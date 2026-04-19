import { Partial, PartialRoot } from "../../lib/partial.tsx";
import { WhenVisible } from "../components/when-visible.tsx";
import { WhenStored } from "../components/when-stored.tsx";
import { WhenMounted } from "../components/when-mounted.tsx";
import {
  ActivateButton,
  StorageKeyEditor,
} from "../components/defer-demo-controls.tsx";
import { AppNav } from "../components/app-nav.tsx";

/**
 * `/defer-demo` — exercises the three shapes of `<Partial defer>`:
 *
 *   1. `defer={true}` — bare defer. No framework-installed trigger; an
 *      app-level button calls `usePartial(id).refetch()` to activate.
 *   2. `defer={<WhenStored .../>}` — activator reads localStorage on
 *      mount and on `storage` events; passes the value into the Partial
 *      via `__inputs`.
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
 *
 * `WhenVisible` / `WhenStored` live in `src/app/components/` — they
 * are userspace activators built against the framework's
 * `useActivate` primitive, not library exports.
 *
 * Each activated content renders a server timestamp so the RSC
 * round-trip is visible (and assertable).
 */

async function SlowContent() {
  // ~1.5s delay so the Suspense fallback is visibly up while the
  // deferred Partial in the same section activates + refetches.
  await new Promise((r) => setTimeout(r, 1500));
  return (
    <div data-testid="slow-content">
      <Timestamp prefix="slow stream resolved at" />
    </div>
  );
}

/**
 * Render-delayed body for the concurrent-refetch demo. Each instance
 * awaits its own delay before producing a timestamp — so three
 * concurrent refetches that hit the same server take max(delay), not
 * sum(delay).
 */
async function DelayedClock({
  delayMs,
  label,
}: {
  delayMs: number;
  label: string;
}) {
  await new Promise((r) => setTimeout(r, delayMs));
  return (
    <div data-testid={`concurrent-${label}`}>
      <strong>{label}</strong> ({delayMs}ms): {new Date().toISOString()}
    </div>
  );
}
function Timestamp({ prefix }: { prefix: string }) {
  return (
    <span>
      {prefix} {new Date().toISOString()}
    </span>
  );
}

function StoredContent({ stored }: { stored?: string }) {
  return (
    <div data-testid="stored-content">
      <Timestamp prefix="activated at" /> — value:{" "}
      <code data-testid="stored-value">{stored ?? "(none)"}</code>
    </div>
  );
}

