# React CMS — Proxy Data Layer

Research project: a React data layer where accessing data IS the query, inspired by Shopify Liquid.

## Architecture

**Thesis:** Data resolution strategy should be a property of the data, not the component.

**How it works:** Schema-aware JavaScript Proxies record property accesses during a phantom render, compile them into GraphQL queries, fetch data, and re-render with real values. Components never write queries.

```
Discovery (phantom proxy) → Compile (access tree → GraphQL) → Fetch → Render (data proxies)
```

## Project Structure

- `src/lib/` — Backend-agnostic library (proxy, schema, compiler, partials)
- `src/app/` — Example application (PokeAPI + Magento backends)
- `src/framework/` — RSC plumbing (vite-plugin-rsc, Vite 8, React 19)

## Key API: `resolve()`

The render function receives a **query root proxy**. Accessing fields on it — including with arguments — defines the GraphQL query automatically. No config objects, no rootField, no selectionPath.

```tsx
// Single query
resolve((q) => {
  const pokemon = q.pokemon_v2_pokemon({ limit: 12, order_by: raw("{id: asc}") });
  return pokemon.map(p => <Card name={p.name.value} />);
});

// Multi-query — just access multiple root fields
resolve((q) => {
  const products = q.products({ filter: {}, pageSize: 12 }).items;
  const cart = q.cart({ cart_id: id });
  return <>
    <ProductGrid products={products} />
    <CartDrawer cart={cart} />
  </>;
});

// Data-only mode (returns { data, query })
const { data } = await resolve.data((q) => {
  q.products({ filter: {} }).items.map(p => { p.name.value; p.sku.value; });
});
```

`resolve.data` returns `{ data, query }` (not the bare proxy) because proxies are thenable — `await proxy` would unwrap it.

## Key Conventions

### `.value` accessor
Every proxy field returns another proxy. `.value` unwraps to the actual value.
- `.value` is **schema-aware**: if the type has a real field called `value` (e.g., Magento `Money.value`), it traverses. Otherwise it unwraps.
- `.$value` — escape hatch to force unwrap when type has a `value` field.
- Every proxy is thenable — `use(proxy)` works with React's `use()` hook.

### `__typename` injection
The query compiler automatically injects `__typename` into every object selection. The proxy uses `__typename` from response data to resolve concrete types at runtime (e.g., `ConfigurableProduct` from `ProductInterface`).

### Partials MUST be server components
All partials and their rendering components are server components. Client components are only for interactivity (buttons, forms) nested inside partials.

### Backend-agnostic
The library works with any GraphQL schema. The schema introspection discovers the query root type name automatically (e.g., `query_root` for Hasura, `Query` for standard GraphQL).

## Partial Architecture

Pages are flat lists of independently re-renderable partials (inspired by Shopify's section rendering). Every `Partials` instance requires a `namespace` prop to disambiguate IDs across nested instances. Filter with `?partials=namespace/id`.

### Namespace is required
Every `<Partials>` MUST have a `namespace` prop. A namespace is just a prefix for the partial ID — it's not a fundamentally different concept, it's just a way to avoid collisions between nested Partials instances. The namespace is transparent to component authors — `usePartial("cart")` automatically resolves to `"magento/cart"` based on the enclosing Partials context.

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
const hero = usePartial("hero");  // → sends ?partials=pokemon/hero
hero.refetch();
```

### Tags and cache
Partials can declare tags and cache TTL via reserved props:
```tsx
<CartBadge key="cart" tags={["cart"]} cache={60} />
```
- `tags` — group partials for bulk invalidation: `{ invalidate: { tags: ["cart"] } }`
- `cache` — server-side data cache TTL in seconds (keyed by compiled GraphQL query)
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

| API | Endpoint | Used for |
|-----|----------|----------|
| PokeAPI | `https://beta.pokeapi.co/graphql/v1beta` | Primary example (Hasura) |
| GraphCommerce | `https://graphcommerce.vercel.app/api/graphql` | Magento 2 (mutations, @defer) |
