"use client"

import { useState } from "react"
import { useNavigation } from "../../../lib/partial-client.tsx"
import { Button } from "@/components/ui/button"

export function RefreshAllPricesButton() {
  const nav = useNavigation()
  const [isPending, setIsPending] = useState(false)

  async function refreshAll() {
    setIsPending(true)
    try {
      await nav.reload({ selector: ".price" }).finished
    } finally {
      setIsPending(false)
    }
  }

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      data-testid="refresh-all-prices"
      onClick={refreshAll}
      disabled={isPending}
      className="mb-4"
    >
      {isPending ? "Refreshing all prices…" : "Refresh all prices"}
    </Button>
  )
}
