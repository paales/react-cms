"use client"

/**
 * /bound-cells-demo client controls — one button firing the host-side
 * cart write. The interesting machinery is server-side (dep-driven
 * re-projection of the embed); this is just the trigger.
 */

const hydrated = (el: HTMLElement | null): void => el?.setAttribute("data-hydrated", "")

export function BoundCellsControls({ add }: { add: () => Promise<void> }) {
  return (
    <button
      ref={hydrated}
      onClick={() => void add()}
      data-testid="bound-cells-add"
      className="rounded-md border px-3 py-1 text-sm"
    >
      Add item to host cart
    </button>
  )
}
