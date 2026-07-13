/**
 * Bound cells — the inward state contract (`remote-frame.md` § Bound
 * cells), in-process. The "remote" is the app itself: the stubbed
 * fetch renders the requested page through the harness inside its own
 * request scope, mirroring the entry's embed branch — including the
 * projection decode (`x-parton-embed-cells` body →
 * `runWithBoundCellProjection`).
 *
 * Covers:
 *  - wire shape: bindings make the embed fetch a POST whose JSON body
 *    carries the projected VALUES; no bindings keeps the GET;
 *  - producer enforcement: a missing REQUIRED binding fails the
 *    render explicitly; optional absence renders; an UNDECLARED
 *    binding does not cross `getBoundCells()`;
 *  - standalone visits (no embed headers) read `{}` and enforce
 *    nothing;
 *  - host dep recording: the enclosing parton's in-body resolve
 *    records the `cell:` dep (the re-projection trigger);
 *  - refetch: `partialFromSnapshot` on the placement RE-RESOLVES the
 *    stamps — the focused POST carries the CURRENT host value, never
 *    the placement-time projection;
 *  - non-resolved bindings (module handle / BoundCell) throw the
 *    guidance error.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Suspense, type ReactNode } from "react"
import { PartialRoot, computeRouteKey, parton, partialFromSnapshot } from "../partial.tsx"
import type { RenderArgs } from "../partial.tsx"
import { RemoteFrame } from "../remote-frame.tsx"
import {
  EMBED_CELLS_HEADER,
  EMBED_DEPTH_HEADER,
  EMBED_NS_HEADER,
  applyEmbedNamespace,
  embedNamespaceOf,
} from "../page-embed.ts"
import { localCell } from "../cell.ts"
import { getBoundCells } from "../server-hooks.ts"
import {
  _readSnapshotsForRoute,
  type PageSnapshotSource,
  type PartialSnapshot,
} from "../partial-registry.ts"
import { wrapStreamWithCommitOnly } from "../fp-trailer.ts"
import { rewriteFlightStream, type RowRewriter } from "../flight-rewrite.ts"
import { wrapStreamWithSnapshotTrailer } from "../snapshot-trailer.ts"
import { HEADER_RSC_RENDER } from "../../runtime/request.tsx"
import { _captureCommitHandle, runWithRequestAsync } from "../../runtime/context.ts"
import { runWithBoundCellProjection } from "../../runtime/capability.ts"
import { getCellStorage } from "../../runtime/cell-storage.ts"
import { renderServerToFlight, type FlightBytes } from "../../test/rsc-server.ts"

async function streamToText(stream: FlightBytes): Promise<string> {
  return new Response(stream).text()
}

const neutralizeClientRefs: RowRewriter = (row) =>
  row.type === "I" ? { ...row, type: "", data: '"client-ref"' } : row

/** Entry-shaped page render: commit-only wrap + snapshots trailer,
 *  with the projection decoded into scope exactly like
 *  `handleEmbedRender` does. */
async function renderPageStream(
  root: ReactNode,
  url: string,
  headers: Record<string, string>,
  projection: Record<string, unknown> | null,
): Promise<FlightBytes> {
  const request = new Request(url, { headers })
  const { result } = await runWithRequestAsync(request, async () => {
    const routeKey = computeRouteKey(url)
    const ns = embedNamespaceOf(new Headers(headers))
    const getSnapshots = () => {
      const all = _readSnapshotsForRoute("default", routeKey)
      if (ns === null) return all
      const own = new Map<string, PartialSnapshot>()
      for (const [id, snap] of all) if (id.startsWith(`${ns}:`)) own.set(id, snap)
      return own
    }
    const render = () =>
      rewriteFlightStream(
        renderServerToFlight({ root } as unknown as ReactNode),
        neutralizeClientRefs,
      )
    const stream = wrapStreamWithSnapshotTrailer(
      wrapStreamWithCommitOnly(
        projection === null ? render() : runWithBoundCellProjection(projection, render),
        _captureCommitHandle(),
      ),
      getSnapshots,
    )
    const [forCaller, forDrain] = stream.tee()
    await new Response(forDrain).arrayBuffer()
    return forCaller
  })
  return result
}

type FetchCall = { url: string; method: string; headers: Headers; body: string | null }

/** Self-serving fetch honoring the embed-cells contract: a flagged
 *  POST's body decodes into the projection scope for the page render. */
