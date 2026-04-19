import { PartialRoot, Partial } from "../../lib/partial.tsx";
import { AppNav } from "../components/app-nav.tsx";

/**
 * Default 404 page. Rendered by `Root` when a page component throws
 * `notFound()`. Authors can replace this with their own component by
 * intercepting the render path in `Root`.
 */
export function NotFoundPage() {
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
            <title>404 — Not Found</title>
            <style>{`
              * { box-sizing: border-box; margin: 0; padding: 0; }
              body { font-family: system-ui, -apple-system, sans-serif; background: #0a0a0a; color: #ededed; padding: 2rem; max-width: 900px; margin: 0 auto; }
              a { color: #58a6ff; text-decoration: none; }
              a:hover { text-decoration: underline; }
              h1 { font-size: 2.5rem; margin-bottom: 0.5rem; }
              .card { background: #1a1a2e; border-radius: 12px; padding: 2rem; margin-top: 1rem; text-align: center; }
              .muted { color: #888; margin-top: 0.5rem; }
              code { background: #2d3748; padding: 0.15rem 0.4rem; border-radius: 4px; font-size: 0.85rem; }
            `}</style>
          </head>
        </Partial>
        <body>
          <AppNav />
          <main data-testid="not-found">
            <section className="card">
              <h1>404</h1>
              <div className="muted">This URL doesn't match any known route.</div>
            </section>
          </main>
        </body>
      </html>
    </PartialRoot>
  );
}
