/**
 * Product card — title + price + image, slots into `.group-item`.
 */

import { ReactCms, type RenderArgs } from "@react-cms/framework"

export const ProductCardBlock = ReactCms.partial(
  function ProductCardRender({
    title,
    price,
    imageSrc,
    imageAlt,
  }: { title: string; price: number; imageSrc: string; imageAlt: string } & RenderArgs) {
    const formattedPrice =
      price > 0
        ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(price)
        : "—"
    return (
      <article
        className="flex w-48 shrink-0 flex-col gap-2 rounded-lg border bg-card p-3 shadow-sm"
        data-testid="product-card"
      >
        <div className="aspect-square w-full overflow-hidden rounded-md bg-muted">
          {imageSrc ? (
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
  },
  {
    type: "product-card",
    tags: [".group-item"],
    vary: ({ cms }) => ({
      title: cms.text("title"),
      price: cms.number("price"),
      imageSrc: cms.text("imageSrc"),
      imageAlt: cms.text("imageAlt"),
    }),
  },
)
