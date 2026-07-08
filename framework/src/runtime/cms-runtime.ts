/**
 * CMS runtime — content store + sync read surface.
 *
 * The source of truth for CMS content is `cms/data/content.json` — a
 * forest of `CmsNode`s keyed by `id`. Each node holds one or more
 * `configs` (match clause → fields). The resolver picks every config
 * whose match is satisfied by the current request, scores by
 * matched-dimension count, and cascade-merges fields.
 *
 * Sync read surface for block `schema` callbacks:
 *
 *   const cms = createCmsReadSurface(id, request)
 *   cms.text("headline")                       // "Welcome"
 *   cms.enum("tone", ["info","warn"] as const) // T
 *   cms.reference("featured", "product")       // string id | null
 *
 * Pure function of `(id, request)`. No ALS, no scope cells, no
 * tracking — the `cms:<contentKey>` dep re-reads the content hash per
 * fold, so the read IS the dependency surface.
 */

import React, { type ReactNode } from "react"
import { matchRoutePattern } from "./context.ts"
import { getCmsStorage, type LoadedStore } from "./cms-storage.ts"
import { CMS_DRAFT_COOKIE, EDITOR_COOKIE } from "./cms-constants.ts"
import { getSpecById } from "../lib/spec-catalog.ts"
import { registerDepKind } from "../lib/server-hooks.ts"

export { CMS_DRAFT_COOKIE, EDITOR_COOKIE }

// ─── Types ─────────────────────────────────────────────────────────────

export type ContentFieldKind = "text" | "richText" | "number" | "enum" | "image" | "boolean"

export interface SlotSpec {
  multi: boolean
  allow?: string
}

export interface Reference<T extends string = string> {
  readonly type: T
  readonly value: string | null
}

/** Read surface passed into `schema` callbacks on `block`.
 *  Field reads return values; `block`/`blocks` return ReactNodes for
 *  the host's slot children, rendered via the spec catalog's
 *  type→Component lookup. */
export interface CmsReadSurface {
  text(name: string): string
  richText(name: string): string
  number(name: string): number
  boolean(name: string): boolean
  enum<T extends string>(name: string, values: readonly T[]): T
  image(name: string): { src: string; alt: string }
  reference(name: string, type: string): string | null
  /** Render a single slot entry (the first one) under `slot`. Returns
   *  `null` when the slot is empty or no entry matches the selector. */
  block(slot: string, selector?: string): ReactNode
  /** Render every slot entry under `slot` in stored order. Returns
   *  `null` when the slot is empty. */
  blocks(slot: string, selector?: string): ReactNode
}

// ─── Store schema ──────────────────────────────────────────────────────

export type MatchClause =
  | string
  | number
  | boolean
  | { in: ReadonlyArray<string | number> }
  | Record<string, ScalarOrIn>

type ScalarOrIn = string | number | boolean | { in: ReadonlyArray<string | number> }

export interface CmsConfig {
  match: Record<string, MatchClause>
  fields: Record<string, unknown>
}

export interface CmsNode {
  id: string
  type?: string
  displayName?: string
  configs: CmsConfig[]
  slots?: Record<string, CmsNode[]>
}

export interface CmsStore {
  partials: Record<string, CmsNode>
}

// ─── Store loader ──────────────────────────────────────────────────────

function emptyStore(): CmsStore {
  return { partials: {} }
}

interface CacheSlot {
  store: CmsStore
  index: Map<string, CmsNode>
  mtime: number
}
let publishedSlot: CacheSlot | null = null
let draftSlot: CacheSlot | null = null

function buildIndex(store: CmsStore): Map<string, CmsNode> {
  const index = new Map<string, CmsNode>()
  for (const node of Object.values(store.partials)) index.set(node.id, node)
  // A slot can reference an ancestor's id (a hand-edited / malformed
  // store), forming a cycle. Track visited ids so the walk terminates
  // instead of recursing until the stack overflows.
  const visited = new Set<string>()
  const walk = (node: CmsNode): void => {
    if (visited.has(node.id)) return
    visited.add(node.id)
    if (!node.slots) return
    for (const entries of Object.values(node.slots)) {
      for (const child of entries) {
        if (!index.has(child.id)) index.set(child.id, child)
        walk(child)
      }
    }
  }
  for (const node of Object.values(store.partials)) walk(node)
  return index
}

function loadedToSlot(loaded: LoadedStore): CacheSlot {
  return { store: loaded.store, index: buildIndex(loaded.store), mtime: loaded.mtime }
}

