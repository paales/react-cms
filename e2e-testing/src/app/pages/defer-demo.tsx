/**
 * /defer-demo — exercises the three shapes of `defer` plus
 * batched-activation, streaming/defer race, and concurrent-refetch
 * scenarios.
 *
 * Outer wrapper gates the route once; sub-specs render unconditionally
 * inside it.
 */

import { ReactCms, type RenderArgs } from "@react-cms/framework"
import { WhenVisible } from "../components/when-visible.tsx"
import { WhenStored } from "../components/when-stored.tsx"
import { WhenMounted } from "../components/when-mounted.tsx"
import { ActivateButton, StorageKeyEditor } from "../components/defer-demo-controls.tsx"
import { Card, CardContent, CardHeader, CardTitle } from "@react-cms/copies/components/ui/card"

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

function Timestamp({ prefix }: { prefix: string }) {
  return (
    <span>
      {prefix} {new Date().toISOString()}
    </span>
  )
}

// ─── Sub-specs ──────────────────────────────────────────────────────────

export const ManualPartial = ReactCms.partial(
  function ManualRender({}: RenderArgs) {
    return (
      <div data-testid="manual-content">
        <Timestamp prefix="activated at" />
      </div>
    )
  },
  {
    selector: "#manual",
    defer: true,
    fallback: (
      <DormantFallback testId="manual-fallback">
        dormant — waiting for manual activation
      </DormantFallback>
    ),
  },
)

export const StoredPartial = ReactCms.partial(
  function StoredRender({ stored }: { stored?: string } & RenderArgs) {
    return (
      <div data-testid="stored-content">
        <Timestamp prefix="activated at" /> — value:{" "}
        <InlineCode>
          <span data-testid="stored-value">{stored ?? "(none)"}</span>
        </InlineCode>
      </div>
    )
  },
  {
    selector: "#stored",
    defer: <WhenStored storageKey="demo-stored" />,
    fallback: (
      <DormantFallback testId="stored-fallback">
        dormant — set localStorage["demo-stored"] to activate
      </DormantFallback>
    ),
  },
)

function makeBatch(label: string) {
  const key = `${label}-key`
  return ReactCms.partial(
    async function BatchRender({ stored }: { stored?: string } & RenderArgs) {
      return (
        <div data-testid={`${label}-content`}>
          <Timestamp prefix="activated at" /> — value:{" "}
          <InlineCode>
            <span data-testid={`${label}-value`}>{stored ?? "(none)"}</span>
          </InlineCode>
        </div>
      )
    },
    {
      selector: `#${label}`,
      defer: <WhenStored storageKey={key} />,
      fallback: (
        <DormantFallback testId={`${label}-fallback`}>
          dormant — set localStorage["{key}"] before loading to activate
        </DormantFallback>
      ),
    },
  )
}

export const BatchAPartial = makeBatch("batch-a")
export const BatchBPartial = makeBatch("batch-b")

export const SlowStreamPartial = ReactCms.partial(
  async function SlowStreamRender({}: RenderArgs) {
    await new Promise((r) => setTimeout(r, 1500))
    return (
      <div data-testid="slow-content">
        <Timestamp prefix="slow stream resolved at" />
      </div>
    )
  },
  {
    selector: "#slow-stream",
    fallback: (
      <DormantFallback testId="slow-fallback">slow content streaming… (1.5s)</DormantFallback>
    ),
  },
)

export const RaceDeferPartial = ReactCms.partial(
  function RaceDeferRender({}: RenderArgs) {
    return (
      <div data-testid="race-defer-content">
        <Timestamp prefix="race defer activated at" />
      </div>
    )
  },
  {
    selector: "#race-defer",
    defer: <WhenMounted />,
    fallback: (
      <DormantFallback testId="race-defer-fallback">
        dormant — activates immediately on mount
      </DormantFallback>
    ),
  },
)

function makeConcurrent(label: string, delayMs: number) {
  return ReactCms.partial(
    async function ConcurrentRender({}: RenderArgs) {
      await new Promise((r) => setTimeout(r, delayMs))
      return (
        <div data-testid={`concurrent-${label}`}>
          <strong>{label}</strong> ({delayMs}ms): {new Date().toISOString()}
        </div>
      )
    },
    {
      selector: `#concurrent-${label} .concurrent`,
      fallback: (
        <div data-testid={`concurrent-${label}-fallback`} className="text-muted-foreground">
          {label} ({delayMs}ms): streaming…
        </div>
      ),
    },
  )
}

