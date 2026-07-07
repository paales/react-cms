/**
 * Window navigation over the channel — `url` frames and navigation
 * segments, against a real drive. The claims:
 *
 *   1. a url frame ends the lanes region and answers with ONE payload
 *      segment for the new URL, in stream order — fp-skip against the
 *      connection's mirror prunes partons the client already holds to
 *      placeholders (a navigation to a mostly-mirrored route ships
 *      ~placeholders), the segment's `seq` entry carries the frame's
 *      envelope seq as its AS-OF, and the lanes region reopens after;
 *   2. a url frame naming a cross-origin target 400s the envelope —
 *      nothing applies; same-origin absolute and path-relative targets
 *      both apply;
 *   3. navigation outranks pending flips: an envelope carrying a flip
 *      AND a url statement produces the navigation segment FIRST; the
 *      flip's lane follows, resolved against the new route;
 *   4. a NEWER url frame mid-render supersedes: the in-flight
 *      navigation render is aborted server-side (its truncated segment
 *      never settles) and exactly one settled navigation segment lands
 *      — the newest statement's, as-of ITS envelope seq;
 *   5. the mirror SURVIVES navigation: held pre-navigation deliveries
 *      stay in the mirror across a nav (the client keeps them, parked)
 *      and fold as holdings on the covering ack, so a return nav
 *      fp-skips them without any intervening ack; a delivery the client
 *      REPORTS dropped (`ack.dropped`) is evicted from the optimistic
 *      layer and never folds — the drop is the client's explicit
 *      statement, not a server inference from seq order;
 *   6. a stale url restatement (seq at or below the consumed
 *      navigation) applies as a no-op — retransmit idempotence.
 */

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runWithRequestAsync } from "../../runtime/context.ts";
import {
	_clearInvalidationRegistry,
	refreshSelector,
} from "../../runtime/invalidation-registry.ts";
import {
	decodeLane,
	drainPayloadSegment,
	freshLiveScope,
	withLiveDrive,
} from "../../test/live-drive.tsx";
import { CHANNEL_ENDPOINT, type ChannelEnvelope } from "../channel-protocol.ts";
import {
	_openConnectionSession,
	_closeConnectionSession,
	_peekConnectionSession,
	_recordDelivery,
	handleChannelPost,
} from "../connection-session.ts";
import type { DemuxedLane } from "../fp-trailer-split.ts";
import { PartialRoot, parton, type RenderArgs } from "../partial.tsx";
import { clearRegistry } from "../partial-registry.ts";
import { searchParam } from "../server-hooks.ts";

const renders = { shared: 0, a: 0, b: 0, slow: 0, outer: 0, child: 0 };

// The mid-render supersede's controllable stall — re-armed per test.
let releaseSlow: () => void = () => {};
let slowGate: Promise<void> = Promise.resolve();
function armSlowGate(): void {
	slowGate = new Promise<void>((resolve) => {
		releaseSlow = resolve;
	});
}

const NavShared = parton(
	function NavSharedRender(_: RenderArgs) {
		renders.shared++;
		return <div data-shared>{`shared:${renders.shared}`}</div>;
	},
	{ selector: "nav-shared" },
);
const NavA = parton(
	function NavARender(_: RenderArgs) {
		renders.a++;
		return <div data-a>{`route-a:${renders.a}`}</div>;
	},
	{ match: "/nav-a", selector: "nav-a" },
);
const NavB = parton(
	function NavBRender(_: RenderArgs) {
		renders.b++;
		return <div data-b>{`route-b:${renders.b}`}</div>;
	},
	{ match: "/nav-b", selector: "nav-b" },
);
const NavSlow = parton(
	async function NavSlowRender(_: RenderArgs) {
		renders.slow++;
		await slowGate;
		return <div data-slow>slow-resolved</div>;
	},
	{ match: "/nav-slow", selector: "nav-slow" },
);

