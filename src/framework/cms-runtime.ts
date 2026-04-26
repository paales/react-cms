/**
 * CMS runtime — content store + resolver.
 *
 * The source of truth for CMS content is `src/cms/content.json` — a
 * committed forest of Partial-shaped nodes keyed by `cmsId`. Each node
 * holds one or more `configs` (match clause → fields) plus recursive
 * `slots`. At render time, `resolveCmsScope` finds the configs whose
 * match clauses are satisfied by the current request and cascade-
 * merges their fields (less-specific first, more-specific overrides).
 *
 * This module has NO runtime dependency on `context.ts` — the resolver
 * takes the `Request` as an explicit argument. The caller (content
 * accessors in `context.ts`) passes `getRequest()` through. Keeping it
 * dep-free avoids an import cycle and makes the resolver unit-testable.
 *
 * V1 specificity:
 *   - each config scores by the number of matched dimensions
 *   - longer score beats shorter (more dimensions matched = more specific)
 *   - tie-break by order of appearance in `configs[]` (earlier wins)
 *
 * V1 storage:
 *   - single committed JSON file, loaded with mtime-based caching.
 *     Dev: edits reflect on the next request (mtime bump invalidates
 *     the cache). Prod: first request loads; subsequent requests hit
 *     the cached store until the file is rewritten.
 *   - No draft/published split yet; that's a follow-up (`CMS_EDITOR.md`
 *     §Draft and published — cookie-driven).
 *
 * See `notes/CMS_MANIFEST.md` for the full design context.
 */

import type { ReactNode } from "react";
import { getCmsStorage, type CmsStorage, type LoadedStore } from "./cms-storage.ts";

// ─── Types ─────────────────────────────────────────────────────────────

/**
 * Classification of a content-field accessor call. Recorded on the
 * `CmsScope` for future editor introspection (the editor renders a
 * form whose field types come from this map).
 */
export type ContentFieldKind =
  | "text"
  | "richText"
  | "number"
  | "enum"
  | "image"
  | "boolean";

/** Declaration for a `<Children>` / `<Child>` slot; not wired yet. */
export interface SlotSpec {
  multi: boolean;
  allow?: string;
}

/**
 * Typed entity reference produced by `getReference(name, type)`.
 * Consumed by userspace loaders (`getProduct(ref)`, `getPokemon(ref)`,
 * …) which decide how to resolve a concrete value or fall back.
 *
 * Shape:
 *   - `type` — entity-family tag (`"product"`, `"pokemon"`, …). A
 *     loader accepts only refs of its family.
 *   - `value` — the concrete id/sku/slug from the CMS config, or
 *     `null` when no value was stored for this name.
 *   - `fallback` — what the loader should do if `value` is absent.
 *     `"closest"` (default) means "walk the parent chain via
 *     `getClosest<T>(type)`". `null` means "return null, the author
 *     explicitly wants a specific value or nothing."
 */
export interface Reference<T extends string = string> {
  readonly type: T;
  readonly value: string | null;
  readonly fallback: "closest" | null;
}

/**
 * Per-Partial CMS scope, held in a React.cache-backed cell (see
 * `context.ts`). Mutated when `<Partial cmsId=…>` runs; read by content
 * accessors. Same discipline as the frame-scope cell: read BEFORE any
 * `await`, otherwise a sibling may have mutated the cell to its own
 * scope between your capture and use.
 */
export interface CmsScope {
  /** Stable storage key for this Partial instance. */
  readonly cmsId: string;
  /** Effective Partial id (from selector) — for error messages. */
  readonly partialId: string;
  /** Content fields read during render, keyed by field name. For the
   *  editor to know which form fields to show. */
  readonly contentFields: Map<string, ContentFieldKind>;
  /** Entity references read during render, keyed by ref name → type tag. */
  readonly references: Map<string, string>;
  /** Named child slots declared during render. */
  readonly childSlots: Map<string, SlotSpec>;
  /** `getClosest(key)` reads, for ancestry-lint. */
  readonly contextConsumes: Set<string>;
  /** Lazy-resolved config fields.
   *    undefined → not yet resolved
   *    null      → resolved; no CMS node / no matching configs
   *    object    → resolved; merged fields from matching configs */
  resolvedConfig: Record<string, unknown> | null | undefined;
}

export function createCmsScope(cmsId: string, partialId: string): CmsScope {
  return {
    cmsId,
    partialId,
    contentFields: new Map(),
    references: new Map(),
    childSlots: new Map(),
    contextConsumes: new Set(),
    resolvedConfig: undefined,
  };
}

