# Deploy-and-drain — SIGTERM as a protocol moment

> **Superseded 2026-07-17 by
> [`docs/reference/deployment.md`](../reference/deployment.md).** The
> operator contract (drain lifecycle, knobs, measured numbers) is now a
> reference page; this note is kept for the design rationale and the
> as-built map.

Landing note for research→PoC workstream 3
([`research-to-poc.md`](../notes/research-to-poc.md) §3). The architecture is
a held connection to a stateful process, so a deploy used to tear
every live lane and drop the in-flight window. The drain makes SIGTERM
deliberate: stop accepting attaches, settle in-flight work, signal
clients to reattach, exit. Mechanism reference:
[`../internals/channel.md`](../internals/channel.md) § Deploy-and-drain.
Measurement input this was designed against: the ungraceful-failover
numbers in [`bridge-seam.md`](./bridge-seam.md) (§ Failover
measurement) — the design closes exactly what that measurement said is
lost (the visible gap and the in-flight window), nothing more.

## Design decisions worth remembering

- **The drain signal is a producer-written frame, not an inference.**
  A new `drain` entry in the `\xFF` marker vocabulary (`TAG_DRAIN`,
  zero body) — the done-marker rule: the client must never read drain
  out of a closed socket, because a closed socket also means crash,
  keepalive elapse, or its own supersede. Likewise the attach refusal
  is `503` + `x-parton-drain: 1` — the HEADER is the statement; a bare
  503 is ordinary overload.
- **The settle phase is the transport handover, reused.** The
  fetch→WS upgrade already needed "close with everything in flight
  served first" (`windDownAtPark` — exit at the next FULL park) and
  "the close re-fires the attach" (the one-shot reattach flag). Drain
  is those two seams with a different trigger: server-side the drain
  mark converts the drive to the atPark wind-down; client-side the
  `drain` entry arms reattach-on-close. Almost no new machinery on the
  hot path — the drain-specific code is the orchestration module
  (`runtime/drain.ts`), the refusal gate, and the wire entry.
- **Reattach-before-exit is what deletes the gap.** Ungraceful
  failover's ~1.9s gap is proxy-failover-shaped: kill → connect
  errors → re-pin → cold attach. Draining, the old process is STILL
  UP while the client reattaches — the refusal + proxy retry route the
  attach to the survivor in one round trip, and the old stream had
  already served everything.
- **Quiescence = sessions + in-flight requests, gauged to the byte.**
  The entry counts every request until its response BODY fully streams
  out (a Response object exists long before its bytes leave), so a
  write racing SIGTERM commits and its response flushes. Found the
  hard way: gauging handler-resolution alone still lost the response
  to the displaced server-close's socket destruction — the final chunk
  settles the gauge a microtask before the middleware hands it to the
  socket, so the exit path also yields one I/O turn.
- **The deadline is the one legitimate timeout.** It IS the contract —
  a deploy must complete. Default 5s (`DEFAULT_DRAIN_DEADLINE_MS`);
  at the bound, stragglers are force-closed with EVERY lane read
  aborted (producers and wedged loaders alike) and the drop reported
  (process-level warn + per-connection lane detail) — never silent. A
  force-closed lane ends on the cancel path (muxend, no delivery
  announcement): the client's decode settles without committing, and
  the reattach's whole-tree render heals.
