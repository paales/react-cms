/**
 * Connection-session visibility — flips ride the OPEN live connection.
 *
 * The client's visibility controller states viewport flips as
 * `visible` frames on channel envelopes (`POST /__parton/channel`),
 * addressed to the live connection's explicit id; the segment driver
 * stores the set as connection-session state and treats each statement
 * like an invalidation wake, rendering the flipped-IN partons as lanes
 * on the EXISTING stream with the cull gate reading the session's
 * CURRENT set.
 *
 * The claims under test:
 *   1. the `?visible=` seed on the `?live=1` request drives the
 *      whole-tree first segment (no cold-seed clobber): out-of-set
 *      partons emit the pair (body skipped), in-set ones render;
 *   2. a `visible` frame wakes a lane for EXACTLY the flipped-IN
 *      parton, rendered against the stated set — untouched siblings
 *      never re-render, and a cull-OUT lanes NOTHING (the client swaps
 *      to its inline skeleton locally; the statement's only server
 *      effect is the session-set update that keeps lane parking
 *      honest);
 *   3. a flip cycle (in → out → in) settles the returning state with
 *      fp-skip semantics: the content fp is unchanged, so cycling back
 *      answers with the zero-byte confirmation placeholder — the body
 *      never re-runs for content the client provably holds;
 *   4. a flip whose parton has no route snapshot yet (the statement
 *      raced the render that first materializes it) is DEFERRED, not
 *      dropped — it resolves into a lane on a later wake once the
 *      snapshot lands;
 *   5. session lifecycle — an envelope for a connection that was never
 *      opened, or whose drive loop has exited, answers `404` (the
 *      client's explicit fall-back-to-reload signal);
 *   6. envelope ordering — a stale envelope (older seq) can't regress
 *      the set or overwrite a newer pending statement; its flips still
 *      queue, each carrying its own frame's statement;
 *   7. PARKED partons don't lane — a bump touching a parton outside
 *      the session's measured visible set renders nothing, and a
 *      culled parton has NO wake surface at all (its snapshot records
 *      the gate's reads only: no cell labels, no expires deadline);
 *      the flip-in revalidation re-renders the returning state fresh,
 *      folding everything that landed while parked;
 *   8. a pure SYNC statement (`changed: []` — the client's
 *      measurement passenger riding a driven envelope) updates the
 *      session set WITHOUT laning anything: later wakes park and
 *      unpark against the synced set (the parking honesty the
 *      passenger cadence relies on);
 *   9. flip resolution is PER-STATEMENT — each pending flip resolves
 *      against its own frame's statement (the id's presence in THAT
 *      frame's `visible` snapshot), never against a later frame's
 *      snapshot: a mid-scroll burst legitimately dips the snapshot
 *      while an earlier in-flip is still pending, and the client
 *      states each flip exactly once, so resolving it against the
 *      dip would drop it forever. Only an explicit later statement
 *      about the SAME id can turn a pending in-flip out (last
 *      statement wins, ordered by seq).
 */

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	_clearInvalidationRegistry,
	refreshSelector,
} from "../../runtime/invalidation-registry.ts";
import { runWithRequestAsync } from "../../runtime/context.ts";
import {
	decodeLane,
	drainPayloadSegment,
	freshLiveScope,
	withLiveDrive,
} from "../../test/live-drive.tsx";
import { CHANNEL_ENDPOINT, type ChannelEnvelope } from "../channel-protocol.ts";
import {
	_closeConnectionSession,
	_openConnectionSession,
	handleChannelPost,
	reportConnectionVisibility,
	takeConnectionFlips,
} from "../connection-session.ts";
import type { DemuxedLane } from "../fp-trailer-split.ts";
import { PartialRoot, parton, type RenderArgs } from "../partial.tsx";
import { clearRegistry } from "../partial-registry.ts";
import { expires, time } from "../server-hooks.ts";
import { SkelBox } from "./cull-skeleton-fixture.tsx";

// Module-scope render counters — bumped every time a Render body runs.
// Under the gate a culled parton's body NEVER runs, so these count
// content renders exactly.
const renders = { a: 0, b: 0 };

