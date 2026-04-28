# `<Partial>`

The framework's only public render primitive. Every Partial is a
Server Component wrapper that registers a snapshot of its content,
computes a structural fingerprint, opens scopes for nested behavior
(frame, CMS, manifest), and decides at render time whether to emit
fresh content or a placeholder.

```tsx
import { Partial, ROOT, capturePartialContext } from "./lib";

<Partial parent={ROOT} selector="#cart" fallback={<CartSkeleton />}>
  <Cart />
</Partial>;
```

## Props

```ts
interface PartialProps {
  parent: PartialCtx; // required
  selector: SelectorToken | SelectorToken[]; // required
  children?: ReactNode;
  fallback?: ReactNode;
  errorWith?: ReactNode;
  defer?: true | ReactElement<ActivatorProps>;
  cache?: CacheOptions; // see cache.md
  frame?: string; // see frames-navigation.md
  frameUrl?: string;
  cmsId?: string; // see cms.md
  provides?: Readonly<Record<string, unknown>>;
}
```

`PartialRoot` (`src/lib/partial.tsx`) wraps the entire app once at the
top of `<Root>`; page authors never render it. `<Partial>` itself can
appear anywhere — at the top of a route, inside another Partial, deep
inside a `.map()` in an async server component. Every call goes
through the same body, makes the same decisions, registers the same
snapshot shape.

## `selector` — addressing

CSS-style. A space-separated string (or array of tokens). Each token
must start with `#` or `.`:

- **`#foo`** — a unique token. Validated at render time: a second
  `<Partial>` with the same `#`-token throws synchronously. A Partial
  may carry multiple `#`-tokens (`selector="#cart #header-cart"`),
  each unique page-wide.
- **`.foo`** — a shared label. Any number of Partials may carry it.
  Refetches with `.foo` union across every Partial that has it.

A Partial without any `#`-token is **anonymous**: its effective id is
synthesized as `__anon:<sorted-classes>`. Two anonymous Partials with
the same sorted `.`-token set collide and throw — give one a
distinguishing class or a `#`-token.

Effective id derivation (see `resolveEffectiveId` in
`partial-component.tsx`):

| Selector              | Effective id                      |
| --------------------- | --------------------------------- |
| `#cart`               | `cart`                            |
| `#cart #primary-cart` | `cart,primary-cart` (sorted-join) |
| `.price .product`     | `__anon:price,product`            |
| `#cart .price`        | `cart`                            |

The effective id is what the registry, client cache, and cache base
key are keyed on. Refetch addressing scans `uniqueTokens` /
`sharedTokens` independently of the effective id — `reload({ selector:
"#cart" })` matches a Partial whose `uniqueTokens` includes `cart`
even when its effective id is `cart,primary-cart`.

**Authoring parallel.** `selector` lines up with `className`:

```tsx
<div className="btn btn-primary" id="hero">
<Partial selector="#hero .btn .btn-primary">
```

Space is union (both on the prop and in `reload({ selector })`), not
the descendant combinator. Comma is not part of the grammar.

## `parent` — tracking the tree

**Required.** Pass `ROOT` at the top of the page tree. Pass
`capturePartialContext()` (in a sync code path) or a `parent` prop
threaded down from a caller for any nested Partial.

```tsx
function Page() {
  return (
    <Partial parent={ROOT} selector="#products">
      <ProductGrid parent={capturePartialContext()} />
    </Partial>
  );
}

async function ProductGrid({ parent }: { parent: PartialCtx }) {
  const items = await fetchProducts();
  return items.map((p) => (
    <Partial parent={parent} selector=".product" cmsId={`product-${p.sku}`}>
      <ProductCard p={p} />
    </Partial>
  ));
}
```

### Why required

React Server Components don't render in JSX-traversal order. Once an
async component hits `await`, React schedules sibling subtrees;
resumes happen as promises resolve. A single per-request cell that
tracks "who is the current parent" drifts whenever a sibling Partial
runs between an ancestor's setup and its descendant's body.

Until TC39 AsyncContext lands, the cell can't be made reliable. The
framework works around it by making the author thread the token
explicitly. Inside a synchronous body the per-request cell is fine —
`capturePartialContext()` reads it. Inside an async body, capture
**before any `await`** or accept `parent` as a prop:

```tsx
async function Wrong() {
  await something();
  const parent = capturePartialContext(); // cell may have drifted
  return (
    <Partial parent={parent} selector="#x">
      <X />
    </Partial>
  );
}

async function Right() {
  const parent = capturePartialContext(); // captured at sync top
  await something();
  return (
    <Partial parent={parent} selector="#x">
      <X />
    </Partial>
  );
}
```

### What it carries

```ts
interface PartialCtx {
  readonly path: readonly string[]; // ancestor effective ids, outer-first
  readonly frameChain: readonly string[]; // ancestor frame names, outer-first
  readonly provides: Readonly<Record<string, unknown>>;
}
```