// A nested wrapper + addressable child that reads a searchParam — the
// fold-exclusion fixture. `#fold-outer` folds `#fold-child`'s deps, so
// without the exclusion a `?x=` change on the child moves the wrapper's
// fp and re-renders it; with the child force-refetched, the wrapper's
// fold excludes it and the wrapper fp-skips.
const FoldChild = parton(
	function FoldChildRender(_: RenderArgs) {
		renders.child++;
		const x = searchParam("x") ?? "";
		return <div data-fold-child>{`child:${x}:${renders.child}`}</div>;
	},
	{ selector: "fold-child" },
);
const FoldOuter = parton(
	function FoldOuterRender(_: RenderArgs) {
		renders.outer++;
		return (
			<div data-fold-outer>
				{`outer:${renders.outer}`}
				<FoldChild />
			</div>
		);
	},
	{ match: "/fold", selector: "fold-outer" },
);
const PageFold = (): ReactNode => (
	<PartialRoot>
		<FoldOuter />
	</PartialRoot>
);

const PageNav = (): ReactNode => (
	<PartialRoot>
		<NavShared />
		<NavA />
		<NavB />
		<NavSlow />
	</PartialRoot>
);

beforeEach(() => {
	_clearInvalidationRegistry();
	renders.shared = 0;
	renders.a = 0;
	renders.b = 0;
	renders.slow = 0;
	renders.outer = 0;
	renders.child = 0;
	armSlowGate();
});

afterEach(() => {
	releaseSlow();
	clearRegistry("all");
	_clearInvalidationRegistry();
});

async function post(
	scope: string | undefined,
	envelope: ChannelEnvelope,
): Promise<number> {
	const headers: Record<string, string> = {
		"content-type": "application/json",
	};
	if (scope !== undefined) headers["x-test-scope"] = scope;
	const request = new Request(`http://localhost${CHANNEL_ENDPOINT}`, {
		method: "POST",
		headers,
		body: JSON.stringify(envelope),
	});
	const { result } = await runWithRequestAsync(request, () =>
		handleChannelPost(request),
	);
	return result.status;
}

async function nextLane(
	iter: AsyncIterator<DemuxedLane>,
): Promise<DemuxedLane> {
	const step = await iter.next();
	if (step.done) throw new Error("expected another lane");
	return step.value;
}

