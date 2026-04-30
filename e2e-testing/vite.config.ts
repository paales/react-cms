import path from "node:path"
import react from "@vitejs/plugin-react"
import rsc from "@vitejs/plugin-rsc"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "vite"

// Skip `@vitejs/plugin-rsc` when vitest is running: its `"use client"`
// transform wraps modules in client-reference proxies, which breaks
// hook rendering in jsdom because the wrapper pulls in its own React
// copy. For dev / build we still want the plugin active.
const isTest = process.env.VITEST === "true"

// CMS_DATA_DIR pins the storage layer at the cms workspace's data dir
// regardless of cwd — `yarn workspace e2e-testing dev` invokes vite
// from this folder, so the framework's defaultCmsDataDir() (cwd-based)
// would otherwise look for `e2e-testing/cms/data/` instead of the
// repo-level `cms/data/`. Setting it here is robust for dev, build,
// and any preview command run from this workspace.
const REPO_CMS_DATA_DIR = path.resolve(import.meta.dirname, "..", "cms", "data")
process.env.CMS_DATA_DIR ??= REPO_CMS_DATA_DIR

// Workspace alias map — referenced by both the dev/build config and
// (separately) by the root vitest config. Keep them in lockstep.
const REPO_ROOT = path.resolve(import.meta.dirname, "..")
const workspaceAliases = [
  {
    find: /^@react-cms\/framework\/(.*)/,
    replacement: path.resolve(REPO_ROOT, "framework/src/$1"),
  },
  {
    find: /^@react-cms\/framework$/,
    replacement: path.resolve(REPO_ROOT, "framework/index.ts"),
  },
  {
    find: /^@react-cms\/cms\/(.*)/,
    replacement: path.resolve(REPO_ROOT, "cms/src/$1"),
  },
  {
    find: /^@react-cms\/cms$/,
    replacement: path.resolve(REPO_ROOT, "cms/index.ts"),
  },
  {
    find: /^@react-cms\/copies\/(.*)/,
    replacement: path.resolve(REPO_ROOT, "copies/src/$1"),
  },
  {
    find: /^@react-cms\/copies$/,
    replacement: path.resolve(REPO_ROOT, "copies/index.ts"),
  },
  { find: "@", replacement: path.resolve(import.meta.dirname, "src") },
]

// `yarn dev:clean` → `--mode clean`. Runs on port 5174 with HMR off
// and the Vite websocket closed, so the RSC/Flight stream isn't
// interleaved with HMR pings and rsc:update messages. Intended for
// observing actual payload shape in DevTools — not for iterating
// on code. Edit and refresh the page manually.

// Hook-calling node_modules need to be bundled with React in every
// environment (rsc, ssr, client) — never externalised — or their
// `import "react"` resolves through Node and gets a different React
// instance than vite's pre-bundled renderer. The symptom is "Cannot
// read properties of null (reading 'useRef')" on every <Button>.
// Pre-migration this was a non-issue because there was only one src/
// tree; with workspaces, vite's per-env optimizer can miss deps that
// only show up via cross-package aliases (copies/ → @base-ui/react).
// `dedupe: ["react"]` is necessary but not sufficient: dedupe applies
// only to imports vite resolves, externalised packages bypass it.
const HOOK_CALLING_DEPS = [/^@base-ui\//, /^@radix-ui\//, /^@phosphor-icons\//]

export default defineConfig(({ mode }) => ({
  plugins: isTest ? [react(), tailwindcss()] : [rsc(), react(), tailwindcss()],
  server: mode === "clean" ? { port: 5174, strictPort: true, hmr: false, ws: false } : undefined,
  environments: {
    rsc: {
      build: {
        rollupOptions: {
          input: { index: "./src/entry.rsc.tsx" },
        },
      },
      resolve: {
        noExternal: HOOK_CALLING_DEPS,
      },
    },
    ssr: {
      build: {
        rollupOptions: {
          input: { index: "./src/entry.ssr.tsx" },
        },
      },
      resolve: {
        noExternal: HOOK_CALLING_DEPS,
      },
    },
    client: {
      build: {
        rollupOptions: {
          input: { index: "./src/entry.browser.tsx" },
        },
      },
    },
  },
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: workspaceAliases,
  },
  // SSR-environment fallback for vite versions that read top-level
  // `ssr.noExternal` rather than per-env `environments.ssr.resolve.noExternal`.
  ssr: {
    noExternal: HOOK_CALLING_DEPS,
  },
}))
