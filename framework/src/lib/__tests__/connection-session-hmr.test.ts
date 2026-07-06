/**
 * The connection-session store survives module re-evaluation. In dev,
 * a server-side edit re-evals the module graph while a held live
 * connection's driver keeps running against the instance it loaded —
 * but the visibility beacon endpoint resolves the module FRESH per
 * request. Both must address the same store: a report landing in a
 * new, empty map answers `404` (the client's fall-back-to-reload
 * signal) for every open connection until the heartbeat's next
 * reopen, and the driver's sessions leak in the abandoned map.
 */

import { describe, expect, it, vi } from "vitest";

type ConnectionSessionModule = typeof import("../connection-session.ts");

describe("connection-session store — module re-evaluation", () => {
	it("a report through a re-evaluated module reaches a session the prior instance opened", async () => {
		vi.resetModules();
		const first: ConnectionSessionModule = await import(
			"../connection-session.ts"
		);
		const session = first._openConnectionSession("hmr-conn", null);
		try {
			vi.resetModules();
			const second: ConnectionSessionModule = await import(
				"../connection-session.ts"
			);
			// Distinct module instances — the dev-edit shape.
			expect(second).not.toBe(first);

			const applied = second.reportConnectionVisibility(
				"hmr-conn",
				1,
				["chunk-a"],
				["chunk-a"],
			);
			expect(applied).toBe(true);
			// The report landed on the SAME session object the (old) driver
			// holds — its flip wake and pending set are live.
			expect(session.pendingFlips.has("chunk-a")).toBe(true);
			expect(session.visible?.has("chunk-a")).toBe(true);

			// Closing through the new instance unregisters it for both.
			second._closeConnectionSession("hmr-conn");
			expect(
				second.reportConnectionVisibility("hmr-conn", 2, [], []),
			).toBe(false);
			expect(
				first.reportConnectionVisibility("hmr-conn", 2, [], []),
			).toBe(false);
		} finally {
			first._closeConnectionSession("hmr-conn");
		}
	});
});
