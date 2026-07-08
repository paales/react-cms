/**
 * Per-parton error containment.
 *
 * A parton resolves its prop cells (`await resolveCellValue`) and runs
 * its `Render` ABOVE the per-partial `PartialErrorBoundary` (that
 * boundary only wraps the already-resolved body). A throw in either
 * phase therefore escapes the boundary; before containment it
 * propagated all the way to the RSC entry and crashed the whole page
 * (cold loads 500'd; client navigations replaced the app with the
 * global "something went wrong" boundary).
 *
 * The spec wrapper now catches those throws and renders the partial's
 * own error card in place, so one failing parton can't take down its
 * siblings or the surrounding chrome. Framework-branded controls
 * (`notFound` / `redirect` / `NavigationError`) keep bubbling — they
 * are routed by the RSC entry / host boundary, not contained.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { parton, PartialRoot, type RenderArgs } from "../partial.tsx"
import { localCell, type ResolvedCell } from "../cell.ts"
import { MemoryCellStorage, setCellStorage, _resetCellStorage } from "../../runtime/cell-storage.ts"
import { renderWithRequest } from "../../test/rsc-server.ts"
import { clearRegistry } from "../partial-registry.ts"
import { notFound } from "../../runtime/errors.ts"

beforeEach(() => {
  setCellStorage(new MemoryCellStorage())
})

afterEach(() => {
  _resetCellStorage()
})

async function flightAt(url: string, node: React.ReactNode): Promise<string> {
  const { stream } = await renderWithRequest(url, node)
  return await new Response(stream).text()
}

describe("per-parton error containment", () => {
  it("a cell-loader throw in props resolution is contained — the sibling parton still renders", async () => {
    clearRegistry("all")

    // A prop-bound cell whose loader throws (stands in for a GraphQL
    // failure — the magento cart's real failure mode). The props
    // cell-resolution phase awaits the loader inside the spec wrapper,
    // above the per-partial boundary; the body must never reach the
    // wire.
    const doomed = localCell<"opaque", string>({
      id: "test.contain.doomed",
      shape: "opaque",
      initial: "",
      load: async () => {
        throw new Error("cell load failed")
      },
    })
    const Boom = parton(
      function BoomCellRender({ data }: { data: ResolvedCell<string> } & RenderArgs) {
        return <span data-testid="boom-body">SHOULD-NOT-RENDER-{data.value}</span>
      },
      { match: "/contain" },
    )

    const Healthy = parton(
      function HealthySiblingRender(_: RenderArgs) {
        return <span data-testid="healthy-body">HEALTHY-OK</span>
      },
      { selector: "#healthy", match: "/contain" },
    )

    const out = await flightAt(
      "http://t/contain",
      <PartialRoot>
        <Boom data={doomed.with({ k: "x" })} />
        <Healthy />
      </PartialRoot>,
    )

    // Containment: the sibling rendered despite Boom throwing.
    expect(out).toContain("HEALTHY-OK")
    // Boom's normal body never reached the wire (the loader threw).
    expect(out).not.toContain("SHOULD-NOT-RENDER")
    // The failing parton surfaced its error card. Match the rendered
    // client-reference row (`module#export`) rather than the bare
    // symbol — in dev, Flight serializes the wrapper's function source,
    // which mentions `PartialErrorCard` even when no card renders. The
    // card also carries the spec's catalog id (`BoomCellRender` →
    // "boom-cell"), which only appears in the rendered card's props.
    expect(out).toContain("partial-error-boundary.tsx#PartialErrorCard")
    expect(out).toContain("boom-cell")
  })

  it("a synchronous Render throw is contained the same way", async () => {
    clearRegistry("all")

    const Boom = parton(
      function BoomRenderThrow(_: RenderArgs) {
        throw new Error("render exploded")
      },
      { selector: "#boom-render", match: "/contain2" },
    )

    const Healthy = parton(
      function HealthySibling2Render(_: RenderArgs) {
        return <span data-testid="healthy2-body">HEALTHY-2-OK</span>
      },
      { selector: "#healthy2", match: "/contain2" },
    )

    const out = await flightAt(
      "http://t/contain2",
      <PartialRoot>
        <Boom />
        <Healthy />
      </PartialRoot>,
    )

    expect(out).toContain("HEALTHY-2-OK")
    expect(out).toContain("partial-error-boundary.tsx#PartialErrorCard")
    expect(out).toContain("boom-render")
  })

  it("framework-branded controls (notFound) still bubble past containment", async () => {
    clearRegistry("all")

    // `notFound()` throws a `__framework`-branded error. The
    // containment catch rethrows branded errors, so it surfaces as a
    // Flight error chunk (routed by the RSC entry / host boundary)
    // rather than being swallowed into an error card — otherwise
    // notFound/redirect would stop reaching the entry.
    const NotFoundParton = parton(
      function NotFoundPartonRender(_: RenderArgs) {
        notFound()
        return null
      },
      { selector: "#nf", match: "/nf" },
    )

    const out = await flightAt(
      "http://t/nf",
      <PartialRoot>
        <NotFoundParton />
      </PartialRoot>,
    )

    // Bubbled, not contained: the error reached the wire as an error
    // row and no error-card client reference was rendered for it.
    expect(out).toContain(":E{")
    expect(out).not.toContain("partial-error-boundary.tsx#PartialErrorCard")
  })
})
