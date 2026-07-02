/**
 * /remote-frame-demo — `<RemoteFrame>` validation surface.
 *
 * Exercises:
 *
 * 1. Three remote frames embedded in one host page, fetched in
 *    parallel against `/__remote/<id>`. Each spec self-registers
 *    in the catalog so the route handler resolves them by id.
 *
 * 2. Different remote latencies (200ms, 600ms, 1000ms) demonstrate
 *    parallel streaming — the slowest doesn't block the fastest.
 *
 * 3. A remote spec that renders a `"use client"` `<ClickCounter>` —
 *    validates client components inside a remote payload hydrate
 *    correctly in the host's browser.
 *
 * 4. A remote spec with `cache: { maxAge }` — second fetch hits the
 *    cache, returns immediately.
 *
 * 5. A refresh button driving `nav.reload({selector: "..."})` to
 *    re-fetch a remote frame. Same-origin v1: this round-trips
 *    through the host's local spec (same process). v2 cross-origin
 *    would need an explicit "this id is hosted at <origin>"
 *    annotation in the snapshot.
 */

import { parton, RemoteFrame, type RenderArgs } from "@parton/framework"
import { Suspense } from "react"
import { Card, CardContent } from "@parton/copies/components/ui/card"
import { Button } from "@parton/copies/components/ui/button"
import { ClickCounter } from "../components/click-counter.tsx"
import { RemoteRefreshButton } from "../components/remote-refresh-button.tsx"

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ─── Remote specs (auto-addressable at /__remote/<id>) ──────────────────

const RemoteFastGreeting = parton(
  async function RemoteFastGreetingRender(_: RenderArgs) {
    // Render interval stamped into the DOM: the parallel-streaming
    // e2e spec proves the remotes render CONCURRENTLY from interval
    // overlap (`started(slow) < finished(fast)`) — a server-clock
    // signal immune to client-side scheduling jitter.
    const startedAt = Date.now()
    await delay(200)
    return (
      <RemoteCard
        tone="emerald"
        testid="remote-fast"
        data-started-at={startedAt}
        data-finished-at={Date.now()}
      >
        <strong>Fast remote</strong> · 200ms · {new Date().toISOString()}
      </RemoteCard>
    )
  },
  { selector: "remote-fast" },
)

const RemoteMidGreeting = parton(
  async function RemoteMidGreetingRender(_: RenderArgs) {
    await delay(600)
    return (
      <RemoteCard tone="amber" testid="remote-mid">
        <strong>Mid remote</strong> · 600ms · {new Date().toISOString()}
      </RemoteCard>
    )
  },
  { selector: "remote-mid" },
)

const RemoteSlowGreeting = parton(
  async function RemoteSlowGreetingRender(_: RenderArgs) {
    // See RemoteFastGreeting — the pair's stamped intervals prove
    // parallel rendering by overlap.
    const startedAt = Date.now()
    await delay(1000)
    return (
      <RemoteCard
        tone="sky"
        testid="remote-slow"
        data-started-at={startedAt}
        data-finished-at={Date.now()}
      >
        <strong>Slow remote</strong> · 1000ms · {new Date().toISOString()}
      </RemoteCard>
    )
  },
  { selector: "remote-slow" },
)

const RemoteCounter = parton(
  async function RemoteCounterRender(_: RenderArgs) {
    await delay(300)
    return (
      <RemoteCard tone="violet" testid="remote-counter">
        <strong>Remote with client component</strong>
        <div className="mt-2 text-xs text-muted-foreground">
          The button below is a `"use client"` component rendered inside the remote spec. It
          hydrates after the remote payload reaches the browser; clicking it bumps local state —
          proves client components inside a remote work end-to-end.
        </div>
        <div className="mt-3" data-testid="remote-counter-mount">
          <ClickCounter />
        </div>
      </RemoteCard>
    )
  },
  { selector: "remote-counter" },
)

