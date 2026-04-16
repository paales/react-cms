"use client";

import { useTransition } from "react";

/**
 * Refreshes every product's live-price partial in a single request.
 *
 * Works via tag-based refetch: each `<Partial id={"price-" + sku}
 * tags={["price"]}>…</Partial>` registers its tag on the server, so
 * `?tags=price` resolves (through the route registry) to the full
 * set of currently-known price partial ids. Rather than dispatch N
 * individual `usePartial` calls, we hit `__rsc_partial_refetch`
 * directly with the tag query — one roundtrip, one cache mode render.
 */
export function RefreshAllPricesButton() {
  const [isPending, startTransition] = useTransition();

  function refreshAll() {
    startTransition(async () => {
      const handler = (window as Window & {
        __rsc_partial_refetch?: (url: string) => Promise<void>;
      }).__rsc_partial_refetch;
      if (!handler) return;
      const url = new URL(window.location.href);
      url.searchParams.set("tags", "price");
      url.searchParams.set("revalidate", "1");
      await handler(url.toString());
    });
  }

  return (
    <button
      type="button"
      data-testid="refresh-all-prices"
      onClick={refreshAll}
      disabled={isPending}
      style={{
        background: "#2d3748",
        color: "#ededed",
        border: "1px solid #4a5568",
        padding: "0.5rem 1rem",
        borderRadius: 6,
        cursor: isPending ? "wait" : "pointer",
        fontSize: "0.9rem",
        marginBottom: "1rem",
      }}
    >
      {isPending ? "Refreshing all prices…" : "Refresh all prices"}
    </button>
  );
}
