/**
 * /cache-demo — server-side render-output caching spike.
 *
 * Two partials:
 *  - "Slow": simulates ~500ms server work. Uses `<Partial cache>`.
 *  - "Clock": renders the current time on every request. Not cached.
 *
 * Initial render populates both. Refetching the Slow partial on
 * subsequent requests should serve from the server-side cache
 * (render count stays at 1, response is fast). The Clock ticks every
 * request regardless.
 */

import { Partial } from "../../lib/partial.tsx";
import { ROOT } from "../../lib/partial-context.ts";
import { _cacheStats } from "../../lib/cache.tsx";
import { CacheControls } from "../components/cache-controls.tsx";
import { ClickCounter } from "../components/click-counter.tsx";
import { getScope, getSearchParam } from "../../framework/context.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Per-scope counter so parallel Playwright workers (each with its own
// `x-test-scope` header) don't share the tally. Tests assert on
// deltas within a single scope, which is what matters.
const slowRenderCounts = new Map<string, number>();
function bumpSlowRender(): number {
  const scope = getScope();
  const next = (slowRenderCounts.get(scope) ?? 0) + 1;
  slowRenderCounts.set(scope, next);
  return next;
}

async function SlowContent() {
  // Demonstrates auto-tracked cache keys: `getSearchParam` records
  // `url:flavor` in the enclosing `<Partial cache>`'s access manifest,
  // so cached bytes are automatically keyed per flavor without any
  // `vary` declaration on the Partial.
  const flavor = getSearchParam("flavor") ?? "vanilla";
  const slowRenderCount = bumpSlowRender();
  await delay(500);
  return (
    <div
      data-testid="slow-content"
      data-render-count={slowRenderCount}
      className="mb-2 rounded-lg bg-card p-4"
    >
      <div className="font-semibold">Slow content (flavor: {flavor})</div>
      <div className="mt-1 text-xs text-muted-foreground">
        rendered {slowRenderCount} time{slowRenderCount === 1 ? "" : "s"} ·
        computed at {new Date().toISOString()}
      </div>
      <div className="mt-3">
        <ClickCounter />
      </div>
    </div>
  );
}

function Clock() {
  return (
    <div
      data-testid="clock-content"
      className="mb-2 rounded-lg bg-muted p-4"
    >
      <div className="font-semibold">Clock (always fresh)</div>
      <div className="mt-1 text-xs text-muted-foreground">
        Server time: {new Date().toISOString()}
      </div>
    </div>
  );
}

export async function CacheDemoPage() {
  const flavor = getSearchParam("flavor") ?? "vanilla";
  const stats = await _cacheStats();

  return (
    <>
      <title>Cache Demo</title>
      <h1 className="mb-4 text-2xl font-semibold">Server-side cache spike</h1>
      <p className="mb-4 text-muted-foreground">
        flavor=<Code>{flavor}</Code> · cache size:{" "}
        <Code data-testid="cache-size">{stats.size}</Code>
      </p>

      <CacheControls />

      <Partial
        parent={ROOT}
        selector="#slow"
        cache={{ maxAge: 60 }}
        fallback={<div data-testid="slow-fallback">Loading slow…</div>}
      >
        <SlowContent />
      </Partial>

      <Partial parent={ROOT} selector="#clock" fallback={<div>Loading clock…</div>}>
        <Clock />
      </Partial>

      <div className="mt-8 text-xs text-muted-foreground">
        Server <Code>slowRenderCount</Code>:{" "}
        <span data-testid="server-render-count">
          {slowRenderCounts.get(getScope()) ?? 0}
        </span>
        <br />
        Try: change <Code>?flavor=</Code>, refetch the slow partial, reload.
      </div>
    </>
  );
}

function Code({
  children,
  ...rest
}: React.ComponentProps<"code">) {
  return (
    <code
      {...rest}
      className="rounded bg-muted px-1.5 py-0.5 text-[0.85em] font-mono"
    >
      {children}
    </code>
  );
}
