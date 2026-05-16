/**
 * /cache-streaming-demo — slow-source cache replay.
 *
 * Validates that the cache's decode → re-emit pipeline preserves
 * Suspense streaming when the source emits bytes slowly. The cache
 * wrapper around `CachedRegion` is configured with `slowSource` so
 * stored bytes feed the decoder in small chunks separated by a
 * delay — the same shape a `<RemoteFrame>` will see from a slow
 * cross-origin Flight payload.
 *
 * Expected observation on reload (cache hit):
 *
 *   - `HeaderBar` paints immediately (uncached, fresh).
 *   - `CachedRegion`'s wrapper fallback paints next while the slow
 *     stream feeds bytes into createFromReadableStream.
 *   - Inner Suspense boundaries inside the cached region resolve
 *     one-by-one as more bytes arrive (Section 1, 2, 3, …) — NOT
 *     all-at-once.
 *   - `FooterBar` paints either alongside the header (outer render
 *     streamed around the cache wrapper) or after the cache wrapper
 *     resolved (outer render blocked on the cache). Which one you
 *     see tells you whether the streaming-stitch primitive composes
 *     with the outer Flight encoder.
 *
 * Cold render (first visit, no cache entry): populates the cache.
 * Each `Section`'s `await delay(ms)` delays cold render normally;
 * the stored bytes carry the post-resolution snapshot. Reload to
 * exercise the slow hit path.
 */

import { parton, type RenderArgs } from "@parton/framework"
import { Suspense } from "react"
import { Card, CardContent } from "@parton/copies/components/ui/card"

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function Section({ n, ms }: { n: number; ms: number }) {
  await delay(ms)
  return (
    <Card className="mb-2 p-4" data-testid={`section-${n}`}>
      <CardContent className="px-0">
        <div className="font-semibold">Section {n}</div>
        <div className="mt-1 text-xs text-muted-foreground">
          cold-rendered at <code>{new Date().toISOString()}</code> · {ms}ms async work
        </div>
      </CardContent>
    </Card>
  )
}

const SECTION_FALLBACK = (n: number) => (
  <Card className="mb-2 p-4 opacity-60" data-testid={`section-${n}-fallback`}>
    <CardContent className="px-0 italic text-muted-foreground">Loading section {n}…</CardContent>
  </Card>
)

const CachedRegion = parton(
  async function CachedRegionRender({}: RenderArgs) {
    return (
      <div data-testid="cached-region">
        <Suspense fallback={SECTION_FALLBACK(1)}>
          <Section n={1} ms={100} />
        </Suspense>
        <Suspense fallback={SECTION_FALLBACK(2)}>
          <Section n={2} ms={200} />
        </Suspense>
        <Suspense fallback={SECTION_FALLBACK(3)}>
          <Section n={3} ms={300} />
        </Suspense>
        <Suspense fallback={SECTION_FALLBACK(4)}>
          <Section n={4} ms={400} />
        </Suspense>
        <Suspense fallback={SECTION_FALLBACK(5)}>
          <Section n={5} ms={500} />
        </Suspense>
      </div>
    )
  },
  {
    selector: "cached-region",
    cache: {
      maxAge: 600,
      // Raw-bytes storage preserves Suspense structure end-to-end.
      // Each section occupies ~5KB of stored Flight bytes (dev-mode
      // overhead is large). 25ms × 256B gives roughly 500ms between
      // section reveals — clearly staggered, total ~3s for a reload.
      slowSource: { perChunkMs: 25, chunkBytes: 256 },
    },
    fallback: (
      <div data-testid="cached-region-fallback" className="rounded bg-muted p-3 text-sm italic">
        Loading cached region (slow stream replay)…
      </div>
    ),
  },
)

const HeaderBar = parton(function HeaderBarRender() {
  return (
    <header className="mb-4" data-testid="header-bar">
      <h1 className="text-2xl font-semibold">Cache Streaming Demo</h1>
      <p className="text-sm text-muted-foreground">
        Header (uncached, always fresh) rendered at <code>{new Date().toISOString()}</code>
      </p>
      <p className="mt-2 text-xs text-muted-foreground">
        First visit cold-renders + populates cache. Reload to exercise the slow hit path —
        inner Suspense boundaries should resolve incrementally as bytes arrive.
      </p>
    </header>
  )
})

const FooterBar = parton(function FooterBarRender() {
  return (
    <footer className="mt-6 text-xs text-muted-foreground" data-testid="footer-bar">
      Footer (uncached) rendered at <code>{new Date().toISOString()}</code>. If this
      timestamp matches the header's, the outer Flight encoder streamed AROUND the cache
      wrapper. If it's noticeably later, the outer render blocked on cache resolution.
    </footer>
  )
})

export const CacheStreamingDemoPage = parton(
  function CacheStreamingDemoRender({ parent }: RenderArgs) {
    return (
      <>
        <HeaderBar parent={parent} />
        <CachedRegion parent={parent} />
        <FooterBar parent={parent} />
      </>
    )
  },
  { match: "/cache-streaming-demo" },
)
