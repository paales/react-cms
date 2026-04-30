"use client"

import { useState, useTransition } from "react"
import { addToCart } from "./cart-actions.ts"
import { Button } from "@react-cms/copies/components/ui/button"
import { Alert, AlertDescription } from "@react-cms/copies/components/ui/alert"

export function AddToCartButton({ sku }: { sku: string }) {
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  function handleClick() {
    setError(null)
    startTransition(async () => {
      try {
        await addToCart(sku, 1)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    })
  }

  return (
    <div className="flex flex-col gap-2">
      <Button
        type="button"
        size="sm"
        onClick={handleClick}
        disabled={isPending}
        className="bg-emerald-500 text-emerald-950 hover:bg-emerald-400"
      >
        {isPending ? "Adding..." : "Add to Cart"}
      </Button>
      {error && (
        <Alert variant="destructive" className="py-2">
          <AlertDescription className="text-xs">{error}</AlertDescription>
        </Alert>
      )}
    </div>
  )
}
