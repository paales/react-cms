/**
 * /selector-demo — exercises selector-based refetch with `#`-unique and
 * `.`-shared tokens.
 */

import { ReactCms, type RenderArgs } from "@react-cms/framework"
import { SelectorRefetchButton } from "../components/selector-demo-controls.tsx"
import { Card, CardContent, CardHeader, CardTitle } from "@react-cms/copies/components/ui/card"

function ServerTime({ label }: { label: string }) {
  return (
    <div data-testid={`time-${label}`} className="font-mono">
      <strong>{label}:</strong> {new Date().toISOString()}
    </div>
  )
}

function InlineCode({ children }: { children: React.ReactNode }) {
  return <code className="rounded bg-muted px-1.5 py-0.5 text-[0.85em] font-mono">{children}</code>
}

export const ProductAnonymousPartial = ReactCms.partial(
  function ProductAnonymousRender({}: RenderArgs) {
    return <ServerTime label="product" />
  },
  { selector: ".product" },
)

export const PriceAPartial = ReactCms.partial(
  function PriceARender({}: RenderArgs) {
    return <ServerTime label="price-a" />
  },
  { selector: "#price-a .price" },
)

export const PriceBPartial = ReactCms.partial(
  function PriceBRender({}: RenderArgs) {
    return <ServerTime label="price-b" />
  },
  { selector: "#price-b .price .featured" },
)

export const PriceCPartial = ReactCms.partial(
  function PriceCRender({}: RenderArgs) {
    return <ServerTime label="price-c" />
  },
  { selector: "#price-c .price .featured" },
)

export const SelectorDemoPage = ReactCms.partial(
  function SelectorDemoRender({ parent }: RenderArgs) {
    return (
      <main className="py-4">
        <title>Selector Demo</title>
        <h1 className="mb-4 text-2xl font-semibold">Selector-based refetch</h1>
        <p className="mb-8 text-muted-foreground">
          <InlineCode>useNavigation().reload({'{selector: ".price"}'})</InlineCode> refetches every
          Partial carrying that class token.
        </p>

        <Card className="mb-6 p-5">
          <CardHeader className="px-0">
            <CardTitle className="text-base">
              <InlineCode>selector=".product"</InlineCode> — anonymous
            </CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            <ProductAnonymousPartial parent={parent} />
          </CardContent>
        </Card>

        <Card className="mb-6 p-5">
          <CardHeader className="px-0">
            <CardTitle className="text-base">
              <InlineCode>.price</InlineCode> family
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 px-0">
            <PriceAPartial parent={parent} />
            <PriceBPartial parent={parent} />
            <PriceCPartial parent={parent} />
          </CardContent>
        </Card>

        <Card className="p-5">
          <CardHeader className="px-0">
            <CardTitle className="text-base">Refetch controls</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2 px-0">
            <SelectorRefetchButton
              selector=".product"
              label="refetch .product"
              testId="refresh-product"
            />
            <SelectorRefetchButton
              selector=".price"
              label="refetch .price (3 partials)"
              testId="refresh-price"
            />
            <SelectorRefetchButton
              selector=".featured"
              label="refetch .featured (2 partials)"
              testId="refresh-price-featured"
            />
            <SelectorRefetchButton
              selector="#price-a"
              label="refetch #price-a"
              testId="refresh-price-a"
            />
          </CardContent>
        </Card>
      </main>
    )
  },
  { match: "/selector-demo" },
)
