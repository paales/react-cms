import { Partial, PartialRoot } from "../../lib/partial.tsx";
import { WhenVisible } from "../../lib/when-visible.tsx";
import { WhenStored } from "../../lib/when-stored.tsx";
import { AnyOf } from "../../lib/any-of.tsx";
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
 *   3. `defer={<AnyOf activators={<><WhenVisible/><WhenStored/></>}/>}` —
 *      first-to-fire composition.
 *
 * Each activated content renders a server timestamp so the RSC
 * round-trip is visible (and assertable).
 *
 * NOTE on layout: all content is inlined into a single component body,
 * not factored into intermediate `<Section>` server components. Reason:
 * the framework's `buildTemplate` walk only sees Partials that are
 * direct JSX descendants of `<PartialRoot>`. A Partial hidden inside an
 * intermediate opaque component would execute on both the template
 * path and the children path, triggering a duplicate-id error. This
 * mirrors how `<MagentoPage>` is structured.
 */
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
          <Partial id="nav">
            <AppNav />
          </Partial>
          <main style={{ padding: "1rem 0" }}>
            <h1 style={{ marginBottom: "1rem" }}>
              Partial defer — feature demo
            </h1>
            <p style={{ color: "#888", marginBottom: "2rem" }}>
              Three activation shapes for{" "}
              <code>&lt;Partial defer&gt;</code>. Each section stays
              dormant until its trigger fires; the activated content
              renders a server timestamp so you can confirm the RSC
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
                <ActivateButton
                  partialId="manual"
                  label="Activate manually"
                />
              </div>
            </section>

            {/* ── 2. <WhenStored> — storage-triggered ───────────────── */}
            <section
              data-testid="section-stored"
              className="card"
              style={{ marginBottom: "2rem" }}
            >
              <h2>
                2. <code>&lt;WhenStored&gt;</code> — activates when
                localStorage key appears
              </h2>
              <p style={{ color: "#888", marginBottom: "0.75rem" }}>
                The activator reads{" "}
                <code>localStorage["demo-stored"]</code> on mount and on{" "}
                <code>storage</code> events. When present, activates the
                Partial and passes the value in via{" "}
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
                    dormant — set{" "}
                    <code>localStorage["demo-stored"]</code> to activate
                  </div>
                }
              >
                <StoredContent />
              </Partial>
              <StorageKeyEditor
                storageKey="demo-stored"
                testId="demo-stored"
              />
            </section>

            {/* ── 3. <AnyOf> — visible OR stored composition ──────── */}
            <section
              data-testid="section-any"
              className="card"
              style={{ marginBottom: "2rem" }}
            >
              <h2>
                3. <code>&lt;AnyOf&gt;</code> — visible OR stored
                activation
              </h2>
              <p style={{ color: "#888", marginBottom: "0.75rem" }}>
                Activates when <em>either</em> the fallback scrolls into
                view <em>or</em> <code>localStorage["demo-any"]</code> is
                set. First trigger wins.
              </p>
              <StorageKeyEditor storageKey="demo-any" testId="demo-any" />
              <div
                data-testid="any-spacer"
                style={{ height: "90vh" }}
                aria-hidden="true"
              />
              <Partial
                id="any"
                defer={
                  <AnyOf
                    activators={
                      <>
                        <WhenVisible />
                        <WhenStored storageKey="demo-any" />
                      </>
                    }
                  />
                }
                fallback={
                  <div
                    data-testid="any-fallback"
                    style={{ color: "#888", fontStyle: "italic" }}
                  >
                    dormant — scroll into view OR set the key above
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
