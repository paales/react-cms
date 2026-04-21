"use client";

import { useEffect, useRef, useState } from "react";
import { useNavigation } from "../../lib/partial-client.tsx";

/**
 * Tracks which page partials are currently visible.
 * When scrolling up and a page leaves the viewport,
 * silently updates ?pages= to the highest visible page.
 *
 * The URL update is bookmarkable but does NOT trigger a refetch —
 * `navigate(url, { silent: true })` replaces the URL without
 * any server round-trip.
 */
const visiblePages = new Set<number>();

function silentlyUpdatePages(
  nav: ReturnType<typeof useNavigation>,
) {
  if (visiblePages.size === 0) return;
  const maxVisible = Math.max(...visiblePages);
  const url = new URL(window.location.href);
  const current = Number(url.searchParams.get("pages")) || 1;

  if (maxVisible < current) {
    // Scrolling up — update URL for bookmarking/refresh without
    // triggering a refetch.
    url.searchParams.set("pages", String(maxVisible));
    void nav.navigate(url.toString(), { history: "replace", silent: true });
  }
}

/**
 * Invisible sentinel placed at the top of each page partial.
 * Tracks visibility so ?pages= stays in sync with scroll position.
 */
export function PageSentinel({ page }: { page: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const nav = useNavigation();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        visiblePages.add(page);
        return;
      }
      // Only trigger the silent URL update when a page that *was* visible
      // leaves the viewport. Without this guard, a newly mounted page that
      // has not yet been scrolled to fires an initial "not intersecting"
      // event, which yanks the URL back down and races with LoadMore
      // bumping it up again — causing the URL to flip between N and N+1
      // on pageload.
      if (!visiblePages.has(page)) return;
      visiblePages.delete(page);
      silentlyUpdatePages(nav);
    });

    observer.observe(el);
    return () => {
      observer.disconnect();
      visiblePages.delete(page);
    };
  }, [page, nav]);

  return <div ref={ref} style={{ height: 0 }} />;
}

/**
 * Sentinel element that triggers loading the next page of results
 * when it enters the viewport via IntersectionObserver.
 *
 * Updates the URL and dispatches a targeted refetch for the new
 * page partial and the load-more sentinel itself in one call:
 * `navigate(url, { history: "replace", ids: [...] })`. Previously
 * rendered page partials stay in the client cache — and so does any
 * other unrelated partial (e.g. an open search overlay).
 */
export function LoadMore({ nextPage }: { nextPage: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const triggered = useRef(false);
  const nav = useNavigation();
  const [isPending, setIsPending] = useState(false);

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
          const url = new URL(window.location.href);
          url.searchParams.set("pages", String(nextPage));
          setIsPending(true);
          nav
            .navigate(url.toString(), {
              history: "replace",
              ids: [`page-${nextPage}`, "load-more"],
            })
            .finally(() => setIsPending(false));
        }
      },
      { rootMargin: "200px" },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [nextPage, nav]);

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
