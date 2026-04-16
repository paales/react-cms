// Helper script for flight-streaming.test.ts
// Runs in a plain Node subprocess to avoid vitest ESM transform issues.
// Receives test name as argv[2], prints JSON result to stdout.

global.__webpack_require__ = Object.assign(() => ({}), { u: () => "" });
global.__webpack_chunk_load__ = () => Promise.resolve();

// Resolve the vendored react-server-dom client through the installed
// @vitejs/plugin-rsc package — the yarn pnpm-like `.store` directory
// includes a content hash in the path that changes on every
// lockfile update, so a hardcoded absolute path goes stale.
const path = require("node:path");
const pluginRscDir = path.dirname(require.resolve("@vitejs/plugin-rsc/package.json"));
const { createFromReadableStream } = require(
	path.join(
		pluginRscDir,
		"dist/vendor/react-server-dom/cjs/react-server-dom-webpack-client.browser.development.js",
	),
);

function timedStream(chunks) {
	const encoder = new TextEncoder();
	return new ReadableStream({
		async start(controller) {
			for (const [delayMs, data] of chunks) {
				if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
				controller.enqueue(encoder.encode(data));
			}
			controller.close();
		},
	});
}

const tests = {
	"root-resolves-early": async () => {
		const stream = timedStream([
			[0, '0:{"value":"$L1"}\n'],
			[500, '1:"delayed-content"\n'],
		]);
		const start = Date.now();
		const root = await Promise.resolve(createFromReadableStream(stream, {}));
		const elapsed = Date.now() - start;
		return {
			elapsed,
			hasLazy: root.value?.$$typeof === Symbol.for("react.lazy"),
		};
	},

	"lazy-refs-resolve": async () => {
		const stream = timedStream([
			[0, '0:{"value":"$L1"}\n'],
			[200, '1:"hello-world"\n'],
		]);
		const root = await createFromReadableStream(stream, {});
		const chunk = root.value._payload;
		const statusBefore = chunk.status;
		await new Promise((r) => setTimeout(r, 300));
		return {
			statusBefore,
			statusAfter: chunk.status,
			value: chunk.value,
		};
	},

	"root-blocks-on-delayed-chunk0": async () => {
		const stream = timedStream([[300, '0:{"value":"delayed-root"}\n']]);
		const start = Date.now();
		const root = await createFromReadableStream(stream, {});
		const elapsed = Date.now() - start;
		return { elapsed, value: root.value };
	},

	"dev-server-rsc-streams-progressively": async () => {
		// Fetch a partial refetch for the three search stage partials.
		// Each is a separate partial with its own delay (0ms, 1000ms, 2000ms).
		// They should arrive as separate lazy refs on the Flight stream.
		const url =
			"http://localhost:5173/pokemon_.rsc?search=url&q=char&partials=stage-1,stage-2,stage-3";
		const t0 = Date.now();
		const response = await fetch(url);
		const fetchMs = Date.now() - t0;

		const payload = await createFromReadableStream(response.body, {});
		const rootResolvedMs = Date.now() - t0;

		// Walk the payload tree to find ALL pending lazy refs.
		// Each search stage partial should be a separate lazy ref.
		const LAZY = Symbol.for("react.lazy");
		const allLazies = [];
		function findLazies(node, depth = 0, path = "") {
			if (!node || depth > 40) return;
			if (typeof node !== "object") return;
			if (node.$$typeof === LAZY) {
				const chunk = node._payload;
				allLazies.push({ path, status: chunk?.status ?? "unknown", chunk });
				if (chunk?.status === "fulfilled") {
					findLazies(chunk.value, depth + 1, path + ".$resolved");
				}
				return;
			}
			if (node.$$typeof === Symbol.for("react.transitional.element") ||
				node.$$typeof === Symbol.for("react.element")) {
				findLazies(node.type, depth + 1, path + ".type");
				if (node.props) {
					for (const [k, v] of Object.entries(node.props)) {
						findLazies(v, depth + 1, path + `.props.${k}`);
					}
				}
				return;
			}
			if (Array.isArray(node)) {
				for (let i = 0; i < node.length; i++) findLazies(node[i], depth + 1, path + `[${i}]`);
				return;
			}
			for (const [k, v] of Object.entries(node)) findLazies(v, depth + 1, path + `.${k}`);
		}
		findLazies(payload, 0, "root");

		const pendingLazies = allLazies.filter(l => l.status === "pending");

		// Track when each pending lazy resolves
		const resolveTimes = [];
		await Promise.all(pendingLazies.map(async (lazy) => {
			const chunk = lazy.chunk;
			await new Promise((resolve) => {
				if (chunk.status !== "pending") { resolve(); return; }
				chunk.then(resolve, resolve);
			});
			resolveTimes.push({ path: lazy.path, resolvedMs: Date.now() - t0 });
		}));

		// Also track already-fulfilled lazies
		const fulfilledLazies = allLazies.filter(l => l.status === "fulfilled");
		for (const lazy of fulfilledLazies) {
			resolveTimes.push({ path: lazy.path, resolvedMs: rootResolvedMs });
		}

		return {
			fetchMs,
			rootResolvedMs,
			totalLazies: allLazies.length,
			pendingCount: pendingLazies.length,
			lazyStatuses: allLazies.map(l => ({ path: l.path, status: l.status })),
			resolveTimes: resolveTimes.sort((a, b) => a.resolvedMs - b.resolvedMs),
		};
	},
};

const testName = process.argv[2];
if (!tests[testName]) {
	console.error(`Unknown test: ${testName}`);
	process.exit(1);
}

tests[testName]().then((result) => {
	console.log(JSON.stringify(result));
});