describe("url frames drive navigation segments", () => {
	it("a url frame renders the new URL as a payload segment, fp-skipping the mirror, and reopens lanes", async () => {
		const scope = freshLiveScope("nav-basic");
		await withLiveDrive(
			"http://localhost/nav-a?live=1",
			PageNav,
			scope,
			async (h) => {
				const first = await h.segments.next();
				if (first.done || first.value.kind !== "payload")
					throw new Error("expected payload segment 0");
				const seg0 = await drainPayloadSegment(first.value);
				expect(seg0).toContain("route-a:1");
				expect(seg0).toContain("shared:1");
				const conn = h.connectionId() ?? "";
				expect(conn).not.toBe("");

				const lanesSeg = await h.segments.next();
				if (lanesSeg.done || lanesSeg.value.kind !== "lanes")
					throw new Error("expected lanes segment");

				// The client committed segment 0 and says so (the transport's
				// FIRST commit drives a prompt ack). Without the ack, the
				// nav-consume prune discards the segment's unacked promotions
				// — conservative over-fetch — and the navigation re-ships the
				// shared parton instead of confirming it.
				expect(
					await post(scope, {
						connection: conn,
						seq: 2,
						frames: [{ kind: "ack", delivered: 1 }],
					}),
				).toBe(204);

				// The statement: the client's window URL is now /nav-b
				// (envelope seq 3 — page-lifetime).
				expect(
					await post(scope, {
						connection: conn,
						seq: 3,
						frames: [{ kind: "url", url: "/nav-b", intent: "push" }],
					}),
				).toBe(204);

				// The lanes region ends; the NAVIGATION SEGMENT flows: fresh
				// route-b content, while the mirrored shared parton fp-skips
				// to a placeholder (its body never re-runs).
				const navSeg = await h.segments.next();
				if (navSeg.done || navSeg.value.kind !== "payload")
					throw new Error("expected the navigation payload segment");
				const navBody = await drainPayloadSegment(navSeg.value);
				expect(navBody).toContain("route-b:1");
				expect(navBody).toContain('"data-partial-id":"nav-shared"');
				expect(renders.shared).toBe(1);

				// The delivery entry carries the url frame's envelope seq as
				// its as-of; the session's request state reflects the consume.
				const seqBodies = h.entries
					.filter((e) => e.tag === "seq")
					.map((e) => e.body);
				expect(seqBodies).toEqual(["1 0", "2 3"]);
				expect(_peekConnectionSession(conn)?.consumedNavSeq).toBe(3);

				// The lanes region reopened — post-navigation wakes lane on
				// the NEW route.
				const reopened = await h.segments.next();
				if (reopened.done || reopened.value.kind !== "lanes")
					throw new Error("expected the reopened lanes region");
				const laneIter = reopened.value.lanes[Symbol.asyncIterator]();
				refreshSelector("nav-b");
				const lane = await nextLane(laneIter);
				expect(lane.partonId).toBe("nav-b");
				await decodeLane(lane);

				await h.shutdown("nav-b");
			},
		);
	});

	it("a refetch statement's `__force` targets lane fresh after the whole-tree segment", async () => {
		const scope = freshLiveScope("nav-force");
		await withLiveDrive(
			"http://localhost/nav-a?live=1",
			PageNav,
			scope,
			async (h) => {
				const first = await h.segments.next();
				if (first.done || first.value.kind !== "payload")
					throw new Error("expected payload segment 0");
				await drainPayloadSegment(first.value);
				const conn = h.connectionId() ?? "";
				await h.segments.next(); // lanes
				expect(
					await post(scope, {
						connection: conn,
						seq: 2,
						frames: [{ kind: "ack", delivered: 1 }],
					}),
				).toBe(204);

				// reload({selector: "nav-a"}) as a channel statement: same
				// page URL, `__force=nav-a`, intent silent.
				expect(
					await post(scope, {
						connection: conn,
						seq: 3,
						frames: [
							{ kind: "url", url: "/nav-a?__force=nav-a", intent: "silent" },
						],
					}),
				).toBe(204);
				// The whole-tree segment re-evaluates the (unchanged) URL —
				// everything mirrored prunes to placeholders; the force does
				// NOT ride the segment render (an fp-skipped ancestor or a
				// byte-cache replay would cut a forced target out of a tree
				// render — the lane below is the force's path).
				const seg = await h.segments.next();
				if (seg.done || seg.value.kind !== "payload")
					throw new Error("expected the refetch's payload segment");
				const body = await drainPayloadSegment(seg.value);
				expect(body).toContain('"data-partial-id":"nav-a"');
				expect(body).toContain('"data-partial-id":"nav-shared"');
				expect(renders.shared).toBe(1);

				// The forced target lanes EXPLICIT on the reopened region:
				// fp unchanged, yet the body re-runs — a refetch target must
				// re-render, never match-and-skip.
				const reopened = await h.segments.next();
				if (reopened.done || reopened.value.kind !== "lanes")
					throw new Error("expected the reopened lanes region");
				const laneIter = reopened.value.lanes[Symbol.asyncIterator]();
				const lane = await nextLane(laneIter);
				expect(lane.partonId).toBe("nav-a");
				expect((await decodeLane(lane)).bodyText).toContain("route-a:2");
				// The one-shot overlay never persisted into the connection's
				// request state.
				expect(_peekConnectionSession(conn)?.consumedNavSeq).toBe(3);

				await h.shutdown("nav-a");
			},
		);
	});

	it("a stale url restatement (seq ≤ consumed) is an idempotent no-op", async () => {
		const scope = freshLiveScope("nav-stale");
		await withLiveDrive(
			"http://localhost/nav-a?live=1",
			PageNav,
			scope,
			async (h) => {
				const first = await h.segments.next();
				if (first.done || first.value.kind !== "payload")
					throw new Error("expected payload segment 0");
				await drainPayloadSegment(first.value);
				const conn = h.connectionId() ?? "";
				await h.segments.next(); // lanes

				expect(
					await post(scope, {
						connection: conn,
						seq: 4,
						frames: [{ kind: "url", url: "/nav-b", intent: "push" }],
					}),
				).toBe(204);
				const navSeg = await h.segments.next();
				if (navSeg.done || navSeg.value.kind !== "payload")
					throw new Error("expected the navigation payload segment");
				await drainPayloadSegment(navSeg.value);
				await h.segments.next(); // reopened lanes

				// The retransmit: same statement, same seq. Already consumed —
				// it latches nothing and drives no segment.
				expect(
					await post(scope, {
						connection: conn,
						seq: 4,
						frames: [{ kind: "url", url: "/nav-b", intent: "push" }],
					}),
				).toBe(204);
				expect(_peekConnectionSession(conn)?.pendingNav).toBeNull();
				expect(_peekConnectionSession(conn)?.consumedNavSeq).toBe(4);

				await h.shutdown("nav-b");
			},
		);
	});
});

