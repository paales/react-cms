# Server context

Values threaded parent→child through the server render tree, readable during
any Server Component's render. React's RSC renderer has no Context for Server
Components (and the experimental `createServerContext` was removed), so the
framework implements it with a small patch to the vendored Flight server.

**One channel, every consumer.** A single immutable map flows down the render
tree. Each context is one keyed entry — every `createServerContext` value, and
the framework's own parton parent (`PartialCtx` — ancestor id path + frame
chain), which rides the same channel under a reserved key, `ParentContext`. The
generic primitive is `framework/src/lib/server-context.ts`; the parton-parent
consumer (`ParentContext`) lives in `partial-context.ts`; the patch is
`.yarn/patches/@vitejs-plugin-rsc-*.patch`, authored reproducibly by
`scripts/patch-plugin-rsc-server-context.mjs`.

## One mechanism: the parton ALS

Both halves of context — carrying it parent→child and reading it mid-render —
ride **one** `AsyncLocalStorage` the patch enters per component
(`partonStorage`, the same store React's own dev `componentStorage` uses,
extended to prod). The carrier is not a separate, fragile channel; it is the
exact mechanism that already makes reads reliable, because an ALS store follows
the JS engine's post-`await` continuation.

The unit threaded through the ALS is a per-render **frame** —
`{ ctx, parton? }`:

- `ctx` is the immutable context map this subtree READS (`getServerContext`).
- `parton` is the rendering parton's self-identity (`getCurrentParton`),
  read-your-own and not inherited — see [`current-parton.ts`](../../framework/src/lib/current-parton.ts).

Because `ctx` is immutable and a provider scopes its descendants by handing the
patch a fresh child map (never by mutating a slot a sibling shares), a read is
valid ANYWHERE in a render — before or after awaits — and sibling subtrees stay
isolated.

## The patch

Authored by `scripts/patch-plugin-rsc-server-context.mjs`; each edit asserts a
unique anchor, so an upstream change fails loudly. Five edits per build (dev +
prod edge):

1. **Declare** `partonStorage` (the ALS) and `PARTON_CTX` (a `Symbol.for`
   sentinel shared with `server-context.ts`) alongside React's own storages.
2. **`createTask`** snapshots the current frame's `ctx` onto the new task
   (`task.serverCtx`) — an immutable snapshot taken WHEN the task is created, so
   a deferred or outlined child renders in the context active where its element
   appeared, not whatever a sibling wrote later.
3. **`retryTask`** runs the whole task render inside
   `partonStorage.run({ ctx: task.serverCtx }, …)` — so reads, child
   `createTask`s, and post-`await` continuations all see that context.
4. **The render site** runs each component in a FRESH frame inheriting the
   parent `ctx` (`partonStorage.run(__frame, Component, …)`). That frame is
   where a parton stamps its self-identity and where a read resolves `ctx`. The
   ALS is exposed as `ReactSharedInternalsServer.__partonStorage` for the shim.
5. **`renderModelDestructive`** recognises a `PARTON_CTX` marker (below).

The edge build never imports `AsyncLocalStorage` (edge runtimes lack
`async_hooks`). `@vitejs/plugin-rsc` injects `globalThis.AsyncLocalStorage`
from `node:async_hooks` for SSR/RSC, so on the real Vite server the global is
present; the patch prefers it and falls back to `require("node:async_hooks")`
for the vitest harness. On a true edge runtime with no `async_hooks` the
`require` throws at load — loud, not silent.

## Why a provider returns a marker (and outlines)

A naive provider would render its children inside `partonStorage.run({ ctx }, …)`
and call it done. That fails: React renders a model, then **serialises it in a
second deferred pass** — arrays (`renderFragment`), client-component props, and
suspended children all serialise later, in the *parent task's* scope. A `run()`
scope established during render does not survive into that pass, so those
descendants would read the parent's context, not the provider's.

So `createServerContext`'s provider is **synchronous** and returns a marker
instead of children:

```ts
return { $$typeof: PARTON_CTX, _ctx: overlay, _node: children }
```

The patch's `renderModelDestructive`, on seeing `PARTON_CTX`, **outlines**
`_node` into its own task whose `serverCtx` is `_ctx` (the `createTask` runs
inside `partonStorage.run({ ctx: _ctx }, …)`, then `pingTask`). The whole
subtree — including arrays, client props, and suspending children — then renders
*and serialises* through that task's `retryTask`, which re-establishes `_ctx`.

