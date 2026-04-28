# Frames and navigation

`useNavigation()` is the single client surface for everything that
moves data on a page: full-page navigation, targeted partial refetch,
silent URL sync, and frame navigation. The handle it returns is a
typed superset of `window.navigation` — every method on the browser
`Navigation` object works, plus framework extensions.

A **frame** is a `<Partial frame="name">` that opens its own URL
scope. Tracked accessors inside the frame resolve against the
**frame's URL** (session-backed), not the page URL. The frame has
its own navigation stack, its own back/forward, and its state lives
on the same browser entry as the page so a refresh restores the
whole scene.

## `useNavigation()`

```ts
import { useNavigation } from "./lib";

const nav = useNavigation(); // window-scoped, or ambient frame
const cart = useNavigation("cart"); // explicit frame by name
const list = useNavigation("products.list"); // nested frame, dotted path
```

| Argument                              | Returns                                                        |
| ------------------------------------- | -------------------------------------------------------------- |
| omitted, outside any frame            | window handle (binds to `window.navigation`)                   |
| omitted, inside `<Partial frame="X">` | handle for the innermost ambient frame, via `FrameNameContext` |
| explicit dotted path                  | handle for that frame, regardless of context                   |

The handle's reactive getters (`currentEntry`, `canGoBack`,
`canGoForward`) re-read after every navigation and frame state
update. The handle reference is memoized, so a consumer effect with
`[nav]` in its dep list only re-runs when the bound name changes.

`nav.name` (framework-only, not on `Navigation`) is `null` for the
window handle, the frame's dotted path for a frame handle. Lets a
component render identically whether bound to the page or a frame:

```tsx
function ReloadButton() {
  const nav = useNavigation();
  return <button onClick={() => nav.reload()}>Reload {nav.name ?? "page"}</button>;
}
```

## `navigate(target, options?)`

```ts
nav.navigate("/products?sort=price");
nav.navigate(new URL("/checkout", location.href));
nav.navigate((u) => {
  u.searchParams.set("q", q);
  return u;
});

nav.navigate(url, { history: "replace" });
nav.navigate(url, { history: "replace", silent: true });
nav.navigate(url, { history: "replace", selector: ".search-results" });
```

`target` accepts `string | URL | ((current: URL) => URL | string)`.
The updater receives an absolute URL — `new URL(window.location.href)`
on the window handle, or the frame URL synthesized against
`window.location.origin` on a frame handle — so the same updater
code works in both scopes. Returning a cross-origin URL from a frame
handle throws; from the window handle it goes through the browser's
normal cross-origin behavior.

### Options

| Field               | Meaning                                                                                                                                                                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `history`           | `"push"` (default), `"replace"`, or `"auto"`. From the browser `NavigationNavigateOptions`. Frame handles default to `"auto"` — see §Two history axes below.                                                                                                                    |
| `state`             | State to write onto the resulting entry. From `NavigationNavigateOptions`.                                                                                                                                                                                                      |
| `info`              | Forwarded to the `navigate` event. Window handle only — frame handles stamp their own framework-internal `info` to suppress the page-level intercept.                                                                                                                           |
| `selector`          | CSS-style selector (string or array). `#unique` tokens target single Partials; `.shared` tokens union across every Partial with the label. Resolved server-side against the route registry. **Page handle only**; frame handles ignore it (frames refetch their whole subtree). |
| `silent`            | Update the URL only. No refetch. Useful for bookmarkability-only URL sync.                                                                                                                                                                                                      |
| `disableTransition` | Commit without `startTransition`. See §Refetch commit behavior below.                                                                                                                                                                                                           |

### Decision matrix (window handle)

| `silent` | `selector` | Behavior                                                                                                                            |
| -------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `true`   | —          | URL update only, no refetch.                                                                                                        |
| `false`  | set        | URL update + targeted refetch (microtask-batched). Page-level intercept skipped.                                                    |
| `false`  | unset      | Default page nav. Browser fires `navigate`; the framework's intercept fetches the new URL with `?cached=` and commits the response. |

### Result

`navigate` and `reload` return `FrameworkNavigationResult`:

```ts
interface FrameworkNavigationResult {
  readonly committed: Promise<NavigationHistoryEntry>;
  readonly finished: Promise<NavigationHistoryEntry>;
}
```

Both fields are non-optional. `await nav.navigate(...).finished`
when you need to wait for the refetch (and any composed framework
work) to settle. `void nav.navigate(...)` for fire-and-forget;
AbortError on superseded navs is swallowed silently so it doesn't
surface as an unhandled rejection.

## `reload(options?)`

Refetch the current URL without changing it.

```ts
nav.reload(); // full-page refetch
nav.reload({ selector: "#cart" }); // single Partial
nav.reload({ selector: ".price" }); // every Partial with .price
nav.reload({ selector: "#cart .price" }); // both — union
```