export const ConcurrentAPartial = makeConcurrent("a", 400)
export const ConcurrentBPartial = makeConcurrent("b", 800)
export const ConcurrentCPartial = makeConcurrent("c", 1200)

export const VisibilityDeferPartial = ReactCms.partial(
  function VisibilityDeferRender({}: RenderArgs) {
    return (
      <div data-testid="any-content">
        <Timestamp prefix="activated at" />
      </div>
    )
  },
  {
    selector: "#any",
    defer: <WhenVisible />,
    fallback: (
      <DormantFallback testId="any-fallback">
        dormant — scroll into view to activate
      </DormantFallback>
    ),
  },
)

// ─── Static chrome ──────────────────────────────────────────────────────

export const DeferDemoPage = ReactCms.partial(
  function DeferDemoRender({ parent }: RenderArgs) {
    return (
      <main className="py-4">
        <title>Defer Demo</title>
        <h1 className="mb-4 text-2xl font-semibold">Partial defer — feature demo</h1>
        <p className="mb-8 text-muted-foreground">
          Three activation shapes for <InlineCode>defer</InlineCode>.
        </p>

        <Card data-testid="section-manual" className="mb-8 p-5">
          <CardHeader className="px-0">
            <CardTitle className="text-base">
              1. <InlineCode>defer={"{true}"}</InlineCode>
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 px-0">
            <ManualPartial parent={parent} />
            <div>
              <ActivateButton partialId="manual" label="Activate manually" />
            </div>
          </CardContent>
        </Card>

        <Card data-testid="section-stored" className="mb-8 p-5">
          <CardHeader className="px-0">
            <CardTitle className="text-base">
              2. <InlineCode>&lt;WhenStored&gt;</InlineCode>
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 px-0">
            <StoredPartial parent={parent} />
            <StorageKeyEditor storageKey="demo-stored" testId="demo-stored" />
          </CardContent>
        </Card>

        <Card data-testid="section-batch" className="mb-8 p-5">
          <CardHeader className="px-0">
            <CardTitle className="text-base">4. Batched activation</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 px-0">
            <BatchAPartial parent={parent} />
            <BatchBPartial parent={parent} />
            <div className="flex flex-wrap gap-2">
              <StorageKeyEditor storageKey="batch-a-key" testId="batch-a-key" />
              <StorageKeyEditor storageKey="batch-b-key" testId="batch-b-key" />
            </div>
          </CardContent>
        </Card>

        <Card data-testid="section-race" className="mb-8 p-5">
          <CardHeader className="px-0">
            <CardTitle className="text-base">5. Streaming + defer race</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 px-0">
            <SlowStreamPartial parent={parent} />
            <RaceDeferPartial parent={parent} />
          </CardContent>
        </Card>

        <Card data-testid="section-concurrent" className="mb-8 p-5">
          <CardHeader className="px-0">
            <CardTitle className="text-base">6. Concurrent refetches</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 px-0">
            <ConcurrentAPartial parent={parent} />
            <ConcurrentBPartial parent={parent} />
            <ConcurrentCPartial parent={parent} />
            <div className="flex flex-wrap gap-2">
              <ActivateButton
                partialId="concurrent-a"
                label="refetch a"
                testId="refresh-concurrent-a"
                disableTransition
              />
              <ActivateButton
                partialId="concurrent-b"
                label="refetch b"
                testId="refresh-concurrent-b"
                disableTransition
              />
              <ActivateButton
                partialId="concurrent-c"
                label="refetch c"
                testId="refresh-concurrent-c"
                disableTransition
              />
            </div>
          </CardContent>
        </Card>

        <Card data-testid="section-any" className="mb-8 p-5">
          <CardHeader className="px-0">
            <CardTitle className="text-base">
              3. <InlineCode>&lt;WhenVisible&gt;</InlineCode>
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 px-0">
            <div data-testid="any-spacer" className="h-[90vh]" aria-hidden="true" />
            <VisibilityDeferPartial parent={parent} />
          </CardContent>
        </Card>
      </main>
    )
  },
  { match: "/defer-demo" },
)
