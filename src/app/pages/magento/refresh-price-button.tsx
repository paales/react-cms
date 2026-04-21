"use client";

import { useState } from "react";
import { useNavigation } from "../../../lib/partial-client.tsx";

/**
 * Refetches the per-product live-price partial. The partial id mirrors
 * the one declared in the server-side `.map()` — `price-${sku}` — which
 * is only reachable via the route-scoped registry (the bootstrap walk
 * in `PartialRoot` can't see through `ProductGrid`).
 */
export function RefreshPriceButton({ sku }: { sku: string }) {
  const nav = useNavigation();
  const [isPending, setIsPending] = useState(false);
  async function refresh() {
    setIsPending(true);
    try {
      await nav.reload({ ids: [`price-${sku}`] });
    } finally {
      setIsPending(false);
    }
  }
  return (
    <button
      type="button"
      data-testid={`refresh-price-${sku}`}
      onClick={refresh}
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
