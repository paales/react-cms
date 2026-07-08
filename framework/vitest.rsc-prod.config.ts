import path from "node:path"
import rscConfig from "./vitest.rsc.config.ts"

/**
 * The rsc tier, but against the PRODUCTION react-server-dom Flight build.
 *
 * `@vitejs/plugin-rsc/vendor/react-server-dom/server.edge` branches on
 * `process.env.NODE_ENV` at require-time — `"production"` loads the prod
 * `.production.js` build, anything else the dev build. The regular `rsc`
 * tier (and `test:e2e`) run the DEV build, so a bug that only manifests in
 * the prod build's task scheduling ships green on every tier. This config
 * exists to close that gap: `yarn test:rsc:prod` runs it with
 * `NODE_ENV=production`, so the worker requires the prod Flight build.
 *
 * It reuses the `rsc` project wholesale (plugins, the `react-server`
 * condition, aliases, inlined deps) and only swaps the project name and the
 * include glob — prod-build tests are named `*.rsc-prod.test.{ts,tsx}` so
 * they never run under the dev `rsc` tier. The tests themselves
 * `describe.skipIf(NODE_ENV !== "production")`, so a stray all-projects
 * `vitest run` skips them rather than asserting against the wrong build.
 */
const REPO_ROOT = path.resolve(import.meta.dirname, "..")

export default {
  ...rscConfig,
  test: {
    ...rscConfig.test,
    name: "rsc-prod",
    dir: REPO_ROOT,
    include: ["{framework,cms,copies,e2e-testing,e2e-magento}/**/*.rsc-prod.test.?(c|m)[jt]s?(x)"],
  },
}
