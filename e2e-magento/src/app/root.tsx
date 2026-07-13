import "./styles.css"
import { PartialRoot, getEmbedGrants, parton } from "@parton/framework"
import {
  MagentoCheckoutStep,
  MagentoGreeting,
  MagentoPaymentSummary,
  MagentoStockTicker,
} from "./remote-specs.tsx"
import { MagentoPaintMixed, MagentoPaintSummary } from "./paint-specs.tsx"
import { MagentoInteractivePanel } from "./interactive-specs.tsx"
import { MagentoCartNote } from "./bound-specs.tsx"

/** The showcase landing content — gated to `/` so the embeddable
 *  `/remote/*` pages carry only their own parton in the body. */
const ShowcaseHome = parton(
  function ShowcaseHomeRender() {
    return (
      <section>
        <h1>e2e-magento</h1>
        <p>
          Companion app. The pages under <code>/remote/*</code> each host one parton — ordinary,
          individually-browsable pages the host app embeds with <code>&lt;RemoteFrame&gt;</code>.
        </p>
      </section>
    )
  },
  { match: "/" },
)

export function Root() {
  // The embed-surface variant: a vocabulary-constrained grant (Paint)
  // admits no raw HTML wrappers, so the shell chrome (`<main>` below)
  // would degrade at the host's splice — and take the page's content
  // subtree with it. The producer knows the grant it's rendering
  // under (`getEmbedGrants()` — decoded off the embed request), so it
  // renders just the paint surfaces, bare. Full-trust renders (and
  // ordinary browser visits) keep the showcase shell.
  const grants = getEmbedGrants()
  const paintSurface = grants !== null && !grants.has("client")
  return (
    <PartialRoot>
      <html lang="en">
        <head>
          <meta charSet="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <title>e2e-magento — showcase</title>
        </head>
        <body>
          {paintSurface ? (
            <>
              <MagentoPaintSummary />
              <MagentoPaintMixed />
              <MagentoInteractivePanel />
            </>
          ) : (
            <main>
              <ShowcaseHome />
              {/* Embeddable pages — each spec's `match` is its page. */}
              <MagentoGreeting />
              <MagentoCheckoutStep />
              <MagentoPaymentSummary />
              <MagentoStockTicker />
              {/* Paint-tier surfaces stay browsable standalone. */}
              <MagentoPaintSummary />
              <MagentoPaintMixed />
              <MagentoInteractivePanel />
              <MagentoCartNote />
            </main>
          )}
        </body>
      </html>
    </PartialRoot>
  )
}
