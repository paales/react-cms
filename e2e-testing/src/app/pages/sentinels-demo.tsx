/**
 * /sentinels-demo + /not-found-demo + /redirect-demo.
 *
 * Three independent page specs, each gating its own URL:
 *  - `SentinelsDemoPage` — UI on /sentinels-demo
 *  - `NotFoundDemoPage` — calls `notFound()` on /not-found-demo
 *  - `RedirectDemoPage` — calls `redirect()` on /redirect-demo
 */

import { ReactCms, type RenderArgs } from "@react-cms/framework"
import { notFound } from "@react-cms/framework/framework/errors.ts"
import { setFrameworkControl } from "@react-cms/framework/framework/context.ts"
import { Redirect } from "@react-cms/framework/framework/redirect-client.tsx"
import { Card, CardContent, CardHeader, CardTitle } from "@react-cms/copies/components/ui/card"
import { Badge } from "@react-cms/copies/components/ui/badge"
import { buttonVariants } from "@react-cms/copies/components/ui/button"

function InlineCode({ children }: { children: React.ReactNode }) {
  return <code className="rounded bg-muted px-1.5 py-0.5 text-[0.85em] font-mono">{children}</code>
}

function StatusBadge({ status }: { status: 404 | 302 | 200 }) {
  const variant = status === 404 ? "destructive" : status === 302 ? "secondary" : "outline"
  return (
    <Badge variant={variant} className="ml-2">
      HTTP {status}
    </Badge>
  )
}

export const NotFoundDemoPage = ReactCms.partial(
  function NotFoundDemoTriggerRender() {
    notFound()
  },
  { match: "/not-found-demo" },
)

export const RedirectDemoPage = ReactCms.partial(
  function RedirectDemoTriggerRender() {
    // Set framework control so the HTML path emits a 302; render
    // <Redirect> so the RSC path commits with a client-side
    // navigate. No throwing — the tree-level control channel is
    // enough for both paths.
    setFrameworkControl({ redirect: { url: "/cache-demo", status: 302 } })
    return <Redirect url="/cache-demo" />
  },
  { match: "/redirect-demo" },
)

export const SentinelsDemoPage = ReactCms.partial(
  function SentinelsDemoRender({}: RenderArgs) {
    return (
      <main className="py-4">
        <title>Sentinels Demo</title>
        <h1 className="mb-4 text-2xl font-semibold">notFound() + redirect() — the sentinels</h1>

        <Card className="mb-4 p-5">
          <CardHeader className="px-0">
            <CardTitle className="flex flex-wrap items-center gap-1 text-base">
              1. <InlineCode>notFound()</InlineCode> — sync throw
              <StatusBadge status={404} />
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col items-start gap-3 px-0">
            <a
              href="/not-found-demo"
              data-testid="link-not-found-sync"
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              /not-found-demo →
            </a>
          </CardContent>
        </Card>

        <Card className="mb-4 p-5">
          <CardHeader className="px-0">
            <CardTitle className="flex flex-wrap items-center gap-1 text-base">
              2. <InlineCode>notFound()</InlineCode> — deep async throw
              <StatusBadge status={404} />
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col items-start gap-3 px-0">
            <a
              href="/pokemon/9999999"
              data-testid="link-not-found-async"
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              /pokemon/9999999 →
            </a>
          </CardContent>
        </Card>

        <Card className="mb-4 p-5">
          <CardHeader className="px-0">
            <CardTitle className="flex flex-wrap items-center gap-1 text-base">
              3. <InlineCode>redirect()</InlineCode>
              <StatusBadge status={302} />
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col items-start gap-3 px-0">
            <a
              href="/redirect-demo"
              data-testid="link-redirect-html"
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              /redirect-demo →
            </a>
          </CardContent>
        </Card>
      </main>
    )
  },
  { match: "/sentinels-demo" },
)
