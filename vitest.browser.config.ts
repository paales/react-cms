import path from "node:path"
import react from "@vitejs/plugin-react"
import { defineProject } from "vitest/config"

/**
 * Vitest browser-mode project. Runs tests in real Chromium via the
 * Playwright provider (we already ship `@playwright/test`). Intended
 * for tests that need real DOM primitives jsdom stubs poorly or not
 * at all — focus semantics, scroll/measurement, the Navigation API,
 * cross-frame event ordering.
 *
 * Lives alongside:
 *   - `node` (jsdom, fast, default — see vite.config.ts)
 *   - `rsc`  (Node + react-server condition, see vitest.rsc.config.ts)
 *
 * Only files matching `*.browser.test.{ts,tsx}` run here; separate
 * glob keeps accidental jsdom tests from paying the browser boot
 * cost.
 */
export default defineProject({
  plugins: [react()],
  resolve: {
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
  test: {
    name: "browser",
    include: [
      "{framework,cms,copies,e2e-testing,e2e-magento}/**/*.browser.test.?(c|m)[jt]s?(x)",
    ],
    setupFiles: ["./vitest.browser.setup.ts"],
    browser: {
      enabled: true,
      provider: "playwright",
      headless: true,
      instances: [{ browser: "chromium" }],
    },
  },
})
