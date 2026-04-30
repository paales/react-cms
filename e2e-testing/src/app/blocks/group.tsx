/**
 * Group — layout primitive with editable direction/align/justify/gap/
 * padding/wrap. Children plug in via the `items` slot (any block).
 */

import { Children, ReactCms, type RenderArgs } from "@react-cms/framework"
import { cn } from "@react-cms/copies/lib/utils"

const DIRECTIONS = ["column", "row"] as const
const ALIGN_VALUES = ["start", "center", "end", "stretch"] as const
const JUSTIFY_VALUES = ["start", "center", "end", "between", "around"] as const

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

export const GroupBlock = ReactCms.partial(
  function GroupRender({
    direction,
    align,
    justify,
    gap,
    padding,
    wrap,
    parent,
    cmsId,
  }: {
    direction: (typeof DIRECTIONS)[number]
    align: (typeof ALIGN_VALUES)[number]
    justify: (typeof JUSTIFY_VALUES)[number]
    gap: number
    padding: number
    wrap: "nowrap" | "wrap"
  } & RenderArgs) {
    return (
      <div
        className={cn(
          "flex",
          FLEX_DIR[direction],
          ALIGN_ITEMS[align],
          JUSTIFY_CONTENT[justify],
          wrap === "wrap" && "flex-wrap",
        )}
        style={{ gap: `${gap}px`, padding: padding > 0 ? `${padding}px` : undefined }}
        data-testid="group-block"
      >
        <Children name="items" allow="*" host={parent} hostCmsId={cmsId} />
      </div>
    )
  },
  {
    type: "group",
    tags: [".page-block", ".group-item"],
    vary: ({ cms }) => ({
      direction: cms.enum("direction", DIRECTIONS),
      align: cms.enum("align", ALIGN_VALUES),
      justify: cms.enum("justify", JUSTIFY_VALUES),
      gap: cms.number("gap"),
      padding: cms.number("padding"),
      wrap: cms.enum("wrap", ["nowrap", "wrap"] as const),
    }),
  },
)
