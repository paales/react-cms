/**
 * Monotonic commit ordering for window-scoped selector refetches.
 *
 * Every search keystroke fires an independent `.search-results`
 * refetch (`navigate({selector})`). Superseded fires are NOT aborted —
 * they drain and commit, because aborting one mid-decode would reject
 * the whole Flight document and crash the page. The hazard: their
 * responses can arrive OUT OF ORDER, so an older-issued ("po") tree can
 * land after a newer-issued ("pokemo") one and clobber it — the
 * "stage-1 committed a tree for a stale query" bug.
 *
 * The fix is a per-selector monotonic sequence: each fire gets an
 * increasing issue seq (`_nextRefetchSeq`), and a commit is only
 * allowed if its seq is not older than the newest already committed for
 * that selector (`_claimRefetchCommit`). "Last ISSUED wins", regardless
 * of arrival order — the real signal, not the window-URL proxy.
 *
 * Selector identity is the key (the sorted, comma-joined label set, as
 * on the wire's `?partials=`). Each test uses a distinct key so the
 * module-level high-water marks don't bleed across cases.
 */

import { describe, expect, it } from "vitest"
import {
  claimRefetchCommit as _claimRefetchCommit,
  nextRefetchSeq as _nextRefetchSeq,
} from "../refetch-ordering.ts"
import {
  abortPredecessors,
  inFlightKey,
  registerInFlight,
  unregisterInFlight,
  type InFlightEntry,
} from "../partial-client-state.ts"

describe("_claimRefetchCommit — monotonic per-selector commit ordering", () => {
  it("commits fires that arrive in issue order", () => {
    const k = "search-results-inorder"
    expect(_claimRefetchCommit(k, 1)).toBe(true)
    expect(_claimRefetchCommit(k, 2)).toBe(true)
    expect(_claimRefetchCommit(k, 3)).toBe(true)
  })

  it("drops a superseded fire that arrives out of order (the stale-q bug)", () => {
    const k = "search-results-reorder"
    // The newer fire ("pokemo", seq 2) lands and commits first…
    expect(_claimRefetchCommit(k, 2)).toBe(true)
    // …then the older fire ("po", seq 1) arrives late. Committing it
    // would clobber the newer tree — it must be dropped.
    expect(_claimRefetchCommit(k, 1)).toBe(false)
  })

  it("lets every segment of one streaming fire (shared seq) commit", () => {
    const k = "search-results-stream"
    // One streaming refetch commits per segment (stage 1/2/3) — all
    // carry the same issue seq, so each must be allowed.
    expect(_claimRefetchCommit(k, 5)).toBe(true)
    expect(_claimRefetchCommit(k, 5)).toBe(true)
    expect(_claimRefetchCommit(k, 5)).toBe(true)
  })

  it("drops the older fire's later segments once a newer fire commits mid-stream", () => {
    const k = "search-results-interleave"
    expect(_claimRefetchCommit(k, 1)).toBe(true) // old fire, stage 1 paints
    expect(_claimRefetchCommit(k, 2)).toBe(true) // newer fire supersedes
    expect(_claimRefetchCommit(k, 1)).toBe(false) // old fire's stage 2: dropped
    expect(_claimRefetchCommit(k, 2)).toBe(true) // newer fire's stage 2: commits
  })

  it("keeps per-selector keys independent", () => {
    expect(_claimRefetchCommit("sel-a", 9)).toBe(true)
    // A different selector's first fire is unaffected by sel-a's high-water mark.
    expect(_claimRefetchCommit("sel-b", 1)).toBe(true)
  })

  it("an issued-but-never-committed newer fire does not blackhole an older drain", () => {
    const k = "search-results-aborted-newer"
    const first = _nextRefetchSeq(k) // 1
    _nextRefetchSeq(k) // 2 — issued, then aborted by the caller's signal
    // The newer fire never commits (its fetch was cancelled before any
    // segment landed). The high-water mark only advances on COMMIT, so
    // the older fire's drain still lands — the page shows fire 1's
    // tree, which is the newest content that actually arrived.
    expect(_claimRefetchCommit(k, first)).toBe(true)
  })

  it("a resumed older stream cannot commit again after a newer fire landed between its segments", () => {
    const k = "search-results-resume-after-newer"
    const older = _nextRefetchSeq(k) // 1
    const newer = _nextRefetchSeq(k) // 2
    expect(_claimRefetchCommit(k, older)).toBe(true) // stage 1 of the older stream
    expect(_claimRefetchCommit(k, newer)).toBe(true) // newer fire lands whole
    expect(_claimRefetchCommit(k, older)).toBe(false) // older stage 2: dropped
    expect(_claimRefetchCommit(k, older)).toBe(false) // …and stays dropped (stage 3)
    expect(_claimRefetchCommit(k, newer)).toBe(true) // newer's own later segments still pass
  })
})

