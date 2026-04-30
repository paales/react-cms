"use client"

import { useState } from "react"
import { useNavigation } from "@react-cms/framework/lib/partial-client.tsx"
import { Button } from "@react-cms/copies/components/ui/button"

/**
 * Button that fires a targeted reload via `useNavigation().reload()`.
 */
export function SelectorRefetchButton({
  selector,
  label,
  testId,
}: {
  selector: string
  label: string
  testId: string
}) {
  const nav = useNavigation()
  const [isPending, setIsPending] = useState(false)

  async function fire() {
    setIsPending(true)
    try {
      await nav.reload({ selector }).finished
    } finally {
      setIsPending(false)
    }
  }

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      data-testid={testId}
      onClick={fire}
      disabled={isPending}
    >
      {isPending ? "…" : label}
    </Button>
  )
}
