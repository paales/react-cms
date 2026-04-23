# React CMS — Partials + GraphQL

Research project: a React CMS data layer inspired by Shopify Liquid. Pages are composed of independently re-renderable server-rendered partials; data is fetched with hand-written GraphQL queries via `graphql-request`, typed end-to-end with [gql.tada](https://gql-tada.0no.co/).

> **Historical note:** an earlier iteration used a proxy-based data layer where field access _was_ the query. That design is preserved in `proxy-design/` and is no longer wired into the app. Do not reach for it.

## Project Structure

**Reading this repo:** the load-bearing code lives in `src/test/`, `src/lib/`, `src/framework/`, and `src/app/` — treat everything else as ignorable for understanding. For design decisions, read `notes/` **fully** (not just the README).

- `notes/` — current design notes. Read fully. Historical docs live in `archive/` (top-level).
- `src/lib/` — Partials library (`partial.tsx`, `partial-component.tsx`, `partial-client.tsx`, `partial-registry.ts`, `partial-request-state.ts`, `partial-error-boundary.tsx`, `cache.tsx`, `hash.ts`, `multipart.ts`, `partial-cache.ts`). Activator components (`WhenVisible`, `WhenStored`) live in userspace at `src/app/components/`.
- `src/framework/` — RSC plumbing (vite-plugin-rsc, Vite 8, React 19)
- `src/app/` — Example application (PokeAPI + Magento backends)
- `src/test/` — In-process RSC test harness (`rsc-server.ts`) and cross-tier fixtures.
- `proxy-design/` — legacy proxy data layer (see `proxy-design/README.md`).
- `user-ideas.md` — Ideas by the user.

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

A Partial is addressable via a CSS-style `selector` prop — `#foo` for unique tokens (one per page, hard-enforced), `.foo` for shared labels (any number, unions on refetch). Filter with `?partials=<name>` (unique tokens, sans `#`) or `?tags=<name>` (shared tokens, sans `.`). Refetch with `useNavigation().reload({ selector: "#cart .price" })` — see the **Client navigation** section below, and `notes/SELECTOR_API.md` for the full design.

### Partials must be server components

All `<Partial>` content must render in the RSC environment. Client components are only for interactivity (buttons, forms) nested inside partials. Deep Partials inside opaque async components (e.g. `.map()` inside a product list) are first-class — see the Dynamic Partials section below.

### Authoring

```tsx
<Partial selector="#header">
  <header>
    {new Date().toLocaleString()}
    <Partial selector="#cart .cart .header" fallback={<CartBadge quantity={"?"} />}>
      <CartPartial />
    </Partial>
  </header>
</Partial>

<Partial selector="#products" cache={{ maxAge: 60 }}>
  <ProductGrid search={search} />
</Partial>

{/* anonymous — addressable only via .ad-slot */}
<Partial selector=".ad-slot">
  <HouseAd />
</Partial>
```

No namespace. No `<Partials>` wrapper. No `key`.

- **`selector`** is required. A space-separated list (or array) of CSS-style tokens. Each token starts with `#` (unique per page; duplicates throw) or `.` (shared label; repeats allowed).
- **`#foo`** — unique token. Addressable via `reload({ selector: "#foo" })`. Multiple `#`-tokens on one Partial are allowed; each must still be unique page-wide.
- **`.foo`** — shared label. Addressable via `reload({ selector: ".foo" })` — refetches the union of every Partial carrying the label.
- A Partial with only `.`-tokens is **anonymous**: it synthesizes `__anon:<sorted-classes>` internally and is addressable only through its shared tokens. Two anonymous Partials with the same sorted `.`-token set collide and throw.

### Dynamic Partials (inside `.map()`)

A Partial produced inside an async component's return value (e.g. per-row in a product grid) is picked up the same as a statically-placed one. Each `<Partial>` render calls `<PartialBoundary>` which side-effects into a **route-scoped registry** (`src/lib/partial-registry.ts`); subsequent refetches consult the registry to resolve selector tokens without re-running ancestors. See `notes/DYNAMIC_PARTIAL_REGISTRY.md`.

### Fingerprints

Each Partial computes a structural fingerprint (hash of component types + scalar props + children shape). The client sends `?cached=id:fp,…` with every refetch. `<Partial>` skips (emits an `<i data-partial hidden>` placeholder) when its fingerprint matches what the client already has, so the browser fills from `_cache` and no bytes are wasted on unchanged subtrees.

### Client navigation — `useNavigation()`

The single client-side handle. Returned by `useNavigation()` (or `useNavigation(name)` for an explicit frame); drives page navigation, frame navigation, and targeted partial refetches. The handle **is** a `FrameworkNavigation` — a typed superset of the browser's `Navigation` — so everything you'd expect from `window.navigation` works, plus our extensions.

```tsx
const nav = useNavigation();          // page-scoped (or ambient frame if inside one)
const cart = useNavigation("cart");   // explicit: the cart frame

nav.navigate("/products?sort=price", { history: "push" });                // full page nav, string URL
nav.navigate(new URL("/checkout", location.href));                        // URL instance
nav.navigate(u => { u.searchParams.set("q", q); return u },               // updater callback
             { history: "replace", selector: ".search-results" });
nav.navigate(url,   { history: "replace", silent: true });                // URL update only, no refetch
nav.reload({ selector: "#cart" });                                         // targeted refetch (single Partial), no URL change
nav.reload({ selector: ".price" });                                        // shared-token refetch (union)
nav.reload({ selector: "#cart .price" });                                  // mix: refreshes #cart AND every .price
nav.back(); nav.forward(); nav.reload();                                   // inherited from Navigation

await nav.navigate(...).finished;                                          // wait for refetch to settle
```

`navigate`'s first arg (`NavigateTarget`) is `string | URL | ((current: URL) => URL | string)`. The updater receives an absolute `URL` — `window.location.href` for the window handle, or the frame URL synthesized against `window.location.origin` for a frame handle — so authors write the same code regardless of scope. Returning a cross-origin URL from a frame handle throws; from the window handle it goes through the browser's normal cross-origin behavior.

`navigate` / `reload` return `FrameworkNavigationResult` (`{ committed, finished }`, both non-optional). Use `.finished` when you need to wait on the refetch; `void nav.navigate(...)` for fire-and-forget.

`FrameworkNavigateOptions` extends the browser's `NavigationNavigateOptions`:

| Field               | Meaning                                                                                                                                                                                                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `history`           | `"push"` (default), `"replace"`, or `"auto"`. From `NavigationNavigateOptions`.                                                                                                                                                                                               |
| `state`             | State to write onto the resulting entry. From `NavigationNavigateOptions`.                                                                                                                                                                                                    |
| `info`              | Forwarded to navigate events. From `NavigationNavigateOptions`. Window handle only — frame handles stamp their own framework-internal `info` to suppress the page-level intercept.                                                                                            |
| `selector`          | CSS-style selector string (or array). `#foo` tokens target single Partials; `.foo` tokens union across every Partial with the label. Resolved server-side against the route-scoped registry. Page handle only; ignored by frame handles (frames refetch their whole subtree). |
| `silent`            | Update the URL only. No refetch. Useful for bookmarkability-only URL sync (infinite scroll's `?pages=`).                                                                                                                                                                      |
| `disableTransition` | Commit without wrapping in `startTransition` — fallbacks flash, chunks stream. Default `false` (atomic swap, no fallback).                                                                                                                                                    |

`nav.name` (framework-only, not on `Navigation`) is `null` for the window handle, the frame name for a frame handle. Lets a component render identically whether it's bound to the page or a frame. Read scope-aware state via `nav.currentEntry?.url` (absolute) and `nav.currentEntry?.getState()` (frame handles project to the frame's `__frameState[name]` bucket).

Multiple `navigate` / `reload` calls in the same tick coalesce into one microtask-batched refetch request. Frame `navigate(url)` is unchanged — it refetches the frame Partial, which re-renders its whole subtree. See `notes/NAVIGATE_UNIFIED.md` for the full surface and `notes/FRAMES.md` for frame mechanics.

**No `usePartial`, no `__inputs`, no `silentReplace`, no `usePartialParams`** (removed 2026-04-21; see `archive/USE_PARTIAL_AND_INPUTS.md`). State that drives a refetch must live in a URL — page URL for shareable state, frame URL for subtree-scoped state. The server reads it through tracked accessors (`getSearchParam` / `getPathname` / `getCookie` / `getHeader`). A parent that reads an accessor and passes a scalar prop to a descendant is the idiom when the descendant is cache-wrapped (Cache's inner render doesn't inherit the `React.cache`-backed frame-scope cell — see `notes/NAVIGATE_UNIFIED.md` §Sharp edges).

### Caching (`<Partial cache={…}>`)

`cache` opts a Partial into server-side render-output caching. The shape mirrors HTTP `Cache-Control`:

```tsx
<Partial selector="#products" cache={{ maxAge: 60, staleWhileRevalidate: 300 }}>
  <ProductGrid />
</Partial>
```

| Field                  | Meaning                                                                                                                                                         |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxAge`               | Fresh window (seconds).                                                                                                                                         |
| `staleWhileRevalidate` | Additional window where stale bytes are served while a background refresh runs.                                                                                 |
| `vary`                 | Scalar values that identify _which snapshot_ this is — for inputs the auto-tracker can't see (route params like `sku`, pre-computed values). Typed scalar-only. |
| `bypass`               | Skip caching this render (dev/preview escape hatch).                                                                                                            |

The cache key derives automatically from the Partial body's tracked accessor reads (`getCookie`, `getHeader`, `getSearchParam`, `getPathname` from `src/framework/context.ts`) plus any `vary` scalars. Authors don't restate dependencies — the runtime tracks them.

`getPathname("/p/:slug")` matches the current pathname against a pattern and returns the extracted params. It's the pattern-scaled answer to "my Partial depends on a path segment": two different products matching the same pattern hash distinct values via the matched params, but the pattern itself (not the resolved values) is what lives in the manifest — so a single snapshot in the route-scoped registry is fine. Prefer `getPathname` over closure-capturing the pathname into a prop for Partials that appear on high-cardinality routes like product detail pages. The zero-arg form was deliberately removed (see `notes/AUTO_TRACKED_CACHE_KEYS.md`) — the pattern is required so you can't accidentally key a cache on the full URL.

`getRequest()` is also exported but is **framework-only**: it returns the raw `Request` and does not participate in the cache manifest. Reserved for routing primitives (`framework/router.ts`) and framework internals that derive routes for storage. If you're writing an app-level Partial, read request state through the tracked accessors — `getRequest` inside a cached Partial body silently bypasses the cache key.

Tracked accessors must be called **unconditionally at the top of the body**, like React hooks. Reading a key that wasn't read on previous renders throws a `HoistingViolationError` synchronously — silent cache thrash is worse than a hard failure. See `notes/AUTO_TRACKED_CACHE_KEYS.md`.

Dynamic Partials inside a cached region stay live via strip-on-store / reinject-on-return. Inner Partial ids are folded into the key so adding/removing one invalidates automatically.

### Server action invalidation

Server actions return invalidation instructions:

```ts
return { invalidate: { selector: ".cart" } }; // shared-token: everything with .cart
return { invalidate: { selector: "#cart" } }; // unique token: just #cart
return { invalidate: { selector: "#nav .cart" } }; // mix: #nav plus every .cart
```

Tokens follow the `<Partial selector>` grammar. `#foo` matches a Partial whose selector contains that `#`-token; `.foo` matches every Partial whose selector contains that `.`-token (union).

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
  channel _and_ throw. Sync throws are caught by `Root`'s try/catch
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
nav.reload({ selector: "#stage-1 #stage-2 #stage-3", disableTransition: true });
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
yarn dev                # Start dev server (Vite 8 + RSC)
yarn test               # Vitest — runs the `node` + `rsc` projects
yarn test:node          # Only the jsdom project (fastest feedback)
yarn test:rsc           # Only the RSC project (server-component tree tests)
yarn test:browser       # Real Chromium via Vitest browser mode
yarn test:all           # All three Vitest projects
yarn test:watch         # Watch mode — node project
yarn test:watch:rsc     # Watch mode — rsc project
yarn test:e2e           # Playwright — end-to-end specs under e2e/
```

`yarn test` and `yarn test:e2e` cover disjoint suites — both must pass before a change is done. See `notes/TESTING_ARCHITECTURE.md` for the full tiering and when to pick each.

## Testing

Tests hit real GraphQL APIs (PokeAPI, GraphCommerce Magento). Timeout is 15-30s for integration tests.

**Four tiers, picked by glob:**

| Tier      | Glob                                     | What it's for                                    | Speed         |
| --------- | ---------------------------------------- | ------------------------------------------------ | ------------- |
| `node`    | `src/**/*.{test,spec}.?(c\|m)[jt]s?(x)`  | Unit tests, client hooks                         | ~2s           |
| `rsc`     | `src/**/*.rsc.test.?(c\|m)[jt]s?(x)`     | Server-component trees → Flight in-process       | ~1s           |
| `browser` | `src/**/*.browser.test.?(c\|m)[jt]s?(x)` | Real DOM primitives jsdom can't fake             | ~500ms        |
| e2e       | `e2e/**/*.spec.ts`                       | Full-stack browser assertions against `yarn dev` | ~30s parallel |

The RSC project needs `NODE_OPTIONS='--conditions=react-server'` to put `react` on the hook-less subset; the yarn scripts handle that. In-process RSC rendering uses the vendored Flight runtime directly via `src/test/rsc-server.ts` — `renderServerToFlight`, `consumePayload`, `renderWithRequest`. No dev server or subprocess required.

**Playwright runs fully parallel (`fullyParallel: true`).** Each worker stamps every request with an `x-test-scope: worker-<N>` header; the framework reads it in `framework/context.ts` (`deriveScope`) and buckets every process-wide state map by scope — `<Cache>` store, partial registry, session store, GraphQL cache, chat log, demo-page counters. Parallel workers never contend on shared state. See `notes/SERVER_ISOLATION.md` for the audit. Spec files import `test`/`expect`/`request` from `e2e/fixtures.ts` (not `@playwright/test` directly) so fixture overrides inject the header automatically.

**Dev-only `/__test/clear-caches` endpoint** (in `src/framework/entry.rsc.tsx`) clears state. By default it clears just the requesting worker's scope (via `x-test-scope`); `?all=1` wipes every scope — what the debug toolbar flush button does (`src/app/components/debug-toolbar.tsx`). Used by `test.beforeEach` in specs that need a cold starting state — particularly anything asserting Suspense fallback behavior.

**Vitest's route-keyed fixtures need a registry reset.** `partial.test.tsx` has a top-level `beforeEach(clearRegistry)` because dynamic partials registered under the fake URL (`http://localhost/test`) otherwise leak across tests and contaminate tag resolution.

## Workflow — after a task is done

When a non-trivial task reaches a clean end state (feature landed, bug fixed, refactor finished) AND `yarn test` + `yarn test:e2e` are both green, close the loop before moving on:

1. **Update the notes.** Find every doc that references the old behavior or lists the problem as open — `notes/*.md`, `CLAUDE.md` (this file — §Future tasks, architecture sections), `user-ideas.md`, `notes/IDEAS.md` — and amend them to match the new reality. Mark resolved items with a `— RESOLVED YYYY-MM-DD` banner pointing to where the work landed (the existing `notes/IDEAS.md` entries model this). Don't delete the history; the resolution trail is how future readers understand why a thing is the way it is.
2. **Move stale docs to `archive/`.** A doc earns archival when its design is no longer wired in OR has been fully superseded by a newer doc. Add an index line in `archive/README.md` pointing to the replacement. Do not archive anything whose insights still live in current code.
3. **Confirm the test suites are actually green.** `yarn test` and `yarn test:e2e` — both, from a clean working tree (known parallel-load flakes excepted; check against isolation). Don't commit red.
4. **Commit.** One commit per logical change, focused on the WHY, not the WHAT (the diff tells the what). Include docs + tests alongside the code. Prefer a short imperative subject (under 70 chars) and a body that captures the motivation + any non-obvious tradeoff. Do not amend; do not `--no-verify`.

The two tests tiers and the notes surface are load-bearing for this project — a fix without the corresponding doc/test update is incomplete work, not a finished task.

## APIs

| API           | Endpoint                                       | Used for                      |
| ------------- | ---------------------------------------------- | ----------------------------- |
| PokeAPI       | `https://beta.pokeapi.co/graphql/v1beta`       | Primary example (Hasura)      |
| GraphCommerce | `https://graphcommerce.vercel.app/api/graphql` | Magento 2 (mutations, @defer) |
