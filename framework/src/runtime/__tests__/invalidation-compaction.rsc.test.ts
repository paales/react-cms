/**
 * Compaction semantics of the invalidation registry.
 *
 * The registry stores ONE entry per (name, canonical-constraints) pair;
 * a newer same-pair bump supersedes the older entry's `ts` in place.
 * These tests prove the compaction is lossless for the only read the
 * framework performs — the MAX matching `ts` (`queryMatchingTs`) — and
 * that storage stays bounded by partition cardinality under sustained
 * ticker load (the website world-pulse shape: many bumps, one selector
 * name, bounded partitions).
 */

import { afterEach, describe, expect, it } from "vitest";
import {
	_clearInvalidationRegistry,
	_currentTs,
	_registryStats,
	buildCellSelector,
	queryMatchingTs,
	refreshSelector,
} from "../invalidation-registry.ts";

afterEach(() => {
	_clearInvalidationRegistry();
});

describe("same-key supersession", () => {
	it("a re-bump of the same (name, constraints) yields the newest ts", () => {
		refreshSelector("price?sku=A");
		const first = _currentTs();
		refreshSelector("price?sku=A");
		const second = _currentTs();
		expect(second).toBeGreaterThan(first);
		expect(queryMatchingTs(["price"], { sku: "A" })).toBe(second);
	});

	it("supersession keeps distinct constraint tuples independent", () => {
		refreshSelector("price"); // bare — matches every placement
		const bareTs = _currentTs();
		refreshSelector("price?sku=B");
		refreshSelector("price?sku=A");
		const aTs = _currentTs();
		refreshSelector("price?sku=B"); // supersedes the earlier sku=B entry
		const bTs = _currentTs();

		// Subset matching: a placement's constraint surface picks up every
		// entry whose constraints it satisfies; max wins.
		expect(queryMatchingTs(["price"], { sku: "A" })).toBe(aTs);
		expect(queryMatchingTs(["price"], { sku: "B" })).toBe(bTs);
		// A tuple no constrained entry matches still sees the bare bump.
		expect(queryMatchingTs(["price"], { sku: "C" })).toBe(bareTs);
		// Null vary inputs: only the unconstrained entry matches.
		expect(queryMatchingTs(["price"], null)).toBe(bareTs);
		// One entry per distinct tuple: bare, sku=A, sku=B.
		expect(_registryStats().entries).toBe(3);
	});

	it("multi-key tuples supersede by the full tuple, matched as a subset", () => {
		refreshSelector("price?sku=A&zone=EU");
		refreshSelector("price?sku=A"); // different tuple — does NOT supersede
		const skuOnlyTs = _currentTs();
		refreshSelector("price?sku=A&zone=EU");
		const bothTs = _currentTs();

		expect(_registryStats().entries).toBe(2);
		// Surface satisfying both tuples folds the max.
		expect(queryMatchingTs(["price"], { sku: "A", zone: "EU" })).toBe(bothTs);
		// Surface satisfying only the single-key tuple sees only it.
		expect(queryMatchingTs(["price"], { sku: "A", zone: "US" })).toBe(
			skuOnlyTs,
		);
	});

	it("type-tagged and string constraints stay distinct entries", () => {
		// A number partition (`{uid: 123}`) and a hand-authored string token
		// (`uid=123`) are different storage slots — compaction must not
		// merge them (mirrors the partition-key identity).
		refreshSelector(buildCellSelector("t.part", { uid: 123 }));
		const numTs = _currentTs();
		refreshSelector("cell:t.part?uid=123");
		const strTs = _currentTs();

		expect(_registryStats().entries).toBe(2);
		// String-loose entry matches both surfaces; type-tagged only the number.
		expect(queryMatchingTs(["cell:t.part"], { uid: "123" })).toBe(strTs);
		expect(queryMatchingTs(["cell:t.part"], { uid: 123 })).toBe(
			Math.max(numTs, strTs),
		);
	});
});

