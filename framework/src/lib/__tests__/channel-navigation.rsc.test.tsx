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
 *   5. the nav-consume prune + the ack fold gate keep the mirror
 *      honest: pre-navigation unacked deliveries never fold into the
 *      acked layer (the client as-of-drops them), while the ack still
 *      advances the watermark — the window frees;
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

const renders = { shared: 0, a: 0, b: 0, slow: 0 };

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
	it("nav-consume prunes pre-navigation unacked deliveries; the covering ack folds only post-nav holdings", async () => {
		const scope = freshLiveScope("nav-honest");
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
				const lanesSeg = await h.segments.next();
				if (lanesSeg.done || lanesSeg.value.kind !== "lanes")
					throw new Error("expected lanes segment");
				const laneIter = lanesSeg.value.lanes[Symbol.asyncIterator]();

				// A pre-navigation lane delivery (seq 2, as-of 0).
				refreshSelector("nav-a");
				const lane = await nextLane(laneIter);
				expect(lane.partonId).toBe("nav-a");
				await decodeLane(lane);

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
				await drainPayloadSegment(navSeg.value);

				// The consume pruned every pre-navigation record — only the
				// navigation segment's own (seq 3, as-of 9) pends.
				const session = _peekConnectionSession(conn);
				if (!session) throw new Error("session gone");
				expect([...session.pendingDeliveries.keys()]).toEqual([3]);
				expect(session.pendingDeliveries.get(3)?.asOf).toBe(9);

				// The client processed everything through seq 3 (the pre-nav
				// lane was an as-of drop — processed, not held). The watermark
				// advances — the window frees — and ONLY the post-nav
				// holdings fold into the acked layer.
				expect(
					await post(scope, {
						connection: conn,
						seq: 10,
						frames: [{ kind: "ack", delivered: 3 }],
					}),
				).toBe(204);
				expect(session.ackedDeliverySeq).toBe(3);
				expect(session.pendingDeliveries.size).toBe(0);
				expect(session.ackedFps.has("nav-a")).toBe(false);
				expect(session.ackedFps.has("nav-b")).toBe(true);

				await h.shutdown("nav-b");
			},
		);
	});

	it("the fold gate: an ack covering a pre-latch delivery discards it instead of folding", async () => {
		const session = _openConnectionSession("nav-gate", null);
		try {
			_recordDelivery(session, 1, [["x", "mk", "f1"]], 0);
			// The url statement latches (statedNavSeq advances at APPLY, ahead
			// of the driver's consume) …
			expect(
				await post(undefined, {
					connection: "nav-gate",
					seq: 7,
					frames: [{ kind: "url", url: "/next", intent: "push" }],
				}),
			).toBe(204);
			expect(session.statedNavSeq).toBe(7);
			// … so the ack that follows — computed by a client whose
			// navigation point was already 7 — frees the window WITHOUT
			// folding the dropped delivery's fps.
			expect(
				await post(undefined, {
					connection: "nav-gate",
					seq: 8,
					frames: [{ kind: "ack", delivered: 1 }],
				}),
			).toBe(204);
			expect(session.ackedDeliverySeq).toBe(1);
			expect(session.ackedFps.has("x")).toBe(false);
			expect(session.pendingDeliveries.size).toBe(0);

			// A post-navigation delivery folds as usual.
			_recordDelivery(session, 2, [["y", "mk", "f2"]], 7);
			expect(
				await post(undefined, {
					connection: "nav-gate",
					seq: 9,
					frames: [{ kind: "ack", delivered: 2 }],
				}),
			).toBe(204);
			expect([...(session.ackedFps.get("y") ?? [])]).toEqual(["f2"]);
		} finally {
			_closeConnectionSession("nav-gate");
		}
	});
});
