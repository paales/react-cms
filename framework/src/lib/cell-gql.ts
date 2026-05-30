/**
 * GraphQL-shaped cells: `gqlCellBuilder` / `gqlCell` + `fragmentCell`.
 *
 *   gqlCellBuilder — per-backend constructor that mirrors the gql.tada
 *                  `graphql()` tag. Bind the client + tag once, then
 *                  build cells from query strings:
 *
 *                      const pokemonQuery = gqlCellBuilder({ client, graphql })
 *                      export const heroCell = pokemonQuery(`query PokemonHero(…){…}`)
 *
 *                  The wire id auto-derives from the operation name
 *                  (kebab-cased, optionally namespaced by `prefix`), and
 *                  `.with(args)` is typed from the query's variables.
 *
 *   gqlCell      — low-level doc-mode constructor (`gqlCell(client, doc)`)
 *                  for callers that already hold a typed document. Same
 *                  auto-id + typed handle; the builder is sugar over it.
 *
 *   fragmentCell — cell typed by a GraphQL fragment but WITHOUT a
 *                  loader. Populated externally — typically by a
 *                  parent gqlCell's loader calling
 *                  `cellHandle.with(args).hydrate(value)`. The
 *                  fragment is purely a type-flow hook (gql.tada
 *                  inference); the runtime treats values opaquely.
 *
 * gqlCell cells are backed by REQUEST-SCOPED in-memory storage; each
 * request gets a fresh cache, discarded at request end. Cross-request
 * caching is a separate layer. For state that should persist across
 * runs (preferences, drafts) use `localCell`.
 */

import type {
  TadaDocumentNode,
  GraphQLTadaAPI,
  ResultOf,
  VariablesOf,
  FragmentOf,
} from "gql.tada"
import {
  buildEphemeralCell,
  type BoundCell,
  type CellInterface,
  type CellArgs,
} from "./cell.ts"

/**
 * Minimal GraphQL client contract. Both `graphql-request` and a
 * hand-rolled fetch wrapper match this. Defined locally so the
 * framework doesn't take a hard dep on a specific client library.
 */
export interface GqlClient {
  request<TResult, TVars extends Record<string, unknown>>(
    // Decoration slot is `any` so fragment-composed documents (which
    // carry a non-void decoration) are accepted — matches the real
    // `graphql-request` client's typed-document overload.
    document: TadaDocumentNode<TResult, TVars, any>,
    variables: TVars,
  ): Promise<TResult>
}

/**
 * A GraphQL-loaded cell. `CellInterface` with its args type bound to the
 * document's inferred variables, so `.with(args)` is typed — no override
 * needed, the base method picks up `TVars`.
 */
export interface GqlCell<TResult, TVars extends Record<string, unknown>>
  extends CellInterface<TResult | null, TVars> {}

// ─── id derivation ────────────────────────────────────────────────────

/** `PokemonHero` → `pokemon-hero`, `CartWithItems` → `cart-with-items`. */
function kebabCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[_\s]+/g, "-")
    .toLowerCase()
}

/** Read the operation name off a parsed gql.tada document AST. */
function operationNameOf(
  doc: TadaDocumentNode<unknown, Record<string, unknown>>,
): string | undefined {
  const def = (
    doc as { definitions?: ReadonlyArray<{ name?: { value?: string } }> }
  ).definitions?.[0]
  return def?.name?.value
}

/** Auto-derive the wire id from the operation name, unless overridden. */
function deriveCellId(
  doc: TadaDocumentNode<unknown, Record<string, unknown>>,
  prefix: string | undefined,
  explicit: string | undefined,
): string {
  if (explicit) return explicit
  const name = operationNameOf(doc)
  if (!name) {
    throw new Error(
      "gqlCell: cannot derive an id from an anonymous operation. Name the " +
        "query/mutation (e.g. `query PokemonHero(...)`) or pass `{ id }`.",
    )
  }
  const base = kebabCase(name)
  return prefix ? `${prefix}.${base}` : base
}

export interface GqlCellOpts<TResult> {
  /** Override the auto-derived wire id. */
  id?: string
  /** Initial value before the loader populates storage. Defaults to
   *  `null` — the loader is the normal cold-start path. */
  initial?: TResult | null
}

// ─── doc-mode primitive ───────────────────────────────────────────────

/**
 * Build a `GqlCell` from a typed gql.tada document. The wire id
 * auto-derives from the operation name (kebab-cased) unless `opts.id`
 * is given; the loader runs `client.request(doc, args)`.
 *
 *     export const heroCell = gqlCell(client, PokemonHeroQuery)
 *
 * Most call sites use `gqlCellBuilder` (which binds the client + tag and
 * accepts query strings directly); reach for this when you already hold
 * a document.
 */
