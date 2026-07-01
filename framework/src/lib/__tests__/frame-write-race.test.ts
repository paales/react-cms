/**
 * Lost-update safety for the frames-tree write path.
 *
 * Every frame nav is a clone-and-patch cycle on the window entry's
 * `state.__frames`: read the current state, `writeFrameNode` a new
 * snapshot, hand it to the Navigation API. A `history: "push"` frame
 * nav bakes its snapshot into `nav.navigate(...)`, whose entry commits
 * ASYNCHRONOUSLY — so a second frame nav firing inside that window
 * would read a snapshot missing the pending nav's node, and whichever
 * write landed last would silently drop the other frame's update.
 *
 * `runFrameTreeWrite` (frame-client.tsx) closes that window with a
 * write queue: a cycle whose commit is pending HOLDS the tree, and
 * later cycles re-read the then-current state when their turn comes.
 * These tests drive two `_frame()` handles against a fake Navigation
 * whose `navigate` commits are flushed manually, so the interleaving
 * is forced deterministically every run.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { _frame, _readFrameNode } from "../frame-client.tsx"

// ─── Controllable fake Navigation ───────────────────────────────────
//
// jsdom has no Navigation API; the suite-wide shim (vitest.setup.ts)
// commits `navigate` synchronously, which can't reproduce the race.
// This fake gives the test the two levers that matter:
//   - `updateCurrentEntry` applies state synchronously (spec behavior);
//   - `navigate` DEFERS its state application until the test flushes
//     the pending commit — the browser's async entry commit.

interface PendingCommit {
  flush: () => void
}

function makeFakeNav() {
  let entryState: unknown = null
  const pending: PendingCommit[] = []

  const currentEntry = {
    id: "fake",
    index: 0,
    key: "fake",
    sameDocument: true,
    get url() {
      return window.location.href
    },
    getState: () => entryState,
  }

  const nav = {
    currentEntry,
    canGoBack: false,
    canGoForward: false,
    transition: null,
    activation: null,
    entries: () => [currentEntry],
    updateCurrentEntry(opts: { state?: unknown }) {
      entryState = opts.state ?? null
    },
    navigate(_url: string, opts?: { state?: unknown }) {
      let resolveCommitted!: (v: unknown) => void
      const committed = new Promise((res) => {
        resolveCommitted = res
      })
      pending.push({
        flush: () => {
          entryState = opts?.state ?? null
          resolveCommitted(currentEntry)
        },
      })
      return { committed, finished: committed }
    },
    reload: () => ({ committed: Promise.resolve(), finished: Promise.resolve() }),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
  }

  return {
    nav,
    getState: () => entryState,
    /** Commit the oldest pending `navigate` (the browser finishing). */
    flushOldestCommit: () => {
      const c = pending.shift()
      if (!c) throw new Error("no pending navigate commit to flush")
      c.flush()
    },
    pendingCount: () => pending.length,
  }
}

/** Drain microtasks so queued frames-tree writes execute. */
const microtasks = () => new Promise<void>((res) => setTimeout(res, 0))

let fake: ReturnType<typeof makeFakeNav>
let priorNavigation: unknown

beforeEach(() => {
  priorNavigation = (globalThis as { navigation?: unknown }).navigation
  fake = makeFakeNav()
  ;(globalThis as { navigation?: unknown }).navigation = fake.nav
})

afterEach(() => {
  ;(globalThis as { navigation?: unknown }).navigation = priorNavigation
})

describe("frames-tree writes under concurrent frame navigations", () => {
  it("auto-mode nav applies its state synchronously when uncontended", () => {
    _frame(["t1cart"]).navigate("/cart/open")
    // No pending push commit → the read-modify-write ran synchronously.
    expect(_readFrameNode(fake.getState(), ["t1cart"])?.url).toBe("/cart/open")
  })

  it("a concurrent auto nav is not lost under a pending push commit (the lost-update race)", async () => {
    // Frame A navigates with history:"push" — its state snapshot is
    // baked into nav.navigate and the entry commit is now PENDING.
    const a = _frame(["t2cart"]).navigate("/cart/open", { history: "push" })

    // Frame B fires while A's commit is in flight. Unserialized, B
    // would read the pre-A state, apply {t2menu}, and then A's commit
    // would overwrite the entry with a snapshot that never saw B.
    const b = _frame(["t2menu"]).navigate("/menu/about")

    // B's write must be HELD — not applied against the stale snapshot.
    expect(_readFrameNode(fake.getState(), ["t2menu"])).toBeUndefined()

    // The browser finishes A's entry commit.
    fake.flushOldestCommit()
    await a.committed
    await microtasks()

    // Both frame nodes survive: A's from the committed push, B's
    // re-read the post-commit state and patched on top of it.
    expect(_readFrameNode(fake.getState(), ["t2cart"])?.url).toBe("/cart/open")
    expect(
      _readFrameNode(fake.getState(), ["t2menu"])?.url,
      "concurrent frame nav was lost under the pending push commit",
    ).toBe("/menu/about")

    await b.committed
  })

  it("two pending pushes serialize — the second reads the first's committed state", async () => {
    const a = _frame(["t3cart"]).navigate("/cart/open", { history: "push" })
    const b = _frame(["t3menu"]).navigate("/menu/about", { history: "push" })

    // Only A has dispatched its browser navigate; B is queued behind
    // A's commit, so exactly one commit is pending.
    expect(fake.pendingCount()).toBe(1)

    fake.flushOldestCommit()
    await a.committed
    await microtasks()

    // B's navigate dispatched only after A committed — from a snapshot
    // that includes A's node.
    expect(fake.pendingCount()).toBe(1)
    fake.flushOldestCommit()
    await b.committed
    await microtasks()

    expect(_readFrameNode(fake.getState(), ["t3cart"])?.url).toBe("/cart/open")
    expect(_readFrameNode(fake.getState(), ["t3menu"])?.url).toBe("/menu/about")
  })

  it("sequential auto navs on sibling frames both land (synchronous read-modify-write)", () => {
    _frame(["t4cart"]).navigate("/cart/open")
    _frame(["t4menu"]).navigate("/menu/about")
    expect(_readFrameNode(fake.getState(), ["t4cart"])?.url).toBe("/cart/open")
    expect(_readFrameNode(fake.getState(), ["t4menu"])?.url).toBe("/menu/about")
  })

  it("per-frame history stacks stay intact across a contended write", async () => {
    // Seed the drawer with an initial URL, then push-navigate it while
    // a sibling frame writes concurrently; the drawer's own back-stack
    // must record the prior URL exactly once.
    _frame(["t5drawer"]).navigate("/drawer/a")
    const a = _frame(["t5drawer"]).navigate("/drawer/b", { history: "push" })
    _frame(["t5panel"]).navigate("/panel/x")

    fake.flushOldestCommit()
    await a.committed
    await microtasks()

    const drawerNode = _readFrameNode(fake.getState(), ["t5drawer"])
    expect(drawerNode?.url).toBe("/drawer/b")
    expect(drawerNode?.__frameHistory?.past).toEqual(["/drawer/a"])
    expect(_readFrameNode(fake.getState(), ["t5panel"])?.url).toBe("/panel/x")
  })
})
