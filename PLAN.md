# React CMS: Data Layer Architecture Plan

## Thesis

Data resolution strategy should be a property of the data, not the component. Components render values. The system decides when and how those values resolve. The developer's only job is to define the schema and write the template.

Liquid's genius is that accessing data IS the query. React's problem isn't complexity — it's that it forces developers to make data-fetching decisions that should be automatic. This project builds a React data layer that gives Liquid-like defaults (automatic data loading, no manual queries, no loading state management) while keeping React's client model for real interactivity.

## Core Insight: What Shopify Got Right (and what React is missing)

### Section Architecture

Shopify pages are flat lists of sections. Each section is:

- A named, independently re-renderable unit within a page
- Rendered against the page's shared data context (not its own data root)
- Addressable via URL: `GET /products/my-product?sections=recommendations`

React has no equivalent. Component boundaries are only about UI composition. In Shopify, section boundaries are BOTH UI composition AND re-fetch boundaries. This dual purpose is what React is missing.

Next.js layouts are the closest equivalent — they're persistent render boundaries that don't re-execute on navigation. But they only exist at the route level, not within a page. Everything inside a single `page.tsx` is one atomic render unit.

### Data Loading Without Queries

In Liquid, writing `{{ product.title }}` IS the data requirement. There's no query file, no `useQuery`, no wiring. The engine resolves data on access.

Shopify likely achieves this through lazy resolution with batching — a dataloader-style system that resolves fields on access and batches within a render tick. They can afford this because their data layer is co-located with the renderer (~1ms resolution). The template engine is their own runtime, so every variable access is a controlled evaluation point where they intercept, batch, and resolve.

### What React Lost Along The Way

| Capability                     | Liquid/Sections | useQuery (Pages Router) | RSC (App Router) |
| ------------------------------ | --------------- | ----------------------- | ----------------- |
| Server data without spinners   | Yes             | Yes (cache pre-pop)     | Yes               |
| Partial page data refetch      | Yes (section)   | Yes (per query)         | No (per route)    |
| Client interactivity           | Poor (bolt-on)  | Good                    | Good              |
| Lazy server render on scroll   | Yes (section)   | N/A                     | No                |
| Component-level addressability | Yes             | No                      | No                |

RSC solved the "server data without spinners" problem from Pages Router, but LOST the fine-grained partial update capability that `useQuery` had. Neither approach matches Liquid's ability to independently re-fetch an isolated server-rendered block.

## Architecture

### 1. Proxy-Based Data Layer

All data is accessed through schema-aware Proxy objects. Components never write queries — they access properties, and the proxy system records access patterns and compiles them into queries.

```jsx
function ProductHero({ product }) {
  const p = use(product)
  return (
    <div>
      <h1>{p.title}</h1>
      <img src={p.featuredImage.src} />
    </div>
  )
}
```

The proxy object for `product` is not real data. It is a schema-aware object that:

1. Records every property access path (`product.title`, `product.featuredImage.src`)
2. Returns Promises for each value (resolved or pending)
3. Knows the GraphQL schema so it returns the correct types (objects return proxy objects, arrays return ProxyArrays, scalars return Promises)

#### ProxyArray

Array values are not real arrays. They are ProxyArray objects that implement array-like methods (`.map()`, `.find()`, `.filter()`) but are proxy-controlled. During phantom renders, the ProxyArray contains at least one phantom element so callbacks execute and nested access paths are recorded.

```jsx
// ProxyArray ensures the .map() callback runs during phantom render
// so that `img.src` is recorded as an access path
product.images.map(img => <img src={use(img.src)} />)
```

#### Parameterized Access (Pagination, Filtering)

Fields that accept arguments are accessed as function calls. These map directly to GraphQL field arguments:

```jsx
const products = use(collection.products({ first: 10, after: cursor }))
```

The proxy records `collection.products(first: 10, after: cursor)` as a parameterized access path and compiles it to the corresponding GraphQL field with arguments.

### 2. Query Compilation

The proxy's recorded access paths compile into a single GraphQL query. This happens automatically — the developer never writes or sees the query.

```
Recorded paths:
  product.title
  product.featuredImage.src
  product.images[].src
  product.variants[].price.amount

Compiled query:
  query {
    product(id: "...") {
      title
      featuredImage { src }
      images { src }
      variants { price { amount } }
    }
  }
```

