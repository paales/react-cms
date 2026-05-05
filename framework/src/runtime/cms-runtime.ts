/**
 * CMS runtime — content store + sync read surface.
 *
 * The source of truth for CMS content is `cms/data/content.json` — a
 * forest of `CmsNode`s keyed by `cmsId`. Each node holds one or more
 * `configs` (match clause → fields). The resolver picks every config
 * whose match is satisfied by the current request, scores by
 * matched-dimension count, and cascade-merges fields.
 *
 * Read surface for `vary` callbacks:
 *
 *   const cms = createCmsReadSurface(cmsId, request)
 *   cms.text("headline")                       // "Welcome"
 *   cms.enum("tone", ["info","warn"] as const) // T
 *   cms.reference("featured", "product")       // string id | null
 *
 * Pure function of `(cmsId, request)`. No ALS, no scope cells, no
 * tracking — the sync surface is what `vary` returns; that result IS
 * the dependency surface.
 */

import type { ReactNode } from "react"
import { matchRoutePattern } from "./context.ts"
import { getCmsStorage, type LoadedStore } from "./cms-storage.ts"

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

/** Read surface passed into `vary` callbacks. All sync. */
export interface CmsReadSurface {
  text(name: string): string
  richText(name: string): string
  number(name: string): number
  boolean(name: string): boolean
  enum<T extends string>(name: string, values: readonly T[]): T
  image(name: string): { src: string; alt: string }
  reference(name: string, type: string): string | null
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

export const CMS_DRAFT_COOKIE = "cms-draft"
export const EDITOR_COOKIE = "__editor"

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
  const walk = (node: CmsNode): void => {
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
  if (url.searchParams.get("editor") === "1") return true
  if (readCookieFromRequest(request, CMS_DRAFT_COOKIE) === "1") return true
  return readCookieFromRequest(request, EDITOR_COOKIE) === "1"
}

export function isEditorRequest(request: Request): boolean {
  const url = new URL(request.url)
  const flag = url.searchParams.get("editor")
  if (flag === "1") return true
  if (flag === "0") return false
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

  const publishedIds = new Set<string>()
  const collectPublishedIds = (node: CmsNode): void => {
    publishedIds.add(node.id)
    if (!node.slots) return
    for (const children of Object.values(node.slots)) {
      for (const child of children) collectPublishedIds(child)
    }
  }
  for (const node of Object.values(published)) collectPublishedIds(node)

  const slotChildIds = new Set<string>()
  const collectSlotChildren = (node: CmsNode): void => {
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
  const walk = (
    node: CmsNode,
    depth: number,
    slotName: string | undefined,
    parentId: string | undefined,
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
    if (!node.slots) return
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
        walk(effective, childDepth, name, node.id)
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
    walk(node, 0, undefined, undefined)
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

export function lookupCmsNode(cmsId: string, request?: Request): CmsNode | null {
  if (isDraftRequest(request)) {
    const draftHit = loadDraftStore().index.get(cmsId)
    if (draftHit) return draftHit
  }
  return loadPublishedStore().index.get(cmsId) ?? null
}

export function lookupDraftNode(cmsId: string): CmsNode | null {
  const draftHit = loadDraftStore().index.get(cmsId)
  if (draftHit) return draftHit
  return loadPublishedStore().index.get(cmsId) ?? null
}

export async function writeDraftNode(cmsId: string, node: CmsNode): Promise<void> {
  const backend = getCmsStorage()
  const current = (await backend.loadDraft())?.store ?? emptyStore()
  current.partials[cmsId] = { ...node, id: cmsId }
  await backend.saveDraft(current)
  _invalidateCmsStoreCache()
}

export async function publishDraft(): Promise<void> {
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
}

export async function revertDraftNode(cmsId: string): Promise<void> {
  const backend = getCmsStorage()
  const current = (await backend.loadDraft())?.store
  if (!current || !(cmsId in current.partials)) return
  delete current.partials[cmsId]
  if (Object.keys(current.partials).length === 0) {
    await backend.deleteDraft()
  } else {
    await backend.saveDraft(current)
  }
  _invalidateCmsStoreCache()
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

export function resolveCmsFields(
  cmsId: string,
  request: Request,
): Record<string, unknown> | null {
  const node = lookupCmsNode(cmsId, request)
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
export function cmsFingerprintContribution(cmsId: string, request: Request): string {
  const node = lookupCmsNode(cmsId, request)
  if (!node) return `|cms=${cmsId}:miss`
  return `|cms=${cmsId}:${contributionForNode(node, request)}`
}

function contributionForNode(node: CmsNode, request: Request): string {
  const fields = mergeMatchingConfigs(node.configs, request)
  const base = stableStringify(fields)
  if (!node.slots) return base
  const slotParts: string[] = []
  for (const name of Object.keys(node.slots).sort()) {
    const children = node.slots[name]
    const childParts = children.map((child) => {
      // Resolve each child through `lookupCmsNode` so a top-level
      // draft override on the slot-child id (saveCmsFields writes
      // edits to `partials[childId]`, not into the parent's slot
      // tree) flows into the parent's contribution. Without this,
      // editing a nav-link's label leaves `app-nav`'s fingerprint
      // unchanged — the parent fp-skips, the cached subtree wins,
      // and the preview keeps showing the old label until the next
      // full page render.
      const effective = lookupCmsNode(child.id, request) ?? child
      return `${child.id}=${contributionForNode(effective, request)}`
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

// ─── Sync read surface (passed into vary callbacks) ───────────────────

const EMPTY_IMAGE = Object.freeze({ src: "", alt: "" })

/**
 * Build a sync `CmsReadSurface` bound to `cmsId` + `request`. The
 * resolver runs once on first read and memoizes; subsequent reads hit
 * the cached fields map. Empty defaults for everything when the store
 * has nothing — vary still returns a stable shape on first authoring.
 */
export function createCmsReadSurface(cmsId: string | undefined, request: Request): CmsReadSurface {
  let resolved: Record<string, unknown> | null | undefined
  const resolve = (): Record<string, unknown> | null => {
    if (resolved !== undefined) return resolved
    if (cmsId == null) {
      resolved = null
      return null
    }
    resolved = resolveCmsFields(cmsId, request)
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
  }
}

// ─── Spec catalog (block + page registration) ─────────────────────────
//
// `ReactCms.partial(...)` self-registers each spec under its `cmsId`.
// Slots resolve store entries by looking up `entry.type` here.

export interface SpecCatalogEntry {
  id: string
  cmsId: string
  selectorTokens: { uniqueTokens: string[]; sharedTokens: string[] }
  /** The component returned by ReactCms.partial — render it as JSX.
   *  Accepts the standard `parent` plus a per-instance `cmsId`
   *  override for slot use. */
  Component: React.FC<{
    parent: import("../lib/partial-context.ts").PartialCtx
    cmsId?: string
    children?: ReactNode
  }>
  /** Stable identifier for the catalog ("type" tag). Defaults to cmsId. */
  type: string
  /** True when this spec was constructed with `tags` — usable as a
   *  slot block. Only slot blocks register in the type catalog. */
  isSlotBlock: boolean
  /** Used by the editor's catalog prerender to discover content fields. */
  vary?: (scope: {
    url: URL
    pathname: string
    search: Partial<Record<string, string>>
    cookies: Partial<Record<string, string>>
    headers: Partial<Record<string, string>>
    params: Record<string, string>
    cms: CmsReadSurface
  }) => unknown
  /** Compiled URLPattern for the spec's `match` option, if any. The
   *  framework's descendant-fp fold needs to evaluate descendants'
   *  matches against the current request URL when computing
   *  ancestors' fingerprints. */
  matchPattern?: URLPattern
  /** Optional render fn name for selector auto-derivation. */
  displayName: string
}

const specCatalog = new Map<string, SpecCatalogEntry>()
const typeCatalog = new Map<string, SpecCatalogEntry>()

export function registerSpec(entry: SpecCatalogEntry): void {
  specCatalog.set(entry.cmsId, entry)
  // Only slot-block specs go into the type catalog. A spec is a slot
  // block when it has class-only tag tokens (no #-tokens) AND the
  // explicit `type` was NOT auto-derived from a #-token. Page specs
  // (which auto-derive id/type from their selector) shouldn't shadow
  // slot blocks in the type catalog.
  if (entry.isSlotBlock) {
    typeCatalog.set(entry.type, entry)
  }
}

export function getSpecByCmsId(cmsId: string): SpecCatalogEntry | undefined {
  return specCatalog.get(cmsId)
}

export function getSpecByType(type: string): SpecCatalogEntry | undefined {
  return typeCatalog.get(type)
}

export function listSpecTypes(): string[] {
  return [...typeCatalog.keys()]
}

export function _clearSpecCatalog(): void {
  specCatalog.clear()
  typeCatalog.clear()
}

// Re-export for slot.tsx compatibility.
export type ReactNode_ = ReactNode
