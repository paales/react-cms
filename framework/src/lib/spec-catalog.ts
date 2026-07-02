/**
 * Spec catalog — framework-internal index of every `parton`
 * spec by its catalog id.
 *
 * Lookups feed three internal consumers:
 *
 *  - `partialFromSnapshot` in cache-mode refetch — finds the spec
 *    Component when re-spawning from a snapshot.
 *  - `descendantContribution` in the descendant-fp fold — re-runs a
 *    descendant's `match` against the current request to keep
 *    ancestors' fingerprints honest.
 *  - `deriveMatchKey` walking `parent.path` — looks up ancestors to
 *    find the closest match-bearing pattern for variant identity.
 *
 * No CMS coupling: this catalog knows about spec id, render component,
 * and match pattern. CMS-specific block metadata
 * (`schema` callbacks, slot-allow labels) lives separately in
 * `runtime/cms-runtime.ts` as a side-table.
 */

import type { FC } from "react"
import type { PartialCtx } from "./partial-context.ts"

/** Minimal framework-internal props every spec component accepts. */
export interface SpecComponentProps {
  /** Per-instance render-id override. Slot wiring (and any other
   *  caller that needs per-placement identity) sets this; the value
   *  becomes the rendered effective id. Framework-internal — author
   *  code never reads or sets it. */
  __instanceId?: string
  children?: import("react").ReactNode
}

export interface SpecCatalogEntry {
  /** Spec catalog id. Derived from `selector` or auto-named from
   *  `Render.name`. */
  id: string
  /** Refetch labels declared by `selector` (with `id` as the first
   *  label). `nav.reload({selector: "label"})` matches any of these. */
  labels: string[]
  /** The component returned by `parton(...)`. */
  Component: FC<SpecComponentProps>
  /** Compiled URLPattern for the spec's `match` option, if any. */
  matchPattern?: URLPattern
  /** Render-fn display name (for debug). */
  displayName: string
  /** Author-declared via selector / schema / match. Auto-named specs
   *  are `false` and excluded from the public `/__remote/<id>`
   *  surface. */
  addressable?: boolean
  /** Capability schema type name — referenced by the remote
   *  manifest so the `parton add` CLI can generate typed bindings.
   *  See `PartialOptions.capabilityType`. */
  capabilityType?: string
}

const specCatalog = new Map<string, SpecCatalogEntry>()

export function registerSpec(entry: SpecCatalogEntry): void {
  specCatalog.set(entry.id, entry)
}

export function getSpecById(id: string): SpecCatalogEntry | undefined {
  return specCatalog.get(id)
}

export function listSpecIds(): string[] {
  return [...specCatalog.keys()]
}

/** Read-only iteration over every registered spec entry. */
export function listSpecs(): SpecCatalogEntry[] {
  return [...specCatalog.values()]
}

export function _clearSpecCatalog(): void {
  specCatalog.clear()
}