function loadPublishedStore(): { store: CmsStore; index: Map<string, CmsNode> } {
  if (publishedSlot) return publishedSlot
  const loaded = getCmsStorage().loadPublishedSync()
  if (loaded) {
    publishedSlot = loadedToSlot(loaded)
    return publishedSlot
  }
  return { store: emptyStore(), index: new Map() }
}

function loadDraftStore(): { store: CmsStore; index: Map<string, CmsNode> } {
  if (draftSlot) return draftSlot
  const loaded = getCmsStorage().loadDraftSync()
  if (loaded) {
    draftSlot = loadedToSlot(loaded)
    return draftSlot
  }
  return { store: emptyStore(), index: new Map() }
}

export async function warmCmsCache(): Promise<void> {
  const backend = getCmsStorage()
  const [pub, draft] = await Promise.all([backend.loadPublished(), backend.loadDraft()])
  if (pub) {
    if (!publishedSlot || publishedSlot.mtime !== pub.mtime) publishedSlot = loadedToSlot(pub)
  } else {
    publishedSlot = null
  }
  if (draft) {
    if (!draftSlot || draftSlot.mtime !== draft.mtime) draftSlot = loadedToSlot(draft)
  } else {
    draftSlot = null
  }
}

function readCookieFromRequest(request: Request, name: string): string | null {
  const header = request.headers.get("cookie") ?? ""
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`))
  return match?.[1] ?? null
}

function isDraftRequest(request: Request | undefined): boolean {
  if (!request) return false
  const url = new URL(request.url)
  if (url.searchParams.get("cms-draft") === "1") return true
  if (readCookieFromRequest(request, CMS_DRAFT_COOKIE) === "1") return true
  return readCookieFromRequest(request, EDITOR_COOKIE) === "1"
}

export function isEditorRequest(request: Request): boolean {
  return readCookieFromRequest(request, EDITOR_COOKIE) === "1"
}

// ─── Tree (for editor) ────────────────────────────────────────────────

export type CmsTreeEntryKind = "node" | "slot" | "slot-add"

export interface CmsTreeEntry {
  id: string
  kind: CmsTreeEntryKind
  type?: string
  displayName?: string
  depth: number
  slotName?: string
  parentId?: string
  draftOnly: boolean
  hasDraft: boolean
}

export function slotEntryId(parentId: string, slotName: string): string {
  return `slot:${parentId}:${slotName}`
}

export function slotAddEntryId(parentId: string, slotName: string): string {
  return `slot-add:${parentId}:${slotName}`
}

export function parseSlotEntryId(id: string): { parentId: string; slotName: string } | null {
  let rest: string
  if (id.startsWith("slot-add:")) rest = id.slice("slot-add:".length)
  else if (id.startsWith("slot:")) rest = id.slice("slot:".length)
  else return null
  const colon = rest.lastIndexOf(":")
  if (colon < 0) return null
  return { parentId: rest.slice(0, colon), slotName: rest.slice(colon + 1) }
}

export function buildCmsTreeEntries(
  published: Record<string, CmsNode>,
  draft: Record<string, CmsNode>,
  rootIds?: ReadonlyArray<string>,
): CmsTreeEntry[] {
  const merged: Record<string, CmsNode> = { ...published }
  for (const [id, node] of Object.entries(draft)) merged[id] = node

  // A slot can reference an ancestor's id, forming a cycle. The
  // `publishedIds` set doubles as the visited guard here — re-entering
  // an already-collected id terminates the walk.
  const publishedIds = new Set<string>()
  const collectPublishedIds = (node: CmsNode): void => {
    if (publishedIds.has(node.id)) return
    publishedIds.add(node.id)
    if (!node.slots) return
    for (const children of Object.values(node.slots)) {
      for (const child of children) collectPublishedIds(child)
    }
  }
  for (const node of Object.values(published)) collectPublishedIds(node)

  const slotChildIds = new Set<string>()
  const visitedForSlots = new Set<string>()
  const collectSlotChildren = (node: CmsNode): void => {
    if (visitedForSlots.has(node.id)) return
    visitedForSlots.add(node.id)
    if (!node.slots) return
    for (const children of Object.values(node.slots)) {
      for (const child of children) {
        slotChildIds.add(child.id)
        collectSlotChildren(child)
      }
    }
  }
  for (const node of Object.values(merged)) collectSlotChildren(node)

  const entries: CmsTreeEntry[] = []
  // `ancestors` holds the ids currently on the recursion stack. A slot
  // that references an ancestor (a cycle) is emitted once but not
  // descended into, so the walk terminates instead of overflowing.
  const walk = (
    node: CmsNode,
    depth: number,
    slotName: string | undefined,
    parentId: string | undefined,
    ancestors: ReadonlySet<string>,
  ): void => {
    const hasDraft = draft[node.id] != null
    entries.push({
      id: node.id,
      kind: "node",
      type: node.type,
      displayName: node.displayName ?? deriveLabelFromConfigs(node.configs),
      depth,
      slotName,
      parentId,
      draftOnly: hasDraft && !publishedIds.has(node.id),
      hasDraft,
    })
    if (ancestors.has(node.id)) return
    if (!node.slots) return
    const nextAncestors = new Set(ancestors).add(node.id)
    const slotEntries = Object.entries(node.slots)
    const collapseHeader = slotEntries.length === 1
    for (const [name, children] of slotEntries) {
      const childDepth = collapseHeader ? depth + 1 : depth + 2
      if (!collapseHeader) {
        entries.push({
          id: slotEntryId(node.id, name),
          kind: "slot",
          depth: depth + 1,
          slotName: name,
          parentId: node.id,
          draftOnly: false,
          hasDraft: false,
        })
      }
      for (const child of children) {
        const effective = merged[child.id] ?? child
        walk(effective, childDepth, name, node.id, nextAncestors)
      }
      entries.push({
        id: slotAddEntryId(node.id, name),
        kind: "slot-add",
        depth: childDepth,
        slotName: name,
        parentId: node.id,
        draftOnly: false,
        hasDraft: false,
      })
    }
  }
  const rootFilter = rootIds ? new Set(rootIds) : null
  for (const node of Object.values(merged)) {
    if (slotChildIds.has(node.id)) continue
    if (rootFilter && !rootFilter.has(node.id)) continue
    walk(node, 0, undefined, undefined, new Set())
  }
  return entries
}

function deriveLabelFromConfigs(configs: readonly CmsConfig[]): string | undefined {
  if (configs.length === 0) return undefined
  const defaultConfig = configs.find((c) => Object.keys(c.match).length === 0) ?? configs[0]
  for (const field of ["title", "headline", "name", "label"] as const) {
    const v = defaultConfig.fields[field]
    if (typeof v === "string" && v.trim() !== "") return v
  }
  return undefined
}

export function listAllCmsNodes(rootIds?: ReadonlyArray<string>): CmsTreeEntry[] {
  return buildCmsTreeEntries(
    loadPublishedStore().store.partials,
    loadDraftStore().store.partials,
    rootIds,
  )
}

export function lookupCmsNode(id: string, request?: Request): CmsNode | null {
  if (isDraftRequest(request)) {
    const draftHit = loadDraftStore().index.get(id)
    if (draftHit) return draftHit
  }
  return loadPublishedStore().index.get(id) ?? null
}

export function lookupDraftNode(id: string): CmsNode | null {
  const draftHit = loadDraftStore().index.get(id)
  if (draftHit) return draftHit
  return loadPublishedStore().index.get(id) ?? null
}

// Every draft/published mutation is a load-modify-save. Run on a
// promise-chain mutex so concurrent calls don't interleave their
// loads and clobber each other's keys (the atomic file write keeps
// the bytes intact but can't prevent a lost logical update — two
// writers that both read the pre-write store, then the second save
// drops the first's key). Serializing the whole load→save span makes
// each mutation observe the prior one's result.
let writeChain: Promise<void> = Promise.resolve()

function serializeStoreWrite(work: () => Promise<void>): Promise<void> {
  const next = writeChain.then(work, work)
  // Keep the chain alive regardless of whether `work` rejected, so one
  // failed write doesn't wedge every subsequent one.
  writeChain = next.then(
    () => {},
    () => {},
  )
  return next
}

export function writeDraftNode(id: string, node: CmsNode): Promise<void> {
  return serializeStoreWrite(async () => {
    const backend = getCmsStorage()
    const current = (await backend.loadDraft())?.store ?? emptyStore()
    current.partials[id] = { ...node, id: id }
    await backend.saveDraft(current)
    _invalidateCmsStoreCache()
  })
}

export function publishDraft(): Promise<void> {
  return serializeStoreWrite(async () => {
    const backend = getCmsStorage()
    const [draft, published] = await Promise.all([backend.loadDraft(), backend.loadPublished()])
    const draftStore = draft?.store ?? emptyStore()
    const publishedStore = published?.store ?? emptyStore()
    for (const [id, node] of Object.entries(draftStore.partials)) {
      publishedStore.partials[id] = node
    }
    await backend.savePublished(publishedStore)
    await backend.saveDraft(emptyStore())
    _invalidateCmsStoreCache()
  })
}

export function revertDraftNode(id: string): Promise<void> {
  return serializeStoreWrite(async () => {
    const backend = getCmsStorage()
    const current = (await backend.loadDraft())?.store
    if (!current || !(id in current.partials)) return
    delete current.partials[id]
    if (Object.keys(current.partials).length === 0) {
      await backend.deleteDraft()
    } else {
      await backend.saveDraft(current)
    }
    _invalidateCmsStoreCache()
  })
}

export function _invalidateCmsStoreCache(): void {
  publishedSlot = null
  draftSlot = null
}

export async function _clearCmsDraft(): Promise<void> {
  await getCmsStorage().deleteDraft()
  _invalidateCmsStoreCache()
}

// ─── Resolver ──────────────────────────────────────────────────────────

export function resolveCmsFields(id: string, request: Request): Record<string, unknown> | null {
  const node = lookupCmsNode(id, request)
  if (!node) return null
  return mergeMatchingConfigs(node.configs, request)
}

export function resolveCmsNode(node: CmsNode, request: Request): Record<string, unknown> {
  return mergeMatchingConfigs(node.configs, request)
}

export function pickBestConfigIndex(
  configs: readonly CmsConfig[],
  request: Request,
): number | null {
  let bestIdx = -1
  let bestLen = -1
  for (let i = 0; i < configs.length; i++) {
    const score = evaluateMatch(configs[i].match, request)
    if (score === null) continue
    if (score.length > bestLen) {
      bestLen = score.length
      bestIdx = i
    }
  }
  return bestIdx >= 0 ? bestIdx : null
}

/**
 * Stable string capturing the resolved-content shape for an id under
 * the current request. Folded into the spec's fingerprint so a CMS
 * edit invalidates the partial even when its JSX is unchanged.
 */
export function cmsFingerprintContribution(id: string, request: Request): string {
  const node = lookupCmsNode(id, request)
  if (!node) return `|cms=${id}:miss`
  return `|cms=${id}:${contributionForNode(node, request, new Set([node.id]))}`
}

// The `cms:<contentKey>` dep kind — how a block's fingerprint tracks
// its content row. The block wrapper records the key on the live dep
// set at render; every fold re-reads the CURRENT hash here (committed
// store + the requester's draft overlay), so a CMS edit moves the fp
// with no lag and per-author drafts fold per request.
registerDepKind("cms", (contentKey, request) => cmsFingerprintContribution(contentKey, request))

function contributionForNode(node: CmsNode, request: Request, ancestors: Set<string>): string {
  const fields = mergeMatchingConfigs(node.configs, request)
  const base = stableStringify(fields)
  if (!node.slots) return base
  const slotParts: string[] = []
  for (const name of Object.keys(node.slots).sort()) {
    const children = node.slots[name]
    const childParts = children.map((child) => {
      // A slot child can resolve back to an ancestor (a cycle in a
      // hand-edited store). Emit a bounded marker instead of recursing
      // — keeps the contribution finite and stable.
      if (ancestors.has(child.id)) return `${child.id}=<cycle>`
      // Resolve each child through `lookupCmsNode` so a top-level
      // draft override on the slot-child id (saveCmsFields writes
      // edits to `partials[childId]`, not into the parent's slot
      // tree) flows into the parent's contribution. Without this,
      // editing a nav-link's label leaves `app-nav`'s fingerprint
      // unchanged — the parent fp-skips, the cached subtree wins,
      // and the preview keeps showing the old label until the next
      // full page render.
      const effective = lookupCmsNode(child.id, request) ?? child
      const nextAncestors = new Set(ancestors).add(child.id)
      return `${child.id}=${contributionForNode(effective, request, nextAncestors)}`
    })
    slotParts.push(`${name}:[${childParts.join(",")}]`)
  }
  return `${base}|slots={${slotParts.join(";")}}`
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]"
  const keys = Object.keys(value as Record<string, unknown>).sort()
  return (
    "{" +
    keys
      .map((k) => JSON.stringify(k) + ":" + stableStringify((value as Record<string, unknown>)[k]))
      .join(",") +
    "}"
  )
}

function mergeMatchingConfigs(
  configs: readonly CmsConfig[],
  request: Request,
): Record<string, unknown> {
  const matched: Array<{ cfg: CmsConfig; idx: number; score: number[] }> = []
  for (let i = 0; i < configs.length; i++) {
    const cfg = configs[i]
    const score = evaluateMatch(cfg.match, request)
    if (score !== null) matched.push({ cfg, idx: i, score })
  }
  matched.sort((a, b) => {
    const cmp = b.score.length - a.score.length
    if (cmp !== 0) return cmp
    return a.idx - b.idx
  })
  const merged: Record<string, unknown> = {}
  for (let i = matched.length - 1; i >= 0; i--) {
    Object.assign(merged, matched[i].cfg.fields)
  }
  return merged
}

function evaluateMatch(match: Record<string, MatchClause>, request: Request): number[] | null {
  const url = new URL(request.url)
  const scores: number[] = []
  for (const [key, clause] of Object.entries(match)) {
    if (!matchKey(key, clause, url, request)) return null
    scores.push(1)
  }
  return scores
}

function matchKey(key: string, clause: MatchClause, url: URL, request: Request): boolean {
  const colonIdx = key.indexOf(":")
  if (colonIdx < 0) return false
  const kind = key.slice(0, colonIdx)
  const name = key.slice(colonIdx + 1)
  switch (kind) {
    case "url":
      return scalarClauseMatches(clause, url.searchParams.get(name) ?? "")
    case "cookie":
      return scalarClauseMatches(clause, readCookieRaw(request, name) ?? "")
    case "header":
      return scalarClauseMatches(clause, request.headers.get(name) ?? "")
    case "pathname": {
      const params = matchRoutePattern(url.pathname, name)
      if (!params) return false
      if (typeof clause !== "object" || clause === null || Array.isArray(clause)) return false
      if ("in" in clause) return false
      for (const [paramName, paramClause] of Object.entries(clause as Record<string, ScalarOrIn>)) {
        if (!scalarClauseMatches(paramClause, params[paramName] ?? "")) return false
      }
      return true
    }
    default:
      return false
  }
}

function scalarClauseMatches(clause: MatchClause, value: string): boolean {
  if (typeof clause === "string") return clause === value
  if (typeof clause === "number") return String(clause) === value
  if (typeof clause === "boolean") return String(clause) === value
  if (
    typeof clause === "object" &&
    clause !== null &&
    !Array.isArray(clause) &&
    "in" in clause &&
    Array.isArray((clause as { in: unknown }).in)
  ) {
    const list = (clause as { in: ReadonlyArray<string | number> }).in
    return list.some((v) => String(v) === value)
  }
  return false
}

function readCookieRaw(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie") ?? ""
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`))
  return match?.[1]
}

