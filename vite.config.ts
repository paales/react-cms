import react from "@vitejs/plugin-react";
import rsc from "@vitejs/plugin-rsc";
import { defineConfig } from "vite";

// Skip `@vitejs/plugin-rsc` when vitest is running: its `"use client"`
// transform wraps modules in client-reference proxies, which breaks
// hook rendering in jsdom because the wrapper pulls in its own React
// copy. For dev / build we still want the plugin active.
const isTest = process.env.VITEST === "true";

export default defineConfig({
	plugins: isTest ? [react()] : [rsc(), react()],
	environments: {
		rsc: {
			build: {
				rollupOptions: {
					input: { index: "./src/framework/entry.rsc.tsx" },
				},
			},
		},
		ssr: {
			build: {
				rollupOptions: {
					input: { index: "./src/framework/entry.ssr.tsx" },
				},
			},
		},
		client: {
			build: {
				rollupOptions: {
					input: { index: "./src/framework/entry.browser.tsx" },
				},
			},
		},
	},
	test: {
		setupFiles: ["./vitest.setup.ts"],
		// Vitest only owns unit/integration tests under src/. Playwright
		// specs live in e2e/ (run via `yarn test:e2e`); the legacy proxy
		// data layer in archive/ has its own tests that aren't wired up.
		include: ["src/**/*.{test,spec}.?(c|m)[jt]s?(x)"],
	},
	resolve: {
		dedupe: ["react", "react-dom"],
	},
});