describe("lossless vs append-only reference model", () => {
	it("answers every query identically to an uncompacted registry", () => {
		// Deterministic LCG so the case set is reproducible.
		let seed = 42;
		const rnd = (): number => {
			seed = (seed * 1664525 + 1013904223) >>> 0;
			return seed / 2 ** 32;
		};
		const names = ["a", "b", "c"];
		const vals = ["1", "2", "3"];

		// Reference model: plain append-only list with linear max-scan —
		// the semantics compaction must preserve.
		interface RefEntry {
			name: string;
			constraints: Record<string, string>;
			ts: number;
		}
		const ref: RefEntry[] = [];
		const refQuery = (
			labels: readonly string[],
			vary: Record<string, string> | null,
		): number => {
			let max = 0;
			for (const e of ref) {
				if (!labels.includes(e.name)) continue;
				let ok = true;
				for (const k in e.constraints) {
					if (!vary || vary[k] == null || vary[k] !== e.constraints[k]) {
						ok = false;
						break;
					}
				}
				if (ok && e.ts > max) max = e.ts;
			}
			return max;
		};

		for (let i = 0; i < 500; i++) {
			const name = names[Math.floor(rnd() * names.length)];
			const constraints: Record<string, string> = {};
			for (const k of ["k1", "k2"]) {
				if (rnd() < 0.5) constraints[k] = vals[Math.floor(rnd() * vals.length)];
			}
			const qs = Object.entries(constraints)
				.map(([k, v]) => `${k}=${v}`)
				.join("&");
			refreshSelector(qs ? `${name}?${qs}` : name);
			ref.push({ name, constraints, ts: _currentTs() });
		}

		// Exhaustive query surface: every label × every vary combination the
		// constraint vocabulary can produce (incl. absent keys and null).
		const varyCombos: Array<Record<string, string> | null> = [null];
		for (const v1 of [...vals, "x", undefined]) {
			for (const v2 of [...vals, "x", undefined]) {
				const vary: Record<string, string> = {};
				if (v1 !== undefined) vary.k1 = v1;
				if (v2 !== undefined) vary.k2 = v2;
				varyCombos.push(vary);
			}
		}
		for (const label of names) {
			for (const vary of varyCombos) {
				expect(queryMatchingTs([label], vary)).toBe(refQuery([label], vary));
			}
		}
		for (const vary of varyCombos) {
			expect(queryMatchingTs(names, vary)).toBe(refQuery(names, vary));
		}

		// And storage stayed bounded by tuple cardinality, not bump count:
		// 3 names × (bare + up-to-16 k1/k2 tuples) ≪ 500 bumps.
		expect(_registryStats().entries).toBeLessThanOrEqual(3 * 17);
	});
});

describe("soak guard", () => {
	it("10k bumps across 100 partitions of one name stay ≤100 entries, answers exact", () => {
		const base = _currentTs();
		for (let i = 0; i < 10_000; i++) {
			refreshSelector(`pulse?part=${i % 100}`);
		}

		// Storage bounded by partition cardinality, not bump count.
		expect(_registryStats().entries).toBeLessThanOrEqual(100);
		// The monotonic counter still advanced once per bump.
		expect(_currentTs()).toBe(base + 10_000);

		// Every partition answers with its LAST bump's ts: partition p's
		// final bump is iteration 9900+p (0-based), i.e. ts base+9901+p.
		for (const p of [0, 1, 37, 99]) {
			expect(queryMatchingTs(["pulse"], { part: String(p) })).toBe(
				base + 9901 + p,
			);
		}
		// A partition never bumped matches nothing.
		expect(queryMatchingTs(["pulse"], { part: "100" })).toBe(0);
		// No unconstrained entry was created by partition-scoped bumps.
		expect(queryMatchingTs(["pulse"], null)).toBe(0);
	});
});
