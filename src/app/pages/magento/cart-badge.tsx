"use client"

export function CartBadge({ quantity = 0 }: { quantity?: number | string }) {
  return (
    <div className="inline-flex items-center gap-2 rounded-lg border bg-card px-3 py-1.5 text-sm text-card-foreground">
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="9" cy="21" r="1" />
        <circle cx="20" cy="21" r="1" />
        <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" />
      </svg>
      <span className="min-w-[18px] text-center font-semibold">{quantity}</span>
    </div>
  )
}
