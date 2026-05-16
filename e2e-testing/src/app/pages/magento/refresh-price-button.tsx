"use client"

import { useState } from "react"
import {
  useEnclosingPartialId,
  useNavigation,
} from "@react-cms/framework/lib/partial-client.tsx"
import { Button } from "@react-cms/copies/components/ui/button"

/**
 * Per-card refresh button. Reads the enclosing partial instance's id
 * via `useEnclosingPartialId()` and refetches just that one. The id
 * for a `<LivePrice sku=…/>` placement auto-derives in the framework
 * from `spec.id + hash(props)` — each card gets a distinct one, so
 * the refetch targets exactly the clicked card. The "refresh all"
 * companion button uses the class-level `.price` selector to fan
 * out across every instance.
 */
export function RefreshPriceButton({ sku }: { sku: string }) {
  const nav = useNavigation()
  const myId = useEnclosingPartialId()
  const [isPending, setIsPending] = useState(false)
  async function refresh() {
    if (!myId) return
    setIsPending(true)
    try {
      await nav.reload({ selector: myId }).finished
    } finally {
      setIsPending(false)
    }
  }
  return (
    <Button
      type="button"
      size="icon-xs"
      variant="ghost"
      data-testid={`refresh-price-${sku}`}
      onClick={refresh}
      disabled={isPending}
      className="text-primary"
    >
      {isPending ? "…" : "↻"}
    </Button>
  )
}
