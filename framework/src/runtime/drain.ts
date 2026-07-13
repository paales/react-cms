/**
 * Deploy-and-drain — the graceful half of process shutdown.
 *
 * The architecture holds one long-lived connection per viewer to a
 * stateful process, so an abrupt exit tears every live lane and drops
 * the in-flight window. `beginDrain()` is the deliberate alternative,
 * run when the deploy signal (SIGTERM) arrives:
 *
 *   1. **Stop accepting attaches.** `isDraining()` flips; the attach
 *      endpoints answer new attaches with an EXPLICIT refusal
 *      (`drainAttachRefusal()` — `503` + `x-parton-drain: 1`; the
 *      full-duplex drivers write the `drain` wire entry and close).
 *      A drain-aware proxy retries the buffered attach against a
 *      surviving backend; the client transport retries promptly and
 *      never counts the refusal toward its degrade bound. Everything
 *      else keeps serving: envelopes, action POSTs and document GETs
 *      stay up for the whole window, so in-flight writes land.
 *   2. **Signal + settle every held connection.** Each open session is
 *      marked (`_drainAllConnectionSessions`); its driver's next wake
 *      writes the `drain` wire entry — the client's explicit
 *      reattach-on-close signal — and converts the drive to the
 *      full-park wind-down the transport handover already uses: open
 *      lanes drain and commit, latched statements get their covering
 *      renders, the stream closes CLEANLY. The client re-attaches the
 *      moment its stream settles, so the viewer is live on the new
 *      process before this one exits — no visible tear.
 *   3. **The deadline.** A connection that cannot settle (an unbounded
 *      producer, a wedged loader) is force-closed when `deadlineMs`
 *      elapses — the one place time is the signal, because it IS the
 *      contract: a deploy must complete. The drop is reported (the
 *      driver logs each force-closed connection's undrained lanes),
 *      never silent; the client's reattach whole-tree render heals it.
 *   4. **Exit.** `beginDrain` resolves (after a best-effort cell-storage
 *      flush — the dev JSON store's debounce window must not ride into
 *      the kill); the caller exits. `installDrainOnSigterm` (wired by
 *      `createRscHandler` unless the app opts out) owns that: it takes
 *      the SIGTERM over from any previously-registered listener (Vite's
 *      dev/preview handler destroys every open socket and exits within
 *      the same tick — the drain frame would never flush), drains, then
 *      hands the signal on to the displaced listeners (they close the
 *      http server and exit) or exits itself.
 *
 * What drain does NOT do: migrate state. Values live in the shared
 * store (`setCellStorage`) and survive by construction. Sessions
 * (frame URLs) survive iff the app configured a shared `SessionStore`
 * (`setSessionStore(new SqliteSessionStore(...))`); on the default
 * in-memory store they die with the process and the new process
 * renders every frame at its initial URL — drain surfaces that
 * honestly rather than hiding it. Per-process registry/fps/caches die
 * with the process; the reattach pays one whole-tree render
 * (over-fetch, never stale — the cold-record posture).
 *
 * State is `globalThis`-backed so dev-server module re-evaluation
 * (HMR) never yields two competing drain states in one process.
 */

import { DRAIN_REFUSAL_HEADER } from "../lib/channel-protocol.ts"
import {
  _drainAllConnectionSessions,
  _forceCloseDrainingSessions,
  _onConnectionSessionClosed,
  _openConnectionSessionCount,
} from "../lib/connection-session.ts"
import { getCellStorage } from "./cell-storage.ts"

/** Default bound on the settle window. Lanes settle in loader time
 *  (typically milliseconds) and the client reattaches the moment its
 *  stream closes, so an active connection drains in well under a
 *  second; the bound only exists for the connection that CANNOT settle
 *  (an unbounded producer, a wedged loader) — generous enough for slow
 *  loaders, small enough that a deploy is never hostage. */
export const DEFAULT_DRAIN_DEADLINE_MS = 5_000

/** After the deadline force-closes the stragglers, how long to wait for
 *  their drives to actually unwind before resolving anyway — the
 *  force-close aborts every lane read, so this is exit bookkeeping, not
 *  a second settle window. */
const FORCE_CLOSE_GRACE_MS = 1_000

export interface DrainResult {
  /** Every held connection settled and closed inside the deadline. */
  settled: boolean
  /** Connection ids the deadline force-closed (empty when `settled`). */
  forcedConnections: string[]
}

interface DrainState {
  draining: boolean
  done: Promise<DrainResult> | null
  /** Requests whose handler is still running — the in-flight gauge the
   *  drain waits out alongside the held sessions, so a write racing
   *  the deploy signal lands (its response flushes) before the exit. */
  inFlightRequests: number
  /** Fired on every request settle AND session close — the drain's
   *  quiescence observer (no polling). */
  settleListeners: Set<() => void>
}

const state = ((globalThis as Record<string, unknown>).__partonDrainState ??= {
  draining: false,
  done: null,
  inFlightRequests: 0,
  settleListeners: new Set<() => void>(),
} satisfies DrainState) as DrainState

/** A request entered the entry handler — counted so a drain begun
 *  while it runs waits for it (bounded by the deadline). Paired with
 *  `_drainRequestSettled` in a `finally`. */
export function _drainRequestStarted(): void {
  state.inFlightRequests += 1
}

/** The entry handler resolved (its Response exists; small bodies flush
 *  with it). Wakes the drain's quiescence wait. */
export function _drainRequestSettled(): void {
  state.inFlightRequests = Math.max(0, state.inFlightRequests - 1)
  for (const listener of [...state.settleListeners]) listener()
}

/** Whether the process is draining — the attach endpoints' refusal
 *  gate. Once true it stays true: a draining process is exiting. */
