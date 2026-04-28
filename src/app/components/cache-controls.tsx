"use client"

import { useTransition } from "react"
import { useNavigation } from "../../lib/partial-client.tsx"
import { Button } from "@/components/ui/button"

/**
 * Client-side buttons to trigger refetches against the cache-demo
 * partials.
 */
export function CacheControls() {
  const nav = useNavigation()
  const [isPending, startTransition] = useTransition()

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() =>
          startTransition(() => {
            void nav.reload({ selector: "#slow" })
          })
        }
        data-testid="refetch-slow"
      >
        Refetch slow
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() =>
          startTransition(() => {
            void nav.reload({ selector: "#clock" })
          })
        }
        data-testid="refetch-clock"
      >
        Refetch clock
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => {
          const url = new URL(window.location.href)
          const current = url.searchParams.get("flavor") ?? "vanilla"
          const next = current === "vanilla" ? "chocolate" : "vanilla"
          url.searchParams.set("flavor", next)
          startTransition(() => {
            void nav.navigate(url.toString(), {
              history: "push",
              selector: "#slow",
            })
          })
        }}
        data-testid="toggle-flavor"
      >
        Toggle flavor
      </Button>
      {isPending && <span className="text-muted-foreground">…</span>}
    </div>
  )
}
