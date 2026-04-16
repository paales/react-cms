"use client";

import { useState } from "react";

/**
 * Minimal client component used inside the cache-demo's cached
 * subtree. Validates that `<Cache>`'s buffer/decode round-trip
 * preserves client references (module id + export name) so the
 * component still hydrates and retains state across cache hits.
 */
export function ClickCounter() {
  const [n, setN] = useState(0);
  return (
    <button
      type="button"
      onClick={() => setN((x) => x + 1)}
      data-testid="click-counter"
      style={{
        background: "#2d3748",
        color: "#ededed",
        border: "1px solid #4a5568",
        padding: "0.3rem 0.6rem",
        borderRadius: 6,
        fontSize: "0.8rem",
      }}
    >
      clicked {n}×
    </button>
  );
}
