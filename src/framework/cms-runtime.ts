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

import { readFileSync, statSync } from "node:fs";
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
const STORE_PATH = join(__dirname, "..", "cms", "content.json");
const EMPTY_STORE: CmsStore = { partials: {} };

interface CacheSlot {
  store: CmsStore;
  mtime: number;
}
let cacheSlot: CacheSlot | null = null;

function loadStore(): CmsStore {
  try {
    const mtime = statSync(STORE_PATH).mtimeMs;
    if (cacheSlot && cacheSlot.mtime === mtime) return cacheSlot.store;
    const text = readFileSync(STORE_PATH, "utf8");
    const store = JSON.parse(text) as CmsStore;
    cacheSlot = { store, mtime };
    return store;
  } catch {
    return cacheSlot?.store ?? EMPTY_STORE;
  }
}

/** Look up a Partial node by its stable storage id. */
export function lookupCmsNode(cmsId: string): CmsNode | null {
  const store = loadStore();
  return store.partials[cmsId] ?? null;
}

/**
 * Dev / test reset — drops the in-memory cache so the next lookup
 * re-reads from disk unconditionally. Not needed in normal flow
 * (mtime-based invalidation handles it), but useful for tests that
 * swap the file contents within one process.
 */
export function _invalidateCmsStoreCache(): void {
  cacheSlot = null;
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
  const node = lookupCmsNode(scope.cmsId);
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
 * current request.
 *
 * Why fold content into the fp: the fingerprint-skip protocol
 * (`?cached=id:fp`) tells the server "I already have this id at this
 * fp". If only `fingerprintElement(children)` contributed, two
 * different CMS configs that share JSX but differ in fields would
 * hash identically — on nav between them the server would emit a
 * skip placeholder and the client would paint stale cached bytes.
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
  const node = lookupCmsNode(cmsId);
  if (!node) return `|cms=${cmsId}:miss`;
  const fields = mergeMatchingConfigs(node.configs, request);
  return `|cms=${cmsId}:${stableStringify(fields)}`;
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
