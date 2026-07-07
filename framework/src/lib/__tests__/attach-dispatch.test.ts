/**
 * Attach dispatch — the explicit request markers, never the body.
 *
 * An `_.rsc` POST is one of exactly two kinds, each named by its own
 * header: `x-parton-attach` (the heartbeat's attach — held segmented
 * drive) or `x-rsc-action` (an action — one commit-only segment).
 * `parseRenderRequest`'s verdict is what the entry's wrap/drive
 * decision keys on, so the claims pin the verdicts: an action whose
 * body happens to be statement-shaped stays an action (no drive), an
 * attach never decodes as an action, and a POST claiming both is
 * ill-formed. Alongside: the statement decoder's grammar (unknown
 * fields ignored — the ack watermark seeds there next; malformed
 * KNOWN fields are protocol violations).
 */

import { describe, expect, it } from "vitest"
import {
  ATTACH_HEADER,
  type AttachStatement,
  decodeAttachStatement,
} from "../channel-protocol.ts"
import {
  createRscRenderRequest,
  parseRenderRequest,
} from "../../runtime/request.tsx"

const statement: AttachStatement = {
  cached: ["a:mk:f1", "b:mk:f2"],
  since: { epoch: "e1", ts: 42 },
  visible: ["a"],
  applied: 7,
}

describe("decodeAttachStatement", () => {
  it("decodes the full statement", () => {
    expect(decodeAttachStatement(JSON.parse(JSON.stringify(statement)))).toEqual(
      statement,
    )
  })

  it("normalizes absent since/visible to null and absent applied to 0", () => {
    expect(decodeAttachStatement({ cached: [] })).toEqual({
      cached: [],
      since: null,
      visible: null,
      applied: 0,
    })
  })

  it("keeps the empty-array/null distinction on visible", () => {
    // [] is a measurement ("nothing in view"); null is no statement.
    expect(decodeAttachStatement({ cached: [], visible: [] })?.visible).toEqual([])
    expect(decodeAttachStatement({ cached: [], visible: null })?.visible).toBeNull()
  })

  it("ignores unknown fields — the statement grows by adding them", () => {
    expect(
      decodeAttachStatement({ cached: [], ack: 7, telemetry: { w: 1 } }),
    ).toEqual({ cached: [], since: null, visible: null, applied: 0 })
  })

  it("rejects malformed known fields", () => {
    expect(decodeAttachStatement(null)).toBeNull()
    expect(decodeAttachStatement("nope")).toBeNull()
    expect(decodeAttachStatement({})).toBeNull()
    expect(decodeAttachStatement({ cached: "a,b" })).toBeNull()
    expect(decodeAttachStatement({ cached: [1] })).toBeNull()
    expect(decodeAttachStatement({ cached: [], since: "e1:42" })).toBeNull()
    expect(decodeAttachStatement({ cached: [], since: { epoch: "", ts: 1 } })).toBeNull()
    expect(
      decodeAttachStatement({ cached: [], since: { epoch: "e", ts: Number.NaN } }),
    ).toBeNull()
    expect(
      decodeAttachStatement({ cached: [], since: { epoch: "e", ts: -1 } }),
    ).toBeNull()
    expect(decodeAttachStatement({ cached: [], visible: "a,b" })).toBeNull()
    // `applied` is a KNOWN field — malformed values are protocol
    // violations, not extensibility.
    expect(decodeAttachStatement({ cached: [], applied: "3" })).toBeNull()
    expect(decodeAttachStatement({ cached: [], applied: -1 })).toBeNull()
    expect(
      decodeAttachStatement({ cached: [], applied: Number.NaN }),
    ).toBeNull()
  })
})

describe("parseRenderRequest — attach vs action dispatch", () => {
  it("an attach POST parses as attach, never action, and its body round-trips", async () => {
    const request = createRscRenderRequest(
      "http://localhost/page?live=1&streaming=1",
      undefined,
      statement,
    )
    expect(request.method).toBe("POST")
    expect(request.headers.get(ATTACH_HEADER)).toBe("1")
    const parsed = parseRenderRequest(request)
    expect(parsed.isRsc).toBe(true)
    expect(parsed.isAttach).toBe(true)
    expect(parsed.isAction).toBe(false)
    expect(parsed.actionId).toBeUndefined()
    // The reconstructed request keeps the body — the entry decodes the
    // statement off it.
    expect(decodeAttachStatement(await parsed.request.json())).toEqual(statement)
  })

  it("an action POST with a statement-shaped body stays an action", () => {
    const request = createRscRenderRequest("http://localhost/page", {
      id: "act-1",
      body: JSON.stringify(statement),
    })
    const parsed = parseRenderRequest(request)
    expect(parsed.isAction).toBe(true)
    expect(parsed.isAttach).toBe(false)
    expect(parsed.actionId).toBe("act-1")
  })

  it("a POST claiming both markers is ill-formed", () => {
    const request = new Request("http://localhost/page_.rsc", {
      method: "POST",
      headers: { [ATTACH_HEADER]: "1", "x-rsc-action": "act-1" },
      body: "{}",
    })
    expect(() => parseRenderRequest(request)).toThrow(
      /both an attach marker and an action id/,
    )
  })

  it("a marker-less _.rsc POST is still rejected", () => {
    const request = new Request("http://localhost/page_.rsc", {
      method: "POST",
      body: "{}",
    })
    expect(() => parseRenderRequest(request)).toThrow(/Missing action id/)
  })

  it("a GET is never an attach", () => {
    const parsed = parseRenderRequest(
      createRscRenderRequest("http://localhost/page?live=1"),
    )
    expect(parsed.isAttach).toBe(false)
    expect(parsed.isAction).toBe(false)
  })
})