// ─── Sync read surface (passed into block schema callbacks) ───────────

const EMPTY_IMAGE = Object.freeze({ src: "", alt: "" })

/**
 * Build a sync `CmsReadSurface` bound to `id` + `request` + `host`
 * context. Field reads resolve from this node's configs; `block`/
 * `blocks` calls render slot entries from `node.slots[name]` through
 * the spec catalog (type → Component) with the host's frame chain
 * + parent threaded in.
 *
 * `host` is the host spec's child PartialCtx — slot-rendered blocks
 * are descendants under it. Optional only because the prerender's
 * tracking surface doesn't have a real one.
 */
export function createCmsReadSurface(id: string | undefined, request: Request): CmsReadSurface {
  let resolved: Record<string, unknown> | null | undefined
  const resolve = (): Record<string, unknown> | null => {
    if (resolved !== undefined) return resolved
    if (id == null) {
      resolved = null
      return null
    }
    resolved = resolveCmsFields(id, request)
    return resolved
  }
  return {
    text(name) {
      const v = resolve()?.[name]
      return typeof v === "string" ? v : ""
    },
    richText(name) {
      const v = resolve()?.[name]
      return typeof v === "string" ? v : ""
    },
    number(name) {
      const v = resolve()?.[name]
      return typeof v === "number" ? v : 0
    },
    boolean(name) {
      const v = resolve()?.[name]
      return typeof v === "boolean" ? v : false
    },
    enum<T extends string>(name: string, values: readonly T[]): T {
      const v = resolve()?.[name]
      if (typeof v === "string" && (values as readonly string[]).includes(v)) return v as T
      return values[0]
    },
    image(name) {
      const v = resolve()?.[name]
      if (typeof v !== "object" || v === null) return EMPTY_IMAGE
      const obj = v as { src?: unknown; alt?: unknown }
      return {
        src: typeof obj.src === "string" ? obj.src : "",
        alt: typeof obj.alt === "string" ? obj.alt : "",
      }
    },
    reference(name, _type) {
      const v = resolve()?.[name]
      if (typeof v === "string") return v
      if (typeof v === "number") return String(v)
      return null
    },
    block(slot, selector) {
      if (id == null) return null
      const node = lookupCmsNode(id, request)
      const entries = node?.slots?.[slot] ?? []
      const matched = filterEntriesBySelector(entries, selector)
      const first = matched[0]
      if (!first) return null
      return renderSlotEntry(first)
    },
    blocks(slot, selector) {
      if (id == null) return null
      const node = lookupCmsNode(id, request)
      const entries = node?.slots?.[slot] ?? []
      const matched = filterEntriesBySelector(entries, selector)
      if (matched.length === 0) return null
      return matched.map((entry) => renderSlotEntry(entry))
    },
  }
}

