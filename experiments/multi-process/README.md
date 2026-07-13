# Multi-process harness

Two production builds of the tiny harness app (`./app`) as separate
node processes over ONE shared SQLite store, behind a sticky reverse
proxy, connected by the framework's **invalidation-bridge seam**
(`setInvalidationBridge` / `deliverInvalidationBumps`) through a
JSON-lines bump broker. Playwright scenarios prove the cross-process
consistency contract and measure failover. Findings + gate numbers:
[`docs/notes/bridge-seam.md`](../../docs/notes/bridge-seam.md).

## Topology

```
client ── :5690  harness.mjs (sticky proxy + supervisor + byte stats)
             ├── :5691  vite preview #0   (app/dist)
             └── :5692  vite preview #1   (same dist, separate process)
          :5699  bump broker (JSON-lines relay, {origin, selectors} only)
          .data/cells.sqlite  (the shared per-key store, WAL)
```

The 56xx band never collides with the canonical e2e servers
(5179/5181/5183). All in-memory framework state (partial registry,
session store, invalidation registry, render cache) is per-process;
values live in the shared store, doorbells cross on the bus.

The app is NOT a yarn workspace — every dependency resolves from the
repo's hoisted `node_modules` (the `nodeLinker: node-modules` layout),
and its vite config aliases `@parton/framework` to the working tree's
source, so the harness always runs the framework as it exists in your
checkout.

Affinity: `x-lb-backend` header (test override) → `__lb` cookie →
hash of `__frame_sid` → round-robin; the proxy re-pins via
`Set-Cookie: __lb=<n>` whenever the served backend differs. The
client-facing `Host` header is preserved through the proxy
(virtual-host style) — the framework's live-attach endpoint verifies
`Origin` against the request URL, so a Host rewrite would 403 every
attach. Responses stream through chunk-for-chunk; request bodies are
buffered so a dead pinned backend fails over transparently — and so an
EXPLICIT drain refusal (`503` + `x-parton-drain` from a backend that
received its deploy signal) replays the buffered attach against the
next backend and re-pins, the deployment-side half of the framework's
deploy-and-drain contract. Every
response carries `x-lb-backend`, and the proxy records per-request
byte counts (`/__harness/stats`) — the failover measurement's ruler.

Supervisor endpoints (proxy port): `/__harness/status`,
`/__harness/kill?i=N&signal=SIGTERM|SIGKILL`, `/__harness/start?i=N`,
`/__harness/stats`, `/__harness/stats/reset`, `/__harness/reset-store`.

App endpoints (per backend, for driving writes at a SPECIFIC process
without Flight-encoding action payloads): `POST /__mp/update`
(`counter.update(n => n + 1)`, returns the CAS-final committed value),
`GET /__mp/value`.

## Running

```bash
# once, and after framework changes:
cd experiments/multi-process/app && ../../../node_modules/.bin/vite build && cd -

# the suite (Playwright boots + reaps the harness):
node_modules/.bin/playwright test --config experiments/multi-process/playwright.config.ts

# or hold the harness open for manual poking:
node experiments/multi-process/harness.mjs
```

One worker, no parallelism — the scenarios share cross-process state
on purpose.

| Spec                 | Scenario                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bus.spec.ts`        | The bridge end-to-end: a write in process A reaches a live viewer attached to process B (doorbell → registry commit → wake index → lane), both directions. A broker spy asserts every relayed line is exactly `{origin, selectors}` — zero values on the wire.                                                                                                                                                                        |
| `contention.spec.ts` | 100 concurrent `cell.update(fn)` increments interleaved across both processes land exactly 100 (the SQLite CAS composes; the prototype's scenario D demonstrated the OPPOSITE over cells.json).                                                                                                                                                                                                                                       |
| `drain.spec.ts`      | Deploy-and-drain (workstream 3's gate): SIGTERM the pinned backend with a write IN FLIGHT on it. Proves no visible tear (the DOM gap must beat the ungraceful ~1.9s baseline — measured ~0.3s), the in-flight write commits and answers, zero document reloads, live on the survivor afterward; records the reattach's full-price whole-tree cost. Numbers: [`docs/notes/deploy-and-drain.md`](../../docs/notes/deploy-and-drain.md). |
| `failover.spec.ts`   | SIGKILL the pinned backend mid-session while writes keep flowing through the survivor — the ungraceful crash-class baseline the drain is compared against (SIGTERM is the graceful path now). Measures: auto-recovery time, DOM update gap, reattach count, document reloads, committed-write survival, held-stream byte cost either side of the kill.                                                                                |

## Prototype lineage

Ported forward from `feat/multi-process-harness` (commit `a5f4f64`).
The prototype's scenarios A–C and F measured the pre-adapter,
pre-bridge world (JSON-file clobbering, heartbeat-reopen propagation,
affinity-loss fp portability) and are superseded: D is inverted by
`contention.spec.ts` (the lost update became the zero-lost gate), G is
modernized as `bus.spec.ts` over the landed seam, E is extended as
`failover.spec.ts` with the shared store underneath.
