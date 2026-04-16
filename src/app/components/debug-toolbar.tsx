"use client";

import { useState, useTransition } from "react";

/**
 * Minimal dev-only toolbar for flushing server-side state — the
 * `<Cache>` store, the partial-data cache, and the route-scoped
 * partial registry — by calling `/__test/clear-caches` and then
 * triggering a fresh navigation to repopulate everything.
 *
 * Rendered as a fixed bottom-right pill so it doesn't interfere with
 * page layout. Not auto-gated on dev here because the endpoint it
 * calls already 404s in production.
 */
export function DebugToolbar() {
  const [isPending, startTransition] = useTransition();
  const [flashMessage, setFlashMessage] = useState<string | null>(null);

  function flushAll() {
    startTransition(async () => {
      try {
        const res = await fetch("/__test/clear-caches");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setFlashMessage("flushed — reloading");
        // Hard reload so the page re-renders against cold server state.
        window.location.reload();
      } catch (err) {
        setFlashMessage(
          `failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        setTimeout(() => setFlashMessage(null), 3000);
      }
    });
  }

  return (
    <div
      style={{
        position: "fixed",
        bottom: "1rem",
        right: "1rem",
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        gap: "0.5rem",
        padding: "0.4rem 0.6rem",
        background: "#1a1a2e",
        border: "1px solid #4a5568",
        borderRadius: 999,
        fontSize: "0.75rem",
        fontFamily: "system-ui, sans-serif",
        color: "#ededed",
        boxShadow: "0 4px 12px rgba(0, 0, 0, 0.3)",
      }}
      data-testid="debug-toolbar"
    >
      <span style={{ color: "#888" }}>debug</span>
      <button
        type="button"
        data-testid="debug-flush-cache"
        onClick={flushAll}
        disabled={isPending}
        style={{
          background: "#742a2a",
          color: "#fed7d7",
          border: "1px solid #9b2c2c",
          padding: "0.25rem 0.6rem",
          borderRadius: 999,
          cursor: isPending ? "wait" : "pointer",
          fontSize: "0.75rem",
          fontWeight: 600,
        }}
      >
        {isPending ? "flushing…" : "flush cache"}
      </button>
      {flashMessage && <span style={{ color: "#a0aec0" }}>{flashMessage}</span>}
    </div>
  );
}
