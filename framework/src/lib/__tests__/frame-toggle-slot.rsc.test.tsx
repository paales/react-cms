/**
 * Nested-frame A→B→A toggle over the channel — the mirror's SLOT rule.
 *
 * The frame statement's covering lane renders the frame's top-level
 * parton EXPLICIT, but a NESTED parton inside it (constant matchKey,
 * tracked-read content — the tab body) is not explicit: its fp-skip
 * verdict runs against the connection mirror. The client keeps ONE
 * content per `(id, matchKey)` slot, so returning to a previously
 * rendered state must RE-RENDER the nested parton — the mirror's slot
 * rule evicted the old fp when B's content overwrote the slot. Without
 * it, the A→B→A return fp-skips against a phantom (the slot holds B)
 * and the client shows stale content forever.
 */
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runWithRequestAsync } from "../../runtime/context.ts";
import { _clearInvalidationRegistry } from "../../runtime/invalidation-registry.ts";
import { _clearAllSessions } from "../../runtime/session.ts";
import {
	decodeLane,
	drainPayloadSegment,
	freshLiveScope,
	withLiveDrive,
} from "../../test/live-drive.tsx";
import { CHANNEL_ENDPOINT, type ChannelEnvelope } from "../channel-protocol.ts";
import { handleChannelPost } from "../connection-session.ts";
import { Frame } from "../frame.tsx";
import { PartialRoot, parton, type RenderArgs } from "../partial.tsx";
import { clearRegistry } from "../partial-registry.ts";
import { pathname } from "../server-hooks.ts";

// The frame's top-level parton — the statement's explicit target.
const Panel = parton(
	function PanelRender(_: RenderArgs) {
		return (
			<div data-panel>
				<InnerTab />
			</div>
		);
	},
	{ selector: "menu-panel" },
);
// Nested, constant matchKey, content from a tracked read — the shape
// whose slot the toggle cycles.
const InnerTab = parton(
	function InnerTabRender(_: RenderArgs) {
		return <div data-tab>{`tab:${pathname()}`}</div>;
	},
	{ selector: "inner-tab" },
);
const Page = (): ReactNode => (
	<PartialRoot>
		<Frame name="menu-panel" initialUrl="/general">
			<Frame name="tab" initialUrl="/general">
				<Panel />
			</Frame>
		</Frame>
	</PartialRoot>
);

beforeEach(() => _clearInvalidationRegistry());
afterEach(() => {
	clearRegistry("all");
	_clearAllSessions();
	_clearInvalidationRegistry();
});

async function post(scope: string, envelope: ChannelEnvelope, sid: string): Promise<number> {
	const request = new Request(`http://localhost${CHANNEL_ENDPOINT}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-test-scope": scope,
			cookie: `__frame_sid=${sid}`,
		},
		body: JSON.stringify(envelope),
	});
	const { result } = await runWithRequestAsync(request, () => handleChannelPost(request));
	return result.status;
}

describe("nested frame toggle", () => {
	it("A->B->A lanes fresh each time", async () => {
		const scope = freshLiveScope("frame-toggle");
		const sid = "sid-toggle";
		await withLiveDrive(
			"http://localhost/frames",
			Page,
			scope,
			async (h) => {
				const first = await h.segments.next();
				if (first.done || first.value.kind !== "payload") throw new Error("seg0");
				await drainPayloadSegment(first.value);
				const conn = h.connectionId() ?? "";
				const lanesSeg = await h.segments.next();
				if (lanesSeg.done || lanesSeg.value.kind !== "lanes") throw new Error("lanes");
				const iter = lanesSeg.value.lanes[Symbol.asyncIterator]();

				const fire = async (seq: number, url: string) =>
					post(scope, {
						connection: conn,
						seq,
						frames: [{ kind: "url", url, intent: "silent", frame: ["menu-panel", "tab"] }],
					}, sid);

				expect(await fire(1, "/advanced")).toBe(204);
				const l1 = await iter.next();
				if (l1.done) throw new Error("no lane 1");
				expect((await decodeLane(l1.value)).bodyText).toContain("tab:/advanced");

				// The RETURN: the nested tab's /general fp sits in the mirror
				// from the initial segment — but the client's slot now holds
				// /advanced. The slot rule evicted the stale fp, so the lane
				// must ship FRESH general content, never a placeholder.
				expect(await fire(2, "/general")).toBe(204);
				const l2 = await iter.next();
				if (l2.done) throw new Error("no lane 2");
				const body2 = (await decodeLane(l2.value)).bodyText;
				expect(body2).toContain("tab:/general");
				expect(body2).not.toMatch(/"data-partial-id":"inner-tab"[^{]*hidden/);

				expect(await fire(3, "/advanced")).toBe(204);
				const l3 = await iter.next();
				if (l3.done) throw new Error("no lane 3");
				expect((await decodeLane(l3.value)).bodyText).toContain("tab:/advanced");

				await h.shutdown("menu-panel");
			},
			{ headers: { cookie: `__frame_sid=${sid}` } },
		);
	}, 15000);
});
