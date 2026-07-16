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

|                                  | What it is                                                                                         | When you reach for it                                                                                        |
| -------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `parton(R, opts)`                | Addressable render unit. Optionally request-gated via `match`.                                     | Any subtree you want fingerprinted, cacheable, refetchable. The catch-all.                                   |
| `block(R, opts)`                 | Slot-placeable partial with a `schema` for CMS content.                                            | Content blocks the CMS can place into slots or render directly as a singleton (storage row matches spec id). |
| `cell` / `localCell` / `gqlCell` | Typed, identity-keyed slot of server-authoritative state; crosses Flight as `ResolvedCell<T>`.     | Server-owned state a parton reads and clients mutate — cart, prefs, form drafts, GraphQL-loaded entities.    |
| `<Frame name initialUrl>`        | Scope opener — extends the ambient frame chain so descendants see the frame-resolved request.      | Any region whose URL is independent of the window URL.                                                       |
| `<RemoteFrame url capability>`   | Cross-process composition — embeds a parton hosted by a different process (same- or cross-origin). | Federated UI: payment forms hosted by a payment provider, marketing widgets from a CMS, etc.                 |

```tsx
const PokemonPage = parton(PokemonRender, "/pokemon/:id")

function PokemonRender({ id }: { id: string } & RenderArgs) {
  return <article>...{id}...</article>
}

;<PokemonPage />
```

## The mental model

A spec is constructed once at module scope; every render of it runs
one pipeline:

1. **Match gate.** `match` decides which instance exists on this
   request — variant identity (named params), route buckets,
   existence. A miss parks the client's cached variants; only
   matching specs render.
2. **Body reads.** Everything else the spec depends on, its `Render`
   _reads_: request dimensions via tracked hooks (`searchParam()`,
   `cookie()`, `header()`, …), data via cells
   (`cell.resolve()`, inline `localCell`, `.with()` prop binding),
   CMS content via a block's `schema({cms})`. The read IS the
   dependency — recorded per render, no declarations. (Viewport
   visibility is an existence gate like `match`, not a body read —
   the `cull` spec option.)
3. **Fingerprint.** Each render hashes the spec id, match params,
   resolved cells, call-site props, invalidation bumps, the recorded
   reads re-evaluated at the current request, and every descendant's
   contribution. The client states the fingerprints it holds (the
   attach statement's `cached` manifest; the `x-parton-cached` request
   header on an unattached action POST); the server emits a placeholder for any spec whose
   fp is unchanged, and the client paints the cached subtree from its
   client-side partial cache.
4. **Per-parton wire.** After first paint the page holds ONE channel
   connection; navigations and frame moves are `url` frames on it,
   and every rendered consequence rides the held stream — whole-tree
   segments for navigations, per-parton lanes for targeted work, each
   parton at its own cadence. Independently re-renderable: a lane
   re-runs only its parton's body, never its ancestors; the client
   merges lanes and segments into a persisted template.
5. **Writes.** Plain `"use server"` functions that import cells and
   call `.set`, wrapped in `atomic(fn)` for one transactional commit;
   invalidation fans back out to every parton that read the cell.

> Render the whole tree on the document request — the CDN-cacheable
> artifact. After that, the page speaks to a live server process
> over one held connection: every client statement is a frame on the
> channel, every rendered consequence comes down the stream as
> segments and per-parton lanes, and the client merges them into a
> persisted template.

Every render decision lives inside the spec component the
constructor returns: match gate, fingerprint, skip, fall through.
Specs placed inside opaque server components or `.map()` loops
register themselves the same way as top-level placements.

## What lives where

| Folder                   | Role                                                                                                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `framework/src/lib/`     | Framework primitives — `partial.tsx` (constructor + `PartialRoot`), `frame.tsx` (`<Frame>` scope opener), `cache.tsx`, `partial-registry.ts`.                                                     |
| `framework/src/runtime/` | RSC plumbing — `context.ts` (request ALS only), `cms-runtime.ts`, `navigation-api.ts`, `session.ts`. (The `entry.{rsc,browser,ssr}.tsx` glue files live with the active app: `e2e-testing/src/`.) |
| `cms/src/editor/`        | CMS editor UI — three-pane shell.                                                                                                                                                                 |
| `e2e-testing/src/app/`   | Example application — pages and blocks.                                                                                                                                                           |
| `cms/data/`              | CMS content store — `content.json` (committed), `draft.json` (gitignored).                                                                                                                        |

