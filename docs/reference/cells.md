# Cells

A cell is a **typed, identity-keyed slot** of server-authoritative
state that crosses Flight to client components as a `ResolvedCell<T>`
prop. Clients read its `.value` and call `.set(v)`; the framework
fans the write back out to every parton that read it via the
parton's `schema` callback or via JSX prop binding.

Three constructors today, each backed by a different storage tier:

| Constructor | Storage | Loader | Use case |
|---|---|---|---|
| `localCell({...})` | **Persistent** — disk-backed (`cms/data/cells.json`). Survives process restart. | Optional. | User preferences, editor toggles, form drafts. State you actually want to keep. |
| `gqlCellBuilder({client, graphql})` → `q.query(\`query …\`)` | **Ephemeral, request-scoped** — fresh in-memory storage per request, discarded on request finish. | Always (typed GraphQL query). | Upstream-loaded entity reads — cart, product details, user data. |
| `q.fragment(\`fragment …\`, {key?})` | **Ephemeral, request-scoped** — same as gqlCell. | Never. | Identity-keyed sub-entities populated by auto-hydration (a query that composes the fragment) or value-keyed `.set()`. |

`gqlCellBuilder` mirrors the gql.tada `graphql()` tag — bind the client +
tag once, then `q.query(\`…\`)` / `q.fragment(\`…\`)` build cells from
strings (the raw `graphql()` call stays hidden). `gqlCell(client, doc)` is
the lower-level doc-mode form. All auto-derive the wire id from the
operation/fragment name.

All three implement the same `Cell<T>` interface — Render code
doesn't know which backend produced the value.

**Why connection-scoped for ephemeral?** Each HTTP connection gets
its own in-memory cache for the duration of its ALS request context
— including all segments a streaming heartbeat emits, because the
segment driver loops inside one `runWithRequestAsync` scope. Short
POSTs (mutations) and cold GETs each get their own short-lived
storage; long heartbeats hold their storage for the connection's
lifetime. No leakage between connections (different tabs, different
users). Cross-connection caching (when we eventually want it) is a
separate layer added on top, not a default.

**Custom storage on localCell:** pass `storage: getEphemeralCellStorage`
to opt a localCell into request-scoped storage (useful when you want
a custom loader with side effects, like the cart loader that
hydrates child cells). Or pass any `CellStorage` adapter for Redis,
S3, etc.

Use a cell when:

- The state isn't shareable (so it doesn't belong in a URL) but is
  authoritative on the server.
- The state should fan out across all viewers in its partition (a
  cell with `vary: ({session}) => ({sid: session.id})` reaches every
  tab the user has open).
- Multiple partons need to react to changes (cells auto-stamp
  `cell:<id>` on every reading parton's labels, so a `cell.set`
  refetches matching placements on the next render).

For internals (storage adapters, wire shape, batcher mechanics) see
[`../internals/cell-internals.md`](../internals/cell-internals.md).

## Partition axes

A cell's storage is keyed by `(id, partitionKey)` where partitionKey
hashes the cell's **args** for this render. Args come from two
sources:

- **`vary` callback** on the cell — derives args from the request
  scope (`session`, `cookies`, `headers`, `params`, etc.). Sync,
  runs per-render. For request-derived partitioning (palette by
  session, notes by URL param).
- **`.with(args)` at the call site** — author binds explicit args
  when placing a cell handle into a parton's schema or as a JSX
  prop. For placement-derived partitioning (cart line by item id).

Both can compose: a cell with `vary` *and* `.with()` ends up with
merged args. Vary's output forms the base; `.with()` overlays.

## Three placement patterns

### 1. Module-scope cell, declared in schema

For cells where the partition is fully derived from request scope:

```ts
import { localCell, parton, type RenderArgs, type ResolvedCell } from "@parton/framework"

export const palette = localCell({
  id: "palette",
  shape: { enum: ["light", "dark"] as const },
  vary: ({ session }) => ({ sid: session.id }),
  initial: "dark",
})

const ProductHeader = parton(
  function Render({ palette }: { palette: ResolvedCell<"light" | "dark"> } & RenderArgs) {
    return <header data-palette={palette.value}>...</header>
  },
  { schema: () => ({ palette }) },
)
```

The framework resolves `palette` against the request, passes
`ResolvedCell<...>` to Render via `palette` prop.

### 2. Parton-scoped cell, declared inline in schema

For cells owned by a specific parton, partitioned by the parton's
vary output:

