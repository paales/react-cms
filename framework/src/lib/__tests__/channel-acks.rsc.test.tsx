/**
 * Delivery acks — the evidenced half of the live connection.
 *
 * Every payload segment and lane a live connection emits carries a
 * per-connection monotonic DELIVERY seq (`seq` entries); the client
 * acks the highest contiguously COMMITTED seq upstream, and the driver
 * layers its mirror on the evidence. The claims:
 *
 *   1. seq emission ordering — segment 0 carries seq 1 ahead of its
 *      Flight rows; each lane's seq entry precedes its `muxend`; seqs
 *      mint monotonically across segments and lanes;
 *   2. an `ack` frame advances the session's watermark, folds the
 *      covered deliveries' fps into the ACKED mirror layer, and is
 *      cumulative (stale/duplicate acks are no-ops); a record landing
 *      after its ack folds immediately;
 *   3. the `applied` marker announces the upstream envelope watermark
 *      after an envelope applies, exactly once per advance; a
 *      retransmitted (duplicate) envelope converges — same session
 *      state, no re-announce, and its re-queued flip costs at most a
 *      zero-byte confirmation (fp-skip off the optimistic layer: the
 *      re-lane skips with NO ack ever received);
 *   4. the attach statement's `applied` watermark seeds the session's
 *      applied gate, so the marker never announces below what the
 *      client already heard;
 *   5. window-exceeded coalescing — with the unacked window full, no
 *      new lanes open; touched ids coalesce and render their LATEST
 *      state when an ack frees the window (nothing dropped, one render
 *      per id no matter how many wakes coalesced);
 *   6. never-acked degrade — a connection whose first delivery settled
 *      a full deadline ago with no ack frame EVER received closes with
 *      `degradedReason: "never-acked"`; an acking client is NEVER
 *      degraded (any ack frame is the duplex proof);
 *   7. the reconcile backstop — past the cadence, the next wake emits
 *      a whole-tree payload segment on the stream (subsuming the
 *      wake's own changes) and reopens the lanes region;
 *   8. mirror layering — a flip statement's cached tokens supersede
 *      the ACKED layer too (an acked-then-evicted fp must not confirm
 *      a phantom), and the verdict falls back to the acked layer on an
 *      optimistic miss.
 */

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	_setConnectionSession,
	runWithRequestAsync,
} from "../../runtime/context.ts";
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
import { renderServerToFlight } from "../../test/rsc-server.ts";
import { CHANNEL_ENDPOINT, type ChannelEnvelope } from "../channel-protocol.ts";
import {
	_closeConnectionSession,
	_openConnectionSession,
	_peekConnectionSession,
	_recordDelivery,
	handleChannelPost,
} from "../connection-session.ts";
import type { DemuxedLane } from "../fp-trailer-split.ts";
import { PartialRoot, parton, type RenderArgs } from "../partial.tsx";
import { clearRegistry } from "../partial-registry.ts";
import {
	_setFirstAckDeadlineMs,
	_setReconcileIntervalMs,
	_setUnackedDeliveryWindow,
} from "../segmented-response.ts";

const renders = { a: 0, b: 0, win: 0, wib: 0, deg: 0, rec: 0, lay: 0, iso: 0 };

const AckA = parton(
	function AckARender(_: RenderArgs) {
		renders.a++;
		return <div data-a>{`a:${renders.a}`}</div>;
	},
	{ selector: "ack-a" },
);
const AckB = parton(
	function AckBRender(_: RenderArgs) {
		renders.b++;
		return <div data-b>{`b:${renders.b}`}</div>;
	},
	{ selector: "ack-b" },
);
const WinA = parton(
	function WinARender(_: RenderArgs) {
		renders.win++;
		return <div data-win>{`win:${renders.win}`}</div>;
	},
	{ selector: "win-a" },
);
const WinB = parton(
	function WinBRender(_: RenderArgs) {
		renders.wib++;
		return <div data-wib>{`wib:${renders.wib}`}</div>;
	},
	{ selector: "win-b" },
);
const DegA = parton(
	function DegARender(_: RenderArgs) {
		renders.deg++;
		return <div data-deg>{`deg:${renders.deg}`}</div>;
	},
	{ selector: "deg-a" },
);
const RecA = parton(
	function RecARender(_: RenderArgs) {
		renders.rec++;
		return <div data-rec>{`rec:${renders.rec}`}</div>;
	},
	{ selector: "rec-a" },
);
const LayA = parton(
	function LayARender(_: RenderArgs) {
		renders.lay++;
		return <div data-lay>{`lay:${renders.lay}`}</div>;
	},
	{ selector: "lay-a" },
);
const IsoA = parton(
	function IsoARender(_: RenderArgs) {
		renders.iso++;
		return <div data-iso>{`iso:${renders.iso}`}</div>;
	},
	{ selector: "iso-a" },
);

