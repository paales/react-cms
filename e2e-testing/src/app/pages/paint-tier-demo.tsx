/**
 * /paint-tier-demo — the Paint tier: `<RemoteFrame grant="paint">`.
 *
 * Both frames embed e2e-magento pages (port 5181) under a Paint
 * grant: the payload may reference only the framework vocabulary, the
 * host's tier rewriter degrades everything else at splice time, and
 * ZERO remote modules load in the browser. The host owns appearance:
 * `<VocabularyStyles/>` (the host-bundle resolution of the vocabulary
 * tags) plus the `--parton-*` custom properties set on the themed
 * wrapper below. The host also owns each embed's BOX — `contain:
 * strict` (size containment) means content never sizes it, hence the
 * explicit heights in the page-scoped stylesheet.
 */

import { parton } from "@parton/framework"
import { VocabularyStyles } from "@parton/framework/lib/vocabulary.tsx"
import { Suspense, type CSSProperties } from "react"
import { MagentoPaintMixed, MagentoPaintSummary } from "../../remote/magento"

const HOST_THEME = {
  // The e2e spec asserts this exact color computes on the embedded
  // `parton-text` elements — host CSS custom properties crossing the
  // containment boundary into the vocabulary.
  "--parton-text-color": "rgb(190, 24, 93)",
  "--parton-gap-md": "14px",
} as CSSProperties

export const PaintTierDemoPage = parton(
  function PaintTierDemoRender() {
    return (
      <>
        <VocabularyStyles />
        {/* Host-defined boxes: size the granted embeds. */}
        <style href="paint-tier-demo-boxes" precedence="default">
          {`[data-testid="paint-demo-themed"] parton-embed-box{height:340px}
[data-testid="paint-demo-mixed"] parton-embed-box{height:280px}`}
        </style>
        <header className="mb-4">
          <h1 className="text-2xl font-semibold">Paint tier demo</h1>
          <p className="text-sm text-muted-foreground">
            Two cross-origin embeds under <code>grant="paint"</code> — vocabulary only, zero remote
            module loading, host-themed via CSS custom properties.
          </p>
        </header>

        <section data-testid="paint-demo-themed" style={HOST_THEME} className="mb-6">
          <Suspense fallback={<p data-testid="paint-demo-summary-fallback">Loading summary…</p>}>
            <MagentoPaintSummary />
          </Suspense>
        </section>

        <section data-testid="paint-demo-mixed">
          <Suspense fallback={<p data-testid="paint-demo-mixed-fallback">Loading mixed…</p>}>
            <MagentoPaintMixed />
          </Suspense>
        </section>
      </>
    )
  },
  { match: "/paint-tier-demo", selector: "#paint-tier-demo" },
)