```tsx
const ProductPage = parton(
  function Render({ notes, parent }) {
    return <NotesEditor notes={notes} />
  },
  {
    match: "/product/:id",
    vary: ({ params }) => ({ productId: params.id }),
    schema: ({ localCell }) => ({
      notes: localCell({ shape: "string", initial: "" }),
    }),
  },
)
```

Wire id auto-derives as `<partonId>/<schemaKey>` (e.g.
`product-page/notes`). Partition is the parton's vary output by
default; narrow via `vary: (partonVary) => subset` on the descriptor.

### 3. Placement-bound cell, passed as a JSX prop

For per-instance addressability — the new shape that enables
fine-grained refetch:

```tsx
const cartItemCell = localCell({
  id: "cart-item",
  shape: "opaque",
  initial: null as CartItem | null,
})

// Parent renders many lines, each bound to a specific itemId:
function CartRender({ cart, parent }) {
  return cart.value.itemIds.map((uid) => (
    <CartLine key={uid} parent={parent} item={cartItemCell.with({ uid })} />
  ))
}

// Child reads the bound cell from its prop bag:
const CartLine = parton(
  function Render({ item }: { item: ResolvedCell<CartItem | null> } & RenderArgs) {
    return <Line {...item.value} />
  },
  { selector: "cart-line" },
)
```

`cellHandle.with(args)` returns a `BoundCell<T>` descriptor. When the
framework sees a `BoundCell` in a parton's top-level JSX props, it:

1. Resolves the cell's value at the bound partition (running the
   loader if present and storage is cold).
2. Replaces the `BoundCell` with a `ResolvedCell<T>` in the prop bag.
3. Stamps `cell:<id>` onto the parton's invalidation labels.
4. Merges the bound args into the parton's effective constraint
   surface — so partition-scoped writes (`cell:<id>?<args>`) only
   refetch placements whose bound args match.

The result: 200 `<CartLine>` placements, one quantity update via
`cartItemCell.with({uid: "X"}).set(...)` → only that one placement
refetches. The others stay put.

## Surface — `localCell`

```ts
const palette = localCell({
  id: "palette",
  shape: { enum: ["light", "dark"] as const },
  vary: ({ session }) => ({ sid: session.id }),
  initial: "dark",
})

const cartItemCell = localCell({
  id: "cart-item",
  shape: "opaque",
  initial: null as CartItem | null,
  // no `vary` — partition entirely from `.with()` at placement sites
})

const cardName = localCell({
  id: "card-name",
  shape: "string",
  vary: () => ({}),
  initial: "",
  // server-side canonicalisation: every write runs through this
  write: (raw) => raw.toUpperCase().replace(/[^A-Z ]/g, "").slice(0, 26),
})
```

### Options