Options are the same as `navigate` minus `silent` (reload has no URL
change to be silent about).

## Selector semantics on the wire

The client dispatcher parses the selector into `#`-tokens and
`.`-tokens, then splits them across the wire:

```
GET /products?partials=cart,header&tags=price&cached=cart:abc,nav:def&disableTransition=1
```

- `?partials=` carries `#`-token names (sans `#`).
- `?tags=` carries `.`-token names (sans `.`).
- `?cached=id:fp,…` carries every fingerprint the client has,
  except for ids being explicitly targeted (those would skip on
  fingerprint-match and defeat the request).

Multiple `reload` / `navigate({ selector })` calls within the same
microtask coalesce into one request. The server resolves the
selector union against its route-scoped registry: `#`-token names
match snapshots' `uniqueTokens`; `.`-token names match
`sharedTokens`. Union semantics across both.

A `#`-token that doesn't resolve triggers the **registry-miss
bailout** — the server drops the filter and runs the whole tree,
re-populating the registry as Partials run. Covers cold processes,
range-expanding paginators, conditional Partials that haven't
rendered yet. `.`-tokens never trigger the bailout — a tag union that
resolves to a subset of known snapshots is valid.

## Refetch commit behavior

Refetches commit through one of two paths in `entry.browser.tsx`:

- **Default — `setPayload`** (wrapped in `React.startTransition`).
  React holds the current UI visible until all pending children
  resolve, then atomic-swaps the new payload in. No Suspense
  fallback flash, no per-chunk streaming. Pair with `isPending` on
  the trigger button. Right for "swap a value" UX (cart badge, live
  price).

- **`disableTransition: true` — `setPayloadRaw`**. Plain `setState`
  outside any transition. React shows Suspense fallbacks for pending
  children and commits Flight chunks as they arrive. Per-row
  progressive streaming. Right for search results, multi-stage
  reveals, or concurrent refetches across disjoint ids that should
  each commit on arrival rather than collapsing into one transition.

## `<Partial frame="name">`

```tsx
<Partial selector="#cart" frame="cart" frameUrl="/cart/closed">
  <CartSection />
</Partial>
```

Inside the frame, every tracked accessor (`getSearchParam`,
`getPathname`, `getCookie`, `getHeader`) resolves against the
**frame's URL** instead of the page's. The frame URL comes from, in
order:

1. The server session entry for this frame's dotted path.
2. The `frameUrl` prop (initial URL).
3. The page request (frame and page agree — no-op frame).

Frames don't carry their own cookies — they use the page's. A frame
Request is constructed from the page request's headers + the
resolved frame URL.

### Nesting

Frames compose. A `<Partial frame="list">` inside a
`<Partial frame="products">` ancestor has the dotted path
`"products.list"` — its session key, its `__frameHistory` slot, and
its `useNavigation("products.list")` lookup all use that path. Two
`<Partial frame="list">`s under different parents
(`products.list` vs `blog.list`) coexist without colliding.

The dotted path is built by the framework from `parent.frameChain`,
which authors thread via `parent={capturePartialContext()}`:

```tsx
<Partial parent={ROOT} selector="#products" frame="products">
  <Partial parent={capturePartialContext()} selector="#list" frame="list">
    <ProductList /> {/* frame URL = session["products.list"] */}
  </Partial>
</Partial>
```

### Frame name and selector convention

The frame's root Partial should carry `#<frameName>` as one of its
selector tokens. The client's frame-refetch dispatcher narrows the
request to `?partials=<name>` so the server renders just the frame's
subtree fresh while ancestors fp-skip. Without a matching `#`-token,
frame navs fall back to a full-page refetch — workable, but loses
the "render only the frame" optimization.

### Frame navigation

```tsx
function CartControls() {
  const cart = useNavigation(); // ambient inside <Partial frame="cart">
  return <button onClick={() => cart.navigate("/cart/checkout")}>Checkout</button>;
}
```

`navigate(url, options)` on a frame handle:

1. Resolves the URL against the frame's current URL (origin = page
   origin — cross-origin throws).
2. Writes the new URL into `state.__frames.<path>.url` on the
   current entry, with a per-frame history mutation (see §Two history
   axes).
3. Updates the client-side frame URL cache (`_frameUrls`).
4. Stamps a framework-silent `info` payload so the page-level
   intercept stands down.
5. Dispatches a refetch with `?__frame=<path>&__frameUrl=<url>` so
   the server writes the new URL into the session before any framed
   Partial renders.

Frame `selector` and `silent` options are accepted but ignored
(frame refetches are coarse by design).

## Two history axes

Frames have their own back/forward stack, separate from the
browser's. Per-frame stacks live in
`state.__frameHistory[<dottedPath>]` on every navigation entry.

