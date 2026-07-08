/**
 * The channel endpoint — `POST /__parton/channel` envelope handling.
 *
 * The upstream half of the channel: one coalesced envelope of frames,
 * addressed to an open live connection. The claims under test:
 *
 *   1. HTTP mapping — applied envelopes answer `204` (no body);
 *      malformed envelopes AND malformed known-kind frames answer
 *      `400`; unknown connections answer `404`.
 *   2. Cross-site rejection — an `Origin` not matching the request's
 *      own, or a `Sec-Fetch-Site` testifying cross-site, answers
 *      `403` before any session is touched. Same-origin provenance
 *      and header-less requests (non-browser clients — the cookie
 *      binding is the credential check) pass.
 *   3. Attach binding — an envelope must resolve the SAME scope and
 *      present the SAME session identity the attach carried; either
 *      mismatch answers `404`, byte-identical to "connection gone",
 *      so a hostile beacon can't distinguish wrong-creds from gone.
 *      The anonymous page binds the empty identity and keeps working.
 *   4. Unknown frame kinds are SKIPPED, not errors — the grammar
 *      grows by adding kinds (url / ack / telemetry), and an old
 *      server must stay indifferent to a newer client's frames.
 *   5. Frames apply in envelope order — a later `visible` frame in
 *      the SAME envelope stands (its snapshot replaces the set).
 *   6. `detach` ends the held stream — the parked driver wakes, the
 *      drive loop exits, and the session closes NOW instead of
 *      holding a goner for the keepalive window. Best-effort by
 *      nature; the keepalive timeout remains the backstop.
 */

import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { _clearInvalidationRegistry } from "../../runtime/invalidation-registry.ts"
import { runWithRequestAsync } from "../../runtime/context.ts"
import { drainPayloadSegment, freshLiveScope, withLiveDrive } from "../../test/live-drive.tsx"
import {
  CHANNEL_ENDPOINT,
  type ChannelEnvelope,
  decodeChannelEnvelope,
} from "../channel-protocol.ts"
import {
  _closeConnectionSession,
  _openConnectionSession,
  handleChannelPost,
} from "../connection-session.ts"
import { PartialRoot, parton, type RenderArgs } from "../partial.tsx"
import { clearRegistry } from "../partial-registry.ts"
import { SkelBox } from "./cull-skeleton-fixture.tsx"

const Cullable = parton(
  function CullableRender(_: RenderArgs) {
    return <div data-x>x:full</div>
  },
  { selector: "chan-x", cull: { skeleton: SkelBox } },
)

function Page(): ReactNode {
  return (
    <PartialRoot>
      <Cullable />
    </PartialRoot>
  )
}

beforeEach(() => {
  _clearInvalidationRegistry()
})

afterEach(() => {
  clearRegistry("all")
  _clearInvalidationRegistry()
})

/** POST a raw body through the endpoint the way the entry does —
 *  inside a request scope. */
