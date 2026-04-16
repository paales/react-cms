"use client";

import { useTransition } from "react";
import { usePartial } from "../../lib/partial-client.tsx";

/**
 * Client-side buttons to trigger refetches against the cache-demo
 * partials. Use these to verify that refetching a cached partial
 * doesn't re-run its server component body (check
 * data-testid="server-render-count" before/after).
 */
export function CacheControls() {
  const [dispatchSlow, pendingSlow] = usePartial("slow");
  const [dispatchClock, pendingClock] = usePartial("clock");
  const [isPending, startTransition] = useTransition();

  const pending = pendingSlow || pendingClock || isPending;

  return (
    <div
      style={{
        display: "flex",
        gap: "0.5rem",
        marginBottom: "1rem",
        flexWrap: "wrap",
      }}
    >
      <button
        type="button"
        onClick={() => startTransition(() => { void dispatchSlow(); })}
        data-testid="refetch-slow"
      >
        Refetch slow
      </button>
      <button
        type="button"
        onClick={() => startTransition(() => { void dispatchClock(); })}
        data-testid="refetch-clock"
      >
        Refetch clock
      </button>
      <button
        type="button"
        onClick={() => {
          const url = new URL(window.location.href);
          const current = url.searchParams.get("flavor") ?? "vanilla";
          const next = current === "vanilla" ? "chocolate" : "vanilla";
          url.searchParams.set("flavor", next);
          window.history.pushState(null, "", url.toString());
          startTransition(() => { void dispatchSlow(); });
        }}
        data-testid="toggle-flavor"
      >
        Toggle flavor
      </button>
      {pending && <span style={{ color: "#888" }}>…</span>}
    </div>
  );
}
