# Introduction

An RSC-native framework for commerce-shaped UIs: server-owned state
— `useState` on the server — with Flight as the communication layer,
and independently re-renderable, addressable, cacheable subtrees as
the unit of composition.

The bet is **dynamic range** — one primitive that stretches from the
leanest, mobile-snappy storefront (mostly static, fingerprint-skip
everything, a few bytes on the wire) to a realtime streaming
dashboard (segmented Flight, live server state), so a commerce stack
never has to bifurcate the way Shopify (Liquid + a React checkout)
or Magento (Luma/Hyvä + yet another React app) must today. See
[`../notes/perspectives.md`](../notes/perspectives.md) § The thesis
for the full framing.

The public surface is five things:

| | What it is | When you reach for it |
|---|---|---|
| `parton(R, opts)` | Addressable render unit. Optionally request-gated via `match`. | Any subtree you want fingerprinted, cacheable, refetchable. The catch-all. |
| `block(R, opts)` | Slot-placeable partial with a `schema` for CMS content. | Content blocks the CMS can place into slots or render directly as a singleton (storage row matches spec id). |
| `cell` / `localCell` / `gqlCell` | Typed, identity-keyed slot of server-authoritative state; crosses Flight as `ResolvedCell<T>`. | Server-owned state a parton reads and clients mutate — cart, prefs, form drafts, GraphQL-loaded entities. |
| `<Frame name initialUrl>` | Scope opener — extends the ambient frame chain so descendants see the frame-resolved request. | Any region whose URL is independent of the window URL. |
| `<RemoteFrame url capability>` | Cross-process composition — embeds a parton hosted by a different process (same- or cross-origin). | Federated UI: payment forms hosted by a payment provider, marketing widgets from a CMS, etc. |

```tsx
const PokemonPage = parton(PokemonRender, "/pokemon/:id")

function PokemonRender({ id }: { id: string } & RenderArgs) {
  return <article>...{id}...</article>
}

<PokemonPage />
```

## The mental model

A spec is constructed once at module scope; every render of it runs
one pipeline:

1. **Match gate.** `match` decides which instance exists on this
   request — variant identity (named params), route buckets,
   existence. A miss parks the client's cached variants; only
   matching specs render.
2. **Body reads.** Everything else the spec depends on, its `Render`
   *reads*: request dimensions via tracked hooks (`searchParam()`,
   `cookie()`, `header()`, `visible()`, …), data via cells
   (`cell.resolve()`, inline `localCell`, `.with()` prop binding),
   CMS content via a block's `schema({cms})`. The read IS the
   dependency — recorded per render, no declarations.
3. **Fingerprint.** Each render hashes the spec id, match params,
   resolved cells, call-site props, invalidation bumps, the recorded
   reads re-evaluated at the current request, and every descendant's
   contribution. The client sends the fingerprints it has on every
   refetch; the server emits a placeholder for any spec whose fp is
   unchanged, and the client paints the cached subtree from its
   client-side partial cache.
4. **Per-parton wire.** Every navigation can ask for any subset of
   specs (`selector` labels); the server returns only what was asked
   for, the client merges the parts into a persisted template.
   Independently re-renderable: a targeted refetch re-runs only the
   requested spec's body, never its ancestors.
5. **Writes.** Plain `"use server"` functions that import cells and
   call `.set`, wrapped in `atomic(fn)` for one transactional commit;
   invalidation fans back out to every parton that read the cell.

> Render the whole tree on a full request. After that, every
> client-initiated render is a navigation, and every navigation can
> ask for any subset of specs; the server returns only what was
> asked for, the client merges them into a persisted template.

Every render decision lives inside the spec component the
constructor returns: match gate, fingerprint, skip, fall through.
Specs placed inside opaque server components or `.map()` loops
register themselves the same way as top-level placements.

## What lives where

| Folder | Role |
|---|---|
| `framework/src/lib/` | Framework primitives — `partial.tsx` (constructor + `PartialRoot`), `frame.tsx` (`<Frame>` scope opener), `cache.tsx`, `partial-registry.ts`. |
| `framework/src/runtime/` | RSC plumbing — `context.ts` (request ALS only), `cms-runtime.ts`, `navigation-api.ts`, `session.ts`. (The `entry.{rsc,browser,ssr}.tsx` glue files live with the active app: `e2e-testing/src/`.) |
| `cms/src/editor/` | CMS editor UI — three-pane shell. |
| `e2e-testing/src/app/` | Example application — pages and blocks. |
| `cms/data/` | CMS content store — `content.json` (committed), `draft.json` (gitignored). |

## Reading order

1. [`partial.md`](./partial.md) — the base constructor: the match
   gate, tracked reads, fingerprinting, skip semantics.
2. [`block.md`](./block.md) — the CMS-slot-placeable constructor.
3. [`cells.md`](./cells.md) — typed server-state slots (the data
   primitive partons and blocks read) and the write surface
   (`atomic`, bound writes, `useCell`).
4. [`cache.md`](./cache.md) — server-side render-output cache.
5. [`cms.md`](./cms.md) — CMS layer + editor.
6. [`frames-navigation.md`](./frames-navigation.md) — `<Frame>`
   component and the `useNavigation` API.
7. [`remote-frame.md`](./remote-frame.md) — `<RemoteFrame>` for
   cross-process composition (same- or cross-origin partons
   stitched into the host's response).
