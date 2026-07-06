/**
 * Cull-to-park — the client pool mechanics (`cull-park.ts`).
 *
 *   - the parked-by-culling LRU: most-recently-culled kept; past the
 *     cap the oldest id's parked content (cache slots + advertised
 *     fps) is destroyed — its skeleton needs no cache entry (it
 *     renders from the pair's inline element), so it keeps holding
 *     the parton's space regardless;
 *   - the drop-on-drift generation: a fresh content store for a slot
 *     whose fiber has been parked since its bytes were minted bumps
 *     the generation (remount); a confirmed restore
 *     (`clearParkedSince`) makes later stores reconcile in place;
 *   - the observer refcount: a flip hands observation between the two
 *     slots inside one effect flush — only a count that stays at zero
 *     past the flush means the parton left the page.
 */

import { beforeEach, describe, expect, it } from "vitest"
import {
	_isParkedSince,
	_parkedIds,
	_resetCullPark,
	contentGeneration,
	contentSlotConfirmed,
	contentSlotStored,
	CULL_PARK_CAP,
	cullStateGone,
	registerCullObserver,
	reportCullState,
	reportedVisibility,
} from "../cull-park.ts"
import {
	cacheLookup,
	cacheStore,
	getCachedPartialIds,
	getCurrentPagePartials,
	pruneToLive,
	registerClientPartial,
} from "../partial-client-state.ts"

const MK = "0123456789abcdef"

function seedContent(id: string): void {
	const cache = getCurrentPagePartials()
	cacheStore(cache, id, MK, `content-${id}`)
	registerClientPartial(id, MK, `fp-${id}`)
}

beforeEach(() => {
	_resetCullPark()
	pruneToLive(new Map()) // clear both client maps
})

describe("parked-by-culling LRU", () => {
	it("evicts the oldest parked id's content past the cap", () => {
		const ids = Array.from({ length: CULL_PARK_CAP + 2 }, (_, i) => `chunk-${i}`)
		for (const id of ids) seedContent(id)
		for (const id of ids) reportCullState(id, false)

		// Two oldest culled ids fell off the LRU.
		expect(_parkedIds()).toEqual(ids.slice(2))
		const cache = getCurrentPagePartials()
		for (const id of ids.slice(0, 2)) {
			// Content destroyed — a return visit renders cold. (The skeleton
			// keeps holding the parton's space regardless: it renders from
			// the pair's inline element, never the cache.)
			expect(cacheLookup(cache, id, MK)).toBeUndefined()
			expect(getCachedPartialIds().some((t) => t.startsWith(`${id}:${MK}:`))).toBe(false)
		}
		// Survivors keep their content.
		expect(cacheLookup(cache, ids[2], MK)).toBe(`content-${ids[2]}`)
	})

	it("a cull-in removes the id from the pool; re-culling re-inserts at the tail", () => {
		seedContent("a")
		seedContent("b")
		reportCullState("a", false)
		reportCullState("b", false)
		expect(_parkedIds()).toEqual(["a", "b"])
		reportCullState("a", true)
		expect(_parkedIds()).toEqual(["b"])
		reportCullState("a", false)
		expect(_parkedIds()).toEqual(["b", "a"])
	})
})

describe("drop-on-drift generation", () => {
	it("bumps only for a store that lands while parked-since, once", () => {
		expect(contentGeneration("a")).toBe(0)
		// Ordinary live store (never parked): reconcile in place.
		contentSlotStored("a")
		expect(contentGeneration("a")).toBe(0)

		// Park, then fresh bytes arrive (fp moved while parked): drop.
		reportCullState("a", false)
		expect(_isParkedSince("a")).toBe(true)
		contentSlotStored("a")
		expect(contentGeneration("a")).toBe(1)
		// The bump consumed the parked-since mark — the follow-up live
		// update reconciles in place.
		contentSlotStored("a")
		expect(contentGeneration("a")).toBe(1)
	})

	it("a confirmed restore (confirmation placeholder) re-arms in-place updates", () => {
		reportCullState("a", false)
		reportCullState("a", true) // optimistic restore
		contentSlotConfirmed("a") // the commit walked the confirm placeholder
		contentSlotStored("a") // later live update
		expect(contentGeneration("a")).toBe(0)
	})
})

describe("observer refcount", () => {
	it("a slot handoff (release + register in one flush) is not gone", async () => {
		const gone: string[] = []
		const release1 = registerCullObserver("a", (id) => gone.push(id))
		reportCullState("a", true)
		// Flip: the content slot's observer cleans up, the skeleton
		// slot's mounts — same flush, before any microtask runs.
		release1()
		const release2 = registerCullObserver("a", (id) => gone.push(id))
		await Promise.resolve() // the sweep's microtask
		expect(gone).toEqual([])
		expect(reportedVisibility("a")).toBe(true)

		// A real departure: the last observer releases and nothing
		// re-registers before the sweep.
		release2()
		await Promise.resolve()
		expect(gone).toEqual(["a"])
	})

	it("gone drops every trace of the id", () => {
		seedContent("a")
		reportCullState("a", false)
		cullStateGone("a")
		expect(reportedVisibility("a")).toBeUndefined()
		expect(_parkedIds()).toEqual([])
		expect(_isParkedSince("a")).toBe(false)
	})
})
