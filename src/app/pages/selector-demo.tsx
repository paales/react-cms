import { Partial, PartialRoot } from "../../lib/partial.tsx";
import { AppNav } from "../components/app-nav.tsx";
import { SelectorRefetchButton } from "../components/selector-demo-controls.tsx";

/**
 * `/selector-demo` — exercises tag-based refetch.
 *
 *   <Partial tags="product">            // id-less; addressable only via tag
 *   <Partial id="price-a" tags="price"> // price family; each member has an id
 *   <Partial id="price-b" tags="price featured"> // same family, extra "featured" tag
 *
 * Buttons call `useNavigation().reload({tags: [...]})` or
 * `reload({ids: [...]})`. Tags are resolved server-side against the
 * route-scoped partial registry, so dynamic partials (produced inside
 * opaque components, `.map()` loops, etc.) are addressable the same
 * as static ones. Every Partial renders a fresh server timestamp so
 * visible refresh maps 1-to-1 with the target set.
 */

function ServerTime({ label }: { label: string }) {
  return (
    <div data-testid={`time-${label}`} style={{ fontFamily: "ui-monospace, monospace" }}>
      <strong>{label}:</strong> {new Date().toISOString()}
    </div>
  );
}

export function SelectorDemoPage() {
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
            <title>Selector Demo</title>
            <style>{`
              * { box-sizing: border-box; margin: 0; padding: 0; }
              body { font-family: system-ui, -apple-system, sans-serif; background: #0a0a0a; color: #ededed; padding: 2rem; max-width: 900px; margin: 0 auto; }
              a { color: #58a6ff; text-decoration: none; }
              a:hover { text-decoration: underline; }
              h1 { font-size: 1.75rem; margin-bottom: 1rem; }
              h2 { font-size: 1.1rem; margin-bottom: 0.5rem; }
              code { background: #2d3748; padding: 0.1rem 0.3rem; border-radius: 4px; font-size: 0.85rem; }
              .card { background: #1a1a2e; border-radius: 12px; padding: 1.25rem; margin-bottom: 1rem; }
              button { background: #2d3748; color: #ededed; border: 1px solid #4a5568; padding: 0.5rem 0.9rem; border-radius: 6px; cursor: pointer; font-size: 0.85rem; margin-right: 0.5rem; }
              button:hover { background: #4a5568; }
            `}</style>
          </head>
        </Partial>
        <body>
          <AppNav />
          <main style={{ padding: "1rem 0" }}>
            <h1 style={{ marginBottom: "1rem" }}>
              Selector-based refetch
            </h1>
            <p style={{ color: "#888", marginBottom: "2rem" }}>
              <code>useNavigation().reload({"{tags: ['price']}"})</code>{" "}
              refetches every Partial carrying that tag. Multiple tags
              union (<code>{"{tags: ['price', 'featured']}"}</code> hits
              any partial carrying either tag). Ids target a single
              partial.
            </p>

            <section className="card" style={{ marginBottom: "1.5rem" }}>
              <h2>
                <code>&lt;Partial tags="product"&gt;</code> — id-less
              </h2>
              <p style={{ color: "#888", marginBottom: "0.75rem" }}>
                No explicit id. Synthesizes <code>__anon:product</code>{" "}
                internally. Only addressable via <code>.product</code>.
              </p>
              <Partial tags="product">
                <ServerTime label="product" />
              </Partial>
            </section>

            <section className="card" style={{ marginBottom: "1.5rem" }}>
              <h2>
                <code>&lt;Partial tags="price"&gt;</code> family
              </h2>
              <p style={{ color: "#888", marginBottom: "0.75rem" }}>
                Three siblings sharing <code>price</code>; two also carry{" "}
                <code>featured</code>. Tag-intersection lets you refresh a
                subset without plumbing ids through props.
              </p>
              <Partial id="price-a" tags="price">
                <ServerTime label="price-a" />
              </Partial>
              <Partial id="price-b" tags="price featured">
                <ServerTime label="price-b" />
              </Partial>
              <Partial id="price-c" tags="price featured">
                <ServerTime label="price-c" />
              </Partial>
            </section>

            <section className="card">
              <h2>Refetch controls</h2>
              <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                <SelectorRefetchButton
                  tags={["product"]}
                  label="refetch .product"
                  testId="refresh-product"
                />
                <SelectorRefetchButton
                  tags={["price"]}
                  label="refetch .price (3 partials)"
                  testId="refresh-price"
                />
                <SelectorRefetchButton
                  tags={["featured"]}
                  label="refetch .featured (2 partials)"
                  testId="refresh-price-featured"
                />
                <SelectorRefetchButton
                  ids={["price-a"]}
                  label="refetch #price-a"
                  testId="refresh-price-a"
                />
              </div>
            </section>
          </main>
        </body>
      </html>
    </PartialRoot>
  );
}
