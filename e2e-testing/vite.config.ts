import path from "node:path"
import babel from "@rolldown/plugin-babel"
import react, { reactCompilerPreset } from "@vitejs/plugin-react"
import rsc from "@vitejs/plugin-rsc"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "vite"
import { partonChannelServer } from "@parton/framework/vite/channel-server.ts"
import { rscCompression } from "@parton/framework/vite/compression.ts"

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

// DOCS_DIR pins the chat-overlay's markdown source. Same rationale as
// CMS_DATA_DIR — preview-mode bundles live under `dist/rsc/`, so
// neither `process.cwd()` nor `import.meta.dirname`-relative paths
// inside the bundled code reach the repo's `docs/` tree. Anchor it
// from `vite.config.ts`, where `import.meta.dirname` is the workspace
// root regardless of run mode.
const REPO_DOCS_DIR = path.resolve(import.meta.dirname, "..", "docs")
process.env.DOCS_DIR ??= REPO_DOCS_DIR

// Workspace alias map — referenced by both the dev/build config and
// (separately) by the root vitest config. Keep them in lockstep.
const REPO_ROOT = path.resolve(import.meta.dirname, "..")
const workspaceAliases = [
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
const HOOK_CALLING_DEPS = [
  /^@base-ui\//,
  /^@radix-ui\//,
  /^@phosphor-icons\//,
  /^vaul$/,
  /^lucide-react$/,
]

export default defineConfig(({ mode }) => ({
  // React Compiler — opt-in auto-memoization. compilationMode "annotation"
  // compiles only components/hooks carrying a "use memo" directive; everything
  // else is left untouched. The preset's applyToEnvironmentHook also scopes it
  // to the browser ("client") environment, so server components and their
  // read-tracking / fingerprinting are never compiled. It runs through
  // @rolldown/plugin-babel because plugin-react@6's Oxc transform can't host
  // the compiler yet, and the babel pass must see original JSX — so it sits
  // alongside react().
  plugins: isTest
    ? [react(), tailwindcss()]
    : [
        rscCompression(),
        partonChannelServer(),
        rsc(),
        react(),
        babel({
          presets: [reactCompilerPreset({ target: "19", compilationMode: "annotation" })],
        }),
        tailwindcss(),
      ],
  server: mode === "clean" ? { port: 5174, strictPort: true, hmr: false, ws: false } : undefined,
  // Preview pinned to 5173 to match dev — same hard-coded URLs
  // work in both modes. Run `yarn preview:all` only when no dev
  // server is on 5173.
  preview: { port: 5173, strictPort: true },
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