function stubSelfServingFetch(pageFor: (url: string) => ReactNode): { calls: FetchCall[] } {
  const calls: FetchCall[] = []
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      const headers = new Headers(init?.headers)
      const body = typeof init?.body === "string" ? init.body : null
      calls.push({ url, method: init?.method ?? "GET", headers, body })
      const headerRecord: Record<string, string> = {}
      headers.forEach((v, k) => {
        headerRecord[k] = v
      })
      let projection: Record<string, unknown> | null = null
      if (headers.get(EMBED_CELLS_HEADER) === "1" && body !== null) {
        projection = (JSON.parse(body) as { cells: Record<string, unknown> }).cells
      }
      return new Response(await renderPageStream(pageFor(url), url, headerRecord, projection), {
        status: 200,
        headers: { "content-type": "text/x-component;charset=utf-8" },
      })
    },
  )
  return { calls }
}

beforeEach(() => {
  vi.unstubAllGlobals()
})
afterEach(() => {
  vi.unstubAllGlobals()
  getCellStorage().clear("default")
})

// ─── Fixtures ──────────────────────────────────────────────────────────

/** Host-side cell — the binding source. */
const ecCart = localCell({
  id: "ec.cart",
  shape: "opaque",
  initial: { total: 40, items: 2 } as { total: number; items: number },
})

/** The embeddable page's spec: requires `cart`, optional `locale`. */
const EcCartNote = parton(
  async function EcCartNoteRender(_: RenderArgs) {
    const bound = getBoundCells()
    const cart = (bound.cart ?? null) as { total: number; items: number } | null
    return (
      <div data-testid="ec-note">
        {cart === null
          ? "ec-standalone"
          : `ec-total:${cart.total};ec-locale:${String(bound.locale ?? "none")};ec-secret:${String(
              bound.secret ?? "did-not-cross",
            )}`}
      </div>
    )
  },
  {
    selector: "ec-cart-note",
    match: "/ec/cart-note",
    cells: { cart: { required: true }, locale: {} },
  },
)

function EmbeddedRoot() {
  return (
    <PartialRoot>
      <html lang="en">
        <body>
          <EcCartNote />
        </body>
      </html>
    </PartialRoot>
  )
}

const EcHostPage = parton(
  async function EcHostRender(_: RenderArgs) {
    const cart = await ecCart.resolve()
    return (
      <section data-testid="ec-host">
        <Suspense fallback={null}>
          <RemoteFrame url="/ec/cart-note" cells={{ cart }} />
        </Suspense>
      </section>
    )
  },
  { match: "/ec-host", selector: "#ec-host-spec" },
)

function hostRoot(children: ReactNode): ReactNode {
  return (
    <PartialRoot>
      <html lang="en">
        <body>{children}</body>
      </html>
    </PartialRoot>
  )
}

// ─── Tests ─────────────────────────────────────────────────────────────

describe("bound cells — wire shape", () => {
  it("bindings make the embed a flagged POST carrying projected values; the page renders them", async () => {
    const { calls } = stubSelfServingFetch(() => <EmbeddedRoot />)
    const out = await streamToText(
      await renderPageStream(hostRoot(<EcHostPage />), "http://t/ec-host", {}, null),
    )

    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe("POST")
    expect(calls[0].headers.get(EMBED_CELLS_HEADER)).toBe("1")
    expect(calls[0].headers.get(HEADER_RSC_RENDER)).toBe("1")
    expect(JSON.parse(calls[0].body!)).toEqual({ cells: { cart: { total: 40, items: 2 } } })

    // The embedded render read the projected VALUE.
    expect(out).toContain("ec-total:40")
    // Optional binding absent — the body branched, no failure.
    expect(out).toContain("ec-locale:none")
  })

  it("no bindings keeps the embed a GET with no cells header", async () => {
    const NoCellsHost = parton(
      function EcNoCellsHostRender(_: RenderArgs) {
        return (
          <Suspense fallback={null}>
            <RemoteFrame url="/ec/free-page" />
          </Suspense>
        )
      },
      { match: "/ec-nocells-host", selector: "#ec-nocells-host-spec" },
    )
    const { calls } = stubSelfServingFetch(() => (
      <PartialRoot>
        <html lang="en">
          <body>free-page-content</body>
        </html>
      </PartialRoot>
    ))
    await streamToText(
      await renderPageStream(hostRoot(<NoCellsHost />), "http://t/ec-nocells-host", {}, null),
    )
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe("GET")
    expect(calls[0].headers.get(EMBED_CELLS_HEADER)).toBeNull()
    expect(calls[0].body).toBeNull()
  })

  it("rejects non-resolved bindings with the resolve-in-body guidance", async () => {
    const BadHost = parton(
      function EcBadHostRender(_: RenderArgs) {
        return <RemoteFrame url="/ec/cart-note" cells={{ cart: ecCart as never }} />
      },
      { match: "/ec-bad-host", selector: "#ec-bad-host-spec" },
    )
    stubSelfServingFetch(() => <EmbeddedRoot />)
    const out = await streamToText(
      await renderPageStream(hostRoot(<BadHost />), "http://t/ec-bad-host", {}, null),
    )
    expect(out).toContain("must be a RESOLVED cell")
  })
})

