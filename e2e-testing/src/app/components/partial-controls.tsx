"use client"

import { useState } from "react"
import { useNavigation } from "@react-cms/framework/lib/partial-client.tsx"
import { Button } from "@react-cms/copies/components/ui/button"

/**
 * Client component demonstrating partial-level re-fetching.
 *
 * Each button calls `useNavigation().reload({selector: "#…"})` — a
 * targeted refetch of one Partial. Multiple reloads in the same tick
 * are batched into one RSC request by the navigation dispatcher.
 */
export function PartialControls() {
  const nav = useNavigation()
  const [pending, setPending] = useState<string | null>(null)

  async function refresh(id: string) {
    setPending(id)
    try {
      await nav.reload({ selector: `#${id}` }).finished
    } finally {
      setPending(null)
    }
  }

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <span className="text-xs text-muted-foreground">
        reload({"{"}selector{"}"}):
      </span>
      {(["hero", "stats", "species"] as const).map((id) => (
        <Button
          key={id}
          type="button"
          size="sm"
          variant="outline"
          onClick={() => refresh(id)}
          disabled={pending === id}
        >
          {pending === id ? "Refreshing..." : `Refresh ${id[0].toUpperCase()}${id.slice(1)}`}
        </Button>
      ))}
    </div>
  )
}
