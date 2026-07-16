"use client"

import { useState } from "react"
import { useNavigation } from "@parton/framework/client"
import { Button } from "@parton/copies/components/ui/button"

/**
 * Client-side buttons to trigger refetches against the cache-demo
 * partials. Each hook owns its own progress so the "…" indicator
 * reflects only this widget's in-flight work. `data-fires-settled`
 * counts completed fires — the e2e specs' completion signal (a
 * cache-hit refetch changes no DOM, so the count is the only
 * observable settle).
 */
export function CacheControls() {
  const nav = useNavigation()
  const [navigate, navigateProgress] = nav.navigate()
  const [settled, setSettled] = useState(0)
  const countSettle = (m: { finished: Promise<unknown> }) => {
    m.finished.then(
      () => setSettled((n) => n + 1),
      () => setSettled((n) => n + 1),
    )
  }
  const isPending = navigateProgress.committed && !navigateProgress.finished

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <Button
        // `data-hydrated`: React owns the button (onClick live) — the
        // controls hydrate after the page shell; e2e specs click via
        // the marker-qualified locator.
        ref={(el) => el?.setAttribute("data-hydrated", "")}
        type="button"
        size="sm"
        variant="outline"
        // A same-URL replace navigate — one whole-tree statement whose
        // covering segment fp-skips everything the client holds; the
        // byte-cached slow parton replays from the server cache when
        // it does render.
        onClick={() => countSettle(navigate((url) => url, { history: "replace" }))}
        data-testid="refetch-slow"
      >
        Refetch slow
      </Button>
      <Button
        // `data-hydrated`: React owns the button (onClick live) — the
        // controls hydrate after the page shell; e2e specs click via
        // the marker-qualified locator.
        ref={(el) => el?.setAttribute("data-hydrated", "")}
        type="button"
        size="sm"
        variant="outline"
        onClick={() => countSettle(navigate((url) => url, { history: "replace" }))}
        data-testid="refetch-clock"
      >
        Refetch clock
      </Button>
      <Button
        // `data-hydrated`: React owns the button (onClick live) — the
        // controls hydrate after the page shell; e2e specs click via
        // the marker-qualified locator.
        ref={(el) => el?.setAttribute("data-hydrated", "")}
        type="button"
        size="sm"
        variant="outline"
        onClick={() => {
          // Push the new `?flavor=`. The updater already receives the
          // current URL, so toggling reads `flavor` straight off it —
          // no separate `new URL(window.location.href)` first. Slow
          // reads `flavor` from the URL via its tracked read, so its
          // fingerprint moves and only it (plus the flavor-reading
          // wrapper) re-renders.
          const milestones = navigate(
            (url) => {
              const current = url.searchParams.get("flavor") ?? "vanilla"
              url.searchParams.set("flavor", current === "vanilla" ? "chocolate" : "vanilla")
              return url
            },
            { history: "push" },
          )
          countSettle(milestones)
        }}
        data-testid="toggle-flavor"
      >
        Toggle flavor
      </Button>
      <span data-testid="fires-settled" data-fires-settled={settled} hidden />
      {isPending && <span className="text-muted-foreground">…</span>}
    </div>
  )
}
