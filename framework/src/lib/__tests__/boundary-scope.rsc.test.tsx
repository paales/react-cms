/**
 * Round-trips the universal-boundary machinery end to end at the byte
 * level — without partial.tsx. A tiny `TestParton` mimics the real
 * boundary: it reads its `parent` from the ambient ALS (NO parent prop),
 * renders its body to its own Flight document under the child scope,
 * parks the stream via `registerBoundary`, and returns the marker. The
 * tree renders under `renderWithBoundaries`, and the spliced output is
 * asserted on bytes.
 *
 * The load-bearing assertion: each body carries `parent.path`, and the
 * paths come out correctly accumulated through nesting — proving the
 * `parent` context flows boundary→boundary purely through ALS, which is
 * the whole point of removing the `parent={parent}` prop.
 */

import { describe, expect, it } from "vitest"
import type { ReactNode } from "react"
import { renderToReadableStream } from "../flight-runtime.ts"
import { registerBoundary, renderWithBoundaries } from "../boundary-scope.ts"
import { _childContext, getAmbientParent, runWithParent } from "../partial-context.ts"

const DEC = new TextDecoder()

async function toBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** Mimics the real parton boundary: ambient parent (no prop), the body
 *  renders to its own document under the child scope, the stream is
 *  parked, the marker returned. The body records its resolved path so the
 *  test can assert ALS propagation across the boundary. */
async function TestParton({ id, children }: { id: string; children?: ReactNode }) {
  const parent = getAmbientParent()
  const childCtx = _childContext(parent, id)
  const body = (
    <div data-id={id} data-path={parent.path.join("/")}>
      {children}
    </div>
  )
  // Body renders under the child scope, so any nested TestParton in it
  // reads THIS parton's child context as its ambient parent.
  const stream = runWithParent(childCtx, () => renderToReadableStream(body))
  const bid = registerBoundary(stream)
  return <i hidden data-boundary-id={bid} />
}

describe("boundary-scope round-trip (ambient parent, no prop)", () => {
  it("splices nested bodies and threads parent.path through ALS", async () => {
    const out = DEC.decode(
      await toBytes(
        renderWithBoundaries(() =>
          renderToReadableStream(
            <main>
              <TestParton id="outer">
                <TestParton id="inner" />
              </TestParton>
            </main>,
          ),
        ),
      ),
    )

    // Both bodies spliced in, every marker consumed. (A real surviving
    // marker serialises its bid value — `"data-boundary-id":"b0"`; the
    // bare substring also appears in DEV's serialised component source,
    // so match the quoted-value form to mean an actual unspliced row.)
    expect(out).toContain(`"data-id":"outer"`)
    expect(out).toContain(`"data-id":"inner"`)
    expect(out).not.toContain(`"data-boundary-id":"b`)

    // The crux: `outer` rendered at ROOT (empty path); `inner` rendered
    // under outer's child scope, so its parent.path is ["outer"]. The
    // path flowed boundary→boundary with no parent prop in sight.
    expect(out).toContain(`"data-path":""`)
    expect(out).toContain(`"data-path":"outer"`)
  })

  it("registers null outside a boundary scope (caller renders inline)", async () => {
    // No renderWithBoundaries wrapper → registerBoundary returns null, so
    // a stray render with no boundary scope has no id to splice against.
    const bid = registerBoundary(renderToReadableStream(<span>x</span>))
    expect(bid).toBeNull()
  })
})