export function isDraining(): boolean {
  return state.draining
}

/** The explicit refusal a draining process answers new attaches with:
 *  `503` + `x-parton-drain: 1` (`DRAIN_REFUSAL_HEADER`). `null` while
 *  not draining — the caller proceeds normally. The header, not the
 *  status, is the statement: a proxy or client must never infer drain
 *  from a bare 503. */
export function drainAttachRefusal(): Response | null {
  if (!state.draining) return null
  return new Response(null, {
    status: 503,
    headers: { [DRAIN_REFUSAL_HEADER]: "1" },
  })
}

/**
 * Begin the process drain. Idempotent — every call returns the one
 * drain's promise, which resolves when all held connections closed (or
 * the deadline force-closed the stragglers) and the cell storage's
 * pending writes flushed. The caller exits afterwards
 * (`installDrainOnSigterm` below, or the app's own supervisor).
 */
export function beginDrain(opts?: { deadlineMs?: number }): Promise<DrainResult> {
  if (state.done !== null) return state.done
  state.draining = true
  const deadlineMs = opts?.deadlineMs ?? DEFAULT_DRAIN_DEADLINE_MS
  state.done = runDrain(deadlineMs)
  return state.done
}

async function runDrain(deadlineMs: number): Promise<DrainResult> {
  _drainAllConnectionSessions()
  const settled = await waitForQuiescence(deadlineMs)
  let forcedConnections: string[] = []
  if (!settled) {
    forcedConnections = _forceCloseDrainingSessions()
    // Never a silent loss: the per-connection lane detail is logged by
    // each driver's exit; this is the process-level statement.
    console.warn(
      `[parton] drain deadline (${deadlineMs}ms) elapsed — force-closed ${forcedConnections.length} connection(s)` +
        (forcedConnections.length > 0 ? `: ${forcedConnections.join(", ")}` : "") +
        (state.inFlightRequests > 0
          ? ` (${state.inFlightRequests} request(s) still in flight)`
          : ""),
    )
    await waitForQuiescence(FORCE_CLOSE_GRACE_MS)
  }
  // The dev JSON cell store debounces its file flush; a deploy must not
  // lose that window. The SQLite adapter's flush is a no-op (its
  // commits are synchronous); best-effort — a flush failure must not
  // block the exit.
  try {
    await getCellStorage().flush?.()
  } catch {}
  return { settled, forcedConnections }
}

/** Resolve `true` when the process is QUIESCENT — zero open sessions
 *  AND zero in-flight requests — `false` when `boundMs` elapses first.
 *  Event-driven off the session-close and request-settle listeners; the
 *  timer is the drain DEADLINE itself — the one explicit time signal
 *  this module owns. */
function waitForQuiescence(boundMs: number): Promise<boolean> {
  const quiescent = (): boolean =>
    _openConnectionSessionCount() === 0 && state.inFlightRequests === 0
  if (quiescent()) return Promise.resolve(true)
  return new Promise<boolean>((resolve) => {
    const finish = (ok: boolean): void => {
      clearTimeout(timer)
      disposeSession()
      state.settleListeners.delete(onSettle)
      resolve(ok)
    }
    const timer = setTimeout(() => finish(false), boundMs)
    timer.unref?.()
    const onSettle = (): void => {
      if (quiescent()) finish(true)
    }
    const disposeSession = _onConnectionSessionClosed(onSettle)
    state.settleListeners.add(onSettle)
  })
}

/**
 * Wire the deploy signal: SIGTERM → `beginDrain` → exit. Installed by
 * `createRscHandler` unless the app passes `drain: false`; idempotent
 * across dev-server module re-evaluation.
 *
 * The handler TAKES OWNERSHIP of SIGTERM: listeners registered before
 * it (Vite's dev/preview handler destroys every open socket and calls
 * `process.exit` within the same tick — the drain frame would never
 * reach a client) are displaced at install and re-invoked AFTER the
 * drain completes, so the server still closes and the process still
 * exits through its own path. With no displaced listener the handler
 * exits itself. SIGINT (Ctrl-C) is deliberately untouched — the deploy
 * signal is SIGTERM.
 */
export function installDrainOnSigterm(opts?: { deadlineMs?: number }): void {
  if (typeof process === "undefined" || typeof process.on !== "function") return
  const g = globalThis as Record<string, unknown>
  if (g.__partonDrainSigtermInstalled) return
  g.__partonDrainSigtermInstalled = true
  const displaced = process.listeners("SIGTERM")
  for (const listener of displaced) process.removeListener("SIGTERM", listener)
  process.once("SIGTERM", () => {
    void beginDrain(opts)
      .then(
        // One I/O turn between quiescence and the exit path: the last
        // response body's final chunk settles the gauge from inside the
        // consumer's read, a MICROTASK before the server middleware's
        // own continuation hands those bytes to the socket. Yielding a
        // macrotask (the event-loop's I/O phase) lets that queued write
        // reach the kernel before a displaced listener's socket
        // destruction (Vite's close) or the exit can cut it.
        () => new Promise<void>((resolve) => setImmediate(resolve)),
        () => {},
      )
      .then(() => {
        if (displaced.length > 0) {
          for (const listener of displaced) {
            try {
              listener("SIGTERM")
            } catch {}
          }
        } else {
          process.exit(0)
        }
      })
  })
}

/** Test-only: unwind the drain state so one process can exercise
 *  several drains (the rsc tier). Never called in production — a
 *  drained process exits. */
export function _resetDrainForTests(): void {
  state.draining = false
  state.done = null
  state.inFlightRequests = 0
  state.settleListeners.clear()
}
