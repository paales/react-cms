import { Partial } from "../../lib/partial.tsx"
import { ROOT } from "../../lib/partial-context.ts"
import { WhenVisible } from "../components/when-visible.tsx"
import { WhenStored } from "../components/when-stored.tsx"
import { WhenMounted } from "../components/when-mounted.tsx"
import { ActivateButton, StorageKeyEditor } from "../components/defer-demo-controls.tsx"
import { getSearchParam } from "../../framework/context.ts"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

/**
 * `/defer-demo` — exercises the three shapes of `<Partial parent={ROOT} defer>`:
 *
 *   1. `defer={true}` — bare defer. No framework-installed trigger; an
 *      app-level button calls `useNavigation().reload({selector: "#" + id})` to
 *      activate.
 *   2. `defer={<WhenStored .../>}` — activator reads localStorage on
 *      mount and on `storage` events; writes the value to the page URL
 *      (`?<as>=<value>`) before firing the targeted refetch. The
 *      Partial's content reads it back via `getSearchParam(as)`.
 *   3. `defer={<WhenVisible/>}` — visibility-triggered activation via
 *      IntersectionObserver.
 *
 * Plus two dispatch-behavior exercises:
 *
 *   4. Batched activation — two `<WhenStored>` Partials firing from the
 *      same commit pass. The microtask-batched dispatch should coalesce
 *      them into ONE RSC request listing both ids in `?partials=`.
 *   5. Streaming + defer race — a slow-async Partial suspends on its
 *      initial render; a deferred Partial on the same page activates
 *      immediately on mount. The two must not block each other: the
 *      defer refetch lands while the slow Partial is still streaming.
 */

function InlineCode({ children }: { children: React.ReactNode }) {
  return <code className="rounded bg-muted px-1.5 py-0.5 text-[0.85em] font-mono">{children}</code>
}

function DormantFallback({ testId, children }: { testId: string; children: React.ReactNode }) {
  return (
    <div data-testid={testId} className="italic text-muted-foreground">
      {children}
    </div>
  )
}

async function SlowContent() {
  // ~1.5s delay so the Suspense fallback is visibly up while the
  // deferred Partial in the same section activates + refetches.
  await new Promise((r) => setTimeout(r, 1500))
  return (
    <div data-testid="slow-content">
      <Timestamp prefix="slow stream resolved at" />
    </div>
  )
}

/**
 * Render-delayed body for the concurrent-refetch demo. Each instance
 * awaits its own delay before producing a timestamp — so three
 * concurrent refetches that hit the same server take max(delay), not
 * sum(delay).
 */
async function DelayedClock({ delayMs, label }: { delayMs: number; label: string }) {
  await new Promise((r) => setTimeout(r, delayMs))
  return (
    <div data-testid={`concurrent-${label}`}>
      <strong>{label}</strong> ({delayMs}ms): {new Date().toISOString()}
    </div>
  )
}

function Timestamp({ prefix }: { prefix: string }) {
  return (
    <span>
      {prefix} {new Date().toISOString()}
    </span>
  )
}

function StoredContent({ paramName }: { paramName: string }) {
  const stored = getSearchParam(paramName)
  return (
    <div data-testid="stored-content">
      <Timestamp prefix="activated at" /> — value:{" "}
      <InlineCode>
        <span data-testid="stored-value">{stored ?? "(none)"}</span>
      </InlineCode>
    </div>
  )
}

