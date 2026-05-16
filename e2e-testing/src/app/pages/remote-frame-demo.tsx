/**
 * /remote-frame-demo — same-origin `<RemoteFrame>` validation.
 *
 * Two pieces:
 *
 * 1. `RemoteGreeting` is a normal parton. Because every parton
 *    self-registers in the spec catalog, it's automatically
 *    addressable at `/__remote/remote-greeting` — the route handler
 *    in `entry.rsc.tsx` looks the id up via `getSpecById` and
 *    renders `<Component parent={ROOT} />` as a focused Flight
 *    stream. The bytes are exactly what an `await Component()` on
 *    the host side would produce.
 *
 * 2. `RemoteFrameDemoPage` is the host page. It embeds the remote
 *    greeting via `<RemoteFrame src="/__remote/remote-greeting">`.
 *    The framework fetches that URL, pipes the Flight bytes through
 *    `flight-rewrite.ts` (passthrough for same-origin — no module
 *    refs to translate), and decodes them into a tree that the
 *    outer Flight encoder splices into the host's response.
 *
 * Visual check: the page header has the host's request timestamp;
 * the remote greeting renders with the remote endpoint's render
 * timestamp. Both are server times, but distinguishable because
 * the remote endpoint and the host page run on slightly different
 * request boundaries.
 */

import { parton, RemoteFrame, type RenderArgs } from "@parton/framework"
import { Suspense } from "react"
import { Card, CardContent } from "@parton/copies/components/ui/card"

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

const RemoteGreeting = parton(
  async function RemoteGreetingRender({ parent: _parent }: RenderArgs) {
    // Simulate remote work — the host's render shouldn't block on
    // this. The Suspense in the host wraps the RemoteFrame so the
    // host paints its chrome first, then the remote streams in.
    await delay(400)
    return (
      <Card className="border-emerald-500/40 bg-emerald-500/5 p-4" data-testid="remote-greeting">
        <CardContent className="px-0">
          <div className="font-semibold text-emerald-300">Hello from the remote frame!</div>
          <div className="mt-1 text-xs text-muted-foreground">
            Rendered at <code>{new Date().toISOString()}</code> via{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 text-[0.85em] font-mono">
              /__remote/remote-greeting
            </code>
          </div>
        </CardContent>
      </Card>
    )
  },
)

export const RemoteFrameDemoPage = parton(
  function RemoteFrameDemoRender({ parent }: RenderArgs) {
    return (
      <>
        <header className="mb-4" data-testid="rfd-header">
          <h1 className="text-2xl font-semibold">Remote Frame Demo</h1>
          <p className="text-sm text-muted-foreground">
            Header (uncached host content) rendered at{" "}
            <code>{new Date().toISOString()}</code>.
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            The card below comes from a separate Flight stream fetched from{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 text-[0.85em] font-mono">
              /__remote/remote-greeting
            </code>
            . Same engine, separate request, stitched into this page via{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 text-[0.85em] font-mono">
              flight-rewrite
            </code>
            . The host's outer Flight encoder streams around the remote fetch — header
            and footer paint without waiting for the remote.
          </p>
        </header>

        <Suspense
          fallback={
            <Card
              className="border-dashed border-muted bg-muted/30 p-4 italic"
              data-testid="rfd-fallback"
            >
              <CardContent className="px-0 text-muted-foreground">
                Fetching remote greeting…
              </CardContent>
            </Card>
          }
        >
          <RemoteFrame src="/__remote/remote-greeting" parent={parent} />
        </Suspense>

        <footer className="mt-6 text-xs text-muted-foreground" data-testid="rfd-footer">
          Footer rendered at <code>{new Date().toISOString()}</code>.
        </footer>
      </>
    )
  },
  { match: "/remote-frame-demo" },
)
