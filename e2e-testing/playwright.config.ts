import { defineConfig } from "@playwright/test"

// Single source for both dev-server ports. A worktree remap (see
// CLAUDE.md § Working in a worktree) changes only these two
// constants; everything below — baseURL, webServer commands and
// readiness URLs, the remote-binding origin, the cross-origin spec —
// derives from them.
const PORT = 5179
const MAGENTO_PORT = 5181
const MAGENTO_ORIGIN = `http://localhost:${MAGENTO_PORT}`

// Thread the magento origin to everything that needs it: the host dev
// server (the generated remote bindings in `src/remote/magento/` read
// it), and the spec workers (`remote-frame-crossorigin.spec.ts` reads
// it for direct wire-level fetches). Playwright spawns both the
// webServer commands and the worker processes from this process, so
// they inherit it.
process.env.MAGENTO_REMOTE_ORIGIN = MAGENTO_ORIGIN

// Record/replay for PokeAPI queries (see `src/app/gql-disk-cache.ts`):
// the suite's query set is deterministic, and PokeAPI rate-limits by
// IP under repeated full-suite runs — a mid-spec 429 is
// indistinguishable from an app bug. The spawned dev server inherits
// this; a plain `yarn dev` stays live.
process.env.GQL_DISK_CACHE = "1"

export default defineConfig({
  testDir: "./e2e",
  // Preview-tier specs live under `e2e/preview/` and run via the
  // separate `playwright.preview.config.ts` (port 5181, build+preview).
  // Skipping the directory here keeps `yarn test:e2e` (dev tier, port
  // 5179) from picking them up — assertions about production-bundle
  // streaming wouldn't hold against the dev server.
  testIgnore: ["preview/**"],
  timeout: 30000,
  // Give-up bound for `expect` polls. Every wait in the suite is on a
  // real signal (a marker, a locator, a server-stamped value) — this
  // only sets how long a signal gets to arrive before the test is
  // declared red. The 5s default is calibrated for an idle machine; a
  // saturated dev box (parallel workers + two dev servers) can push a
  // legitimate roundtrip past it without anything being wrong.
  expect: { timeout: 10_000 },
  // On CI a saturated runner (parallel workers + two dev servers + the live
  // PokeAPI/GraphCommerce backends) turns transient wobble into spurious
  // reds. A retry re-runs the exact failing spec against a real signal, so a
  // flake passes while a genuine regression still fails all attempts —
  // nothing is hidden. Local runs stay at 0: a flake there is a signal to
  // chase, not to paper over.
  retries: process.env.CI ? 2 : 0,
  // Workers > 1 is safe: `e2e/fixtures.ts` stamps every request with
  // a per-worker `x-test-scope` header, and the framework (see
  // `framework/src/runtime/context.ts` — `deriveScope`) routes each
  // request to its own bucket of process-wide state (<Cache>, registry,
  // session, GraphQL cache). Capped at 6 rather than Playwright's
  // CPU-count default: every worker renders through ONE dev-server
  // process, and past ~6 concurrent heavy RSC renders (the browse
  // page alone is ~100 sections) the server's p99 latency blows past
  // the specs' give-up bounds without anything being wrong.
  fullyParallel: true,
  workers: 6,
  use: {
    baseURL: `http://localhost:${PORT}`,
    headless: true,
  },
  projects: [
    // Serial pre-pass that visits every route once (see
    // `e2e/warmup.setup.ts`). A fresh dev server compiles each page's
    // module graph on first hit and discovers optimizer deps lazily;
    // without the warmup, the parallel spec storm pays those costs
    // mid-assertion (slow first paints, optimizer-triggered reloads).
    // The warmup absorbs them before any spec runs.
    {
      name: "warmup",
      testMatch: /warmup\.setup\.ts/,
    },
    {
      name: "chromium",
      testMatch: /.*\.spec\.ts/,
      dependencies: ["warmup"],
    },
  ],
  webServer: [
    {
      // Resolved within the e2e-testing workspace — `yarn dev` runs
      // `vite` here.
      command: `yarn dev --port ${PORT}`,
      url: `http://localhost:${PORT}`,
      reuseExistingServer: true,
      timeout: 60000,
    },
    {
      // The e2e-magento companion app — hosts the remote partons the
      // cross-origin `<RemoteFrame>` specs (and /remote-frame-
      // crossorigin-demo) fetch at `/__remote/<id>`. The readiness URL
      // is a real remote endpoint rather than `/`, so the first parton
      // compile happens here instead of inside a spec's timeout.
      command: `yarn workspace @parton/e2e-magento dev --port ${MAGENTO_PORT}`,
      url: `${MAGENTO_ORIGIN}/__remote/magento-greeting`,
      reuseExistingServer: true,
      timeout: 120000,
    },
  ],
})