const CullA = parton(
	function CullARender(_: RenderArgs) {
		renders.a++;
		return <div data-a>{`a:full:${renders.a}`}</div>;
	},
	{ selector: "cull-a", cull: { skeleton: SkelBox } },
);

const CullB = parton(
	function CullBRender(_: RenderArgs) {
		renders.b++;
		return <div data-b>{`b:full:${renders.b}`}</div>;
	},
	{ selector: "cull-b", cull: { skeleton: SkelBox } },
);

function Page(): ReactNode {
	return (
		<PartialRoot>
			<CullA />
			<CullB />
		</PartialRoot>
	);
}

// Live-data cullable for the parked-wake probe: an `expires()` boundary
// over the content body. The culled snapshot records the gate's reads
// only — no deadline, no cell labels — so a parked parton has no wake
// surface at all.
const renders3 = { pulse: 0 };
const CullPulse = parton(
	function CullPulseRender(_: RenderArgs) {
		renders3.pulse++;
		expires(time().in(120));
		return <div data-pulse>{`pulse:full:${renders3.pulse}`}</div>;
	},
	{ selector: "cull-pulse", cull: { skeleton: SkelBox } },
);

// Parent/child pair for the deferral probe: the child only exists in
// the tree while the parent is in view, so its FIRST snapshot is
// created by the parent's flip-in lane — the render a same-batch child
// flip races.
const CullChildLate = parton(
	function CullChildLateRender(_: RenderArgs) {
		return <div data-child>child:full</div>;
	},
	{ selector: "cull-child-late", cull: { skeleton: SkelBox } },
);

const CullParent = parton(
	function CullParentRender(_: RenderArgs) {
		return (
			<div data-parent>
				parent-full
				<CullChildLate />
			</div>
		);
	},
	{ selector: "cull-parent", cull: { skeleton: SkelBox } },
);

function NestedPage(): ReactNode {
	return (
		<PartialRoot>
			<CullParent />
		</PartialRoot>
	);
}

beforeEach(() => {
	_clearInvalidationRegistry();
	renders.a = 0;
	renders.b = 0;
	renders3.pulse = 0;
});

afterEach(() => {
	clearRegistry("all");
	_clearInvalidationRegistry();
});

async function nextLane(
	iter: AsyncIterator<DemuxedLane>,
): Promise<DemuxedLane> {
	const step = await iter.next();
	if (step.done) throw new Error("expected another lane");
	return step.value;
}

/** POST one `visible` frame through the channel endpoint, the way the
 *  client transport delivers it — a full envelope through the request
 *  scope the entry wraps around `handleChannelPost`. Returns the HTTP
 *  status (`204` applied, `404` connection gone). `scope` mirrors the
 *  drive's own — beacons carry the same `x-test-scope` the page's
 *  requests do (Playwright stamps the browser context). */