describe("same-origin validation", () => {
	it("a cross-origin url frame 400s the envelope and applies nothing", async () => {
		const session = _openConnectionSession("nav-origin", null);
		try {
			expect(
				await post(undefined, {
					connection: "nav-origin",
					seq: 1,
					frames: [
						{ kind: "url", url: "http://evil.example/x", intent: "push" },
					],
				}),
			).toBe(400);
			expect(session.pendingNav).toBeNull();
			expect(session.statedNavSeq).toBe(0);
			expect(session.appliedSeq).toBe(0);

			// Same-origin absolute and path-relative targets both latch.
			expect(
				await post(undefined, {
					connection: "nav-origin",
					seq: 2,
					frames: [
						{ kind: "url", url: "http://localhost/ok?q=1", intent: "replace" },
					],
				}),
			).toBe(204);
			expect(session.pendingNav).toEqual({
				url: "/ok?q=1",
				intent: "replace",
				seq: 2,
			});
			expect(
				await post(undefined, {
					connection: "nav-origin",
					seq: 3,
					frames: [{ kind: "url", url: "/ok2", intent: "silent" }],
				}),
			).toBe(204);
			expect(session.pendingNav).toEqual({
				url: "/ok2",
				intent: "silent",
				seq: 3,
			});
		} finally {
			_closeConnectionSession("nav-origin");
		}
	});

	it("a malformed url frame (bad intent, empty url) is a 400", async () => {
		const session = _openConnectionSession("nav-shape", null);
		try {
			expect(
				await post(undefined, {
					connection: "nav-shape",
					seq: 1,
					frames: [
						{ kind: "url", url: "/x", intent: "teleport" },
					] as unknown as ChannelEnvelope["frames"],
				}),
			).toBe(400);
			expect(
				await post(undefined, {
					connection: "nav-shape",
					seq: 2,
					frames: [
						{ kind: "url", url: "", intent: "push" },
					] as unknown as ChannelEnvelope["frames"],
				}),
			).toBe(400);
			expect(session.pendingNav).toBeNull();
		} finally {
			_closeConnectionSession("nav-shape");
		}
	});
});

describe("wake priority — navigation first", () => {
	it("an envelope carrying a flip and a url statement lands the navigation segment before the flip's lane", async () => {
		const scope = freshLiveScope("nav-priority");
		await withLiveDrive(
			"http://localhost/nav-a?live=1",
			PageNav,
			scope,
			async (h) => {
				const first = await h.segments.next();
				if (first.done || first.value.kind !== "payload")
					throw new Error("expected payload segment 0");
				await drainPayloadSegment(first.value);
				const conn = h.connectionId() ?? "";
				await h.segments.next(); // lanes

				// One envelope: the flip FIRST in frame order, the url second.
				// Navigation still preempts — the flip resolves after, against
				// the new route (nav-shared renders there too).
				expect(
					await post(scope, {
						connection: conn,
						seq: 5,
						frames: [
							{
								kind: "visible",
								changed: ["nav-shared"],
								visible: ["nav-shared"],
								cached: [],
							},
							{ kind: "url", url: "/nav-b", intent: "push" },
						],
					}),
				).toBe(204);

				const navSeg = await h.segments.next();
				if (navSeg.done || navSeg.value.kind !== "payload")
					throw new Error("expected the navigation segment first");
				expect(await drainPayloadSegment(navSeg.value)).toContain("route-b:1");

				const reopened = await h.segments.next();
				if (reopened.done || reopened.value.kind !== "lanes")
					throw new Error("expected the reopened lanes region");
				const laneIter = reopened.value.lanes[Symbol.asyncIterator]();
				// The flip's lane follows on the reopened region ("I hold
				// nothing" — the stated empty holdings force a re-render).
				const lane = await nextLane(laneIter);
				expect(lane.partonId).toBe("nav-shared");
				expect((await decodeLane(lane)).bodyText).toContain("shared:");

				await h.shutdown("nav-b");
			},
		);
	});
});

