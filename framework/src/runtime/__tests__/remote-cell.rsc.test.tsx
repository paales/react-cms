/**
 * remoteCell — outward state across the boundary, in-process.
 *
 * The "remote" is a real `createRemoteHandler` served through a
 * stubbed fetch, so both halves run against the genuine endpoint code:
 *
 *  - producer: `publish` authorization on the attach and the value
 *    read (unpublished/guard-denied → 403, existence undisclosed);
 *    the attach's NDJSON stream ships an acceptance line and then one
 *    `{selectors}` batch per commit section — doorbells, never
 *    values;
 *  - host: `remoteCell(...)` — first resolve attaches + loads over
 *    HTTP; a producer-side write's doorbell DROPS the host cache and
 *    re-emits through `deliverInvalidationBumps`, so the next resolve
 *    re-reads the CURRENT value over the value endpoint (fetch-count
 *    asserted: the doorbell, not the shared in-process registry, is
 *    what forces the re-read); a parton reading the handle records
 *    the `cell:` dep and re-renders with the fresh value.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PartialRoot, computeRouteKey, parton, type RenderArgs } from "../../lib/partial.tsx"
import { localCell } from "../../lib/cell.ts"
import { _readSnapshotsForRoute } from "../../lib/partial-registry.ts"
import { wrapStreamWithCommitOnly } from "../../lib/fp-trailer.ts"
import { REMOTE_CELL_VALUE_PATH } from "../../lib/page-embed.ts"
import { createRemoteHandler } from "../remote-endpoints.tsx"
import { remoteCell } from "../remote-cell.ts"
import { encodeCapability } from "../capability.ts"
import { CAPABILITY_HEADER } from "../capability.ts"
import { getCellStorage } from "../cell-storage.ts"
import { _captureCommitHandle, runWithRequestAsync } from "../context.ts"
import { renderServerToFlight, type FlightBytes } from "../../test/rsc-server.ts"

const REMOTE = "http://remote.t"
const handler = createRemoteHandler({ name: "rc-test" })

async function streamToText(stream: FlightBytes): Promise<string> {
  return new Response(stream).text()
}

/** Route every fetch to the real remote handler; count value reads. */
function stubRemoteFetch(): { valueReads: () => number } {
  let valueReads = 0
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      if (!url.startsWith(REMOTE)) throw new Error(`unexpected fetch ${url}`)
      if (new URL(url).pathname === REMOTE_CELL_VALUE_PATH) valueReads++
      const response = await handler(new Request(url, init))
      if (response === null) throw new Error(`unhandled remote path ${url}`)
      return response
    },
  )
  return { valueReads: () => valueReads }
}

async function waitFor(predicate: () => boolean | Promise<boolean>, ms = 2000): Promise<void> {
  const start = Date.now()
  while (!(await predicate())) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out")
    await new Promise((r) => setTimeout(r, 10))
  }
}

let warnSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
})
afterEach(() => {
  warnSpy.mockRestore()
  vi.unstubAllGlobals()
  getCellStorage().clear("all")
})

const inRequest = <T,>(fn: () => Promise<T>): Promise<T> =>
  runWithRequestAsync(new Request("http://host.t/page"), fn).then((r) => r.result)

// ─── Producer auth ─────────────────────────────────────────────────────

