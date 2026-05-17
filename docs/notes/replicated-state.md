# Replicated parton state

> Live design doc. Captured 2026-05-16 from a design conversation
> exploring how Unreal Engine's actor replication model maps onto
> parton primitives. Decision still open; this is the proposal
> on the table.
>
> Predecessor: [`transient-client-state.md`](./transient-client-state.md).
> This doc concretises Direction A + B from that doc and adds the
> RepNotify channel.
>
> Status note 2026-05-17: a `usePartialReconcile` prototype landed
> briefly and was rolled back — no in-tree callers and the
> microtask-defer plumbing it required was paying for nothing. The
> RepNotify channel described below is still the right design
> direction; this doc keeps it as the forward-looking proposal,
> not as something currently shipping.

## Premise

Translate Unreal's actor replication model into parton-shaped
primitives, picking up the lessons that transfer and dropping the
tick-loop / FPS assumptions.

## What survives from Unreal

1. **Per-property authority** — not per-parton. A parton's state is
   composed of fields, each with explicit authority.
2. **RepNotify** — incoming updates fire a side-effect channel;
   value sync and consequence are decoupled.
3. **Prediction is optional and shape-only** — clients predict the
   structural change (row appears, count increments), not the
   authoritative value (price, validated state). Complex / secret /
   fragile business logic stays server-side.
4. **Saved-moves replay** — pending optimistic actions replay
   against the new authoritative state when the server reconciles.
5. **Smooth correction** — view-transition over snap.
6. **Reliable vs lossy channels** — reliable for commits, lossy
   for high-frequency intent.
7. **Relevancy** — already in parton via `?cached=`; covers
   single-client. Multi-client routing deferred.

## What we drop

- Tick-based simulation (60Hz). Parton is request-driven.
- Deterministic-physics rollback. Out of scope.
- Per-frame bandwidth budgets. We're at hundreds-of-ms latency,
  not 16ms.
- UDP / unreliable transport. WebSocket / HTTP/3 streams are
  the upper bound — QUIC is good enough.

## Authority taxonomy

Every piece of state in a parton lives in one of four modes. The
author picks the mode by picking the hook / spec option — there is
no per-field `authority: …` declaration. Same discipline as
[`cms.text(name)`](../reference/cms.md): name the role, the
framework owns the cascade.

| Mode | Where it lives | API surface | Example |
|---|---|---|---|
| **server-only** | `vary` / `schema` output | normal parton render | price, inventory, permissions |
| **server-with-rep-notify** | server-authoritative + client side-effect | `usePartialReconcile()` + `transition: "view"` | toast on order-status change; flash on price update |
| **server-with-optimistic** | server-authoritative + client prediction overlay | `useOptimistic` (single-shot) / `useReplayableOptimistic` (queued) | add-to-cart, drag-reorder, mark-as-read |
| **client-only** | React memory | plain `useState` | hover, focus, drag-position-during-drag |

Unreal's "client-authoritative-server-validated" (its character
input shape) maps to **server-with-optimistic** + a server action
that returns the validated result. The client predicts the shape;
the server commits with authority. Even when "client-authoritative"
in name, the server has the final say — same as Unreal's input
validation.

## Client hook surface

```tsx
"use client"
import {
  useOptimistic,              // React, unchanged
  useReplayableOptimistic,    // new
  usePartialReconcile,        // new — RepNotify
  useNavigation,              // existing
} from "@parton/framework/client"
```

### `useOptimistic` — React-native, unchanged

For single-shot optimistic updates that discard on commit. Use when
the prediction is one action at a time and replay isn't needed.

```tsx
const [items, addOptimistic] = useOptimistic(initial, (state, op) =>
  op.kind === "remove" ? state.filter(i => i.id !== op.id) : state
)
```

### `useReplayableOptimistic(serverState, reducer)` — new

Same call shape as `useOptimistic`; action queue survives across
renders and replays on reconcile. Use for rapid-fire optimistic
flows (multi-cell admin edits, multi-step drag, queued
mark-as-read).

