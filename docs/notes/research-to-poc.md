# Research → proof of concept

> Design note, 2026-07-13. What separates the current research state
> from a proof of concept, as five gating workstreams with exit
> criteria. Companion to
> [`remote-frame-arc.md`](./remote-frame-arc.md) — the two share a
> spine (the storage adapter and the capability machinery serve
> both).

## The bar

**One pilot commerce site, one team, real users, a single sticky
server process, deployed twice a day.** PoC ≠ production. Everything
below is derived from that sentence; anything not required by it is
explicitly non-gating (see the end).

The through-line: every gating item is a consequence of the
framework's own thesis. Server-owned state ⇒ the server process is
precious ⇒ drain/resume and durable storage. Writes are plain server
functions ⇒ authorization must live somewhere. One held connection ⇒
reconnect is a first-class path, not an error path.

## Gating workstreams

### 1. Write authorization

Any client can currently invoke any `__cellWrite` / server action on
any cell it can name. Identity can be a session-partitioned cell
(the auth-district demo); *authorization* — who may write this cell,
who may call this action — needs a framework-level answer on the
write surface itself, not per-action boilerplate. Candidate shape: a
guard declared on the cell/action definition, evaluated in request
scope (session/capability in, allow/deny out) — the same grant
machinery the federation arc's capabilities use, applied locally.

Existence-as-authorization comes free on the read side: gating a
parton's `match` on an identity cell means unauthorized content is
never rendered and never on the wire — but the write path has no
equivalent today, and that's the gap.

**Done when:** a cell can declare who may write it; an unauthorized
write is rejected server-side; an e2e spec proves both the rejection
and that the UI degrades sanely.

### 2. One real storage adapter

`cells.json` whole-snapshot debounced flush and the in-memory
session store are demo-grade by design and dangerous for a pilot:
SIGKILL drops the debounce window, and a second process silently
clobbers (demonstrated: `feat/multi-process-harness` scenario D).
Build **one** per-key adapter (SQLite is enough) behind the existing
`CellStorage` interface, and a second `SessionStore` impl behind its
interface. An interface with a single implementation is a
hypothesis; the adapter is the test that the seams were drawn right.

The adapter also carries the consistency contract from the
federation arc: per-key write ordering from the store,
publish-after-commit for bumps, `cell.update(fn)` compare-and-retry
for contended writes. Building it here means the federation arc
inherits it, not the other way around.

**Done when:** the JSON file is a dev-only default; the harness
contention scenario passes with zero lost updates; `update(fn)`
exists with a real caller (the bidding district is the natural one).

### 3. Deploy-and-drain

The architecture is a held connection to a stateful process, so
today every deploy tears every live lane and drops every ephemeral
state. A pilot deploying twice a day needs: stop accepting attaches,
settle in-flight lanes, signal clients to reattach, exit; and a
client resume that survives it (the ack-watermark machinery is most
of the way there; the real reconnect path is the least-covered part
of the channel). Measure before designing: harness scenario E
(SIGTERM failover) is halfway to the measurement — extend it to
capture exactly what is lost today, then design the resume contract
around what the measurement says.

**Done when:** a harness scenario SIGTERMs the pinned process
mid-session and proves viewers reattach with no visible tear, no
lost committed writes, and a bounded full-price re-render cost.

### 4. The error-recovery contract

`PartialErrorBoundary` has zero app call sites — the error story is
unproven at the app layer, and the documented answer to a flaky
loader is "you get a card." A pilot needs: serve-last-known-good on
error (the byte cache already holds it), a retry/backoff default,
and a documented author contract for what to do about a flaky cell
loader. Design it against a forcing caller: the **flaky district** —
a world chunk whose loader fails intermittently, showing
last-known-good with a staleness indicator instead of an error card.

**Done when:** the flaky district renders last-known-good through
failures; the contract (what throws where, what the boundary shows,
what retries) is a `docs/reference/` page.

### 5. The DX floor

What makes an external pilot team bounce in the first hour:

- **Barrel split** (`@parton/framework/server` + `/client`): the
  mandatory deep-import of `lib/partial-client.tsx` (23 call sites
  today) to dodge a runtime Flight error is the sharpest authoring
  footgun. Already in IDEAS.md; it gates the pilot.
- **A deployment reference page** — there is none: build outputs,
  the process model, the sticky-session requirement, drain behavior,
  what state lives where (per-process registry/sessions/caches vs
  the shared store).
- **A docs honesty pass** on the single-process constraints: the
  registry, wake index, sessions, and attached-action routing assume
  co-residence; the docs currently imply more than the code
  delivers. State the constraint plainly wherever it binds.

**Done when:** a fresh app imports only from the two barrels; the
deployment page exists; no doc claims multi-process behavior the
code doesn't have.

## Measure-first items

Not workstreams — measurements that set budgets for the workstreams
above, using harnesses that already exist:

- **Reconnect/resume today** (harness E/F) — what exactly is lost;
  feeds workstream 3.
- **Long-session soak** (the kiosk shape; soak-runner) — the leak
  curve of wake-arm and client-pool eviction over days; converts
  comment-enforced invariants into a measured curve.
- **N×M fan-out at high write frequency** (the chat-plaza shape) —
  whether a lossy/coalescing write tier is a necessity or an
  optimization; budgets the Interactive federation tier too.

## Explicitly not gating

Multi-process fan-out (graduates with the federation arc's bridge
seam — the pilot runs one sticky process), i18n, sitemap/route
enumeration, observability beyond basic logging, CMS storage
hardening (demo-grade is stated and fine), RemoteFrame capability
signing, WebTransport. All real; none required by the bar.

## Order

Adapter (2) first — it unblocks the consistency contract, the
bidding demo, and the federation arc simultaneously. Then write
authorization (1, shares the grant machinery with the arc's
capabilities), drain/resume (3, after its measurement), the error
contract (4, with the flaky district), and the DX floor (5) as the
closing pass — docs are written last so they describe what shipped.

**Exit:** all five done-whens green from a clean tree with both test
tiers passing, plus the measure-first numbers recorded in this note's
successor as the pilot's operating budgets.