describe("mid-render supersede", () => {
	it("a newer url frame aborts the in-flight navigation render — exactly one settled navigation segment", async () => {
		const scope = freshLiveScope("nav-supersede");
		await withLiveDrive(
			"http://localhost/nav-a?live=1",
			PageNav,
			scope,
			async (h) => {
				const first = await h.segments.next();
				if (first.done || first.value.kind !== "payload")
					throw new Error("expected payload segment 0");
				await drainPayloadSegment(first.value);
				const conn = h.connectionId() ?? "";
				await h.segments.next(); // lanes

				// Navigate to the stalling route: the segment's render suspends
				// at NavSlow's gate and its bytes stop flowing.
				expect(
					await post(scope, {
						connection: conn,
						seq: 6,
						frames: [{ kind: "url", url: "/nav-slow", intent: "push" }],
					}),
				).toBe(204);
				const stalled = await h.segments.next();
				if (stalled.done || stalled.value.kind !== "payload")
					throw new Error("expected the stalled navigation segment");

				// The newer statement supersedes mid-render: the stalled
				// segment is aborted (never settles — its body ends at the
				// next delimiter) and the /nav-b segment lands.
				expect(
					await post(scope, {
						connection: conn,
						seq: 7,
						frames: [{ kind: "url", url: "/nav-b", intent: "push" }],
					}),
				).toBe(204);
				const tornBody = await drainPayloadSegment(stalled.value);
				expect(tornBody).not.toContain("slow-resolved");

				const covering = await h.segments.next();
				if (covering.done || covering.value.kind !== "payload")
					throw new Error("expected the covering navigation segment");
				expect(await drainPayloadSegment(covering.value)).toContain(
					"route-b:1",
				);

				// Exactly one settled navigation: the torn segment's delivery
				// (seq 2) rendered as-of 6, the covering one (seq 3) as-of 7 —
				// and the lanes region reopens exactly once, after the
				// covering segment.
				const seqBodies = h.entries
					.filter((e) => e.tag === "seq")
					.map((e) => e.body);
				expect(seqBodies).toEqual(["1 0", "2 6", "3 7"]);
				expect(_peekConnectionSession(conn)?.consumedNavSeq).toBe(7);

				const reopened = await h.segments.next();
				if (reopened.done || reopened.value.kind !== "lanes")
					throw new Error("expected the reopened lanes region");

				releaseSlow();
				await h.shutdown("nav-b");
			},
		);
	});
});

