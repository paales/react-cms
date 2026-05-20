# Cells

> Live design doc. Captured 2026-05-19 from a design conversation
> arriving at a typed, identity-keyed, multi-realm replacement for
> the `session.string('name')` + `setSessionValue(name, v)` pair.
> First in-tree caller: `streaming-demo` (was `streaming-demo-state.ts`
> + `streaming-demo-actions.ts`).

## Premise

A cell is a **typed, identity-keyed slot** of server-authoritative
state that:

1. Has a **default value** and a **shape** (string / number / boolean
   / enum), declared once at module scope.
2. Partitions its storage by an **own `vary` callback** — sync,
   request-scoped, same shape as a parton's `vary`. Realms ("user",
   "global", "tab", per-product, per-(user × product)) fall out
   naturally from the partition you pick.
3. Is **read** by parton specs through a new `schema` option — the
   parton declares which cells it depends on; the framework
   resolves them and folds the resolved values into the parton's
   fingerprint.
4. Is **mutated** through `cell.set(v)`, available identically on
   server (sync, direct write) and client (Flight-serialized
   server-action ref). Mutation fans out via the existing
   invalidation registry — `refreshSelector("cell:<id>")` shifts
   every parton's fp that reads the cell.

Cells are **not** a state manager. They are a typed access surface
over the same storage classification the framework already
acknowledges (per-user session, per-cookie scope, durable per-key),
absorbing the boilerplate that today shows up as scoped Maps + ad
hoc selectors + per-feature server-action files.

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
export const palette = cell.enum(["light", "dark"], {
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

// per-(user × product)
export const productFavorite = cell.boolean({
  id: "product-favorite",
  vary: ({ session, params }) => ({
    sid: session.id,
    productId: params.id,
  }),
  initial: false,
})
```

Shape catalog for v1: `cell.string` / `cell.number` / `cell.boolean`
/ `cell.enum(values, opts)`. The shape determines runtime validation
on client writes (`__cellWrite(id, value)` rejects mismatched
shapes before storage).

The `id` is **required** in v1 — explicit ids are stable across
renames + survive HMR + identify the cell on the wire. A Vite
plugin to auto-derive ids from `(module-path, export-name)` is a
follow-up; not in this PR.

### Reading in a parton's `schema`

```ts
import { parton, type RenderArgs } from "@parton/framework"
import { palette, productNotes } from "./state.ts"

const ProductHeader = parton(
  function ProductHeaderRender({ palette, notes, parent }) {
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

`schema` is a sync callback returning a record. Each entry can be:

- A **cell handle** — framework runs `cell.vary(scope)`, looks up
  storage by `(cell.id, hash(cellVaryOutput))`, resolves to a
  per-render `ResolvedCell<T>` that Render receives.
- (Later, when block.schema unifies) a `cms.text()` / `cms.enum()`
  marker — framework resolves via the CMS surface.

`schema` runs **alongside** `vary`. `vary` is request-dimensions
only (URL bits, cookies, headers); `schema` is declared deps that
need framework-mediated resolution.

### Resolution order per partial render

1. **match phase** — URLPattern gates rendering.
2. **vary phase** — sync callback against request scope; output
   participates in fp.
3. **schema phase** — sync callback returns a record; framework
   walks it, for each cell:
   - Run `cell.vary(scope)` against the same request scope →
     `partitionKey = hash(cellVaryOutput)`.
   - Storage read `(scope, cell.id, partitionKey)` → value (or
     `cell.defaultValue` on miss).
   - Build `ResolvedCell<T> = { id, value, set }` for Render.
   - Stamp `cell:<id>` onto the partial's labels (so
     `refreshSelector` fires on `.set`).
4. **fp** = `id|matchKey|vary=<hash>|schema=<cellHashes>|props=<hash>|inv=<ts>`.
   The `schema=...` slot includes each cell's `(id,
   partitionKeyHash, valueHash)`, so changing the cell value OR
   navigating across partitions both shift fp.
5. **Render** runs with merged props: vary entries + schema entries.

The parton author does NOT need to redeclare cell-vary dimensions
in their own vary. A cell partitioned by `productId` makes the
parton's fp move on productId transitively, because resolving the
cell at fp time produces a different value per productId.

### Mutation surface

Server-side:

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

`cell.set(v)` resolves the partition key from the **current
request scope** automatically. The action invocation request has
URL + cookies + headers; `cell.vary` runs against that scope to
produce the partition key.

Optional override for cross-context mutations:

```ts
await productNotes.set("New notes", { vary: { productId: "abc" } })
```

When the explicit `vary` override is supplied, `cell.vary` is
skipped and the override is used directly. Useful when an action
fired from `/cart` needs to update notes for a product not in the
current URL.

Client-side:

```tsx
"use client"
import { palette } from "../state.ts"

export function PaletteToggle({ palette: handle }) {
  return (
    <button onClick={() => handle.set(handle.value === "dark" ? "light" : "dark")}>
      {handle.value}
    </button>
  )
}
```

Two ways to obtain the handle on the client:

1. **Via Flight prop** — server render passes `<PaletteToggle
   palette={palette} />` where `palette` came from the parton's
   schema. The `ResolvedCell` carries `{id, value, set}` across
   Flight. `.set` is a server-action ref (bound `__cellWrite`
   with `cellId` baked in via `Function.prototype.bind`).
2. **Direct module import** — the client component imports the
   bare module handle; `.set` is the same bound action ref.
   `.value` on the bare handle is `undefined` (no
   request to resolve against). Use the prop-passed handle when
   you need `.value`, the bare handle when you only need `.set`.

Default exposure: `{value, set}` — both cross Flight. Permission
flags (`exposeValueToClient: false` for sensitive cells) are
deferred; can be added later without breaking the wire shape.

## Storage

v1 ships with **JSON file storage** at `cms/data/cells.json`,
mirroring the CMS storage pattern (`content.json` / `draft.json`).

- **Process-local in-memory cache** is the canonical read path
  (sync, fast).
- **Disk flushes are debounced** (~100ms) — the streaming-demo's
  per-tick writes coalesce into one file write per debounce window.
- **Test scopes** (the `x-test-scope` header used by Playwright
  workers) stay in-memory only — parallel test workers don't
  trample shared disk state, and test cleanup is a per-scope wipe
  rather than file truncation.
- **Atomic writes** use temp-file + rename, same as
  `cms-storage.ts::JsonFileStorage`.

### Storage shape on disk

```json
{
  "demo.bumps": {
    "<hash-of-empty-vary>": 5
  },
  "palette": {
    "<hash-of-{sid:abc123}>": "dark",
    "<hash-of-{sid:def456}>": "light"
  },
  "product-notes": {
    "<hash-of-{productId:42}>": "Notes for 42",
    "<hash-of-{productId:99}>": "Notes for 99"
  }
}
```

Top-level keys = cell ids. Inner keys = `hash(stableStringify(cell.vary(scope)))`
— so `vary: () => ({})` collapses to one constant partition slot.

### Pluggable driver

```ts
import { setCellStorage, type CellStorage } from "@parton/framework"

const redisStorage: CellStorage = {
  async read(scope, cellId, partitionKey) { … },
  async write(scope, cellId, partitionKey, value) { … },
  clear(scope) { … },
}

setCellStorage(redisStorage)
```

Reads are sync today (the runtime calls cells inside parton render
paths that are sync after vary). Drivers that need async reads
(Redis, KV) ship a sync-ish wrapper or a warm-cache step the
runtime awaits at request entry — same shape `cms-storage.ts`
already uses.

## Wire shape

`ResolvedCell<T>` over Flight:

```ts
{
  __cell: true,
  id: "demo.bumps",
  value: 5,                           // current resolved value
  set: <serverRef-of-__cellWrite-bound-to-id>,
}
```

`set` is `__cellWrite.bind(null, cellId)` — Flight handles bound
server-action refs natively (React 19+). The client invokes
`.set(v)` and the framework re-resolves `partitionKey` from the
action invocation's request scope. The action returns
`Promise<void>`; refetch is driven by `getServerNavigation().reload({
selector: "cell:<id>" })` inside the action, which bumps the
invalidation registry and shifts the fp of every parton reading
the cell on the next render.

The cell module handle (the module-singleton thing constructed via
`cell.string(...)`) is **distinct** from `ResolvedCell<T>`. The
module handle carries `vary`, `defaultValue`, `validate`; the
resolved cell carries `value` (and `set`, the bound action ref the
module handle also exposes). Only the resolved form is passed to
Render and across Flight.

## Composition with existing primitives

- **vary** — unchanged. Pure request-dimensions. Cell reads do NOT
  happen inside vary; that's what `schema` is for.
- **selector** — cells auto-stamp `cell:<id>` on the spec's labels.
  Authors can declare additional labels via `selector:` as before.
- **invalidation registry** — `cell.set(v)` calls
  `refreshSelector("cell:" + id)` inside a transaction. fp folding
  reuses today's `queryMatchingTs(labels, varyInputs)` against the
  expanded label set.
- **session reads** — `session.text/number/enum` on the vary scope
  remain available; the new `session.id` field is added for cells
  that partition per-user. Editor shell stays on `session.enum` for
  now; broader migration is filed separately.
- **CMS reads** — `block.schema({cms})` already exists. Pulling
  it up to `parton.schema({cms})` is a separate refactor; this PR
  adds parton.schema to host cell reads only.

## Non-goals (v1)

- **Async loader callbacks.** Render does its own async fetching;
  cells are sync typed slots with defaults. If you need lazy
  population, do it in render.
- **Auto-id from module path.** Explicit `id` is required for now.
  Vite plugin to encode `(module-path, export-name)` is a follow-up.
- **Permission-gated value exposure.** All resolved cells expose
  `value` to client. Add `exposeValueToClient: false` later for
  sensitive cells.
- **Migration of `session.string`/`setSessionValue` callers.**
  Existing callers (editor shell, session-toggle component) stay on
  the legacy surface. Cells live alongside; migration is a
  follow-up PR.
- **Redis/KV adapters.** Interface is stable; in-tree adapter is
  JSON file only.

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
- Currently-typing-into-textarea state → `useState` in the client
  component until commit (then debounced cell write if persistence
  matters).
- Anything sharable that fits a URL → URL, not a cell.

## Related

- [`replicated-state.md`](./replicated-state.md) — the broader
  Unreal-actor-shaped state model. Cells are the narrow
  "single typed value, mutate-and-invalidate" lane.
- [`transient-client-state.md`](./transient-client-state.md) —
  Direction A (per-session draft store) collapses to a cell with
  `vary: ({session}) => ({sid: session.id})`.
- [`../reference/partial.md`](../reference/partial.md) — the
  `parton` constructor surface that `schema` extends.
- [`../reference/cms.md`](../reference/cms.md) — block.schema, the
  existing template for the schema callback shape.