`path` lands on the snapshot's `parentPath` so cache-mode refetches
know where the Partial sits in the tree. `frameChain` resolves the
ambient frame URL when the Partial is inside one or more
`<Partial frame="…">` ancestors. `provides` carries the merged
ancestor-contributed context bag (see §`provides` below).

**`ROOT` is for the outermost Partials only.** Passing `ROOT` to a
nested Partial bypasses the ancestor chain; nested-frame addressing
breaks, ancestor `provides` don't reach descendants. Always prefer
`capturePartialContext()` or a threaded prop unless you're at the
tree root.

## `children` — content

Must render in the RSC environment. Client components are allowed
_inside_ a Partial for interactivity, but the Partial body itself
runs server-side. The content can be async; any unresolved promises
block the Partial's Suspense boundary, the rest of the page streams
around them.

When `fallback` is set, the Partial wraps in `<Suspense>` so the
fallback shows during async work. When `fallback` is unset and the
content is async, the Suspense boundary lives elsewhere (or nowhere)
and the parent's reveal blocks on it.

## `fallback` and `errorWith`

```tsx
<Partial selector="#cart" fallback={<CartSkeleton />} errorWith={<CartError />}>
  <Cart />
</Partial>
```

| Prop        | Used for                                                                                                             |
| ----------- | -------------------------------------------------------------------------------------------------------------------- |
| `fallback`  | Suspense fallback while async content resolves. Also the dormant display when `defer` is active.                     |
| `errorWith` | Error-boundary fallback when the body or any descendant throws. Defaults to a built-in red card with a retry button. |

`PartialErrorBoundary` re-throws framework sentinels (`notFound()`,
`redirect()`) past `errorWith`, so a deep async throw still surfaces
through the framework-control channel and produces a 404 / 302 at the
HTTP layer.

## Fingerprint

Every render computes a structural hash. The client sends it back as
`?cached=id:fp,…` on every refetch; if the server's recomputed fp
matches, the Partial emits a 3-byte placeholder
(`<i hidden data-partial>`) and the client paints from `_cache`.

The fp folds in everything that could change the rendered output
without the JSX shape itself changing:

- The structural shape of `children` (component types, scalar props,
  recursion). Function and object props are skipped.
- Own frame URL (when `frame` is set).
- Ambient frame URL (when nested inside a frame, but only for
  Partials that DON'T open their own frame — a self-framing Partial
  isolates from sibling-leak corruption).