// ─── Store schema ──────────────────────────────────────────────────────

/**
 * Match clause — tests a request value against a predicate.
 *
 *   - scalar (string | number | boolean) → exact equality (stringified)
 *   - `{in: [...]}`                       → membership
 *   - for `pathname:<pattern>` keys, the clause is an object mapping
 *     param names → scalar | `{in: [...]}`. The full pattern must
 *     match and every declared param clause must match.
 */
export type MatchClause =
  | string
  | number
  | boolean
  | { in: ReadonlyArray<string | number> }
  | Record<string, ScalarOrIn>;

type ScalarOrIn = string | number | boolean | { in: ReadonlyArray<string | number> };

export interface CmsConfig {
  /** Map of manifest key → clause. Empty object = default (always matches). */
  match: Record<string, MatchClause>;
  fields: Record<string, unknown>;
}

export interface CmsNode {
  /** Storage anchor — matches the Partial's `cmsId` prop. */
  id: string;
  /** Component identifier for blocks contributed into slots. Omitted
   *  for code-declared Partials. */
  type?: string;
  /** Human-readable name shown in the editor; typically the selector. */
  displayName?: string;
  /** Configurations ordered by the author; the resolver re-sorts by
   *  computed specificity but uses array order as the tie-break. */
  configs: CmsConfig[];
  /** Recursive child-block storage; not consumed by v1. */
  slots?: Record<string, CmsNode[]>;
}

export interface CmsStore {
  partials: Record<string, CmsNode>;
}

// ─── Store loader ──────────────────────────────────────────────────────

function emptyStore(): CmsStore {
  return { partials: {} };
}

/**
 * Name of the cookie that flips the runtime into draft mode. When
 * set to `"1"` on a request, `lookupCmsNode(id, request)` checks the
 * draft store first and falls back to published. The editor sets
 * this cookie on its preview frame; real visitors never see it.
 */
export const CMS_DRAFT_COOKIE = "cms-draft";

interface CacheSlot {
  store: CmsStore;
  /** Flat `cmsId → node` index covering root entries AND recursive
   *  slot children. Built once per reload; lookups are O(1). */
  index: Map<string, CmsNode>;
  mtime: number;
}
let publishedSlot: CacheSlot | null = null;
let draftSlot: CacheSlot | null = null;

function buildIndex(store: CmsStore): Map<string, CmsNode> {
  const index = new Map<string, CmsNode>();
  // Pass 1: every top-level entry. These are the "authoritative"
  // versions — a draft write of a slot child goes here, so we want
  // it to take precedence over any stale nested copy that still
  // lives inside a parent's `slots` array.
  for (const node of Object.values(store.partials)) {
    index.set(node.id, node);
  }
  // Pass 2: recurse into slots and register nested children that
  // DON'T already have a top-level entry. This covers the published
  // shape (slot children are only stored inline, never at the top
  // level) without letting stale inline copies shadow a fresh
  // top-level edit in the draft store.
  const walk = (node: CmsNode): void => {
    if (!node.slots) return;
    for (const entries of Object.values(node.slots)) {
      for (const child of entries) {
        if (!index.has(child.id)) index.set(child.id, child);
        walk(child);
      }
    }
  };
  for (const node of Object.values(store.partials)) walk(node);
  return index;
}

function loadedToSlot(loaded: LoadedStore): CacheSlot {
  return { store: loaded.store, index: buildIndex(loaded.store), mtime: loaded.mtime };
}

/**
 * Sync read from cache, with a sync-fallback to disk when the cache
 * is cold. Partial bodies and CMS accessors call this on every
 * render — they're synchronous, so the load HAS to be synchronous
 * too. The async warming path (`warmCmsCache()`) refreshes the
 * cache before each request so a hot cache is the steady state;
 * this fallback is what saves us on cold start (test setup, first
 * request before any warm-up has run).
 */
function loadPublishedStore(): { store: CmsStore; index: Map<string, CmsNode> } {
  if (publishedSlot) return publishedSlot;
  const loaded = getCmsStorage().loadPublishedSync();
  if (loaded) {
    publishedSlot = loadedToSlot(loaded);
    return publishedSlot;
  }
  // No file. Empty-store fallback — fresh Map each call so a writer
  // can't accidentally mutate a shared singleton and leak entries
  // between unrelated writes.
  return { store: emptyStore(), index: new Map() };
}

