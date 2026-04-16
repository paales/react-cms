import { RefreshPriceButton } from "./refresh-price-button.tsx";

/**
 * Fallback shown while a `<LivePrice>` is still streaming. Shows the
 * product's base price in gray so the user can clearly see each
 * product switch into "loading" state during a refresh.
 */
export function LivePriceFallback({ sku, basePrice, currency }: {
  sku: string;
  basePrice: number;
  currency: string;
}) {
  return (
    <div
      data-testid={`live-price-fallback-${sku}`}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.5rem",
        marginTop: "0.5rem",
      }}
    >
      <span
        style={{
          color: "#888",
          fontWeight: 600,
          fontStyle: "italic",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {currency} {basePrice.toFixed(2)}
      </span>
      <span style={{ fontSize: "0.7rem", color: "#666" }}>loading…</span>
    </div>
  );
}

/**
 * Server-rendered "live price" for a product, fluctuating every render
 * so manual refetches produce visibly different output. Used as a
 * **dynamic Partial** (wrapped in `<Partial id={"price-" + sku}>` inside
 * a `.map()` in `ProductGrid`) to exercise the route-scoped partial
 * registry: the static `collectPartials` walk can't see through
 * `ProductGrid`, but the registry captures each instance on first
 * render so each product's price can be refetched individually
 * without re-running the product list query.
 *
 * Artificial 200ms delay so a refresh actually suspends — otherwise
 * it commits instantly and you never see the fallback flash.
 */
export async function LivePrice({ sku, basePrice, currency }: {
  sku: string;
  basePrice: number;
  currency: string;
}) {
  await new Promise((r) => setTimeout(r, 200));

  // Fresh fluctuation on every render — `Date.now()` ticks at ms
  // precision so every click produces a new value, and `Math.random`
  // guarantees consecutive clicks within the same millisecond still
  // diverge. ±50% swing — big enough to be unmistakable when you
  // click refresh.
  const tick = Date.now();
  const swing = Math.random() - 0.5; // ±50%
  const live = basePrice * (1 + swing);

  return (
    <div
      data-testid={`live-price-${sku}`}
      data-price-tick={String(tick)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.5rem",
        marginTop: "0.5rem",
      }}
    >
      <span
        style={{ color: "#48bb78", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}
      >
        {currency} {live.toFixed(2)}
      </span>
      <RefreshPriceButton sku={sku} />
    </div>
  );
}