## Setting up an app

An app is three thin entry files delegating to the framework's entry
factories, plus a vite config whose `environments.*.build.rollupOptions
.input` map wires them together (see any sibling workspace —
`website/` is the smallest example):

```tsx
// src/entry.rsc.tsx — the server handler
import { createRscHandler } from "@parton/framework/entry/rsc.tsx"
import { Root } from "./app/root.tsx"
export default createRscHandler({ Root })

// src/entry.ssr.tsx — HTML rendering
export { renderHTML } from "@parton/framework/entry/ssr.tsx"

// src/entry.browser.tsx — hydration + client runtime
import { bootBrowser } from "@parton/framework/entry/browser.tsx"
bootBrowser()
```

`createRscHandler` accepts the app's knobs: `Root` (the html shell,
placing `<PartialRoot>`), `notFound` (404 page body), `fetch` (a
first-crack hook for app routes — return `undefined` to fall through),
`remote` (opt-in remote-metadata endpoints — the manifest + types the
`parton add` CLI reads; embedding itself needs no config — see
[`remote-frame.md`](./remote-frame.md)), and `clearCaches` (extras on
the DEV clear-caches endpoint). Everything else — the segmented
response driver, fp-trailers, invalidation transactions, the live
heartbeat — is the factories' business.

## Static assets

Drop files in the app's `public/` dir (`favicon.ico`, `robots.txt`,
`apple-touch-icon.png`, …) — Vite's own serving layer owns them, in
every mode this repo runs: `servePublicMiddleware` (dev) and `vite
preview`'s asset middleware both serve `public/` **before** the RSC
handler is even installed (both `configureServer` and
`configurePreviewServer` register the framework's fetch handler as a
Vite "post" middleware — see `@vitejs/plugin-rsc`'s `plugin.js`). A
request for a file that exists under `public/` never reaches
`createRscHandler`'s `fetch` at all; there is nothing for the
framework to configure. `e2e-testing/public/favicon.ico` is the
worked example.

A request for a path with **no** `public/` file (a stray crawler
probe, a mistyped URL) still reaches the handler and renders the
whole tree; whether that resolves to HTTP 404 is the APP's semantic —
an app whose pages are match-gated declares it by placing a fallback
that consults the match registry and throws `notFound()`
([`partial.md` § 404 fallback](./partial.md#404-fallback)), while an
app whose document is built of bare, matchless partons (the website's
tile world) legitimately renders content at every pathname and has no
404 boundary at all. The framework cannot tell those two apart from
the registry alone, so it never short-circuits ahead of the render.

## Reading order

1. [`partial.md`](./partial.md) — the base constructor: the match
   gate, tracked reads, fingerprinting, skip semantics.
2. [`block.md`](./block.md) — the CMS-slot-placeable constructor.
3. [`cells.md`](./cells.md) — typed server-state slots (the data
   primitive partons and blocks read) and the write surface
   (`atomic`, bound writes, `useCell`).
4. [`cache.md`](./cache.md) — server-side render-output cache.
5. [`errors.md`](./errors.md) — the error-recovery contract: what
   throws where, serve-last-known-good, retry/backoff, the staleness
   marker, observability.
6. [`cms.md`](./cms.md) — CMS layer + editor.
7. [`frames-navigation.md`](./frames-navigation.md) — `<Frame>`
   component and the `useNavigation` API.
8. [`remote-frame.md`](./remote-frame.md) — `<RemoteFrame>` for
   cross-process composition (same- or cross-origin partons
   stitched into the host's response).
9. [`deployment.md`](./deployment.md) — running a pilot: build
   outputs, the sticky stateful-process model, storage backends,
   deploy-and-drain, and what state survives a deploy.