function loadDraftStore(): { store: CmsStore; index: Map<string, CmsNode> } {
  if (draftSlot) return draftSlot;
  const loaded = getCmsStorage().loadDraftSync();
  if (loaded) {
    draftSlot = loadedToSlot(loaded);
    return draftSlot;
  }
  return { store: emptyStore(), index: new Map() };
}

/**
 * Async warm-up — call from the request entry before any render.
 * Re-reads the storage backend and refreshes the cache. The async
 * read avoids the sync-IO penalty in the hot path. Cache invalidation
 * uses the storage's mtime tag (file mtime for `JsonFileStorage`).
 *
 * Tests don't need to call this — sync lazy load via
 * `loadPublishedStore` covers cold-start; tests typically invoke
 * `_invalidateCmsStoreCache()` to force a re-read.
 */
export async function warmCmsCache(): Promise<void> {
  const backend = getCmsStorage();
  const [pub, draft] = await Promise.all([
    backend.loadPublished(),
    backend.loadDraft(),
  ]);
  if (pub) {
    if (!publishedSlot || publishedSlot.mtime !== pub.mtime) {
      publishedSlot = loadedToSlot(pub);
    }
  } else {
    // Backend has no published store — clear cache so the sync
    // path returns the empty fallback on next read.
    publishedSlot = null;
  }
  if (draft) {
    if (!draftSlot || draftSlot.mtime !== draft.mtime) {
      draftSlot = loadedToSlot(draft);
    }
  } else {
    draftSlot = null;
  }
}

function readCookieFromRequest(request: Request, name: string): string | null {
  const header = request.headers.get("cookie") ?? "";
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match?.[1] ?? null;
}

function isDraftRequest(request: Request | undefined): boolean {
  if (!request) return false;
  // Query-param form wins over cookie so the editor's preview frame
  // can opt in via `?cms-draft=1` on the frame URL (survives frame
  // navigation inherited from the page's cookies without needing to
  // mutate Set-Cookie inside the request).
  const url = new URL(request.url);
  if (url.searchParams.get("cms-draft") === "1") return true;
  return readCookieFromRequest(request, CMS_DRAFT_COOKIE) === "1";
}

/**
 * Flat list of every entry in draft + published, with hierarchy
 * info for the tree sidebar. Draft overrides published on id
 * collision.
 *
 * Two `kind`s of entry:
 *   - `"node"` — a real CmsNode (page, block, etc.). `id` is the
 *     node's `cmsId`; selecting it loads the field form.
 *   - `"slot"` — a synthetic intermediary inserted between a parent
 *     and its slot children when the parent declares 2+ slots, so
 *     authors can see which slot a child belongs to (a single-slot
 *     parent stays flat — the slot name is unambiguous). `id` is
 *     `slot:<parentId>:<slotName>`; selecting it loads the slot
 *     palette (add/reorder/remove). `slotName` and `parentId` are
 *     filled in.
 */
export type CmsTreeEntryKind = "node" | "slot" | "slot-add";

export interface CmsTreeEntry {
  id: string;
  kind: CmsTreeEntryKind;
  type?: string;
  displayName?: string;
  depth: number;
  /** For `"node"` entries: the slot of the parent this node hangs in
   *  (undefined for top-level nodes). For `"slot"` / `"slot-add"`
   *  entries: the slot name. */
  slotName?: string;
  /** For `"node"` entries: the `cmsId` of the parent node (undefined
   *  at top level). For `"slot"` / `"slot-add"` entries: the parent
   *  node's `cmsId`. */
  parentId?: string;
  /** `true` when this id only exists in draft (no published
   *  counterpart yet) — added by the editor, never published. */
  draftOnly: boolean;
  /** `true` when this id has a top-level draft entry, regardless of
   *  whether published also has it. Covers both "new" (draftOnly is
   *  true) and "modified" (draftOnly is false but draft exists)
   *  cases. The editor uses it for a "modified" badge so authors
   *  can see at a glance which entries have unpublished edits. */
  hasDraft: boolean;
}

/** Synthetic id for a slot header tree entry. */
export function slotEntryId(parentId: string, slotName: string): string {
  return `slot:${parentId}:${slotName}`;
}

/** Synthetic id for the slot-add tree entry (the `+ <type>` palette
 *  rendered AT THE END of a slot's children). */
export function slotAddEntryId(parentId: string, slotName: string): string {
  return `slot-add:${parentId}:${slotName}`;
}

/** Parse a slot entry id (either header `slot:` or footer `slot-add:`)
 *  back into its `{parentId, slotName}` parts, or `null` if the id
 *  isn't a slot entry. */
