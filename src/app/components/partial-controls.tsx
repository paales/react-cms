"use client";

import { useState } from "react";
import { useNavigation } from "../../lib/partial-client.tsx";

/**
 * Client component demonstrating partial-level re-fetching.
 *
 * Each button calls `useNavigation().reload({ids: ["…"]})` — a targeted
 * refetch of one partial. Multiple reloads in the same tick are
 * batched into one RSC request by the navigation dispatcher.
 */
export function PartialControls() {
  const nav = useNavigation();
  const [pending, setPending] = useState<string | null>(null);

  async function refresh(id: string) {
    setPending(id);
    try {
      await nav.reload({ ids: [id] });
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="partial-controls">
      <span style={{ color: "#888", fontSize: "0.8rem", alignSelf: "center" }}>
        reload({'{'}ids{'}'}):
      </span>
      <button
        type="button"
        onClick={() => refresh("hero")}
        disabled={pending === "hero"}
      >
        {pending === "hero" ? "Refreshing..." : "Refresh Hero"}
      </button>
      <button
        type="button"
        onClick={() => refresh("stats")}
        disabled={pending === "stats"}
      >
        {pending === "stats" ? "Refreshing..." : "Refresh Stats"}
      </button>
      <button
        type="button"
        onClick={() => refresh("species")}
        disabled={pending === "species"}
      >
        {pending === "species" ? "Refreshing..." : "Refresh Species"}
      </button>
    </div>
  );
}