| Option | Notes |
|---|---|
| `id` | Wire identifier. Required. |
| `shape` | Runtime shape. `"string"` / `"number"` / `"boolean"` / `"opaque"` / `{enum: [...] as const}`. `"opaque"` accepts any value without validation — author owns the TS type. |
| `initial` | Default value when storage is empty and no loader is configured. |
| `vary` | Optional. `(scope) => CellArgs`. Output hashes into the partition key. Omit for a cell whose partition comes entirely from `.with()`. |
| `load` | Optional async `(args) => T`. Runs on cold-start (storage miss) — result is validated, written to storage, then returned. Storage stays the source of truth thereafter. |
| `write` | Optional `(T) => T`. Server-side canonicalisation. Runs after `validate` and before storage on every write. |
| `deferred` | Optional `boolean`. When set, a write to this cell makes the action POST return **no re-render** — the new value propagates only over the open streaming connection. See [Deferred (stream-only) writes](#deferred-stream-only-writes). |

## Surface — `gqlCellBuilder`

`gqlCellBuilder` is the per-backend constructor — the gqlCell analogue
of the `graphql()` tag. Bind the client + tag once (plus an optional id
`prefix`); it returns `{ query, fragment }`, which build cells straight
from strings — the raw `graphql()` call is hidden at every site.

```ts
import { gqlCellBuilder } from "@parton/framework"
import { client } from "../data.ts"
import { graphql } from "../pokeapi-graphql.ts"

const pokemon = gqlCellBuilder({ client, graphql })

export const heroCell = pokemon.query(`
  query PokemonHero($id: Int!) {
    pokemon_v2_pokemon(where: { id: { _eq: $id } }, limit: 1) { id name }
  }
`)                                     // wire id auto-derives → "pokemon-hero"

// Namespaced ids for a second backend:
const magento = gqlCellBuilder({ client, graphql, prefix: "magento" })
export const productsCell = magento.query(`query Products($pageSize: Int!) {…}`)
                                          // wire id → "magento.products"
```

The **wire id auto-derives from the operation name** (kebab-cased,
optionally `prefix`-namespaced); pass `{ id }` to override, or name the
operation (anonymous operations throw). `.with(args)` is typed from the
query's variables, and the result type flows to `ResolvedCell<T>`.

When you already hold a typed document (e.g. to also export its
`ResultOf` type), use the doc-mode primitive `gqlCell(client, doc, {id?,
prefix?})` — same auto-id + typed handle.

## Surface — `q.fragment`

`q.fragment(source, { key })` builds a fragment cell from a fragment
string (the `graphql()` call is hidden). It's typed by — and **keyed
off** — the fragment: the value type is inferred, the wire id derives
from the fragment name, and the framework matches the fragment's spreads
in queries for **auto-hydration**.

```ts
const magento = gqlCellBuilder({ client, graphql, prefix: "magento" })

export const cartItemCell = magento.fragment(
  `fragment CartLine on CartItemInterface { uid quantity product { sku } }`,
  { key: (d) => ({ uid: d.uid }) },   // CartItemInterface has no `id`
)                                      // wire id → "magento.cart-line"
```

A **query composes a fragment by passing its cell** — never the raw doc:

```ts
export const cartCell = magento.query(
  `query Cart($cartId: String!) { cart(cart_id: $cartId) { items { uid ...CartLine } … } }`,
  [cartItemCell],   // the CELL; q.query extracts its .fragment for composition
)
```

| Option | Notes |
|---|---|
| `key` | Identity extractor `(data) => CellArgs`. **Defaults to `(d) => ({ id: d.id })`** when the fragment selects `id`; the cell throws at construction if no `id` is selected and no `key` is given. The same key drives `.with(...)` placement AND value-keyed `.set(value)`. (`data` is typed via the standalone `fragmentCell(graphql(...), {key})`; `any` in the `q.fragment` string form.) |
| `id` | Override the auto-derived id. |
| `initial` | Value before any hydration (default `null`). |

Three ways a fragment cell gets populated:

1. **Auto-hydration** — when a query composes this fragment's cell (or a
   custom loader uses `runQuery`), every matching result node is hydrated
   into its keyed partition automatically. No manual loop.
2. **Value-keyed `.set(value)`** — `cartItemCell.set(line)` reads the
   partition straight off the value via `key`, so a mutation that
   colocates `...CartLine` writes the right line with no restated id, and
   only the matching `<CartLine>` placement refetches.
3. **Explicit `.with(args).hydrate(value)`** — for parent loaders that
   populate children before they render (no signal).

> **Fragments on abstract types.** gql.tada does NOT validate a fragment's
> type condition against the schema — a wrong type (`on CartItem` instead
> of `on CartItemInterface`) passes `tsc` but fails at runtime, and
> collapses `ResultOf`/`FragmentOf` to `never`. Use the exact interface
> name; author the fragment with `@_unmask` so its query/mutation spread
> sites stay readable.

### Result → cells

When a query composes a fragment cell, its result is **rewritten so each
spread location holds that cell's `BoundCell`** — the loader hydrates each
matching node into its keyed partition AND replaces it in-place with the
bound cell. The consumer forwards those cells straight to children; there
is no manual `.with({ uid })` re-keying:

```tsx
// The host parton reads its own cart cell in `schema` and forwards each
// per-line BoundCell. Type the prop off the cell with CellValue — no
// hand-written alias:
function MagentoCartRender({
  cart,
  parent,
}: { cart: ResolvedCell<CellValue<typeof cartCell>> } & RenderArgs) {
  // cart.value.cart.items is BoundCell<…>[] — forward directly:
  return cart.value?.cart.items.map((line) => <CartLine item={line} parent={parent} />)
}
```

