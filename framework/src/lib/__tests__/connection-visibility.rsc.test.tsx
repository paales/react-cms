/**
 * Connection-session visibility — flips ride the OPEN live connection.
 *
 * The client's visibility controller reports viewport flips as
 * fire-and-forget POSTs addressed to the live connection's explicit
 * `__conn` id; the segment driver stores the set as connection-session
 * state and treats each report like an invalidation wake, rendering the
 * flipped-IN partons as lanes on the EXISTING stream with the cull
 * gate reading the session's CURRENT set.
 *
 * The claims under test:
 *   1. the `?visible=` seed on the `?live=1` request drives the
 *      whole-tree first segment (no cold-seed clobber): out-of-set
 *      partons emit the pair (body skipped), in-set ones render;
 *   2. a report wakes a lane for EXACTLY the flipped-IN parton,
 *      rendered against the reported set — untouched siblings never
 *      re-render, and a cull-OUT lanes NOTHING (the client swaps to
 *      its inline skeleton locally; the report's only server effect is
 *      the session-set update that keeps lane parking honest);
 *   3. a flip cycle (in → out → in) settles the returning state with
 *      fp-skip semantics: the content fp is unchanged, so cycling back
 *      answers with the zero-byte confirmation placeholder — the body
 *      never re-runs for content the client provably holds;
 *   4. a flip whose parton has no route snapshot yet (the report raced
 *      the render that first materializes it) is DEFERRED, not dropped —
 *      it resolves into a lane on a later wake once the snapshot lands;
 *   5. session lifecycle — a report for a connection that was never
 *      opened, or whose drive loop has exited, is refused (the client's
 *      explicit fall-back-to-reload signal), and the endpoint handler
 *      maps apply/refuse/malformed to 204/404/400;
 *   6. report ordering — a stale report (older seq) can't regress the
 *      set, but its flips still merge;
 *   7. PARKED partons don't lane — a bump touching a parton outside
 *      the session's measured visible set renders nothing, and a
 *      culled parton has NO wake surface at all (its snapshot records
 *      the gate's reads only: no cell labels, no expires deadline);
 *      the flip-in revalidation re-renders the returning state fresh,
 *      folding everything that landed while parked.
 */

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
import { expires, time } from "../server-hooks.ts";
import { VISIBILITY_ENDPOINT } from "../visibility-protocol.ts";
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

describe("connection-session visibility", () => {
	it("the ?visible= seed drives the first segment; in-flips lane, out-flips don't", async () => {
		const conn = "conn-vis-1";
		await withLiveDrive(
			`http://localhost/world?live=1&__conn=${conn}&visible=cull-a`,
			Page,
			freshLiveScope("conn-vis"),
			async (h) => {
				// Segment 0: whole tree, rendered against the SEEDED set — a is
				// in (body renders), b is out (body SKIPPED: the pair ships with
				// the skeleton reference, zero body bytes, zero body runs).
				const first = await h.segments.next();
				if (first.done || first.value.kind !== "payload")
					throw new Error("expected payload segment 0");
				const seg0 = await drainPayloadSegment(first.value);
				expect(seg0).toContain("a:full:1");
				expect(seg0).not.toContain("b:full");
				expect(seg0).toContain('"id":"cull-b"');
				expect(seg0).toContain('"culled":true');
				expect(renders.b).toBe(0);

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
				expect((await decodeLane(laneIn)).bodyText).toContain("b:full:1");
				// The sibling never re-ran — the report named only cull-b.
				expect(renders.a).toBe(1);

				// Flip b OUT: NOTHING lanes — the client already swapped to its
				// inline skeleton; the report's server effect is the session-set
				// update alone. Prove it by bumping a next: the next lane on the
				// wire is a's, and b's body never re-ran.
				expect(
					reportConnectionVisibility(conn, 2, ["cull-b"], ["cull-a"]),
				).toBe(true);
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
					reportConnectionVisibility(conn, 3, ["cull-b"], ["cull-a", "cull-b"]),
				).toBe(true);
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
				// An EMPTY seed is a measurement too — everything out, no body
				// runs anywhere.
				expect(seg0).not.toContain("a:full");
				expect(seg0).not.toContain("b:full");
				expect(renders.a).toBe(0);
				expect(renders.b).toBe(0);

				// A report naming an unknown id must not open a lane (it stays
				// deferred); the next real flip still lanes normally on the same
				// connection.
				expect(
					reportConnectionVisibility(conn, 1, ["not-on-this-route"], ["not-on-this-route"]),
				).toBe(true);
				expect(
					reportConnectionVisibility(conn, 2, ["cull-a"], ["cull-a", "not-on-this-route"]),
				).toBe(true);
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
				expect(seg0).not.toContain("parent-full");
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
			// …but the flip merged — y still gets drained, and its lane render
			// (or out-skip) reads the (newer) current set.
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
					cached: [],
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
					cached: [],
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

	it("a bump touching a PARKED parton doesn't lane; the flip-in re-renders it fresh", async () => {
		const conn = "conn-vis-parked";
		await withLiveDrive(
			`http://localhost/world?live=1&__conn=${conn}&visible=cull-a,cull-b`,
			Page,
			freshLiveScope("conn-vis"),
			async (h) => {
				const first = await h.segments.next();
				if (first.done || first.value.kind !== "payload")
					throw new Error("expected payload segment 0");
				const seg0 = await drainPayloadSegment(first.value);
				expect(seg0).toContain("a:full:1");
				expect(seg0).toContain("b:full:1");

				// Park b (flip it out) — no lane; the client's swap is local.
				expect(
					reportConnectionVisibility(conn, 1, ["cull-b"], ["cull-a"]),
				).toBe(true);

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
					reportConnectionVisibility(conn, 2, ["cull-b"], ["cull-a", "cull-b"]),
				).toBe(true);
				const laneIn = await nextLane(laneIter);
				expect(laneIn.partonId).toBe("cull-b");
				expect((await decodeLane(laneIn)).bodyText).toContain("b:full:2");

				await h.shutdown("cull-b");
			},
		);
	});

	it("a parked parton has no wake surface: its expires() deadline neither lanes nor hot-spins", async () => {
		const conn = "conn-vis-parked-exp";
		await withLiveDrive(
			`http://localhost/pulse?live=1&__conn=${conn}&visible=cull-pulse`,
			() => (
				<PartialRoot>
					<CullPulse />
				</PartialRoot>
			),
			freshLiveScope("conn-vis"),
			async (h) => {
				const first = await h.segments.next();
				if (first.done || first.value.kind !== "payload")
					throw new Error("expected payload segment 0");
				expect(await drainPayloadSegment(first.value)).toContain(
					"pulse:full:1",
				);

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
				expect(
					reportConnectionVisibility(conn, 1, ["cull-pulse"], []),
				).toBe(true);
				await new Promise((r) => setTimeout(r, 350));
				expect(renders3.pulse).toBe(2);

				// Flip-in catches up (the content snapshot's deadline elapsed
				// while parked → fp-skip declines) and re-arms the boundary.
				expect(
					reportConnectionVisibility(conn, 2, ["cull-pulse"], ["cull-pulse"]),
				).toBe(true);
				const laneIn = await nextLane(laneIter);
				expect((await decodeLane(laneIn)).bodyText).toContain("pulse:full:3");

				await h.shutdown("cull-pulse");
			},
		);
	});
});
