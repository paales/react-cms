import { Partial } from "../../lib/partial.tsx"
import { ROOT } from "../../lib/partial-context.ts"
import { SelectorRefetchButton } from "../components/selector-demo-controls.tsx"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

/**
 * `/selector-demo` — exercises selector-based refetch.
 *
 *   <Partial parent={ROOT} parent={parent} selector=".product">                    // anonymous; addressable only via .product
 *   <Partial parent={ROOT} parent={parent} selector="#price-a .price">             // price family; each member has a `#`-token
 *   <Partial parent={ROOT} parent={parent} selector="#price-b .price .featured">   // same family, extra `.featured` label
 *
 * Buttons call `useNavigation().reload({selector: "..."})`. The selector
 * string uses CSS grammar: `#foo` (unique) and `.foo` (shared), space
 * separated. Tokens are resolved server-side against the route-scoped
 * partial registry, so dynamic partials (produced inside opaque
 * components, `.map()` loops, etc.) are addressable the same as static
 * ones. Every Partial renders a fresh server timestamp so a visible
 * refresh maps 1-to-1 with the target set.
 */

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

export function SelectorDemoPage() {
  return (
    <main className="py-4">
      <title>Selector Demo</title>
      <h1 className="mb-4 text-2xl font-semibold">Selector-based refetch</h1>
      <p className="mb-8 text-muted-foreground">
        <InlineCode>useNavigation().reload({'{selector: ".price"}'})</InlineCode> refetches every
        Partial carrying that class token. Multiple tokens union:{" "}
        <InlineCode>{'{selector: ".price .featured"}'}</InlineCode> hits any Partial with either
        label. <InlineCode>#foo</InlineCode> targets a single Partial.
      </p>

      <Card className="mb-6 p-5">
        <CardHeader className="px-0">
          <CardTitle className="text-base">
            <InlineCode>&lt;Partial selector=".product"&gt;</InlineCode> — anonymous
          </CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          <p className="mb-3 text-sm text-muted-foreground">
            No <InlineCode>#</InlineCode>-token. Synthesizes{" "}
            <InlineCode>__anon:.product</InlineCode> internally. Only addressable via{" "}
            <InlineCode>.product</InlineCode>.
          </p>
          <Partial parent={ROOT} selector=".product">
            <ServerTime label="product" />
          </Partial>
        </CardContent>
      </Card>

      <Card className="mb-6 p-5">
        <CardHeader className="px-0">
          <CardTitle className="text-base">
            <InlineCode>&lt;Partial selector=".price"&gt;</InlineCode> family
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 px-0">
          <p className="text-sm text-muted-foreground">
            Three siblings sharing <InlineCode>.price</InlineCode>; two also carry{" "}
            <InlineCode>.featured</InlineCode>. Selector unions let you refresh a subset without
            plumbing ids through props.
          </p>
          <Partial parent={ROOT} selector="#price-a .price">
            <ServerTime label="price-a" />
          </Partial>
          <Partial parent={ROOT} selector="#price-b .price .featured">
            <ServerTime label="price-b" />
          </Partial>
          <Partial parent={ROOT} selector="#price-c .price .featured">
            <ServerTime label="price-c" />
          </Partial>
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
}