export function parseSlotEntryId(
  id: string,
): { parentId: string; slotName: string } | null {
  let rest: string;
  if (id.startsWith("slot-add:")) rest = id.slice("slot-add:".length);
  else if (id.startsWith("slot:")) rest = id.slice("slot:".length);
  else return null;
  const colon = rest.lastIndexOf(":");
  if (colon < 0) return null;
  return { parentId: rest.slice(0, colon), slotName: rest.slice(colon + 1) };
}

/**
 * Pure tree-building helper — takes the published / draft node maps
 * and returns the flat tree-entry list. Split out from
 * `listAllCmsNodes` so it's unit-testable without touching the
 * shared on-disk `draft.json` (which races across parallel vitest
 * file workers).
 */
export function buildCmsTreeEntries(
  published: Record<string, CmsNode>,
  draft: Record<string, CmsNode>,
): CmsTreeEntry[] {
  const merged: Record<string, CmsNode> = { ...published };
  for (const [id, node] of Object.entries(draft)) {
    merged[id] = node;
  }
  // Collect every id reachable in the published forest (top-level or
  // nested as a slot child). Drives the `draftOnly` flag — an id is
  // "draft only" when it has a draft entry but is nowhere in
  // published, even nested. Without this nesting walk the flag would
  // misfire for slot children (which only ever live nested in
  // published), giving them a misleading amber "draft" badge after
  // any edit.
  const publishedIds = new Set<string>();
  const collectPublishedIds = (node: CmsNode): void => {
    publishedIds.add(node.id);
    if (!node.slots) return;
    for (const children of Object.values(node.slots)) {
      for (const child of children) collectPublishedIds(child);
    }
  };
  for (const node of Object.values(published)) collectPublishedIds(node);

  // Pre-pass: every id that lives as a slot child somewhere in the
  // merged forest. `saveCmsFields` writes top-level draft entries
  // for edited slot children (the runtime's flat-index lookup top-
  // level-wins design — see `buildIndex`); without this dedupe step,
  // those edited children would surface in the tree twice — once
  // nested under their parent's slot walk, and once as a fake root
  // entry.
  const slotChildIds = new Set<string>();
  const collectSlotChildren = (node: CmsNode): void => {
    if (!node.slots) return;
    for (const children of Object.values(node.slots)) {
      for (const child of children) {
        slotChildIds.add(child.id);
        collectSlotChildren(child);
      }
    }
  };
  for (const node of Object.values(merged)) collectSlotChildren(node);

  const entries: CmsTreeEntry[] = [];
  const walk = (
    node: CmsNode,
    depth: number,
    slotName: string | undefined,
    parentId: string | undefined,
  ): void => {
    const hasDraft = draft[node.id] != null;
    entries.push({
      id: node.id,
      kind: "node",
      type: node.type,
      // Editor needs a HUMAN label for each row. Order:
      //   1. explicit `displayName` (author wrote it on the node)
      //   2. derived label from a well-known content field on the
      //      default config (title / headline / name) — the
      //      product-card "Linen apron" case the user flagged
      //   3. undefined → the editor falls back to `#${id}`
      // Step 2 keeps the tree readable even when authors haven't
      // bothered to set a displayName per node — common for blocks
      // contributed via the +add palette which only seeds an empty
      // default config.
      displayName: node.displayName ?? deriveLabelFromConfigs(node.configs),
      depth,
      slotName,
      parentId,
      // "draft only" = exists in draft, nowhere in published. Walks
      // the published tree (not just top-level) so slot children with
      // a draft override don't get misflagged as brand-new.
      draftOnly: hasDraft && !publishedIds.has(node.id),
      hasDraft,
    });
    if (!node.slots) return;
    const slotEntries = Object.entries(node.slots);
    // When a node declares ONE slot, the slot label (`▸ body`) adds
    // no information — there's no other slot to disambiguate it from
    // — and just costs a row of vertical space + an indent level for
    // every child. Skip the header in that case; render children
    // directly under the parent and keep the +add row at the same
    // depth as the children.
    //
    // 2+ slots still emit the header so authors can tell which slot
    // a given child belongs to (e.g. the multi-slot demo with `body`
    // + `sidebar`).
    const collapseHeader = slotEntries.length === 1;
    // Every slot a parent declares gets two synthetic entries:
    //
    //   1. `slot:<parent>:<name>` — header at the top of the slot's
    //      children. Just a label (▸ <slotName>); non-selectable
    //      (rendered as plain text, not a link). Skipped for
    //      single-slot parents — see `collapseHeader` above.
    //   2. `slot-add:<parent>:<name>` — footer at the bottom of the
    //      slot's children. Hosts the +add-block palette so authors
    //      naturally append blocks at the end of the list (matches
    //      the typical "list grows downward" mental model — Shopify,
    //      WordPress, Storyblok all put +add at the bottom).
    //
    // Splitting the intermediary into header + footer cleans up the
    // tree: the slot row is no longer a wide cluster of `+ type`
    // buttons that wraps to multiple lines and squeezes the slot
    // name. See the issue report (2026-04-25) for the visual breakage
    // before this split.
    for (const [name, children] of slotEntries) {
      const childDepth = collapseHeader ? depth + 1 : depth + 2;
      if (!collapseHeader) {
        entries.push({
          id: slotEntryId(node.id, name),
          kind: "slot",
          depth: depth + 1,
          slotName: name,
          parentId: node.id,
          draftOnly: false,
          hasDraft: false,
        });
      }
      // Prefer the merged top-level version of each slot child when
      // available — that's the post-edit state. Fall back to the
      // inline copy for ids the author hasn't edited yet (or that
      // never had a top-level entry, i.e. published slot children).
      for (const child of children) {
        const effective = merged[child.id] ?? child;
        walk(effective, childDepth, name, node.id);
      }
      entries.push({
        id: slotAddEntryId(node.id, name),
        kind: "slot-add",
        depth: childDepth,
        slotName: name,
        parentId: node.id,
        draftOnly: false,
        hasDraft: false,
      });
    }
  };
  for (const node of Object.values(merged)) {
    // Skip ids that show up as a slot child of some other node —
    // they are emitted by the parent's slot walk above.
    if (slotChildIds.has(node.id)) continue;
    walk(node, 0, undefined, undefined);
  }
  return entries;
}

