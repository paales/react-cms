# Introduction

A React Server Components based framework layer for pages composed
of independently re-renderable, addressable, cacheable subtrees.

The primitive is `ReactCms.partial(Render, options)`. A spec is
constructed once at module scope; every dependency it has on the
request, route, or CMS lives in a single sync `vary` callback.

```tsx
const PokemonPage = ReactCms.partial(PokemonRender, "/pokemon/:id")

function PokemonRender({ id, parent }: { id: string } & RenderArgs) {
  return <article>...{id}...</article>
}

<PokemonPage parent={ROOT} />
```

A spec is:

- **Addressable** — `selector="#cart"` (auto-derived from
  `Render.name` when omitted) makes it the target of
  `useNavigation().reload({ selector: "#cart" })` and of server-action
  `return { invalidate: { selector: "#cart" } }`.
- **Independently re-renderable** — a targeted refetch re-runs only
  the requested spec's body without re-executing any ancestor.
- **Fingerprinted** — every render computes a hash from the spec
  id, the render function reference, and the `vary` result. The
  client sends the fingerprints it has on every refetch; the server
  emits a 3-byte placeholder for any spec whose fingerprint is
  unchanged, and the client paints the cached subtree from its
  module-level `_cache`.
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
| `framework/src/lib/` | Framework primitives — `partial.tsx` (constructor + PartialRoot), `cache.tsx`, `partial-registry.ts`, `slot.tsx`. |
| `framework/src/runtime/` | RSC plumbing — `context.ts` (request ALS only), `cms-runtime.ts`, `navigation-api.ts`, `session.ts`. (The `entry.{rsc,browser,ssr}.tsx` glue files live with the active app: `e2e-testing/src/`.) |
| `cms/src/editor/` | CMS editor UI — three-pane shell. |
| `e2e-testing/src/app/` | Example application — pages and blocks. |
| `cms/data/` | CMS content store — `content.json` (committed), `draft.json` (gitignored). |

## Reading order

1. [`partial.md`](./partial.md) — the constructor surface.
2. [`cache.md`](./cache.md) — server-side render-output cache.
3. [`cms.md`](./cms.md) — CMS layer + editor.
4. [`frames-navigation.md`](./frames-navigation.md) — frames
   and the `useNavigation` API.

## What changed (2026-04-28)

The framework just went through a rewrite from `<Partial>` JSX
wrappers + tracked accessors (`getCookie`, `getSearchParam`, …) to
the define-step constructor. The old API and internals docs are in
[`archive/`](../archive/); the design rationale lives in
[`notes/partial-define-step-api.md`](../notes/partial-define-step-api.md).