/** Filter slot entries against an optional label-selector filter (e.g.
 *  `"page-block"`). Each entry's type → spec → spec.labels provides
 *  the labels to match against. Leading `.` / `#` in the filter is
 *  cosmetic and stripped. */
function filterEntriesBySelector(
  entries: readonly CmsNode[],
  selector: string | undefined,
): readonly CmsNode[] {
  if (!selector) return entries
  const wanted = selector
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => (t.startsWith("#") || t.startsWith(".") ? t.slice(1) : t))
  if (wanted.length === 0) return entries
  return entries.filter((entry) => {
    const type = entry.type
    if (!type) return false
    const spec = getSpecById(type)
    if (!spec) return false
    return wanted.some((w) => spec.labels.includes(w))
  })
}

function renderSlotEntry(entry: CmsNode): React.ReactElement | null {
  const type = entry.type
  if (!type) return null
  const spec = getSpecById(type)
  if (!spec) {
    if (import.meta.env?.DEV) {
      console.warn(
        `[cms] slot entry "${entry.id}" has type "${type}" which is not registered. ` +
          `Register with block(...).`,
      )
    }
    return null
  }
  // Slot wiring passes the entry's id through the generic framework
  // `__instanceId` channel — it becomes this placement's effective
  // render id AND (interpreted by the CMS block wrapper) the CMS row
  // the schema reads from.
  // The slot block renders as a task-child of the host parton, so it
  // inherits the host's context via server context — no `parent` to pass.
  const Component = spec.Component as React.FC<{ __instanceId?: string }>
  return React.createElement(Component, {
    key: entry.id,
    __instanceId: entry.id,
  })
}

