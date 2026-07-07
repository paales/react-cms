/**
 * Attach-with-intent + the attach's `__force` overlay + the warm
 * statement — against a real drive. The claims:
 *
 *   1. a statement's `frames` intent applies BEFORE the first render:
 *      the session frame URL moves inside the attach's own request
 *      scope and the whole-tree first segment already renders the
 *      framed subtree at the stated URL — the covering render the
 *      client's re-anchored records resolve against;
 *   2. the statement URL's one-shot `?__force=` overlay never enters
 *      request state; its targets lane EXPLICIT the moment the region
 *      opens — fp-skip and the defer gate yield (the refetch contract)
 *      even when the manifest fp-skipped the target in the segment;
 *   3. a `warm` frame's park-point consume renders the STATED target
 *      route byte-silently: the render evaluates the target URL's
 *      request state, and nothing about it reaches the wire (no lane,
 *      no delivery seq for it).
 */

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runWithRequestAsync } from "../../runtime/context.ts";
import { _clearInvalidationRegistry } from "../../runtime/invalidation-registry.ts";
import { _clearAllSessions, getSessionFrameUrl } from "../../runtime/session.ts";
import {
	decodeLane,
	drainPayloadSegment,
	freshLiveScope,
	withLiveDrive,
} from "../../test/live-drive.tsx";
import { renderWithRequest } from "../../test/rsc-server.ts";
import { CHANNEL_ENDPOINT, type ChannelEnvelope } from "../channel-protocol.ts";
import { handleChannelPost } from "../connection-session.ts";
import { Frame } from "../frame.tsx";
import { PartialRoot, parton, type RenderArgs } from "../partial.tsx";
import { clearRegistry } from "../partial-registry.ts";
import { pathname, searchParam } from "../server-hooks.ts";

const renders = { panel: 0, forced: 0, probe: 0 };
let lastProbeV: string | null = null;

const IntentPanel = parton(
	function IntentPanelRender(_: RenderArgs) {
		renders.panel++;
		return <div data-panel>{`panel:${pathname()}:${renders.panel}`}</div>;
	},
	{ selector: "intent-panel" },
);

const PageFramed = (): ReactNode => (
	<PartialRoot>
		<Frame name="intent-panel" initialUrl="/panel/a">
			<IntentPanel />
		</Frame>
	</PartialRoot>
);

const ForcedTarget = parton(
	function ForcedTargetRender(_: RenderArgs) {
		renders.forced++;
		return <div data-forced>{`forced:${renders.forced}`}</div>;
	},
	{ selector: "forced-target" },
);

const PageForced = (): ReactNode => (
	<PartialRoot>
		<ForcedTarget />
	</PartialRoot>
);

// The warm probe reads the request URL — a warm render for the stated
// target must evaluate the TARGET's request state, observable through
// the recorded read.
const WarmProbe = parton(
	function WarmProbeRender(_: RenderArgs) {
		renders.probe++;
		lastProbeV = searchParam("v");
		return <div data-probe>{`probe:${lastProbeV ?? "none"}`}</div>;
	},
	{ selector: "warm-probe" },
);

const PageProbe = (): ReactNode => (
	<PartialRoot>
		<WarmProbe />
	</PartialRoot>
);

beforeEach(() => {
	_clearInvalidationRegistry();
	renders.panel = 0;
	renders.forced = 0;
	renders.probe = 0;
	lastProbeV = null;
});

afterEach(() => {
	clearRegistry("all");
	_clearAllSessions();
	_clearInvalidationRegistry();
});

