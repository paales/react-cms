import path from "node:path"
import babel from "@rolldown/plugin-babel"
import react, { reactCompilerPreset } from "@vitejs/plugin-react"
import rsc from "@vitejs/plugin-rsc"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "vite"
import { partonChannelServer } from "@parton/framework/vite/channel-server.ts"
import { rscCompression } from "@parton/framework/vite/compression.ts"

// The website keeps its own content store — it never shares the e2e
// apps' CMS data. Anchored here because bundled code can't reach the
// workspace root by cwd in preview mode.
const WEBSITE_CMS_DATA_DIR = path.resolve(import.meta.dirname, "data")
process.env.CMS_DATA_DIR ??= WEBSITE_CMS_DATA_DIR

// Workspace alias map — same shape as the sibling apps so the
// framework and copies resolve from source in dev.
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
    find: /^@parton\/copies\/(.*)/,
    replacement: path.resolve(REPO_ROOT, "copies/src/$1"),
  },
  {
    find: /^@parton\/copies$/,
    replacement: path.resolve(REPO_ROOT, "copies/index.ts"),
  },
  { find: "@", replacement: path.resolve(import.meta.dirname, "src") },
]

// Hook-calling node_modules must bundle with React in every
// environment — see the note in e2e-testing/vite.config.ts.
const HOOK_CALLING_DEPS = [/^@base-ui\//, /^@radix-ui\//, /^lucide-react$/]

export default defineConfig(() => ({
  plugins: [
    // Serve the opt-in WebSocket channel transport's `/__parton/ws`
    // upgrade in dev + preview (additive — the default fetch transport is
    // untouched, and only a page opting in with `?transport=ws` uses it).
    partonChannelServer(),
    rscCompression(),
    rsc(),
    react(),
    babel({
      presets: [reactCompilerPreset({ target: "19", compilationMode: "annotation" })],
    }),
    tailwindcss(),
  ],
  server: {
    port: 5183,
    // The cell storage lives in data/ inside this workspace; writes
    // are runtime state, not source — without the ignore, every cell
    // persist triggers vite's full-reload and the page loops.
    watch: { ignored: ["**/website/data/**"] },
  },
  preview: { port: 5183, strictPort: true },
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
        // Hidden client sourcemaps when the client-scroll benchmark builds
        // (`PARTON_BENCH_SOURCEMAP=1` — see bench/client-scroll.mjs): the
        // CPU profile's minified call frames symbolicate back to real
        // function names + source file:line. "hidden" emits the `.map`
        // files without a runtime `sourceMappingURL` comment, so the shipped
        // bundle is byte-identical to a plain build save the sidecar maps.
        sourcemap: process.env.PARTON_BENCH_SOURCEMAP ? ("hidden" as const) : false,
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
  ssr: {
    noExternal: HOOK_CALLING_DEPS,
  },
}))
