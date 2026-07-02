# Replicated parton state

> Live design doc. Originally captured 2026-05-16 from a design
> conversation exploring how Unreal Engine's actor replication
> model maps onto parton primitives. 2026-05-22 pass narrowed scope
> after rolling back the `usePartialReconcile` prototype and
> recognising that cells already cover the typed-value lane. Latest
> pass: 2026-07-02 — terminology refreshed for the read-is-the-
> dependency model (`vary`/`schema` are gone; a body's tracked reads
> are its request surface). The doc describes the *current* model
> (cells + `useOptimistic` + in-body `reload()`) and a small set
> of genuinely open questions.
>
> Predecessor: [`../archive/transient-client-state.md`](../archive/transient-client-state.md)
> (archived 2026-05-21 once cells landed Directions A + B).

## Premise

Translate Unreal's actor replication model into parton-shaped
primitives, picking up the lessons that transfer and dropping the
tick-loop / FPS assumptions.

## What survives from Unreal

1. **Per-property authority** — not per-parton. A parton's state is
   composed of fields, each with explicit authority. Cells make
   this first-class for typed values.
2. **Prediction is optional and shape-only** — clients predict the
   structural change (row appears, count increments), not the
   authoritative value (price, validated state). Complex / secret /
   fragile business logic stays server-side.
3. **Smooth correction** — view-transition over snap. Available
   client-side via `document.startViewTransition` around the
   reconcile; no spec-level option today.
4. **Relevancy** — already in parton via `?cached=`; covers
   single-client. Multi-client routing deferred.

## What we drop

- Tick-based simulation (60Hz). Parton is request-driven.
- Deterministic-physics rollback. Out of scope.
- Per-frame bandwidth budgets. We're at hundreds-of-ms latency,
  not 16ms.
- UDP / unreliable transport. WebSocket / HTTP/3 streams are
  the upper bound — QUIC is good enough.
- **RepNotify (`usePartialReconcile`).** Prototyped 2026-05-17,
  rolled back same week — no in-tree callers and the
  microtask-defer plumbing it required was paying for nothing.
  The fingerprint substrate (cold→warm trailer, `PartialIdContext`)
  is intact, so re-landing is cheap if a real case appears.
- **Saved-moves replay (`useReplayableOptimistic`).** Cells
  cover the typed-value lane cleanly, `useOptimistic` covers the
  structural-prediction lane. A queued-replay primitive hasn't
  found an in-tree case where neither suffices.
- **Reliable vs lossy channels.** Both exist now. Reliable (server
  actions) is the default; the lossy lane is `deferred` cells riding
  the live segment stream — writes skip the action-response
  re-render and the open connection carries whatever the value is
  when the next segment renders (cursor / presence broadcast).

## Authority taxonomy

Every piece of state in a parton lives in one of four modes. The
author picks the mode by picking the primitive — there is no
per-field `authority: …` declaration. Same discipline as
[`cms.text(name)`](../reference/cms.md): name the role, the
framework owns the cascade.

| Mode | Where it lives | API surface | Example |
|---|---|---|---|
| **server-only** | the Render body — tracked request reads + async loaders | normal parton render | price, inventory, permissions |
| **server-with-cell** | server-authoritative typed value, partition-keyed | `localCell` / `gqlCell` resolved in-body (`cell.resolve()`, inline `localCell`, or a `BoundCell` prop) + `useCell` on the client (optimistic-aware value, batched `set`, `input()` bindings) | counter, draft text, drawer-open state, anything keyed by partition |
| **server-with-optimistic-shape** | server-authoritative + client structural prediction | React-native `useOptimistic` (single-shot) | add-to-cart (line disappears optimistically; totals/taxes from server), drag-reorder |
| **client-only** | React memory | plain `useState` | hover, focus, drag-position-during-drag |

Cells are the answer for the typed-value lane: pick a cell when the
state is one named value whose authority lives on the server but
whose UI is interactive (counter, drawer, draft, tag). The cell's
`set` is what the client calls; cells auto-bump the invalidation
registry so every parton reading the cell re-renders with the new
value.

`useOptimistic` covers the structural-prediction lane: pick it when
the client is predicting a shape change (a row disappearing, a
count incrementing) rather than a single typed value.
Discard-on-commit is fine — totals / taxes / promos arrive from
the server's authoritative re-render.

`client-only` covers the never-leaves-the-tab case: hover, focus,
the drag position WHILE dragging. `useState` and we're done.

Unreal's "client-authoritative-server-validated" (its character
input shape) maps to **server-with-optimistic-shape** + a server
action that returns the validated result. The client predicts the
shape; the server commits with authority. Even when
"client-authoritative" in name, the server has the final say —
same as Unreal's input validation.

## Action semantics

### Action body — in-body `reload({selector})`

Server actions drive refetch via a side-effect call in the body.
Inside the action body, call
`getServerNavigation().reload({selector})` to bump the invalidation
registry — the surrounding `runInvalidationTransaction` (installed
by the RSC entry handler) buffers the bump and flushes on success.
On throw, the queue is discarded so a failed mutation leaves the
registry untouched.

```ts
"use server"

import { getServerNavigation, setCookie } from "@parton/framework"

export async function addToCart(sku: string) {
  const cart = await magento.addItem(sku)
  setCookie("cart_id", cart.id)
  getServerNavigation().reload({ selector: `cart?cart_id=${cart.id}` })
}
```