async function postVisible(
	scope: string | undefined,
	connection: string,
	seq: number,
	changed: string[],
	visible: string[],
	cached?: string[],
): Promise<number> {
	const envelope: ChannelEnvelope = {
		connection,
		seq,
		frames: [
			{
				kind: "visible",
				changed,
				visible,
				...(cached !== undefined ? { cached } : {}),
			},
		],
	};
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

describe("connection-session visibility", () => {
	it("the ?visible= seed drives the first segment; in-flips lane, out-flips don't", async () => {
		let conn = "";
		const scope = freshLiveScope("conn-vis");
		await withLiveDrive(
			`http://localhost/world?live=1&visible=cull-a`,
			Page,
			scope,
			async (h) => {
				// Segment 0: whole tree, rendered against the SEEDED set — a is
				// in (body renders), b is out (body SKIPPED: the pair ships with
				// the skeleton reference, zero body bytes, zero body runs).
				const first = await h.segments.next();
				if (first.done || first.value.kind !== "payload")
					throw new Error("expected payload segment 0");
				const seg0 = await drainPayloadSegment(first.value);
				conn = h.connectionId() ?? "";
				expect(conn).not.toBe("");
				expect(seg0).toContain("a:full:1");
				expect(seg0).not.toContain("b:full");
				expect(seg0).toContain('"id":"cull-b"');
				expect(seg0).toContain('"culled":true');
				expect(renders.b).toBe(0);

				// Flip b IN. The driver must answer with a lane for cull-b only,
				// rendered against the updated session set.
				expect(
					await postVisible(scope, conn, 1, ["cull-b"], ["cull-a", "cull-b"]),
				).toBe(204);
				const second = await h.segments.next();
				if (second.done || second.value.kind !== "lanes")
					throw new Error("expected lanes segment");
				const laneIter = second.value.lanes[Symbol.asyncIterator]();

				const laneIn = await nextLane(laneIter);
				expect(laneIn.partonId).toBe("cull-b");
				expect((await decodeLane(laneIn)).bodyText).toContain("b:full:1");
				// The sibling never re-ran — the statement named only cull-b.
				expect(renders.a).toBe(1);

				// Flip b OUT: NOTHING lanes — the client already swapped to its
				// inline skeleton; the statement's server effect is the
				// session-set update alone. Prove it by bumping a next: the next
				// lane on the wire is a's, and b's body never re-ran.
				expect(await postVisible(scope, conn, 2, ["cull-b"], ["cull-a"])).toBe(
					204,
				);
				refreshSelector("cull-a");
				const laneA = await nextLane(laneIter);
				expect(laneA.partonId).toBe("cull-a");
				expect((await decodeLane(laneA)).bodyText).toContain("a:full:2");
				expect(renders.b).toBe(1);

				// …and back IN. The content fp b cycles back to is byte-identical
				// to the one its flip-in emitted, so the lane answers with the
				// confirmation placeholder instead of re-running the body. The
				// confirm marker is what re-arms the restored fiber as a live
				// instance client-side.
				expect(
					await postVisible(scope, conn, 3, ["cull-b"], ["cull-a", "cull-b"]),
				).toBe(204);
				const laneBack = await nextLane(laneIter);
				expect(laneBack.partonId).toBe("cull-b");
				const backBody = (await decodeLane(laneBack)).bodyText;
				expect(backBody).not.toContain("b:full");
				expect(backBody).toContain('"data-partial-id":"cull-b"');
				expect(backBody).toContain('"data-partial-confirm":true');
				expect(renders.b).toBe(1);
				expect(renders.a).toBe(2);

				await h.shutdown("cull-b");
			},
		);
		// The drive loop exited — the session is closed, so a late envelope
		// answers 404 (the client falls back to the render-reload path).
		expect(await postVisible(scope, conn, 4, ["cull-b"], [])).toBe(404);
	});

	it("a flip for an id the route never rendered defers without disturbing the stream", async () => {
		let conn = "";
		const scope = freshLiveScope("conn-vis");
		await withLiveDrive(
			`http://localhost/world?live=1&visible=`,
			Page,
			scope,
			async (h) => {
				const first = await h.segments.next();
				if (first.done || first.value.kind !== "payload")
					throw new Error("expected payload segment 0");
				const seg0 = await drainPayloadSegment(first.value);
				conn = h.connectionId() ?? "";
				expect(conn).not.toBe("");
				// An EMPTY seed is a measurement too — everything out, no body
				// runs anywhere.
				expect(seg0).not.toContain("a:full");
				expect(seg0).not.toContain("b:full");
				expect(renders.a).toBe(0);
				expect(renders.b).toBe(0);

				// A statement naming an unknown id must not open a lane (it
				// stays deferred); the next real flip still lanes normally on
				// the same connection.
				expect(
					await postVisible(
						scope,
						conn,
						1,
						["not-on-this-route"],
						["not-on-this-route"],
					),
				).toBe(204);
				expect(
					await postVisible(
						scope,
						conn,
						2,
						["cull-a"],
						["cull-a", "not-on-this-route"],
					),
				).toBe(204);
				const second = await h.segments.next();
				if (second.done || second.value.kind !== "lanes")
					throw new Error("expected lanes segment");
				const laneIter = second.value.lanes[Symbol.asyncIterator]();
				const lane = await nextLane(laneIter);
				expect(lane.partonId).toBe("cull-a");
				expect((await decodeLane(lane)).bodyText).toContain("a:full:1");

				await h.shutdown("cull-a");
			},
		);
	});

	it("a flip racing the render that first materializes its parton defers, then lanes once the snapshot lands", async () => {
		let conn = "";
		const scope = freshLiveScope("conn-vis");
		await withLiveDrive(
			`http://localhost/world?live=1&visible=`,
			NestedPage,
			scope,
			async (h) => {
				const first = await h.segments.next();
				if (first.done || first.value.kind !== "payload")
					throw new Error("expected payload segment 0");
				const seg0 = await drainPayloadSegment(first.value);
				conn = h.connectionId() ?? "";
				expect(conn).not.toBe("");
				// Parent culled out → the child never rendered: no snapshot for
				// it exists anywhere yet.
				expect(seg0).not.toContain("parent-full");
				expect(seg0).not.toContain("child:");

				// One statement flips parent AND child in — the child's flip
				// races the very render (the parent's lane) that will
				// materialize it.
				expect(
					await postVisible(
						scope,
						conn,
						1,
						["cull-parent", "cull-child-late"],
						["cull-parent", "cull-child-late"],
					),
				).toBe(204);
				const second = await h.segments.next();
				if (second.done || second.value.kind !== "lanes")
					throw new Error("expected lanes segment");
				const laneIter = second.value.lanes[Symbol.asyncIterator]();

				// The parent lanes immediately (it has a snapshot); its body
				// materializes the child, whose gate reads the session set → in
				// view → the child renders too.
				const parentLane = await nextLane(laneIter);
				expect(parentLane.partonId).toBe("cull-parent");
				const parentBody = (await decodeLane(parentLane)).bodyText;
				expect(parentBody).toContain("parent-full");
				expect(parentBody).toContain("child:full");

				// The child's flip was deferred, not dropped: the parent lane's
				// drain is a wake, the child's snapshot now exists, and the
				// deferred flip resolves into the child's own lane. The parent's
				// materializing render already read the current set, so the
				// child's fp matches its just-promoted entry and the lane is the
				// cheap confirmation placeholder — fp-skip as the precise
				// stale-detector.
				const childLane = await nextLane(laneIter);
				expect(childLane.partonId).toBe("cull-child-late");
				const childBody = (await decodeLane(childLane)).bodyText;
				expect(childBody).toContain('"data-partial-id":"cull-child-late"');
				expect(childBody).toContain('"data-partial-confirm":true');

				await h.shutdown("cull-parent");
			},
		);
	});

	it("a pure sync statement (changed: []) aligns the set without laning", async () => {
		let conn = "";
		const scope = freshLiveScope("conn-vis");
		await withLiveDrive(
			`http://localhost/world?live=1&visible=cull-a`,
			Page,
			scope,
			async (h) => {
				const first = await h.segments.next();
				if (first.done || first.value.kind !== "payload")
					throw new Error("expected payload segment 0");
				const seg0 = await drainPayloadSegment(first.value);
				conn = h.connectionId() ?? "";
				expect(conn).not.toBe("");
				expect(seg0).toContain("a:full:1");
				expect(renders.b).toBe(0);

				// The sync: no flips, just the client's full measured set —
				// the shape a measurement passenger contributes when another
				// statement drives the envelope. It must lane NOTHING at
				// statement time: the next lane on the wire is a's bump.
				expect(
					await postVisible(scope, conn, 1, [], ["cull-a", "cull-b"]),
				).toBe(204);
				refreshSelector("cull-a");
				const second = await h.segments.next();
				if (second.done || second.value.kind !== "lanes")
					throw new Error("expected lanes segment");
				const laneIter = second.value.lanes[Symbol.asyncIterator]();
				const laneA = await nextLane(laneIter);
				expect(laneA.partonId).toBe("cull-a");
				expect(renders.b).toBe(0);

				// …but the SET took the statement: b is unparked, so a bump
				// now lanes it — the parking honesty the sync exists for.
				refreshSelector("cull-b");
				const laneB = await nextLane(laneIter);
				expect(laneB.partonId).toBe("cull-b");
				expect((await decodeLane(laneB)).bodyText).toContain("b:full:1");

				await h.shutdown("cull-b");
			},
		);
	});

	it("an in-flip resolves against its OWN frame's statement, not a later frame's snapshot dip", async () => {
		let conn = "";
		const scope = freshLiveScope("conn-vis");
		await withLiveDrive(
			`http://localhost/world?live=1&visible=cull-a`,
			Page,
			scope,
			async (h) => {
				const first = await h.segments.next();
				if (first.done || first.value.kind !== "payload")
					throw new Error("expected payload segment 0");
				const seg0 = await drainPayloadSegment(first.value);
				conn = h.connectionId() ?? "";
				expect(conn).not.toBe("");
				expect(seg0).toContain("a:full:1");
				expect(renders.b).toBe(0);

				// The burst: envelope 1 flips b IN (its snapshot holds b);
				// envelope 2 lands before the driver drains — a exits, and the
				// snapshot DIPS below b too (its node is mid-swap client-side)
				// WITHOUT an out-flip for b in `changed`. b's pending in-flip
				// must resolve against envelope 1's statement and lane; the
				// client states each flip exactly once, so resolving it against
				// envelope 2's snapshot would drop it forever.
				expect(
					await postVisible(scope, conn, 1, ["cull-b"], ["cull-a", "cull-b"]),
				).toBe(204);
				expect(await postVisible(scope, conn, 2, ["cull-a"], [])).toBe(204);

				const second = await h.segments.next();
				if (second.done || second.value.kind !== "lanes")
					throw new Error("expected lanes segment");
				const laneIter = second.value.lanes[Symbol.asyncIterator]();
				const laneIn = await nextLane(laneIter);
				expect(laneIn.partonId).toBe("cull-b");
				expect((await decodeLane(laneIn)).bodyText).toContain("b:full:1");
				// a's out-flip laned nothing — its cull completed client-side.
				expect(renders.a).toBe(1);

				// The SET itself still took envelope 2's snapshot wholesale: a
				// re-enters via an explicit flip-in, and the driver answers
				// with a's lane.
				expect(
					await postVisible(scope, conn, 3, ["cull-a"], ["cull-a", "cull-b"]),
				).toBe(204);
				const laneA = await nextLane(laneIter);
				expect(laneA.partonId).toBe("cull-a");

				await h.shutdown("cull-b");
			},
		);
	});

	it("a later out-flip statement wins over the same id's earlier pending in-flip", async () => {
		let conn = "";
		const scope = freshLiveScope("conn-vis");
		await withLiveDrive(
			`http://localhost/world?live=1&visible=cull-a`,
			Page,
			scope,
			async (h) => {
				const first = await h.segments.next();
				if (first.done || first.value.kind !== "payload")
					throw new Error("expected payload segment 0");
				await drainPayloadSegment(first.value);
				conn = h.connectionId() ?? "";
				expect(conn).not.toBe("");
				expect(renders.b).toBe(0);

				// The burst: b flips in (seq 1), then explicitly OUT again
				// (seq 2) before the driver drains. The last statement about b
				// wins — nothing lanes for it, its body never runs. The bump
				// on a provides the positive signal: the next lane on the wire
				// is a's. Applied at the session level, not through the
				// endpoint: the claim requires BOTH statements standing before
				// the drain, and only a synchronous apply pins that ordering
				// against the concurrently-parked driver (the endpoint's
				// envelope→session parity is the endpoint suite's claim; the
				// client transport coalesces a same-tick burst into one
				// envelope anyway).
				expect(
					reportConnectionVisibility(conn, 1, ["cull-b"], ["cull-a", "cull-b"]),
				).toBe(true);
				expect(
					reportConnectionVisibility(conn, 2, ["cull-b"], ["cull-a"]),
				).toBe(true);
				refreshSelector("cull-a");

				const second = await h.segments.next();
				if (second.done || second.value.kind !== "lanes")
					throw new Error("expected lanes segment");
				const laneIter = second.value.lanes[Symbol.asyncIterator]();
				const laneA = await nextLane(laneIter);
				expect(laneA.partonId).toBe("cull-a");
				expect((await decodeLane(laneA)).bodyText).toContain("a:full:2");
				expect(renders.b).toBe(0);

				await h.shutdown("cull-a");
			},
		);
	});

	it("a deferred in-flip is cancelled by a later frame's explicit out-flip", async () => {
		let conn = "";
		const scope = freshLiveScope("conn-vis");
		await withLiveDrive(
			`http://localhost/world?live=1&visible=`,
			NestedPage,
			scope,
			async (h) => {
				const first = await h.segments.next();
				if (first.done || first.value.kind !== "payload")
					throw new Error("expected payload segment 0");
				await drainPayloadSegment(first.value);
				conn = h.connectionId() ?? "";
				expect(conn).not.toBe("");

				// The child flips in while it has no snapshot (parent culled →
				// it never rendered) — the flip defers. Then an explicit
				// out-flip lands for it: the deferred in-flip must cancel.
				expect(
					await postVisible(
						scope,
						conn,
						1,
						["cull-child-late"],
						["cull-child-late"],
					),
				).toBe(204);
				expect(await postVisible(scope, conn, 2, ["cull-child-late"], [])).toBe(
					204,
				);

				// The parent's flip-in materializes the child's snapshot (as a
				// culled pair — the session set holds only the parent). If the
				// cancelled flip survived, it would resolve on this lane's
				// drain and the child would lane next; instead the next lane
				// is the parent's bump.
				expect(
					await postVisible(scope, conn, 3, ["cull-parent"], ["cull-parent"]),
				).toBe(204);
				const second = await h.segments.next();
				if (second.done || second.value.kind !== "lanes")
					throw new Error("expected lanes segment");
				const laneIter = second.value.lanes[Symbol.asyncIterator]();
				const parentLane = await nextLane(laneIter);
				expect(parentLane.partonId).toBe("cull-parent");
				expect((await decodeLane(parentLane)).bodyText).toContain("parent-full");

				refreshSelector("cull-parent");
				const nextUp = await nextLane(laneIter);
				expect(nextUp.partonId).toBe("cull-parent");

				await h.shutdown("cull-parent");
			},
		);
	});

	it("an envelope for a connection that was never opened answers 404", async () => {
		expect(await postVisible(undefined, "never-opened", 1, ["x"], ["x"])).toBe(
			404,
		);
	});

	it("a stale envelope (older seq) cannot regress the set, but its flips still queue", async () => {
		const session = _openConnectionSession("conn-vis-seq", null);
		try {
			expect(await postVisible(undefined, "conn-vis-seq", 2, ["x"], ["x"])).toBe(
				204,
			);
			// Older seq arrives late: the set stays at seq 2's value…
			expect(await postVisible(undefined, "conn-vis-seq", 1, ["y"], [])).toBe(
				204,
			);
			expect(session.visible).toEqual(new Set(["x"]));
			// …but the flip queued — y still gets drained, carrying its own
			// frame's statement (out: y was absent from that snapshot).
			const flips = takeConnectionFlips(session);
			expect([...flips.keys()]).toEqual(["x", "y"]);
			expect(flips.get("x")).toMatchObject({ inView: true, seq: 2 });
			expect(flips.get("y")).toMatchObject({ inView: false, seq: 1 });
			// The drain re-armed: nothing pending until the next statement.
			expect(session.pendingFlips.size).toBe(0);
		} finally {
			_closeConnectionSession("conn-vis-seq");
		}
	});

	it("a stale late envelope cannot overwrite a newer pending statement about the same id", async () => {
		const session = _openConnectionSession("conn-vis-stmt", null);
		try {
			// Newest statement lands first (in), then an older out arrives
			// late — the pending statement keeps the newer testimony.
			expect(
				await postVisible(undefined, "conn-vis-stmt", 2, ["x"], ["x"]),
			).toBe(204);
			expect(await postVisible(undefined, "conn-vis-stmt", 1, ["x"], [])).toBe(
				204,
			);
			const flips = takeConnectionFlips(session);
			expect(flips.get("x")).toMatchObject({ inView: true, seq: 2 });
		} finally {
			_closeConnectionSession("conn-vis-stmt");
		}
	});

	it("a bump touching a PARKED parton doesn't lane; the flip-in re-renders it fresh", async () => {
		let conn = "";
		const scope = freshLiveScope("conn-vis");
		await withLiveDrive(
			`http://localhost/world?live=1&visible=cull-a,cull-b`,
			Page,
			scope,
			async (h) => {
				const first = await h.segments.next();
				if (first.done || first.value.kind !== "payload")
					throw new Error("expected payload segment 0");
				const seg0 = await drainPayloadSegment(first.value);
				conn = h.connectionId() ?? "";
				expect(conn).not.toBe("");
				expect(seg0).toContain("a:full:1");
				expect(seg0).toContain("b:full:1");

				// Park b (flip it out) — no lane; the client's swap is local.
				expect(await postVisible(scope, conn, 1, ["cull-b"], ["cull-a"])).toBe(
					204,
				);

				// Bump parked b, then visible a. b must NOT lane — the next lane
				// on the wire is a's.
				refreshSelector("cull-b");
				refreshSelector("cull-a");
				const second = await h.segments.next();
				if (second.done || second.value.kind !== "lanes")
					throw new Error("expected lanes segment");
				const laneIter = second.value.lanes[Symbol.asyncIterator]();
				const laneA = await nextLane(laneIter);
				expect(laneA.partonId).toBe("cull-a");
				expect((await decodeLane(laneA)).bodyText).toContain("a:full:2");
				expect(renders.b).toBe(1);

				// Flip b back in: the returning state's fp folds the bump that
				// landed while parked, so the lane re-renders fresh — the
				// catch-up — instead of confirming the stale parked copy.
				expect(
					await postVisible(scope, conn, 2, ["cull-b"], ["cull-a", "cull-b"]),
				).toBe(204);
				const laneIn = await nextLane(laneIter);
				expect(laneIn.partonId).toBe("cull-b");
				expect((await decodeLane(laneIn)).bodyText).toContain("b:full:2");

				await h.shutdown("cull-b");
			},
		);
	});

	it("a parked parton has no wake surface: its expires() deadline neither lanes nor hot-spins", async () => {
		let conn = "";
		const scope = freshLiveScope("conn-vis");
		await withLiveDrive(
			`http://localhost/pulse?live=1&visible=cull-pulse`,
			() => (
				<PartialRoot>
					<CullPulse />
				</PartialRoot>
			),
			scope,
			async (h) => {
				const first = await h.segments.next();
				if (first.done || first.value.kind !== "payload")
					throw new Error("expected payload segment 0");
				expect(await drainPayloadSegment(first.value)).toContain(
					"pulse:full:1",
				);
				conn = h.connectionId() ?? "";
				expect(conn).not.toBe("");

				// The declared boundary drives a lane while visible.
				const second = await h.segments.next();
				if (second.done || second.value.kind !== "lanes")
					throw new Error("expected lanes segment");
				const laneIter = second.value.lanes[Symbol.asyncIterator]();
				const tick = await nextLane(laneIter);
				expect(tick.partonId).toBe("cull-pulse");
				expect((await decodeLane(tick)).bodyText).toContain("pulse:full:2");

				// Park it: no out-lane, and the culled snapshot carries NO
				// deadline (the gate records only its own reads) — so while
				// parked, nothing lanes and nothing hot-spins the wake loop.
				expect(await postVisible(scope, conn, 1, ["cull-pulse"], [])).toBe(204);
				await new Promise((r) => setTimeout(r, 350));
				expect(renders3.pulse).toBe(2);

				// Flip-in catches up (the content snapshot's deadline elapsed
				// while parked → fp-skip declines) and re-arms the boundary.
				expect(
					await postVisible(scope, conn, 2, ["cull-pulse"], ["cull-pulse"]),
				).toBe(204);
				const laneIn = await nextLane(laneIter);
				expect((await decodeLane(laneIn)).bodyText).toContain("pulse:full:3");

				await h.shutdown("cull-pulse");
			},
		);
	});
});
