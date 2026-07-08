/**
 * Cookies ride the live channel — a client cookie change no longer
 * TEARS the held connection.
 *
 * `navigate(url, {cookies})` writes `document.cookie` client-side and
 * states each change as a `cookie` frame on the OPEN connection (see
 * `channel-client.ts`). The endpoint applies it to the connection
 * session's mutable cookie overlay, and the segment driver re-lanes
 * exactly the cookie's readers on the HELD stream — their fp folds the
 * overlay through `parseCookies`, so a changed value re-renders and an
 * unchanged one fp-skips.
 *
 * The claims under test:
 *   1. the endpoint applies a `cookie` frame to the session overlay and
 *      queues the name for the driver's re-lane; a delete tombstones;
 *   2. a `cookie` frame re-lanes EXACTLY the `cookie()` readers of the
 *      changed name — a non-reader never re-renders — with the fresh
 *      value, and a delete re-lanes back to the absent value;
 *   3. match gates are untouched: the overlay is a body-read surface,
 *      not an existence gate (asserted via `parseCookies` reflecting the
 *      overlay while `parseRawCookies` — the gate — does not).
 */

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _clearInvalidationRegistry } from "../../runtime/invalidation-registry.ts";
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
	takeConnectionCookieChanges,
} from "../connection-session.ts";
import type { DemuxedLane } from "../fp-trailer-split.ts";
import { compileMatch } from "../match.ts";
import { PartialRoot, parton, type RenderArgs } from "../partial.tsx";
import { clearRegistry } from "../partial-registry.ts";
import { cookie } from "../server-hooks.ts";

const renders = { theme: 0, plain: 0 };

const ThemeReader = parton(
	function ThemeReaderRender(_: RenderArgs) {
		renders.theme++;
		const theme = cookie("theme") ?? "none";
		return <div data-theme>{`theme:${theme}:${renders.theme}`}</div>;
	},
	{ selector: "theme-reader" },
);

const Plain = parton(
	function PlainRender(_: RenderArgs) {
		renders.plain++;
		return <div data-plain>{`plain:${renders.plain}`}</div>;
	},
	{ selector: "plain" },
);

function Page(): ReactNode {
	return (
		<PartialRoot>
			<ThemeReader />
			<Plain />
		</PartialRoot>
	);
}

beforeEach(() => {
	_clearInvalidationRegistry();
	renders.theme = 0;
	renders.plain = 0;
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

/** POST one `cookie` frame through the channel endpoint, the way the
 *  client transport delivers it. Returns the HTTP status. */
async function postCookie(
	scope: string | undefined,
	connection: string,
	seq: number,
	name: string,
	value: string | null,
): Promise<number> {
	const envelope: ChannelEnvelope = {
		connection,
		seq,
		frames: [{ kind: "cookie", name, value }],
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

describe("cookie frame endpoint apply", () => {
	it("applies a cookie frame to the session overlay and queues the re-lane; a delete tombstones", async () => {
		const session = _openConnectionSession("cook-apply", null);
		try {
			const request = new Request(`http://localhost${CHANNEL_ENDPOINT}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					connection: "cook-apply",
					seq: 1,
					frames: [
						{ kind: "cookie", name: "theme", value: "dark" },
						{ kind: "cookie", name: "cart_id", value: null },
					],
				}),
			});
			const { result } = await runWithRequestAsync(request, () =>
				handleChannelPost(request),
			);
			expect(result.status).toBe(204);
			expect(session.cookies.get("theme")).toBe("dark");
			expect(session.cookies.get("cart_id")).toBeNull();
			// Both names queued for the driver's re-lane, drained once.
			expect(takeConnectionCookieChanges(session)).toEqual(
				new Set(["theme", "cart_id"]),
			);
			expect(session.pendingCookieChanges.size).toBe(0);
			// The overlay persists past the drain — later renders read it.
			expect(session.cookies.get("theme")).toBe("dark");
		} finally {
			_closeConnectionSession("cook-apply");
		}
	});
});

describe("cookies ride the held stream", () => {
	it("a cookie frame re-lanes exactly the reader with the fresh value; a non-reader never re-renders", async () => {
		let conn = "";
		const scope = freshLiveScope("cook-relane");
		await withLiveDrive(
			`http://localhost/page`,
			Page,
			scope,
			async (h) => {
				const first = await h.segments.next();
				if (first.done || first.value.kind !== "payload")
					throw new Error("expected payload segment 0");
				const seg0 = await drainPayloadSegment(first.value);
				conn = h.connectionId() ?? "";
				expect(conn).not.toBe("");
				// Attach carried no theme cookie — the reader renders "none".
				expect(seg0).toContain("theme:none:1");
				expect(seg0).toContain("plain:1");

				// Change theme → the reader re-lanes against the overlay; the
				// non-reader (no `cookie:theme` dep) is never touched.
				expect(await postCookie(scope, conn, 1, "theme", "dark")).toBe(204);
				const second = await h.segments.next();
				if (second.done || second.value.kind !== "lanes")
					throw new Error("expected lanes segment");
				const laneIter = second.value.lanes[Symbol.asyncIterator]();
				const laneDark = await nextLane(laneIter);
				expect(laneDark.partonId).toBe("theme-reader");
				expect((await decodeLane(laneDark)).bodyText).toContain(
					"theme:dark:2",
				);
				expect(renders.plain).toBe(1);

				// Change theme again → re-lanes with the newest value.
				expect(await postCookie(scope, conn, 2, "theme", "light")).toBe(204);
				const laneLight = await nextLane(laneIter);
				expect(laneLight.partonId).toBe("theme-reader");
				expect((await decodeLane(laneLight)).bodyText).toContain(
					"theme:light:3",
				);

				// Delete theme → re-lanes back to the absent value.
				expect(await postCookie(scope, conn, 3, "theme", null)).toBe(204);
				const laneGone = await nextLane(laneIter);
				expect(laneGone.partonId).toBe("theme-reader");
				expect((await decodeLane(laneGone)).bodyText).toContain(
					"theme:none:4",
				);
				expect(renders.plain).toBe(1);

				await h.shutdown("theme-reader");
			},
			{ attach: { cached: [], since: null, visible: null } },
		);
		// The drive loop exited — a late envelope answers 404.
		expect(await postCookie(scope, conn, 4, "theme", "x")).toBe(404);
	});
});

describe("match gates are untouched by the overlay", () => {
	it("parseRawCookies (the gate) reads the raw header; the overlay is a body-read surface", () => {
		// A cookie gate compiled over the RAW header: absence of `beta`
		// keeps it un-matched regardless of any body-read overlay. The
		// overlay never reaches `evaluate` — the gate is who you were when
		// you asked.
		const gate = compileMatch({
			pathname: "/x",
			cookies: { beta: "1" },
		});
		const req = new Request("http://localhost/x", {
			headers: { cookie: "other=1" },
		});
		expect(gate.evaluate(req).matched).toBe(false);
		const withBeta = new Request("http://localhost/x", {
			headers: { cookie: "beta=1" },
		});
		expect(gate.evaluate(withBeta).matched).toBe(true);
	});
});