- The CMS resolved field map for `cmsId` (recursively including slot
  children's resolved fields), so an author edit invalidates the fp
  even when the JSX is unchanged.
- The previous render's manifest of tracked-accessor reads, resolved
  against the current request — covers `getCookie` / `getHeader` /
  `getSearchParam` / `getPathname` reads inside the body.
- The transitive descendants' manifests, walked via the previous
  render's registry plus the static `rawContent` JSX. An ancestor
  whose own JSX is unchanged still invalidates when a descendant's
  URL dep changes.

**Two fp variants are computed.** `structuralFp` excludes the ambient
frame URL — it's what `<Cache>` uses for its base key, so cache keys
stay stable across full vs. cache-mode renders (which differ in
whether the per-request frame cell happens to be set). `fp` includes
ambient — used for the client skip handshake, where ambient changes
must invalidate.

Explicitly-requested ids (in `?partials=`) never skip on fingerprint
match — they're what the caller asked for.

## `defer` — dormant rendering

```tsx
<Partial selector="#feed" fallback={<FeedSkeleton />} defer={<WhenVisible rootMargin="200px" />}>
  <Feed />
</Partial>
```

Three modes:

| Value           | Behavior                                                                                                                                             |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| unset / `false` | Eager render.                                                                                                                                        |
| `true`          | Emit fallback only; no automatic trigger. App calls `useNavigation().reload({ selector: "#feed" })` somewhere.                                       |
| `ReactElement`  | The framework `cloneElement`s with `{partialId, children: fallback}`. Activator renders the fallback and installs its own trigger via `useActivate`. |

### `useActivate(partialId, subscribe, opts?)`

The primitive every activator is built on.

```ts
"use client";
export function WhenVisible({ partialId, children, rootMargin = "0px" }: ActivatorProps & { rootMargin?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useActivate(partialId!, (fire) => {
    if (!ref.current) return;
    const obs = new IntersectionObserver(
      (e) => e.some(x => x.isIntersecting) && fire(),
      { rootMargin },
    );
    obs.observe(ref.current);
    return () => obs.disconnect();
  });
  return <div ref={ref}>{children}</div>;
}
```

`fire()` dispatches a microtask-batched targeted refetch of `partialId`
as a `#`-token. `subscribe` is captured via ref so the latest closure
fires; the effect itself doesn't re-run when subscribe changes
(`key`-remount the activator if you need to re-subscribe). Default is
one-shot — pass `{ once: false }` to fire repeatedly.

**Activators that need to pass state to the server write it to a
URL first.** The subscribe runs inside `useEffect` so it can't call
`useNavigation()` itself; thread the handle in from the surrounding
component's render and close over it.

```tsx
export function WhenStored({ partialId, children, storageKey, as }: …) {
  const nav = useNavigation();
  useActivate(partialId!, (fire) => {
    const value = localStorage.getItem(storageKey);
    if (value == null) return;
    void nav
      .navigate(u => { u.searchParams.set(as, value); return u },
                { history: "replace", silent: true })
      .finished
      .then(fire);
  });
  return children;
}
```

The Partial body re-runs on the refetch; `getSearchParam(as)` reads
the just-written value.

Reference activators live in userspace (`src/app/components/`).
Adding a new trigger type (`<WhenIdle>`, `<WhenMediaQuery>`,
`<WhenEvent>`) is ~20-30 lines.

## `provides` — ancestor context

```tsx
<Partial parent={ROOT} selector="#pdp" provides={{ product: await fetchProduct(slug) }}>
  <ProductDetail />
</Partial>
```

Descendants read via `getClosest<T>(key)`:

```ts
import { getClosest } from "./framework/context.ts";

export async function ReviewsBlock() {
  const product = getClosest<Product>("product");
  if (!product) return null;
  const reviews = await fetchReviews(product.id);
  // ...
}
```

`provides` merges into descendant `PartialCtx.provides`; child entries
override parent entries of the same key.

**Cache-mode refetch limitation.** Snapshots don't re-derive ancestor
`provides` — when a Partial runs from its snapshot, its
`getClosest(key)` reads return null for keys that came from an
ancestor that didn't re-execute. Blocks that must survive a cache-mode
refetch should also carry a concrete `getReference` value or branch
on the missing closest.

## `frame`, `frameUrl`, `cache`, `cmsId`

Pointer-only here:

| Prop                 | Doc                    |
| -------------------- | ---------------------- |
| `frame` / `frameUrl` | `frames-navigation.md` |
| `cache`              | `cache.md`             |
| `cmsId`              | `cms.md`               |

## Authoring rules

1. **Read tracked accessors at the synchronous top of the body**,
   before any `await`. The same set of keys must be read on every
   render. A new key on a later render throws
   `HoistingViolationError`.

2. **Capture `parent` at the sync top** when not threading it as a
   prop. Capturing post-`await` is silently wrong — the per-request
   cell may have drifted to a sibling.

3. **Don't put a `<Partial>` inside a client component.** Partials
   must render in the RSC environment.

4. **Don't pass `key={id}` on a `<Partial>` produced inside a
   `.map()`.** Flight composites the outer key with the inner
   `<Suspense key={id}>` into `"id,id"` on the wire, and the client
   reconciles it as a different identity than the plain `"id"` from
   streaming mode — remounting state inside the Partial. Wrap in a
   keyed `<Fragment>` if you need an array key:

   ```tsx
   {
     items.map((item) => (
       <Fragment key={item.id}>
         <Partial parent={parent} selector={`#item-${item.id}`}>
           <Item item={item} />
         </Partial>
       </Fragment>
     ));
   }
   ```

   The `<Children>` slot primitive (`src/lib/slot.tsx`) does this
   automatically for CMS-rendered blocks.

## Sharp edges

- **Sibling leak in the per-request cells.** Frame-scope, CMS-scope,
  and partial-manifest cells are React.cache-backed, mutable, and
  shared across the request. Two sibling Partials interleave their
  bodies across awaits; whichever ran most recently is what the cell
  shows. The Partial body resets these cells on entry from its
  explicitly-threaded `parent.frameChain` / `cmsId` — **provided the
  author threads `parent` correctly across awaits**. A
  `parent={ROOT}` on a Partial actually nested inside another Partial
  bypasses the reset and exposes the bug.

- **`HoistingViolationError` self-recovers.** When a tracked accessor
  reads a key the previous render didn't see, the throw fires and
  the framework drops that Partial's snapshot from both the current
  and previous-render registries. The next render starts with
  `stored = null` and won't re-trip the same comparison. Browsers
  refresh recovers without HMR or a server restart — but the dev
  still has to fix the underlying conditional read or post-await
  read.

- **Snapshots are captured JSX with bound props.** A Partial inside a
  `.map()` over `products` snapshots `<ProductHero sku="abc"/>` —
  the `sku` is baked in. Changing `sku` requires a fresh ancestor
  render (streaming mode); cache-mode refetches replay the snapshot
  with the same closure. Dynamic per-request data should flow through
  tracked accessors, not closure-captured props, when the Partial
  needs to vary per refetch.

- **Anonymous Partials and cache stability.** A `cache`-bearing
  Partial without a `#`-token keys its cache entry on
  `__anon:<sorted-classes>`. Legal, but a class rename silently
  changes the cache key. Prefer `#`-tokens on cache-bearing Partials.
