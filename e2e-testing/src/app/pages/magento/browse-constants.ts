/** Catalog grid geometry, shared by the leaf layout (server), the
 *  client-rendered shell, and the scroller's reservation estimate. */
export const PAGE_SIZE = 12
export const COLS = 4
/** Estimated px per grid row (card + gap) — the scroller's `estimate`
 *  input for culled-region reservation, and the shell's placeholder
 *  height. */
export const CARD_ROW_PX = 252
export const GRID = "grid grid-cols-4 gap-3"
