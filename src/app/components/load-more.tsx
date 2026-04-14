"use client";

import { useEffect, useRef } from "react";
import { usePartial } from "../../lib/partial-client.tsx";

/**
 * Tracks which page partials are currently visible.
 * When scrolling up and a page leaves the viewport,
 * silently updates ?pages= to the highest visible page.
 */
const visiblePages = new Set<number>();

function silentlyUpdatePages() {
  if (visiblePages.size === 0) return;
  const maxVisible = Math.max(...visiblePages);
  const url = new URL(window.location.href);
  const current = Number(url.searchParams.get("pages")) || 1;

  if (maxVisible < current) {
    // Scrolling up — update URL for bookmarking/refresh without
    // triggering a server fetch. Uses the unpatched replaceState
    // so the navigation listener in entry.browser doesn't fire.
    url.searchParams.set("pages", String(maxVisible));
    History.prototype.replaceState.call(
      history,
      history.state,
      "",
      url.toString(),
    );
  }
}

/**
 * Invisible sentinel placed at the top of each page partial.
 * Tracks visibility so ?pages= stays in sync with scroll position.
 */
export function PageSentinel({ page }: { page: number }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        visiblePages.add(page);
      } else {
        visiblePages.delete(page);
        silentlyUpdatePages();
      }
    });

    observer.observe(el);
    return () => {
      observer.disconnect();
      visiblePages.delete(page);
    };
  }, [page]);

  return <div ref={ref} style={{ height: 0 }} />;
}

/**
 * Sentinel element that triggers loading the next page of results
 * when it enters the viewport via IntersectionObserver.
 *
 * Updates the URL silently (native replaceState, bypassing the patched
 * one in entry.browser so no full navigation fires), then dispatches a
 * partial refetch for the new page partial and the load-more sentinel
 * itself. Previously rendered page partials stay in the client cache —
 * and so does any other unrelated partial (e.g. an open search overlay).
 */
export function LoadMore({ nextPage }: { nextPage: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const triggered = useRef(false);
  const [dispatchPage, isPendingPage] = usePartial(`page-${nextPage}`);
  const [dispatchLoadMore, isPendingLoadMore] = usePartial("load-more");
  const isPending = isPendingPage || isPendingLoadMore;

  useEffect(() => {
    triggered.current = false;
  }, [nextPage]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        // Don't auto-paginate while the search overlay is active. The
        // sentinel is geometrically behind the <dialog> but still
        // "intersecting" the viewport — IntersectionObserver checks
        // geometry, not occlusion. Auto-firing here would race with
        // the user's keystroke dispatches into the search stages.
        if (new URL(window.location.href).searchParams.has("search")) return;

        if (entry.isIntersecting && !triggered.current) {
          triggered.current = true;
          // Silent URL update for bookmarkability — bypasses the patched
          // replaceState so the navigation listener in entry.browser.tsx
          // doesn't fire a full-page refetch.
          const url = new URL(window.location.href);
          url.searchParams.set("pages", String(nextPage));
          History.prototype.replaceState.call(
            history,
            history.state,
            "",
            url.toString(),
          );
          // Partial refetch: only the new page and the load-more sentinel
          // are fresh. Everything else is served from the client cache.
          dispatchPage();
          dispatchLoadMore();
        }
      },
      { rootMargin: "200px" },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [nextPage, dispatchPage, dispatchLoadMore]);

  return (
    <div ref={ref} style={{ padding: "2rem", textAlign: "center" }}>
      {isPending && (
        <span
          style={{
            display: "inline-block",
            width: 24,
            height: 24,
            border: "3px solid #2d3748",
            borderTopColor: "#58a6ff",
            borderRadius: "50%",
            animation: "spin 0.6s linear infinite",
          }}
        />
      )}
    </div>
  );
}
