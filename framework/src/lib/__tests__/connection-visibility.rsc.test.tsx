/**
 * Connection-session visibility — flips ride the OPEN live connection.
 *
 * The client's visibility controller reports viewport flips as
 * fire-and-forget POSTs addressed to the live connection's explicit
 * `__conn` id; the segment driver stores the set as connection-session
 * state and treats each report like an invalidation wake, rendering the
 * flipped partons as lanes on the EXISTING stream with `visible()`
 * reading the session's CURRENT set.
 *
 * The claims under test:
 *   1. the `?visible=` seed on the `?live=1` request drives the
 *      whole-tree first segment (no cold-anchor clobber);
 *   2. a report wakes a lane for EXACTLY the flipped parton, rendered
 *      against the reported set — untouched siblings never re-render;
 *   3. a flip cycle (in → out → in) re-renders every time: the fp a
 *      visibility flip cycles back to must not fp-skip against the
 *      cached override's pre-flip entry;
 *   4. a flip whose parton has no route snapshot yet (the report raced
 *      the render that first materializes it) is DEFERRED, not dropped —
 *      it resolves into a lane on a later wake once the snapshot lands;
 *   5. session lifecycle — a report for a connection that was never
 *      opened, or whose drive loop has exited, is refused (the client's
 *      explicit fall-back-to-reload signal), and the endpoint handler
 *      maps apply/refuse/malformed to 204/404/400;
 *   6. report ordering — a stale report (older seq) can't regress the
 *      set, but its flips still merge.
 */

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _clearInvalidationRegistry } from "../../runtime/invalidation-registry.ts";
import {
	decodeLane,
	drainPayloadSegment,
	freshLiveScope,
	withLiveDrive,
} from "../../test/live-drive.tsx";
import {
	_closeConnectionSession,
	_openConnectionSession,
	handleVisibilityReport,
	reportConnectionVisibility,
	takeConnectionFlips,
} from "../connection-session.ts";
import type { DemuxedLane } from "../fp-trailer-split.ts";
import { PartialRoot, parton, type RenderArgs } from "../partial.tsx";
import { clearRegistry } from "../partial-registry.ts";
import { visible } from "../server-hooks.ts";
import { VISIBILITY_ENDPOINT } from "../visibility-protocol.ts";

// Module-scope render counters — bumped every time a Render body runs,
// so assertions can distinguish "re-rendered" from "served placeholder".
const renders = { a: 0, b: 0 };

const CullA = parton(
	function CullARender(_: RenderArgs) {
		renders.a++;
		const v = visible();
		return (
			<div data-a>{`a:${v === undefined ? "cold" : v ? "full" : "skeleton"}:${renders.a}`}</div>
		);
	},
	{ selector: "cull-a" },
);

const CullB = parton(
	function CullBRender(_: RenderArgs) {
		renders.b++;
		const v = visible();
		return (
			<div data-b>{`b:${v === undefined ? "cold" : v ? "full" : "skeleton"}:${renders.b}`}</div>
		);
	},
	{ selector: "cull-b" },
);

function Page(): ReactNode {
	return (
		<PartialRoot>
			<CullA />
			<CullB />
		</PartialRoot>
	);
}

// Parent/child pair for the deferral probe: the child only exists in
// the tree while the parent is in view, so its FIRST snapshot is
// created by the parent's flip-in lane — the render a same-batch child
// flip races.
const CullChildLate = parton(
	function CullChildLateRender(_: RenderArgs) {
		const v = visible();
		return <div data-child>{`child:${v ? "full" : "skeleton"}`}</div>;
	},
	{ selector: "cull-child-late" },
);

