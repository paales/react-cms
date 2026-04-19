# React CMS — Partials + GraphQL

Research project: a React CMS data layer inspired by Shopify Liquid. Pages are composed of independently re-renderable server-rendered partials; data is fetched with hand-written GraphQL queries via `graphql-request`, typed end-to-end with [gql.tada](https://gql-tada.0no.co/).

> **Historical note:** an earlier iteration used a proxy-based data layer where field access _was_ the query. That design is preserved in `proxy-design/` and is no longer wired into the app. Do not reach for it.

## Project Structure

- `notes/` — current design notes (start at `notes/README.md`). Historical docs live in `notes/archive/`.
- `src/lib/` — Partials library (`partial.tsx`, `partial-component.tsx`, `partial-client.tsx`, `partial-registry.ts`, `partial-request-state.ts`, `partial-error-boundary.tsx`, `cache.tsx`, `hash.ts`, `multipart.ts`, `partial-cache.ts`, `when-visible.tsx`, `when-visible-client.tsx`).
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

Pages are composed of independently re-renderable partials (inspired by Shopify's section rendering). The framework exposes one primitive — `<Partial id="...">` — wrapped by a single framework-owned `<PartialRoot>` at the top of the RSC entry. Page authors never see `<PartialRoot>`; they just use `<Partial>` anywhere in the JSX tree.

Filter with `?partials=<id>` or `?tags=<tag>`. Refetch with `usePartial(id).refetch()`.

### Partials must be server components

All `<Partial>` content must render in the RSC environment. Client components are only for interactivity (buttons, forms) nested inside partials. Deep Partials inside opaque async components (e.g. `.map()` inside a product list) are first-class — see the Dynamic Partials section below.

### Authoring

```tsx
<Partial id="header">
  <header>
    {new Date().toLocaleString()}
    <Partial id="cart" tags={["cart"]} fallback={<CartBadge quantity={"?"} />}>
      <CartPartial />
    </Partial>
  </header>
</Partial>

<Partial id="products" cache={{ maxAge: 60 }}>
  <ProductGrid search={search} />
</Partial>
```

No namespace. No `<Partials>` wrapper. No `key`. Ids are globally unique per page; duplicates throw during render.

### Dynamic Partials (inside `.map()`)

A Partial produced inside an async component's return value (e.g. per-row in a product grid) is picked up the same as a statically-placed one. Each `<Partial>` render calls `<PartialBoundary>` which side-effects into a **route-scoped registry** (`src/lib/partial-registry.ts`); subsequent refetches consult the registry to resolve ids/tags without re-running ancestors. See `notes/DYNAMIC_PARTIAL_REGISTRY.md`.

### Fingerprints

Each Partial computes a structural fingerprint (hash of component types + scalar props + children shape). The client sends `?cached=id:fp,…` with every refetch. `<Partial>` skips (emits an `<i data-partial hidden>` placeholder) when its fingerprint matches what the client already has, so the browser fills from `_cache` and no bytes are wasted on unchanged subtrees.

### usePartial hook

`const [refetch, isPending] = usePartial(id);`

- `refetch()` — re-render with current props.
- `refetch({ query: "pika" })` — re-render with `__inputs` overrides applied via `cloneElement`.

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

### Refetch commit behavior

The client wraps refetches in `React.startTransition` by default: preserve UI, atomic swap, no fallback flash. Opt into per-chunk streaming (fallback + per-boundary reveal as each chunk arrives) per refetch:

```ts
refetch({ query: "pika" }, { disableTransition: true });
```

See `notes/archive/BARE_KEY_REFETCH.md` for the history.

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