const RemoteCachedGreeting = parton(
  async function RemoteCachedGreetingRender(_: RenderArgs) {
    // Without cache, this would delay 500ms every call. With cache,
    // only the first call pays the cost; subsequent fetches replay
    // stored bytes immediately.
    await delay(500)
    return (
      <RemoteCard tone="pink" testid="remote-cached">
        <strong>Cached remote</strong> · 500ms cold · {new Date().toISOString()}
        <div className="mt-2 text-xs text-muted-foreground">
          `cache: {`{ maxAge: 60 }`}` on the remote spec. The first request renders fresh;
          subsequent same-key fetches hit the cache and return immediately.
        </div>
      </RemoteCard>
    )
  },
  {
    selector: "remote-cached",
    cache: { maxAge: 60 },
  },
)

// ─── Shared visual primitive ────────────────────────────────────────────

function RemoteCard({
  tone,
  testid,
  children,
  ...dataProps
}: {
  tone: "emerald" | "amber" | "sky" | "violet" | "pink"
  testid: string
  children: React.ReactNode
} & Record<`data-${string}`, string | number>) {
  const toneClass = {
    emerald: "border-emerald-500/40 bg-emerald-500/5",
    amber: "border-amber-500/40 bg-amber-500/5",
    sky: "border-sky-500/40 bg-sky-500/5",
    violet: "border-violet-500/40 bg-violet-500/5",
    pink: "border-pink-500/40 bg-pink-500/5",
  }[tone]
  return (
    <Card className={`mb-2 p-4 ${toneClass}`} data-testid={testid} {...dataProps}>
      <CardContent className="px-0 text-sm">{children}</CardContent>
    </Card>
  )
}

function RemoteFallback({ label, testid }: { label: string; testid: string }) {
  return (
    <Card
      className="mb-2 border-dashed border-muted bg-muted/30 p-4"
      data-testid={`${testid}-fallback`}
    >
      <CardContent className="px-0 italic text-muted-foreground">Loading {label}…</CardContent>
    </Card>
  )
}

// ─── Host page ──────────────────────────────────────────────────────────

export const RemoteFrameDemoPage = parton(
  function RemoteFrameDemoRender() {
    return (
      <>
        <header className="mb-4" data-testid="rfd-header">
          <h1 className="text-2xl font-semibold">Remote Frame Demo</h1>
          <p className="text-sm text-muted-foreground">
            Host rendered at <code>{new Date().toISOString()}</code>. Five remote frames stream in
            parallel below.
          </p>
        </header>

        <div className="mb-3 flex flex-wrap gap-2" data-testid="rfd-controls">
          <RemoteRefreshButton selector="remote-fast" label="Refresh fast" />
          <RemoteRefreshButton selector="remote-mid" label="Refresh mid" />
          <RemoteRefreshButton selector="remote-slow" label="Refresh slow" />
          <RemoteRefreshButton selector="remote-counter" label="Refresh counter" />
          <RemoteRefreshButton selector="remote-cached" label="Refresh cached" />
        </div>

        <Suspense fallback={<RemoteFallback label="fast" testid="remote-fast" />}>
          <RemoteFrame url="/__remote/remote-fast" />
        </Suspense>

        <Suspense fallback={<RemoteFallback label="mid" testid="remote-mid" />}>
          <RemoteFrame url="/__remote/remote-mid" />
        </Suspense>

        <Suspense fallback={<RemoteFallback label="slow" testid="remote-slow" />}>
          <RemoteFrame url="/__remote/remote-slow" />
        </Suspense>

        <Suspense fallback={<RemoteFallback label="counter" testid="remote-counter" />}>
          <RemoteFrame url="/__remote/remote-counter" />
        </Suspense>

        <Suspense fallback={<RemoteFallback label="cached" testid="remote-cached" />}>
          <RemoteFrame url="/__remote/remote-cached" />
        </Suspense>

        <footer className="mt-4 text-xs text-muted-foreground" data-testid="rfd-footer">
          Footer rendered at <code>{new Date().toISOString()}</code>. The five remote frames above
          stream into the response independently — host chrome paints immediately, each card arrives
          when its remote spec resolves. Click any refresh button to re-fetch that frame's content
          via{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 text-[0.85em] font-mono">
            nav.reload(&#123;selector&#125;)
          </code>
          .
        </footer>
      </>
    )
  },
  { match: "/remote-frame-demo" },
)

// Side-effect — these declarations must execute so the spec catalog
// registers them and `/__remote/<id>` can look them up.
void RemoteFastGreeting
void RemoteMidGreeting
void RemoteSlowGreeting
void RemoteCounter
void RemoteCachedGreeting
