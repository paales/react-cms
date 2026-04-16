# React CMS — Partials + GraphQL

Research project: a React CMS data layer inspired by Shopify Liquid. Pages are composed of independently re-renderable server-rendered partials; data is fetched with hand-written GraphQL queries via `graphql-request`, typed end-to-end with [gql.tada](https://gql-tada.0no.co/).

> **Historical note:** an earlier iteration used a proxy-based data layer where field access _was_ the query. That design is preserved in `PROXY_DESIGN.md` and the implementation still lives in `src/lib/` but is no longer used by the app. Do not reach for it.

## Project Structure

- `notes` for design documents.
- `src/lib/` — Partials library (`partial.tsx`, `partial-client.tsx`, `partial-cache.ts`, `orchestrator.ts`, `multipart.ts`, `hash.ts`, `partial-error-boundary.tsx`). Also contains the legacy proxy data layer (see `PROXY_DESIGN.md`).
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

Pages are flat lists of independently re-renderable partials (inspired by Shopify's section rendering). Every `Partials` instance requires a `namespace` prop to disambiguate IDs across nested instances. Filter with `?partials=namespace/id`.

### Partials must be server components

All partials and their rendering components are server components. Client components are only for interactivity (buttons, forms) nested inside partials.

### Namespace is required

Every `<Partials>` MUST have a `namespace` prop. A namespace is just a prefix for the partial ID to avoid collisions between nested Partials instances. The namespace is transparent to component authors — `usePartial("cart")` automatically resolves to `"magento/cart"` based on the enclosing Partials context.

### Nesting Partials

Partials instances can be nested. The outer instance (e.g., `namespace="layout"`) wraps the page shell (head, nav, body). The inner instance (e.g., `namespace="magento"`) wraps the page-specific content (header, cart, products).

When `?partials=magento/cart` is requested:

1. **Outer (layout)**: no IDs start with `layout/` → pass-through
2. **Inner (magento)**: `magento/cart` matches → filters to just cart

Pass-through is necessary because the server must execute the outer's "page" child for the inner Partials to run at all (RSC is server-rendered).

### Pass-through optimization: HTML vs component heuristic

During pass-through, the outer instance must render enough for inner instances to execute. But not all outer partials need re-rendering:

- **HTML-type partials** (`<head key="head">`, `<nav key="nav">`) can't contain nested Partials or read request context. If their fingerprint matches the client's cached version, they're **skipped** during pass-through.
- **Component-type partials** (`<PokemonPage key="page" />`) might contain nested Partials instances or depend on URL/context. They **always render** during pass-through.

On full navigation (no `?partials=` filter), ALL partials render regardless — URL changes can affect any component's output.

### Fingerprints

Each partial has a fingerprint (hash of its element tree shape). The client sends `?cached=layout/head:fp,layout/nav:fp,...` with all known fingerprints. Fingerprints are used for:

1. **Pass-through skip**: HTML-type partials with matching fingerprints skip during pass-through (see above)
2. **Client change detection**: the client PartialsClient uses fingerprints to track which partials have changed

**Critical implementation detail**: `_tokensByNamespace` in `partial-client.tsx` accumulates cached tokens across ALL PartialsClient instances (keyed by namespace). If this were a simple overwrite, nested instances would clobber each other's tokens and the outer's fingerprints wouldn't be sent → the outer would re-render everything on every refetch.

### usePartial hook

`usePartial(id)` returns `{ refetch(props?), isPending }`:

- `refetch()` — invalidation: re-render with current props
- `refetch({ query: "pika" })` — re-render with overridden props (via `__inputs`)

The hook reads the namespace from React context. Component authors never write the namespace prefix:

```tsx
// Inside <Partials namespace="pokemon">
const hero = usePartial("hero"); // → sends ?partials=pokemon/hero
hero.refetch();
```

### Tags and cache

Partials can declare tags and cache TTL via reserved props:

```tsx
<CartBadge key="cart" tags={["cart"]} cache={60} />
```

- `tags` — group partials for bulk invalidation: `{ invalidate: { tags: ["cart"] } }`
- `cache` — server-side data cache TTL in seconds (keyed by the GraphQL query string)
- Reserved props are stripped before rendering the component (via `stripReservedProps`)

### Server action invalidation

Server actions return invalidation instructions. **Prefer tags** over IDs — tags are namespace-agnostic and don't couple actions to page structure:

```ts
// By tag (preferred — namespace-agnostic)
return { invalidate: { tags: ["cart"] } };
// By ID (must include namespace prefix)
return { invalidate: ["magento/cart"] };
// Mixed
return { invalidate: { ids: ["layout/nav"], tags: ["cart"] } };
```

**IMPORTANT**: ID-based invalidation (`["cart"]`) without the namespace prefix will NOT match any Partials instance — both outer and inner instances pass through and re-render everything. Always use the full namespaced ID or use tag-based invalidation.

### Template and client merge

The server sends a structural template (layout wrappers with placeholders for partials) plus fresh partial content. The client `PartialsClient` fills placeholders from its cache, merging fresh content with cached content. This means non-requested partials stay visible without re-rendering.

## Development

```bash
yarn dev        # Start dev server (Vite 8 + RSC)
yarn test       # Run all tests (vitest)
yarn test:watch # Watch mode
```

## Testing

Tests hit real GraphQL APIs (PokeAPI, GraphCommerce Magento). Timeout is 15-30s for integration tests.

## APIs

| API           | Endpoint                                       | Used for                      |
| ------------- | ---------------------------------------------- | ----------------------------- |
| PokeAPI       | `https://beta.pokeapi.co/graphql/v1beta`       | Primary example (Hasura)      |
| GraphCommerce | `https://graphcommerce.vercel.app/api/graphql` | Magento 2 (mutations, @defer) |