The cell's value type reflects this via `RewriteSpreads<ResultOf<doc>,
cells>`: spread sites become `BoundCell<V>`, everything else (scalars,
non-fragment objects like `prices`) is untouched. `CellValue<typeof
cartCell>` surfaces that whole value type for the Render prop, so you
never restate it. Because the rewritten value isn't the raw result,
**mutations refresh such a cell with `.invalidate()`** (re-run the loader
+ rewrite), not `.set(raw)`.

### Auto-hydration via `runQuery`

A custom loader (e.g. a `localCell` that computes an aggregate) gets
auto-hydration by running its query through `runQuery`:

```ts
load: async ({ cartId }) => {
  const data = await runQuery(client, CartWithItemsQuery, { cartId })
  return cartAggregate(data.cart)   // per-line cells already hydrated
}
```

## Bound cells — mutation surface

`cellHandle.with(args)` returns a `BoundCell<T>` carrying:

| Method | Behaviour |
|---|---|
| `set(value)` | Write storage at this partition, fire `cell:<id>?<args>`. |
| `update(updater)` | Read current value (running loader on miss), apply `updater(current) => next`, write back. |
| `clear()` | Reset storage to `defaultValue`, fire partition-scoped invalidation. |
| `invalidate()` | Fire `cell:<id>?<args>` WITHOUT touching storage. Forces matching placements to re-resolve. |
| `hydrate(value)` | Sync write to storage with NO signal. Used by parent loaders to populate child cells on cold load. |

`set` / `update` / `clear` / `invalidate` are server-action refs —
Flight-serializable, callable from client components.

The cell-write path emits **partition-scoped selectors**:
`cell:<id>?<key>=<value>&<key>=<value>`. Only partons whose effective
constraint surface (vary output ∪ bound args) contains a matching
subset get invalidated.

## Reading patterns

### In schema

Schema callbacks return a record of cell handles / scoped
descriptors / `BoundCell`s. The framework resolves each entry into a
`ResolvedCell<T>` and passes it to Render via the prop bag.

The callback's **2nd argument is the parton's `vary` output** — so one
parton can derive a partition from the request and bind+read its own
cell, no binder/reader split:

```ts
const Cart = parton(
  function Render({ cart, parent }) {
    // cart.value.cart.items are per-line BoundCells (result → cells):
    return cart.value?.cart.items.map((line) => (
      <CartLine key={String(line.args.uid)} parent={parent} item={line} />
    ))
  },
  {
    match: "/cart",
    // cart_id cookie → the cart cell's partition.
    vary: ({ cookies }) => ({ cartId: cookies.cart_id ?? "" }),
    // 2nd arg is the vary output. The options generic widens it to
    // `object` (TS can't thread a sibling `vary`'s return into this
    // position), so narrow with a cast to bind `.with`.
    schema: (_f, vary) => ({ cart: cartCell.with(vary as { cartId: string }) }),
  },
)
```

### As a JSX prop

Top-level JSX props that are `CellInterface<T>` or `BoundCell<T>` are
auto-resolved before Render runs. Pass a `BoundCell` from a parent to a
child parton:

```tsx
<CartLine parent={parent} item={cartItemCell.with({ uid })} />
```

The child's Render receives `item` as a `ResolvedCell<T>`. The
child's labels include `cell:<id>` automatically.

**Scope:** only top-level JSX props are walked. Nested cells inside
object props are NOT auto-resolved — if you want a cell to be
framework-tracked, pass it as its own top-level prop.

### Server-side via `cell.peek()`

`peek()` is a sync server-side read at the partition derived from
the cell's own `vary` against the active request. Returns
`defaultValue` on miss. Does NOT trigger the loader. Useful inside
actions or vary callbacks.

```ts
const showAdvanced = palette.peek() === "dark"
```

## Resolution order per partial render

1. **match phase** — URLPattern gates rendering.
2. **vary phase** — sync callback against request scope; output participates in fp.
3. **schema phase** — for each cell handle:
   - Module cell: run `cell.vary(scope)` → args; resolve via storage (or loader on miss); build `ResolvedCell`.
   - Scoped descriptor: finalize → run descriptor's vary against partonVary → args; resolve.
   - Bound cell: use baked args; resolve.
   - Stamp `cell:<id>` onto labels; merge args into constraint surface.
4. **props phase** — walk top-level JSX props for Cell / BoundCell:
   - Resolve each; replace prop with `ResolvedCell`.
   - Stamp label; merge args.
5. **fp** = `id|matchKey|vary|schema=<cellHashes>|props|inv`. `inv` folds the latest `queryMatchingTs(labels, vary ∪ args)` — partition-scoped invalidations move fp only for matching placements.
6. **Render** runs with the merged prop bag.

## Mutation patterns

### Direct write — `cell.set(value, opts?)`

For module-scope cells where partition is fully derived from request scope:

```ts
"use server"
import { palette } from "./state.ts"

