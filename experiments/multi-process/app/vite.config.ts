import path from "node:path"
import react from "@vitejs/plugin-react"
import rsc from "@vitejs/plugin-rsc"
import { defineConfig } from "vite"

// The harness app keeps its own tiny content dir (the framework's CMS
// runtime resolves CMS_DATA_DIR even for apps that never touch CMS
// content) — anchored here because preview-mode bundles can't reach it
// by cwd.
const DATA_DIR = path.resolve(import.meta.dirname, "data")
process.env.CMS_DATA_DIR ??= DATA_DIR

// Resolve `@parton/framework` straight to its TypeScript source — the
// same alias every sibling app carries, so the harness always runs the
// framework as it exists in the working tree.
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..")
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
  plugins: [rsc(), react()],
  // The harness spawns each backend with `vite preview --port <n>`
  // (5691/5692 — the 56xx band, never the canonical e2e ports).
  preview: { strictPort: true },
  environments: {
    rsc: {
      build: {
        rollupOptions: {
          input: { index: "./src/entry.rsc.tsx" },
        },
      },
      resolve: {
        // Native module — must be require()d from node_modules at
        // runtime, never bundled.
        external: ["better-sqlite3"],
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