const PageAB = (): ReactNode => (
	<PartialRoot>
		<AckA />
		<AckB />
	</PartialRoot>
);
const PageWin = (): ReactNode => (
	<PartialRoot>
		<WinA />
		<WinB />
	</PartialRoot>
);
const PageDeg = (): ReactNode => (
	<PartialRoot>
		<DegA />
	</PartialRoot>
);
const PageRec = (): ReactNode => (
	<PartialRoot>
		<RecA />
	</PartialRoot>
);
const PageLay = (): ReactNode => (
	<PartialRoot>
		<LayA />
	</PartialRoot>
);

beforeEach(() => {
	_clearInvalidationRegistry();
	for (const k of Object.keys(renders) as Array<keyof typeof renders>) {
		renders[k] = 0;
	}
});

afterEach(() => {
	clearRegistry("all");
	_clearInvalidationRegistry();
	_setUnackedDeliveryWindow();
	_setFirstAckDeadlineMs();
	_setReconcileIntervalMs();
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

const ackEnvelope = (
	connection: string,
	seq: number,
	delivered: number,
): ChannelEnvelope => ({
	connection,
	seq,
	frames: [{ kind: "ack", delivered }],
});

async function nextLane(
	iter: AsyncIterator<DemuxedLane>,
): Promise<DemuxedLane> {
	const step = await iter.next();
	if (step.done) throw new Error("expected another lane");
	return step.value;
}

const sleep = (ms: number): Promise<void> =>
	new Promise((r) => setTimeout(r, ms));

/** Poll until `check` passes — bounded, for wire bytes whose arrival
 *  has no client-side completion signal (framed entries surface as the
 *  demux reads them). */
async function until(check: () => boolean, label: string): Promise<void> {
	for (let i = 0; i < 100; i++) {
		if (check()) return;
		await sleep(10);
	}
	throw new Error(`timed out waiting for ${label}`);
}

describe("delivery seqs on the wire", () => {
	it("segments and lanes carry monotonic per-connection seqs; a lane's precedes its muxend", async () => {
		const scope = freshLiveScope("seq-order");
		await withLiveDrive(
			"http://localhost/seq?live=1",
			PageAB,
			scope,
			async (h) => {
				const seqEntries = (): string[] =>
					h.entries.filter((e) => e.tag === "seq").map((e) => e.body);
				const first = await h.segments.next();
				if (first.done || first.value.kind !== "payload")
					throw new Error("expected payload segment 0");
				await drainPayloadSegment(first.value);
				// Segment 0's seq entry precedes its Flight rows — by drain
				// time it has necessarily been read.
				expect(seqEntries()).toEqual(["1"]);

				const second = await h.segments.next();
				if (second.done || second.value.kind !== "lanes")
					throw new Error("expected lanes segment");
				const laneIter = second.value.lanes[Symbol.asyncIterator]();

				refreshSelector("ack-a");
				const laneA = await nextLane(laneIter);
				expect(laneA.partonId).toBe("ack-a");
				await decodeLane(laneA);
				// The lane's seq entry precedes its muxend — decode completes
				// only after the lane body closed, so the entry is here.
				expect(seqEntries()).toEqual(["1", "ack-a\n2"]);

				refreshSelector("ack-b");
				const laneB = await nextLane(laneIter);
				expect(laneB.partonId).toBe("ack-b");
				await decodeLane(laneB);
				expect(seqEntries()).toEqual(["1", "ack-a\n2", "ack-b\n3"]);

				await h.shutdown("ack-a");
			},
		);
	});
});

describe("the ack watermark + the acked mirror layer", () => {
	it("an ack folds covered deliveries into the acked layer, cumulatively", async () => {
		const session = _openConnectionSession("ack-unit", null);
		try {
			_recordDelivery(session, 1, [
				["a", "f1"],
				["b", "f2"],
			]);
			_recordDelivery(session, 2, [["a", "f3"]]);
			expect(session.pendingDeliveries.size).toBe(2);

			expect(await post(undefined, ackEnvelope("ack-unit", 1, 1))).toBe(204);
			expect(session.ackedDeliverySeq).toBe(1);
			expect(session.firstAckReceived).toBe(true);
			expect([...(session.ackedFps.get("a") ?? [])]).toEqual(["f1"]);
			expect([...(session.ackedFps.get("b") ?? [])]).toEqual(["f2"]);
			expect(session.pendingDeliveries.has(1)).toBe(false);
			expect(session.pendingDeliveries.has(2)).toBe(true);

			// Cumulative: a stale/duplicate ack is a no-op.
			expect(await post(undefined, ackEnvelope("ack-unit", 2, 1))).toBe(204);
			expect(session.ackedDeliverySeq).toBe(1);
			expect(session.pendingDeliveries.has(2)).toBe(true);

			// Advancing folds the rest.
			expect(await post(undefined, ackEnvelope("ack-unit", 3, 2))).toBe(204);
			expect(session.ackedDeliverySeq).toBe(2);
			expect([...(session.ackedFps.get("a") ?? [])]).toEqual(["f1", "f3"]);
			expect(session.pendingDeliveries.size).toBe(0);

			// A record for an already-acked seq (the ack raced the driver's
			// post-drain bookkeeping) folds immediately instead of pending
			// forever.
			_recordDelivery(session, 2, [["c", "f4"]]);
			expect(session.pendingDeliveries.size).toBe(0);
			expect([...(session.ackedFps.get("c") ?? [])]).toEqual(["f4"]);
		} finally {
			_closeConnectionSession("ack-unit");
		}
	});
});

describe("the applied marker + retransmit idempotence", () => {
	it("announces the applied watermark once per advance; a duplicate envelope converges via fp-skip", async () => {
		let conn = "";
		const scope = freshLiveScope("applied");
		await withLiveDrive(
			"http://localhost/applied?live=1",
			PageAB,
			scope,
			async (h) => {
				const appliedEntries = (): string[] =>
					h.entries.filter((e) => e.tag === "applied").map((e) => e.body);
				const first = await h.segments.next();
				if (first.done || first.value.kind !== "payload")
					throw new Error("expected payload segment 0");
				await drainPayloadSegment(first.value);
				conn = h.connectionId() ?? "";
				expect(conn).not.toBe("");

				const second = await h.segments.next();
				if (second.done || second.value.kind !== "lanes")
					throw new Error("expected lanes segment");
				const laneIter = second.value.lanes[Symbol.asyncIterator]();

				// An envelope applies (page-lifetime seq 5, e.g. after prior
				// connections consumed 1–4); its flip lanes — and the next
				// bytes carry the applied watermark.
				const flip: ChannelEnvelope = {
					connection: conn,
					seq: 5,
					frames: [
						{ kind: "visible", changed: ["ack-b"], visible: ["ack-b"] },
					],
				};
				expect(await post(scope, flip)).toBe(204);
				const lane1 = await nextLane(laneIter);
				expect(lane1.partonId).toBe("ack-b");
				// The optimistic layer alone decides — NO ack has ever been
				// received on this connection, yet the re-lane of unchanged
				// content is the placeholder (the body never re-runs; the
				// render counter is the wire-safe assertion — dev Flight row
				// labels collide with content substrings).
				expect((await decodeLane(lane1)).bodyText).toContain(
					'"data-partial-id":"ack-b"',
				);
				expect(renders.b).toBe(1);
				await until(
					() => appliedEntries().length === 1,
					"the applied marker",
				);
				expect(appliedEntries()).toEqual(["5"]);

				// The retransmit: byte-identical envelope, same seq. It
				// applies per statement semantics (the flip re-queues, its
				// re-lane fp-skips again), the session converges, and the
				// watermark does NOT re-announce.
				expect(await post(scope, flip)).toBe(204);
				const lane2 = await nextLane(laneIter);
				expect(lane2.partonId).toBe("ack-b");
				expect((await decodeLane(lane2)).bodyText).toContain(
					'"data-partial-id":"ack-b"',
				);
				expect(renders.b).toBe(1);
				const session = _peekConnectionSession(conn);
				expect(session?.appliedSeq).toBe(5);
				expect(session?.lastSeq).toBe(5);
				expect(appliedEntries()).toEqual(["5"]);

				await h.shutdown("ack-a");
			},
		);
	});

	it("the attach statement's applied watermark seeds the session's gate", async () => {
		const scope = freshLiveScope("applied-seed");
		await withLiveDrive(
			"http://localhost/seed?live=1",
			PageAB,
			scope,
			async (h) => {
				const appliedEntries = (): string[] =>
					h.entries.filter((e) => e.tag === "applied").map((e) => e.body);
				const first = await h.segments.next();
				if (first.done || first.value.kind !== "payload")
					throw new Error("expected payload segment 0");
				await drainPayloadSegment(first.value);
				const conn = h.connectionId() ?? "";
				const session = _peekConnectionSession(conn);
				expect(session?.appliedSeq).toBe(3);
				expect(session?.announcedAppliedSeq).toBe(3);

				const second = await h.segments.next();
				if (second.done || second.value.kind !== "lanes")
					throw new Error("expected lanes segment");
				void second.value.lanes[Symbol.asyncIterator]();

				// An envelope below the seed (a cross-connection retransmit)
				// still applies its statements — per-kind seq semantics, not
				// a whole-envelope replay gate — but the watermark never
				// regresses, so nothing announces below what the client heard.
				expect(
					await post(scope, {
						connection: conn,
						seq: 2,
						frames: [{ kind: "visible", changed: [], visible: ["ack-a"] }],
					}),
				).toBe(204);
				expect(session?.visible).toEqual(new Set(["ack-a"]));
				await sleep(50);
				expect(appliedEntries()).toEqual([]);
				expect(session?.appliedSeq).toBe(3);

				// Past the seed, the marker advances.
				expect(
					await post(scope, {
						connection: conn,
						seq: 4,
						frames: [{ kind: "visible", changed: [], visible: [] }],
					}),
				).toBe(204);
				await until(
					() => appliedEntries().length === 1,
					"the applied marker",
				);
				expect(appliedEntries()).toEqual(["4"]);

				await h.shutdown("ack-a");
			},
			// The reattaching client states the watermark it last heard —
			// the unknown-field-tolerant seam W2 pinned for exactly this.
			{ attach: { cached: [], since: null, visible: null, applied: 3 } },
		);
	}, 10_000);
});

describe("the unacked delivery window", () => {
	it("gates lane opening while exceeded; freed by an ack, dirty ids render their latest state once", async () => {
		// Window of ONE: the initial segment (delivery 1) fills it.
		_setUnackedDeliveryWindow(1);
		const scope = freshLiveScope("window");
		await withLiveDrive(
			"http://localhost/window?live=1",
			PageWin,
			scope,
			async (h) => {
				const first = await h.segments.next();
				if (first.done || first.value.kind !== "payload")
					throw new Error("expected payload segment 0");
				await drainPayloadSegment(first.value);
				const conn = h.connectionId() ?? "";
				expect(renders.win).toBe(1);
				expect(renders.wib).toBe(1);

				const second = await h.segments.next();
				if (second.done || second.value.kind !== "lanes")
					throw new Error("expected lanes segment");
				const laneIter = second.value.lanes[Symbol.asyncIterator]();

				// Three bumps while the window is full — spaced so the driver
				// processes each as its own wake (the claim is WINDOW
				// coalescing, not bump batching). Nothing lanes; nothing
				// renders.
				refreshSelector("win-a");
				await sleep(60);
				refreshSelector("win-a");
				await sleep(60);
				refreshSelector("win-b");
				await sleep(80);
				expect(renders.win).toBe(1);
				expect(renders.wib).toBe(1);

				// The ack frees the window: the coalesced ids render their
				// LATEST state — one render each, nothing dropped.
				expect(await post(scope, ackEnvelope(conn, 1, 1))).toBe(204);
				const laneA = await nextLane(laneIter);
				expect(laneA.partonId).toBe("win-a");
				expect((await decodeLane(laneA)).bodyText).toContain("win:2");
				const laneB = await nextLane(laneIter);
				expect(laneB.partonId).toBe("win-b");
				expect((await decodeLane(laneB)).bodyText).toContain("wib:2");
				expect(renders.win).toBe(2);
				expect(renders.wib).toBe(2);

				// Free the window before shutdown: the harness's teardown
				// detects the torn client at a lane's ENQUEUE, and a gated
				// window opens no lane to fail — the drive would otherwise
				// hold until the keepalive (the production bound for a
				// gated-and-torn connection).
				expect(await post(scope, ackEnvelope(conn, 2, 3))).toBe(204);
				await h.shutdown("win-a");
			},
		);
	}, 10_000);
});

describe("never-acked degrade", () => {
	it("closes after the first-ack deadline with the reason on the session", async () => {
		_setFirstAckDeadlineMs(150);
		const scope = freshLiveScope("degrade");
		await withLiveDrive(
			"http://localhost/degrade?live=1",
			PageDeg,
			scope,
			async (h) => {
				const first = await h.segments.next();
				if (first.done || first.value.kind !== "payload")
					throw new Error("expected payload segment 0");
				await drainPayloadSegment(first.value);
				const session = _peekConnectionSession(h.connectionId() ?? "");
				expect(session).toBeDefined();

				// The first delivery settled; no ack ever arrives. The driver
				// stops holding: the lanes region ends and the stream closes,
				// well inside the keepalive window.
				const second = await h.segments.next();
				if (second.done || second.value.kind !== "lanes")
					throw new Error("expected lanes segment");
				const laneIter = second.value.lanes[Symbol.asyncIterator]();
				expect((await laneIter.next()).done).toBe(true);
				expect((await h.segments.next()).done).toBe(true);
				expect(session?.degradedReason).toBe("never-acked");

				await h.shutdown("deg-a");
			},
		);
	});

	it("an acking client is NEVER degraded — any ack frame is the duplex proof", async () => {
		_setFirstAckDeadlineMs(120);
		const scope = freshLiveScope("no-degrade");
		await withLiveDrive(
			"http://localhost/no-degrade?live=1",
			PageDeg,
			scope,
			async (h) => {
				const first = await h.segments.next();
				if (first.done || first.value.kind !== "payload")
					throw new Error("expected payload segment 0");
				await drainPayloadSegment(first.value);
				const conn = h.connectionId() ?? "";
				const session = _peekConnectionSession(conn);
				expect(await post(scope, ackEnvelope(conn, 1, 1))).toBe(204);

				const second = await h.segments.next();
				if (second.done || second.value.kind !== "lanes")
					throw new Error("expected lanes segment");
				const laneIter = second.value.lanes[Symbol.asyncIterator]();

				// Well past the deadline the connection still serves lanes.
				await sleep(300);
				refreshSelector("deg-a");
				const lane = await nextLane(laneIter);
				expect(lane.partonId).toBe("deg-a");
				expect((await decodeLane(lane)).bodyText).toContain("deg:2");
				expect(session?.degradedReason).toBeNull();

				await h.shutdown("deg-a");
			},
		);
	});
});

describe("the whole-tree reconcile", () => {
	it("past the cadence, the next wake emits a full payload segment and reopens the lanes region", async () => {
		_setReconcileIntervalMs(80);
		const scope = freshLiveScope("reconcile");
		await withLiveDrive(
			"http://localhost/reconcile?live=1",
			PageRec,
			scope,
			async (h) => {
				const first = await h.segments.next();
				if (first.done || first.value.kind !== "payload")
					throw new Error("expected payload segment 0");
				expect(await drainPayloadSegment(first.value)).toContain("rec:1");

				const second = await h.segments.next();
				if (second.done || second.value.kind !== "lanes")
					throw new Error("expected lanes segment");
				const laneIter = second.value.lanes[Symbol.asyncIterator]();

				// Let the cadence lapse (no wakes — nothing emits), then wake
				// with a bump: the reconcile runs FIRST and subsumes the
				// bump's change — the whole-tree segment carries the fresh
				// body, and no separate lane renders it again.
				await sleep(120);
				refreshSelector("rec-a");
				expect((await laneIter.next()).done).toBe(true);
				const third = await h.segments.next();
				if (third.done || third.value.kind !== "payload")
					throw new Error("expected the reconcile payload segment");
				const reconcile = await drainPayloadSegment(third.value);
				expect(reconcile).toContain("rec:2");
				expect(renders.rec).toBe(2);
				// The reconcile is a delivery like any other emission.
				expect(
					h.entries.filter((e) => e.tag === "seq").map((e) => e.body),
				).toEqual(["1", "2"]);

				// The lanes region reopens; later wakes lane as usual.
				const fourth = await h.segments.next();
				if (fourth.done || fourth.value.kind !== "lanes")
					throw new Error("expected the reopened lanes region");
				const laneIter2 = fourth.value.lanes[Symbol.asyncIterator]();
				refreshSelector("rec-a");
				const lane = await nextLane(laneIter2);
				expect(lane.partonId).toBe("rec-a");
				expect((await decodeLane(lane)).bodyText).toContain("rec:3");

				await h.shutdown("rec-a");
			},
		);
	}, 10_000);
});

describe("mirror layering", () => {
	it("a flip statement's cached tokens supersede the ACKED layer — no phantom confirms", async () => {
		const scope = freshLiveScope("layering");
		await withLiveDrive(
			"http://localhost/layering?live=1",
			PageLay,
			scope,
			async (h) => {
				const first = await h.segments.next();
				if (first.done || first.value.kind !== "payload")
					throw new Error("expected payload segment 0");
				await drainPayloadSegment(first.value);
				const conn = h.connectionId() ?? "";
				const session = _peekConnectionSession(conn);

				// The client commits delivery 1 — its fps become ACKED
				// holdings (the real fold).
				expect(await post(scope, ackEnvelope(conn, 1, 1))).toBe(204);
				await until(
					() => (session?.ackedFps.get("lay-a")?.size ?? 0) > 0,
					"the acked fold",
				);

				const second = await h.segments.next();
				if (second.done || second.value.kind !== "lanes")
					throw new Error("expected lanes segment");
				const laneIter = second.value.lanes[Symbol.asyncIterator]();

				// The flip states EMPTY holdings ("I hold nothing for this
				// id") — the eviction evidence. It must supersede BOTH mirror
				// layers: were the acked fp to survive, the verdict would
				// confirm a phantom copy (zero bytes for content the client
				// dropped). The lane must re-render.
				expect(
					await post(scope, {
						connection: conn,
						seq: 2,
						frames: [
							{
								kind: "visible",
								changed: ["lay-a"],
								visible: ["lay-a"],
								cached: [],
							},
						],
					}),
				).toBe(204);
				const lane = await nextLane(laneIter);
				expect(lane.partonId).toBe("lay-a");
				expect((await decodeLane(lane)).bodyText).toContain("lay:2");
				expect(renders.lay).toBe(2);
				expect(session?.ackedFps.get("lay-a")?.size ?? 0).toBe(0);

				await h.shutdown("lay-a");
			},
		);
	});

	it("the verdict falls back to the acked layer on an optimistic miss", async () => {
		// Render once to commit the parton's snapshot and learn the fp it
		// emits (a static leaf's fp is stable across renders).
		const scope = freshLiveScope("acked-verdict");
		const url = "http://localhost/acked-verdict";
		const page = (): ReactNode => (
			<PartialRoot>
				<IsoA />
			</PartialRoot>
		);
		const render = async (
			ackedFps: Map<string, Set<string>> | null,
		): Promise<string> => {
			const request = new Request(url, {
				headers: { "x-test-scope": scope },
			});
			const { result } = await runWithRequestAsync(request, async () => {
				// A connection session whose acked layer holds the fp — the
				// shape the ack fold produces (proven above); the optimistic
				// layer stays EMPTY (no ?cached=, nothing promoted yet).
				if (ackedFps) {
					_setConnectionSession({ visible: null, ackedFps });
				}
				const stream = renderServerToFlight(page());
				const [forCaller, forDrain] = stream.tee();
				await new Response(forDrain).arrayBuffer();
				return forCaller;
			});
			return await new Response(result).text();
		};

		const cold = await render(null);
		expect(cold).toContain("iso:1");
		const fpMatch = cold.match(
			/"partialId":"iso-a","partialFingerprint":"([^"]+)"/,
		);
		expect(fpMatch).not.toBeNull();
		const fp = fpMatch?.[1] ?? "";

		// Optimistic miss + acked miss → renders.
		const missed = await render(new Map([["iso-a", new Set(["other"])]]));
		expect(missed).toContain("iso:2");

		// Optimistic miss + acked hit → the zero-byte placeholder; the
		// body never runs.
		const skipped = await render(new Map([["iso-a", new Set([fp])]]));
		expect(skipped).not.toContain("iso:");
		expect(skipped).toContain('"data-partial-id":"iso-a"');
		expect(renders.iso).toBe(2);
	});
});