const CullParent = parton(
	function CullParentRender(_: RenderArgs) {
		const v = visible();
		if (!v) return <div data-parent>parent-skeleton</div>;
		return (
			<div data-parent>
				parent-full
				<CullChildLate />
			</div>
		);
	},
	{ selector: "cull-parent" },
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

describe("connection-session visibility", () => {
	it("the ?visible= seed drives the first segment; reports lane-render exactly the flipped partons against the current set", async () => {
		const conn = "conn-vis-1";
		await withLiveDrive(
			`http://localhost/world?live=1&__conn=${conn}&visible=cull-a`,
			Page,
			freshLiveScope("conn-vis"),
			async (h) => {
				// Segment 0: whole tree, rendered against the SEEDED set — a is
				// in (full), b is out (skeleton). Neither reads "cold": the
				// session's seed is the measurement, not the anchor fallback.
				const first = await h.segments.next();
				if (first.done || first.value.kind !== "payload")
					throw new Error("expected payload segment 0");
				const seg0 = await drainPayloadSegment(first.value);
				expect(seg0).toContain("a:full:1");
				expect(seg0).toContain("b:skeleton:1");

				// Flip b IN. The driver must answer with a lane for cull-b only,
				// rendered against the updated session set.
				expect(
					reportConnectionVisibility(conn, 1, ["cull-b"], ["cull-a", "cull-b"]),
				).toBe(true);
				const second = await h.segments.next();
				if (second.done || second.value.kind !== "lanes")
					throw new Error("expected lanes segment");
				const laneIter = second.value.lanes[Symbol.asyncIterator]();

				const laneIn = await nextLane(laneIter);
				expect(laneIn.partonId).toBe("cull-b");
				expect((await decodeLane(laneIn)).bodyText).toContain("b:full:2");
				// The sibling never re-ran — the report named only cull-b.
				expect(renders.a).toBe(1);

				// Flip b OUT again…
				expect(
					reportConnectionVisibility(conn, 2, ["cull-b"], ["cull-a"]),
				).toBe(true);
				const laneOut = await nextLane(laneIter);
				expect(laneOut.partonId).toBe("cull-b");
				expect((await decodeLane(laneOut)).bodyText).toContain("b:skeleton:3");

				// …and back IN. The fp b cycles back to is byte-identical to the
				// one its first flip-in emitted — a stale cached-override entry
				// would fp-skip this render to a placeholder while the client's
				// cache slot holds the skeleton. The flip wake drops the id's
				// override fps, so the body must re-run.
				expect(
					reportConnectionVisibility(conn, 3, ["cull-b"], ["cull-a", "cull-b"]),
				).toBe(true);
				const laneBack = await nextLane(laneIter);
				expect(laneBack.partonId).toBe("cull-b");
				expect((await decodeLane(laneBack)).bodyText).toContain("b:full:4");
				expect(renders.a).toBe(1);

				await h.shutdown("cull-b");
			},
		);
		// The drive loop exited — the session is closed, so a late report is
		// refused (the client falls back to the render-reload path).
		expect(reportConnectionVisibility(conn, 4, ["cull-b"], [])).toBe(false);
	});

	it("a flip for an id the route never rendered defers without disturbing the stream", async () => {
		const conn = "conn-vis-2";
		await withLiveDrive(
			`http://localhost/world?live=1&__conn=${conn}&visible=`,
			Page,
			freshLiveScope("conn-vis"),
			async (h) => {
				const first = await h.segments.next();
				if (first.done || first.value.kind !== "payload")
					throw new Error("expected payload segment 0");
				const seg0 = await drainPayloadSegment(first.value);
				// An EMPTY seed is a measurement too — everything out, nothing
				// "cold".
				expect(seg0).toContain("a:skeleton:1");
				expect(seg0).toContain("b:skeleton:1");

				// A report naming an unknown id must not open a lane (it stays
				// deferred); the next real flip still lanes normally on the same
				// connection.
				expect(
					reportConnectionVisibility(conn, 1, ["not-on-this-route"], []),
				).toBe(true);
				expect(
					reportConnectionVisibility(conn, 2, ["cull-a"], ["cull-a"]),
				).toBe(true);
				const second = await h.segments.next();
				if (second.done || second.value.kind !== "lanes")
					throw new Error("expected lanes segment");
				const laneIter = second.value.lanes[Symbol.asyncIterator]();
				const lane = await nextLane(laneIter);
				expect(lane.partonId).toBe("cull-a");
				expect((await decodeLane(lane)).bodyText).toContain("a:full:2");

				await h.shutdown("cull-a");
			},
		);
	});

	it("a flip racing the render that first materializes its parton defers, then lanes once the snapshot lands", async () => {
		const conn = "conn-vis-3";
		await withLiveDrive(
			`http://localhost/world?live=1&__conn=${conn}&visible=`,
			NestedPage,
			freshLiveScope("conn-vis"),
			async (h) => {
				const first = await h.segments.next();
				if (first.done || first.value.kind !== "payload")
					throw new Error("expected payload segment 0");
				const seg0 = await drainPayloadSegment(first.value);
				// Parent culled out → the child never rendered: no snapshot for
				// it exists anywhere yet.
				expect(seg0).toContain("parent-skeleton");
				expect(seg0).not.toContain("child:");

				// One report flips parent AND child in — the child's flip races
				// the very render (the parent's lane) that will materialize it.
				expect(
					reportConnectionVisibility(
						conn,
						1,
						["cull-parent", "cull-child-late"],
						["cull-parent", "cull-child-late"],
					),
				).toBe(true);
				const second = await h.segments.next();
				if (second.done || second.value.kind !== "lanes")
					throw new Error("expected lanes segment");
				const laneIter = second.value.lanes[Symbol.asyncIterator]();

				// The parent lanes immediately (it has a snapshot); its body
				// materializes the child, which reads the session set → full.
				const parentLane = await nextLane(laneIter);
				expect(parentLane.partonId).toBe("cull-parent");
				const parentBody = (await decodeLane(parentLane)).bodyText;
				expect(parentBody).toContain("parent-full");
				expect(parentBody).toContain("child:full");

				// The child's flip was deferred, not dropped: the parent lane's
				// drain is a wake, the child's snapshot now exists, and the
				// deferred flip resolves into the child's own lane.
				const childLane = await nextLane(laneIter);
				expect(childLane.partonId).toBe("cull-child-late");
				expect((await decodeLane(childLane)).bodyText).toContain("child:full");

				await h.shutdown("cull-parent");
			},
		);
	});

	it("a report for a connection that was never opened is refused", () => {
		expect(reportConnectionVisibility("never-opened", 1, ["x"], ["x"])).toBe(
			false,
		);
	});

	it("a stale report (older seq) cannot regress the set, but its flips still merge", () => {
		const session = _openConnectionSession("conn-vis-seq", null);
		try {
			expect(reportConnectionVisibility("conn-vis-seq", 2, ["x"], ["x"])).toBe(
				true,
			);
			// Older seq arrives late: the set stays at seq 2's value…
			expect(reportConnectionVisibility("conn-vis-seq", 1, ["y"], [])).toBe(
				true,
			);
			expect(session.visible).toEqual(new Set(["x"]));
			// …but the flip merged — y still gets its lane render, which reads
			// the (newer) current set.
			expect(new Set(takeConnectionFlips(session))).toEqual(
				new Set(["x", "y"]),
			);
			// The drain re-armed: nothing pending until the next report.
			expect(session.pendingFlips.size).toBe(0);
		} finally {
			_closeConnectionSession("conn-vis-seq");
		}
	});

	it("the endpoint maps apply / unknown-connection / malformed to 204 / 404 / 400", async () => {
		const post = (body: string) =>
			handleVisibilityReport(
				new Request(`http://localhost${VISIBILITY_ENDPOINT}`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body,
				}),
			);

		_openConnectionSession("conn-vis-http", null);
		try {
			const ok = await post(
				JSON.stringify({
					connection: "conn-vis-http",
					seq: 1,
					changed: ["a"],
					visible: ["a"],
				}),
			);
			expect(ok.status).toBe(204);
			expect(ok.body).toBeNull();

			const gone = await post(
				JSON.stringify({
					connection: "conn-vis-gone",
					seq: 1,
					changed: [],
					visible: [],
				}),
			);
			expect(gone.status).toBe(404);

			expect((await post("not json")).status).toBe(400);
			expect((await post(JSON.stringify({ connection: "" }))).status).toBe(
				400,
			);
		} finally {
			_closeConnectionSession("conn-vis-http");
		}
	});
});
