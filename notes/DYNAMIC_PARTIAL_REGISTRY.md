# Dynamic Partial Registry — design notes

**Added:** 2026-04-16
**Files:** `src/lib/partial-registry.ts`, `src/lib/partial-component.tsx`, `src/lib/partial.tsx`
**Related:** `PARTIAL_WRAPPER_DESIGN.md` (baseline `<Partial>` API), `SERVER_CACHE_NOTES.md` (composition with `<Cache>`)

---

## 1. The gap

`<PartialRoot>` discovers partials by walking the JSX tree through the
`.props.children` chain — `collectPartials` in `partial.tsx`. That walk
doesn't execute function components, so it only finds `<Partial>`
elements that:

1. Are direct children of `<PartialRoot>`, its descendants in
   structural wrappers (`<html>`, `<body>`, `<Fragment>`), or
2. Are passed *as the `children` prop* to another element (structural
   or component).

That misses the canonical CMS pattern of a product list producing one
partial per row:

```tsx
async function ProductList() {
  const products = await fetchProducts();
  return products.map(p => (
    <ProductItem
      key={p.sku}
      product={p}
      // ↓ Partial is produced inside ProductList's *return value*,
      //   not passed as ProductList's children prop.
      price={<Partial id={`price-${p.sku}`}><GoldPrice sku={p.sku}/></Partial>}
    />
  ));
}
```

`<ProductList/>` is a leaf to `collectPartials` (no `.children` prop).
Every `price-<sku>` Partial is invisible to the static walker. Before
the registry, that meant:

- `?partials=price-X` refetches had nothing to route to — the page
  came back empty.
- `?tags=price` couldn't resolve, because the tag index was built
  from the static walk too.
- Server-action invalidations by id never matched.

## 2. The design in one paragraph

The `<Partial>` component self-wraps with `<PartialBoundary>`, which
is a thin server-only pass-through. When React renders `PartialBoundary`
(which only happens for *dynamic* partials — `transformForStreaming`
replaces static ones outright), it side-effects into a module-level
**route-scoped registry** keyed by `(pathname, partialId)`. Subsequent
refetches in `<PartialRoot>` consult the registry to resolve ids and
tags that `collectPartials` didn't see. A registry miss falls back to
a full streaming render.

## 3. Data

```ts
// src/lib/partial-registry.ts
interface PartialSnapshot {
  content: ReactNode;                 // the original children JSX
  fallback: ReactNode;
  errorWith: ReactNode | undefined;
  tags: string[];
}

const registry = new Map<string, Map<string, PartialSnapshot>>();
//                       ^ route-path        ^ partial id
```

Exposed functions: `registerPartial`, `lookupPartial`,
`getRouteSnapshots`, `clearRegistry`, `_registryStats`. HMR listener
clears the registry on `vite:beforeUpdate` / `vite:beforeFullReload`
so stale module references don't persist across edits.

## 4. Who populates it

Two paths, both write through `registerPartial`:

**Static path** — `PartialRoot` calls it directly after
`collectPartials`, before rendering:

```ts
for (const entry of allPartials) {
  registerPartial(routePath, entry.id, {
    content: entry.content, fallback: entry.fallback,
    errorWith: entry.errorWith, tags: entry.tags,
  });
}
```

**Dynamic path** — `<Partial>` self-wraps in `PartialBoundary`, which
registers as a side effect during render:

```tsx
// partial-component.tsx
export function Partial({ id, children, fallback, errorWith, tags }) {
  return (
    <PartialBoundary
      id={id}
      content={children}
      fallback={fallback ?? null}
      errorWith={errorWith}
      tags={tags ?? []}
    >
      <Suspense key={id} fallback={/* … */}>
        <PartialErrorBoundary partialId={id} fallback={errorWith}>
          {children}
        </PartialErrorBoundary>
      </Suspense>
    </PartialBoundary>
  );
}

export function PartialBoundary({ id, content, fallback, errorWith, tags, children }) {
  const route = new URL(getRequest().url).pathname;
  registerPartial(route, id, { content, fallback, errorWith, tags });
  return children;          // pass-through
}
```

For *static* partials `transformForStreaming` replaces `<Partial>`
with a Suspense/ErrorBoundary chain *before* React renders, so the
`Partial` function body never runs. The registry entry for static
partials comes from `PartialRoot`'s direct call. For *dynamic*
partials, `transformForStreaming` can't see them; React renders the
`<Partial>` element directly; its body runs, wraps, and
`PartialBoundary` side-effects in.

Two paths, one registry — `registerPartial` just overwrites. If a
partial is visible both statically *and* as a dynamically-rendered
copy, static wins because it runs first. The content is identical
either way.

## 5. Who consults it

`PartialRoot` in cache mode, at two junction points:

### 5.1 Id resolution (registry supplement)

After computing `effectiveRequestedIds` from `?partials=` and
`?tags=`, supplement the active entries for any id that's missing
from the static tree:

