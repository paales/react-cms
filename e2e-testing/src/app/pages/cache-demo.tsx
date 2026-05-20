/**
 * /cache-demo — server-side render-output caching spike.
 *
 * Outer wrapper gates the route once. `Slow` is cached via
 * `vary: ({time}) => ({expiresAt: time.in(60_000)})` and varies by
 * `flavor`; `Clock` stays uncached (no `expiresAt`).
 */

import { parton, getScope, type RenderArgs } from "@parton/framework"
// `_cacheStats` is a framework-internal diagnostic surface — kept on
// the deep path because the demo intentionally peeks at internals.
import { _cacheStats } from "@parton/framework/lib/cache.tsx"
import { CacheControls } from "../components/cache-controls.tsx"
import { ClickCounter } from "../components/click-counter.tsx"

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

const slowRenderCounts = new Map<string, number>()
function bumpSlowRender(): number {
  const scope = getScope()
  const next = (slowRenderCounts.get(scope) ?? 0) + 1
  slowRenderCounts.set(scope, next)
  return next
}

function Code({ children, ...rest }: React.ComponentProps<"code">) {
  return (
    <code {...rest} className="rounded bg-muted px-1.5 py-0.5 text-[0.85em] font-mono">
      {children}
    </code>
  )
}

// ─── Inner specs ───────────────────────────────────────────────────────

const Intro = parton(
  async function CacheDemoIntroRender({ flavor }: { flavor: string } & RenderArgs) {
    const stats = await _cacheStats()
    return (
      <>
        <title>Cache Demo</title>
        <h1 className="mb-4 text-2xl font-semibold">Server-side cache spike</h1>
        <p className="mb-4 text-muted-foreground">
          flavor=<Code>{flavor}</Code> · cache size:{" "}
          <Code data-testid="cache-size">{stats.size}</Code>
        </p>
        <CacheControls />
      </>
    )
  },
)

// `flavor` flows from the wrapper's `vary` as a JSX call-site prop.
// On a partial-refetch (`?partials=slow`) the wrapper is bypassed —
// `<CacheControls>`'s Toggle button explicitly forwards the new
// flavor via `nav.navigate(..., { props: { slow: { flavor } } })`,
// which the server splices in on top of the snapshot-replayed props.
const Slow = parton(
  async function CacheDemoSlowRender({ flavor }: { flavor: string } & RenderArgs) {
    const slowRenderCount = bumpSlowRender()
    await delay(500)
    return (
      <div
        data-testid="slow-content"
        data-render-count={slowRenderCount}
        className="mb-2 rounded-lg bg-card p-4"
      >
        <div className="font-semibold">Slow content (flavor: {flavor})</div>
        <div className="mt-1 text-xs text-muted-foreground">
          rendered {slowRenderCount} time{slowRenderCount === 1 ? "" : "s"} · computed at{" "}
          {new Date().toISOString()}
        </div>
        <div className="mt-3">
          <ClickCounter />
        </div>
      </div>
    )
  },
  {
    selector: "#slow",
    vary: ({ time }) => ({ expiresAt: time.in(60_000) }),
    fallback: <div data-testid="slow-fallback">Loading slow…</div>,
  },
)

const Clock = parton(
  function CacheDemoClockRender() {
    return (
      <div data-testid="clock-content" className="mb-2 rounded-lg bg-muted p-4">
        <div className="font-semibold">Clock (always fresh)</div>
        <div className="mt-1 text-xs text-muted-foreground">
          Server time: {new Date().toISOString()}
        </div>
      </div>
    )
  },
  { selector: "#clock", fallback: <div>Loading clock…</div> },
)

const Footer = parton(
  function CacheDemoFooterRender({ tick: _tick }: { tick: number } & RenderArgs) {
    return (
      <div className="mt-8 text-xs text-muted-foreground">
        Server <Code>slowRenderCount</Code>:{" "}
        <span data-testid="server-render-count">{slowRenderCounts.get(getScope()) ?? 0}</span>
        <br />
        Try: change <Code>?flavor=</Code>, refetch the slow partial, reload.
      </div>
    )
  },
  {
    vary: () => ({ tick: Date.now() }),
  },
)

// ─── Outer wrapper — matches /cache-demo, threads flavor down ─────────

export const CacheDemoPage = parton(
  function CacheDemoRender({ flavor, parent }: { flavor: string } & RenderArgs) {
    return (
      <>
        <Intro parent={parent} flavor={flavor} />
        <Slow parent={parent} flavor={flavor} />
        <Clock parent={parent} />
        <Footer parent={parent} />
      </>
    )
  },
  {
    match: "/cache-demo",
    vary: ({ search: { flavor = "vanilla" } }) => ({ flavor }),
  },
)