The selector's query-string fragment (`?cart_id=${cart.id}`)
scopes the bump: only partons whose constraint surface (match
params + bound cell args) contains `cart_id=<cart.id>` get a fresh
fingerprint. Bare `"cart"` (no constraints) would fan out to every
cart-tagged parton across every user — overwhelmingly the wrong
default for per-user state. The author owns this discipline; the
framework doesn't auto-scope because it doesn't know which of an
action body's reads are partition axes vs incidental reads (render
bodies get this attribution for free via tracked hooks; action
bodies have no equivalent — see the "sharp edge" item in
[`IDEAS.md`](./IDEAS.md)).

The action's response render fires immediately after the body
returns — every parton whose selector matches the bumped name AND
constraints sees a fresh fingerprint and emits new bytes on the
same response. No URL rewrite, no return-value lifting.

Cell writes do this automatically and partition-scoped:
`cell.set(v)` bumps `cell:<id>?<partition-args>` after the write,
so exactly the partons that resolved that cell at that partition
re-render.

### Action results

Today an action's return value flows back to the caller as the
promise resolution. There's no framework-level "result slot" the
renderer can observe — if a caller wants to render the result
(e.g. a form-level error), it stashes the value in client state
at the call site.

A future direction worth exploring: an implicit per-callsite
result slot — like react-hook-form's root error — that the
framework owns and a hook exposes. Shape something like
`{ success, error, value }`, scoped to React identity at the
call site, surviving until the next call, composing with
streaming (the slot updates as the action streams). Deferred
until a concrete in-tree use case lands.

## Worked example — cart with optimistic shape

```tsx
// Server
const Cart = parton(
  async function CartRender() {
    const cartId = cookie("cart_id")   // tracked read — the read IS the dependency
    const cart = await loadCart(cartId)
    return <CartClient initial={cart.items} />
  },
  { selector: "cart" },
)

// Client
"use client"
function CartClient({ initial }: { initial: CartItem[] }) {
  const [items, addOptimistic] = useOptimistic(initial, (state, op) =>
    op.kind === "remove" ? state.filter(i => i.id !== op.id) : state
  )

  return items.map(item => (
    <CartLine
      key={item.id}
      item={item}
      onRemove={async () => {
        addOptimistic({ kind: "remove", id: item.id })
        await removeFromCartAction(item.id)
      }}
    />
  ))
}
```

The optimistic reducer predicts the **shape change** (line
disappears). It does NOT predict the authoritative values — new
totals / taxes / promos all come from the server re-render once
the action's in-body `reload({ selector: "cart" })` lands.

## Contracts

1. **Reducer purity.** The `useOptimistic` reducer runs client-side
   at dispatch and again on each render that still has pending ops.
   Must be deterministic and pure.
2. **Authority wins on reconcile.** If the server's authoritative
   re-render contradicts the prediction, the prediction is replaced.
   No "client wins" mode.
3. **Prediction is shape, not value.** Author rule, not
   framework-enforced — reducers should predict structural changes
   (rows present / absent, counts changed, selections toggled) but
   not authoritative values (final prices, validated states,
   business-rule outputs). Predicting values invites drift between
   client and server logic; predicting shape is structurally stable.

## Open questions

1. **Action result shape.** Is the framework-owned per-callsite
   result slot worth building, and at what surface? `{ success,
   error, value }` is the natural envelope, but the migration cost
   is non-trivial and no in-tree caller forces the decision yet.
2. **Failure-mode propagation.** A single-action throw already
   rolls back the action's queued bumps via the transaction. What's
   not pinned: per-cell granularity inside a batch (today the whole
   batch rolls back; a partial-commit semantic may be wanted later),
   and how the caller learns *which* part failed when the action
   throws. Both questions become urgent the day a multi-cell batch
   ships with mixed-validity semantics.
3. **Cross-tab consistency.** Optimistic state lives in React
   memory and dies on reload. Cells' `latestSentByCell` map has
   the same property. Tracked separately in
   [`IDEAS.md`](./IDEAS.md): "persist optimistic unsaved cell
   values" (single-tab durability) and "Cross-tab sync via
   BroadcastChannel" (multi-tab coherence).
4. **Cell dimensionality.** Cells today carry one value per
   partition (the hashed args record). Time (history / undo),
   translations, currency, domain — these all want different storage
   shapes and different fallback chains. Lives in
   [`cell-dimensionality.md`](./cell-dimensionality.md).

## Related

- [`../archive/transient-client-state.md`](../archive/transient-client-state.md) —
  the predecessor (archived 2026-05-21 once cells landed); names
  the gap this doc fills.
- [`../reference/cells.md`](../reference/cells.md) — the cell
  primitive that covers the typed-value lane.
- [`./cell-dimensionality.md`](./cell-dimensionality.md) —
  exploration of further axes for cell storage (time,
  translations, currency, domain).
- [`./IDEAS.md`](./IDEAS.md) — broader backlog; optimistic-value
  persistence and cross-tab sync live there.
- [`../reference/partial.md`](../reference/partial.md) — the
  `parton` constructor surface.
- [`../reference/frames-navigation.md`](../reference/frames-navigation.md)
  — `useNavigation().reload({ selector })` (client-side
  refetch; symmetric to the server-side
  `getServerNavigation().reload(...)` used by actions).
- [`../internals/render-pipeline.md`](../internals/render-pipeline.md)
  — fingerprint protocol that drives all selector-based refetch.
