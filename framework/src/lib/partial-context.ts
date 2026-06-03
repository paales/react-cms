/**
 * Partial parent context.
 *
 * A parton needs its `parent` — the ancestor id path + frame chain — to
 * derive its own identity and to scope its descendants. Parent flows
 * through an `AsyncLocalStorage` scope, not a prop: each parton renders
 * its body inside `runWithParent(childCtx, …)` at its boundary (the
 * parton boundary in `partial.tsx`), and descendants read it via
 * `getAmbientParent()`.
 *
 * Run-based ALS is the only mechanism that works here: it's
 * interleave-safe and survives the async render across the boundary's
 * `renderToReadableStream` (the same way request context does). A
 * Provider-style `enterWith` cross-contaminates sibling partons under
 * React's breadth-first async traversal — see `als-parent-probe`.
 */

import { AsyncLocalStorage } from "node:async_hooks"

export interface PartialCtx {
  /** Effective ids of ancestor Partials, outer-first. */
  readonly path: readonly string[]
  /** Local frame names from ancestors that opened a frame, outer-first.
   *  Joined with `.` for canonical session / wire keys. */
  readonly frameChain: readonly string[]
}

const EMPTY: readonly string[] = Object.freeze([]) as readonly string[]

export const ROOT: PartialCtx = Object.freeze({
  path: EMPTY,
  frameChain: EMPTY,
})

const parentContext = new AsyncLocalStorage<PartialCtx>()

/** The current ambient parent — set by the enclosing parton's boundary.
 *  `ROOT` at the top of a render, or wherever no boundary is active. */
export function getAmbientParent(): PartialCtx {
  return parentContext.getStore() ?? ROOT
}

/** Run `fn` with `ctx` as the ambient parent. A parton's boundary wraps
 *  its body render in this so descendants read `ctx`. Must enclose the
 *  boundary's `renderToReadableStream` call — the ALS scope propagates
 *  through the render's async continuations, not through lazily-rendered
 *  JSX children, so the body has to render *inside* the callback. */
export function runWithParent<T>(ctx: PartialCtx, fn: () => T): T {
  return parentContext.run(ctx, fn)
}

/** Build the child context a spec scopes its descendants under. Frame
 *  scope opening lives on `<Frame>`, not on partial specs — `parent`'s
 *  `frameChain` flows through unchanged. */
export function _childContext(parent: PartialCtx, selfId: string): PartialCtx {
  const path = Object.freeze([...parent.path, selfId]) as readonly string[]
  return { path, frameChain: parent.frameChain }
}

export function _joinFrameChain(chain: readonly string[]): string {
  return chain.join(".")
}
