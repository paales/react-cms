"use client";

import { useTransition } from "react";
import { useNavigation } from "../../lib/partial-client.tsx";

/**
 * Client-side buttons to trigger refetches against the cache-demo
 * partials. Use these to verify that refetching a cached partial
 * doesn't re-run its server component body (check
 * data-testid="server-render-count" before/after).
 */
export function CacheControls() {
  const nav = useNavigation();
  const [isPending, startTransition] = useTransition();

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
        onClick={() =>
          startTransition(() => {
            void nav.reload({ ids: ["slow"] });
          })
        }
        data-testid="refetch-slow"
      >
        Refetch slow
      </button>
      <button
        type="button"
        onClick={() =>
          startTransition(() => {
            void nav.reload({ ids: ["clock"] });
          })
        }
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
          startTransition(() => {
            void nav.navigate(url.toString(), {
              history: "push",
              ids: ["slow"],
            });
          });
        }}
        data-testid="toggle-flavor"
      >
        Toggle flavor
      </button>
      {isPending && <span style={{ color: "#888" }}>…</span>}
    </div>
  );
}
