/**
 * Infinite-scroll demo for the `<Partial renderOn>`-via-singleton-slot
 * pattern.
 *
 * URL state: `?end=N` is the last page index in the active range
 * (default 1). The server renders pages 1..N each as `<Partial selector="#page-i">`,
 * then a singleton `<Partial selector="#next">` whose content is the
 * NextObserver client component. When that observer enters the viewport
 * it bumps `?end=` and refetches `page-{N+1}` + `next`. The new `next`
 * mounts with `currentEnd={N+1}` and re-arms.
 *
 * Reload / browser back-nav lands on `/bare?end=N` and the server
 * renders the full range up-front; ScrollRestore puts the user where
 * they were.
 */

import { Partial } from "../../lib/partial.tsx";
import { ROOT } from "../../lib/partial-context.ts";
import { NextObserver } from "../components/next-observer.tsx";
import { ScrollRestore } from "../components/scroll-restore.tsx";
import { getSearchParam } from "../../framework/context.ts";

const ITEMS_PER_PAGE = 10;

function PageBlock({ page }: { page: number }) {
  const offset = (page - 1) * ITEMS_PER_PAGE;
  return (
    <section data-testid={`page-${page}`} data-page={page} className="mb-4">
      <h2 className="py-2 text-sm text-muted-foreground">Page {page}</h2>
      {Array.from({ length: ITEMS_PER_PAGE }, (_, i) => {
        const itemId = offset + i + 1;
        return (
          <div
            key={itemId}
            data-testid={`item-${itemId}`}
            className="mb-2 flex h-20 items-center rounded-lg bg-card p-4"
          >
            Item #{itemId}
          </div>
        );
      })}
    </section>
  );
}

export function BarePage() {
  const end = Math.max(1, Number(getSearchParam("end")) || 1);

  const pages = Array.from({ length: end }, (_, i) => {
    const page = i + 1;
    return (
      <Partial key={`page-${page}`} parent={ROOT} selector={`#page-${page}`}>
        <PageBlock page={page} />
      </Partial>
    );
  });

  return (
    <>
      <title>Infinite Scroll Test</title>
      <ScrollRestore />
      <h1 className="mb-4 text-2xl font-semibold">
        Infinite Scroll (renderOn-style singleton slot)
      </h1>
      <p className="mb-4 text-muted-foreground">
        <a
          href="/"
          data-testid="link-home"
          className="text-primary hover:underline"
        >
          ← Home
        </a>
        {" · "}
        <span data-testid="end-readout">end={end}</span>
      </p>
      {pages}
      <Partial parent={ROOT} selector="#next">
        <NextObserver currentEnd={end} />
      </Partial>
    </>
  );
}
