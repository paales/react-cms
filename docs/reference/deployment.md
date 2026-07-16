# Deployment

The framework holds ONE long connection per viewer to a **stateful
server process** — server-owned state lives in that process, not in the
client. That single fact sets the deployment shape: the process is
precious, its state is either durable (a shared store) or ephemeral
(dies with the process), and a deploy is a protocol moment the client
survives, not an outage. This page is the operator contract for a
pilot: **one sticky process, deployed a few times a day, real users.**

## Build outputs & process model

An app is three thin entry files delegating to the framework's entry
factories (see [`intro.md`](./intro.md) § Setting up an app), wired
together by the vite config's `environments.*.build.rollupOptions.input`
map:

| Entry               | Environment | Role                                                |
| ------------------- | ----------- | --------------------------------------------------- |
| `entry.rsc.tsx`     | `rsc`       | The RSC server handler (`createRscHandler`).        |
| `entry.ssr.tsx`     | `ssr`       | HTML rendering of the Flight stream (`renderHTML`). |
| `entry.browser.tsx` | `client`    | Hydration + the client runtime (`bootBrowser`).     |

`yarn build` produces all three bundles; the server runs the `rsc` +
`ssr` bundles in one Node process, the `client` bundle ships to the
browser. There is one server process; it is **sticky** — every viewer's
held connection, its action POSTs, and its re-attaches must land on the
same process (see § Sticky sessions).

**What lives where.** The dividing line is durability:

| State                                             | Where it lives         | Survives a deploy?                          |
| ------------------------------------------------- | ---------------------- | ------------------------------------------- |
| Cell values                                       | The shared cell store  | **Yes** — the store is the truth.           |
| Session frame URLs                                | The session store      | Only with a shared `SessionStore` (below).  |
| Partial registry, fingerprints, wake index        | Per-process, in memory | **No** — rebuilt cold on the new process.   |
| Ephemeral cells, client-pool, connection sessions | Per-process, in memory | **No** — the client re-warms in one attach. |

**Fingerprints are not portable across a deploy.** An fp folds the
process-local invalidation timestamps, so the new process's manifest
never matches the client's held fps. The consequence is bounded and
benign: on re-attach the client's manifest misses, the new process
renders the whole tree at full price ONCE, and the cold-record posture
over-fetches rather than serving stale — **one full-price whole-tree
render per viewer per deploy**, values intact from the store. This is
structural (it is the same cost a fresh visitor pays), not a defect to
engineer away.

## `createRscHandler` knobs

```tsx
// src/entry.rsc.tsx
import { createRscHandler } from "@parton/framework/entry/rsc.tsx"
import { Root } from "./app/root.tsx"

export default createRscHandler({ Root })
```

| Option        | Default           | What it does                                                                                                                              |
| ------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `Root`        | required          | The HTML shell component; places `<PartialRoot>`.                                                                                         |
| `notFound`    | none              | Component rendered (status 404) when a render signals `notFound()`.                                                                       |
| `fetch`       | none              | First-crack request hook for app routes — return `undefined` to fall through to the framework.                                            |
| `remote`      | none              | Opt-in static remote-metadata endpoints (`/__remote/manifest.json`, `/__remote/types.d.ts`) — see [`remote-frame.md`](./remote-frame.md). |
| `clearCaches` | none              | Extra work on the DEV clear-caches endpoint.                                                                                              |
| `drain`       | `SIGTERM → drain` | Deploy-and-drain wiring. `false` opts out; `{ deadlineMs }` tunes the bound (see § Drain).                                                |

Everything else — the segmented-response driver, fp-trailers,
invalidation transactions, the live heartbeat, the SIGTERM handler — is
the factory's business.

## Storage

**Cell values — use `SqliteCellStorage` for a pilot.** The default
`JsonFileCellStorage` is **dev-only**: a whole-snapshot debounced flush.
A SIGKILL (or a hard crash) drops whatever is inside the debounce
window, and a second process silently clobbers the file. `SqliteCellStorage`
is the deployment backend — per-key rows, synchronous-commit WAL (no
debounce window to lose), and the `cell.update(fn)` compare-and-retry
that composes contended writes. It is a **deep import** (not the
barrel): it statically pulls the native `better-sqlite3`, which only
apps that opt in should carry.

```ts
// src/entry.rsc.tsx (before createRscHandler)
import { setCellStorage } from "@parton/framework"
import { SqliteCellStorage } from "@parton/framework/runtime/cell-storage-sqlite.ts"

setCellStorage(new SqliteCellStorage("./data/cells.db"))
```

**Session frame URLs — `SqliteSessionStore` to carry them across a
deploy.** The default `MemorySessionStore` dies with the process, so
after a deploy the new process renders every frame at its `initialUrl`
(the window URL is a shareable projection over the session — see
[`../internals/frame-scope.md`](../internals/frame-scope.md)). A shared
`SqliteSessionStore` survives the restart (`setSessionStore` is on the
barrel; the SQLite store is a deep import, same native-module reason as
`SqliteCellStorage`):

