import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: "./e2e",
  timeout: 30000,
  // Workers > 1 is safe now: `e2e/fixtures.ts` stamps every request
  // with a per-worker `x-test-scope` header, and the framework (see
  // `framework/context.ts` — `deriveScope`) routes each request to
  // its own bucket of process-wide state (<Cache>, registry,
  // session, GraphQL cache). Default (`undefined`) lets Playwright
  // pick based on CPU count.
  fullyParallel: true,
  use: {
    baseURL: "http://localhost:5179",
    headless: true,
  },
  webServer: {
    command: "yarn dev --port 5179",
    url: "http://localhost:5179",
    reuseExistingServer: true,
    timeout: 60000,
  },
})
