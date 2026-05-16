/**
 * Block catalog manifest builder.
 *
 * Walks each registered block spec, invokes its `schema` callback with
 * a tracking CMS surface, and records what fields it touched. No JSX
 * walking — `schema` is a pure function declaring the CMS dependency
 * surface.
 */

import {
  listSpecTypes,
  getSpecByType,
  type ContentFieldKind,
  type SlotSpec,
  type CmsReadSurface,
} from "./cms-runtime.ts"

export interface BlockManifest {
  readonly type: string
  /** Refetch labels carried by the spec (excluding the spec's own id,
   *  which the editor identifies separately via `type`). The editor's
   *  slot-allow filter matches against these. */
  readonly labels: readonly string[]
  readonly contentFields: Record<string, ContentFieldKind>
  readonly references: Record<string, string>
  readonly childSlots: Record<string, SlotSpec>
}

function trackingCms(): {
  surface: CmsReadSurface
  contentFields: Map<string, ContentFieldKind>
  references: Map<string, string>
  childSlots: Map<string, SlotSpec>
} {
  const contentFields = new Map<string, ContentFieldKind>()
  const references = new Map<string, string>()
  const childSlots = new Map<string, SlotSpec>()
  const surface: CmsReadSurface = {
    text(name) {
      contentFields.set(name, "text")
      return ""
    },
    richText(name) {
      contentFields.set(name, "richText")
      return ""
    },
    number(name) {
      contentFields.set(name, "number")
      return 0
    },
    boolean(name) {
      contentFields.set(name, "boolean")
      return false
    },
    enum<T extends string>(name: string, values: readonly T[]): T {
      contentFields.set(name, "enum")
      return values[0]
    },
    image(name) {
      contentFields.set(name, "image")
      return { src: "", alt: "" }
    },
    reference(name, type) {
      references.set(name, type)
      return null
    },
    block(slot, selector) {
      childSlots.set(slot, { multi: false, allow: selector })
      return null
    },
    blocks(slot, selector) {
      childSlots.set(slot, { multi: true, allow: selector })
      return null
    },
  }
  return { surface, contentFields, references, childSlots }
}

export async function prerenderBlock(type: string): Promise<BlockManifest | null> {
  const spec = getSpecByType(type)
  if (!spec) return null
  const tracker = trackingCms()
  if (spec.schema) {
    try {
      spec.schema({ cms: tracker.surface })
    } catch {
      // schema may throw if it expects content shape that isn't
      // present in the empty tracking surface; we still get the field
      // reads it did before throwing.
    }
  }
  // Skip the first label (== spec.id == catalog type). The editor
  // already keys blocks by `type`; the remaining labels are the
  // fan-out targets a slot's `allow` filter may match against.
  const labels = spec.labels.slice(1)
  return {
    type,
    labels,
    contentFields: Object.fromEntries(tracker.contentFields),
    references: Object.fromEntries(tracker.references),
    childSlots: Object.fromEntries(tracker.childSlots),
  }
}

export async function buildCatalogManifest(): Promise<Record<string, BlockManifest>> {
  const out: Record<string, BlockManifest> = {}
  for (const type of listSpecTypes()) {
    const manifest = await prerenderBlock(type)
    if (manifest) out[type] = manifest
  }
  return out
}

let cached: Promise<Record<string, BlockManifest>> | null = null

export function getCatalogManifest(): Promise<Record<string, BlockManifest>> {
  if (!cached) cached = buildCatalogManifest()
  return cached
}

export function _invalidateCatalogManifest(): void {
  cached = null
}

if (import.meta.hot) {
  // See partial-registry.ts — only clear on a true full reload.
  import.meta.hot.on("vite:beforeFullReload", () => {
    cached = null
  })
}
