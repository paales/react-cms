/**
 * The Interactive grant — vocabulary interactive members + grant-gated
 * tier admission (`lib/vocabulary.tsx`, `lib/tier-rewrite.ts`).
 *
 *  - emit side: `TextField` / `Button` serialize through the audit —
 *    cell id + explicit partition JSON + uncontrolled `defaultValue`,
 *    action name + payload; nothing unlisted crosses;
 *  - enforce side: the SAME payload splices intact under
 *    `grant="interactive"` and degrades in place under plain Paint
 *    (`offense: "element"` — an interactive tag is a non-member of the
 *    narrower grant's surface);
 *  - endpoints: the producer's capability-scoped write/invoke surface
 *    (`/__remote/cells/write`, `/__remote/actions/invoke`) — the
 *    writeGuard composition, the explicit action registry, guard
 *    denials.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ReactNode } from "react"
import { createTierRewriter } from "../tier-rewrite.ts"
import { Button, Stack, Text, TextField, TIER_VIOLATION_TAG, VOCABULARY } from "../vocabulary.tsx"
import { rewriteFlightStream } from "../flight-rewrite.ts"
import { createFromReadableStream } from "../flight-runtime.ts"
import {
  CAPABILITY_HEADER_NAME,
  REMOTE_ACTION_INVOKE_PATH,
  REMOTE_CELL_WRITE_PATH,
} from "../page-embed.ts"
import { localCell, type ResolvedCell } from "../cell.ts"
import { buildResolvedCell } from "../cell.ts"
import { createRemoteHandler } from "../../runtime/remote-endpoints.tsx"
import { _clearEmbedActions, embedAction } from "../../runtime/embed-actions.ts"
import { encodeCapability } from "../../runtime/capability.ts"
import { getCellStorage } from "../../runtime/cell-storage.ts"
import { runWithRequestAsync } from "../../runtime/context.ts"
import { renderServerToFlight, type FlightBytes } from "../../test/rsc-server.ts"

async function streamToText(stream: FlightBytes): Promise<string> {
  return new Response(stream).text()
}

/** Splice round trip under a grant set: rewrite → decode → re-encode
 *  (assertions on the re-encoded wire — what a host response carries). */
async function spliceRoundTrip(tree: ReactNode, grants: string[]): Promise<string> {
  const rewriter = createTierRewriter({
    grants: new Set(grants),
    url: "http://t/embedded",
    dev: true,
  })
  const rewritten = rewriteFlightStream(renderServerToFlight(tree), rewriter)
  const decoded = await createFromReadableStream<ReactNode>(rewritten)
  return streamToText(renderServerToFlight(decoded))
}

let consoleError: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
})
afterEach(() => {
  consoleError.mockRestore()
  vi.unstubAllGlobals()
  _clearEmbedActions()
  getCellStorage().clear("default")
})

/** A ResolvedCell view without a live render — what a producer's
 *  in-body resolve yields, shaped for the emit tests. */
function resolvedView<T>(
  id: string,
  value: T,
  partition?: Record<string, unknown>,
): ResolvedCell<T> {
  const cell = localCell({ id, shape: "opaque", initial: value })
  return buildResolvedCell(cell, value, partition)
}

// ─── Emit side ─────────────────────────────────────────────────────────

describe("interactive vocabulary — emit audit", () => {
  it("TextField serializes cell id, explicit partition JSON, and the uncontrolled default", async () => {
    const qty = resolvedView("iv.qty", "3", { lot: "a1" })
    const wire = await streamToText(
      renderServerToFlight(<TextField cell={qty} label="Qty" type="number" data-testid="f" />),
    )
    expect(wire).toContain('"cell-id":"iv.qty"')
    expect(wire).toContain('\\"lot\\":\\"a1\\"')
    expect(wire).toContain('"defaultValue":"3"')
    expect(wire).toContain('"type":"number"')
    expect(wire).toContain('"label":"Qty"')
  })

  it("Button serializes the bare action name + JSON payload — origin is NOT on the wire", async () => {
    const wire = await streamToText(
      renderServerToFlight(
        <Button action="place-bid" payload={{ step: 50 }} data-testid="b">
          <Text>Bid</Text>
        </Button>,
      ),
    )
    expect(wire).toContain('"action":"place-bid"')
    expect(wire).toContain('\\"step\\":50')
    // The namespace is structural: the bridge posts to the placement's
    // origin; no origin/URL rides the payload row.
    expect(wire).not.toContain("http://")
  })

  it("interactive members are marked in the audit table", () => {
    expect(VOCABULARY["parton-textfield"].grant).toBe("interactive")
    expect(VOCABULARY["input"].grant).toBe("interactive")
    expect(VOCABULARY["parton-button"].grant).toBe("interactive")
    expect(VOCABULARY["parton-text"].grant).toBeUndefined()
  })
})

// ─── Enforce side ──────────────────────────────────────────────────────

const panel = (): ReactNode => (
  <Stack gap="sm" data-testid="iv-panel">
    <Text data-testid="iv-plain">plain-line</Text>
    <TextField cell={resolvedView("iv.qty2", "2")} label="Qty" data-testid="iv-field" />
    <Button action="place-bid" data-testid="iv-button">
      <Text>Bid</Text>
    </Button>
  </Stack>
)

