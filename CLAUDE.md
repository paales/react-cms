# React CMS — Partials + GraphQL

Research project: a React CMS data layer inspired by Shopify Liquid. Pages are composed of independently re-renderable server-rendered partials; data is fetched with hand-written GraphQL queries via `graphql-request`, typed end-to-end with [gql.tada](https://gql-tada.0no.co/).

> **Historical note:** an earlier iteration used a proxy-based data layer where field access _was_ the query. That design is preserved in `proxy-design/` and is no longer wired into the app. Do not reach for it.

## Project Structure

- `notes/` — current design notes (start at `notes/README.md`). Historical docs live in `archive/` (top-level).
- `src/lib/` — Partials library (`partial.tsx`, `partial-component.tsx`, `partial-client.tsx`, `partial-registry.ts`, `partial-request-state.ts`, `partial-error-boundary.tsx`, `cache.tsx`, `hash.ts`, `multipart.ts`, `partial-cache.ts`). Activator components (`WhenVisible`, `WhenStored`) live in userspace at `src/app/components/`.
- `proxy-design/` — legacy proxy data layer (see `proxy-design/README.md`).
- `src/app/` — Example application (PokeAPI + Magento backends)
- `src/framework/` — RSC plumbing (vite-plugin-rsc, Vite 8, React 19)

## Data Layer

Data fetching uses `graphql-request` with a per-backend `GraphQLClient` instance. Queries and mutations are written as GraphQL strings and tagged with `gql.tada`'s typed `graphql()` function for end-to-end type inference.

```ts
// src/app/magento-data.ts
import { GraphQLClient } from "graphql-request";
export const client = new GraphQLClient("https://graphcommerce.vercel.app/api/graphql");

// src/app/magento-graphql.ts
import { initGraphQLTada } from "gql.tada";
import type { introspection } from "./magento-env.d.ts";
export const graphql = initGraphQLTada<{ introspection: introspection; scalars: { ... } }>();
```

```tsx
// Usage in a component
import { graphql } from "../../magento-graphql.ts";
import { client } from "../../magento-data.ts";

const CartQuery = graphql(`
  query Cart($cartId: String!) {
    cart(cart_id: $cartId) {
      total_quantity
    }
  }
`);

const data = await client.request(CartQuery, { cartId });
// data.cart.total_quantity is fully typed — no manual <T> generic needed
```

**Conventions:**

- One `graphql()` helper per backend (schema). Don't mix schemas in one document.
- Define fragments with `graphql()` and pass them in the fragments array to queries that use them.
- Prefer `const MyQuery = graphql(\`...\`)` at module scope — makes reuse and fragment composition cleaner than inlining.
- Never pass manual type generics to `client.request`; the typed document provides result + variable types.

## Partials Architecture

Pages are composed of independently re-renderable partials (inspired by Shopify's section rendering). The framework exposes one primitive — `<Partial>` — wrapped by a single framework-owned `<PartialRoot>` at the top of the RSC entry. Page authors never see `<PartialRoot>`; they just use `<Partial>` anywhere in the JSX tree.

A Partial is addressable by `id` (unique per page), by `tags` (non-unique labels, like DOM `className`), or both. Filter with `?partials=<id>` or `?tags=<tag>`. Refetch with `useNavigation().reload({ ids })` or `.reload({ tags })` — see the **Client navigation** section below.

### Partials must be server components

All `<Partial>` content must render in the RSC environment. Client components are only for interactivity (buttons, forms) nested inside partials. Deep Partials inside opaque async components (e.g. `.map()` inside a product list) are first-class — see the Dynamic Partials section below.

### Authoring

```tsx
<Partial id="header">
  <header>
    {new Date().toLocaleString()}
    <Partial id="cart" tags="cart header" fallback={<CartBadge quantity={"?"} />}>
      <CartPartial />
    </Partial>
  </header>
</Partial>

<Partial id="products" cache={{ maxAge: 60 }}>
  <ProductGrid search={search} />
</Partial>

{/* id-less — addressable only via .ad-slot */}
<Partial tags="ad-slot">
  <HouseAd />
</Partial>
```

No namespace. No `<Partials>` wrapper. No `key`.

- **`id`** is optional; when provided, it must be unique per page (duplicates throw). Addressable via `reload({ ids: ["id"] })`.
- **`tags`** is optional; accepts an array OR a whitespace-separated string (`"price product"`) mirroring DOM `className`. Addressable via `reload({ tags: ["price"] })`; passing multiple tags matches their UNION server-side.
- A Partial must have at least one of the two. An id-less Partial synthesizes `__anon:<sorted-tags>` internally and can only be addressed via a tag refetch.

### Dynamic Partials (inside `.map()`)

A Partial produced inside an async component's return value (e.g. per-row in a product grid) is picked up the same as a statically-placed one. Each `<Partial>` render calls `<PartialBoundary>` which side-effects into a **route-scoped registry** (`src/lib/partial-registry.ts`); subsequent refetches consult the registry to resolve ids/tags without re-running ancestors. See `notes/DYNAMIC_PARTIAL_REGISTRY.md`.

### Fingerprints

Each Partial computes a structural fingerprint (hash of component types + scalar props + children shape). The client sends `?cached=id:fp,…` with every refetch. `<Partial>` skips (emits an `<i data-partial hidden>` placeholder) when its fingerprint matches what the client already has, so the browser fills from `_cache` and no bytes are wasted on unchanged subtrees.

### Client navigation — `useNavigation()`

The single client-side handle. Returned by `useNavigation()` (or `useNavigation(name)` for an explicit frame); drives page navigation, frame navigation, and targeted partial refetches.

```tsx
const nav = useNavigation();          // page-scoped (or ambient frame if inside one)
const cart = useNavigation("cart");   // explicit: the cart frame

nav.navigate("/products?sort=price", { history: "push" });              // full page nav
nav.navigate(url,   { history: "replace", tags: ["search-results"] }); // URL update + targeted refetch
nav.navigate(url,   { history: "replace", silent: true });              // URL update only, no refetch
nav.reload({ ids: ["cart"] });                                           // targeted refetch, no URL change
nav.reload({ tags: ["price"] });                                         // tag-resolved refetch, no URL change
nav.back(); nav.forward(); nav.reload();                                  // unfiltered reload = full page refetch
```

`NavigateOptions`:

| Field | Meaning |
|---|---|
| `history` | `"push"` (default), `"replace"`, or `"auto"`. Mirrors the Navigation API. |
| `state` | State to write onto the resulting entry. |
| `info` | Forwarded to navigate events (window handle only). |
| `ids` | Explicit partial ids to refetch. Page handle only; ignored by frame handles (frames refetch their whole subtree). |
| `tags` | Tags to refetch. Resolved server-side against the route-scoped registry; union semantics for multiple tags. Page handle only. |
| `silent` | Update the URL only. No refetch. Useful for bookmarkability-only URL sync (infinite scroll's `?pages=`). |
| `disableTransition` | Commit without wrapping in `startTransition` — fallbacks flash, chunks stream. Default `false` (atomic swap, no fallback). |

Multiple `navigate` / `reload` calls in the same tick coalesce into one microtask-batched refetch request. Frame `navigate(url)` is unchanged — it refetches the frame Partial, which re-renders its whole subtree. See `notes/NAVIGATE_UNIFIED.md` for the full surface and `notes/FRAMES.md` for frame mechanics.

**No `usePartial`, no `__inputs`, no `silentReplace`, no `usePartialParams`** (removed 2026-04-21; see `archive/USE_PARTIAL_AND_INPUTS.md`). State that drives a refetch must live in a URL — page URL for shareable state, frame URL for subtree-scoped state. The server reads it through tracked accessors (`getSearchParam` / `getPathname` / `getCookie` / `getHeader`). A parent that reads an accessor and passes a scalar prop to a descendant is the idiom when the descendant is cache-wrapped (Cache's inner render doesn't inherit the `React.cache`-backed frame-scope cell — see `notes/NAVIGATE_UNIFIED.md` §Sharp edges).

### Caching (`<Partial cache={…}>`)

`cache` opts a Partial into server-side render-output caching. The shape mirrors HTTP `Cache-Control`:

```tsx
<Partial id="products" cache={{ maxAge: 60, staleWhileRevalidate: 300 }}>
  <ProductGrid />
</Partial>
```

| Field | Meaning |
|---|---|
| `maxAge` | Fresh window (seconds). |
| `staleWhileRevalidate` | Additional window where stale bytes are served while a background refresh runs. |
| `vary` | Scalar values that identify *which snapshot* this is — for inputs the auto-tracker can't see (route params like `sku`, pre-computed values). Typed scalar-only. |
| `bypass` | Skip caching this render (dev/preview escape hatch). |

The cache key derives automatically from the Partial body's tracked accessor reads (`getCookie`, `getHeader`, `getSearchParam`, `getPathname` from `src/framework/context.ts`) plus any `vary` scalars. Authors don't restate dependencies — the runtime tracks them.

`getPathname("/p/:slug")` matches the current pathname against a pattern and returns the extracted params. It's the pattern-scaled answer to "my Partial depends on a path segment": two different products matching the same pattern hash distinct values via the matched params, but the pattern itself (not the resolved values) is what lives in the manifest — so a single snapshot in the route-scoped registry is fine. Prefer `getPathname` over closure-capturing the pathname into a prop for Partials that appear on high-cardinality routes like product detail pages. The zero-arg form was deliberately removed (see `notes/AUTO_TRACKED_CACHE_KEYS.md`) — the pattern is required so you can't accidentally key a cache on the full URL.

`getRequest()` is also exported but is **framework-only**: it returns the raw `Request` and does not participate in the cache manifest. Reserved for routing primitives (`framework/router.ts`) and framework internals that derive routes for storage. If you're writing an app-level Partial, read request state through the tracked accessors — `getRequest` inside a cached Partial body silently bypasses the cache key.

Tracked accessors must be called **unconditionally at the top of the body**, like React hooks. Reading a key that wasn't read on previous renders throws a `HoistingViolationError` synchronously — silent cache thrash is worse than a hard failure. See `notes/AUTO_TRACKED_CACHE_KEYS.md`.

Dynamic Partials inside a cached region stay live via strip-on-store / reinject-on-return. Inner Partial ids are folded into the key so adding/removing one invalidates automatically.

### Server action invalidation

Server actions return invalidation instructions:

```ts
return { invalidate: { tags: ["cart"] } };   // by tag (preferred)
return { invalidate: ["cart"] };              // by id
return { invalidate: { ids: ["nav"], tags: ["cart"] } };
```

Ids are global — no prefix — and match 1:1 against `<Partial id>`.

### notFound + redirect

Two framework sentinels let a page or a deep async server component
abort with an HTTP-meaningful outcome:

```ts
import { notFound, redirect } from "./framework/errors.ts";

async function ProductPage() {
  const product = await fetchProduct(getPathname("/p/:slug")?.slug);
  if (!product) notFound();
  if (product.archivedTo) redirect(`/p/${product.archivedTo}`);
  return <Hero product={product} />;
}
```

Mechanics:

- `notFound()` / `redirect()` mutate the request's framework-control
  channel *and* throw. Sync throws are caught by `Root`'s try/catch
  and mapped to `<NotFoundPage/>` / `<Redirect url=…/>` directly.
  Deep async throws bubble past `PartialErrorBoundary` (which
  re-throws framework sentinels via the `__framework` brand) and
  surface via the control channel after `renderHTML` awaits.
- HTML responses return `404` with the `NotFoundPage` body or `302 + Location`
  for redirects. Async `notFound()` causes a re-render of the tree
  with `NotFoundPage` so the body matches the status.
- RSC refetch responses can't return native `302` (fetch would
  transparently follow and commit the destination's payload for the
  current route). The `<Redirect>` client component is shipped
  inline in the payload instead — its `useEffect` calls
  `navigation.navigate` on mount. For `notFound` on a refetch, the
  rendered `<NotFoundPage/>` is committed by the client.

Known limitation: RSC refetch status is always 200 — the framework
communicates via rendered output, not HTTP status, because Root's
sync catch isn't what drives the RSC response path.

### Refetch commit behavior

The client wraps refetches in `React.startTransition` by default: preserve UI, atomic swap, no fallback flash. Opt into per-chunk streaming (fallback + per-boundary reveal as each chunk arrives) per call:

```ts
nav.reload({ ids: ["stage-1", "stage-2", "stage-3"], disableTransition: true });
```

`disableTransition` has a second use: concurrent refetches across disjoint ids. Transitions can collapse overlapping refetches — a newer pending transition can supersede an older one whose bytes have arrived but haven't committed yet. For same-id rapid-fire (search-as-you-type), the transition wrapper is the right default (no stale-data flash). For disjoint-id fan-outs (refresh cart + live price + next page from independent event handlers), pass `disableTransition: true` on each so every response commits on arrival. See `e2e/defer-concurrent-refetches.spec.ts` and `archive/BARE_KEY_REFETCH.md`.

## Future tasks

A running list of design follow-ups that haven't been scheduled yet. Most live with more detail in `notes/IDEAS.md`; this section captures the ones that are load-bearing enough to flag at the top level.

- **Unify `PartialsClient` modes.** `mode="streaming"` vs `mode="cache"` is an internal distinction for merging fresh payloads into the persisted template. With `__inputs` gone, the case for keeping cache-mode is purely "skip ancestor execution on a targeted refetch." Worth a design pass to see if always-streaming + `<Partial cache>` around expensive ancestors is enough. See `notes/IDEAS.md` §Follow-up backlog.
- **Optimistic UI as a Partial primitive.** `<Partial optimistic={(prev, input) => next}>` for action-return optimism. The `__inputs` channel used to carry this shape; the replacement needs to be scoped to the action-return lifecycle, not a general prop-override back-door. See `notes/IDEAS.md` §Optimistic updates.
- **Activator `fire` progress events.** Per-partial `start/success/error` lifecycle so apps can build NProgress-style bars or per-partial affordances without forking. See `notes/IDEAS.md` §Rich refetch event hooks.
- **Tag-based invalidation via manifest values** (e.g. "invalidate every Cache entry that read `cookie:user_id=42`"). Falls out of the existing tracked-accessor manifest; not wired yet. See `notes/IDEAS.md` §Cache invalidation by manifest value.
- **Session/frame eviction policy.** The in-memory session map in `src/framework/session.ts` grows unbounded; production needs Redis + TTL. Frame-URL staleness after long absences is also undefined. See `notes/FRAMES.md` §Known sharp edges.
- **Dev-mode warning for stranded `defer={true}`.** If the app forgets to wire a reload, the Partial is dormant forever. See `notes/DEFER_ACTIVATORS.md` §Known sharp edges.
- **Re-defer on stale.** Once activated, a Partial can't go dormant again. `{once: false}` on `useActivate` is the first step; a `<Partial unmountWhen={<WhenHidden/>}>` activator is the larger story. See `notes/IDEAS.md` §Re-defer / unmount policy.
- **Deeper scope propagation into `<Cache>`.** Cache's inner render (`renderToReadableStream`) doesn't inherit the `React.cache`-backed frame-scope cell, so a cache-wrapped Partial inside a frame can't read `getSearchParam` to get the frame URL's query. Today's workaround: the parent reads the accessor and passes a scalar prop. A cleaner fix would propagate the frame scope into the inner render. See `notes/NAVIGATE_UNIFIED.md` §Sharp edges.

## Development

```bash
yarn dev        # Start dev server (Vite 8 + RSC)
yarn test       # Run all tests (vitest)
yarn test:watch # Watch mode
```

There are also playwright tests, run and validate those as well.

## Testing

Tests hit real GraphQL APIs (PokeAPI, GraphCommerce Magento). Timeout is 15-30s for integration tests.

**Playwright runs with `workers: 1`.** The dev server has process-wide state (the `<Cache>` store, the route-scoped partial registry, session cookies). Parallel workers contended on that state and produced nondeterministic failures. If you add e2e tests, prefer sequential execution + explicit cache clears.

**Dev-only `/__test/clear-caches` endpoint** (in `src/framework/entry.rsc.tsx`) flushes the `<Cache>` store, the partial-data cache, and the partial registry. Used by `test.beforeEach` in specs that need a cold starting state — particularly anything asserting Suspense fallback behavior, since a warm `<Cache>` returns instantly and the fallback never flashes. The same endpoint powers the dev debug toolbar's "flush cache" button (`src/app/components/debug-toolbar.tsx`).

**Vitest's route-keyed fixtures need a registry reset.** `partial.test.tsx` has a top-level `beforeEach(clearRegistry)` because dynamic partials registered under the fake URL (`http://localhost/test`) otherwise leak across tests and contaminate tag resolution.

## APIs

| API           | Endpoint                                       | Used for                      |
| ------------- | ---------------------------------------------- | ----------------------------- |
| PokeAPI       | `https://beta.pokeapi.co/graphql/v1beta`       | Primary example (Hasura)      |
| GraphCommerce | `https://graphcommerce.vercel.app/api/graphql` | Magento 2 (mutations, @defer) |
