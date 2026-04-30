"use client"

import { useState } from "react"
import { Button } from "@react-cms/copies/components/ui/button"

export function ClickCounter() {
  const [n, setN] = useState(0)
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={() => setN((x) => x + 1)}
      data-testid="click-counter"
    >
      clicked {n}×
    </Button>
  )
}
