import path from "node:path"
import { vitePluginRscMinimal } from "@vitejs/plugin-rsc/plugin"
import { defineProject } from "vitest/config"

/**
 * Dedicated Vitest project for tests that render React Server
 * Components in-process. Runs in a Node worker where `react` resolves
 * under its `react-server` condition (the hook-less subset), so
 * `renderToReadableStream` from the vendored Flight server actually
 * runs. The default Vitest project (see the root `vitest.config.ts`)
 * stays on jsdom with `react-server` off — that keeps the bulk of the
 * suite fast and unchanged. Only files matching `*.rsc.test.{ts,tsx}`
 * run here.
 *
 * `vitePluginRscMinimal` gives us the `"use client"` / `"use server"`
 * transforms and the virtual module graph. We remap its `rsc` role
 * onto Vitest's default server-side Vite environment (`ssr`) so the
 * transforms fire without needing Vitest browser mode.
 *
 * This config lives in framework/ because the rsc-tier tests are
 * primarily here (lib/__tests__ + test/). The root vitest.config.ts
 * references it via the project list.
 */
const REPO_ROOT = path.resolve(import.meta.dirname, "..")

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
        find: /^@parton\/framework\/(.*)/,
        replacement: path.resolve(REPO_ROOT, "framework/src/$1"),
      },
      {
        find: /^@parton\/framework$/,
        replacement: path.resolve(REPO_ROOT, "framework/index.ts"),
      },
      {
        find: /^@parton\/cms\/(.*)/,
        replacement: path.resolve(REPO_ROOT, "cms/src/$1"),
      },
      {
        find: /^@parton\/cms$/,
        replacement: path.resolve(REPO_ROOT, "cms/index.ts"),
      },
      {
        find: /^@parton\/copies\/(.*)/,
        replacement: path.resolve(REPO_ROOT, "copies/src/$1"),
      },
      {
        find: /^@parton\/copies$/,
        replacement: path.resolve(REPO_ROOT, "copies/index.ts"),
      },
      { find: "@", replacement: path.resolve(REPO_ROOT, "e2e-testing/src") },
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
    // Globs are relative to the project root (this config's location is
    // framework/, but vitest's project root resolves to the repo root
    // because the orchestrating root vitest.config.ts is one level up).
    // Listing each workspace dir explicitly avoids the `../<pkg>/` form.
    dir: REPO_ROOT,
    include: ["{framework,cms,copies,e2e-testing,e2e-magento}/**/*.rsc.test.?(c|m)[jt]s?(x)"],
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