export function gqlCell<TResult, TVars extends Record<string, unknown>>(
  client: GqlClient,
  doc: TadaDocumentNode<TResult, TVars, any>,
  opts?: GqlCellOpts<TResult> & { prefix?: string },
): GqlCell<TResult, TVars> {
  const id = deriveCellId(
    doc as TadaDocumentNode<unknown, Record<string, unknown>>,
    opts?.prefix,
    opts?.id,
  )
  const handle = buildEphemeralCell<TResult | null>(
    id,
    opts?.initial ?? null,
    async (args: CellArgs): Promise<TResult | null> => {
      return await runQuery(client, doc, args as TVars)
    },
  )
  return handle as unknown as GqlCell<TResult, TVars>
}

/**
 * Run a typed query through the client AND auto-hydrate any
 * fragment-backed child cells whose fragment appears in the document.
 * `gqlCell`'s synthesized loader uses this; custom loaders (a
 * `localCell` that computes an aggregate from the same response) call
 * it directly to get the auto-hydration for free.
 *
 *     load: async ({ cartId }) => {
 *       const data = await runQuery(client, CartQuery, { cartId })
 *       return aggregate(data)   // line cells already hydrated
 *     }
 */
export async function runQuery<TResult, TVars extends Record<string, unknown>>(
  client: GqlClient,
  doc: TadaDocumentNode<TResult, TVars, any>,
  vars: TVars,
): Promise<TResult> {
  const result = await client.request(doc, vars)
  hydrateFragmentsFromResult(doc, result)
  return result
}

// ─── per-backend builder ──────────────────────────────────────────────

// gql.tada's `SchemaLike` / `AbstractConfig` constraints aren't exported;
// reconstruct them structurally so the builder can be generic over the
// concrete schema (which must flow through to preserve the tag's typed
// call signature — a loose `(input: any) => any` constraint collapses
// inference to `any`).
type SchemaLike = {
  name?: unknown
  query: string
  mutation?: unknown
  subscription?: unknown
  types: { [name: string]: unknown }
}
type ConfigLike = { isMaskingDisabled: boolean }

/** A query's composition arg is always a `fragmentCell` (whose `.fragment`
 *  doc is extracted) — call sites pass the *cell*, never a raw `graphql()`
 *  fragment doc. This is what forbids raw fragment composition in app code:
 *  there is no document option to pass. */
type FragmentInput = FragmentCell<any, any>
type FragDocOf<I> = I extends FragmentCell<any, infer F> ? F : never

function isFragmentCellInput(x: unknown): x is FragmentCell<unknown> {
  return typeof x === "object" && x !== null && "__cell" in x && "fragment" in x
}

/** Options for the bundle's `fragment(...)`. `key`'s `data` is `any` here
 *  (the doc is created internally, so its `ResultOf` can't be referenced
 *  at the parameter position); the cell's *value* type is still inferred.
 *  Use `fragmentCell(graphql(...), {key})` if you want a typed `key`. */
interface BundleFragmentOpts {
  id?: string
  key?: (data: any) => CellArgs
  initial?: unknown
}

/**
 * Per-backend cell constructor — the gqlCell analogue of the gql.tada
 * `graphql()` tag. Bind the client + tag (and an optional id `prefix`)
 * once; the returned `{ query, fragment }` build typed cells from
 * strings, with the raw `graphql()` call hidden at every call site.
 *
 *     const magento = gqlCellBuilder({ client, graphql, prefix: "magento" })
 *
 *     export const cartLine = magento.fragment(
 *       `fragment CartLine on CartItemInterface { uid quantity }`,
 *       { key: (d) => ({ uid: d.uid }) },
 *     )
 *     export const cart = magento.query(
 *       `query Cart($cartId: String!) { cart(cart_id: $cartId) { items { uid ...CartLine } } }`,
 *       [cartLine],   // pass the CELL, not the raw fragment doc
 *     )                // id "magento.cart"; .with({ cartId }) typed
 */
