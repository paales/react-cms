/**
 * Request-scoped registry for the universal parton boundary.
 *
 * Every parton renders its body as its own Flight document so an ALS
 * `parent` scope can wrap that render (see [[partial-context]]). The body
 * stream is parked here under a generated boundary id, and the parton
 * leaves an `<i hidden data-boundary-id>` marker in its parent's output.
 * After the root render, `spliceMarkerStream` walks the document and, at
 * each marker, splices the parked body in its place — recursively, since
 * a body carries markers for its own inner partons.
 *
 * Scope: one registry per root render (per streamed segment). Bodies
 * register during the render (driven by stream consumption); the splice
 * resolves them as it reaches each marker. A body is always parked before
 * its marker byte appears — the parton registers, *then* returns the
 * marker — so the resolver never misses. A fresh registry per
 * `renderWithBoundaries` call isolates segments and bounds memory.
 *
 * Own `AsyncLocalStorage`, entered around the root render so the render's
 * async continuations — where partons actually run — capture it, the same
 * survives-lazy-render property `runWithParent` relies on. The splice's
 * resolver closes over the map directly (no ALS), so it works after the
 * scope has unwound and the response is being consumed.
 */

import { AsyncLocalStorage } from "node:async_hooks"
import { spliceMarkerStream } from "./flight-graph.ts"
import { ROOT, runWithParent } from "./partial-context.ts"

interface BoundaryRegistry {
  map: Map<string, ReadableStream<Uint8Array>>
  next: number
}

const boundaryContext = new AsyncLocalStorage<BoundaryRegistry>()

/**
 * Park a parton's body stream; returns the boundary id to stamp on its
 * marker. Returns `null` outside a boundary scope (a render not wrapped
 * by `renderWithBoundaries` — e.g. an isolated decode in a test) so the
 * caller can fall back to rendering its body inline.
 */
export function registerBoundary(stream: ReadableStream<Uint8Array>): string | null {
  const reg = boundaryContext.getStore()
  if (!reg) return null
  const bid = `b${reg.next++}`
  reg.map.set(bid, stream)
  return bid
}

/**
 * Render the root document with the universal-boundary machinery: a fresh
 * per-segment registry, the `ROOT` parent scope, and a marker splice over
 * the output. `renderFn` must call the host's `renderToReadableStream`
 * (so the app's Flight runtime + temporary references apply); it runs
 * inside both ALS scopes so every parton it renders captures them.
 */
export function renderWithBoundaries(
  renderFn: () => ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const reg: BoundaryRegistry = { map: new Map(), next: 0 }
  const stream = boundaryContext.run(reg, () => runWithParent(ROOT, renderFn))
  return spliceMarkerStream(stream, (bid) => reg.map.get(bid) ?? null)
}