This works against any GraphQL backend. The proxy needs the GraphQL schema (introspection) to:

- Know which fields are objects vs scalars vs arrays
- Generate correctly typed mock values for phantom renders
- Validate that recorded access paths are valid query paths
- Map function-call accesses to field arguments

### 3. Resolution Strategies via `use()`

Values are unwrapped with React's `use()` hook. `use()` works on both server and client:

- If the Promise is resolved: returns the value synchronously
- If the Promise is pending: throws (Suspense catches it, streams/suspends)

The SAME field can be sync or async depending on context. `product.price` resolves immediately for public catalog pricing but defers for customer-specific pricing. The component doesn't know or care:

```jsx
function Price({ value }) {
  const price = use(value)
  return <span>{price.amount} {price.currency}</span>
}
```

The resolution strategy is determined by the data layer at query time, not by the component at render time. Three strategies:

| Strategy  | Behavior                          | Example                              |
| --------- | --------------------------------- | ------------------------------------ |
| Immediate | Resolved before render            | `product.title`                      |
| Deferred  | Streamed via `@defer`, use() suspends until ready | `product.customerPrice`  |
| Lazy      | Resolved when client signals readiness (e.g., scroll into view) | `product.recommendations` |

These can be driven by the context (auth state, viewport visibility) rather than hardcoded per field.

#### `<Maybe>` Component

A lightweight Suspense boundary that developers place where they expect possible deferral:

```jsx
<Maybe fallback={<PriceSkeleton />}>
  <Price value={product.price} />
</Maybe>
```

`<Maybe>` is just `<Suspense>` with potentially an integrated Error Boundary for handling failed resolutions. Developers learn to use coarse-grained `<Maybe>` boundaries by default and refine to finer-grained boundaries as needed.

#### `<IntersectionObserver>` + Lazy Resolution

```jsx
<IntersectionObserver>
  <Suspense fallback={<Skeleton />}>
    <RecommendedProducts products={product.recommendations} />
  </Suspense>
</IntersectionObserver>
```

The data dependency for `product.recommendations` is declared during render (proxy records it), but resolution is deferred until the IntersectionObserver signals visibility. The query includes the field but the response streams it only when the client signals readiness. This is the pattern that RSC currently cannot do — lazily loading a server-rendered fragment on scroll.

### 4. Access Pattern Learning

The proxy records access patterns at runtime. This handles conditional branches that static analysis cannot:

```jsx
if (use(product.isInStock)) {
  return <span>Only {use(product.onlyXAvailable)} left!</span>
}
```

If `isInStock` is false during the first render, `onlyXAvailable` is never accessed and never fetched. When a render first encounters `isInStock === true`, the proxy records the new path, triggers a supplemental fetch, and Suspense handles the loading. From then on, the pattern is cached and included in subsequent queries.

#### Learning Lifecycle

1. **Pre-seed at build/prerender time:** Run pages with various data shapes (in-stock product, out-of-stock product, different product types). Union all discovered access patterns. This covers common paths before production.
2. **Learn at runtime:** Production traffic discovers new conditional paths. First occurrence pays a supplemental fetch (one extra round-trip). Pattern is cached for all subsequent requests.
3. **Nice property:** Unused code paths never generate data fetches. If a branch never executes in production, its data is never loaded. This is better than static analysis which would over-fetch both branches.

#### Cold Start

First request for a page/section combination with no cached patterns:

1. Schema generates typed mock values
2. Phantom render executes components against mocks, recording all access paths
3. Compiled query fetches real data
4. Real render with resolved data

This is a double-render on first hit. For server components (pure functions, no side effects) this cost is negligible. Subsequent requests skip the phantom render and use cached patterns.

**Future (v2):** A control flow analysis compiler could statically extract access patterns at build time, eliminating the cold start entirely. The runtime learning system is the pragmatic v1 approach.

### 5. Section Architecture

A page is a list of sections. Each section has a stable identity and is independently re-renderable.

```jsx
function ProductPage({ product }) {
  return (
    <SectionList context={{ product }}>
      <Section id="hero" component={ProductHero} />
      <Section id="recommendations" component={Recommendations} />
      <Section id="reviews" component={Reviews} />
    </SectionList>
  )
}
```

#### How It Works

