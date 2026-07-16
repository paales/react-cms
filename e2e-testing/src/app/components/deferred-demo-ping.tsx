"use client"

import { useState } from "react"
import type { ResolvedCell } from "@parton/framework/client"
import { Button } from "@parton/copies/components/ui/button"

/**
 * Ping button — writes the `deferred` `pings` cell via its bound
 * server-action ref. Because the cell declares `deferred: true`, the
 * action POST returns no re-render: the new value reaches the page only
 * through the already-open streaming connection (the heartbeat's
 * `?streaming=1` segment).
 *
 * The client-side `sent` counter increments AFTER `pings.set(...)`
 * resolves — i.e. once the POST has round-tripped. It's the e2e spec's
 * deterministic "the write completed" signal, distinct from "the new
 * value has committed to the page" (which, for a deferred cell, only
 * happens when a stream segment lands). With the heartbeat disabled the
 * two diverge: `sent:` advances, `Pings:` does not.
 */
export function PingButton({ pings }: { pings: ResolvedCell<number> }) {
  const [sent, setSent] = useState(0)
  return (
    <div className="flex flex-col gap-2">
      <Button
        // `data-hydrated`: React owns the button (onClick live) — the
        // ping partial hydrates after the page shell; e2e specs click
        // through the marker-qualified locator.
        ref={(el) => el?.setAttribute("data-hydrated", "")}
        type="button"
        variant="outline"
        size="sm"
        data-testid="deferred-ping-btn"
        onClick={async () => {
          await pings.set(pings.value + 1)
          setSent((n) => n + 1)
        }}
        className="w-fit"
      >
        Ping
      </Button>
      <span className="font-mono text-xs text-muted-foreground" data-testid="deferred-ping-sent">
        sent: {sent}
      </span>
    </div>
  )
}