async function post(
	scope: string,
	envelope: ChannelEnvelope,
): Promise<number> {
	const request = new Request(`http://localhost${CHANNEL_ENDPOINT}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-test-scope": scope,
		},
		body: JSON.stringify(envelope),
	});
	const { result } = await runWithRequestAsync(request, () =>
		handleChannelPost(request),
	);
	return result.status;
}

describe("attach-with-intent", () => {
	it("applies frame statements before the first render — the segment IS the covering render", async () => {
		const scope = freshLiveScope("attach-intent");
		const sid = "sid-attach-intent";
		await withLiveDrive(
			"http://localhost/host",
			PageFramed,
			scope,
			async (h) => {
				const first = await h.segments.next();
				if (first.done || first.value.kind !== "payload")
					throw new Error("expected payload segment 0");
				const seg0 = await drainPayloadSegment(first.value);
				// The whole-tree first segment reads the frame URL the intent
				// just wrote — never the initialUrl.
				expect(seg0).toContain("panel:/panel/b:1");
				expect(seg0).not.toContain("panel:/panel/a");

				// The session store reflects the bind's write, under the
				// attach's own cookie identity.
				await runWithRequestAsync(
					new Request("http://localhost/host", {
						headers: { "x-test-scope": scope, cookie: `__frame_sid=${sid}` },
					}),
					async () => {
						expect(getSessionFrameUrl(["intent-panel"])).toBe("/panel/b");
					},
				);

				await h.shutdown("intent-panel");
			},
			{
				attach: {
					cached: [],
					since: null,
					visible: null,
					frames: [
						{
							kind: "url",
							url: "/panel/b",
							intent: "silent",
							frame: ["intent-panel"],
						},
					],
				},
				headers: { cookie: `__frame_sid=${sid}` },
			},
		);
	});

	it("lanes the statement URL's __force targets explicit after the region opens", async () => {
		const scope = freshLiveScope("attach-force");
		// Two document renders: the second's emitted fp is the warm token
		// the client would advertise.
		const tokenOf = (flight: string): string => {
			const m =
				/"partialId":"forced-target","partialFingerprint":"([^"]+)","partialMatchKey":"([^"]+)"/.exec(
					flight,
				);
			if (!m) throw new Error("expected a forced-target token");
			return `forced-target:${m[2]}:${m[1]}`;
		};
		await renderWithRequest("http://localhost/host", <PageForced />, {
			headers: { "x-test-scope": scope },
		});
		const { stream } = await renderWithRequest(
			"http://localhost/host",
			<PageForced />,
			{ headers: { "x-test-scope": scope } },
		);
		const token = tokenOf(await new Response(stream).text());
		const baseline = renders.forced;

		await withLiveDrive(
			"http://localhost/host",
			PageForced,
			scope,
			async (h) => {
				const first = await h.segments.next();
				if (first.done || first.value.kind !== "payload")
					throw new Error("expected payload segment 0");
				const seg0 = await drainPayloadSegment(first.value);
				// The manifest fp-skips the target in the whole-tree segment —
				// a whole-tree render cannot force a target — and the request
				// state never absorbed the overlay. (The forced lane's render
				// runs concurrently with this read, so the wire content is the
				// assertion, never the render counter.)
				expect(seg0).toContain('"data-partial-id":"forced-target"');
				expect(seg0).not.toContain("data-forced");

				// The forced lane is the covering render: explicit, past
				// fp-skip, the moment the region opens.
				const lanesSeg = await h.segments.next();
				if (lanesSeg.done || lanesSeg.value.kind !== "lanes")
					throw new Error("expected lanes segment");
				const laneIter = lanesSeg.value.lanes[Symbol.asyncIterator]();
				const lane = await laneIter.next();
				if (lane.done) throw new Error("expected a forced lane");
				expect(lane.value.partonId).toBe("forced-target");
				expect((await decodeLane(lane.value)).bodyText).toContain(
					`forced:${baseline + 1}`,
				);

				await h.shutdown("forced-target");
			},
			{
				attach: {
					url: "http://localhost/host?__force=forced-target",
					cached: [token],
					since: null,
					visible: null,
				},
			},
		);
	});
});

describe("the warm statement", () => {
	it("park-renders the stated target byte-silently", async () => {
		const scope = freshLiveScope("warm-intent");
		await withLiveDrive(
			"http://localhost/tel",
			PageProbe,
			scope,
			async (h) => {
				const first = await h.segments.next();
				if (first.done || first.value.kind !== "payload")
					throw new Error("expected payload segment 0");
				await drainPayloadSegment(first.value);
				expect(lastProbeV).toBeNull();
				const conn = h.connectionId() ?? "";
				const lanesSeg = await h.segments.next();
				if (lanesSeg.done || lanesSeg.value.kind !== "lanes")
					throw new Error("expected lanes segment");
				const laneIter = lanesSeg.value.lanes[Symbol.asyncIterator]();
				const rendersBefore = renders.probe;

				// The statement: the client expects to visit /tel?v=warmed.
				expect(
					await post(scope, {
						connection: conn,
						seq: 1,
						frames: [{ kind: "warm", url: "/tel?v=warmed" }],
					}),
				).toBe(204);

				// The park point consumes it: one whole-tree render of the
				// TARGET request state (the tracked read observes the stated
				// URL), and nothing reaches the wire — the lanes region stays
				// empty of any announcement for it.
				const deadline = Date.now() + 5000;
				while (renders.probe === rendersBefore && Date.now() < deadline) {
					await new Promise((r) => setTimeout(r, 10));
				}
				expect(renders.probe).toBe(rendersBefore + 1);
				expect(lastProbeV).toBe("warmed");
				expect(
					h.entries.some(
						(e) => e.tag === "seq" && e.body.startsWith("warm-probe"),
					),
				).toBe(false);

				// The lanes region is still live for real statements — the
				// iterator has produced nothing for the warm.
				void laneIter;
				await h.shutdown("warm-probe");
			},
		);
	});
});
