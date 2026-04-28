import { RefreshPriceButton } from "./refresh-price-button.tsx"

export function LivePriceFallback({
  sku,
  basePrice,
  currency,
}: {
  sku: string
  basePrice: number
  currency: string
}) {
  return (
    <div data-testid={`live-price-fallback-${sku}`} className="mt-2 flex items-center gap-2">
      <span className="font-semibold italic text-muted-foreground tabular-nums">
        {currency} {basePrice.toFixed(2)}
      </span>
      <span className="text-xs text-muted-foreground">loading…</span>
    </div>
  )
}

export async function LivePrice({
  sku,
  basePrice,
  currency,
}: {
  sku: string
  basePrice: number
  currency: string
}) {
  await new Promise((r) => setTimeout(r, 1000))

  const tick = Date.now()
  const swing = Math.random() - 0.5
  const live = basePrice * (1 + swing)

  return (
    <div
      data-testid={`live-price-${sku}`}
      data-price-tick={String(tick)}
      className="mt-2 flex items-center gap-2"
    >
      <span className="font-semibold text-emerald-400 tabular-nums">
        {currency} {live.toFixed(2)}
      </span>
      <RefreshPriceButton sku={sku} />
    </div>
  )
}
