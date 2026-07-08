import "./styles.css"
// Side-effect import — registers the partons this app exposes as
// `<RemoteFrame>` endpoints in the spec catalog.
import "./remote-specs.tsx"
import { PartialRoot } from "@parton/framework"

export function Root() {
  return (
    <PartialRoot>
      <html lang="en">
        <head>
          <meta charSet="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <title>e2e-magento — showcase</title>
        </head>
        <body>
          <main>
            <h1>e2e-magento</h1>
            <p>
              Empty showcase scaffold. Real Magento integration lands here as partials are added.
            </p>
          </main>
        </body>
      </html>
    </PartialRoot>
  )
}
