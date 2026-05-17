# Introduction

A React Server Components based framework layer for pages composed
of independently re-renderable, addressable, cacheable subtrees.

The public surface is four things:

| | What it is | When you reach for it |
|---|---|---|
| `parton(R, opts)` | Addressable render unit. Optionally URL-gated via `match`. | Any subtree you want fingerprinted, cacheable, refetchable. The catch-all. |
| `block(R, opts)` | Slot-placeable partial with a `schema` for CMS content. | Content blocks the CMS can place into slots or render directly as a singleton (storage row matches spec id). |
| `<Frame name initialUrl>` | Scope opener — extends `parent.frameChain` so descendants see the frame-resolved request. | Any region whose URL is independent of the window URL. |
| `<RemoteFrame url capability>` | Cross-process composition — embeds a parton hosted by a different process (same- or cross-origin). | Federated UI: payment forms hosted by a payment provider, marketing widgets from a CMS, etc. |

A spec is constructed once at module scope; every dependency it has on
the request lives in a single sync `vary` callback (CMS reads live on
blocks' `schema`).

```tsx
const PokemonPage = parton(PokemonRender, "/pokemon/:id")

function PokemonRender({ id, parent }: { id: string } & RenderArgs) {
  return <article>...{id}...</article>
}

<PokemonPage parent={ROOT} />
```

A spec is:

- **Addressable** — `selector="cart"` (auto-derived from
  `Render.name` when omitted) makes it the target of the client-side
  `[reload] = useNavigation().reload(); reload({ selector: "cart" })`
  and of server-action `return { invalidate: { selector: "cart" } }`.
  Cosmetic `#`/`.` prefixes on labels are stripped and don't change
  behaviour.
- **Independently re-renderable** — a targeted refetch re-runs only
  the requested spec's body without re-executing any ancestor.
- **Fingerprinted** — every render computes a hash from the spec
  id, the render function reference, and the `vary` result. The
  client sends the fingerprints it has on every refetch; the server
  emits a 3-byte placeholder for any spec whose fingerprint is
  unchanged, and the client paints the cached subtree from its
  module-level `_currentPagePartials`.
- **Pattern-as-router** — when `match: "/pokemon/:id"` is set, the
  spec emits nothing on a pattern miss. A page is a list of pattern-
  gated specs; only the matching ones render.

## The mental model

> Render the whole tree on a full request. After that, every
> client-initiated render is a navigation, and every navigation can
> ask for any subset of specs; the server returns only what was
> asked for, the client merges them into a persisted template.

Every render decision lives inside the spec component the
constructor returns: pattern match, vary computation, fingerprint,
skip, fall through. Specs placed inside opaque server components or
`.map()` loops register themselves the same way as top-level
placements.

## What lives where

| Folder | Role |
|---|---|
| `framework/src/lib/` | Framework primitives — `partial.tsx` (constructor + `PartialRoot`), `frame.tsx` (`<Frame>` scope opener), `cache.tsx`, `partial-registry.ts`. |
| `framework/src/runtime/` | RSC plumbing — `context.ts` (request ALS only), `cms-runtime.ts`, `navigation-api.ts`, `session.ts`. (The `entry.{rsc,browser,ssr}.tsx` glue files live with the active app: `e2e-testing/src/`.) |
| `cms/src/editor/` | CMS editor UI — three-pane shell. |
| `e2e-testing/src/app/` | Example application — pages and blocks. |
| `cms/data/` | CMS content store — `content.json` (committed), `draft.json` (gitignored). |

## Reading order

1. [`partial.md`](./partial.md) — the base constructor.
2. [`block.md`](./block.md) — the CMS-slot-placeable constructor.
3. [`cache.md`](./cache.md) — server-side render-output cache.
4. [`cms.md`](./cms.md) — CMS layer + editor.
5. [`frames-navigation.md`](./frames-navigation.md) — `<Frame>`
   component and the `useNavigation` API.
6. [`remote-frame.md`](./remote-frame.md) — `<RemoteFrame>` for
   cross-process composition (same- or cross-origin partons
   stitched into the host's response).
