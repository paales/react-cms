/**
 * Debug-only per-batch latency hook for the cell-write pipeline.
 *
 * Lives in a separate (non-`"use server"`) module so it can export
 * synchronous helpers — the `cell-actions.ts` module is `"use server"`
 * and every export there has to be an async server action. Importing
 * the simulator state from here lets `__cellWriteBatch` consult it
 * before each batch without violating that constraint.
 *
 * Production code leaves the simulator null. Demos install one to
 * exercise the auto-batched write path under variable RTTs without
 * losing the microtask-coalescing behaviour.
 */

let _writeDelaySimulator: (() => number | void) | null = null

export function _setCellWriteDelaySimulator(fn: (() => number | void) | null): void {
  _writeDelaySimulator = fn
}

export function _getCellWriteDelay(): number | void {
  return _writeDelaySimulator?.()
}
