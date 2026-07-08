/**
 * Nested frame CREATED by an outer-frame nav, then toggled A->B->A — the
 * mirror's warm-heal slotting. Mirrors the real /frames-demo menu: the tab
 * frame is absent from the initial segment; an outer `menu` frame nav
 * (closed -> about) first places `menu-tab`, whose FIRST render is cold
 * (dep-less fp), so its lane flush emits a warm heal (cold fp -> dep-ful
 * fp). If that heal folds into the connection mirror BEFORE the drain
 * promote establishes the slot, the dep-ful fp lands slotless — a later
 * `/advanced` render evicts only the cold fp, stranding the dep-ful
 * `/general` fp. The return to `/general` then fp-skips against that
 * phantom and the client (which overwrote general with advanced in its
 * one-content-per-slot cache) shows stale `advanced` forever. The fix
 * folds the heal AFTER the promote, so `to` joins its slot and evicts as
 * a unit — sibling of `frame-toggle-slot`, whose nested parton instead
 * exists from render 1 (promoted by the initial whole-tree segment).
 */
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { runWithRequestAsync } from "../../runtime/context.ts"
import { _clearInvalidationRegistry } from "../../runtime/invalidation-registry.ts"
import { _clearAllSessions } from "../../runtime/session.ts"
import {
  decodeLane,
  drainPayloadSegment,
  freshLiveScope,
  withLiveDrive,
} from "../../test/live-drive.tsx"
import { CHANNEL_ENDPOINT, type ChannelEnvelope } from "../channel-protocol.ts"
import { handleChannelPost } from "../connection-session.ts"
import { Frame } from "../frame.tsx"
import { PartialRoot, parton, type RenderArgs } from "../partial.tsx"
import { clearRegistry } from "../partial-registry.ts"
import { pathname } from "../server-hooks.ts"

const MenuTab = parton(
  function MenuTabRender(_: RenderArgs) {
    return <div data-tab>{`tab:${pathname()}`}</div>
  },
  { selector: "menu-tab" },
)
// The outer menu frame: `closed` has no nested frame; `about` places it.
const MenuFrame = parton(
  function MenuFrameRender(_: RenderArgs) {
    const state = pathname()
    if (state === "/menu/about") {
      return (
        <div data-about>
          <Frame name="tab" initialUrl="/general">
            <MenuTab />
          </Frame>
        </div>
      )
    }
    return <div data-closed>{`menu:${state}`}</div>
  },
  { selector: "menu" },
)
const Page = (): ReactNode => (
  <PartialRoot>
    <Frame name="menu" initialUrl="/menu/closed">
      <MenuFrame />
    </Frame>
  </PartialRoot>
)

beforeEach(() => _clearInvalidationRegistry())
afterEach(() => {
  clearRegistry("all")
  _clearAllSessions()
  _clearInvalidationRegistry()
})

async function post(scope: string, envelope: ChannelEnvelope, sid: string): Promise<number> {
  const request = new Request(`http://localhost${CHANNEL_ENDPOINT}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-test-scope": scope,
      cookie: `__frame_sid=${sid}`,
    },
    body: JSON.stringify(envelope),
  })
  const { result } = await runWithRequestAsync(request, () => handleChannelPost(request))
  return result.status
}

describe("nested frame created by outer nav, then toggled", () => {
  it("A->B->A on the tab lanes fresh each time", async () => {
    const scope = freshLiveScope("frame-nested-create")
    const sid = "sid-nested-create"
    await withLiveDrive(
      "http://localhost/frames",
      Page,
      scope,
      async (h) => {
        const first = await h.segments.next()
        if (first.done || first.value.kind !== "payload") throw new Error("seg0")
        await drainPayloadSegment(first.value)
        const conn = h.connectionId() ?? ""
        const lanesSeg = await h.segments.next()
        if (lanesSeg.done || lanesSeg.value.kind !== "lanes") throw new Error("lanes")
        const iter = lanesSeg.value.lanes[Symbol.asyncIterator]()

        const fireFrame = async (seq: number, frame: string[], url: string) =>
          post(
            scope,
            {
              connection: conn,
              seq,
              frames: [{ kind: "url", url, intent: "silent", frame }],
            },
            sid,
          )

        // Open the menu (closed -> about): this places the nested tab.
        expect(await fireFrame(1, ["menu"], "/menu/about")).toBe(204)
        const o1 = await iter.next()
        if (o1.done) throw new Error("no lane open")
        expect((await decodeLane(o1.value)).bodyText).toContain("tab:/general")

        // Tab -> /advanced.
        expect(await fireFrame(2, ["menu", "tab"], "/advanced")).toBe(204)
        const l1 = await iter.next()
        if (l1.done) throw new Error("no lane 1")
        expect((await decodeLane(l1.value)).bodyText).toContain("tab:/advanced")

        // Tab -> /general (the RETURN). Must be fresh general, not a
        // placeholder fp-skipped against a phantom mirror slot.
        expect(await fireFrame(3, ["menu", "tab"], "/general")).toBe(204)
        const l2 = await iter.next()
        if (l2.done) throw new Error("no lane 2")
        const body2 = (await decodeLane(l2.value)).bodyText
        expect(body2).toContain("tab:/general")
        expect(body2).not.toMatch(/"data-partial-id":"menu-tab"[^{]*hidden/)

        await h.shutdown("menu")
      },
      { headers: { cookie: `__frame_sid=${sid}` } },
    )
  }, 15000)
})
