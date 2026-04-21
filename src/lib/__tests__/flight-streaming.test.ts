import { execSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Test the Flight client's streaming behavior.
 *
 * The vendored Flight client needs __webpack_require__ as a free variable
 * at CJS module init time, which conflicts with vitest's ESM transform.
 * We run tests in a Node subprocess via a CJS helper script.
 */

const helper = path.resolve(__dirname, "flight-streaming-helper.cjs");

function run(testName: string): any {
	const output = execSync(`node ${helper} ${testName}`, {
		encoding: "utf-8",
		timeout: 10000,
		cwd: path.resolve(__dirname, "../../.."),
	});
	return JSON.parse(output.trim());
}

describe("Flight client streaming", () => {
	it("root thenable resolves BEFORE the stream ends", () => {
		const result = run("root-resolves-early");
		// Root should resolve almost immediately (< 100ms), not after the 500ms delayed chunk
		expect(result.elapsed).toBeLessThan(100);
		// Root value should be a React.lazy wrapper ($$typeof === Symbol.for("react.lazy"))
		expect(result.hasLazy).toBe(true);
	});

	it("lazy refs resolve when their chunk arrives on the stream", () => {
		const result = run("lazy-refs-resolve");
		// Initially pending — chunk 1 hasn't arrived yet
		expect(result.statusBefore).toBe("pending");
		// After 300ms (chunk 1 arrives at 200ms) — fulfilled
		expect(result.statusAfter).toBe("fulfilled");
		expect(result.value).toBe("hello-world");
	});

	it("root blocks until chunk 0 arrives", () => {
		const result = run("root-blocks-on-delayed-chunk0");
		// Root thenable doesn't resolve until chunk 0 arrives at ~300ms
		expect(result.elapsed).toBeGreaterThanOrEqual(200);
		expect(result.value).toBe("delayed-root");
	});

	it("dev server RSC stream resolves three search partials progressively", { timeout: 15000 }, async () => {
		// The stage partials opt into `<Partial cache>`. If a previous
		// test (or an e2e run) has already populated the server-side
		// `<Cache>` store for this request shape, the stage bodies
		// return instantly and the progressive-streaming assertions
		// below collapse to a few hundred ms. Flush the cache up front
		// so the 0/1000/2000ms delays actually run.
		await fetch("http://localhost:5173/__test/clear-caches").catch(() => {});
		const result = run("dev-server-rsc-streams-progressively");
		console.log("Dev server streaming result:", JSON.stringify(result, null, 2));
		// Root should resolve almost immediately (template + lazy refs for partials)
		expect(result.rootResolvedMs).toBeLessThan(500);
		// Three search stage partials should resolve at different times
		expect(result.resolveTimes.length).toBeGreaterThanOrEqual(2);
		// First stage resolves quickly (0ms delay + fetch time)
		expect(result.resolveTimes[0].resolvedMs).toBeLessThan(2000);
		// Last stage resolves after ~2000ms delay
		const lastResolve = result.resolveTimes[result.resolveTimes.length - 1].resolvedMs;
		expect(lastResolve).toBeGreaterThan(1500);
	});
});
