"use client";

import { usePartial } from "../../../lib/partial-client.tsx";

/**
 * Refetches the per-product live-price partial. The partial id mirrors
 * the one declared in the server-side `.map()` — `price-${sku}` — which
 * is only reachable via the route-scoped registry (the bootstrap walk
 * in `PartialRoot` can't see through `ProductGrid`).
 */
export function RefreshPriceButton({ sku }: { sku: string }) {
  const [refetch, isPending] = usePartial(`price-${sku}`);
  return (
    <button
      type="button"
      data-testid={`refresh-price-${sku}`}
      onClick={() => refetch()}
      disabled={isPending}
      style={{
        background: "transparent",
        color: "#58a6ff",
        border: "1px solid #2d3748",
        padding: "0.2rem 0.5rem",
        borderRadius: 4,
        cursor: isPending ? "wait" : "pointer",
        fontSize: "0.7rem",
      }}
    >
      {isPending ? "…" : "↻"}
    </button>
  );
}
