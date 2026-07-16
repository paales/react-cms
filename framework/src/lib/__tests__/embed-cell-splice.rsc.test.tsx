/**
 * `<RemoteFrame>` — a resolved cell spliced across the embed boundary.
 *
 * The shape under test: an embedded page's parton resolves a cell and
 * passes the whole `ResolvedCell` (carrying `set`) into a `"use
 * client"` component. The host decodes that page payload and re-encodes
 * `payload.root` into its OWN document Flight render. A cell's write
 * routing must survive that hop WITHOUT stalling the host stream — the
 * regression guard for the embed-splice write path.
 *
 * The harness renders the "remote" through the same in-process pipeline
 * the host render uses (genuine same-origin self-embedding). Client
 * refs are neutralised to plain intrinsics (the bare worker has no
 * client-module loader), but the cell's write routing rides the payload
 * as data, so the splice + re-encode is exercised end to end.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Suspense, type ReactNode } from "react"
import { PartialRoot, computeRouteKey, parton } from "../partial.tsx"
import type { RenderArgs } from "../partial.tsx"
import { RemoteFrame } from "../remote-frame.tsx"
import { EMBED_DEPTH_HEADER, EMBED_NS_HEADER, embedNamespaceOf } from "../page-embed.ts"
import { _readSnapshotsForRoute, type PartialSnapshot } from "../partial-registry.ts"
import { wrapStreamWithCommitOnly } from "../fp-trailer.ts"
import { rewriteFlightStream, type RowRewriter } from "../flight-rewrite.ts"
import { wrapStreamWithSnapshotTrailer } from "../snapshot-trailer.ts"
import { localCell, _clearCellRegistry } from "../cell.ts"
import { ClientCellConsumer } from "../../test/__fixtures__/client-cell-consumer.tsx"
import { _captureCommitHandle, runWithRequestAsync } from "../../runtime/context.ts"
import { renderServerToFlight, type FlightBytes } from "../../test/rsc-server.ts"

/** Neutralise client-ref import rows to a plain intrinsic — the bare
 *  worker can't resolve a decoded client lazy. The cell's write routing
 *  rides the payload as data (props of the intrinsic), so the splice
 *  still re-encodes whatever the resolved cell carried. */
const neutralizeClientRefs: RowRewriter = (row) =>
  row.type === "I" ? { ...row, type: "", data: '"client-ref"' } : row

async function renderPageStream(
  root: ReactNode,
  url: string,
  headers: Record<string, string>,
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
    const stream = wrapStreamWithSnapshotTrailer(
      wrapStreamWithCommitOnly(
        rewriteFlightStream(
          renderServerToFlight({ root } as unknown as ReactNode),
          neutralizeClientRefs,
        ),
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

async function pageResponse(
  root: ReactNode,
  url: string,
  headers: Record<string, string>,
): Promise<Response> {
  return new Response(await renderPageStream(root, url, headers), {
    status: 200,
    headers: { "content-type": "text/x-component;charset=utf-8" },
  })
}

function stubSelfServingFetch(pageFor: (url: string) => ReactNode): void {
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      const headers = new Headers(init?.headers)
      const headerRecord: Record<string, string> = {}
      headers.forEach((v, k) => {
        headerRecord[k] = v
      })
      return pageResponse(pageFor(url), url, headerRecord)
    },
  )
}

/** Fail fast: the pre-fix hang never resolves, so a completed render
 *  within a short window is the whole assertion. */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`render did not settle within ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer!)
  }
}

const counterCell = localCell({ id: "embed-splice-counter", shape: "number", initial: 7 })

const CellHolder = parton(
  Object.assign(
    async function EmbedSpliceCellHolderRender(_: RenderArgs) {
      // Resolve at an explicit partition — the resolved view's `set`
      // then binds a partition OBJECT, the exact arg shape that stalls
      // the host re-encode in production (a single-string bound id
      // survives; a bound object does not).
      const cell = await counterCell.resolve({ slot: "a" })
      return <ClientCellConsumer cell={cell} />
    },
    { displayName: "embed-splice-cell-holder" },
  ),
)

function EmbeddedRoot() {
  return (
    <PartialRoot>
      <html lang="en">
        <body>
          <div data-testid="embedded-content">embedded-hello</div>
          <CellHolder />
        </body>
      </html>
    </PartialRoot>
  )
}

const HostPage = parton(
  Object.assign(
    function EmbedSpliceHostRender(_: RenderArgs) {
      return (
        <section data-testid="embed-host">
          <Suspense fallback={<div>loading embed…</div>}>
            <RemoteFrame url="/embedded-cell" />
          </Suspense>
        </section>
      )
    },
    { displayName: "embed-splice-host" },
  ),
  { match: "/embed-splice-host" },
)

function HostRoot() {
  return (
    <PartialRoot>
      <html lang="en">
        <body>
          <HostPage />
        </body>
      </html>
    </PartialRoot>
  )
}

beforeEach(() => {
  vi.unstubAllGlobals()
})
afterEach(() => {
  vi.unstubAllGlobals()
  _clearCellRegistry()
})

describe("page embed — a resolved cell spliced into a client component", () => {
  it("the host stream settles and the resolved cell crosses as data", async () => {
    stubSelfServingFetch(() => <EmbeddedRoot />)
    const out = await withTimeout(
      renderPageStream(<HostRoot />, "http://t/embed-splice-host", {}).then((s) =>
        new Response(s).text(),
      ),
      4000,
    )
    // The embedded content splices in — proof the host stream closed
    // (the bound-server-ref hang never resolves).
    expect(out).toContain("embedded-hello")
    // The resolved cell crossed intact — id + value + partition ride as
    // data. The id + partition are the write routing: the client `.set`
    // reconstructs the SAME `cell:embed-splice-counter?slot=a` selector
    // from them, so the invalidation fan-out is unchanged.
    expect(out).toContain('"id":"embed-splice-counter"')
    expect(out).toContain('"value":7')
    expect(out).toContain('"partition":{"slot":"a"}')
    // No bound server reference re-encoded across the splice: the host
    // never tries to resolve `__cellWrite` from its server manifest
    // (the failure mode the fix removes — a hang in prod, a
    // manifest-miss error in this harness). The write rides as a client
    // reference instead.
    expect(out).not.toContain("cell-actions")
    expect(out).not.toContain("Could not find the module")
  })

  it("stamps the embed request headers for the cell-holding page", async () => {
    const seen: Headers[] = []
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url
        const headers = new Headers(init?.headers)
        seen.push(headers)
        const headerRecord: Record<string, string> = {}
        headers.forEach((v, k) => {
          headerRecord[k] = v
        })
        return pageResponse(<EmbeddedRoot />, url, headerRecord)
      },
    )
    await withTimeout(
      renderPageStream(<HostRoot />, "http://t/embed-splice-host", {}).then((s) =>
        new Response(s).text(),
      ),
      4000,
    )
    expect(seen).toHaveLength(1)
    expect(seen[0].get(EMBED_DEPTH_HEADER)).toBe("1")
    expect(seen[0].get(EMBED_NS_HEADER)).toMatch(/^e~[0-9a-f]+$/)
  })
})
