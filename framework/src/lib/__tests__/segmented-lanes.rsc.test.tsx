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
	_captureCommitHandle,
	runWithRequestAsync,
} from "../../runtime/context.ts";
import {
	_clearInvalidationRegistry,
	refreshSelector,
} from "../../runtime/invalidation-registry.ts";
import { renderServerToFlight } from "../../test/rsc-server.ts";
import { wrapStreamWithFpTrailer } from "../fp-trailer.ts";
import {
	type DemuxedLane,
	splitAtFpTrailer,
	splitSegments,
} from "../fp-trailer-split.ts";
import { PartialRoot, parton, type RenderArgs } from "../partial.tsx";
import { clearRegistry } from "../partial-registry.ts";
import { driveSegmentedResponse } from "../segmented-response.ts";

// Module-scope render counters — bumped every time a Render body runs,
// so assertions can distinguish "re-rendered" from "served placeholder".
const renders = { fast: 0, slow: 0, wrapper: 0 };

const FastLane = parton(
	function FastLaneRender() {
		renders.fast++;
		return <div data-fast-render={renders.fast}>{`fast-${renders.fast}`}</div>;
	},
	{ selector: "lane-fast", vary: ({ search: { q = "" } }) => ({ q }) },
);

const SlowSibling = parton(
	function SlowSiblingRender() {
		renders.slow++;
		return (
			<aside data-slow-render={renders.slow}>{`slow-${renders.slow}`}</aside>
		);
	},
	{ selector: "lane-slow", vary: ({ search: { s = "" } }) => ({ s }) },
);

const LaneWrapper = parton(
	function LaneWrapperRender({ children }: RenderArgs) {
		renders.wrapper++;
		return <section data-wrapper>{children}</section>;
	},
	{ selector: "lane-wrapper", vary: ({ pathname }) => ({ pathname }) },
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

// Ticking parton for the expiresAt arm: vary re-derives per second, so
// each expiry wake renders fresh content.
const renders2 = { clock: 0 };
const ExpiryClock = parton(
	function ExpiryClockRender({ tick }: { tick: number } & RenderArgs) {
		renders2.clock++;
		return <time data-clock>{`tick-${tick}-${renders2.clock}`}</time>;
	},
	{
		selector: "lane-clock",
		vary: ({ time }) => ({
			tick: Math.floor(Date.now() / 100),
			expiresAt: time.in(80),
		}),
	},
);

// ─── Harness ─────────────────────────────────────────────────────────

interface DriveHandle {
	segments: AsyncIterator<
		ReturnType<typeof splitSegments> extends AsyncIterable<infer S> ? S : never
	>;
	/** Ends the connection: cancels the client reader and wakes the
	 *  parked driver with a bump so its enqueue fails and the loop
	 *  exits without waiting out the 20s keepalive. */
	shutdown: (wakeSelector: string) => Promise<void>;
}

async function withLiveDrive(
	url: string,
	page: () => ReactNode,
	scope: string,
	run: (h: DriveHandle) => Promise<void>,
): Promise<void> {
	const request = new Request(url, { headers: { "x-test-scope": scope } });
	await runWithRequestAsync(request, async () => {
		let controller!: ReadableStreamDefaultController<Uint8Array>;
		const response = new ReadableStream<Uint8Array>({
			start(c) {
				controller = c;
			},
		});
		const renderOnce = () =>
			wrapStreamWithFpTrailer(
				renderServerToFlight(page()),
				_captureCommitHandle(),
			);
		const drive = driveSegmentedResponse(controller, renderOnce).then(() => {
			try {
				controller.close();
			} catch {}
		});
		const iter = splitSegments(response)[Symbol.asyncIterator]();
		await run({
			segments: iter,
			shutdown: async (wakeSelector: string) => {
				await iter.return?.();
				// The parked driver only observes the torn controller on its
				// next enqueue; a matching bump forces that wake.
				refreshSelector(wakeSelector);
				await drive;
			},
		});
	});
}

async function drainPayloadSegment(seg: {
	kind: "payload";
	body: ReadableStream<Uint8Array>;
	trailers: Promise<Map<string, Uint8Array>>;
}): Promise<string> {
	const text = await new Response(seg.body).text();
	await seg.trailers;
	return text;
}

async function decodeLane(lane: DemuxedLane): Promise<{
	bodyText: string;
	fp: Record<string, { from: string; to: string }> | null;
}> {
	const { mainStream, trailer } = splitAtFpTrailer(lane.body);
	const bodyText = await new Response(mainStream).text();
	const fp = (await trailer) as Record<
		string,
		{ from: string; to: string }
	> | null;
	return { bodyText, fp };
}

let scopeCounter = 0;
function freshScope(): string {
	return `lanes-rsc-${Date.now()}-${scopeCounter++}`;
}

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
			freshScope(),
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
			freshScope(),
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
			freshScope(),
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
