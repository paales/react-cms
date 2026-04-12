# Proxy Data Layer — Library

Backend-agnostic GraphQL data layer for React Server Components. Instead of writing queries, components access properties on proxy objects. The library records access patterns, compiles them into GraphQL queries, fetches data, and renders with real values.

## Core API

### `createResolver(getSchema, execute)`

Returns a `resolve` function bound to a schema source and query executor. This is the primary entry point for the library.

```ts
import { createResolver, fetchSchema } from "./lib";

const getSchema = () => fetchSchema("https://api.example.com/graphql");
const execute = async (query: string) => {
  const res = await fetch("https://api.example.com/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  return (await res.json()).data;
};

const resolve = createResolver(getSchema, execute);
```

### `resolve(typeName, args, render)` — Simple API

Works when the GraphQL root field name matches the type name and returns an array directly (Hasura-style).

```tsx
// PokeAPI example
resolve("pokemon_v2_pokemon", { limit: 10 }, (pokemonList, { query }) => (
  <div>
    {pokemonList.map((p) => <div key={p.id.value}>{p.name.value}</div>)}
  </div>
));
```

### `resolve(config, render)` — Advanced API

For backends where the query structure differs (e.g., Magento's `products { items { ... } }`).

```tsx
resolve(
  {
    rootField: "products",
    typeName: "ProductInterface",
    args: { search: "shirt", pageSize: 10 },
    selectionPath: "items",                     // wraps selection: products { items { ... } }
    extractItems: (data) => data.products.items, // how to get the items array from the response
  },
  (products) => products.map((p) => <ProductCard key={p.sku.value} product={p} />),
);
```

## The `.value` Accessor

Every property access on a proxy returns another proxy. `.value` is the explicit unwrap point that returns the actual data (or a mock during discovery).

```tsx
pokemon.name          // → Proxy (not yet unwrapped)
pokemon.name.value    // → "bulbasaur" (actual string)
pokemon.id.value      // → 1
pokemon.pokemon_v2_pokemonsprites.map((s) => s.sprites.value) // → array of sprite URLs
```

### Schema-Aware `.value`

When a GraphQL type has a field literally named `value` (e.g., Magento's `Money.value`), the proxy traverses to that field instead of unwrapping. Use `.$value` as an escape hatch to force unwrap.

```tsx
// Magento Money type has { value: Float, currency: String }
product.price_range.minimum_price.regular_price.value.value
//      ^-- traverses to Money.value (Float scalar)
//                                                ^-- unwraps the scalar
```

## Section Architecture

Pages are flat lists of independently re-renderable sections. Inspired by Shopify's section model.

```tsx
import { SectionList, Section } from "./lib";

function ProductPage({ product, sections }) {
  return (
    <SectionList sections={sections}>
      <Section id="hero" component={HeroSection} props={{ product }} />
      <Section id="stats" component={StatsSection} props={{ product }} />
      <Section id="reviews" component={ReviewsSection} props={{ product }} />
    </SectionList>
  );
}
```

### Section Filtering

`SectionList` reads a comma-separated list of section IDs and filters children:

- Full page render: all sections render
- `?sections=hero,stats`: only `hero` and `stats` render
- `?sections=reviews`: only `reviews` renders

This enables partial page re-fetch without re-rendering the entire route.

### Triggering Section Re-fetch (Client)

```tsx
"use client";
import { useTransition } from "react";
import { refreshStats } from "./actions";

function RefreshButton() {
  const [isPending, startTransition] = useTransition();

  async function handleClick() {
    const result = await refreshStats(); // server action
    const url = new URL(window.location.href);
    url.searchParams.set("sections", result.invalidate.join(","));
    startTransition(() => history.replaceState(null, "", url.toString()));
  }

  return <button onClick={handleClick}>Refresh Stats</button>;
}
```

### Server Actions for Mutations

```ts
"use server";

export async function addToCart(cartId: string, sku: string) {
  await executeQuery(`mutation { addProductsToCart(...) { ... } }`);
  return { invalidate: ["cart-drawer", "header-cart-count"] };
}
```

After the mutation, the client refetches only the invalidated sections.

## How It Works (Discovery Phase)

1. **Phantom render.** The library creates a proxy object with mock values and runs the component tree. Property accesses are recorded.
2. **Access tree.** The recorder builds a tree of all accessed paths (`pokemon.name`, `pokemon.types[].type.name`, etc.)
3. **Query compilation.** The access tree compiles into a GraphQL query.
4. **Fetch.** The query runs against the backend.
5. **Real render.** The component tree runs again with data-backed proxies. Same components, same code — different mode.

The phantom render is effectively a cost-free double-render (no I/O, pure function evaluation).

## Backend Agnosticism

The library works with any GraphQL schema. Tested against:

- **PokeAPI (Hasura)** — `pokemon_v2_pokemon(limit: 10) { ... }` style
- **GraphCommerce Magento 2** — `products(search: "shirt") { items { ... } }` style with `selectionPath: "items"`

The proxy uses the schema introspection to know which fields are objects, lists, or scalars, and generates mock values accordingly.

## API Reference

### Exports from `./lib`

```ts
// Core proxy + schema
export { SchemaGraph, fetchSchema } from "./schema";
export { createProxy } from "./proxy-node";
export { AccessRecorder } from "./access-recorder";
export { compileQuery, compileSelectionSet, raw } from "./query-compiler";
export { renderForDiscovery } from "./discovery";

// Primary resolve API
export { createResolver, type ResolveMeta, type ResolveConfig } from "./resolve";

// Section architecture
export { Section, SectionList } from "./section";
export { useSectionRefetch, SectionRefetchButton } from "./section-client";

// Lower-level orchestrator (for custom use cases)
export { orchestrate, createLazyProxy, clearPatternCache } from "./orchestrator";
```
