import path from "node:path"
import react from "@vitejs/plugin-react"
import rsc from "@vitejs/plugin-rsc"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "vite"

// Mirror of e2e-testing/vite.config.ts. The two showcases share the
// framework runtime; this one defaults its dev port to 5181 so both
// can boot side-by-side.

const isTest = process.env.VITEST === "true"

const REPO_CMS_DATA_DIR = path.resolve(import.meta.dirname, "..", "cms", "data")
process.env.CMS_DATA_DIR ??= REPO_CMS_DATA_DIR

// Mirror e2e-testing/vite.config.ts — DOCS_DIR pins chat-overlay's
// markdown source so bundled-preview cwd quirks can't strand the
// path.
const REPO_DOCS_DIR = path.resolve(import.meta.dirname, "..", "docs")
process.env.DOCS_DIR ??= REPO_DOCS_DIR

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

export default defineConfig({
  plugins: isTest ? [react(), tailwindcss()] : [rsc(), react(), tailwindcss()],
  server: { port: 5181, strictPort: true },
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
})
