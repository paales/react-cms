import path from "node:path"
import { vitePluginRscMinimal } from "@vitejs/plugin-rsc/plugin"
import { defineProject } from "vitest/config"

/**
 * Dedicated Vitest project for tests that render React Server
 * Components in-process. Runs in a Node worker where `react` resolves
 * under its `react-server` condition (the hook-less subset), so
 * `renderToReadableStream` from the vendored Flight server actually
 * runs. The default Vitest project (see `vite.config.ts`) stays on
 * jsdom with `react-server` off — that keeps the bulk of the suite
 * fast and unchanged. Only files matching `*.rsc.test.{ts,tsx}` run
 * here.
 *
 * `vitePluginRscMinimal` gives us the `"use client"` / `"use server"`
 * transforms and the virtual module graph. We remap its `rsc` role
 * onto Vitest's default server-side Vite environment (`ssr`) so the
 * transforms fire without needing Vitest browser mode.
 */
export default defineProject({
  plugins: [
    ...vitePluginRscMinimal({
      environment: { rsc: "ssr" },
    }),
  ],
  resolve: {
    conditions: ["react-server"],
    alias: [
      {
        find: /^@react-cms\/framework\/(.*)/,
        replacement: path.resolve(import.meta.dirname, "framework/src/$1"),
      },
      {
        find: /^@react-cms\/framework$/,
        replacement: path.resolve(import.meta.dirname, "framework/index.ts"),
      },
      {
        find: /^@react-cms\/cms\/(.*)/,
        replacement: path.resolve(import.meta.dirname, "cms/src/$1"),
      },
      {
        find: /^@react-cms\/cms$/,
        replacement: path.resolve(import.meta.dirname, "cms/index.ts"),
      },
      {
        find: /^@react-cms\/copies\/(.*)/,
        replacement: path.resolve(import.meta.dirname, "copies/src/$1"),
      },
      {
        find: /^@react-cms\/copies$/,
        replacement: path.resolve(import.meta.dirname, "copies/index.ts"),
      },
      { find: "@", replacement: path.resolve(import.meta.dirname, "e2e-testing/src") },
    ],
  },
  // SSR config mirrors `resolve` — Vitest runs tests through Vite's
  // SSR transform, which reads conditions from here, not the outer
  // `resolve` bucket.
  ssr: {
    resolve: {
      conditions: ["react-server"],
    },
  },
  test: {
    name: "rsc",
    include: [
      "{framework,cms,copies,e2e-testing,e2e-magento}/**/*.rsc.test.?(c|m)[jt]s?(x)",
    ],
    environment: "node",
    // Force-inline React + the vendored Flight runtime so Vite's
    // resolver (with our `react-server` condition) handles them.
    // Default externalisation would let Node resolve them without
    // the condition — which is exactly what just threw "react-server
    // condition must be enabled" in the runtime.
    server: {
      deps: {
        inline: ["react", "react-dom", "react-server-dom-webpack", /@vitejs\/plugin-rsc/],
      },
    },
    // React's internal `require("react")` calls go through the plain
    // Node CJS resolver, which doesn't read our Vite conditions.
    // `yarn test:rsc` sets `NODE_OPTIONS='--conditions=react-server'`
    // to cover that resolve path without polluting the default
    // project (which needs the regular React build). Tried setting
    // it via `poolOptions.forks.execArgv` here — Vitest 3 doesn't
    // appear to propagate execArgv from a project config.
  },
})