JSX is just `createElement` calls that return descriptor objects — writing `<Section component={Reviews} />` does NOT execute `Reviews`. `SectionList` receives its children as plain objects and controls which ones actually render:

```jsx
function SectionList({ children, context, refetchIds }) {
  const sections = React.Children.toArray(children)

  if (refetchIds) {
    return sections.filter(child => refetchIds.includes(child.props.id))
  }

  return sections
}
```

Only sections that survive the filter ever execute. React never calls `Reviews()` if it's filtered out.

#### Full Page Render

All sections render against the shared data context. The proxy collects all access patterns across all sections and compiles one query.

#### Section Re-fetch

```
Client: refetch({ sections: ['cart-drawer', 'header'] })
Server: resolves route data context (shared, same as full page)
Server: SectionList filters to requested sections only
Server: renders only those sections, returns RSC payload
Client: React reconciles — only those subtrees update, siblings keep state
```

The re-fetch request goes to the SAME URL with a sections parameter (like Shopify's `?sections=cart-drawer,header`). The server resolves the same route context but only renders the requested slices. No separate API, no query wiring, no cache coordination.

### 6. Mutations and Revalidation

Mutations are server actions. After a mutation, the system needs to know which sections to re-render.

#### Option A: Explicit Invalidation (v1)

The server action declares which sections are dirty:

```jsx
async function addToCart(productId) {
  'use server'
  await cart.add(productId)
  return { invalidate: ['cart-drawer', 'header-cart-count'] }
}
```

The client receives the invalidation list and triggers a section re-fetch for those IDs.

#### Option B: Implicit Invalidation (future)

The proxy knows which sections accessed which data paths. If `cart-drawer` and `header-cart-count` both accessed `cart.items`, mutating anything on `cart` automatically invalidates both sections. No manual declaration needed.

A server action wrapper could also automatically detect the section it's called from and invalidate that section by default.

#### Mutation Flow

```
User clicks "Add to Cart"
  → Server Action executes mutation
  → Returns { invalidate: ['cart-drawer', 'header-cart-count'] }
  → Client calls refetch({ sections: ['cart-drawer', 'header-cart-count'] })
  → Server re-renders those sections with fresh data context
  → Client reconciles, only affected subtrees update
```

## Open Questions

### Runtime / Framework

The section re-fetch endpoint, RSC streaming, and server actions all need a server runtime. Options:

- **Layer on top of Next.js:** Use Next.js for routing/RSC, add custom section middleware. Risk: Next.js's file-based routing and route-level assumptions may fight the section model.
- **Standalone minimal RSC framework:** Like Twofold or Waku. More control, less ecosystem.
- **Framework-agnostic library:** Build the proxy/section layer as a library that works with any RSC-capable host. Most flexible, hardest to build.

This needs exploration. The architecture doesn't depend on the choice — sections, proxies, and `use()` work the same regardless.

### Client-Side Section Re-rendering

When a section is re-fetched, the server returns an RSC payload. Can React reconcile a partial RSC payload into an existing tree without unmounting siblings? This works with `router.refresh()` (full page), but scoped to specific keyed subtrees it needs validation. If React's reconciler preserves unchanged keyed children naturally, this works. If not, a custom reconciliation layer is needed.

### Server Actions Returning JSX

Server Actions can technically return JSX in Next.js today. This could be the transport for section re-fetching — a Server Action that renders a filtered SectionList and returns the payload. But it's not a promoted pattern, there's no batching (Shopify supports up to 5 sections per request), and framework support may be fragile.

### Error Handling

When a deferred field fails to resolve, `use()` throws an error. This should be caught by an Error Boundary. Should `<Maybe>` include error boundary behavior by default? How does a developer distinguish "loading" from "failed" when both are invisible from the component's perspective?

### Schema Acquisition

The proxy needs the full GraphQL schema for mock generation and type awareness. This requires introspection of the target GraphQL backend. Questions:

- When does introspection happen? Build time? Server startup? Cached?
- How do schema changes propagate? If the backend adds a field, the proxy needs to know.
- Multiple backends? If data comes from Shopify AND Hygraph, the proxy needs a merged schema.

### Normalized Cache for Mutations

For implicit invalidation (Option B), the system needs to know which data paths map to which sections. A lightweight normalized cache (not full Apollo) could track this. But the interaction between a normalized cache and the proxy model needs design — they're both trying to manage data identity.

## Phases

### Phase 1: Proxy + Query Compilation

Build the schema-aware proxy that records access patterns and compiles GraphQL queries. Validate against a real GraphQL backend (Shopify Storefront API as first target, but architecture must be backend-agnostic). Prove that `use(product).title` works in a server component and generates correct queries.

### Phase 2: Section Architecture

Build SectionList with filtering. Prove that sections can be independently re-rendered on the server and reconciled on the client. Build the section re-fetch endpoint (likely a Server Action initially).

### Phase 3: Resolution Strategies

Implement deferred and lazy resolution. `@defer` support in the query compiler. IntersectionObserver-triggered resolution. Validate that the same field can resolve sync or async based on context.

### Phase 4: Mutations and Revalidation

Server action integration with explicit section invalidation. Prove the full cycle: render → mutate → selective re-render.

### Phase 5: Access Pattern Learning

Caching of discovered access patterns. Pre-seeding at build time. Runtime learning with supplemental fetches. Measure the cold start penalty and optimize.

### Future: Control Flow Compiler (v2)

If runtime learning proves insufficient (too many cold start penalties, too many supplemental fetches in production), build a Babel/SWC plugin that statically extracts access patterns from component source code. This eliminates the phantom render entirely but requires solving conditional branch analysis.

---

## Why the GraphQL Pipeline Was Set Aside

### What it was

The GraphQL Pipeline (`<GraphQLPipeline>`) was an attempt to integrate the proxy-based discovery pattern directly into the Partial architecture. It would wrap partial children, intercept them before rendering, run a phantom render to discover data needs, compile GraphQL queries, fetch data, then re-render with real data proxies — all transparently.

### Why it didn't work

**The proxy discovery pattern is fundamentally incompatible with the React component model.**

The pipeline needs to pre-render the component tree to record property accesses (the "phantom render"). But React components are opaque — you can't render them outside of React's reconciliation without losing:

1. **Component isolation.** Partials render as flat, independent siblings. The pipeline needed to call component functions directly to discover their data needs, but this breaks React's rendering model. A parent partial can never provide React context to a nested child partial — the flat rendering model enforces this.

2. **Decoupling.** Every approach to connect the pipeline to Partials created coupling:
   - **Pipeline-as-prop** (`<Partials pipeline={...}>`): Partials had to know about pipelines.
   - **Pipeline-as-marker-child** (`<Partials><GraphQLPipeline>...</GraphQLPipeline></Partials>`): Required Partials to detect the marker via static properties (`_isPipeline`, `_createPipeline`), intercept it, extract props, and run the pipeline internally. Still tangled.
   - **Pipeline-as-parent** (`<GraphQLPipeline><Partials>...</Partials></GraphQLPipeline>`): Would use AsyncLocalStorage to provide context. Conceptually clean, but the phantom render still needs to execute components outside React.

3. **Per-partial queries vs single query.** The pipeline compiled separate queries per partial (so refreshing one partial only fetches its data). But `resolve()` naturally compiles a single query from all accesses. Splitting queries per partial required the pipeline to understand partial boundaries — more coupling.

### What replaces it

The `resolve()` function already works: discovery → compile → fetch → render, all in one call. Components call `getQueryRoot()` to access the proxy. For pages, we need a classic GraphQL handler pattern where each partial explicitly fetches its own data using `resolve()` or a similar explicit query mechanism. The developer writes the query shape (via proxy access), not raw GraphQL strings.

The proxy data layer (`resolve()`, `getQueryRoot()`, `AccessRecorder`, `compileQuery`) remains fully functional. The Partials system remains a pure orchestrator: filtering, templates, client merge. They just don't auto-discover data from the component tree anymore.

### Status

- `src/lib/graphql-pipeline.tsx` — preserved but disconnected. Nothing imports it.
- `src/lib/partial.tsx` — pure orchestrator, no pipeline awareness.
- `resolve()` and `resolveData()` — working, tested, used in lifecycle tests.

### Revisiting later

The proxy-based auto-discovery idea isn't dead — it just needs a different execution model than "pre-render React components". Possibilities:
- **Build-time extraction:** A compiler plugin that statically analyzes component source to extract access patterns.
- **Tagged template literals:** Components declare data needs in a co-located template, not via rendering.
- **Explicit resolve blocks:** Components call `resolve()` at the top and render with the result — explicit but still proxy-powered.