describe("the mirror stays honest across navigations", () => {
	it("held pre-navigation deliveries survive the nav and fold as holdings on the covering ack", async () => {
		const scope = freshLiveScope("nav-held");
		await withLiveDrive(
			"http://localhost/nav-a?live=1",
			PageNav,
			scope,
			async (h) => {
				const first = await h.segments.next();
				if (first.done || first.value.kind !== "payload")
					throw new Error("expected payload segment 0");
				const seg0 = await drainPayloadSegment(first.value);
				expect(seg0).toContain("shared:1");
				const conn = h.connectionId() ?? "";
				const lanesSeg = await h.segments.next();
				if (lanesSeg.done || lanesSeg.value.kind !== "lanes")
					throw new Error("expected lanes segment");
				const laneIter = lanesSeg.value.lanes[Symbol.asyncIterator]();

				// A pre-navigation lane delivery (seq 2, as-of 0), committed by
				// the client at navigation point 0 — a HELD delivery.
				refreshSelector("nav-a");
				const lane = await nextLane(laneIter);
				expect(lane.partonId).toBe("nav-a");
				await decodeLane(lane);

				// Navigate to /nav-b WITHOUT an intervening ack: the mirror
				// RETAINS the pre-nav promotions (no prune), so the navigation
				// segment fp-skips the shared parton to a placeholder — its body
				// never re-runs. This is the keystone: fp-skip against the
				// OPTIMISTIC layer alone, no ack required.
				expect(
					await post(scope, {
						connection: conn,
						seq: 9,
						frames: [{ kind: "url", url: "/nav-b", intent: "push" }],
					}),
				).toBe(204);
				const navSeg = await h.segments.next();
				if (navSeg.done || navSeg.value.kind !== "payload")
					throw new Error("expected the navigation segment");
				const navBody = await drainPayloadSegment(navSeg.value);
				expect(navBody).toContain("route-b:1");
				expect(navBody).toContain('"data-partial-id":"nav-shared"');
				expect(renders.shared).toBe(1);

				// Nothing was pruned — every pre-nav delivery still pends, plus
				// the navigation segment's own (seq 3, as-of 9).
				const session = _peekConnectionSession(conn);
				if (!session) throw new Error("session gone");
				expect([...session.pendingDeliveries.keys()]).toEqual([1, 2, 3]);

				// The client HELD them all (no drop reported) — the covering
				// ack folds each into the acked layer as a client holding, and
				// frees the window.
				expect(
					await post(scope, {
						connection: conn,
						seq: 10,
						frames: [{ kind: "ack", delivered: 3 }],
					}),
				).toBe(204);
				expect(session.ackedDeliverySeq).toBe(3);
				expect(session.pendingDeliveries.size).toBe(0);
				expect(session.ackedFps.has("nav-a")).toBe(true);
				expect(session.ackedFps.has("nav-shared")).toBe(true);
				expect(session.ackedFps.has("nav-b")).toBe(true);

				await h.shutdown("nav-b");
			},
		);
	});

	it("a base parton fp-skips on the return nav — the mirror retained it across A→B→A without an ack", async () => {
		const scope = freshLiveScope("nav-return");
		await withLiveDrive(
			"http://localhost/nav-a?live=1",
			PageNav,
			scope,
			async (h) => {
				const first = await h.segments.next();
				if (first.done || first.value.kind !== "payload")
					throw new Error("expected payload segment 0");
				const seg0 = await drainPayloadSegment(first.value);
				expect(seg0).toContain("route-a:1");
				expect(seg0).toContain("shared:1");
				const conn = h.connectionId() ?? "";
				await h.segments.next(); // lanes

				// A→B, no ack. nav-shared fp-skips (the mirror holds it).
				expect(
					await post(scope, {
						connection: conn,
						seq: 3,
						frames: [{ kind: "url", url: "/nav-b", intent: "push" }],
					}),
				).toBe(204);
				const navB = await h.segments.next();
				if (navB.done || navB.value.kind !== "payload")
					throw new Error("expected the /nav-b navigation segment");
				const navBBody = await drainPayloadSegment(navB.value);
				expect(navBBody).toContain("route-b:1");
				expect(navBBody).toContain('"data-partial-id":"nav-shared"');
				await h.segments.next(); // reopened lanes

				// B→A (return), still no ack ever sent. nav-a AND nav-shared
				// both fp-skip — the mirror retained them across the round trip.
				// A pruned mirror would re-render nav-a here (renders.a → 2);
				// the retained mirror skips it (renders.a stays 1).
				expect(
					await post(scope, {
						connection: conn,
						seq: 4,
						frames: [{ kind: "url", url: "/nav-a", intent: "push" }],
					}),
				).toBe(204);
				const navA = await h.segments.next();
				if (navA.done || navA.value.kind !== "payload")
					throw new Error("expected the /nav-a return segment");
				const navABody = await drainPayloadSegment(navA.value);
				expect(navABody).toContain('"data-partial-id":"nav-a"');
				expect(navABody).toContain('"data-partial-id":"nav-shared"');
				expect(renders.a).toBe(1);
				expect(renders.shared).toBe(1);

				await h.shutdown("nav-a");
			},
		);
	});

	it("an ack naming a delivery DROPPED evicts its optimistic promotions and never folds them", async () => {
		const session = _openConnectionSession("nav-gate", null);
		try {
			// Mirror the driver's link: the two deliveries promoted `x` and
			// `y` into the optimistic layer at emission.
			session.cachedOverride = {
				fingerprints: new Map([
					["x", new Set(["f1"])],
					["y", new Set(["f2"])],
				]),
				matchKeys: new Map([
					["x", new Set(["mk"])],
					["y", new Set(["mk"])],
				]),
				slots: new Map([
					["x", new Map([["mk", new Set(["f1"])]])],
					["y", new Map([["mk", new Set(["f2"])]])],
				]),
			};
			_recordDelivery(session, 1, [["x", "mk", "f1"]], 0);
			_recordDelivery(session, 2, [["y", "mk", "f2"]], 0);

			// The ack covers both but names seq 1 DROPPED: the client received
			// it yet had navigated past its as-of, so it holds none of it.
			expect(
				await post(undefined, {
					connection: "nav-gate",
					seq: 8,
					frames: [{ kind: "ack", delivered: 2, dropped: [1] }],
				}),
			).toBe(204);
			expect(session.ackedDeliverySeq).toBe(2);
			expect(session.pendingDeliveries.size).toBe(0);

			// The dropped delivery never folds AND its optimistic promotions
			// are evicted — no phantom holding survives to fp-skip against.
			expect(session.ackedFps.has("x")).toBe(false);
			expect(session.cachedOverride.fingerprints.get("x")?.has("f1")).toBe(
				false,
			);
			expect(
				session.cachedOverride.slots.get("x")?.get("mk")?.has("f1"),
			).toBe(false);

			// The held delivery folds as usual, and stays in the optimistic
			// layer.
			expect([...(session.ackedFps.get("y") ?? [])]).toEqual(["f2"]);
			expect(session.cachedOverride.fingerprints.get("y")?.has("f2")).toBe(
				true,
			);
		} finally {
			_closeConnectionSession("nav-gate");
		}
	});
});