```tsx
const [rows, dispatch, pending] = useReplayableOptimistic(serverRows, applyAction)

function onCellEdit(id, field, value) {
  const opId = crypto.randomUUID()
  dispatch({ kind: "edit", opId, id, field, value })
  saveCellAction({ opId, id, field, value })
}
```

Behavior:

- Display = `queue.reduce(reducer, serverState)`.
- On reconcile (the enclosing parton's `serverState` prop is
  replaced by the framework's refetch), the queue filters out
  actions whose `opId` was acked, then replays remaining against
  the new `serverState`.
- `pending` is the queue length — for spinners and "saving N
  changes…" indicators.

The `opId` is the join key between client-side queue and
server-side ack. Without it the framework can't tell whether a
returned `serverState` already incorporates a given action.

### `usePartialReconcile(handler)` — new (RepNotify)

Fires when the enclosing parton's server fingerprint changes. Pure
side-effect channel — no state read or write here, that's what
props are for.

```tsx
usePartialReconcile(({ oldFp, newFp, reason }) => {
  document.startViewTransition(() => {})
})
```

`reason` enum: `"initial"` | `"refetch"` | `"action"` |
`"invalidate"`. Lets the handler distinguish first-mount from
subsequent updates.

Reads enclosing parton id from the same React context the
navigation hook's `@self` token resolves through. No-arg form is the
common case; an explicit-id form is open for cross-parton
coordination (toast parton reacting to cart parton's update).

## Spec options (server)

### `transition` — auto view-transition on swap

```tsx
const Price = parton(PriceRender, {
  selector: ".price",
  transition: "view",     // wrap next client paint in startViewTransition
})
```

Three values:

- `"view"` — `document.startViewTransition` when supported,
  no-op fallback.
- `"none"` (default) — instant swap.
- `(prev, next) => void` — author callback fired client-side on
  every reconcile.

Implementation: the trailer / PEB-prop hydration carries a
`transition` hint per spec; the client wraps the affected
substitution in a view transition. Composes with `keepalive`
(Activity-wrapped specs transition between Activity siblings).

## Action semantics

### Reliable (default — exists today)

Server actions. Guaranteed delivery, author-supplied idempotency.
Returns `{ invalidate: { selector } }` to drive refetch.

For replay correctness, actions invoked from
`useReplayableOptimistic` SHOULD return their `opId`:

```tsx
"use server"
async function saveCellAction({ opId, id, field, value }) {
  await db.update(id, { [field]: value })
  return { ack: opId, invalidate: { selector: "grid" } }
}
```

The framework lifts `ack` from the action return and routes it to
the dispatching queue automatically. Wiring: at `dispatch` time,
the framework records `(opId → queueRef)`; on action commit, it
calls `queueRef.ack(opId)` before the parton refetches. Open:
needs a per-tab registry keyed by opId; collision-resistant
because opIds are UUIDs.

### Lossy (filed, not v1)

A streaming "up" channel for high-frequency intent — cursor,
scroll, focus changes, typing-in-progress. Transport: WebSocket
or HTTP/3 stream of small frames; the server consumes them and
emits invalidations downstream via the existing mechanism.

```tsx
const stream = useLossyStream("cursor")
stream.send({ x, y })  // fire-and-forget
```

Server-side handler is opt-in per parton via a `subscribe`
callback. Out of scope for v1 — file it once the role-based hook
story lands. See also "Restart-streaming via segmented Flight"
in [`IDEAS.md`](./IDEAS.md).

## Worked example — cart

```tsx
// Server
const Cart = parton(
  async function CartRender({ cartId }: { cartId: string } & RenderArgs) {
    const cart = await loadCart(cartId)
    return <CartClient initial={cart.items} />
  },
  {
    selector: "cart",
    transition: "view",
    vary: ({ cookies: { cart_id: cartId } }) => ({ cartId }),
  },
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
totals / taxes / promos all come from the server reconcile. The
`transition: "view"` option means the post-reconcile substitution
animates smoothly.

## Worked example — admin grid with replay

```tsx
"use client"
function GridClient({ initial }: { initial: Row[] }) {
  const [rows, dispatch, pending] = useReplayableOptimistic(initial,
    (state, op) =>
      op.kind === "edit"
        ? state.map(r => r.id === op.id ? { ...r, [op.field]: op.value } : r)
        : state
  )

  return (
    <>
      {pending > 0 && <PendingBadge count={pending} />}
      <Grid rows={rows} onCellEdit={(id, field, value) => {
        const opId = crypto.randomUUID()
        dispatch({ kind: "edit", opId, id, field, value })
        saveCellAction({ opId, id, field, value })
      }} />
    </>
  )
}
```

Server returns `{ ack: opId, invalidate: { selector: "grid" } }`.
Framework refetches; queue replays uncommitted ops against the new
state. Rapid-fire edits (cell A, cell B, cell C all in 200ms) all
display optimistically; each gets acked independently; if the
server rejects one, the rest replay against pre-rejection state.

## Contracts

1. **Reducer purity.** The reducer in `useReplayableOptimistic`
   runs client-side at dispatch time, again at every render that
   has pending ops, and again on reconcile. It must be
   deterministic and pure. Hard contract.
2. **OpId uniqueness.** Per-tab unique (UUID is fine). Crossing
   tabs is undefined behavior — replay queues are per-tab.
3. **Authority wins on reconcile.** If the server's authoritative
   state contradicts the prediction, the prediction is replaced.
   No "client wins" mode.
4. **Prediction is shape, not value.** Author rule, not
   framework-enforced — reducers should predict structural changes
   (rows present / absent, counts changed, selections toggled) but
   not authoritative values (final prices, validated states,
   business-rule outputs). Predicting values invites drift between
   client and server logic; predicting shape is structurally
   stable.

## Open questions

1. **Action ack auto-wiring.** Does the framework auto-extract
   `ack: opId` from action returns and route to the right queue,
   or does the author wire it manually? Auto is cleaner but
   requires the framework to know which queue owns each opId.
   Probably: per-tab opId-→-queue registry, populated on
   `dispatch`, consumed on action commit.
2. **Replay-after-error.** Action errors → drop the failed op,
   replay subsequent against pre-error state. Default behavior;
   per-op `onError` override probably wanted later.
3. **Conflict resolution between concurrent optimistic ops.**
   "Last action wins" is fine for commerce; collab editing wants
   CRDTs. Out of scope for v1.
4. **Cross-parton reconcile.** A toast parton reacting to a cart
   parton's update needs an explicit-id
   `usePartialReconcile(cartId, handler)`. Defer until a real
   case appears.
5. **Replay queue persistence.** Today: queue lives in React
   state, dies on reload. Cross-tab consistency (user backgrounds
   the tab for 10 minutes, returns): queue should probably
   persist to sessionStorage with a short TTL.
6. **Predictive world loading.** Different axis — pre-loading
   partons for likely-next routes. See "Speculation Rules API for
   partial prefetch" in [`IDEAS.md`](./IDEAS.md). Doesn't
   interact with the per-parton optimistic story; can ship
   independently.

## Related

- [`transient-client-state.md`](./transient-client-state.md) —
  the predecessor; names the gap this spec fills.
- [`IDEAS.md`](./IDEAS.md) — broader backlog; lossy-channel,
  speculation-rules, cross-tab-broadcast all live there.
- [`../reference/partial.md`](../reference/partial.md) — the
  `parton` constructor surface.
- [`../reference/frames-navigation.md`](../reference/frames-navigation.md)
  — `useNavigation().reload({ selector, props })` (already the
  refetch path replay would build on).
- [`../internals/render-pipeline.md`](../internals/render-pipeline.md)
  — fingerprint protocol the RepNotify hook keys on.
