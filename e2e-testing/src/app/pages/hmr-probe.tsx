/**
 * /hmr-probe — fixture for the DEV-HMR LIVE-EDIT gate
 * (`e2e-testing/validate-hmr.mjs`), which rewrites MARKER on disk and
 * asserts the browser shows the new value live. The cached section
 * proves the byte cache (fp-keyed) misses after an edit too. Keep
 * MARKER exactly `"HMR_MARKER_A"` — the gate string-replaces it.
 */

import { parton, type RenderArgs } from "@parton/framework"

const MARKER = "HMR_MARKER_A"

const CachedSection = parton(
  function HmrProbeCachedRender(_: RenderArgs) {
    return <div data-testid="hmr-marker-cached">{MARKER}</div>
  },
  { selector: "#hmr-probe-cached", cache: { maxAge: 60 } },
)

export const HmrProbePage = parton(
  function HmrProbeRender(_: RenderArgs) {
    return (
      <main className="py-4">
        <title>HMR Probe</title>
        <h1>HMR probe</h1>
        <div data-testid="hmr-marker">{MARKER}</div>
        <CachedSection />
      </main>
    )
  },
  { match: "/hmr-probe" },
)