export async function reset() {
  await palette.set("dark") // partition from palette.vary(currentRequest)
}
```

Optional `opts.vary` overrides the cell's own vary for cross-context
mutations:

```ts
await productNotes.set("New notes", { vary: { productId: "abc" } })
```

### Bound write — `cell.with(args).set(value)`

For placement-derived partitions:

```ts
"use server"
async function updateLineQty(uid: string, qty: number) {
  const r = await magento.updateCartItem({ uid, qty })
  await cartItemCell.with({ uid }).set(r.updatedItem)
}
```

The selector `cell:cart-item?uid=<uid>` fires; only the matching
`<CartLine item={cartItemCell.with({uid})}>` placement refetches.

### Hydration in parent loaders — auto vs. manual

When a parent cell's loader returns nested data, the per-line cells are
populated by **auto-hydration**: run the query through `runQuery` and any
`...Fragment` spread backed by a `fragmentCell` is hydrated into its keyed
partition (no signals — the children haven't rendered yet). The aggregate
loader just returns the aggregate:

```ts
export const cartCell = localCell({
  id: "cart",
  shape: "opaque",
  vary: ({ cookies }) => ({ cartId: cookies.cart_id }),
  initial: null as CartValue | null,
  storage: getEphemeralCellStorage,
  load: async ({ cartId }) => {
    const data = await runQuery(client, CartWithItemsQuery, { cartId })
    return cartAggregate(data.cart)   // per-line cells already hydrated
  },
})
```

Reach for the manual `cellHandle.with(args).hydrate(value)` only outside
the auto-hydration path — e.g. to clear a removed line's slot
(`cartItemCell.with({ uid }).hydrate(null)`).

### Client-side via `useCell`

`useCell(resolvedCell)` returns a `ClientCell` with optimistic-aware
`.value`, microtask-batched `set`, and controlled-input bindings.
See [`./useCell` section below](#client-side-mutation) — unchanged from
prior versions.

## Deferred (stream-only) writes

A normal cell write commits on the action POST: the server re-renders,
the new bytes come back on the POST response, and the client reconciles
them. For high-frequency, last-write-wins broadcast state — cursor
position, scroll offset, presence — that round-trip is wasted work. The
writer is already painting locally, every viewer (the writer included)
is going to catch up over the open streaming connection anyway, and
committing the POST's re-render back over the optimistic value just
costs a render and a reconcile per keystroke.

`deferred: true` removes it:

```ts
export const cursor = localCell({
  id: "cursor",
  shape: "opaque",
  vary: () => ({}),                 // global — one shared partition
  initial: { x: 0, y: 0 } as { x: number; y: number },
  deferred: true,
})
```

A write to a deferred cell still validates, still writes storage, and
still fires its partition-scoped `cell:<id>` bump — so every parton
reading it re-renders on the next stream segment exactly as usual. What
changes is the **action POST response**: when every write in a request
was to a deferred cell, the framework omits the response root (no
re-render on the POST), and the client skips committing it. The bump
reaches the page only through the already-open
[`<LivePageHeartbeat>`](../internals/streaming.md) connection.

The up-channel is the regular `cell.set` POST (fire it as fast as you
like — `useCell(cell).set` is single-inflight + replace-coalesce, so it
self-throttles to one round-trip at a time and only ever sends the
latest value); the down-channel is the heartbeat stream that propagates
to every viewer. Fire up, stream down.

Constraints and edges:

- **Storage must be visible across connections.** The write POST and a
  viewer's heartbeat are different connections. Default `localCell`
  storage is process-global (and in-memory for non-default test
  scopes), so it broadcasts. **Do not** pair `deferred` with
  `getEphemeralCellStorage` — that storage is request-scoped, so the
  write would be invisible to every other connection's heartbeat.
- **Mixed batches still render.** If one action writes both a deferred
  and a non-deferred cell, the response renders normally — the
  non-deferred cell needs the POST commit. `deferred` only suppresses
  the render when *every* write in the request was deferred.
- **No POST-time reconciliation.** The writer's own view updates from
  local state (e.g. pointer events) or via the stream a beat later, not
  from the POST. Don't bind a control to a deferred cell's
  `serverValue` expecting the action response to reconcile it — for
  that, use a normal (non-deferred) cell.
- **Requires the heartbeat.** With no open streaming connection (the
  heartbeat off, or a page that never mounts one), a deferred write
  lands on the server but nothing on the page moves. Deferred state is
  a live-updates feature.

**Multiplayer presence (every viewer's cursor).** The single-value
example above reacts to *one* shared cursor. To show *all* viewers'
cursors, hold the whole set in **one map cell keyed by viewer id** —
`Record<viewerId, {x, y, …}>` — and merge your own entry on write
(read-modify-write in the action). A map, not one partition per viewer,
because cells are point-read by partition and the set of partitions
isn't enumerable, so a viewer can't "read every cursor partition." Each
viewer writes its key; every viewer renders the whole map off the
heartbeat. The e2e-testing app's `/cursors` page is a worked two-tab
example (`pages/cursors-state.ts`, `cursors-actions.ts`,
`components/cursor-layer.tsx`).

See [`../internals/streaming.md`](../internals/streaming.md) §
"Deferred (stream-only) writes" for the wire mechanics (the null-root
action response and the client's skip-commit guard).

## Controlled-input discipline (four rules)

See [`useCell` section](#client-side-mutation) — same as before.
Cells driven by a controlled input use `useCell(cell).input(opts)`
to get the four behaviours (display-local-first, single-inflight
batch, caret restoration, safe-moment adoption) for free.

## Client-side mutation

```tsx
"use client"
import { useCell } from "@parton/framework/lib/cell-client.tsx"

