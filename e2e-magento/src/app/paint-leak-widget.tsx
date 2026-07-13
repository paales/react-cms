"use client"

/**
 * Deliberately NON-vocabulary client component for the Paint-tier
 * violation specs: placed on `/remote/paint-mixed`, it ships a
 * client-module reference that a Paint-granted splice must rewrite
 * out (degrade + loud) — and that must never load in the host
 * browser.
 */

import { useState } from "react"

export function PaintLeakWidget() {
  const [count, setCount] = useState(0)
  return (
    <button data-testid="paint-leak-widget" onClick={() => setCount((c) => c + 1)}>
      leaked client widget · {count}
    </button>
  )
}
