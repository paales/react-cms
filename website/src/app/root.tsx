import "./styles.css"
import { PartialRoot } from "@parton/framework"
import { WorldPage } from "./world/world-page.tsx"

export function Root() {
  return (
    <html lang="en" className="dark">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>parton — an RSC-native framework</title>
      </head>
      <body>
        <PartialRoot>
          <WorldPage />
        </PartialRoot>
      </body>
    </html>
  )
}
