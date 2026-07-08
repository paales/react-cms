/**
 * Session-partition isolation — a PERSISTENT cell partitioned on
 * `partition: ({session}) => ({sid: session.id})` must NOT route distinct
 * anonymous (no-cookie) visitors to a single shared partition.
 *
 * `session.id` is the empty string for any request that arrives with no
 * `__frame_sid` cookie and triggers no cookie-creating write. If the
 * partition key folds that empty `sid` into the persistent slot, every
 * anonymous visitor reads and writes the SAME disk-backed partition —
 * a cross-user state leak. The guard routes an unresolved-session
 * partition to per-request ephemeral storage instead.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  buildEphemeralCell,
  cellStorageForArgs,
  localCell,
  _resetUnresolvedPersistentWarnings,
} from "../cell.ts"
import { __cellWrite } from "../../runtime/cell-actions.ts"
import { MemoryCellStorage, setCellStorage, _resetCellStorage } from "../../runtime/cell-storage.ts"
import { _clearInvalidationRegistry } from "../../runtime/invalidation-registry.ts"
import { _clearAllSessions } from "../../runtime/session.ts"
import { runWithRequestAsync } from "../../runtime/context.ts"

/** Run `fn` inside an anonymous (no-cookie) request scope. */
async function anonRequest<T>(fn: () => Promise<T>): Promise<T> {
  const { result } = await runWithRequestAsync(new Request("http://t/"), fn)
  return result
}

beforeEach(() => {
  setCellStorage(new MemoryCellStorage())
  _clearInvalidationRegistry()
  _clearAllSessions()
  _resetUnresolvedPersistentWarnings()
})

afterEach(() => {
  _resetCellStorage()
  _clearInvalidationRegistry()
  _clearAllSessions()
  _resetUnresolvedPersistentWarnings()
})

describe("persistent cell partitioned on session.id — anonymous isolation", () => {
  it("two distinct anonymous requests do NOT share the persistent partition", async () => {
    const notes = localCell({
      id: "test.session.notes",
      shape: "string",
      partition: ({ session }) => ({ sid: session.id }),
      initial: "",
    })

    // Anonymous request 1 (no cookie): write a private value.
    await anonRequest(async () => {
      await __cellWrite("test.session.notes", "user-1-secret")
    })

    // Anonymous request 2 (distinct visitor, also no cookie): read.
    const seen = await anonRequest(() => Promise.resolve(notes.peek()))

    // The second anonymous visitor must NOT see the first's write.
    expect(seen).toBe("")
  })

  it("within a single anonymous request, a write IS visible to a later read", async () => {
    const notes = localCell({
      id: "test.session.same-request",
      shape: "string",
      partition: ({ session }) => ({ sid: session.id }),
      initial: "",
    })

    // The guard routes the unresolved partition to per-request ephemeral
    // storage — request-scoped, but consistent WITHIN the request. A
    // write and a read in the same anonymous request still cohere.
    const seen = await anonRequest(async () => {
      await __cellWrite("test.session.same-request", "draft-in-flight")
      return notes.peek()
    })
    expect(seen).toBe("draft-in-flight")
  })

  it("a resolved session.id still routes to persistent, per-user storage", async () => {
    const notes = localCell({
      id: "test.session.resolved",
      shape: "string",
      partition: ({ session }) => ({ sid: session.id }),
      initial: "",
    })

    // Two requests carrying the SAME session cookie are the same user —
    // they must share the persistent partition (the whole point of a
    // per-session cell).
    const cookie = { cookie: "__frame_sid=user-abc" }
    await runWithRequestAsync(new Request("http://t/", { headers: cookie }), async () => {
      await __cellWrite("test.session.resolved", "kept")
    })
    const { result: seen } = await runWithRequestAsync(
      new Request("http://t/", { headers: cookie }),
      () => Promise.resolve(notes.peek()),
    )
    expect(seen).toBe("kept")
  })

  it("two DIFFERENT resolved sessions get DIFFERENT persistent partitions", async () => {
    const notes = localCell({
      id: "test.session.per-user",
      shape: "string",
      partition: ({ session }) => ({ sid: session.id }),
      initial: "",
    })

    // User A writes under their own cookie.
    await runWithRequestAsync(
      new Request("http://t/", { headers: { cookie: "__frame_sid=user-a" } }),
      async () => {
        await __cellWrite("test.session.per-user", "a-private")
      },
    )
    // User B writes under a DIFFERENT cookie.
    await runWithRequestAsync(
      new Request("http://t/", { headers: { cookie: "__frame_sid=user-b" } }),
      async () => {
        await __cellWrite("test.session.per-user", "b-private")
      },
    )

    // Each reads back ONLY their own value — distinct persistent
    // partitions, never shared.
    const { result: seenA } = await runWithRequestAsync(
      new Request("http://t/", { headers: { cookie: "__frame_sid=user-a" } }),
      () => Promise.resolve(notes.peek()),
    )
    const { result: seenB } = await runWithRequestAsync(
      new Request("http://t/", { headers: { cookie: "__frame_sid=user-b" } }),
      () => Promise.resolve(notes.peek()),
    )
    expect(seenA).toBe("a-private")
    expect(seenB).toBe("b-private")
  })
})

describe("dev warning — unresolved persistent partition routed to ephemeral", () => {
  it("fires ONCE for a persistent cell with an empty-session partition", async () => {
    const notes = localCell({
      id: "test.session.warn-once",
      shape: "string",
      partition: ({ session }) => ({ sid: session.id }),
      initial: "",
    })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      await anonRequest(async () => {
        // Two routing decisions in one anon request: a write + a read.
        await __cellWrite("test.session.warn-once", "draft")
        notes.peek()
      })
      // Second anon request hits the same unresolved partition again.
      await anonRequest(() => Promise.resolve(notes.peek()))

      const cellWarnings = warn.mock.calls.filter(
        (c) => typeof c[0] === "string" && c[0].includes("test.session.warn-once"),
      )
      expect(cellWarnings).toHaveLength(1)
      expect(cellWarnings[0]?.[0]).toContain("persistent cell")
      expect(cellWarnings[0]?.[0]).toContain("won't persist")
    } finally {
      warn.mockRestore()
    }
  })

  it("does NOT fire for a resolved session.id", async () => {
    const notes = localCell({
      id: "test.session.warn-resolved",
      shape: "string",
      partition: ({ session }) => ({ sid: session.id }),
      initial: "",
    })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      await runWithRequestAsync(
        new Request("http://t/", { headers: { cookie: "__frame_sid=user-x" } }),
        async () => {
          await __cellWrite("test.session.warn-resolved", "kept")
          notes.peek()
        },
      )
      const cellWarnings = warn.mock.calls.filter(
        (c) => typeof c[0] === "string" && c[0].includes("test.session.warn-resolved"),
      )
      expect(cellWarnings).toHaveLength(0)
    } finally {
      warn.mockRestore()
    }
  })

  it("does NOT fire for an already-ephemeral cell, even with an empty partition", () => {
    // An ephemeral cell (gqlCell / fragmentCell shape) routes to
    // ephemeral storage by design — routing its unresolved partition to
    // ephemeral persists nothing either way, so there's nothing to warn.
    const ephemeral = buildEphemeralCell<unknown>("test.session.warn-ephemeral", "", undefined)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      cellStorageForArgs(ephemeral, { sid: "" })
      const cellWarnings = warn.mock.calls.filter(
        (c) => typeof c[0] === "string" && c[0].includes("test.session.warn-ephemeral"),
      )
      expect(cellWarnings).toHaveLength(0)
    } finally {
      warn.mockRestore()
    }
  })
})
