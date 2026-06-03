/**
 * Server context — a value threaded through React's Flight render tree.
 *
 * React's RSC renderer has no Context for Server Components, and the
 * experimental `createServerContext` was removed. This re-implements the
 * piece we need: a value that flows parent→child through the *task graph*
 * (so it survives `await` and isolates siblings, which an `AsyncLocalStorage`
 * cannot — see [[partial-context]] for why).
 *
 * It rides a small patch to the vendored Flight server (see
 * `patches/@vitejs+plugin-rsc+*.patch`):
 *
 *  - every Task carries `partonContext` (inherited from its parent task at
 *    `createTask`, exactly how `formatContext` already flows) and a
 *    `partonChildContext` it hands to its own children;
 *  - the render site stamps the currently-rendering Task onto
 *    `ReactSharedInternalsServer.__partonTask`.
 *
 * A component reads its parent + scopes its children **synchronously at
 * the top of its render** — the only window the task pointer is valid
 * (it's overwritten as sibling tasks render). Capture the task first, then
 * the writes can happen after `await`s because the task object is stable.
 */

import React from "react"
import { ROOT, type PartialCtx } from "./partial-context.ts"

interface TaskContext {
  partonContext?: PartialCtx
  partonChildContext?: PartialCtx
}

const sharedInternals = (
  React as unknown as {
    __SERVER_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE?: { __partonTask?: TaskContext }
  }
).__SERVER_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE

/**
 * The Flight Task currently rendering. Valid only synchronously at the top
 * of a component's render — capture it there and keep the reference; the
 * `__partonTask` pointer is reused for the next task that renders.
 * `null` when the patch isn't applied or no render is active.
 */
export function captureCurrentTask(): TaskContext | null {
  return sharedInternals?.__partonTask ?? null
}

/**
 * The ambient parent context for the currently-rendering parton — its
 * task's inherited `partonContext`. `ROOT` at the top of a render (or when
 * the patch / a task isn't present). Call synchronously at the render top.
 */
export function getAmbientParent(): PartialCtx {
  return captureCurrentTask()?.partonContext ?? ROOT
}

/**
 * Scope `ctx` to a task's descendants: child tasks created while this
 * task's model renders inherit `ctx` as their `partonContext`. `task` must
 * have been captured synchronously at the render top (the object is stable,
 * so the write itself may follow `await`s).
 */
export function setTaskChildContext(task: TaskContext | null, ctx: PartialCtx): void {
  if (task) task.partonChildContext = ctx
}