export function DeferDemoPage() {
  return (
    <PartialRoot>
      <html lang="en">
        <Partial id="head">
          <head>
            <meta charSet="UTF-8" />
            <meta
              name="viewport"
              content="width=device-width, initial-scale=1.0"
            />
            <title>Defer Demo</title>
            <style>{`
              * { box-sizing: border-box; margin: 0; padding: 0; }
              body { font-family: system-ui, -apple-system, sans-serif; background: #0a0a0a; color: #ededed; padding: 2rem; max-width: 900px; margin: 0 auto; }
              a { color: #58a6ff; text-decoration: none; }
              a:hover { text-decoration: underline; }
              h1 { font-size: 1.75rem; margin-bottom: 1rem; }
              h2 { font-size: 1.1rem; margin-bottom: 0.5rem; }
              code { background: #2d3748; padding: 0.1rem 0.3rem; border-radius: 4px; font-size: 0.85rem; }
              .card { background: #1a1a2e; border-radius: 12px; padding: 1.25rem; margin-bottom: 1rem; }
            `}</style>
          </head>
        </Partial>
        <body>
          <AppNav />
          <main style={{ padding: "1rem 0" }}>
            <h1 style={{ marginBottom: "1rem" }}>
              Partial defer — feature demo
            </h1>
            <p style={{ color: "#888", marginBottom: "2rem" }}>
              Three activation shapes for <code>&lt;Partial defer&gt;</code>.
              Each section stays dormant until its trigger fires; the activated
              content renders a server timestamp so you can confirm the RSC
              round-trip.
            </p>

            {/* ── 1. defer={true} — manual activation ─────────────── */}
            <section
              data-testid="section-manual"
              className="card"
              style={{ marginBottom: "2rem" }}
            >
              <h2>
                1. <code>defer={"{true}"}</code> — manual activation
              </h2>
              <p style={{ color: "#888", marginBottom: "0.75rem" }}>
                No automatic trigger. Click the button to call{" "}
                <code>usePartial("manual").refetch()</code>.
              </p>
              <Partial
                id="manual"
                defer
                fallback={
                  <div
                    data-testid="manual-fallback"
                    style={{ color: "#888", fontStyle: "italic" }}
                  >
                    dormant — waiting for manual activation
                  </div>
                }
              >
                <div data-testid="manual-content">
                  <Timestamp prefix="activated at" />
                </div>
              </Partial>
              <div style={{ marginTop: "0.75rem" }}>
                <ActivateButton partialId="manual" label="Activate manually" />
              </div>
            </section>

            {/* ── 2. <WhenStored> — storage-triggered ───────────────── */}
            <section
              data-testid="section-stored"
              className="card"
              style={{ marginBottom: "2rem" }}
            >
              <h2>
                2. <code>&lt;WhenStored&gt;</code> — activates when localStorage
                key appears
              </h2>
              <p style={{ color: "#888", marginBottom: "0.75rem" }}>
                The activator reads <code>localStorage["demo-stored"]</code> on
                mount and on <code>storage</code> events. When present,
                activates the Partial and passes the value in via{" "}
                <code>__inputs.stored</code>.
              </p>
              <Partial
                id="stored"
                defer={<WhenStored storageKey="demo-stored" as="stored" />}
                fallback={
                  <div
                    data-testid="stored-fallback"
                    style={{ color: "#888", fontStyle: "italic" }}
                  >
                    dormant — set <code>localStorage["demo-stored"]</code> to
                    activate
                  </div>
                }
              >
                <StoredContent />
              </Partial>
              <StorageKeyEditor storageKey="demo-stored" testId="demo-stored" />
            </section>

            {/* ── 4. Batched activation: two WhenStored → one RSC ──── */}
            <section
              data-testid="section-batch"
              className="card"
              style={{ marginBottom: "2rem" }}
            >
              <h2>
                4. Batched activation
              </h2>
              <p style={{ color: "#888", marginBottom: "0.75rem" }}>
                Two <code>&lt;Partial defer=&lt;WhenStored/&gt;&gt;</code>
                siblings with distinct keys. Pre-set both keys (via
                <code>localStorage.setItem</code> BEFORE the page loads),
                and the two activators fire in the same commit pass. The
                microtask-batched dispatch should coalesce them into a
                SINGLE RSC request listing both ids in{" "}
                <code>?partials=</code>.
              </p>
              <Partial
                id="batch-a"
                defer={<WhenStored storageKey="batch-a-key" as="stored" />}
                fallback={
                  <div
                    data-testid="batch-a-fallback"
                    style={{ color: "#888", fontStyle: "italic" }}
                  >
                    dormant — set <code>localStorage["batch-a-key"]</code>{" "}
                    before loading to activate
                  </div>
                }
              >
                <StoredContent />
              </Partial>
              <div style={{ height: "0.5rem" }} />
              <Partial
                id="batch-b"
                defer={<WhenStored storageKey="batch-b-key" as="stored" />}
                fallback={
                  <div
                    data-testid="batch-b-fallback"
                    style={{ color: "#888", fontStyle: "italic" }}
                  >
                    dormant — set <code>localStorage["batch-b-key"]</code>{" "}
                    before loading to activate
                  </div>
                }
              >
                <StoredContent />
              </Partial>
              <div style={{ marginTop: "0.75rem" }}>
                <StorageKeyEditor
                  storageKey="batch-a-key"
                  testId="batch-a-key"
                />
                <StorageKeyEditor
                  storageKey="batch-b-key"
                  testId="batch-b-key"
                />
              </div>
            </section>

            {/* ── 5. Streaming + defer race ──────────────────────────── */}
            <section
              data-testid="section-race"
              className="card"
              style={{ marginBottom: "2rem" }}
            >
              <h2>5. Streaming + defer race</h2>
              <p style={{ color: "#888", marginBottom: "0.75rem" }}>
                The <code>&lt;SlowContent/&gt;</code> partial suspends for
                ~1.5s during initial render. A neighboring deferred
                Partial (<code>defer=&lt;WhenVisible/&gt;</code>, fallback
                already on-screen) activates on mount. Its refetch should
                land and its content should appear <em>before</em> the
                slow partial resolves — proving the two flows don't
                serialize.
              </p>
              <Partial
                id="slow-stream"
                fallback={
                  <div
                    data-testid="slow-fallback"
                    style={{ color: "#888", fontStyle: "italic" }}
                  >
                    slow content streaming… (1.5s)
                  </div>
                }
              >
                <SlowContent />
              </Partial>
              <div style={{ height: "0.5rem" }} />
              <Partial
                id="race-defer"
                defer={<WhenMounted />}
                fallback={
                  <div
                    data-testid="race-defer-fallback"
                    style={{ color: "#888", fontStyle: "italic" }}
                  >
                    dormant — activates immediately on mount
                  </div>
                }
              >
                <div data-testid="race-defer-content">
                  <Timestamp prefix="race defer activated at" />
                </div>
              </Partial>
            </section>

            {/* ── 6. Concurrent refetches across distinct ids ───────── */}
            <section
              data-testid="section-concurrent"
              className="card"
              style={{ marginBottom: "2rem" }}
            >
              <h2>6. Concurrent refetches — independent ids</h2>
              <p style={{ color: "#888", marginBottom: "0.75rem" }}>
                Three Partials with staggered artificial delays (400ms,
                800ms, 1200ms). Clicking the buttons in rapid succession
                fires three independent RSC requests that run in
                parallel on the server. Total wall time is{" "}
                <em>max(delays)</em>, not <em>sum</em>.
              </p>
              <p style={{ color: "#888", marginBottom: "0.75rem" }}>
                <strong>Behavior notes.</strong> Each click is its own
                event task → own microtask → own RSC request. Clicking
                in quick succession (one click at a time) fires three
                overlapping requests that run in parallel on the server.
                The buttons pass{" "}
                <code>disableTransition: true</code> so each response
                commits on arrival; the default transition-wrapped mode
                is safest for same-id repeats (suppresses stale
                flashes) but can collapse intermediate commits under
                heavy fan-out — use <code>disableTransition</code> for
                disjoint-id parallelism like this.
              </p>
              <Partial
                id="concurrent-a"
                tags="concurrent"
                fallback={
                  <div
                    data-testid="concurrent-a-fallback"
                    style={{ color: "#888" }}
                  >
                    a (400ms): streaming…
                  </div>
                }
              >
                <DelayedClock delayMs={400} label="a" />
              </Partial>
              <div style={{ height: "0.5rem" }} />
              <Partial
                id="concurrent-b"
                tags="concurrent"
                fallback={
                  <div
                    data-testid="concurrent-b-fallback"
                    style={{ color: "#888" }}
                  >
                    b (800ms): streaming…
                  </div>
                }
              >
                <DelayedClock delayMs={800} label="b" />
              </Partial>
              <div style={{ height: "0.5rem" }} />
              <Partial
                id="concurrent-c"
                tags="concurrent"
                fallback={
                  <div
                    data-testid="concurrent-c-fallback"
                    style={{ color: "#888" }}
                  >
                    c (1200ms): streaming…
                  </div>
                }
              >
                <DelayedClock delayMs={1200} label="c" />
              </Partial>
              <div
                style={{
                  marginTop: "0.75rem",
                  display: "flex",
                  gap: "0.5rem",
                  flexWrap: "wrap",
                }}
              >
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
            </section>

            {/* ── 3. <WhenVisible> — viewport-triggered ─────────────── */}
            <section
              data-testid="section-any"
              className="card"
              style={{ marginBottom: "2rem" }}
            >
              <h2>
                3. <code>&lt;WhenVisible&gt;</code> — activates when the
                fallback enters the viewport
              </h2>
              <p style={{ color: "#888", marginBottom: "0.75rem" }}>
                Activates when the fallback scrolls into view. Uses an{" "}
                <code>IntersectionObserver</code> attached to the fallback's
                DOM range via a Fragment ref.
              </p>
              <div
                data-testid="any-spacer"
                style={{ height: "90vh" }}
                aria-hidden="true"
              />
              <Partial
                id="any"
                defer={<WhenVisible />}
                fallback={
                  <div
                    data-testid="any-fallback"
                    style={{ color: "#888", fontStyle: "italic" }}
                  >
                    dormant — scroll into view to activate
                  </div>
                }
              >
                <div data-testid="any-content">
                  <Timestamp prefix="activated at" />
                </div>
              </Partial>
            </section>
          </main>
        </body>
      </html>
    </PartialRoot>
  );
}
