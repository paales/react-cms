import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30000,
  // Tests share a single dev server with process-wide state (`<Cache>`,
  // the partial registry, cart cookies). Running them in parallel lets
  // workers contend on that state — one test's cached bytes or
  // registry entries interfere with another's assertions. Serialize
  // to keep the suite deterministic.
  workers: 1,
  use: {
    baseURL: "http://localhost:5173",
    headless: true,
  },
});