- **SIGTERM ownership is explicit.** Vite's dev/preview handler
  destroys every open socket and exits in the same tick — the drain
  frame would never flush. `installDrainOnSigterm` displaces
  previously-registered listeners at install and re-invokes them after
  the drain (they still close the server and exit). A listener
  registered AFTER ours (a dev-server restart re-arming Vite's) can
  still preempt — accepted dev-only residual.
- **Sessions are surfaced, not migrated.** Frame URLs survive iff the
  app configured the shared store
  (`setSessionStore(new SqliteSessionStore(...))`); the default
  in-memory store dies with the process and the new process renders
  frames at their initial URLs. Values always survive (the shared cell
  store); per-process registry/fps never do — fps fold per-process
  invalidation timestamps, so they are NOT portable across a deploy
  and the reattach pays one full-price whole-tree render (measured
  below; over-fetch, never stale).

## As-built

- `framework/src/runtime/drain.ts` — `beginDrain` / `isDraining` /
  `drainAttachRefusal` / `installDrainOnSigterm` / the in-flight
  request gauge. Barrel-exported (`beginDrain`, `isDraining`,
  `DEFAULT_DRAIN_DEADLINE_MS`).
- `framework/src/lib/connection-session.ts` — the session half:
  `drainRequested` / `drainForced` flags, `_drainAllConnectionSessions`,
  `_forceCloseDrainingSessions`, the session-close listener the drain's
  quiescence wait observes.
- `framework/src/lib/segmented-response.ts` — the driver announces the
  `drain` entry once per connection and converts to the full-park
  wind-down; the drain-forced exit aborts every lane read and logs the
  undrained lanes.
- `framework/src/entry/rsc.tsx` — the attach refusal, the
  `drain` config option, the SIGTERM wiring, the response-body gauge.
- `framework/src/lib/channel-server.ts` — the WS/WebTransport drivers
  refuse a draining attach with the `drain` entry + close.
- Client: `channel-client.ts` (the `drain` entry arms
  reattach-on-close; drain-refused closes retry on a fixed 500ms
  cadence, never counting toward degrade),
  `channel-transport.ts` + `navigation-error.ts`
  (`NavigationError.drainRefusal` off the refusal header),
  `live-page-heartbeat.tsx` (threads the refusal into the close
  arbitration).
- Harness: `experiments/multi-process/harness.mjs` proxies retry a
  drain-refused attach against the next backend (the buffered request
  body makes the replay safe) — the deployment-side half a real LB
  does off health checks; `scenarios/drain.spec.ts` is the gate;
  `scenarios/failover.spec.ts` moved to SIGKILL (SIGTERM is now the
  graceful path, and the ungraceful crash-class baseline must stay
  measured).
- Tests: `drain.rsc.test.tsx` (frame emission, in-flight lane settle,
  refusal, deadline force-close + loss report, the open-mid-drain
  race), `drain-client.test.ts` (reattach-on-close, refusal cadence,
  no degrade).

## Gate numbers (2026-07-13, drain vs the ungraceful baseline)

Same harness, same app, same 4 writes/s cadence, one run back-to-back
(`playwright test --config experiments/multi-process/playwright.config.ts`):

|                             | drain (SIGTERM)                                        | ungraceful (SIGKILL)                           |
| --------------------------- | ------------------------------------------------------ | ---------------------------------------------- |
| recovery (kill → DOM moves) | **473ms**                                              | 2,042ms                                        |
| longest DOM update gap      | **313ms**                                              | 1,959ms                                        |
| DOM regression samples      | 0                                                      | 0                                              |
| document reloads            | 0                                                      | 0                                              |
| attach POSTs after kill     | 1 (+1 refusal proxy-absorbed)                          | 1                                              |
| in-flight write at the kill | **committed + answered** (300ms-delayed write, gauged) | no guarantee (proxy buffered-body replay only) |
| re-attach held-stream bytes | 14,368B / 3.7s                                         | 12,620B / 3.5s                                 |
| initial attach (baseline)   | 11,455B / 3.2s                                         | 12,311B / 3.1s                                 |

Readings: the drain cuts the visible gap ~6× by reattaching before the
exit; the re-attach cost is the full-price whole-tree render either
way (~the initial attach — fp non-portability is structural, not a
drain defect), so the bounded-re-render-cost claim holds at "one cold
attach per viewer per deploy". Committed writes survive in both worlds
(the store is the truth); only drain guarantees the IN-FLIGHT one.

Suites at landing: `yarn test` green (node 55 / rsc 80 / rsc-prod 6
files), the harness suite 5/5 (bus ×2, contention, drain, failover).