export function DeferDemoPage() {
  return (
    <main className="py-4">
      <title>Defer Demo</title>
      <h1 className="mb-4 text-2xl font-semibold">Partial defer — feature demo</h1>
      <p className="mb-8 text-muted-foreground">
        Three activation shapes for <InlineCode>&lt;Partial defer&gt;</InlineCode>. Each section
        stays dormant until its trigger fires; the activated content renders a server timestamp so
        you can confirm the RSC round-trip.
      </p>

      {/* ── 1. defer={true} — manual activation ─────────────── */}
      <Card data-testid="section-manual" className="mb-8 p-5">
        <CardHeader className="px-0">
          <CardTitle className="text-base">
            1. <InlineCode>defer={"{true}"}</InlineCode> — manual activation
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 px-0">
          <p className="text-sm text-muted-foreground">
            No automatic trigger. Click the button to call{" "}
            <InlineCode>useNavigation().reload({'{selector: "#manual"}'})</InlineCode>.
          </p>
          <Partial
            parent={ROOT}
            selector="#manual"
            defer
            fallback={
              <DormantFallback testId="manual-fallback">
                dormant — waiting for manual activation
              </DormantFallback>
            }
          >
            <div data-testid="manual-content">
              <Timestamp prefix="activated at" />
            </div>
          </Partial>
          <div>
            <ActivateButton partialId="manual" label="Activate manually" />
          </div>
        </CardContent>
      </Card>

      {/* ── 2. <WhenStored> — storage-triggered ───────────────── */}
      <Card data-testid="section-stored" className="mb-8 p-5">
        <CardHeader className="px-0">
          <CardTitle className="text-base">
            2. <InlineCode>&lt;WhenStored&gt;</InlineCode> — activates when localStorage key appears
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 px-0">
          <p className="text-sm text-muted-foreground">
            The activator reads <InlineCode>localStorage["demo-stored"]</InlineCode> on mount and on{" "}
            <InlineCode>storage</InlineCode> events. When present, writes the value to the page URL
            as <InlineCode>?stored=…</InlineCode> and activates the Partial. The content reads the
            value back via <InlineCode>getSearchParam("stored")</InlineCode>.
          </p>
          <Partial
            parent={ROOT}
            selector="#stored"
            defer={<WhenStored storageKey="demo-stored" as="stored" />}
            fallback={
              <DormantFallback testId="stored-fallback">
                dormant — set <InlineCode>localStorage["demo-stored"]</InlineCode> to activate
              </DormantFallback>
            }
          >
            <StoredContent paramName="stored" />
          </Partial>
          <StorageKeyEditor storageKey="demo-stored" testId="demo-stored" />
        </CardContent>
      </Card>

      {/* ── 4. Batched activation: two WhenStored → one RSC ──── */}
      <Card data-testid="section-batch" className="mb-8 p-5">
        <CardHeader className="px-0">
          <CardTitle className="text-base">4. Batched activation</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 px-0">
          <p className="text-sm text-muted-foreground">
            Two <InlineCode>&lt;Partial defer=&lt;WhenStored/&gt;&gt;</InlineCode>
            siblings with distinct keys. Pre-set both keys (via{" "}
            <InlineCode>localStorage.setItem</InlineCode> BEFORE the page loads), and the two
            activators fire in the same commit pass. The microtask-batched dispatch should coalesce
            them into a SINGLE RSC request listing both ids in <InlineCode>?partials=</InlineCode>.
          </p>
          <Partial
            parent={ROOT}
            selector="#batch-a"
            defer={<WhenStored storageKey="batch-a-key" as="batch-a" />}
            fallback={
              <DormantFallback testId="batch-a-fallback">
                dormant — set <InlineCode>localStorage["batch-a-key"]</InlineCode> before loading to
                activate
              </DormantFallback>
            }
          >
            <StoredContent paramName="batch-a" />
          </Partial>
          <Partial
            parent={ROOT}
            selector="#batch-b"
            defer={<WhenStored storageKey="batch-b-key" as="batch-b" />}
            fallback={
              <DormantFallback testId="batch-b-fallback">
                dormant — set <InlineCode>localStorage["batch-b-key"]</InlineCode> before loading to
                activate
              </DormantFallback>
            }
          >
            <StoredContent paramName="batch-b" />
          </Partial>
          <div className="flex flex-wrap gap-2">
            <StorageKeyEditor storageKey="batch-a-key" testId="batch-a-key" />
            <StorageKeyEditor storageKey="batch-b-key" testId="batch-b-key" />
          </div>
        </CardContent>
      </Card>

      {/* ── 5. Streaming + defer race ──────────────────────────── */}
      <Card data-testid="section-race" className="mb-8 p-5">
        <CardHeader className="px-0">
          <CardTitle className="text-base">5. Streaming + defer race</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 px-0">
          <p className="text-sm text-muted-foreground">
            The <InlineCode>&lt;SlowContent/&gt;</InlineCode> partial suspends for ~1.5s during
            initial render. A neighboring deferred Partial (
            <InlineCode>defer=&lt;WhenVisible/&gt;</InlineCode>, fallback already on-screen)
            activates on mount. Its refetch should land and its content should appear{" "}
            <em>before</em> the slow partial resolves — proving the two flows don't serialize.
          </p>
          <Partial
            parent={ROOT}
            selector="#slow-stream"
            fallback={
              <DormantFallback testId="slow-fallback">
                slow content streaming… (1.5s)
              </DormantFallback>
            }
          >
            <SlowContent />
          </Partial>
          <Partial
            parent={ROOT}
            selector="#race-defer"
            defer={<WhenMounted />}
            fallback={
              <DormantFallback testId="race-defer-fallback">
                dormant — activates immediately on mount
              </DormantFallback>
            }
          >
            <div data-testid="race-defer-content">
              <Timestamp prefix="race defer activated at" />
            </div>
          </Partial>
        </CardContent>
      </Card>

      {/* ── 6. Concurrent refetches across distinct ids ───────── */}
      <Card data-testid="section-concurrent" className="mb-8 p-5">
        <CardHeader className="px-0">
          <CardTitle className="text-base">6. Concurrent refetches — independent ids</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 px-0">
          <p className="text-sm text-muted-foreground">
            Three Partials with staggered artificial delays (400ms, 800ms, 1200ms). Clicking the
            buttons in rapid succession fires three independent RSC requests that run in parallel on
            the server. Total wall time is <em>max(delays)</em>, not <em>sum</em>.
          </p>
          <p className="text-sm text-muted-foreground">
            <strong>Behavior notes.</strong> Each click is its own event task → own microtask → own
            RSC request. Clicking in quick succession (one click at a time) fires three overlapping
            requests that run in parallel on the server. The buttons pass{" "}
            <InlineCode>disableTransition: true</InlineCode> so each response commits on arrival;
            the default transition-wrapped mode is safest for same-id repeats (suppresses stale
            flashes) but can collapse intermediate commits under heavy fan-out — use{" "}
            <InlineCode>disableTransition</InlineCode> for disjoint-id parallelism like this.
          </p>
          <Partial
            parent={ROOT}
            selector="#concurrent-a .concurrent"
            fallback={
              <div data-testid="concurrent-a-fallback" className="text-muted-foreground">
                a (400ms): streaming…
              </div>
            }
          >
            <DelayedClock delayMs={400} label="a" />
          </Partial>
          <Partial
            parent={ROOT}
            selector="#concurrent-b .concurrent"
            fallback={
              <div data-testid="concurrent-b-fallback" className="text-muted-foreground">
                b (800ms): streaming…
              </div>
            }
          >
            <DelayedClock delayMs={800} label="b" />
          </Partial>
          <Partial
            parent={ROOT}
            selector="#concurrent-c .concurrent"
            fallback={
              <div data-testid="concurrent-c-fallback" className="text-muted-foreground">
                c (1200ms): streaming…
              </div>
            }
          >
            <DelayedClock delayMs={1200} label="c" />
          </Partial>
          <div className="flex flex-wrap gap-2">
            <ActivateButton
              partialId="concurrent-a"
              label="refetch a (400ms)"
              testId="refresh-concurrent-a"
              disableTransition
            />
            <ActivateButton
              partialId="concurrent-b"
              label="refetch b (800ms)"
              testId="refresh-concurrent-b"
              disableTransition
            />
            <ActivateButton
              partialId="concurrent-c"
              label="refetch c (1200ms)"
              testId="refresh-concurrent-c"
              disableTransition
            />
          </div>
        </CardContent>
      </Card>

      {/* ── 3. <WhenVisible> — viewport-triggered ─────────────── */}
      <Card data-testid="section-any" className="mb-8 p-5">
        <CardHeader className="px-0">
          <CardTitle className="text-base">
            3. <InlineCode>&lt;WhenVisible&gt;</InlineCode> — activates when the fallback enters the
            viewport
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 px-0">
          <p className="text-sm text-muted-foreground">
            Activates when the fallback scrolls into view. Uses an{" "}
            <InlineCode>IntersectionObserver</InlineCode> attached to the fallback's DOM range via a
            Fragment ref.
          </p>
          <div data-testid="any-spacer" className="h-[90vh]" aria-hidden="true" />
          <Partial
            parent={ROOT}
            selector="#any"
            defer={<WhenVisible />}
            fallback={
              <DormantFallback testId="any-fallback">
                dormant — scroll into view to activate
              </DormantFallback>
            }
          >
            <div data-testid="any-content">
              <Timestamp prefix="activated at" />
            </div>
          </Partial>
        </CardContent>
      </Card>
    </main>
  )
}
