/**
 * Infinite-scroll demo for the `<Partial renderOn>`-via-singleton-slot
 * pattern.
 *
 * URL state: `?end=N` is the last page index in the active range
 * (default 1). The server renders pages 1..N each as `<Partial id="page-i">`,
 * then a singleton `<Partial id="next">` whose content is the
 * NextObserver client component. When that observer enters the viewport
 * it bumps `?end=` and refetches `page-{N+1}` + `next`. The new `next`
 * mounts with `currentEnd={N+1}` and re-arms.
 *
 * Reload / browser back-nav lands on `/bare?end=N` and the server
 * renders the full range up-front; ScrollRestore puts the user where
 * they were.
 */

import { PartialRoot, Partial } from "../../lib/partial.tsx";
import { NextObserver } from "../components/next-observer.tsx";
import { ScrollRestore } from "../components/scroll-restore.tsx";
import { AppNav } from "../components/app-nav.tsx";
import { getRequest } from "../../framework/context.ts";

const ITEMS_PER_PAGE = 10;
const ITEM_HEIGHT = 80;

function PageBlock({ page }: { page: number }) {
  const offset = (page - 1) * ITEMS_PER_PAGE;
  return (
    <section
      data-testid={`page-${page}`}
      data-page={page}
      style={{ marginBottom: "1rem" }}
    >
      <h2 style={{ color: "#888", fontSize: "0.9rem", padding: "0.5rem 0" }}>
        Page {page}
      </h2>
      {Array.from({ length: ITEMS_PER_PAGE }, (_, i) => {
        const itemId = offset + i + 1;
        return (
          <div
            key={itemId}
            data-testid={`item-${itemId}`}
            style={{
              height: ITEM_HEIGHT,
              padding: "1rem",
              marginBottom: "0.5rem",
              background: "#1a1a2e",
              borderRadius: 8,
              display: "flex",
              alignItems: "center",
            }}
          >
            Item #{itemId}
          </div>
        );
      })}
    </section>
  );
}

export function BarePage() {
  const url = new URL(getRequest().url);
  const end = Math.max(1, Number(url.searchParams.get("end")) || 1);

  const pages = Array.from({ length: end }, (_, i) => {
    const page = i + 1;
    return (
      <Partial key={`page-${page}`} id={`page-${page}`}>
        <PageBlock page={page} />
      </Partial>
    );
  });

  return (
    <PartialRoot>
      <html lang="en">
        <Partial id="head">
          <head>
            <meta charSet="UTF-8" />
            <title>Infinite Scroll Test</title>
            <style>{`
              body { font-family: system-ui, sans-serif; background: #0a0a0a; color: #ededed; padding: 2rem; max-width: 800px; margin: 0 auto; }
              a { color: #58a6ff; }
            `}</style>
          </head>
        </Partial>
        <body>
          <ScrollRestore />
          <Partial id="nav">
            <AppNav />
          </Partial>
          <h1>Infinite Scroll (renderOn-style singleton slot)</h1>
          <p style={{ color: "#888", marginBottom: "1rem" }}>
            <a href="/" data-testid="link-home">← Home</a>
            {" · "}
            <span data-testid="end-readout">end={end}</span>
          </p>
          {pages}
          <Partial id="next">
            <NextObserver currentEnd={end} />
          </Partial>
        </body>
      </html>
    </PartialRoot>
  );
}
