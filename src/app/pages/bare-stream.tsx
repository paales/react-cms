/**
 * Bare streaming test: three Suspense boundaries with staggered async
 * children, rendered through PartialRoot.
 *
 * Goal: isolate whether RSC streaming + client setState can produce a
 * progressive Suspense reveal on AJAX refetch, separate from all the
 * cache/template/wrapper machinery.
 */

import { BareRefetchButton } from "../components/bare-refetch-button.tsx";
import { PartialRoot, Partial } from "../../lib/partial.tsx";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function BareStage({ id, ms }: { id: number; ms: number }) {
  await delay(ms);
  return (
    <div
      data-testid={`stage-${id}-content`}
      style={{
        padding: "1rem",
        background: "#1a1a2e",
        borderRadius: 8,
        marginBottom: "0.5rem",
      }}
    >
      Stage {id} — resolved after {ms}ms (server time {new Date().toISOString()})
    </div>
  );
}

export function BarePage() {
  return (
    <PartialRoot>
      <html lang="en">
        <Partial id="head">
          <head>
            <meta charSet="UTF-8" />
            <title>Bare Streaming Test</title>
            <style>{`
              body { font-family: system-ui, sans-serif; background: #0a0a0a; color: #ededed; padding: 2rem; max-width: 800px; margin: 0 auto; }
              button { background: #2d3748; color: #ededed; border: 1px solid #4a5568; padding: 0.5rem 1rem; border-radius: 6px; cursor: pointer; }
              button:hover { background: #4a5568; }
            `}</style>
          </head>
        </Partial>
        <body>
          <h1>Bare Streaming Test (now via Partials)</h1>
          <BareRefetchButton />
          <div style={{ marginTop: "1.5rem" }}>
            <Partial
              id="stage-1"
              fallback={<div data-testid="stage-1-fallback">Loading stage 1...</div>}
            >
              <BareStage id={1} ms={0} />
            </Partial>
            <Partial
              id="stage-2"
              fallback={<div data-testid="stage-2-fallback">Loading stage 2...</div>}
            >
              <BareStage id={2} ms={1000} />
            </Partial>
            <Partial
              id="stage-3"
              fallback={<div data-testid="stage-3-fallback">Loading stage 3...</div>}
            >
              <BareStage id={3} ms={2000} />
            </Partial>
          </div>
        </body>
      </html>
    </PartialRoot>
  );
}