```ts
import { setSessionStore } from "@parton/framework"
import { SqliteSessionStore } from "@parton/framework/runtime/session-store-sqlite.ts"

setSessionStore(new SqliteSessionStore("./data/sessions.db"))
```

**CMS content is demo-grade — by design.** The editor's `JsonFileStorage`
(`content.json` + `draft.json`) is one demo surface, not a gating part
of the deployment story; swapping it (`setCmsStorage`, a deep import
from `@parton/framework/runtime/cms-storage.ts`) is out of scope for the
pilot bar. Do not treat the CMS store as production-grade.

## Sticky sessions

The held connection, its action POSTs, and its re-attaches must all
reach the **same process** — the registry, wake index, connection
sessions, and attached-action routing all assume co-residence. A pilot
runs one process, so stickiness is trivially satisfied; behind a load
balancer it is a hard requirement (route by the session cookie).

**The proxy must preserve the client-facing `Host` header.** The
live-attach endpoint runs an `Origin` check against the request's Host;
a proxy that rewrites `Host` to the backend's internal name makes that
check **403** the attach. Preserve the client-facing Host (or configure
the check) — a Host-rewriting proxy is the sharpest deployment footgun
here, found the hard way in the multi-process harness.

## Drain — SIGTERM as a protocol moment

Without a drain, replacing the process tears every live lane and drops
the in-flight window. The drain makes SIGTERM deliberate: stop
accepting attaches, settle in-flight work, signal clients to reattach
BEFORE exiting. `createRscHandler` wires `SIGTERM → beginDrain → exit`
automatically; `drain: false` opts out, `drain: { deadlineMs }` tunes
the bound. Mechanism: [`../internals/channel.md`](../internals/channel.md)
§ Deploy-and-drain.

- **Attaches are refused explicitly.** A new attach during drain
  answers `503` + `x-parton-drain: 1` — the header is the statement (a
  bare 503 is ordinary overload). A drain-aware proxy retries the
  buffered attach POST against a surviving backend; the client marks the
  refusal `NavigationError.drainRefusal` and retries on a fixed 500ms
  cadence WITHOUT counting toward the degrade bound. Everything else
  keeps serving for the whole window — envelopes, action POSTs, document
  GETs — so in-flight writes land.
- **Held connections settle, then re-attach before exit.** `beginDrain`
  writes the `drain` wire frame once per connection and winds the drive
  down to the next full park; the client's `drain` entry arms
  reattach-on-close, so the stream's settle re-fires the attach
  immediately. Through the sticky proxy the re-attach reaches a
  surviving process while the old one is STILL UP — that ordering is
  what deletes the visible gap.
- **Quiescence is gauged to the byte.** The drain resolves at zero open
  sessions AND zero in-flight requests, where a request is counted
  until its response BODY fully streams out — so a write racing SIGTERM
  commits and its response flushes before exit.
- **The deadline is the one legitimate timeout** (`DEFAULT_DRAIN_DEADLINE_MS`,
  5s). It IS the contract — a deploy must complete. At the bound,
  stragglers are force-closed with every lane read aborted and the drop
  REPORTED (process warn + per-connection detail), never silent; the
  client's decode settles without committing and the re-attach's
  whole-tree render heals.

**Measured** (same harness, 4 writes/s, `experiments/multi-process/`):
the drain (SIGTERM) recovers in **473ms** with a **313ms** longest DOM
gap, versus **~2.0s / ~1.9s** for the ungraceful SIGKILL baseline — a
~6× cut, structural (reattach-before-exit, not a faster proxy). The
re-attach's held stream (14,368B/3.7s) ≈ the initial attach
(11,455B/3.2s): the full-price whole-tree render, **one cold attach per
viewer per deploy**. Committed writes survive both worlds (the store is
the truth); only the drain guarantees the in-flight one.

## Multi-process (beyond the pilot bar)

A pilot runs one sticky process, so this is not gating — but the seam
exists. `setInvalidationBridge` is the cross-process doorbell: it
publishes each committed bump batch (`{ origin, selectors }` — selector
grammar strings, **no values, no timestamps**), and `deliverInvalidationBumps`
applies received ones. The consistency contract:

- **The store is the truth.** Values ride the shared cell store
  (`setCellStorage`), never the bus. A batch is a doorbell: the receiver
  re-reads and fp-compares; duplicates and reordering cost a wasted
  re-render, never wrongness.
- **Publish-after-commit is the only ordering.** One `atomic()` = one
  store commit + one bump batch, strictly after the storage flush.
  Timelines are process-local (an inbound bump commits with a fresh
  local timestamp; the writer's row stamp stays authoritative).
- **Contention is per-key last-writer-wins**; `cell.update(fn)` over the
  SQLite CAS is the compose escape — proven across processes (100
  concurrent updates over one store land exactly 100).
- **The transport is deployment code.** The bridge seam carries origin +
  selector strings; the wire that moves them between processes (its
  reconnect loop, its loss window) is the deployment's to build and
  swap, not the framework's. A dropped-while-disconnected batch degrades
  the peer to next-doorbell freshness — over-fetch, never stale.

Mechanism: [`../internals/registry-internals.md`](../internals/registry-internals.md)
§ The bridge seam.
