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
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

const __dirname = dirname(fileURLToPath(import.meta.url));
const CMS_DIR = join(__dirname, "..", "cms");
const PUBLISHED_PATH = join(CMS_DIR, "content.json");
const DRAFT_PATH = join(CMS_DIR, "draft.json");

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
  const walk = (node: CmsNode): void => {
    index.set(node.id, node);
    if (node.slots) {
      for (const entries of Object.values(node.slots)) {
        for (const child of entries) walk(child);
      }
    }
  };
  for (const node of Object.values(store.partials)) walk(node);
  return index;
}

function loadSlot(
  path: string,
  current: CacheSlot | null,
): { slot: CacheSlot | null; fallback: { store: CmsStore; index: Map<string, CmsNode> } } {
  try {
    const mtime = statSync(path).mtimeMs;
    if (current && current.mtime === mtime) {
      return { slot: current, fallback: current };
    }
    const text = readFileSync(path, "utf8");
    const store = JSON.parse(text) as CmsStore;
    const index = buildIndex(store);
    const slot: CacheSlot = { store, index, mtime };
    return { slot, fallback: slot };
  } catch {
    if (current) return { slot: current, fallback: current };
    // Fresh empty store on every fallback — writing callers
    // (`writeDraftNode`) would otherwise mutate a shared singleton
    // and leak entries between unrelated writes when the draft file
    // doesn't yet exist.
    return { slot: null, fallback: { store: emptyStore(), index: new Map() } };
  }
}

function loadPublishedStore(): { store: CmsStore; index: Map<string, CmsNode> } {
  const { slot, fallback } = loadSlot(PUBLISHED_PATH, publishedSlot);
  if (slot) publishedSlot = slot;
  return fallback;
}

function loadDraftStore(): { store: CmsStore; index: Map<string, CmsNode> } {
  const { slot, fallback } = loadSlot(DRAFT_PATH, draftSlot);
  if (slot) draftSlot = slot;
  return fallback;
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
 */
export interface CmsTreeEntry {
  id: string;
  type?: string;
  displayName?: string;
  depth: number;
  slotName?: string;
  parentId?: string;
  /** `true` when this id only exists in draft (no published
   *  counterpart yet). */
  draftOnly: boolean;
}

export function listAllCmsNodes(): CmsTreeEntry[] {
  const published = loadPublishedStore().store.partials;
  const draft = loadDraftStore().store.partials;
  const merged: Record<string, CmsNode> = { ...published };
  for (const [id, node] of Object.entries(draft)) {
    merged[id] = node;
  }
  const entries: CmsTreeEntry[] = [];
  const walk = (
    node: CmsNode,
    depth: number,
    slotName: string | undefined,
    parentId: string | undefined,
  ): void => {
    entries.push({
      id: node.id,
      type: node.type,
      displayName: node.displayName,
      depth,
      slotName,
      parentId,
      draftOnly: draft[node.id] != null && published[node.id] == null,
    });
    if (node.slots) {
      for (const [name, children] of Object.entries(node.slots)) {
        for (const child of children) walk(child, depth + 1, name, node.id);
      }
    }
  };
  for (const node of Object.values(merged)) walk(node, 0, undefined, undefined);
  return entries;
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
 * Write a Partial node into the draft store. Overwrites the existing
 * top-level entry for `cmsId` wholesale — drafts are full-node
 * overrides in v1, so the editor serializes the complete post-edit
 * node shape (configs + slots) rather than diffing field-level
 * changes.
 *
 * Synchronously invalidates both in-memory store slots so the next
 * read sees the write — dev-only flow; a production writer would
 * go through a queue + store backend.
 */
export function writeDraftNode(cmsId: string, node: CmsNode): void {
  const { store } = loadDraftStore();
  store.partials[cmsId] = { ...node, id: cmsId };
  writeStoreFile(DRAFT_PATH, store);
  _invalidateCmsStoreCache();
}

/**
 * Copy draft → published, then clear the draft. Intended as the
 * editor's "publish" action. Writes both files atomically from the
 * editor's perspective (invalidates both cache slots on return so a
 * reader following the publish immediately sees the new published
 * state and an empty draft).
 */
export function publishDraft(): void {
  const draft = loadDraftStore().store;
  const published = loadPublishedStore().store;
  for (const [id, node] of Object.entries(draft.partials)) {
    published.partials[id] = node;
  }
  writeStoreFile(PUBLISHED_PATH, published);
  writeStoreFile(DRAFT_PATH, { partials: {} });
  _invalidateCmsStoreCache();
}

function writeStoreFile(path: string, store: CmsStore): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2) + "\n", "utf8");
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
export function _clearCmsDraft(): void {
  if (existsSync(DRAFT_PATH)) unlinkSync(DRAFT_PATH);
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