```ts
const staticIds = new Set(allPartials.map(e => e.id));
const registrySupplement: PartialEntry[] = [];
let registryMiss = false;
if (effectiveRequestedIds && !populateCache) {
  for (const id of effectiveRequestedIds) {
    if (staticIds.has(id)) continue;
    const snap = lookupPartial(routePath, id);
    if (snap) {
      registrySupplement.push({
        id, content: snap.content, depth: 0, tags: [],
        cacheTtl: 0, fallback: snap.fallback, errorWith: snap.errorWith,
      });
    } else {
      registryMiss = true;   // fall back to full render below
      break;
    }
  }
}
if (registryMiss) effectiveRequestedIds = null;   // full fresh render
```

### 5.2 Tag resolution

The tag index is built from *both* the static tree and the route
registry, so `?tags=price` picks up every `price-<sku>` dynamically-
produced `<Partial tags={["price"]}>`:

```ts
for (const entry of allPartials) for (const tag of entry.tags) addTag(tag, entry.id);
const routeSnapshots = getRouteSnapshots(requestUrl.pathname);
if (routeSnapshots) {
  for (const [id, snap] of routeSnapshots) {
    for (const tag of snap.tags) addTag(tag, id);
  }
}
```

## 6. Client-side: keyed Suspense preservation

For the client's `cacheFromStreamingChildren` / `substituteNested`
walkers to find a dynamic partial at refetch time, something in the
rendered tree has to carry a key that survives the Flight boundary.
`PartialBoundary` is a server component — it dissolves during
serialization. The `<Suspense key={id}>` inside `Partial`'s self-wrap
is a React built-in and **does** preserve its key across Flight.
`cacheFromStreamingChildren` strips the trailing `#<version>` (if
any) and uses the prefix as the partial id.

This is why `Partial`'s self-wrap wraps in `Suspense` even when the
author passed no `fallback` prop — the key has to survive.

## 7. Registry-miss fallback

If `effectiveRequestedIds` contains an id that's neither in the
static tree nor the registry, the partial is genuinely unknown on
this route — either the user clicked a stale ref button, or the
conditional JSX that produced it no longer reaches that branch.
Instead of returning an empty partial, `PartialRoot` **forces a
full streaming render**:

```ts
if (!isPartialRefetch || populateCache || registryMiss) {
  return <PartialsClient mode="streaming" …>{transformForStreaming(…)}</PartialsClient>;
}
```

Navigation-like behavior: the client reconciles against a fresh
tree, the stale partial just isn't there anymore. Plus: every live
partial on the route registers itself during that fresh render, so
the next refetch can resolve by id again.

## 8. Persistence + HMR

Registry is **module-level, per Node process**. No cross-request
cleanup. A partial registered on route `/magento` during an earlier
request stays registered for subsequent requests to `/magento`
until:

- The process restarts.
- HMR fires `vite:beforeUpdate` / `vite:beforeFullReload` (dev).
- Explicit `clearRegistry()` via `/__test/clear-caches` (dev-only
  endpoint used by e2e tests for deterministic cold-state runs).

Cross-request persistence is **desired**: the registry is an
availability index, not per-request state. Two users concurrently
refetching `price-X` on `/magento` both hit the same snapshot.

For unit tests: the registry is route-keyed, and test fixtures tend
to reuse the same fake URL (`http://localhost/test`), so entries
from one test leak into the next. `partial.test.tsx` has a
top-level `beforeEach(clearRegistry)` to neutralize this.

## 9. What the registry does *not* do

**It doesn't skip ancestor execution.** On a dynamic-partial refetch
(`?partials=price-X`), the server looks up `price-X` in the registry
and adds it to `activeEntries`. But the template (built from the
route's JSX) still includes `<ProductList/>` as a leaf, and
rendering the template re-runs ProductList — which fetches all
products, produces all Partials, and registers them again. The
registry prevents *empty responses* for dynamic refetches; it does
not prevent the cost of running the ancestor to produce the DOM
scaffolding.

To actually skip ancestor execution, wrap the producer in `<Cache>`:

```tsx
<Partial id="products">
  <Cache id="products" dep={{ search }}>
    <ProductList />
  </Cache>
</Partial>
```

On a cache hit, ProductList doesn't run. The cached bytes contain
keyed Suspense elements for each dynamic partial. Client-side
`substituteNested` (with the lazy-ref unwrap added in
`STREAMING_DEBUG_NOTES.md · 2026-04-16`) descends into the cached
subtree, finds `<Suspense key="price-X">`, and swaps in the fresh
content.

## 10. Trust boundary note

The `content` field of a `PartialSnapshot` is a captured React
element with bound props — e.g. `<GoldPrice sku="123"/>`. Server
renders the snapshot with optional `__inputs` overrides supplied by
the client via `usePartial(id).refetch(props)`. Props that travel
from client to server are user-controllable; the partial's content
component must validate its own inputs. This is the same trust
model as today's `__inputs` mechanism. The *type* (e.g. `GoldPrice`
function reference) stays server-side in the registry — only props
are client-mutable.