export function gqlCellBuilder<Schema extends SchemaLike, Config extends ConfigLike>(config: {
  client: GqlClient
  graphql: GraphQLTadaAPI<Schema, Config>
  prefix?: string
}) {
  // Return types are INFERRED (not annotated) so gql.tada re-runs its
  // generic inference on the literal string — annotating would erase the
  // per-call document type.
  function query<const In extends string, const Items extends readonly FragmentInput[]>(
    input: In,
    items?: Items,
    opts?: { id?: string },
  ) {
    // Extract each item's `.fragment` doc for gql.tada composition. The
    // type already forbids raw docs; the runtime guard turns a stray one
    // into a clear error rather than a downstream gql.tada failure.
    const cells = (items ?? []) as ReadonlyArray<FragmentInput>
    const frags = cells.map((i) => {
      if (!isFragmentCellInput(i)) {
        throw new Error(
          "query(): fragment composition takes fragment cells (builder.fragment(...)), not raw graphql() docs",
        )
      }
      return i.fragment
    }) as { [K in keyof Items]: FragDocOf<Items[K]> }
    const doc = config.graphql(input, frags)
    const id = deriveCellId(
      doc as TadaDocumentNode<unknown, Record<string, unknown>>,
      config.prefix,
      opts?.id,
    )
    const handle = buildEphemeralCell<unknown>(id, null, async (args: CellArgs) => {
      const raw = await config.client.request(doc, args as never)
      return cells.length ? rewriteResultToCells(doc, cells, raw) : raw
    })
    return handle as unknown as GqlCell<
      RewriteSpreads<ResultOf<typeof doc>, Items>,
      VariablesOf<typeof doc>
    >
  }

  function fragment<const In extends string>(source: In, opts?: BundleFragmentOpts) {
    const doc = config.graphql(source)
    return fragmentCell(
      doc,
      opts as FragmentCellOpts<ResultOf<typeof doc>, ResultOf<typeof doc>>,
    )
  }

  return { query, fragment }
}

// ─── fragmentCell ─────────────────────────────────────────────────────

/**
 * A cell typed by — and keyed off — a GraphQL fragment. The stored
 * value is the fragment's masked data (`FragmentOf<F>`); consumers
 * unmask with `readFragment(fragment, value)`. The fragment document
 * is load-bearing three ways: it carries the type, derives the wire
 * id (kebab of the fragment name), and lets the framework match the
 * fragment's spreads in queries for auto-hydration.
 */
export interface FragmentCell<
  V,
  F extends TadaDocumentNode<any, any, any> = TadaDocumentNode<any, any, any>,
> extends CellInterface<V | null> {
  /** The fragment document this cell is typed by. Carries the precise
   *  doc type so a query built with `q.query(str, [cell])` can extract +
   *  compose it (the raw `graphql()` call stays hidden at the call site). */
  readonly fragment: F
}

// The cell value is the fragment's UNMASKED result (`ResultOf<F>`), not
// the masked `FragmentOf<F>` ref: the cell IS the colocation boundary, so
// consumers read fields directly (no `readFragment`), and — unlike
// `FragmentOf` — `ResultOf` resolves cleanly for fragments on abstract
// (interface/union) types. Author fragments with `@_unmask` so the
// query/mutation spread sites also produce unmasked, directly-settable
// values.

export interface FragmentCellOpts<R, V> {
  /** Override the auto-derived wire id (default: kebab of the fragment
   *  name — `CartLine` → `cart-line`). */
  id?: string
  /** Identity extractor — maps the fragment's (unmasked) data to its
   *  partition args. Defaults to `(d) => ({ id: d.id })` when the
   *  fragment selects an `id` field; REQUIRED otherwise (Magento's
   *  `uid`, composite keys). Drives both `.with(...)` placement and
   *  value-keyed `.set(value)`. `data` is typed `ResultOf<fragment>`. */
  key?: (data: R) => CellArgs
  /** Initial value before any hydration. Defaults to `null`. */
  initial?: V | null
}

/**
 * Build a `FragmentCell` from a gql.tada fragment document. It has NO
 * loader — it's populated by auto-hydration (when a gqlCell query
 * spreads this fragment, every matching result node is hydrated into
 * its keyed partition) or explicitly via `.with(args).hydrate(value)`
 * / value-keyed `.set(value)`.
 *
 *     const CartLineFragment = graphql(`
 *       fragment CartLine on CartItem { uid quantity product { sku } }
 *     `)
 *     export const cartLine = fragmentCell(CartLineFragment, {
 *       key: (d) => ({ uid: d.uid }),   // CartItem has no `id`
 *     })
 *
 *     // placement (parent maps the aggregate's uid list):
 *     <CartLine item={cartLine.with({ uid })} parent={parent} />
 *     // value-keyed write from a mutation that colocates ...CartLine:
 *     cartLine.set(r.updateCartItems.cart.items[0])
 */