export function PaletteToggle({ palette }: { palette: ResolvedCell<"light" | "dark"> }) {
  return (
    <button onClick={() => palette.set(palette.value === "dark" ? "light" : "dark")}>
      {palette.value}
    </button>
  )
}
```

For controlled inputs and rapid-fire writes, reach for **`useCell`**:

```tsx
"use client"
import { useCell } from "@parton/framework/lib/cell-client.tsx"

export function MessageField({ message }: { message: ResolvedCell<string> }) {
  const m = useCell(message)
  return (
    <>
      <input value={m.value} onChange={(e) => m.set(e.target.value)} />
      <div>server says: {m.serverValue}</div>
    </>
  )
}
```

See [`../internals/cell-internals.md`](../internals/cell-internals.md)
for the client-side batcher, optimistic value tracking, and the
`cell.input()` controlled-input binding.

## Examples table

| What | Pattern |
|---|---|
| Featured product banner (admin-set) | `localCell({vary: () => ({}), ...})` |
| User palette / locale | `localCell({vary: ({session}) => ({sid: session.id}), ...})` |
| Cart contents (per session) | `localCell({vary: ({cookies}) => ({cartId: cookies.cart_id}), ...})` |
| Per cart-line | `cartItemCell.with({uid})` — placement-bound |
| GraphQL-loaded product | `magentoQuery(\`query Product($sku){...}\`).with({sku})` |
| Per-line entity, auto-hydrated + value-keyed set | `fragmentCell(LineFragment, {key: d => ({uid: d.uid})})` |
| Add-to-cart form draft per product | `localCell({vary: ({session, params}) => ({sid, productId}), ...})` |

What's NOT a cell:

- Drawer / modal open/closed → frame URL or URL search.
- PDP variant selection → URL search (shareable).
- Anything sharable that fits a URL → URL, not a cell.

## Composition with existing primitives

- **vary** — unchanged. Pure request-dimensions on parton specs.
  Cells have their own `vary` callback (same shape, different role —
  storage partition key vs parton fp).
- **selector** — cells auto-stamp `cell:<id>` on the parton's
  labels. Partition-scoped writes emit `cell:<id>?<args>`.
- **invalidation registry** — `cell.set` calls
  `refreshSelector("cell:" + id + "?" + args)` inside a transaction;
  fp folding reuses `queryMatchingTs(labels, varyInputs ∪ boundArgs)`.

## Related

- [`../internals/cell-internals.md`](../internals/cell-internals.md)
  — storage backends, wire shape, batcher mechanics, prop-bag
  resolution path, partition-scoped selector encoding.
- [`../notes/cells-as-resolvers.md`](../notes/cells-as-resolvers.md)
  — the design conversation behind this surface; resolved questions
  + open ones.
- [`../notes/cell-dimensionality.md`](../notes/cell-dimensionality.md)
  — separate axis: inheritance walks within a single cell's storage
  (translations, draft/published, time/history). Deferred.
- [`./partial.md`](./partial.md) — the `parton` constructor that
  hosts schema + props.
- [`./cms.md`](./cms.md) — block.schema, the existing template for
  the schema callback shape.