describe("in-flight registry — frame long-poll supersede/abort", () => {
  const entry = (): InFlightEntry => ({ controller: new AbortController() })

  it("inFlightKey is the sorted label set; label-less fires get no key", () => {
    expect(inFlightKey(["b", "a"])).toBe("a,b")
    expect(inFlightKey(["cart"])).toBe("cart")
    expect(inFlightKey([])).toBe(null)
  })

  it("abortPredecessors aborts every OLDER fire and keeps the newest", () => {
    const k = "frame-cart-abort"
    const oldest = entry()
    const middle = entry()
    const newest = entry()
    registerInFlight(k, oldest)
    registerInFlight(k, middle)
    registerInFlight(k, newest)

    // The newest fire's first segment landed — its predecessors' long-
    // poll streams must tear down.
    abortPredecessors(k, newest)
    expect(oldest.controller.signal.aborted).toBe(true)
    expect(middle.controller.signal.aborted).toBe(true)
    expect(newest.controller.signal.aborted).toBe(false)

    unregisterInFlight(k, newest)
  })

  it("abortPredecessors on the oldest entry is a no-op", () => {
    const k = "frame-cart-oldest"
    const oldest = entry()
    const newer = entry()
    registerInFlight(k, oldest)
    registerInFlight(k, newer)

    // A stale fire completing does not cancel the newer one.
    abortPredecessors(k, oldest)
    expect(oldest.controller.signal.aborted).toBe(false)
    expect(newer.controller.signal.aborted).toBe(false)

    unregisterInFlight(k, oldest)
    unregisterInFlight(k, newer)
  })

  it("an unregistered (finished) fire is no longer aborted by successors", () => {
    const k = "frame-cart-finished"
    const finished = entry()
    const next = entry()
    registerInFlight(k, finished)
    unregisterInFlight(k, finished)
    registerInFlight(k, next)

    abortPredecessors(k, next)
    expect(finished.controller.signal.aborted).toBe(false)

    unregisterInFlight(k, next)
  })
})

describe("_nextRefetchSeq — monotonic issue counter", () => {
  it("increments per key and is independent across keys", () => {
    const a = "issue-a"
    const b = "issue-b"
    expect(_nextRefetchSeq(a)).toBe(1)
    expect(_nextRefetchSeq(a)).toBe(2)
    expect(_nextRefetchSeq(b)).toBe(1)
    expect(_nextRefetchSeq(a)).toBe(3)
    expect(_nextRefetchSeq(b)).toBe(2)
  })

  it("feeds the claim gate so issue order is what commits last", () => {
    const k = "issue-claim-roundtrip"
    const first = _nextRefetchSeq(k) // 1
    const second = _nextRefetchSeq(k) // 2
    // Responses arrive reversed: the second-issued lands first.
    expect(_claimRefetchCommit(k, second)).toBe(true)
    expect(_claimRefetchCommit(k, first)).toBe(false)
  })
})