export function fragmentCell<F extends TadaDocumentNode<any, any, any>, V = ResultOf<F>>(
  doc: F,
  opts?: FragmentCellOpts<ResultOf<F>, V>,
): FragmentCell<V, F> {
  const fragName = fragmentNameOf(doc)
  if (!fragName) {
    throw new Error(
      "fragmentCell: expected a named fragment document " +
        "(`fragment Name on Type { ... }`).",
    )
  }
  const id = opts?.id ?? kebabCase(fragName)

  let key = opts?.key
  if (!key) {
    if (!fragmentSelectsId(doc)) {
      throw new Error(
        `fragmentCell "${fragName}": no \`id\` field is selected and no ` +
          "`key` was provided. Either select `id` in the fragment, or pass " +
          "`key: (d) => ({ ... })` (e.g. `{ uid: d.uid }` for Magento).",
      )
    }
    key = (d) => ({ id: (d as { id: unknown }).id })
  }
  const keyFn = key

  // The stored value (V) is the fragment's result (ResultOf<F>) by
  // default; even when an author overrides V it carries the key field at
  // runtime, so the cast is sound.
  const keyOf = (value: V | null): CellArgs => {
    if (value == null) {
      throw new Error(
        `fragmentCell "${id}": cannot derive a partition from a null value. ` +
          "Use `.with(args).clear()` to remove a partition.",
      )
    }
    return keyFn(value as unknown as ResultOf<F>)
  }

  const handle = buildEphemeralCell<V | null>(id, opts?.initial ?? null, undefined, keyOf)
  Object.assign(handle, { fragment: doc })
  registerFragmentCell(fragName, handle as unknown as FragmentCell<unknown>)
  return handle as unknown as FragmentCell<V, F>
}

// ─── fragment registry + auto-hydration ───────────────────────────────

const fragmentCellsByName = new Map<string, FragmentCell<unknown>>()

function registerFragmentCell(name: string, cell: FragmentCell<unknown>): void {
  // HMR overwrites in place — storage keys by id, like the cell registry.
  fragmentCellsByName.set(name, cell)
}

/** Test-only — wipe the fragment-cell registry between runs. */
export function _clearFragmentCellRegistry(): void {
  fragmentCellsByName.clear()
}

/** A fragment spread found in a query, with its result path + @defer flag. */
interface SpreadSite {
  /** Field path (using result aliases) from the operation root to the
   *  selection set the spread lives in — e.g. `["cart", "items"]`. */
  path: string[]
  fragName: string
  deferred: boolean
}

const spreadSiteCache = new WeakMap<object, SpreadSite[]>()

/** Read a fragment document's name (`fragment CartLine on …` → `CartLine`). */
function fragmentNameOf(doc: unknown): string | undefined {
  const def = (doc as { definitions?: ReadonlyArray<any> }).definitions?.[0]
  return def?.kind === "FragmentDefinition" ? def?.name?.value : undefined
}

/** Does a fragment select a top-level scalar `id` field? */
function fragmentSelectsId(doc: unknown): boolean {
  const def = (doc as { definitions?: ReadonlyArray<any> }).definitions?.[0]
  const selections: ReadonlyArray<any> = def?.selectionSet?.selections ?? []
  return selections.some(
    (s) => s.kind === "Field" && s.name?.value === "id" && !s.selectionSet,
  )
}

function hasDeferDirective(directives: ReadonlyArray<any> | undefined): boolean {
  return (directives ?? []).some((d) => d?.name?.value === "defer")
}

/** Walk a query document AST, collecting every fragment spread with its
 *  result path and whether it's `@defer`'d. Cached per document. */
export function spreadSitesOf(doc: TadaDocumentNode<any, any, any>): SpreadSite[] {
  const cached = spreadSiteCache.get(doc)
  if (cached) return cached
  const op = (doc as { definitions?: ReadonlyArray<any> }).definitions?.[0]
  const out: SpreadSite[] = []
  const walk = (selectionSet: any, path: string[]): void => {
    if (!selectionSet) return
    for (const sel of selectionSet.selections ?? []) {
      if (sel.kind === "FragmentSpread") {
        out.push({
          path,
          fragName: sel.name.value,
          deferred: hasDeferDirective(sel.directives),
        })
      } else if (sel.kind === "Field") {
        const seg = (sel.alias ?? sel.name).value
        walk(sel.selectionSet, [...path, seg])
      } else if (sel.kind === "InlineFragment") {
        // Inline fragments don't add a path segment; defer on an inline
        // fragment marks its whole selection set deferred (handled by
        // the streaming loader, not auto-hydration).
        walk(sel.selectionSet, path)
      }
    }
  }
  walk(op?.selectionSet, [])
  spreadSiteCache.set(doc, out)
  return out
}