/**
 * Pick the best human label from a node's default config when the
 * author hasn't set an explicit `displayName`. Walks the configs for
 * the first `match: {}` entry (or the first config if none match) and
 * tries common title-shaped field names in order. Returns undefined
 * if nothing useful is set — caller falls back to `#${id}`.
 */
function deriveLabelFromConfigs(configs: readonly CmsConfig[]): string | undefined {
  if (configs.length === 0) return undefined;
  const defaultConfig =
    configs.find((c) => Object.keys(c.match).length === 0) ?? configs[0];
  for (const field of ["title", "headline", "name", "label"] as const) {
    const v = defaultConfig.fields[field];
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return undefined;
}

export function listAllCmsNodes(): CmsTreeEntry[] {
  return buildCmsTreeEntries(
    loadPublishedStore().store.partials,
    loadDraftStore().store.partials,
  );
}

/**
 * Look up a Partial node by its stable storage id. The store is a
 * recursive forest (`slots` contain more `CmsNode`s); lookup walks a
 * flat `cmsId → node` index built eagerly on load. Slot children are
 * therefore addressable by `cmsId` the same way root entries are.
 *
 * Draft fork: when `request` is passed and carries `cms-draft=1`
 * cookie, the draft store is checked first and a hit is returned
 * directly. A miss falls through to published — an author who
 * hasn't touched a node sees the published value by default. The
 * cookie also participates in any downstream fingerprint / cache
 * derivation via `cmsFingerprintContribution` returning a
 * different string for the same id (different node in draft ⇒
 * different stringified fields ⇒ different fp), so cached bytes
 * never leak across modes.
 */
export function lookupCmsNode(
  cmsId: string,
  request?: Request,
): CmsNode | null {
  if (isDraftRequest(request)) {
    const draftHit = loadDraftStore().index.get(cmsId);
    if (draftHit) return draftHit;
  }
  return loadPublishedStore().index.get(cmsId) ?? null;
}

/**
 * Editor-mode lookup: always prefer the draft store, fall back to
 * published. Use this in editor server actions + the editor page's
 * own (non-preview) reads, where the current request might not carry
 * the draft cookie yet (first page load hasn't round-tripped
 * Set-Cookie) but the editor still wants to see draft content.
 *
 * Do NOT use from application-facing code paths — the request-based
 * `lookupCmsNode` is the default, and draft visibility is
 * authoritatively keyed off the `cms-draft=1` cookie / query param.
 */
export function lookupDraftNode(cmsId: string): CmsNode | null {
  const draftHit = loadDraftStore().index.get(cmsId);
  if (draftHit) return draftHit;
  return loadPublishedStore().index.get(cmsId) ?? null;
}

/**
 * Write a Partial node into the draft store. Overwrites the existing
 * top-level entry for `cmsId` wholesale — drafts are full-node
 * overrides in v1, so the editor serializes the complete post-edit
 * node shape (configs + slots) rather than diffing field-level
 * changes.
 *
 * Async because the storage backend's writes are async. Server
 * actions await this; tests can `await` it inline. The in-memory
 * cache is invalidated on return so the next sync read picks up the
 * write.
 */
export async function writeDraftNode(cmsId: string, node: CmsNode): Promise<void> {
  // Read CURRENT draft via async load — tests sometimes mutate the
  // file outside `cms-runtime` between writes, and the sync cache
  // could be stale. The async backend read picks up disk-side
  // changes the cache hasn't seen yet.
  const backend = getCmsStorage();
  const current = (await backend.loadDraft())?.store ?? emptyStore();
  current.partials[cmsId] = { ...node, id: cmsId };
  await backend.saveDraft(current);
  _invalidateCmsStoreCache();
}

/**
 * Copy draft → published, then clear the draft. Intended as the
 * editor's "publish" action. The two writes (published save + draft
 * clear) are sequential — a mid-publish crash leaves draft entries
 * still in the draft store, but published already has the merged
 * copy. Authors can re-publish; no data loss.
 */
export async function publishDraft(): Promise<void> {
  const backend = getCmsStorage();
  const [draft, published] = await Promise.all([
    backend.loadDraft(),
    backend.loadPublished(),
  ]);
  const draftStore = draft?.store ?? emptyStore();
  const publishedStore = published?.store ?? emptyStore();
  for (const [id, node] of Object.entries(draftStore.partials)) {
    publishedStore.partials[id] = node;
  }
  await backend.savePublished(publishedStore);
  await backend.saveDraft(emptyStore());
  _invalidateCmsStoreCache();
}

/**
 * Drop a single id's draft override. If the id has a top-level
 * draft entry, the entry is removed; if it doesn't, this is a
 * no-op. Used by the editor's "Reset to published" button to undo
 * unpublished changes without touching other drafts.
 *
 * Edge case: if removing the entry empties the draft store entirely,
 * the storage's `deleteDraft` is called rather than leaving an
 * empty `{partials: {}}` payload — a missing draft is the canonical
 * "no draft" state.
 */
export async function revertDraftNode(cmsId: string): Promise<void> {
  const backend = getCmsStorage();
  const current = (await backend.loadDraft())?.store;
  if (!current || !(cmsId in current.partials)) return;
  delete current.partials[cmsId];
  if (Object.keys(current.partials).length === 0) {
    await backend.deleteDraft();
  } else {
    await backend.saveDraft(current);
  }
  _invalidateCmsStoreCache();
}

/**
 * Dev / test reset — drops the in-memory cache so the next lookup
 * re-reads from disk unconditionally. Not needed in normal flow
 * (mtime-based invalidation handles it), but useful for tests that
 * swap the file contents within one process.
 */
export function _invalidateCmsStoreCache(): void {
  publishedSlot = null;
  draftSlot = null;
}

/**
 * Delete the draft file + drop its cache. Dev / test helper — wired
 * into `/__test/clear-caches` so e2e tests see a clean draft state
 * on `beforeEach`, and usable from a debug button.
 */
export async function _clearCmsDraft(): Promise<void> {
  await getCmsStorage().deleteDraft();
  _invalidateCmsStoreCache();
}

// ─── Block registry ────────────────────────────────────────────────────
//
// `<Children>` / `<Child>` slots read a CmsNode's `slots[name]` entries
// and render each one as a `<Partial>`. The `type` field on each entry
// names the block component; this registry maps those type tags to
// concrete components + their shared-token tags. Populated at app
// init via `registerBlock("hero", …)` calls in the app's catalog
// module.
//
// Module-level side-effect registration is used here (vs a manifest
// file) because the catalog in userspace owns the full list, and
// importing the catalog once in the app entry is enough. Future-
// editor introspection (palette building, field prerender) will
// layer on top of this registry.

export interface BlockSpec {
  /**
   * Shared-token selectors carried by every instance of this block.
   * Prefix is significant: each string must start with `.`. The
   * runtime concatenates these with a per-instance `#<cmsId>` so
   * every block Partial has a unique unique-token for addressing,
   * plus the registered class-tokens for selector-based refetch.
   */
  readonly tags: ReadonlyArray<`.${string}`>;
  /** The block's server component — renders inside a CMS scope keyed
   *  to the block's `cmsId`. The component reads its fields via
   *  `getText` / `getEnum` / … accessors. */
  readonly component: () => ReactNode | Promise<ReactNode>;
}

const blockRegistry = new Map<string, BlockSpec>();

/**
 * Register a block component under its type tag. Call in a module
 * imported once by the app entry (see `src/app/blocks/catalog.ts` in
 * the example app).
 *
 * Subsequent registrations overwrite — HMR-friendly; the latest
 * module wins.
 */
export function registerBlock(type: string, spec: BlockSpec): void {
  blockRegistry.set(type, spec);
}

/**
 * Look up a block spec by its type tag. Returns `undefined` when the
 * type isn't registered — `<Children>` logs and skips missing types
 * rather than throwing, so an unknown entry in the store is visible
 * but not fatal.
 */
export function getBlockSpec(type: string): BlockSpec | undefined {
  return blockRegistry.get(type);
}

/** Dev / test reset — drops every registered block. */
export function _clearBlockRegistry(): void {
  blockRegistry.clear();
}

/** All registered block type tags — used by the future editor's palette. */
export function listBlockTypes(): string[] {
  return [...blockRegistry.keys()];
}

// ─── Resolver ──────────────────────────────────────────────────────────

/**
 * Resolve the final field map for a Partial given its CmsScope and the
 * current request. Memoized on the scope — subsequent calls in the
 * same render return the same object.
 */
export function resolveCmsScope(
  scope: CmsScope,
  request: Request,
): Record<string, unknown> | null {
  if (scope.resolvedConfig !== undefined) return scope.resolvedConfig;
  const node = lookupCmsNode(scope.cmsId, request);
  if (!node) {
    scope.resolvedConfig = null;
    return null;
  }
  const merged = mergeMatchingConfigs(node.configs, request);
  scope.resolvedConfig = merged;
  return merged;
}

/**
 * For tests / the editor: compute the resolved field map without
 * touching a scope. Pure.
 */
export function resolveCmsNode(
  node: CmsNode,
  request: Request,
): Record<string, unknown> {
  return mergeMatchingConfigs(node.configs, request);
}

/**
 * Contribution a CMS-aware Partial makes to the structural fingerprint
 * — the stable-stringified resolved field map for `cmsId` under the
 * current request, recursively including every slot descendant's
 * resolved fields.
 *
 * Why fold content into the fp: the fingerprint-skip protocol
 * (`?cached=id:fp`) tells the server "I already have this id at this
 * fp". If only `fingerprintElement(children)` contributed, two
 * different CMS configs that share JSX but differ in fields would
 * hash identically — on nav between them the server would emit a
 * skip placeholder and the client would paint stale cached bytes.
 *
 * Why recurse into slots: a host Partial whose own config is empty
 * but whose `slots[].configs` vary per request would fp-skip on the
 * host even though the slot children's content changed. The client's
 * cache for the host serves old slot-content bytes inline. Folding
 * every slot descendant's resolved fields into the host's fp makes
 * the fp differ whenever the rendered subtree would differ — fp-skip
 * stays correct without the server needing to walk into the skipped
 * Partial's body.
 *
 * Same concern for `<Partial cache>`: its `baseKey` derives from
 * `structuralFp`, so a cache key that ignored CMS fields would hit
 * stale bytes across different matching configs. Folding the
 * resolved fields into the fp closes both holes.
 *
 * Missing nodes, missing configs, and first-render-with-no-match all
 * return a stable-but-distinct string so "no CMS entry yet" doesn't
 * collide with "CMS entry with empty fields".
 */
export function cmsFingerprintContribution(
  cmsId: string,
  request: Request,
): string {
  const node = lookupCmsNode(cmsId, request);
  if (!node) return `|cms=${cmsId}:miss`;
  return `|cms=${cmsId}:${contributionForNode(node, request)}`;
}

function contributionForNode(node: CmsNode, request: Request): string {
  const fields = mergeMatchingConfigs(node.configs, request);
  const base = stableStringify(fields);
  if (!node.slots) return base;
  const slotParts: string[] = [];
  for (const name of Object.keys(node.slots).sort()) {
    const children = node.slots[name];
    const childParts = children.map(
      (child) => `${child.id}=${contributionForNode(child, request)}`,
    );
    slotParts.push(`${name}:[${childParts.join(",")}]`);
  }
  return `${base}|slots={${slotParts.join(";")}}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return (
    "{" +
    keys
      .map(
        (k) =>
          JSON.stringify(k) +
          ":" +
          stableStringify((value as Record<string, unknown>)[k]),
      )
      .join(",") +
    "}"
  );
}

function mergeMatchingConfigs(
  configs: readonly CmsConfig[],
  request: Request,
): Record<string, unknown> {
  const matched: Array<{ cfg: CmsConfig; idx: number; score: number[] }> = [];
  for (let i = 0; i < configs.length; i++) {
    const cfg = configs[i];
    const score = evaluateMatch(cfg.match, request);
    if (score !== null) matched.push({ cfg, idx: i, score });
  }
  matched.sort((a, b) => {
    const cmp = compareSpecificity(a.score, b.score);
    if (cmp !== 0) return cmp;
    return a.idx - b.idx;
  });
  // Cascade: apply least-specific first so more-specific overrides win.
  const merged: Record<string, unknown> = {};
  for (let i = matched.length - 1; i >= 0; i--) {
    Object.assign(merged, matched[i].cfg.fields);
  }
  return merged;
}

/**
 * Evaluate a config's match clause against the request. Returns a
 * per-dimension specificity score (array of 1s, one per matched
 * dimension) or `null` if any dimension's clause doesn't match.
 *
 * V1: each matched dimension contributes 1 to the score; longer score
 * beats shorter; ties tie-break by config-array order.
 */
function evaluateMatch(
  match: Record<string, MatchClause>,
  request: Request,
): number[] | null {
  const url = new URL(request.url);
  const scores: number[] = [];
  for (const [key, clause] of Object.entries(match)) {
    if (!matchKey(key, clause, url, request)) return null;
    scores.push(1);
  }
  return scores;
}

function matchKey(
  key: string,
  clause: MatchClause,
  url: URL,
  request: Request,
): boolean {
  const colonIdx = key.indexOf(":");
  if (colonIdx < 0) return false;
  const kind = key.slice(0, colonIdx);
  const name = key.slice(colonIdx + 1);

  switch (kind) {
    case "url":
      return scalarClauseMatches(clause, url.searchParams.get(name) ?? "");
    case "cookie":
      return scalarClauseMatches(clause, readCookie(request, name) ?? "");
    case "header":
      return scalarClauseMatches(clause, request.headers.get(name) ?? "");
    case "pathname": {
      const params = matchRoutePatternLocal(url.pathname, name);
      if (!params) return false;
      if (typeof clause !== "object" || clause === null || Array.isArray(clause)) {
        return false;
      }
      if ("in" in clause) return false; // `in` at the top of a pathname clause is malformed
      for (const [paramName, paramClause] of Object.entries(
        clause as Record<string, ScalarOrIn>,
      )) {
        if (!scalarClauseMatches(paramClause, params[paramName] ?? "")) {
          return false;
        }
      }
      return true;
    }
    default:
      return false;
  }
}

function scalarClauseMatches(clause: MatchClause, value: string): boolean {
  if (typeof clause === "string") return clause === value;
  if (typeof clause === "number") return String(clause) === value;
  if (typeof clause === "boolean") return String(clause) === value;
  if (
    typeof clause === "object" &&
    clause !== null &&
    !Array.isArray(clause) &&
    "in" in clause &&
    Array.isArray((clause as { in: unknown }).in)
  ) {
    const list = (clause as { in: ReadonlyArray<string | number> }).in;
    return list.some((v) => String(v) === value);
  }
  return false;
}

function compareSpecificity(a: number[], b: number[]): number {
  // Longer array → more dimensions matched → higher specificity.
  return b.length - a.length;
}

// ─── Local copies of request helpers ───────────────────────────────────
//
// Duplicated here (rather than imported from `context.ts`) to keep this
// module dependency-free. Both functions are tiny and pure.

function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie") ?? "";
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match?.[1];
}

function matchRoutePatternLocal(
  pathname: string,
  pattern: string,
): Record<string, string> | null {
  const pathSegs = pathname.split("/").filter(Boolean);
  const patSegs = pattern.split("/").filter(Boolean);
  if (pathSegs.length !== patSegs.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < patSegs.length; i++) {
    const pat = patSegs[i];
    const seg = pathSegs[i];
    if (pat.startsWith(":")) {
      params[pat.slice(1)] = decodeURIComponent(seg);
    } else if (pat !== seg) {
      return null;
    }
  }
  return params;
}
