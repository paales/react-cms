/**
 * Group — a layout primitive modeled on Shopify Horizon's
 * `blocks/group.liquid`. Renders a flex container whose direction,
 * alignment, gap, and padding are CMS-editable. Children plug in via
 * a `<Children name="items">` slot, so any block tagged `.group-item`
 * (including other Groups — recursive composition) can be dropped
 * inside.
 *
 * What we ship vs. what Horizon's group has: only the layout knobs.
 * Skipped per the user's "skip the font stuff and irrelevant stuff
 * for now": background media (image/video), color schemes, borders,
 * overlay, link wrapping, custom width/height with mobile-specific
 * variants. Those can be additive later — the current shape is
 * enough to demonstrate aligning fields inside a card and arranging
 * cards in a grid row.
 *
 * Slot accept policy: Group's `items` slot uses `allow="*"` — accept
 * any registered block. Group is meant to compose anything the parent
 * slot permits (page-level blocks at the page level, group-items
 * inside another group, demo-blocks inside a composed section), and
 * forcing a single tag here would break one of those positions. The
 * "ideally inherit the parent slot's allow" semantic is left for a
 * future iteration — wildcard is the simplest answer that doesn't
 * pin Group to any single role.
 */
import { getEnum, getNumber } from "../../framework/context.ts"
import { Children } from "../../lib"
import { cn } from "@/lib/utils"

const DIRECTIONS = ["column", "row"] as const
const ALIGN_VALUES = ["start", "center", "end", "stretch"] as const
const JUSTIFY_VALUES = ["start", "center", "end", "between", "around"] as const

// Tailwind doesn't see dynamic class names, so we map enum values
// to literal class strings here. Each map is small enough to
// inline; the maps double as the source of truth for which values
// the editor should offer.
const FLEX_DIR: Record<(typeof DIRECTIONS)[number], string> = {
  column: "flex-col",
  row: "flex-row",
}
const ALIGN_ITEMS: Record<(typeof ALIGN_VALUES)[number], string> = {
  start: "items-start",
  center: "items-center",
  end: "items-end",
  stretch: "items-stretch",
}
const JUSTIFY_CONTENT: Record<(typeof JUSTIFY_VALUES)[number], string> = {
  start: "justify-start",
  center: "justify-center",
  end: "justify-end",
  between: "justify-between",
  around: "justify-around",
}

export function GroupBlock() {
  const direction = getEnum("direction", DIRECTIONS)
  const align = getEnum("align", ALIGN_VALUES)
  const justify = getEnum("justify", JUSTIFY_VALUES)
  const gap = getNumber("gap")
  const padding = getNumber("padding")
  const wrap = getEnum("wrap", ["nowrap", "wrap"] as const)

  return (
    <div
      className={cn(
        "flex",
        FLEX_DIR[direction],
        ALIGN_ITEMS[align],
        JUSTIFY_CONTENT[justify],
        wrap === "wrap" && "flex-wrap",
      )}
      // gap / padding are dynamic numbers. CSS `gap` and `padding`
      // accept px directly, so inline-style is the cleanest way —
      // safelisting Tailwind classes for arbitrary 0–100 values
      // would be much heavier.
      style={{
        gap: `${gap}px`,
        padding: padding > 0 ? `${padding}px` : undefined,
      }}
      data-testid="group-block"
    >
      <Children name="items" allow="*" />
    </div>
  )
}