describe("producer — publish authorization", () => {
  it("denies the attach for unpublished and unknown cells alike (403)", async () => {
    localCell({ id: "rc.private", shape: "number", initial: 1 })
    for (const cells of [["rc.private"], ["rc.does-not-exist"]]) {
      const res = await handler(
        new Request(`${REMOTE}/__remote/cells/attach`, {
          method: "POST",
          body: JSON.stringify({ cells }),
        }),
      )
      expect(res!.status).toBe(403)
    }
  })

  it("a publish guard authorizes per presented capability — attach and value read", async () => {
    localCell({
      id: "rc.gold",
      shape: "number",
      initial: 7,
      publish: (cap) => cap.tier === "gold",
    })
    const attach = (cap?: Record<string, string>) =>
      handler(
        new Request(`${REMOTE}/__remote/cells/attach`, {
          method: "POST",
          headers: cap ? { [CAPABILITY_HEADER]: encodeCapability(cap) } : {},
          body: JSON.stringify({ cells: ["rc.gold"] }),
        }),
      )
    expect((await attach())!.status).toBe(403)
    expect((await attach({ tier: "silver" }))!.status).toBe(403)
    const ok = await attach({ tier: "gold" })
    expect(ok!.status).toBe(200)
    await ok!.body!.cancel()

    const read = (cap?: Record<string, string>) =>
      handler(
        new Request(`${REMOTE}${REMOTE_CELL_VALUE_PATH}?cell=rc.gold`, {
          headers: cap ? { [CAPABILITY_HEADER]: encodeCapability(cap) } : {},
        }),
      )
    expect((await read())!.status).toBe(403)
    const value = await read({ tier: "gold" })
    expect(value!.status).toBe(200)
    expect(await value!.json()).toEqual({ value: 7 })
  })
})

// ─── The full loop ─────────────────────────────────────────────────────

describe("host — doorbell, drop, re-read", () => {
  it("a producer-side write re-reads through the value endpoint and re-renders a reading parton", async () => {
    const producerBid = localCell({
      id: "rc.bid",
      shape: "number",
      initial: 100,
      publish: true,
    })
    const { valueReads } = stubRemoteFetch()
    const bid = remoteCell<number>({ origin: REMOTE, id: "rc.bid", initial: 0 })

    // First resolve: attaches + loads over HTTP.
    const first = await inRequest(() => bid.resolve())
    expect(first.value).toBe(100)
    expect(valueReads()).toBe(1)

    // A resolve WITHOUT a doorbell serves the host cache — no read.
    const cached = await inRequest(() => bid.resolve())
    expect(cached.value).toBe(100)
    expect(valueReads()).toBe(1)

    // The remote process commits a write (the endpoint handler's own
    // pipeline would do the same — one commit section, one batch).
    await inRequest(async () => {
      await producerBid.set(150)
    })

    // The doorbell drops the host cache; the next resolve re-reads the
    // CURRENT value over HTTP. Polls BEFORE the doorbell serve the
    // cached 100 with no read, so the fetch count landing on exactly 2
    // proves the doorbell (not the shared in-process registry) forced
    // the re-read.
    await waitFor(async () => (await inRequest(() => bid.resolve())).value === 150)
    expect(valueReads()).toBe(2)

    // A parton reading the handle records the dep and renders the
    // fresh value.
    const RcReader = parton(
      async function RcReaderRender(_: RenderArgs) {
        const current = await bid.resolve()
        return <div data-testid="rc-reader">rc-bid:{current.value}</div>
      },
      { match: "/rc-page", selector: "rc-reader" },
    )
    const url = "http://host.t/rc-page"
    const { result: wire } = await runWithRequestAsync(new Request(url), async () => {
      const stream = wrapStreamWithCommitOnly(
        renderServerToFlight(
          <PartialRoot>
            <html lang="en">
              <body>
                <RcReader />
              </body>
            </html>
          </PartialRoot>,
        ),
        _captureCommitHandle(),
      )
      return streamToText(stream)
    })
    expect(wire).toContain('["rc-bid:",150]')
    const snap = _readSnapshotsForRoute("default", computeRouteKey(url)).get("rc-reader")
    expect(snap).toBeDefined()
    expect([...(snap!.deps ?? [])]).toContain("cell:rc.bid")

    bid.detach()
  })

  it("an attach denial is permanent for the handle and logged once; reads fail explicitly", async () => {
    localCell({ id: "rc.closed", shape: "number", initial: 5 })
    stubRemoteFetch()
    const closed = remoteCell<number>({ origin: REMOTE, id: "rc.closed", initial: 0 })
    await expect(inRequest(() => closed.resolve())).rejects.toThrow("value read failed (403)")
    await waitFor(() => warnSpy.mock.calls.some((c) => String(c[0]).includes("attach denied")))
    closed.detach()
  })
})
