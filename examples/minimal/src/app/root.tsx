import { PartialRoot } from "@parton/framework"
import { HelloWorld, NestedParton, Matching } from "./greeting-page.tsx"
import { NotFoundFallback } from "./no-route-fallback.tsx"

export function Root() {
  return (
    <PartialRoot>
      <html lang="en">
        <head>
          <meta charSet="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>parton — minimal example</title>
        </head>
        <body style={{ fontFamily: "system-ui" }}>
          <HelloWorld />
          <Matching />
          <NotFoundFallback />
        </body>
      </html>
    </PartialRoot>
  )
}
