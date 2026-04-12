# React CMS — Proxy Data Layer

Research project: a React data layer where accessing data IS the query, inspired by Shopify Liquid.

## Architecture

**Thesis:** Data resolution strategy should be a property of the data, not the component.

**How it works:** Schema-aware JavaScript Proxies record property accesses during a phantom render, compile them into GraphQL queries, fetch data, and re-render with real values. Components never write queries.

```
Discovery (phantom proxy) → Compile (access tree → GraphQL) → Fetch → Render (data proxies)
```

## Project Structure

- `src/lib/` — Backend-agnostic library (proxy, schema, compiler, sections)
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

### Sections MUST be server components
All sections and their rendering components are server components. Client components are only for interactivity (buttons, forms) nested inside sections.

### Section architecture
Pages are flat lists of independently re-renderable sections. Filter with `?sections=id1,id2`.

### Backend-agnostic
The library works with any GraphQL schema. The schema introspection discovers the query root type name automatically (e.g., `query_root` for Hasura, `Query` for standard GraphQL).

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
