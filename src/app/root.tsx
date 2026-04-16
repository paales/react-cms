import { PokemonPage } from "./pages/pokemon.tsx";
import { MagentoPage } from "./pages/magento/product-list.tsx";
import { BarePage } from "./pages/bare-stream.tsx";
import { CacheDemoPage } from "./pages/cache-demo.tsx";
import { PartialRoot, Partial } from "../lib/partial.tsx";
import { getRequest } from "../framework/context.ts";
import { matchPath, pickRoute } from "../framework/router.ts";
import { DebugToolbar } from "./components/debug-toolbar.tsx";

export function Root() {
  const url = new URL(getRequest().url);

  if (matchPath(url, "/bare")) return <BarePage />;
  if (matchPath(url, "/cache-demo")) return <CacheDemoPage />;

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
            <title>React Partials</title>
            <style>{`
              * { box-sizing: border-box; margin: 0; padding: 0; }
              body { font-family: system-ui, -apple-system, sans-serif; background: #0a0a0a; color: #ededed; padding: 2rem; max-width: 900px; margin: 0 auto; }
              a { color: #58a6ff; text-decoration: none; }
              a:hover { text-decoration: underline; }
              h1 { font-size: 1.75rem; margin-bottom: 1rem; }
              h2 { font-size: 1.25rem; margin-bottom: 0.5rem; }
              .card { background: #1a1a2e; border-radius: 12px; padding: 1.25rem; margin-bottom: 1rem; }
              .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 1rem; }
              .badge { display: inline-block; padding: 0.25rem 0.75rem; border-radius: 999px; font-size: 0.8rem; font-weight: 600; margin-right: 0.5rem; }
              .badge-grass { background: #22543d; color: #9ae6b4; }
              .badge-fire { background: #742a2a; color: #feb2b2; }
              .badge-water { background: #2a4365; color: #90cdf4; }
              .badge-electric { background: #744210; color: #fefcbf; }
              .badge-normal { background: #2d3748; color: #e2e8f0; }
              .badge-poison { background: #553c6b; color: #d6bcfa; }
              .badge-bug { background: #2f4f2f; color: #b5e8b5; }
              .badge-flying { background: #3b4c7a; color: #b3c5f7; }
              .badge-default { background: #2d3748; color: #e2e8f0; }
              .sprite { image-rendering: pixelated; width: 96px; height: 96px; }
              .meta { color: #888; font-size: 0.85rem; margin-top: 0.5rem; }
              .meta code { background: #2d3748; padding: 0.15rem 0.4rem; border-radius: 4px; font-size: 0.75rem; }
              nav { margin-bottom: 2rem; padding-bottom: 1rem; border-bottom: 1px solid #2d3748; }
              .query-debug { background: #111; border: 1px solid #333; border-radius: 8px; padding: 1rem; margin-top: 2rem; overflow-x: auto; }
              .query-debug pre { font-size: 0.75rem; color: #8b8; white-space: pre-wrap; }
              .partial-controls { display: flex; gap: 0.5rem; margin-bottom: 1rem; flex-wrap: wrap; }
              .partial-controls button { background: #2d3748; color: #ededed; border: 1px solid #4a5568; padding: 0.4rem 0.8rem; border-radius: 6px; cursor: pointer; font-size: 0.8rem; }
              .partial-controls button:hover { background: #4a5568; }
              @keyframes spin { to { transform: rotate(360deg); } }
            `}</style>
          </head>
        </Partial>
        <body>
          <Partial id="nav">
            <nav>
              <a href="/">Pokemon</a>
              {" · "}
              <a href="/magento">Magento Store</a>
            </nav>
          </Partial>
          {pickRoute(url, [
            ["/magento", () => MagentoPage()],
            ["/magento/*", () => MagentoPage()],
            ["/*", () => PokemonPage()],
          ])}
          {import.meta.env.DEV && <DebugToolbar />}
        </body>
      </html>
    </PartialRoot>
  );
}
