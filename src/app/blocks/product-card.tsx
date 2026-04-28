/**
 * Product card — title + price + image fields, rendered as a small
 * vertical card. Tagged `.group-item` so it slots into a Group's
 * `items` slot. The card uses its OWN tiny flex column internally
 * for image-then-text layout — Group is for outer placement, not
 * for laying out a card's own contents (you can't easily expose a
 * Group at the card level without exposing the card's slot, which
 * would double as a "free-form group"). Keeping the card opinionated
 * is the more typical commerce pattern.
 */
import { getNumber, getText } from "../../framework/context.ts"
import { cn } from "@/lib/utils"

export function ProductCardBlock() {
  const title = getText("title")
  const price = getNumber("price")
  const imageSrc = getText("imageSrc")
  const imageAlt = getText("imageAlt")

  const formattedPrice =
    price > 0
      ? new Intl.NumberFormat("en-US", {
          style: "currency",
          currency: "USD",
        }).format(price)
      : "—"

  return (
    <article
      className={cn("flex w-48 shrink-0 flex-col gap-2 rounded-lg border bg-card p-3 shadow-sm")}
      data-testid="product-card"
    >
      <div className="aspect-square w-full overflow-hidden rounded-md bg-muted">
        {imageSrc ? (
          // External-or-absolute URLs are allowed; this is a demo
          // surface and the field is author-controlled.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={imageSrc} alt={imageAlt} className="h-full w-full object-cover" />
        ) : (
          <div
            className="flex h-full w-full items-center justify-center text-xs text-muted-foreground"
            aria-label="No image"
          >
            (no image)
          </div>
        )}
      </div>
      <h3 className="line-clamp-2 text-sm font-medium" data-testid="product-card-title">
        {title || "Untitled product"}
      </h3>
      <p className="text-sm text-muted-foreground" data-testid="product-card-price">
        {formattedPrice}
      </p>
    </article>
  )
}
