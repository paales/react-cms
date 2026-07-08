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
 *   - `node` (jsdom, fast, default — see the root vitest.config.ts)
 *   - `rsc`  (Node + react-server condition, see ./vitest.rsc.config.ts)
 *
 * Only files matching `*.browser.test.{ts,tsx}` run here; separate
 * glob keeps accidental jsdom tests from paying the browser boot
 * cost.
 *
 * Lives in framework/ because the only browser test today
 * (click-counter.browser.test.tsx) is part of the framework's test
 * harness suite.
 */
const REPO_ROOT = path.resolve(import.meta.dirname, "..")

export default defineProject({
  plugins: [react()],
  resolve: {
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
  test: {
    name: "browser",
    dir: REPO_ROOT,
    include: ["{framework,cms,copies,e2e-testing,e2e-magento}/**/*.browser.test.?(c|m)[jt]s?(x)"],
    setupFiles: ["./vitest.browser.setup.ts"],
    browser: {
      enabled: true,
      provider: "playwright",
      headless: true,
      instances: [{ browser: "chromium" }],
    },
  },
})
