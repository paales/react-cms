# Cells as resolvers — what shipped, what's still open

> Captured 2026-05-26 during the design conversation that produced
> bound cells (`.with(args)`), the prop-bag resolution path,
> partition-scoped invalidation, and `gqlCell`. The user-facing
> surface lives in [`../reference/cells.md`](../reference/cells.md);
> this note tracks the residue — design questions that were noted
> but deferred during the shipped change.

## What shipped (resolved questions)

- **Resolver-shape primitive.** Cells are normalised entity slots with
  loaders. Same `Cell<T>` contract across `localCell` (storage-only,
  static `initial`) and `gqlCell` (loader = gql.tada-typed query).
- **Args mechanism.** `cellHandle.with(args)` returns a `BoundCell<T>`
  with partition baked. Authors pass `BoundCell`s as JSX props; the
  framework resolves them in the parton's prop-bag resolution phase.
- **Storage-as-authoritative.** Loader runs on cold-start; storage is
  the source thereafter. No TTL, no `freshFor` — that was an
  anti-pattern. Mutations write the cell explicitly; reads dedupe.
- **Partition-scoped invalidation.** Cell writes emit
  `cell:<id>?<args>` selectors; only placements whose constraint
  surface (match params ∪ bound cell args) matches refetch. 200 cart
  lines, one update, one refetch.
- **`hydrate(value)` for parent loaders.** Sync write without firing
  the signal — solves the cascade-on-cold-load problem when a parent
  cell's loader populates child cells.
- **`gqlCellBuilder` / `gqlCell` via gql.tada.** Per-backend constructor
  mirroring the `graphql()` tag — quick-string mode (`q(\`query …\`)`)
  with the doc parsed by the bound tag, plus a doc-mode primitive. Wire
  id auto-derives from the operation name (kebab + optional prefix).
- **Typed `.with()` (item 1, shipped).** `gqlCell` returns
  `GqlCell<TResult, TVars>` narrowing `with(args: TVars)` from the query's
  inferred variables — verified with a `tsc` proof that inference threads
  through the builder closure.
- **`fragmentCell(doc, {key})` + auto-hydration (item 3, shipped).** The
  fragment doc carries the value type, derives the id (kebab of the
  fragment name), and is matched against query spreads. `key` defaults to
  `{ id: d.id }` (throws if no `id` and no `key`). When a query spreads a
  registered fragment, `runQuery` / `hydrateFragmentsFromResult` walks the
  result at each spread path and hydrates the keyed partitions.
- **Value-keyed `.set(value)` (item 4 primitive, shipped).** A cell's
  optional `keyOf(value)` derives the partition from the value itself;
  `cartItemCell.set(line)` routes to `key(line)`'s partition and fires
  `cell:<id>?<args>`, so a mutation that colocates `...Fragment` updates
  exactly one line with no restated id.

## What's still open

### 1. ~~Typed args~~ → shipped; residue: `localCell`

`gqlCell.with()` is typed (`GqlCell<TResult, TVars>`), value-keyed
`.set` is typed off the fragment value, and `fragmentCell`'s `key`
callback now receives `ResultOf<F>` (the opts are
`FragmentCellOpts<ResultOf<F>, V>`, so `key: (d) => ({uid: d.uid})`
type-checks unannotated). One residue remains: `localCell`'s
`.with()` / `.resolve()` args are still `Record<string, unknown>` (no
caller has needed them typed).

**Gotcha learned:** gql.tada does NOT validate a fragment's type condition
against the schema. `fragment X on CartItem` (a type that doesn't exist —
the real one is `CartItemInterface`) passes `tsc` and collapses
`ResultOf`/`FragmentOf` to `never`, then fails at runtime with
`Unknown type "CartItem"`. Always use the exact (interface) type name; for
abstract targets, supply an explicit value type + `@_unmask`.

### 2. Object / list cell shapes (we have `opaque`)