async function post(body: string, headers: Record<string, string> = {}): Promise<Response> {
  const request = new Request(`http://localhost${CHANNEL_ENDPOINT}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  })
  const { result } = await runWithRequestAsync(request, () => handleChannelPost(request))
  return result
}

function envelope(connection: string, seq: number, frames: unknown[]): string {
  return JSON.stringify({ connection, seq, frames })
}

describe("channel envelope decode", () => {
  it("accepts the envelope grammar and drops unknown kinds", () => {
    const decoded = decodeChannelEnvelope({
      connection: "c1",
      seq: 3,
      frames: [
        { kind: "future-kind", payload: [4, 5] },
        { kind: "visible", changed: ["a"], visible: ["a"], cached: ["a:_:f"] },
        { kind: "detach" },
      ],
    })
    expect(decoded).not.toBeNull()
    expect(decoded?.frames).toEqual([
      { kind: "visible", changed: ["a"], visible: ["a"], cached: ["a:_:f"] },
      { kind: "detach" },
    ])
  })

  it("rejects malformed envelopes and malformed KNOWN-kind frames", () => {
    expect(decodeChannelEnvelope(null)).toBeNull()
    expect(decodeChannelEnvelope({})).toBeNull()
    expect(decodeChannelEnvelope({ connection: "", seq: 1, frames: [] })).toBeNull()
    expect(decodeChannelEnvelope({ connection: "c", seq: Number.NaN, frames: [] })).toBeNull()
    expect(decodeChannelEnvelope({ connection: "c", seq: 1, frames: [{}] })).toBeNull()
    // A known kind whose shape doesn't validate is a protocol
    // violation, not extensibility.
    expect(
      decodeChannelEnvelope({
        connection: "c",
        seq: 1,
        frames: [{ kind: "visible", changed: "nope", visible: [] }],
      }),
    ).toBeNull()
    expect(
      decodeChannelEnvelope({
        connection: "c",
        seq: 1,
        frames: [{ kind: "visible", changed: [], visible: [], cached: [1] }],
      }),
    ).toBeNull()
  })

  it("decodes a cookie frame (set + delete) and rejects a malformed one", () => {
    // A string `value` is a set; an explicit `null` is a delete.
    expect(
      decodeChannelEnvelope({
        connection: "c",
        seq: 1,
        frames: [
          { kind: "cookie", name: "theme", value: "dark" },
          { kind: "cookie", name: "cart_id", value: null },
        ],
      })?.frames,
    ).toEqual([
      { kind: "cookie", name: "theme", value: "dark" },
      { kind: "cookie", name: "cart_id", value: null },
    ])
    // A missing name, an empty name, or a non-string/non-null value is
    // a protocol violation like any known-kind field's.
    expect(
      decodeChannelEnvelope({
        connection: "c",
        seq: 1,
        frames: [{ kind: "cookie", value: "dark" }],
      }),
    ).toBeNull()
    expect(
      decodeChannelEnvelope({
        connection: "c",
        seq: 1,
        frames: [{ kind: "cookie", name: "", value: "dark" }],
      }),
    ).toBeNull()
    expect(
      decodeChannelEnvelope({
        connection: "c",
        seq: 1,
        frames: [{ kind: "cookie", name: "theme", value: 3 }],
      }),
    ).toBeNull()
    // An absent `value` (undefined) is malformed — a delete states
    // `null` explicitly.
    expect(
      decodeChannelEnvelope({
        connection: "c",
        seq: 1,
        frames: [{ kind: "cookie", name: "theme" }],
      }),
    ).toBeNull()
  })

  it("decodes an ack's optional `dropped` set and rejects a malformed one", () => {
    // Absent `dropped` decodes to a bare ack.
    expect(
      decodeChannelEnvelope({
        connection: "c",
        seq: 1,
        frames: [{ kind: "ack", delivered: 4 }],
      })?.frames,
    ).toEqual([{ kind: "ack", delivered: 4 }])
    // A present, well-formed `dropped` rides through.
    expect(
      decodeChannelEnvelope({
        connection: "c",
        seq: 1,
        frames: [{ kind: "ack", delivered: 4, dropped: [1, 3] }],
      })?.frames,
    ).toEqual([{ kind: "ack", delivered: 4, dropped: [1, 3] }])
    // An empty `dropped` normalizes away (nothing to state).
    expect(
      decodeChannelEnvelope({
        connection: "c",
        seq: 1,
        frames: [{ kind: "ack", delivered: 4, dropped: [] }],
      })?.frames,
    ).toEqual([{ kind: "ack", delivered: 4 }])
    // A malformed `dropped` (non-array, or a non-number member) is a
    // protocol violation like any known-kind field's.
    expect(
      decodeChannelEnvelope({
        connection: "c",
        seq: 1,
        frames: [{ kind: "ack", delivered: 4, dropped: "1,3" }],
      }),
    ).toBeNull()
    expect(
      decodeChannelEnvelope({
        connection: "c",
        seq: 1,
        frames: [{ kind: "ack", delivered: 4, dropped: [1, -2] }],
      }),
    ).toBeNull()
  })
})

describe("channel endpoint", () => {
  it("maps apply / unknown-connection / malformed to 204 / 404 / 400", async () => {
    _openConnectionSession("chan-http", null)
    try {
      const ok = await post(
        envelope("chan-http", 1, [{ kind: "visible", changed: ["a"], visible: ["a"], cached: [] }]),
      )
      expect(ok.status).toBe(204)
      expect(ok.body).toBeNull()

      expect((await post(envelope("chan-gone", 1, []))).status).toBe(404)
      expect((await post("not json")).status).toBe(400)
      expect((await post(JSON.stringify({ connection: "" }))).status).toBe(400)
      expect(
        (await post(envelope("chan-http", 2, [{ kind: "visible", changed: "nope", visible: [] }])))
          .status,
      ).toBe(400)
    } finally {
      _closeConnectionSession("chan-http")
    }
  })

  it("rejects cross-site provenance with 403; same-origin and header-less pass", async () => {
    const session = _openConnectionSession("chan-origin", null)
    try {
      const body = envelope("chan-origin", 1, [{ kind: "visible", changed: ["a"], visible: ["a"] }])
      expect((await post(body, { origin: "http://evil.example" })).status).toBe(403)
      expect((await post(body, { "sec-fetch-site": "cross-site" })).status).toBe(403)
      expect((await post(body, { "sec-fetch-site": "same-site" })).status).toBe(403)
      // A 403 never touched the session.
      expect(session.pendingFlips.size).toBe(0)
      expect(
        (
          await post(body, {
            origin: "http://localhost",
            "sec-fetch-site": "same-origin",
          })
        ).status,
      ).toBe(204)
      expect(session.pendingFlips.size).toBe(1)
    } finally {
      _closeConnectionSession("chan-origin")
    }
  })

  it("an envelope resolving a different scope than the attach answers 404", async () => {
    const session = _openConnectionSession("chan-scope", null, {
      scope: "worker-attach",
    })
    try {
      const body = envelope("chan-scope", 1, [{ kind: "visible", changed: ["a"], visible: ["a"] }])
      expect((await post(body, { "x-test-scope": "worker-other" })).status).toBe(404)
      expect(session.pendingFlips.size).toBe(0)
      expect((await post(body, { "x-test-scope": "worker-attach" })).status).toBe(204)
      expect(session.pendingFlips.size).toBe(1)
    } finally {
      _closeConnectionSession("chan-scope")
    }
  })

  it("an envelope presenting a different session identity than the attach answers 404", async () => {
    const bound = _openConnectionSession("chan-cookie", null, {
      sessionId: "sid-attach",
    })
    const anon = _openConnectionSession("chan-cookie-anon", null)
    try {
      const boundBody = envelope("chan-cookie", 1, [
        { kind: "visible", changed: ["a"], visible: ["a"] },
      ])
      // No cookie where the attach had one → gone-equivalent.
      expect((await post(boundBody)).status).toBe(404)
      // The wrong cookie → gone-equivalent.
      expect((await post(boundBody, { cookie: "__frame_sid=sid-other" })).status).toBe(404)
      expect(bound.pendingFlips.size).toBe(0)
      // The attach's own identity applies.
      expect((await post(boundBody, { cookie: "__frame_sid=sid-attach" })).status).toBe(204)
      expect(bound.pendingFlips.size).toBe(1)

      // The anonymous page binds the empty identity: cookieless
      // envelopes keep working, and a later-minted session cookie
      // fails the bind until the next attach rebinds.
      const anonBody = envelope("chan-cookie-anon", 1, [
        { kind: "visible", changed: ["a"], visible: ["a"] },
      ])
      expect((await post(anonBody)).status).toBe(204)
      expect((await post(anonBody, { cookie: "__frame_sid=sid-late" })).status).toBe(404)
    } finally {
      _closeConnectionSession("chan-cookie")
      _closeConnectionSession("chan-cookie-anon")
    }
  })

  it("skips unknown frame kinds and still applies the known ones", async () => {
    const session = _openConnectionSession("chan-unknown", null)
    try {
      const res = await post(
        envelope("chan-unknown", 1, [
          { kind: "future-kind", payload: [800, 600] },
          { kind: "visible", changed: ["a"], visible: ["a"] },
        ]),
      )
      expect(res.status).toBe(204)
      expect(session.pendingFlips.get("a")).toMatchObject({
        inView: true,
        seq: 1,
      })
      expect(session.visible).toEqual(new Set(["a"]))
    } finally {
      _closeConnectionSession("chan-unknown")
    }
  })

  it("frames apply in envelope order — the later visible frame's snapshot stands", async () => {
    const session = _openConnectionSession("chan-order", null)
    try {
      const res = await post(
        envelope("chan-order", 1, [
          { kind: "visible", changed: ["a"], visible: ["a", "b"] },
          { kind: "visible", changed: ["b"], visible: ["a"] },
        ]),
      )
      expect(res.status).toBe(204)
      // Same-seq statements: the later frame's testimony about b (out)
      // replaces the earlier snapshot's, and its set stands.
      expect(session.visible).toEqual(new Set(["a"]))
      expect(session.pendingFlips.get("b")).toMatchObject({
        inView: false,
        seq: 1,
      })
    } finally {
      _closeConnectionSession("chan-order")
    }
  })

  it("the stream ships a SERVER-minted id; a client-chosen ?__conn= never keys a session", async () => {
    let conn = ""
    const scope = freshLiveScope("chan-mint")
    await withLiveDrive(
      // A hostile (or stale) client-chosen id on the URL is inert: the
      // driver mints its own and ships it as the stream's `conn` entry.
      `http://localhost/mint?live=1&__conn=chosen-by-client&visible=chan-x`,
      Page,
      scope,
      async (h) => {
        const first = await h.segments.next()
        if (first.done || first.value.kind !== "payload")
          throw new Error("expected payload segment 0")
        const seg0 = await drainPayloadSegment(first.value)
        expect(seg0).toContain("x:full")
        conn = h.connectionId() ?? ""
        expect(conn).not.toBe("")
        expect(conn).not.toBe("chosen-by-client")

        // The chosen token addresses nothing…
        expect(
          (
            await post(
              envelope("chosen-by-client", 1, [
                { kind: "visible", changed: [], visible: ["chan-x"] },
              ]),
              { "x-test-scope": scope },
            )
          ).status,
        ).toBe(404)
        // …the minted one addresses the open session.
        expect(
          (
            await post(envelope(conn, 1, [{ kind: "visible", changed: [], visible: ["chan-x"] }]), {
              "x-test-scope": scope,
            })
          ).status,
        ).toBe(204)

        await h.shutdown("chan-x")
      },
    )
  })

  it("a detach frame ends the held stream instead of waiting out the keepalive", async () => {
    let conn = ""
    const scope = freshLiveScope("chan-detach")
    await withLiveDrive(`http://localhost/detach?live=1&visible=chan-x`, Page, scope, async (h) => {
      const first = await h.segments.next()
      if (first.done || first.value.kind !== "payload")
        throw new Error("expected payload segment 0")
      expect(await drainPayloadSegment(first.value)).toContain("x:full")
      conn = h.connectionId() ?? ""
      expect(conn).not.toBe("")

      expect(
        (
          await post(envelope(conn, 1, [{ kind: "detach" }]), {
            "x-test-scope": scope,
          })
        ).status,
      ).toBe(204)

      // The driver had already opened the lanes region; the detach
      // wake exits the drive loop, the stream closes, and the lane
      // iterator completes without a single lane.
      const second = await h.segments.next()
      if (second.done || second.value.kind !== "lanes") throw new Error("expected lanes segment")
      const laneIter = second.value.lanes[Symbol.asyncIterator]()
      expect((await laneIter.next()).done).toBe(true)
      expect((await h.segments.next()).done).toBe(true)

      await h.shutdown("chan-x")
    })
    // The drive loop's exit closed the session — a late envelope
    // answers the connection-gone 404.
    expect(
      (
        await post(envelope(conn, 2, [{ kind: "detach" }]), {
          "x-test-scope": scope,
        })
      ).status,
    ).toBe(404)
  })
})
