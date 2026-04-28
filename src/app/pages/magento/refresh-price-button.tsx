"use client"

import { useState } from "react"
import { useNavigation } from "../../../lib/partial-client.tsx"
import { Button } from "@/components/ui/button"

export function RefreshPriceButton({ sku }: { sku: string }) {
  const nav = useNavigation()
  const [isPending, setIsPending] = useState(false)
  async function refresh() {
    setIsPending(true)
    try {
      await nav.reload({ selector: [`#price-${sku}`] }).finished
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
