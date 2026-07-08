/**
 * Attach dispatch — the dedicated path is the signal, and the
 * statement decoder's grammar.
 *
 * The attach is a POST to its own endpoint (`/__parton/live`); the
 * only `_.rsc` request kind is an action POST (`x-rsc-action`).
 * `parseRenderRequest`'s verdict is what the entry's wrap/drive
 * decision keys on, so the claims pin the verdicts: an action whose
 * body happens to be statement-shaped stays an action (no drive), a
 * marker-less `_.rsc` POST is ill-formed, and a `_.rsc` GET is not a
 * render request at all (documents are the only GETs). Alongside: the
 * statement decoder's grammar (the required `url`, attach-with-intent
 * `frames`, unknown fields ignored — the statement grows by adding
 * them; malformed KNOWN fields are protocol violations).
 */

import { describe, expect, it } from "vitest"
import { type AttachStatement, decodeAttachStatement } from "../channel-protocol.ts"
import { createRscRenderRequest, parseRenderRequest } from "../../runtime/request.tsx"

const statement: AttachStatement = {
  url: "/page?q=a",
  cached: ["a:mk:f1", "b:mk:f2"],
  since: { epoch: "e1", ts: 42 },
  visible: ["a"],
  applied: 7,
}

describe("decodeAttachStatement", () => {
  it("decodes the full statement", () => {
    expect(decodeAttachStatement(JSON.parse(JSON.stringify(statement)))).toEqual(statement)
  })

  it("normalizes absent since/visible to null and absent applied to 0", () => {
    expect(decodeAttachStatement({ url: "/p", cached: [] })).toEqual({
      url: "/p",
      cached: [],
      since: null,
      visible: null,
      applied: 0,
    })
  })

  it("keeps the empty-array/null distinction on visible", () => {
    // [] is a measurement ("nothing in view"); null is no statement.
    expect(decodeAttachStatement({ url: "/p", cached: [], visible: [] })?.visible).toEqual([])
    expect(decodeAttachStatement({ url: "/p", cached: [], visible: null })?.visible).toBeNull()
  })

  it("decodes attach-with-intent frames — frame-scoped url statements", () => {
    const decoded = decodeAttachStatement({
      url: "/p",
      cached: [],
      frames: [{ url: "/cart/open", intent: "silent", frame: ["cart"] }],
    })
    expect(decoded?.frames).toEqual([
      { kind: "url", url: "/cart/open", intent: "silent", frame: ["cart"] },
    ])
    // An empty frames array decodes as no intent at all.
    expect(decodeAttachStatement({ url: "/p", cached: [], frames: [] })?.frames).toBeUndefined()
  })

  it("rejects window-scoped frames entries — the url field IS the window statement", () => {
    expect(
      decodeAttachStatement({
        url: "/p",
        cached: [],
        frames: [{ url: "/q", intent: "push" }],
      }),
    ).toBeNull()
  })

  it("ignores unknown fields — the statement grows by adding them", () => {
    expect(decodeAttachStatement({ url: "/p", cached: [], ack: 7, telemetry: { w: 1 } })).toEqual({
      url: "/p",
      cached: [],
      since: null,
      visible: null,
      applied: 0,
    })
  })

  it("rejects malformed known fields", () => {
    expect(decodeAttachStatement(null)).toBeNull()
    expect(decodeAttachStatement("nope")).toBeNull()
    expect(decodeAttachStatement({})).toBeNull()
    // `url` is required — a statement without one states no request.
    expect(decodeAttachStatement({ cached: [] })).toBeNull()
    expect(decodeAttachStatement({ url: "", cached: [] })).toBeNull()
    expect(decodeAttachStatement({ url: "/p", cached: "a,b" })).toBeNull()
    expect(decodeAttachStatement({ url: "/p", cached: [1] })).toBeNull()
    expect(decodeAttachStatement({ url: "/p", cached: [], since: "e1:42" })).toBeNull()
    expect(decodeAttachStatement({ url: "/p", cached: [], since: { epoch: "", ts: 1 } })).toBeNull()
    expect(
      decodeAttachStatement({
        url: "/p",
        cached: [],
        since: { epoch: "e", ts: Number.NaN },
      }),
    ).toBeNull()
    expect(
      decodeAttachStatement({ url: "/p", cached: [], since: { epoch: "e", ts: -1 } }),
    ).toBeNull()
    expect(decodeAttachStatement({ url: "/p", cached: [], visible: "a,b" })).toBeNull()
    // `applied` is a KNOWN field — malformed values are protocol
    // violations, not extensibility.
    expect(decodeAttachStatement({ url: "/p", cached: [], applied: "3" })).toBeNull()
    expect(decodeAttachStatement({ url: "/p", cached: [], applied: -1 })).toBeNull()
    expect(decodeAttachStatement({ url: "/p", cached: [], applied: Number.NaN })).toBeNull()
    // `frames` entries are KNOWN — malformed shapes are violations.
    expect(decodeAttachStatement({ url: "/p", cached: [], frames: [{}] })).toBeNull()
    expect(
      decodeAttachStatement({
        url: "/p",
        cached: [],
        frames: [{ url: "/q", intent: "silent", frame: [] }],
      }),
    ).toBeNull()
  })
})

describe("parseRenderRequest — the one _.rsc request kind", () => {
  it("an action POST with a statement-shaped body stays an action", () => {
    const request = createRscRenderRequest("http://localhost/page", {
      id: "act-1",
      body: JSON.stringify(statement),
    })
    const parsed = parseRenderRequest(request)
    expect(parsed.isRsc).toBe(true)
    expect(parsed.isAction).toBe(true)
    expect(parsed.actionId).toBe("act-1")
  })

  it("a marker-less _.rsc POST is rejected", () => {
    const request = new Request("http://localhost/page_.rsc", {
      method: "POST",
      body: "{}",
    })
    expect(() => parseRenderRequest(request)).toThrow(/Missing action id/)
  })

  it("a _.rsc GET is not a render request — documents are the only GETs", () => {
    const parsed = parseRenderRequest(new Request("http://localhost/page_.rsc"))
    expect(parsed.isRsc).toBe(false)
    expect(parsed.isAction).toBe(false)
    // The URL is not de-postfixed: nothing routes it as a page.
    expect(parsed.url.pathname).toBe("/page_.rsc")
  })
})