describe("tier admission by grant", () => {
  it("interactive tags splice intact under grant=interactive", async () => {
    const out = await spliceRoundTrip(panel(), ["interactive"])
    expect(out).toContain("parton-textfield")
    expect(out).toContain('"cell-id":"iv.qty2"')
    expect(out).toContain('"defaultValue":"2"')
    expect(out).toContain("parton-button")
    expect(out).toContain('"action":"place-bid"')
    expect(out).not.toContain(TIER_VIOLATION_TAG)
  })

  it("the SAME rows degrade in place under plain Paint while paint members survive", async () => {
    const out = await spliceRoundTrip(panel(), ["paint"])
    expect(out).toContain("plain-line")
    // No interactive ELEMENT survives (the tag names below appear only
    // inside the violation markers' data-type).
    expect(out).not.toContain('["$","parton-textfield"')
    expect(out).not.toContain('["$","parton-button"')
    expect(out).not.toContain('"cell-id"')
    expect(out).not.toContain('"action":"place-bid"')
    // DEV markers name the degraded elements.
    expect(out).toContain(TIER_VIOLATION_TAG)
    expect(out).toContain('"data-type":"parton-textfield"')
    expect(out).toContain('"data-type":"parton-button"')
  })

  it("unlisted attributes strip; bad values drop the attribute, never the element", async () => {
    const rewriter = createTierRewriter({
      grants: new Set(["interactive"]),
      url: "http://t/embedded",
      dev: true,
    })
    const row = rewriter({
      id: "1",
      type: "",
      data: JSON.stringify([
        "$",
        "parton-button",
        null,
        { action: "ok-name", onClick: "$F1", style: "color:red", payload: 42 },
      ]),
    })
    const data = JSON.parse((row as { data: string }).data) as unknown[]
    expect(data[1]).toBe("parton-button")
    expect(data[3]).toEqual({ action: "ok-name" })
  })
})

// ─── Producer endpoints ────────────────────────────────────────────────

const handler = createRemoteHandler({ name: "iv-test" })

async function post(
  path: string,
  body: unknown,
  capability?: Record<string, string | number | boolean | null>,
) {
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (capability) headers[CAPABILITY_HEADER_NAME] = encodeCapability(capability)
  return (await handler(
    new Request(`http://remote.t${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  ))!
}

describe("producer endpoints — cells/write", () => {
  it("writes through the ordinary pipeline (validation + canonicalisation)", async () => {
    const cell = localCell({
      id: "iv.note",
      shape: "string",
      initial: "",
      write: (raw) => raw.toUpperCase(),
    })
    const res = await post(REMOTE_CELL_WRITE_PATH, { cell: "iv.note", value: "hi" })
    expect(res.status).toBe(204)
    const { result } = await runWithRequestAsync(new Request("http://remote.t/"), async () =>
      cell.peek({}),
    )
    expect(result).toBe("HI")
  })

  it("composes with writeGuard reading the presented capability", async () => {
    const { getCapability } = await import("../../runtime/capability.ts")
    localCell({
      id: "iv.guarded",
      shape: "string",
      initial: "init",
      writeGuard: () => getCapability().writer === true,
    })
    const denied = await post(REMOTE_CELL_WRITE_PATH, { cell: "iv.guarded", value: "x" })
    expect(denied.status).toBe(403)
    const allowed = await post(
      REMOTE_CELL_WRITE_PATH,
      { cell: "iv.guarded", value: "x" },
      { writer: true },
    )
    expect(allowed.status).toBe(204)
  })

  it("404s an unknown cell; 400s a shape violation", async () => {
    localCell({ id: "iv.num", shape: "number", initial: 0 })
    expect((await post(REMOTE_CELL_WRITE_PATH, { cell: "iv.none", value: 1 })).status).toBe(404)
    expect((await post(REMOTE_CELL_WRITE_PATH, { cell: "iv.num", value: "nope" })).status).toBe(400)
  })
})

describe("producer endpoints — actions/invoke", () => {
  it("invokes a registered action with the untrusted payload; unknown names 404", async () => {
    const seen: unknown[] = []
    embedAction("iv-bid", (payload) => {
      seen.push(payload)
    })
    const res = await post(REMOTE_ACTION_INVOKE_PATH, { action: "iv-bid", payload: { n: 1 } })
    expect(res.status).toBe(204)
    expect(seen).toEqual([{ n: 1 }])
    expect((await post(REMOTE_ACTION_INVOKE_PATH, { action: "iv-nope" })).status).toBe(404)
  })

  it("a guard denies with 403 before the handler runs", async () => {
    let ran = 0
    embedAction(
      "iv-guarded",
      () => {
        ran++
      },
      { guard: (cap) => cap.bidder === true },
    )
    expect((await post(REMOTE_ACTION_INVOKE_PATH, { action: "iv-guarded" })).status).toBe(403)
    expect(ran).toBe(0)
    expect(
      (await post(REMOTE_ACTION_INVOKE_PATH, { action: "iv-guarded" }, { bidder: true })).status,
    ).toBe(204)
    expect(ran).toBe(1)
  })
})
