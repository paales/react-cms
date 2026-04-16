/**
 * /cache-demo — server-side render-output caching spike.
 *
 * Two partials:
 *  - "Slow": simulates ~500ms server work. Wrapped in <Cache dep>.
 *  - "Clock": renders the current time on every request. Not cached.
 *
 * Initial render populates both. Refetching the Slow partial on
 * subsequent requests should serve from the server-side cache
 * (render count stays at 1, response is fast). The Clock ticks every
 * request regardless.
 */

import { Partial, PartialRoot } from "../../lib/partial.tsx";
import { Cache, _cacheStats } from "../../lib/cache.tsx";
import { CacheControls } from "../components/cache-controls.tsx";
import { ClickCounter } from "../components/click-counter.tsx";
import { getRequest } from "../../framework/context.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Module-level counter to prove whether the body actually ran this request.
let slowRenderCount = 0;

async function SlowContent({ flavor }: { flavor: string }) {
  slowRenderCount++;
  await delay(500);
  return (
    <div
      data-testid="slow-content"
      data-render-count={slowRenderCount}
      style={{
        padding: "1rem",
        background: "#1a1a2e",
        borderRadius: 8,
        marginBottom: "0.5rem",
      }}
    >
      <div style={{ fontWeight: 600 }}>Slow content (flavor: {flavor})</div>
      <div
        style={{ color: "#888", fontSize: "0.8rem", marginTop: "0.25rem" }}
      >
        rendered {slowRenderCount} time{slowRenderCount === 1 ? "" : "s"} · computed at{" "}
        {new Date().toISOString()}
      </div>
      {/* Client component nested inside a cached subtree — proves the
          buffer/decode round-trip preserves client references. */}
      <div style={{ marginTop: "0.75rem" }}>
        <ClickCounter />
      </div>
    </div>
  );
}

function Clock() {
  return (
    <div
      data-testid="clock-content"
      style={{
        padding: "1rem",
        background: "#2a1a2e",
        borderRadius: 8,
        marginBottom: "0.5rem",
      }}
    >
      <div style={{ fontWeight: 600 }}>Clock (always fresh)</div>
      <div
        style={{ color: "#888", fontSize: "0.8rem", marginTop: "0.25rem" }}
      >
        Server time: {new Date().toISOString()}
      </div>
    </div>
  );
}

export function CacheDemoPage() {
  const url = new URL(getRequest().url);
  const flavor = url.searchParams.get("flavor") ?? "vanilla";
  const stats = _cacheStats();

  return (
    <PartialRoot>
      <html lang="en">
        <Partial id="head">
          <head>
            <meta charSet="UTF-8" />
            <title>Cache Demo</title>
            <style>{`
              body { font-family: system-ui, sans-serif; background: #0a0a0a; color: #ededed; padding: 2rem; max-width: 800px; margin: 0 auto; }
              a { color: #58a6ff; }
              button { background: #2d3748; color: #ededed; border: 1px solid #4a5568; padding: 0.5rem 1rem; border-radius: 6px; cursor: pointer; font-size: 0.9rem; }
              button:hover { background: #4a5568; }
              code { background: #2d3748; padding: 0.1rem 0.3rem; border-radius: 4px; font-size: 0.85rem; }
            `}</style>
          </head>
        </Partial>
        <body>
          <h1>Server-side cache spike</h1>
          <p style={{ color: "#888" }}>
            <a href="/">← Home</a> · flavor=<code>{flavor}</code> ·
            cache size: <code data-testid="cache-size">{stats.size}</code>
          </p>

          <CacheControls />

          <Partial id="slow" fallback={<div data-testid="slow-fallback">Loading slow…</div>}>
            <Cache id="slow" dep={{ flavor }} ttl={60}>
              <SlowContent flavor={flavor} />
            </Cache>
          </Partial>

          <Partial id="clock" fallback={<div>Loading clock…</div>}>
            <Clock />
          </Partial>

          <div style={{ marginTop: "2rem", color: "#666", fontSize: "0.8rem" }}>
            Server <code>slowRenderCount</code>: <span data-testid="server-render-count">{slowRenderCount}</span>
            <br/>
            Try: change <code>?flavor=</code>, refetch the slow partial, reload.
          </div>
        </body>
      </html>
    </PartialRoot>
  );
}