describe("bound cells — producer enforcement", () => {
  it("a missing required binding fails the embed render explicitly", async () => {
    const out = await streamToText(
      await renderPageStream(
        <EmbeddedRoot />,
        "http://t/ec/cart-note",
        {
          [HEADER_RSC_RENDER]: "1",
          [EMBED_DEPTH_HEADER]: "1",
          [EMBED_NS_HEADER]: "e~cafef00d",
        },
        // Projection present but missing the required name.
        { locale: "nl" },
      ),
    )
    // The wire carries the explicit produce-side failure — the spec's
    // own error containment ships it as the parton's error card, which
    // is exactly what a host splices and surfaces at its boundary.
    expect(out).toContain("required bound cell")
    expect(out).toContain("was not bound by the embedding host")
    expect(out).not.toContain("ec-total:")
  })

  it("an undeclared binding does not cross the spec boundary", async () => {
    const out = await streamToText(
      await renderPageStream(
        <EmbeddedRoot />,
        "http://t/ec/cart-note",
        {
          [HEADER_RSC_RENDER]: "1",
          [EMBED_DEPTH_HEADER]: "1",
          [EMBED_NS_HEADER]: "e~cafef00d",
        },
        { cart: { total: 7, items: 1 }, locale: "nl", secret: "leak-me" },
      ),
    )
    expect(out).toContain("ec-total:7")
    expect(out).toContain("ec-locale:nl")
    expect(out).toContain("ec-secret:did-not-cross")
    expect(out).not.toContain("leak-me")
  })

  it("a standalone (non-embed) visit enforces nothing and reads {}", async () => {
    const out = await streamToText(
      await renderPageStream(<EmbeddedRoot />, "http://t/ec/cart-note", {}, null),
    )
    expect(out).toContain("ec-standalone")
  })
})

describe("bound cells — dep recording + refetch re-resolution", () => {
  it("the enclosing parton's in-body resolve records the cell dep", async () => {
    stubSelfServingFetch(() => <EmbeddedRoot />)
    await streamToText(
      await renderPageStream(hostRoot(<EcHostPage />), "http://t/ec-host", {}, null),
    )
    const snapshots = _readSnapshotsForRoute("default", computeRouteKey("http://t/ec-host"))
    const hostSnap = snapshots.get("ec-host-spec")
    expect(hostSnap).toBeDefined()
    expect([...(hostSnap!.deps ?? [])]).toContain("cell:ec.cart")
  })

  it("a placement refetch re-resolves the stamps — the focused POST carries the CURRENT value", async () => {
    const { calls } = stubSelfServingFetch(() => <EmbeddedRoot />)
    await streamToText(
      await renderPageStream(hostRoot(<EcHostPage />), "http://t/ec-host", {}, null),
    )
    expect(calls).toHaveLength(1)
    const ns = calls[0].headers.get(EMBED_NS_HEADER)!
    const id = applyEmbedNamespace(ns, "ec-cart-note")
    const snapshots = _readSnapshotsForRoute("default", computeRouteKey("http://t/ec-host"))
    const snap = snapshots.get(id)
    expect(snap).toBeDefined()
    const source = snap!.source as PageSnapshotSource
    expect(source.cells).toEqual({ cart: { cellId: "ec.cart" } })

    // Host state moves between placement and refetch.
    await runWithRequestAsync(new Request("http://t/ec-host"), async () => {
      await ecCart.set({ total: 99, items: 5 })
    })

    const out = await streamToText(
      await renderPageStream(
        <>{partialFromSnapshot(id, snap!)}</>,
        "http://t/ec-refetch-host",
        {},
        null,
      ),
    )
    // The refetch fetched the embedded URL focused, as a projected POST…
    expect(calls).toHaveLength(2)
    const refetch = calls[1]
    expect(refetch.method).toBe("POST")
    const fetched = new URL(refetch.url)
    expect(fetched.origin + fetched.pathname).toBe("http://t/ec/cart-note")
    expect(fetched.searchParams.get("partials")).toBe(id)
    // …carrying the CURRENT host value, not the placement-time one.
    expect(JSON.parse(refetch.body!)).toEqual({ cells: { cart: { total: 99, items: 5 } } })
    expect(out).toContain("ec-total:99")
  })
})
