/**
 * Per-author editor preferences, modeled as cells. Each tweak
 * (palette / surface / attachment / device / tree style / left tab)
 * partitions per-session (`vary: ({session}) => ({sid: session.id})`)
 * so users carry their own settings across reloads via the session
 * cookie.
 *
 * Replaces the legacy `session.enum("name", values, default)` reads
 * in `shell.tsx`'s vary blocks and the `setSessionValue(name, value)`
 * action wired through `SessionToggleLink`. With cells:
 *
 *   - The parton's `schema: () => ({palette: editorPalette})` reads
 *     the resolved value into Render's prop bag (`palette.value`).
 *   - The toggle component receives the cell handle as a prop and
 *     calls `palette.set("dark")` — same Flight-serialized server-
 *     action ref as everywhere else.
 *   - Cell-stamped `cell:<id>` labels flow through the existing
 *     invalidation registry; specs reading the cell auto-refetch
 *     on mutation, no per-key snapshot walk.
 */

import { cell } from "@parton/framework"

export const editorLeftTab = cell.enum(["layers", "settings"] as const, {
  id: "editor-left-tab",
  vary: ({ session }) => ({ sid: session.id }),
  initial: "layers",
})

export const editorTreeStyle = cell.enum(["jsx", "plain"] as const, {
  id: "editor-tree-style",
  vary: ({ session }) => ({ sid: session.id }),
  initial: "plain",
})

export const editorPalette = cell.enum(["light", "dark"] as const, {
  id: "editor-palette",
  vary: ({ session }) => ({ sid: session.id }),
  initial: "light",
})

export const editorSurface = cell.enum(["light", "translucent", "solid"] as const, {
  id: "editor-surface",
  vary: ({ session }) => ({ sid: session.id }),
  initial: "translucent",
})

export const editorAttachment = cell.enum(["floating", "docked"] as const, {
  id: "editor-attachment",
  vary: ({ session }) => ({ sid: session.id }),
  initial: "docked",
})

export const editorDevice = cell.enum(["desktop", "tablet", "mobile"] as const, {
  id: "editor-device",
  vary: ({ session }) => ({ sid: session.id }),
  initial: "desktop",
})