describe("the descendant fold excludes forced targets", () => {
	it("a forced child's dep change does not re-render its fp-skipping ancestor", async () => {
		const scope = freshLiveScope("fold-excl");
		await withLiveDrive(
			"http://localhost/fold?live=1",
			PageFold,
			scope,
			async (h) => {
				const first = await h.segments.next();
				if (first.done || first.value.kind !== "payload")
					throw new Error("expected payload segment 0");
				const seg0 = await drainPayloadSegment(first.value);
				expect(seg0).toContain("outer:1");
				expect(seg0).toContain("child::1");
				const conn = h.connectionId() ?? "";
				await h.segments.next(); // initial lanes
				expect(
					await post(scope, {
						connection: conn,
						seq: 2,
						frames: [{ kind: "ack", delivered: 1 }],
					}),
				).toBe(204);

				// Force-refetch fold-child with ?x=1. The wrapper's fold now
				// EXCLUDES the forced child, so its fp differs from seg0's (which
				// folded the child) — a one-time mismatch re-renders the wrapper
				// (over-fetch, never stale) and promotes the excluded fp.
				expect(
					await post(scope, {
						connection: conn,
						seq: 3,
						frames: [
							{
								kind: "url",
								url: "/fold?x=1&__force=fold-child",
								intent: "push",
							},
						],
					}),
				).toBe(204);
				const nav1 = await h.segments.next();
				if (nav1.done || nav1.value.kind !== "payload")
					throw new Error("expected the first refetch segment");
				await drainPayloadSegment(nav1.value);
				const lanes1 = await h.segments.next(); // reopened lanes (forced)
				if (lanes1.done || lanes1.value.kind !== "lanes")
					throw new Error("expected reopened lanes");
				const laneIter1 = lanes1.value.lanes[Symbol.asyncIterator]();
				const forced1 = await nextLane(laneIter1);
				expect(forced1.partonId).toBe("fold-child");
				await decodeLane(forced1);
				expect(renders.outer).toBe(2);

				// Force-refetch again with ?x=2. The wrapper's fp EXCLUDES the
				// child, so x=1→x=2 does NOT move it — the mirror holds the
				// excluded fp and the wrapper fp-skips to a placeholder
				// (renders.outer stays 2). Only fold-child re-lanes fresh.
				expect(
					await post(scope, {
						connection: conn,
						seq: 4,
						frames: [
							{
								kind: "url",
								url: "/fold?x=2&__force=fold-child",
								intent: "push",
							},
						],
					}),
				).toBe(204);
				const nav2 = await h.segments.next();
				if (nav2.done || nav2.value.kind !== "payload")
					throw new Error("expected the second refetch segment");
				const nav2Body = await drainPayloadSegment(nav2.value);
				expect(nav2Body).toContain('"data-partial-id":"fold-outer"');
				expect(nav2Body).not.toContain("outer:3");
				expect(renders.outer).toBe(2);

				const lanes2 = await h.segments.next();
				if (lanes2.done || lanes2.value.kind !== "lanes")
					throw new Error("expected the second reopened lanes");
				const laneIter2 = lanes2.value.lanes[Symbol.asyncIterator]();
				const forced2 = await nextLane(laneIter2);
				expect(forced2.partonId).toBe("fold-child");
				expect((await decodeLane(forced2)).bodyText).toContain("child:2:");

				await h.shutdown("fold-outer");
			},
		);
	});
});
