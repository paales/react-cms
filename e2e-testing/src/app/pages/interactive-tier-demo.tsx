/**
 * /interactive-tier-demo — the Interactive grant.
 *
 * One e2e-magento page embedded twice, cross-origin:
 *
 *  - under `grant="interactive"`, the vocabulary's interactive
 *    members survive the splice and the host-bundle interaction
 *    bridge wires them: the quantity TextField writes the REMOTE's
 *    cell (capability-scoped `/__remote/cells/write`, display-local-
 *    first optimistic echo), the bid Button invokes the REMOTE's
 *    `place-bid` embedAction, and the settled hop refreshes this host
 *    parton (`@self`) for the server echo;
 *  - under `grant="paint"`, the SAME rows degrade in place (DEV: the
 *    visible violation markers) while the paint-safe siblings paint.
 *
 * The interactive embed sits inside THIS addressable parton — that is
 * the authoring rule the bridge's `@self` refresh relies on.
 */

import { parton, type RenderArgs } from "@parton/framework"
import { VocabularyStyles } from "@parton/framework/lib/vocabulary.tsx"
import { Suspense } from "react"
import { MagentoInteractivePanel, MagentoInteractivePanelPaint } from "../../remote/magento"

export const InteractiveTierDemoPage = parton(
  function InteractiveTierDemoRender(_: RenderArgs) {
    return (
      <main className="py-4 space-y-4">
        <title>Interactive tier demo</title>
        <VocabularyStyles />
        <style href="interactive-tier-demo-boxes" precedence="default">
          {`[data-testid="interactive-demo"] parton-embed-box{height:360px}
[data-testid="interactive-demo-paint"] parton-embed-box{height:360px}`}
        </style>
        <header>
          <h1 className="text-2xl font-semibold">Interactive tier demo</h1>
          <p className="text-sm text-muted-foreground">
            The same remote page under <code>grant="interactive"</code> (live controls, remote-
            hosted cells and actions) and <code>grant="paint"</code> (those rows degrade).
          </p>
        </header>
        <section data-testid="interactive-demo">
          <Suspense fallback={<p data-testid="interactive-demo-fallback">Loading interactive…</p>}>
            <MagentoInteractivePanel />
          </Suspense>
        </section>
        <section data-testid="interactive-demo-paint">
          <Suspense fallback={<p>Loading paint copy…</p>}>
            <MagentoInteractivePanelPaint />
          </Suspense>
        </section>
      </main>
    )
  },
  { match: "/interactive-tier-demo", selector: "#interactive-tier-demo" },
)