| `history` mode | Window handle                                                   | Frame handle (default: `"auto"`)                                                                                                                        |
| -------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"auto"`       | Browser default — push on URL change, replace on identical URL. | `updateCurrentEntry` — patches state in place, no new browser entry. Pushes prior frame URL onto `__frameHistory[path].past`. **Drawer-shape default.** |
| `"push"`       | New browser entry.                                              | New browser entry AND push on per-frame stack. Use when the user should be able to bookmark / share the frame URL.                                      |
| `"replace"`    | Replace current entry.                                          | Replace current entry. **No** per-frame stack mutation — pure URL sync (search-as-you-type).                                                            |

`frame.canGoBack` / `canGoForward` read from `__frameHistory`, not
from `navigation.entries()`. Browser back/forward stays attached to
real page navs; frame back/forward rewinds the drawer. The two axes
don't interfere.

Frame `back()` / `forward()` walk the in-state stack via
`updateCurrentEntry` + a refetch dispatch. Both produce a
synthesized result whose `finished` resolves when the refetch
completes.

## Browser back/forward

The browser fires `navigate` events with `navigationType: "traverse"`
when the user hits back or forward. The framework intercept in
`entry.browser.tsx` diffs the destination entry's `__frames` tree
against the current entry's, then:

- If the **page URL** changed: full refetch with `__frame`/`__frameUrl`
  pairs appended for every changed frame, so the server applies
  session updates and renders the new URL.
- If only **frame URLs** changed: per-frame `_dispatchFrameRefetch`
  calls in parallel — no page-level refetch.

`history: "auto"` frame navs use `updateCurrentEntry` rather than
creating new browser entries, so drawer-shaped frames don't pollute
browser back. Explicit `history: "push"` does land in browser
history and is what shows up here.

## State on entries

```ts
state.__frames = {
  cart: {
    url: "/cart/open",
    __frameHistory: { past: [...], future: [...] },
    __frameState: { /* user state via updateCurrentEntry */ },
  },
  products: {
    url: "/products",
    __frames: {
      list: { url: "/list?page=3", __frameHistory: { past: [...] } },
    },
  },
};
```

`updateCurrentEntry({ state })` on a frame handle merges into
`__frameState[<path>]`. Reading via `frame.currentEntry?.getState()`
returns just that bucket.

Reading user state from any handle:

```ts
const scrollY = nav.currentEntry?.getState()?.scrollY ?? 0;
```

Window-handle `getState()` returns the full entry state including
`__frames` (the `<PartialsDebug>` component strips the framework
keys for display).

## Sharp edges

- **`<Cache>` inside a frame doesn't inherit frame scope.** The
  inner `renderToReadableStream` opens a new React internal context
  and the `React.cache`-backed frame-scope cell doesn't propagate.
  A `<Partial cache>` inside a frame can't read `getSearchParam` to
  get the frame URL's query directly. **Workaround:** the parent
  reads the accessor and passes the value as a scalar prop. The
  prop participates in the structural fingerprint, so cache keys
  remain URL-correct.

- **Selector refetch needs the registry warm.** A conditional
  Partial that has never rendered isn't in the registry; a
  `reload({ selector: "#x" })` falls back to streaming mode (full
  render) until the conditional renders. Either render the Partial
  unconditionally (let its body short-circuit on missing data), or
  use a shared label on the enclosing container so refetch rebuilds
  the container.

- **`nav.currentEntry?.url` is always absolute.** Window handle:
  `window.location.href`. Frame handle: synthesized as
  `new URL(frameUrl, window.location.origin).href`. Callers wanting
  `pathname + search` extract them with `new URL(entry.url)`. For
  "patch one param and navigate," prefer the updater form —
  `nav.navigate(u => { u.searchParams.set(...); return u })` —
  which hands you a mutable absolute URL directly.

- **Reading tracked accessors after `await` inside a frame.** The
  per-request frame-scope cell may have drifted to a sibling frame
  by then. Hoist accessor reads to the synchronous top of the
  Partial body, before any `await`. The cache-manifest hoisting
  rule applies the same way for the same reason.

- **Frame name / `#`-token can drift.** `<Partial selector="#cart"
frame="basket">` is legal but mismatched. The frame's session key
  is `basket`, the Partial's effective id is `cart`.
  `reload({ selector: "#cart" })` targets the Partial;
  `useNavigation("basket").navigate(...)` targets the frame URL.
  Two different addressing mechanisms for two different concerns;
  if you don't have a reason for the mismatch, keep them aligned.

- **No URL projection.** Frame URLs don't appear on the window URL.
  Mutating the window URL on frame navigation would break the
  page/frame separation and turn sibling frames into a shared state
  channel with spooky action at a distance. If a scene needs to be
  shareable, give it a real page URL instead of a frame.

- **Session GC.** The in-memory session map (`framework/session.ts`)
  grows unbounded. Production needs Redis + TTL behind the same
  interface. Frame URLs after long absences are undefined behavior
  today.
