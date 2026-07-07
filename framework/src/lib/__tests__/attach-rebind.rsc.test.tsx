/**
 * The attach is the credential rebind point.
 *
 * A connection session binds the attach request's session identity
 * (`getSessionId() ?? ""`), and every channel envelope must present
 * the same one — a mismatch answers `404`, byte-identical to
 * "connection gone". A session cookie minted MID-connection (an
 * action's `ensureSessionId`) therefore fails the check for the rest
 * of that connection; the flow under test is the recovery: the next
 * attach carries the new cookie, `openLiveConnectionSession` records
 * the identity fresh, and beacons work again.
 */

import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { runWithRequestAsync } from "../../runtime/context.ts"
import { _clearInvalidationRegistry } from "../../runtime/invalidation-registry.ts"
import {
  drainPayloadSegment,
  freshLiveScope,
  withLiveDrive,
} from "../../test/live-drive.tsx"
import { CHANNEL_ENDPOINT } from "../channel-protocol.ts"
import { handleChannelPost } from "../connection-session.ts"
import { PartialRoot, parton, type RenderArgs } from "../partial.tsx"
import { clearRegistry } from "../partial-registry.ts"

const Rebind = parton(
  function RebindRender(_: RenderArgs) {
    return <div data-rebind>content</div>
  },
  { selector: "rebind-a" },
)

function Page(): ReactNode {
  return (
    <PartialRoot>
      <Rebind />
    </PartialRoot>
  )
}

beforeEach(() => _clearInvalidationRegistry())
afterEach(() => {
  clearRegistry("all")
  _clearInvalidationRegistry()
})

/** POST an (empty-frames) envelope the way the entry does — inside a
 *  request scope carrying the given cookie. An applied envelope is the
 *  "beacons work" probe; the frames don't matter for the binding. */
async function postEnvelope(
  connection: string,
  seq: number,
  scope: string,
  cookie?: string,
): Promise<number> {
  const request = new Request(`http://localhost${CHANNEL_ENDPOINT}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-test-scope": scope,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify({ connection, seq, frames: [] }),
  })
  const { result } = await runWithRequestAsync(request, () =>
    handleChannelPost(request),
  )
  return result.status
}

describe("attach — session-identity rebind", () => {
  it("a cookie minted mid-connection 404s until the next attach presents it", async () => {
    const scope = freshLiveScope("rebind")
    const anonymousAttach = { cached: [], since: null, visible: null }

    // Connection 1 attaches anonymously — it binds the empty identity.
    await withLiveDrive(
      "http://localhost/rebind?live=1",
      Page,
      scope,
      async (h) => {
        const first = await h.segments.next()
        if (first.done || first.value.kind !== "payload")
          throw new Error("expected payload segment 0")
        await drainPayloadSegment(first.value)
        const conn = h.connectionId()
        if (conn === null) throw new Error("expected the conn handshake")

        // Cookieless beacons match the anonymous binding.
        expect(await postEnvelope(conn, 1, scope)).toBe(204)
        // The mid-connection-minted session cookie fails the binding —
        // the W1 gap this flow recovers from. 404, indistinguishable
        // from "connection gone", is the transport's fallback signal.
        expect(await postEnvelope(conn, 2, scope, "__frame_sid=sid-fresh")).toBe(404)

        await h.shutdown("rebind-a")
      },
      { attach: anonymousAttach },
    )

    // The REATTACH carries the new cookie; the session binds the new
    // identity fresh and beacons work again.
    await withLiveDrive(
      "http://localhost/rebind?live=1",
      Page,
      scope,
      async (h) => {
        const first = await h.segments.next()
        if (first.done || first.value.kind !== "payload")
          throw new Error("expected payload segment 0")
        await drainPayloadSegment(first.value)
        const conn = h.connectionId()
        if (conn === null) throw new Error("expected the conn handshake")

        expect(await postEnvelope(conn, 1, scope, "__frame_sid=sid-fresh")).toBe(204)
        // The prior identity (anonymous) no longer matches — the bind
        // is the attach's, not a union of past attaches.
        expect(await postEnvelope(conn, 2, scope)).toBe(404)

        await h.shutdown("rebind-a")
      },
      { attach: anonymousAttach, headers: { cookie: "__frame_sid=sid-fresh" } },
    )
  })
})