The shape catalog now includes `"opaque"` — accepts any value, no
runtime validation. Real object validation (`{object: {a: string,
b: number}}`, `{list: shape}`) would require building out a small
shape DSL that the framework can walk. Not urgent — `opaque` covers
the cart-line case and any other "trust the loader" pattern.

The CMS migration likely needs proper object shapes (nested
configs + slots with field-level validation). That's the trigger
for building this out.

### 3. ~~Fragment composition + relay-style auto-hydration~~ → shipped

Auto-hydration ships: the framework parses a query doc's fragment
spreads (`spreadSitesOf` → `{path, fragName, deferred}`), and for each
spread backed by a registered `fragmentCell`, walks the result at that
path and hydrates each node into its `key`-derived partition. Identity is
the cell's `key` (default `id`); the result walk handles intermediate
arrays. Wired through `runQuery` (gqlCell loaders + custom loaders) and
`hydrateFragmentsFromResult` (mutations).

Residue: matching is by AST path + fragment NAME, one level of nesting at
a time (lists of entities under a path). Deep/recursive normalisation
across many fragment types in one response is still future work — no
caller needs it yet.

### 4. Mutation result auto-write from action returns (primitive shipped)

The primitive — value-keyed `cell.set(value)` deriving its partition from
`keyOf(value)` — ships. Actions now call `cartItemCell.set(line)` with no
restated id; auto-hydration covers the other lines. What's still open is
the *declarative* layer that removes even the imperative `.set` call:

```ts
const updateLineMutation = gqlMutation({
  doc: graphql(`mutation UpdateLine($uid, $qty) { ... cartItem { ... } }`),
  writes: {
    "data.cartItem": (cartItem) => cartItemCell.with({ uid: cartItem.uid }),
  },
})
```

The framework reads `writes`, finds the corresponding field in the
mutation response, calls the bound cell's `.set()` with the field
value. Reduces action boilerplate; the transactional substrate
already exists (`atomic()` buffers cell writes and commits/discards
with the action), so the declarative layer is purely ergonomic.

Needs typed paths (`"data.cartItem"`) — gql.tada's response type can
drive this with a tagged-template path utility. Adjacent to (3); same
caller pressure.

### 5. Multi-tab / multi-viewer mutation propagation

Today, partition-scoped invalidation propagates within ONE process.
Connected clients on the SAME process re-render through the
heartbeat stream. Multiple processes / multiple users on the same
cart: a write in process A doesn't reach process B's clients.

Solutions:
- `BroadcastChannel` for same-origin tabs (filed in
  [`./IDEAS.md`](./IDEAS.md)).
- Pluggable invalidation backend (Redis pub/sub) for cross-process.

Independent of cells; affects the registry layer.

### 6. Eviction policy

`localCell` + `gqlCell` storage grows indefinitely until process
restart. For long-running production usage with N users × M
cart-items, this matters. Today's `CellStorage` adapter contract
doesn't have LRU/maxBytes/TTL eviction.

Eviction is a property of the adapter, not the cell primitive. A
Redis-backed adapter gets eviction for free. The default JSON-file
adapter could grow a TTL pass. Not urgent — even sloppy in-memory
storage handles tens of thousands of entries fine.

## Inspirations

- **Apollo typePolicies** — per-type config (key fields, merge
  functions, field policies). The direct precedent for what
  per-cell options end up looking like once real callers arrive.
- **Relay** — fragment colocation + normalised cache. The eventual
  destination if fragment composition (item 3) earns its place.

## Related

- [`../reference/cells.md`](../reference/cells.md) — the shipped
  user-facing surface (localCell, gqlCell, .with(), hydrate, etc.).
- [`../internals/cell-internals.md`](../internals/cell-internals.md)
  — wire shape, batcher, prop-bag resolution path.
- [`./cell-dimensionality.md`](./cell-dimensionality.md) — the
  orthogonal axis (inheritance walks inside one cell's storage).
- [`./IDEAS.md`](./IDEAS.md) — broader backlog; cross-tab sync,
  persist optimistic state, pattern-based invalidation.
