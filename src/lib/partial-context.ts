/**
 * Server-side partial hierarchy tracking.
 *
 * Until TC39 AsyncContext lands (see
 * https://react.dev/reference/react/useTransition#react-doesnt-treat-my-state-update-after-await-as-a-transition),
 * React server components render in a different traversal order than
 * client components: once a component hits an `await`, React moves on
 * to siblings, so a single ALS / React.cache cell tracking "who's the
 * current parent" drifts unpredictably. That's why
 * `<Partial parent={...}>` is **required** rather than inferred — the
 * author threads the parent context explicitly across async
 * boundaries, and the framework records the whole tree server-side
 * instead of reconstructing it on the client.
 *
 * ── Usage ─────────────────────────────────────────────────────────
 *
 *   import { Partial, ROOT, capturePartialContext } from "./lib";
 *
 *   function Page() {
 *     return (
 *       <Partial parent={ROOT} selector="#products">
 *         <ProductGrid parent={capturePartialContext()} />
 *       </Partial>
 *     );
 *   }
 *
 *   async function ProductGrid({ parent }: { parent: PartialCtx }) {
 *     // Capture BEFORE any await — the cell drifts after React
 *     // suspends this component.
 *     const items = await fetchProducts();
 *     return items.map(p => (
 *       <Partial parent={parent} selector=".product">
 *         <ProductCard p={p} />
 *       </Partial>
 *     ));
 *   }
 *
 * Inside a SYNC component body (no `await` between the enclosing
 * `<Partial>` and the callsite), `capturePartialContext()` reads the
 * cell and returns the current parent chain. Inside an ASYNC
 * component, capture before the `await` — or accept `parent` as a
 * prop from the caller.
 */

import { cache } from "react"

/**
 * Opaque handle representing a Partial's position in the server-side
 * render tree. Passed via `<Partial parent={...}>`; consumed by the
 * registry so every Partial's parent edge is recorded even when React
 * has interleaved siblings across async boundaries.
 *
 * Carries two parallel chains:
 *
 *   - `path` — every ancestor Partial, by effective id. Scoped to the
 *     render tree; drives registry parent-edge recording.
 *   - `frameChain` — every ancestor Partial that opened a **frame**
 *     (`<Partial frame="…">`), by local frame name. A frame's
 *     canonical identity is `frameChain.join(".")` (dotted path), so
 *     `<Partial frame="list">` nested inside `<Partial frame="products">`
 *     is addressed as `"products.list"` — distinct from a `"list"`
 *     frame under a different parent. Only non-empty when some
 *     ancestor opened a frame.
 */
export interface PartialCtx {
  /**
   * Effective ids of ancestor Partials, outer-first. Empty for the
   * root. `path[path.length - 1]` is the immediate parent id.
   */
  readonly path: readonly string[]
  /**
   * Local frame names contributed by ancestor Partials that declared
   * `frame="…"`, outer-first. Empty when no enclosing frame. The
   * join on `.` is the frame's canonical path used in session
   * storage, navigation state, and the `__frame=` wire param.
   */
  readonly frameChain: readonly string[]
  /**
   * Ancestor-contributed context values. Built up by `<Partial
   * provides={{key: value}}>` — each Partial extends its parent's
   * provides with its own entries and passes the merged bag to
   * descendants. Descendants read via `getClosest<T>(key)`.
   *
   * Readonly per-level; a new object is allocated each time a
   * Partial opens a `provides`, otherwise the parent's bag is
   * passed through unchanged. Keys are intentionally string-typed —
   * higher-level wrappers (entity loaders) can layer typing on top.
   */
  readonly provides: Readonly<Record<string, unknown>>
}

/**
 * Sentinel for the top-level of the render tree. Pass as the `parent`
 * prop on the outermost `<Partial>`s (those not nested inside any
 * other Partial).
 */
const EMPTY_PROVIDES: Readonly<Record<string, unknown>> = Object.freeze({})

export const ROOT: PartialCtx = Object.freeze({
  path: Object.freeze([]) as readonly string[],
  frameChain: Object.freeze([]) as readonly string[],
  provides: EMPTY_PROVIDES,
})

/**
 * React.cache-backed mutable cell carrying the current parent
 * context. `<Partial>` bodies push their own path in before
 * rendering children; `capturePartialContext()` reads it. Scoped per
 * request via React.cache.
 */
const partialContextCell = cache((): { current: PartialCtx } => ({
  current: ROOT,
}))

/**
 * Internal — called by `<Partial>` before it renders children. Writes
 * a new context representing "you are inside this Partial." The cell
 * is a per-request singleton, so this value leaks to siblings that
 * render after us (breadth-first / as-promises-resolve in RSC);
 * authors MUST pass `parent` explicitly across async boundaries
 * rather than trusting the cell.
 *
 * @internal
 */
export function _setCurrentPartialContext(ctx: PartialCtx): void {
  partialContextCell().current = ctx
}

/**
 * Read the current parent context. Useful inside sync component
 * bodies rendered as children of a `<Partial>` — returns the
 * enclosing Partial's path. Async components must call this BEFORE
 * their first `await`; after an await the cell may have drifted to a
 * sibling Partial's context. Returns `ROOT` at the top level.
 */
export function capturePartialContext(): PartialCtx {
  return partialContextCell().current
}

/**
 * Derive the child context a new `<Partial>` should push when it
 * renders: parent's path + this Partial's effective id, parent's
 * frame chain + this Partial's frame name (if any), parent's
 * provides merged with the Partial's own `provides` entries (if any).
 *
 * @internal
 */
export function _childContext(
  parent: PartialCtx,
  selfId: string,
  frame: string | undefined,
  provides?: Readonly<Record<string, unknown>>,
): PartialCtx {
  const path = Object.freeze([...parent.path, selfId]) as readonly string[]
  const frameChain =
    frame != null
      ? (Object.freeze([...parent.frameChain, frame]) as readonly string[])
      : parent.frameChain
  const mergedProvides =
    provides && Object.keys(provides).length > 0
      ? Object.freeze({ ...parent.provides, ...provides })
      : parent.provides
  return { path, frameChain, provides: mergedProvides }
}

/**
 * Canonical dotted path for a frame. The empty chain maps to `""`
 * (no enclosing frame) — callers typically branch on `chain.length > 0`
 * before using this.
 *
 * @internal
 */
export function _joinFrameChain(chain: readonly string[]): string {
  return chain.join(".")
}
