/**
 * Per-parton lane emission from the live segment driver — end to end
 * through the REAL production pieces: `driveSegmentedResponse` with a
 * `?live=1` request, `PartialRoot` rendering the initial whole-tree
 * segment, `refreshSelector` / `expiresAt` wakes, and the client
 * splitter (`splitSegments`) consuming the wire.
 *
 * The claims under test:
 *   1. after the initial segment, a relevant bump renders ONLY the
 *      touched parton, emitted as a `mux` lane (the untouched sibling
 *      never re-renders);
 *   2. the lane's body is a complete Flight payload of that parton's
 *      fresh content, carrying its own fp-trailer entries — including
 *      `{from,to}` updates for ANCESTORS whose descendant fold moved,
 *      without the ancestors re-rendering;
 *   3. an `expiresAt` boundary wakes a lane for the declaring parton.
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
import type { DemuxedLane } from "../fp-trailer-split.ts";
import { PartialRoot, parton, type RenderArgs } from "../partial.tsx";
import { expires, time } from "../server-hooks.ts";
import { clearRegistry } from "../partial-registry.ts";

// Module-scope render counters — bumped every time a Render body runs,
// so assertions can distinguish "re-rendered" from "served placeholder".
const renders = { fast: 0, slow: 0, wrapper: 0 };

const FastLane = parton(
	function FastLaneRender() {
		renders.fast++;
		return <div data-fast-render={renders.fast}>{`fast-${renders.fast}`}</div>;
	},
	{ selector: "lane-fast" },
);

const SlowSibling = parton(
	function SlowSiblingRender() {
		renders.slow++;
		return (
			<aside data-slow-render={renders.slow}>{`slow-${renders.slow}`}</aside>
		);
	},
	{ selector: "lane-slow" },
);

const LaneWrapper = parton(
	function LaneWrapperRender({ children }: RenderArgs) {
		renders.wrapper++;
		return <section data-wrapper>{children}</section>;
	},
	{ selector: "lane-wrapper" },
);

function Page(): ReactNode {
	return (
		<PartialRoot>
			<LaneWrapper>
				<FastLane />
				<SlowSibling />
			</LaneWrapper>
		</PartialRoot>
	);
}

// Ticking parton for the expiresAt arm: the body declares an 80ms
// boundary via the wake hook, so each expiry wake renders fresh
// content.
const renders2 = { clock: 0 };
const ExpiryClock = parton(
	function ExpiryClockRender(_: RenderArgs) {
		renders2.clock++;
		expires(time().in(80));
		const tick = Math.floor(Date.now() / 100);
		return <time data-clock>{`tick-${tick}-${renders2.clock}`}</time>;
	},
	{ selector: "lane-clock" },
);

beforeEach(() => {
	_clearInvalidationRegistry();
	renders.fast = 0;
	renders.slow = 0;
	renders.wrapper = 0;
	renders2.clock = 0;
});

afterEach(() => {
	clearRegistry("all");
	_clearInvalidationRegistry();
});

describe("live segment driver — per-parton lanes", () => {
	it("a relevant bump emits a lane for ONLY the touched parton, with ancestor fp updates on its trailer", async () => {
		await withLiveDrive(
			"http://localhost/lanes?live=1",
			Page,
			freshLiveScope("lanes-rsc"),
			async (h) => {
				// Segment 0: whole tree, both partons render once.
				const first = await h.segments.next();
				if (first.done || first.value.kind !== "payload")
					throw new Error("expected payload segment 0");
				const seg0 = await drainPayloadSegment(first.value);
				expect(seg0).toContain("fast-1");
				expect(seg0).toContain("slow-1");
				expect(renders.fast).toBe(1);
				expect(renders.slow).toBe(1);

				// Bump only the fast parton. The driver must answer with a lanes
				// segment containing exactly one lane.
				refreshSelector("lane-fast");
				const second = await h.segments.next();
				if (second.done || second.value.kind !== "lanes")
					throw new Error("expected lanes segment");
				const laneIter = second.value.lanes[Symbol.asyncIterator]();
				const lane = (await laneIter.next()).value as DemuxedLane;
				expect(lane.partonId).toBe("lane-fast");

				const { bodyText, fp } = await decodeLane(lane);
				// Fresh content for the bumped parton…
				expect(bodyText).toContain("fast-2");
				expect(renders.fast).toBe(2);
				// …while the sibling and the wrapper never re-ran.
				expect(renders.slow).toBe(1);
				expect(renders.wrapper).toBe(1);
				expect(bodyText).not.toContain("slow-");

				// The lane's trailer refreshes the ANCESTOR's fp: the wrapper's
				// descendant fold moved with the child's invalidation, and the
				// {from,to} update rides the child's lane without the wrapper
				// re-rendering.
				expect(fp).not.toBeNull();
				expect(fp?.["lane-wrapper"]).toBeDefined();
				expect(fp?.["lane-wrapper"].to).not.toBe(fp?.["lane-wrapper"].from);

				await h.shutdown("lane-fast");
			},
		);
	});

	it("consecutive bumps re-render through the SAME connection as successive lanes", async () => {
		await withLiveDrive(
			"http://localhost/lanes?live=1",
			Page,
			freshLiveScope("lanes-rsc"),
			async (h) => {
				const first = await h.segments.next();
				if (first.done || first.value.kind !== "payload")
					throw new Error("expected payload segment 0");
				await drainPayloadSegment(first.value);

				refreshSelector("lane-fast");
				const second = await h.segments.next();
				if (second.done || second.value.kind !== "lanes")
					throw new Error("expected lanes segment");
				const laneIter = second.value.lanes[Symbol.asyncIterator]();

				const laneA = (await laneIter.next()).value as DemuxedLane;
				expect((await decodeLane(laneA)).bodyText).toContain("fast-2");

				refreshSelector("lane-fast");
				const laneB = (await laneIter.next()).value as DemuxedLane;
				expect(laneB.partonId).toBe("lane-fast");
				expect((await decodeLane(laneB)).bodyText).toContain("fast-3");
				expect(renders.slow).toBe(1);

				await h.shutdown("lane-fast");
			},
		);
	});

	it("an expiresAt boundary wakes a lane for the declaring parton", async () => {
		await withLiveDrive(
			"http://localhost/clock?live=1",
			() => (
				<PartialRoot>
					<ExpiryClock />
				</PartialRoot>
			),
			freshLiveScope("lanes-rsc"),
			async (h) => {
				const first = await h.segments.next();
				if (first.done || first.value.kind !== "payload")
					throw new Error("expected payload segment 0");
				await drainPayloadSegment(first.value);
				expect(renders2.clock).toBe(1);

				// No bump fired — the 80ms expiresAt alone must wake the lane.
				const second = await h.segments.next();
				if (second.done || second.value.kind !== "lanes")
					throw new Error("expected lanes segment");
				const laneIter = second.value.lanes[Symbol.asyncIterator]();
				const lane = (await laneIter.next()).value as DemuxedLane;
				expect(lane.partonId).toBe("lane-clock");
				const { bodyText } = await decodeLane(lane);
				expect(renders2.clock).toBe(2);
				expect(bodyText).toContain("tick-");

				await h.shutdown("lane-clock");
			},
		);
	});
});
