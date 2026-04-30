"use client"

import { useState } from "react"
import { useNavigation } from "@react-cms/framework/lib/partial-client.tsx"
import { Button } from "@react-cms/copies/components/ui/button"

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
