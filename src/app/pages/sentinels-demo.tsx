import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { buttonVariants } from "@/components/ui/button"

/**
 * `/sentinels-demo` — click-through page for the `notFound()` +
 * `redirect()` framework sentinels. Each link triggers a different
 * path through the mechanism; check devtools Network for status codes.
 */

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

export function SentinelsDemoPage() {
  return (
    <main className="py-4">
      <title>Sentinels Demo</title>
      <h1 className="mb-4 text-2xl font-semibold">notFound() + redirect() — the sentinels</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        Two framework helpers (<InlineCode>src/framework/errors.ts</InlineCode>) mutate a
        request-scoped control channel and throw. The entry handler picks them up and adjusts the
        HTTP response. Click any link, then check the Network panel for the status code.
      </p>

      <Card className="mb-4 p-5">
        <CardHeader className="px-0">
          <CardTitle className="flex flex-wrap items-center gap-1 text-base">
            1. <InlineCode>notFound()</InlineCode> — sync throw from a page function
            <StatusBadge status={404} />
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col items-start gap-3 px-0">
          <p className="text-sm text-muted-foreground">
            <InlineCode>/not-found-demo</InlineCode>'s route handler calls{" "}
            <InlineCode>notFound()</InlineCode> synchronously from <InlineCode>Root</InlineCode>.
            The try/catch at the top of <InlineCode>Root</InlineCode> routes it to the control
            channel; handler returns 404 + the default{" "}
            <InlineCode>&lt;NotFoundPage/&gt;</InlineCode> body.
          </p>
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
          <p className="text-sm text-muted-foreground">
            <InlineCode>/pokemon/9999999</InlineCode> hits the live PokeAPI. The{" "}
            <InlineCode>HeroPartial</InlineCode> awaits the GraphQL query; the result is empty, so
            it calls <InlineCode>notFound()</InlineCode>. The throw happens during async rendering —{" "}
            <em>after</em> Root's sync catch has already returned. Because{" "}
            <InlineCode>notFound()</InlineCode> flags the control channel before throwing, the entry
            handler still sees the decision after <InlineCode>renderHTML</InlineCode> awaits, and
            re-renders with <InlineCode>&lt;NotFoundPage/&gt;</InlineCode> cleanly.
          </p>
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
            3. <InlineCode>redirect()</InlineCode> — HTML navigation
            <StatusBadge status={302} />
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col items-start gap-3 px-0">
          <p className="text-sm text-muted-foreground">
            <InlineCode>/redirect-demo</InlineCode> calls{" "}
            <InlineCode>redirect("/cache-demo")</InlineCode>. For an HTML request, the handler
            returns a native 302 + <InlineCode>Location</InlineCode> header and the browser follows.
          </p>
          <a
            href="/redirect-demo"
            data-testid="link-redirect-html"
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            /redirect-demo →
          </a>
        </CardContent>
      </Card>

      <Card className="mb-4 p-5">
        <CardHeader className="px-0">
          <CardTitle className="flex flex-wrap items-center gap-1 text-base">
            4. <InlineCode>redirect()</InlineCode> — client navigation via{" "}
            <InlineCode>&lt;Redirect&gt;</InlineCode>
            <StatusBadge status={200} />
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col items-start gap-3 px-0">
          <p className="text-sm text-muted-foreground">
            If you navigate to <InlineCode>/redirect-demo</InlineCode> via an RSC refetch (a link
            click after the app is hydrated, not a direct URL visit), the server can't emit a native
            302 — <InlineCode>fetch()</InlineCode> would transparently follow and commit the
            destination's payload for the current route. Instead the server renders a{" "}
            <InlineCode>&lt;Redirect url=…/&gt;</InlineCode> client component in the payload; its{" "}
            <InlineCode>useEffect</InlineCode> calls <InlineCode>navigation.navigate</InlineCode> on
            mount.
          </p>
          <a
            href="/redirect-demo"
            data-testid="link-redirect-rsc"
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            /redirect-demo (click from here) →
          </a>
        </CardContent>
      </Card>
    </main>
  )
}
