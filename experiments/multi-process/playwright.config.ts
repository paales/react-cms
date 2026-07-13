import { defineConfig } from "@playwright/test"

/**
 * Multi-process scenarios — run against the sticky-proxy harness
 * (`harness.mjs`: proxy :5690 → two `vite preview` backends
 * :5691/:5692 off one build of `./app`, bump broker :5699, shared
 * SQLite store). The 56xx band never collides with the canonical e2e
 * servers (5179/5181/5183).
 *
 * One worker, no parallelism: the scenarios share the harness's
 * cross-process state on purpose (that IS the subject under test), and
 * the failover scenario kills/respawns backends.
 *
 * Run from the repo root:
 *
 *   (cd experiments/multi-process/app && ../../../node_modules/.bin/vite build)
 *   node_modules/.bin/playwright test --config experiments/multi-process/playwright.config.ts
 */
export default defineConfig({
  testDir: "./scenarios",
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  expect: { timeout: 15_000 },
  use: {
    baseURL: "http://localhost:5690",
    headless: true,
  },
  webServer: {
    command: "node harness.mjs",
    url: "http://localhost:5690/__harness/status",
    reuseExistingServer: true,
    timeout: 60_000,
  },
})
