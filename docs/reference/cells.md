# Cells

A cell is a **typed, identity-keyed slot** of server-authoritative
state that crosses Flight to client components as a `ResolvedCell<T>`
prop. Clients read its `.value` and call `.set(v)`; the framework
fans the write back out to every parton that read it via the
parton's `schema` callback.

Use a cell when:

- The state isn't shareable (so it doesn't belong in a URL) but is
  authoritative on the server.
- The state should fan out across all viewers in its partition (a
  cell with `vary: ({session}) => ({sid: session.id})` reaches every
  tab the user has open).
- Multiple partons need to react to changes (cells auto-stamp
  `cell:<id>` on every reading parton's labels, so a `cell.set`
  refetches them all on the next render).

For internals (storage adapters, wire shape, batcher mechanics) see
[`../internals/cell-internals.md`](../internals/cell-internals.md).

## Two construction sites

Cells can live in two places:

- **Module-scope** — exported from a module, identified by an explicit
  `id`, partitioned by a `vary` callback over the request scope.
  Reach for this when the cell is shared across partons or doesn't
  belong to any one parton (palette, cart contents, maintenance flag,
  featured product).
- **Parton-scoped** — declared inline inside a parton's
  `schema({cell})` callback. Wire id auto-derives as
  `<partonId>/<schemaKey>`; partition derives from the parton's vary
  output (optionally narrowed via the descriptor's `vary`). Reach for
  this when the cell is owned by a specific parton (form fields,
  per-instance UI state, draft data).

Cross-tree sharing rule: if two unrelated partons need the cell, hoist
to module-scope. Scoped cells flow strictly *down* from the owning
parton via Render's prop bag.

## Surface

### Module-scope construction

```ts
import { cell } from "@parton/framework"

// "global" — single value cluster-wide
export const featured = cell.string({
  id: "featured",
  vary: () => ({}),
  initial: "none",
})

// "user" — per-session
export const palette = cell.enum(["light", "dark"] as const, {
  id: "palette",
  vary: ({ session }) => ({ sid: session.id }),
  initial: "dark",
})

// per-product
export const productNotes = cell.string({
  id: "product-notes",
  vary: ({ params }) => ({ productId: params.id }),
  initial: "",
})

// server-side write-pipeline transform — canonicalises every value
// before storage, regardless of what the client sent
export const cardName = cell.string({
  id: "card-name",
  vary: () => ({}),
  initial: "",
  write: (raw) => raw.toUpperCase().replace(/[^A-Z ]/g, "").slice(0, 26),
})
```

Shape catalog: `cell.string` / `cell.number` / `cell.boolean` /
`cell.enum(values, opts)`. The shape drives runtime validation on
writes — `__cellWrite(id, value)` rejects mismatched shapes before
storage.

The `id` is **required**. Explicit ids are stable across renames,
survive HMR, and identify the cell on the wire.

### Options

| Option | Notes |
|---|---|
| `id` | Wire identifier. Required. |
| `initial` | Default value when storage is empty. |
| `vary` | Optional. Sync callback `({url, pathname, search, cookies, headers, params, session, time}) => Record<string, unknown>`. Output hashes into the storage partition key — pick what scopes the cell ("global" = `() => ({})`, "per-session" = `({session}) => ({sid: session.id})`, per-anything else via `params` / `cookies` / `headers`). Omit for a single-partition cell. |
| `write` | Optional. Server-side `(T) => T`. Runs after `validate` and before storage on every write — the server's final say on the stored shape regardless of what the client sent (uppercase, trim, format, length cap, profanity filter). Throws roll back the batch. |

A `read` counterpart (server-side transform on every read) is
designed but not yet shipped — deferred until a caller needs the
split between stored canonical and display format.

### Parton-scoped construction

Declare the cell inline inside the parton's `schema` callback. The
framework injects a `{cell}` factory whose options omit `id` (auto-
derives) and whose `vary` narrows the parton's vary output rather
than taking a request scope.

```tsx
const ProductPage = parton(
  function ProductRender({ notes, sharedNotes, parent }) {
    return <NotesEditor notes={notes} shared={sharedNotes} />
  },
  {
    match: "/product/:id",
    vary: ({ params, search: { lang = "en" } }) => ({
      productId: params.id,
      locale: lang,
    }),
    schema: ({ cell }) => ({
      // Default: partitioned by the full parton vary (productId + locale)
      notes: cell.string({ initial: "" }),

      // Narrowed: shared across locales for the same product
      sharedNotes: cell.string({
        initial: "",
        vary: ({ productId }) => ({ productId }),
      }),
    }),
  },
)
```

Key properties:

- **Wire id**: `<partonId>/<schemaKey>` (auto-derived). For
  `ProductPage` with selector "product-page", the cells are
  `product-page/notes` and `product-page/sharedNotes`. Stable across
  renders + HMR as long as the parton id + schema key don't change.
- **Partition**: defaults to the parton's full vary output. Narrow
  with `vary: (partonVary) => subset` to share values across other
  dimensions. Can NOT expand beyond the parton's vary surface — fp-
  skip safety would break otherwise.
- **`set` binding**: the resolved cell's `set` is bound at parton
  resolution time with the partition baked. Client invocations from
  `useCell(scopedCell).set(v)` land on the right partition regardless
  of URL changes between render and call.
- **Schema mixing**: scoped descriptors and module-scope cell handles
  coexist in the same schema record. The framework detects each shape
  and resolves accordingly.

### Type-inference caveat (v2)

When a scoped cell narrows the parton's vary via `vary: ({foo}) =>
({foo})`, the cascading inference is currently weak — TypeScript
treats the cell's vary input as `object` rather than the parton's
actual vary return type. Cast at the destructure if you want named
keys:

```ts
schema: ({ cell }) => ({
  sharedNotes: cell.string({
    initial: "",
    vary: (pv) => ({ productId: (pv as { productId: string }).productId }),
  }),
})
```

The runtime behavior is correct — the partition is computed from the
narrowed return regardless. This is a typing limitation only.
Tightening this requires reshaping `PartialOptions<V>`'s generic to
propagate the parton's vary return through to schema's `cell`
factory — tracked as a follow-up.

### Reading in a parton's `schema`

```tsx
import { parton, type RenderArgs, type ResolvedCell } from "@parton/framework"
import { palette, productNotes } from "./state.ts"

const ProductHeader = parton(
  function ProductHeaderRender({ palette, notes, parent }: {
    palette: ResolvedCell<"light" | "dark">
    notes: ResolvedCell<string>
  } & RenderArgs) {
    return (
      <header data-palette={palette.value}>
        <NotesEditor notes={notes} />          {/* handle passes to client */}
      </header>
    )
  },
  {
    match: "/product/:id",
    schema: () => ({ palette, notes: productNotes }),
  },
)
```

`schema` is a sync callback returning a record. Each entry whose
value is a `Cell<T>` is resolved (own vary → partition key →
storage read) and the resolved `ResolvedCell<T>` (`{__cell, id,
value, set}`) is passed to `Render` in its place.

The resolved cell auto-stamps `cell:<id>` onto the parton's labels,
so any `cell.set` of that cell refetches every parton reading it.

### Resolution order per partial render

1. **match phase** — URLPattern gates rendering.
2. **vary phase** — sync callback against request scope; output participates in fp.
3. **schema phase** — for each cell handle:
   - Run `cell.vary(scope)` → partition key.
   - Storage read `(scope, cell.id, partitionKey)` → value (or `cell.defaultValue` on miss).
   - Build `ResolvedCell<T> = {id, value, set}` for Render.
   - Stamp `cell:<id>` onto the partial's labels.
4. **fp** = `id|matchKey|vary|schema=<cellHashes>|props|inv`. Changing any cell value OR navigating across cell partitions both shift fp.
5. **Render** runs with merged props.

The parton author does NOT need to redeclare cell-vary dimensions
in their own vary. A cell partitioned by `productId` makes the
parton's fp move on productId transitively, because resolving the
cell at fp time produces a different value per productId.

### Mutation — server side

```ts
import { palette } from "./state.ts"
import { runInvalidationTransaction } from "@parton/framework"

"use server"
export async function reset() {
  await runInvalidationTransaction(async () => {
    await palette.set("dark")
  })
}
```

`cell.set(v)` resolves the partition key from the **current request
scope** automatically. The action invocation request has URL +
cookies + headers; `cell.vary` runs against that scope.

Optional override for cross-context mutations:

```ts
await productNotes.set("New notes", { vary: { productId: "abc" } })
```

When the explicit `vary` override is supplied, `cell.vary` is
skipped and the override is used directly. Useful when an action
fired from `/cart` needs to update notes for a product not in the
current URL.

### Mutation — client side: `useCell` + `cell.input()`

The cell's `.set` (the server-action ref) works directly from a
client component for fire-and-forget mutations (one POST per call):

```tsx
"use client"
import type { ResolvedCell } from "@parton/framework"

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

`useCell(serverCell)` returns a `ClientCell` with:

| Field | Behaviour |
|---|---|
| `value: T` | **Optimistic-aware.** Latest local-set value while writes are queued or in flight; falls back to `serverValue` when everything has settled. Components can bind controlled inputs directly to `value` — no `useState`, no `useEffect`-based adoption. |
| `serverValue: T` | Always the server snapshot (same as `cell.value` from the prop). Use for "server says: …" panels alongside the optimistic `value`. |
| `set(value, opts?): Promise<void>` | Microtask-coalesced batched write. Multiple `set` calls in the same tick collapse into one `__cellWriteBatch` POST. At most one POST in flight per tab; new sets during in-flight accumulate and flush as the next batch. Writes always reach the server in strict send-order. |
| `input(opts?): {value, onChange, ref}` | Spread onto a controlled `<input>`. Handles value binding, onChange → transform → set, and caret restoration via an internal ref + `useLayoutEffect`. See below. |

### `cell.input()` — controlled-input binding

```tsx
"use client"
import { useCell } from "@parton/framework/lib/cell-client.tsx"

function CardholderField({ name }: { name: ResolvedCell<string> }) {
  const cell = useCell(name)
  return (
    <input
      {...cell.input({
        transform: (raw, caret) => {
          const value = raw.toUpperCase().replace(/[^A-Z ]/g, "")
          return { value, caret }
        },
        onCommit: (v) => { /* cross-cell trigger */ },
      })}
      data-testid="cardholder"
    />
  )
}
```

Options:

| Option | Behaviour |
|---|---|
| `mode?: 'onChange' \| 'onSubmit'` | Default `'onChange'`. `'onSubmit'` makes the input **uncontrolled**: bindings carry `defaultValue` (seeded from `cell.value`) + `ref` only — no `value` / `onChange` — so the DOM owns the input's state and **the hook does not re-render on every keystroke**. Harvest the current value at submit time via `cell.read()` (reads through the bound ref). See "Two write paths" below. |
| `transform?(raw, caret) => {value, caret}` | Per-keystroke transform. Author returns the value to display (= what we send to `cell.set`) and the new caret position. Without this, the input is uncontrolled-by-author and raw `event.target.value` flows straight to `cell.set` (server's `write` is the only canonicalisation). **`'onChange'` mode only.** |
| `onCommit?(value)` | Fired after the local transform and after `cell.set` has been enqueued. Use for cross-cell triggers — e.g. firing a derived cell's `set` whenever this input changes. **`'onChange'` mode only.** |

Returned bindings cover the entire input lifecycle for whichever
mode is active. The author spreads them onto the element; the
framework handles refs, layout effects, caret restoration, and the
batched set call. The `ref` is a callback that accepts either
`HTMLInputElement` or `HTMLTextAreaElement`, so the same bindings
work on both elements without a generic call signature.

### Two write paths — `'onChange'` vs `'onSubmit'`

The mode flag distinguishes two patterns that previously needed
hand-rolled `useState` plumbing:

- **`mode: 'onChange'`** — controlled. The cell is the source of
  truth, every keystroke commits via the batcher. The bound input's
  `.value` is optimistic-aware, so display is local-first while the
  write is in flight. Use for autosave-on-type, draft fields that
  persist across reloads, cross-tab broadcast state.

- **`mode: 'onSubmit'`** — uncontrolled. The cell seeds the input's
  `defaultValue` on first mount; further user edits live in DOM
  state alone — no hook re-renders, no React state. The cell does
  NOT update during typing. Read the current value at submit time via
  `cell.read()`:

  ```tsx
  const name = useCell(cardName)
  const nameInput = name.input({ mode: "onSubmit" })
  // ...
  <input {...nameInput} />
  // Later:
  await save({ cardName: name.read() })
  ```

  `read()` returns the DOM `<input>`'s `value` via the hook-owned
  ref (or falls back to `cell.value` when no input is mounted). The
  action's auto-write commits the value atomically.

The two modes coexist on the same form. The `/forms-demo` example
combines them: a `notes` textarea in `'onChange'` mode (every
keystroke persists) and two card fields in `'onSubmit'` mode
(committed via a `save` action that demonstrates transactional
rollback on failure).

The shape parallels react-hook-form's
[`register()`](https://react-hook-form.com/docs/useform/register) —
worth comparing API surfaces before extending `CellInputOpts`
ad-hoc. See the "Future research" section in
[`../notes/IDEAS.md`](../notes/IDEAS.md).

## Controlled-input discipline (four rules)

Cells driven by a controlled input (text field, slider, drag handle)
need four rules together, otherwise rapid-fire typing produces
visible jank or out-of-order writes. **`useCell` + `cell.input()`
implement all four — author code gets them for free.**

1. **Display is local-first.** `cell.value` is optimistic-aware:
   latest local-set value while writes are queued or in flight,
   falls back to server-authoritative when settled. An optional
   `transform` fn runs per keystroke. The display never waits on a
   server round-trip to advance to the next character.
2. **Single in-flight + accumulate-pending.** Every `cell.set`
   enqueues into the framework's microtask-coalesced batcher. At
   most one `__cellWriteBatch` POST in flight per tab; new
   enqueues during in-flight accumulate and flush as the next
   batch when the current resolves. Writes hit the server in
   strict send-order — no write-write race.
3. **Caret restoration via `useLayoutEffect`.** Owned by the hook.
   The transform returns `{value, caret}`; the hook stashes the
   caret in a ref and restores via `setSelectionRange` after React
   commits.
4. **Safe-moment adoption.** Implicit. The optimistic value clears
   when the last pending write for the cell drains, so the next
   render flips `value` to the server-authoritative shape (the
   reconcile moment). During a typing burst the optimistic value
   stays pinned to the user's input — no mid-burst clobber by
   construction.

Discrete-event cells (a "favorite" toggle, "add to cart") don't
need the discipline — plain `cell.set(v)` is fine. Each call is
atomic, no caret to preserve, no in-progress input to clobber.

## Storage

v1 ships with **JSON file storage** at `cms/data/cells.json`,
mirroring the CMS storage pattern. Pluggable via
`setCellStorage(backend)`. See
[`../internals/cell-internals.md`](../internals/cell-internals.md)
for the disk shape, the in-memory cache, per-scope bucketing,
debounced flushes, and the pluggable adapter contract.

## Examples table

| What | Cell vary |
|---|---|
| Featured product banner (admin-set) | `() => ({})` |
| Maintenance mode flag | `() => ({})` |
| Site-wide announcement text | `() => ({})` |
| User palette / locale | `({session}) => ({sid: session.id})` |
| Wishlist | `({session}) => ({sid: session.id})` |
| Cart contents (logged-in user) | `({session}) => ({sid: session.id})` |
| Multi-step checkout draft | `({session}) => ({sid: session.id})` |
| Recent searches | `({session}) => ({sid: session.id})` |
| A/B test bucket | `({session}) => ({sid: session.id})` |
| Like state for blog post | `({session, params}) => ({sid: session.id, postId: params.id})` |
| Add-to-cart form draft per product | `({session, params}) => ({sid: session.id, productId: params.id})` |
| Comment count for post | `({params}) => ({postId: params.id})` |
| Admin price override for SKU | `({params}) => ({sku: params.sku})` |
| Cart for anonymous user | `({cookies}) => ({cartId: cookies.cart_id})` |

What's NOT a cell:

- Drawer / modal open/closed → frame URL or URL search.
- PDP variant selection → URL search (`?variant=red`), shareable.
- PLP filters → URL search.
- Currently-typing-into-textarea state → bind to `useCell(cell).value`
  and call `cell.set(v)` on every keystroke; the framework's
  microtask-coalesced batcher handles the wire side.
- Anything sharable that fits a URL → URL, not a cell.

## Composition with existing primitives

- **vary** — unchanged. Pure request-dimensions. Cell reads do NOT
  happen inside vary; that's what `schema` is for.
- **selector** — cells auto-stamp `cell:<id>` on the spec's labels.
  Authors can declare additional labels via `selector:` as before.
- **invalidation registry** — `cell.set(v)` calls
  `refreshSelector("cell:" + id)` inside a transaction. fp folding
  reuses today's `queryMatchingTs(labels, varyInputs)` against the
  expanded label set.
- **CMS reads** — `block.schema({cms})` already exists. Cell reads
  live on the parton's `schema()` callback (no `{cms}` argument);
  the two are parallel surfaces with the same shape.

## Related

- [`../internals/cell-internals.md`](../internals/cell-internals.md)
  — storage backends, wire shape, batcher mechanics, nested-tx
  batching, debug hooks.
- [`../notes/replicated-state.md`](../notes/replicated-state.md) —
  the broader Unreal-actor-shaped state model. Cells are the
  narrow "single typed value, mutate-and-invalidate" lane.
- [`../archive/transient-client-state.md`](../archive/transient-client-state.md)
  — original design exploration that produced cells. Archived
  2026-05-21. Directions C (per-tab session) and D (`<PartialForm>`)
  carry forward as backlog items in
  [`../notes/IDEAS.md`](../notes/IDEAS.md).
- [`./partial.md`](./partial.md) — the `parton` constructor surface
  that `schema` extends.
- [`./cms.md`](./cms.md) — block.schema, the existing template for
  the schema callback shape.