/** Gather the result node(s) at a field path, flattening intermediate
 *  arrays (so `["cart","items"]` yields each item). */
function collectAtPath(root: unknown, segments: string[]): unknown[] {
  let current: unknown[] = [root]
  for (const seg of segments) {
    const next: unknown[] = []
    for (const node of current) {
      if (node == null || typeof node !== "object") continue
      const v = (node as Record<string, unknown>)[seg]
      if (Array.isArray(v)) next.push(...v)
      else if (v !== undefined) next.push(v)
    }
    current = next
  }
  return current
}

/**
 * For every non-deferred fragment spread in `doc` that's backed by a
 * registered `fragmentCell`, walk `result` at the spread's path and
 * hydrate each node into its keyed partition. Pure side effect; safe
 * to call on any result (no-op when no spreads are fragment-backed).
 */
export function hydrateFragmentsFromResult(
  doc: TadaDocumentNode<any, any, any>,
  result: unknown,
): void {
  for (const site of spreadSitesOf(doc)) {
    if (site.deferred) continue // deferred spreads stream in via the loader
    const cell = fragmentCellsByName.get(site.fragName)
    if (!cell || !cell.keyOf) continue
    for (const node of collectAtPath(result, site.path)) {
      if (node == null) continue
      cell.with(cell.keyOf(node)).hydrate(node)
    }
  }
}

// ─── result → cells rewrite ───────────────────────────────────────────
//
// A query built with `q.query(str, [cell])` rewrites its result so each
// fragment-spread location holds the per-entity `BoundCell` (forwardable
// to a child parton) instead of raw data — the runtime twin of
// `RewriteSpreads` below. Spread sites are found by AST path (`spreadSitesOf`),
// not masking markers, so this is masking-independent at runtime.

/** Replace each node at `segments` (flattening intermediate arrays) via
 *  `replace`, mutating `root` in place (the loaded result is freshly
 *  allocated, so mutation is safe). */
function replaceAtPath(node: unknown, segments: string[], replace: (n: object) => unknown): void {
  if (node == null || typeof node !== "object") return
  if (Array.isArray(node)) {
    for (const el of node) replaceAtPath(el, segments, replace)
    return
  }
  const rec = node as Record<string, unknown>
  const [seg, ...rest] = segments
  const v = rec[seg]
  if (rest.length === 0) {
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        const el = v[i]
        if (el != null && typeof el === "object") v[i] = replace(el)
      }
    } else if (v != null && typeof v === "object") {
      rec[seg] = replace(v)
    }
  } else {
    replaceAtPath(v, rest, replace)
  }
}

/**
 * Hydrate each fragment-spread node into its keyed partition AND replace
 * it in the result with the bound cell. Returns the same (mutated) result.
 */
function rewriteResultToCells(
  doc: TadaDocumentNode<any, any, any>,
  cells: ReadonlyArray<FragmentCell<unknown>>,
  result: unknown,
): unknown {
  const byName = new Map<string, FragmentCell<unknown>>()
  for (const c of cells) {
    const name = fragmentNameOf(c.fragment)
    if (name) byName.set(name, c)
  }
  for (const site of spreadSitesOf(doc)) {
    if (site.deferred) continue
    const cell = byName.get(site.fragName)
    if (!cell || !cell.keyOf) continue
    const keyOf = cell.keyOf
    replaceAtPath(result, site.path, (node) => {
      const args = keyOf(node)
      cell.with(args).hydrate(node)
      return cell.with(args)
    })
  }
  return result
}

/** Type transform: replace each fragment-spread location in a query
 *  result with the matching cell's `BoundCell<V>` (forwardable), leaving
 *  everything else untouched. Distributes over union members so a
 *  nullable spread element (`Member | null`) keeps its `null`. */
type FragMatch<T, Cells extends readonly unknown[]> = Cells extends readonly [infer C, ...infer Rest]
  ? C extends FragmentCell<infer V, infer F>
    ? [T] extends [FragmentOf<F>]
      ? BoundCell<V | null>
      : FragMatch<T, Rest>
    : FragMatch<T, Rest> // non-cell item (raw fragment doc) — skip
  : never

export type RewriteSpreads<T, Cells extends readonly unknown[]> = T extends unknown
  ? [FragMatch<T, Cells>] extends [never]
    ? T extends readonly (infer E)[]
      ? ReadonlyArray<RewriteSpreads<E, Cells>>
      : T extends object
        ? { [K in keyof T]: RewriteSpreads<T[K], Cells> }
        : T
    : FragMatch<T, Cells>
  : never

export type { FragmentOf }