// ─── Slot-block metadata ────────────────────────────────────────────
//
// Side-table keyed by spec id, holding CMS-specific metadata
// (`schema` callback) for blocks. The framework spec catalog
// (`spec-catalog.ts`) stays CMS-free; this table is consulted by:
//
//   - the editor's catalog-manifest prerender, which walks each
//     registered block id and invokes its `schema` with a tracking
//     CMS surface;
//   - other CMS layer code that needs to know whether a given spec
//     is block-shaped.
//
// Specs that don't go through `block` aren't here; they
// have no schema and aren't slot-placeable.

export interface SlotBlockMeta {
  id: string
  schema?: (scope: { cms: CmsReadSurface }) => unknown
}

const slotBlockMeta = new Map<string, SlotBlockMeta>()

export function registerSlotBlockMeta(entry: SlotBlockMeta): void {
  slotBlockMeta.set(entry.id, entry)
}

export function getSlotBlockMeta(id: string): SlotBlockMeta | undefined {
  return slotBlockMeta.get(id)
}

export function listSlotBlockIds(): string[] {
  return [...slotBlockMeta.keys()]
}

// Re-export spec-catalog lookups so existing CMS callers (slot
// machinery, editor) don't need to import from two places.
export { getSpecById, listSpecIds } from "../lib/spec-catalog.ts"

export function _clearSpecCatalog(): void {
  slotBlockMeta.clear()
}

// Re-export for slot.tsx compatibility.
export type ReactNode_ = ReactNode
