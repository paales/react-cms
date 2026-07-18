import path from "node:path"
import babel from "@rolldown/plugin-babel"
import react, { reactCompilerPreset } from "@vitejs/plugin-react"
import rsc from "@vitejs/plugin-rsc"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "vite"
import { partonChannelServer } from "@parton/framework/vite/channel-server.ts"
import { rscCompression } from "@parton/framework/vite/compression.ts"

// This example keeps its own tiny content store, gitignored like every
// sibling app's `data/` — anchored here (not `process.cwd()`) because
// bundled code can't reach the workspace root by cwd in preview mode.
const DATA_DIR = path.resolve(import.meta.dirname, "data")
process.env.CMS_DATA_DIR ??= DATA_DIR

// Resolve `@parton/framework` straight to its TypeScript source — the
// same alias every sibling app carries, so edits to the framework show
// up here without a build step.
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..")
const workspaceAliases = [
  {
    find: /^@parton\/framework\/(.*)/,
    replacement: path.resolve(REPO_ROOT, "framework/src/$1"),
  },
  {
    find: /^@parton\/framework$/,
    replacement: path.resolve(REPO_ROOT, "framework/index.ts"),
  },
]

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
    port: 5177,
    // Cell storage lives in data/ inside this workspace; writes are
    // runtime state, not source — without the ignore, every cell
    // persist triggers vite's full-reload and the page loops.
    watch: { ignored: ["**/examples/minimal/data/**"] },
  },
  preview: { port: 5177, strictPort: true },
  environments: {
    rsc: {
      build: {
        rollupOptions: {
          input: { index: "./src/entry.rsc.tsx" },
        },
      },
    },
    ssr: {
      build: {
        rollupOptions: {
          input: { index: "./src/entry.ssr.tsx" },
        },
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
}))