Cost: one outlined task (one referenced Flight row) per provider. Since
`ParentContext` wraps every parton, that's ~+1 row per parton — the parton's
content moves from inline to a `$L`-referenced row (a few % of wire bytes). This
is the price of a carrier that survives React's render/serialise split; a
render-time scope alone cannot.

## The public API

`server-context.ts` exposes two functions:

- `createServerContext(default)` → a value that is BOTH a provider component
  and the handle for `getServerContext`:

```tsx
const Theme = createServerContext<"light" | "dark">("light")

<Theme value="dark">
  <Page />          {/* getServerContext(Theme) → "dark" anywhere inside */}
</Theme>
```

- `getServerContext(Ctx)` → the value for `Ctx` in the rendering frame's `ctx`,
  or `Ctx`'s default. Valid anywhere in a render — there is no "sync-top rule".

A provider never reads its own overlay: it writes a fresh child map onto the
marker, and the patch renders the children in a frame whose `ctx` is that map,
so only descendants see it. Overlaying copies the inherited map, so every OTHER
key flows through untouched — user server contexts thread through a parton to
its descendants for free.

`partial-context.ts` is the first consumer: the parton parent is one reserved
entry, `ParentContext`. A parton reads its parent with
`getServerContext(ParentContext)` and scopes its descendants by returning them
inside `<ParentContext value={childCtx}>` (so does `<Frame>`, and the cache's
isolated render).

The same ALS frame backs the parton **self**-context: where `ParentContext`
gives a parton its parent, `current-parton.ts` (`getCurrentParton`, `tag`)
gives it its OWN identity — the basis for *server-hooks*. It is read-your-own (a
provider deliberately never sees its own overlay), so it's a direct `parton`
slot on the rendering frame rather than a context entry, and is not inherited by
descendant frames. See [`../reference/partial.md`](../reference/partial.md).

Isolated renders that are their own render root — a cache hole, a
`<RemoteFrame>`, an addressable refetch — have no ambient parent frame; those
seed `parent` explicitly (the cache renders its body inside
`<ParentContext value={bodyParent}>`; refetch injects the `__parent` prop), and
the ALS threads it onward.

## Why not a request-level AsyncLocalStorage

The carrier rides a per-component frame, not a request-level ALS, and we have
probes proving the request-level strategies fail (`__tests__/als-parent-probe`):

- `als.run(ctx, …)` at the request root does not reach a child rendered in a
  later continuation — children read nothing.
- `als.enterWith(ctx)` leaks across siblings — React's work loop renders
  siblings in one shared async context, so the last `enterWith` wins.

A per-component `run` (what the patch does) is different: each component gets
its own frame, and `createTask`/`retryTask` carry an immutable snapshot to
descendants, so post-`await` reads stay correct and siblings don't
cross-contaminate.

## Maintaining the patch across upgrades

The patch targets `@vitejs/plugin-rsc`'s vendored
`react-server-dom-webpack-server.edge.{development,production}.js`. On an
upgrade, regenerate it:

```
yarn patch @vitejs/plugin-rsc
node scripts/patch-plugin-rsc-server-context.mjs <printed-temp-dir>
yarn patch-commit -s <printed-temp-dir>
```

If an anchor no longer matches, the script throws — re-locate `createTask` /
`retryTask` / the render site / `renderModelDestructive` in the new build and
update the anchors. The wire format and these internals are unspecified and may
change; the asserted anchors are the early-warning system.

**Test both builds.** `test:rsc` and `test:e2e` run the *dev* Flight build, so
they exercise only the dev half of the patch; the dev and prod builds schedule
tasks differently and the prod half can diverge silently. The `rsc-prod` tier
covers the prod build —
[`server-context.rsc-prod.test.tsx`](../../framework/src/lib/__tests__/server-context.rsc-prod.test.tsx),
run by `yarn test:rsc:prod` (folded into `yarn test`), renders the threading,
sibling-isolation, array-deferral and client-boundary cases against the
production Flight build. After regenerating the patch, run it. See
[`testing.md`](./testing.md).
