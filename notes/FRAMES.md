# Frames — server iframes on Partials

**Status:** implemented. Demo + e2e at `/frames-demo`. Scoping
decision in `FRAME_SCOPING.md`.

## One-liner

A **frame** is a `<Partial>` with its own URL. Everything inside
reads tracked accessors (`getSearchParam`, `getPathname`,
`getCookie`, `getHeader`) against the FRAME's URL instead of the
page URL. Frames have their own navigation, preserved in a server
session, their state is scoped via a `React.cache`-backed cell.

```tsx
<Partial selector="#cart" frame="cart" frameUrl="/cart/closed">
  <CartSection /> {/* getSearchParam("q") reads the cart frame's ?q= */}
</Partial>
```

Navigating the frame from the client:

```ts
// Hook — default-binds to the ambient frame inside a
// `<Partial frame="cart">` subtree, or to `window.navigation` when
// called outside one. Pass a name to bind to a specific frame from
// outside. Reactive: canGoBack, canGoForward, currentUrl,
// entryState update on navigation.
import { useNavigation } from "../lib";
function CartControls() {
  const cart = useNavigation();                      // ambient = "cart"
  return <button onClick={() => cart.navigate("/cart/checkout")}>Checkout</button>;
}
function ProductListItem({ sku }) {
  const page = useNavigation();                      // no ambient → window
  return <button onClick={() => page.navigate(`/?product=${sku}`)}>Open</button>;
}
```

The handle mirrors `window.navigation`. Frame-scoped and window-
scoped handles have the same shape:

| Method / Prop | Frame-scoped | Window-scoped |
|---|---|---|
| `name` | Dotted frame path (e.g. `"cart"` or `"products.list"`) | `null` |
| `currentUrl` | Frame's URL (client cache) | `location.pathname + search` |
| `canGoBack` / `canGoForward` | An earlier/later entry's `__frames[name].url` differs | `navigation.canGoBack` / `canGoForward` |
| `navigate(url, opts?)` | `navigation.navigate(sameUrl, { state, info })` + session update + frame refetch | `navigation.navigate` |
| `back()` / `forward()` | `navigation.traverseTo()` to a matching entry | `navigation.back()` / `forward()` |
| `reload(opts?)` | Re-dispatch the current frame URL | `navigation.reload()` |
| `updateCurrentEntry(state)` | Merge under `__frameState[name]` | `navigation.updateCurrentEntry({state})` |
| `entryState` | Read that merged state back | Full entry state |

**Options** follow the Navigation API spec
(https://developer.mozilla.org/en-US/docs/Web/API/Navigation/navigate)
plus one extra:

```ts
navigate(url, {
  history: "push" | "replace" | "auto",   // default: "auto" (in-state, no browser entry)
  state: { scrollY: 100 },                // user state on the entry
  info: { reason: "auto-save" },          // navigate event info (window only)
  disableTransition: true,                // bypass startTransition on commit
})
```

## Nesting — frames inside frames

Frames compose by nesting. A `<Partial frame="list">` rendered inside
a `<Partial frame="products">` ancestor is a child frame of
`products`: its canonical identity is the dotted path of every
enclosing frame ancestor joined with its own local name —
`"products.list"`. This is what lets two separate `list` frames
coexist under different parents without colliding:

```tsx
<Partial parent={ROOT} selector="#products" frame="products">
  <Partial parent={capturePartialContext()} selector="#list" frame="list">
    <ProductList />  {/* frame URL = session["products.list"] */}
  </Partial>
</Partial>

<Partial parent={ROOT} selector="#blog" frame="blog">
  <Partial parent={capturePartialContext()} selector="#list" frame="list">
    <BlogList />    {/* frame URL = session["blog.list"], distinct! */}
  </Partial>
</Partial>
```

The server tracks the full chain via `PartialCtx.frameChain` threaded
through `<Partial parent={…}>` — an opaque token built from either
`ROOT` at the top or `capturePartialContext()` in a sync code path,
and threaded as an explicit prop across any `await` (same discipline
as tracked accessors; see `src/lib/partial-context.ts`). On the wire,
`?__frame=products.list&__frameUrl=/list?page=3` carries the full
path; session storage keys off the dotted path; client navigation
state nests by tree:

```ts
state.__frames = {
  products: {
    url: "/p/alpha",
    __frameHistory: { past, future },  // products' own back-stack
    __frames: {
      list: {
        url: "/list?page=3",
        __frameHistory: { past, future },  // list's own back-stack
      }
    }
  }
}
```

A parent frame's `__frameHistory` and a child's are independent — the
two nav axes don't interfere. `useNavigation("products.list")`
returns a handle bound to the nested node; no-argument
`useNavigation()` inside a nested subtree binds to the innermost
ambient frame via `FrameNameContext` (which stacks the full path).

## Mental model

- Pages used to be one routing axis = one URL.
- A frame introduces an additional routing axis, scoped to a subtree.
- The window URL stays page-level; the frame has its own.
- State is persisted server-side in a **session** (cookie → in-memory
  map, swap for Redis). Refresh reconstructs the scene.
- The window URL is untouched by frame navigation. If you want
  something shareable, use plain page URLs (`useNavigation()` with
  no frame) — don't project frame state into the page URL.

The spiritual cousin is **Turbo Frames**. Each frame is a mini
browser: its own current URL, its own history, its own navigation.
Unlike Turbo Frames, ours render top-down through the same RSC
streaming pipeline as everything else — the frame boundary is
logical (a scope-cell mutation plus a session entry), not an HTML
custom element, and no new transport.

## Building blocks

| Piece | File | What it does |
|---|---|---|
| Frame-scope cell | `src/framework/context.ts` | `React.cache()`-backed `{ current: FrameScope \| null }`. `FrameWrapper` mutates it; accessors read it. Streams naturally. |
| Session store | `src/framework/session.ts` | Cookie-ID → `{frames: {name: {url}}}`. In-memory today. |
| `<Partial frame="name" frameUrl="/…">` | `src/lib/partial-component.tsx` | `FrameWrapper` mutates the scope cell + wraps in `<FrameNameProvider>`. Sync, no Flight round-trip — streaming preserved. |
| Server-side `__frame`/`__frameUrl` parsing | `src/lib/partial.tsx` (in `PartialRoot`) | Refetch URL params update the session before any framed Partial renders. |
| Client-side `useNavigation(name?)` | `src/lib/partial-client.tsx` | `navigate(url, opts?)`, `currentUrl`, etc. Writes a new entry via `navigation.navigate(sameUrl, { state, info })` carrying the full `__frames` snapshot. Framework-internal escape hatch `_frame(name)` exists for non-render call sites. |
| Browser navigation listener | `src/framework/entry.browser.tsx` | On traversal: diffs destination vs current snapshots, dispatches refetches for changed frames, and carries them on the refetch URL if the page URL also changed. |

## Streaming

Frame scoping used to go through a Flight render+decode round-trip
inside an ALS scope. Correct but it **blocked streaming** — a slow
async component inside a frame buffered the whole subtree before
the frame's body could return.

The current implementation swaps that for **`React.cache` mutation**
(pattern borrowed from
https://github.com/zhangyu1818/react-server-only-context). The scope
is a mutable cell; `FrameWrapper` writes to it synchronously before
returning children; accessors read it. No buffering, Suspense
boundaries inside a framed subtree stream normally, the outer Flight
stream emits chunks progressively.

## Discipline: read accessors before any `await`

Same rule as the cache manifest (`HoistingViolationError` in
`context.ts`): accessors must be called at the top of an async
server component body, BEFORE any `await`. After an `await` the
scope cell may have been mutated by a sibling frame's render.
Capture to a local and use after the await.

```tsx
async function SlowCart() {
  const sku = getSearchParam("sku");          // ✓ read at top
  const data = await fetchCart(sku);           // ✓ await after read
  return <Cart data={data} />;
}

async function BrokenCart() {
  await fetchSomething();                      // ✗ await before read
  const sku = getSearchParam("sku");           // ⚠ scope may have drifted
  ...
}
```

## No URL projection

An earlier iteration serialized frame URLs into the window URL for
share-links. It was removed: the window URL mutating during frame
navigation broke the separation between "the page" and "frames on
that page," and turned sibling frames into a shared state channel
with spooky action at a distance. If a scene needs to be shareable,
give it a real page URL.

## Interaction with the rest of the system

- **Partial registry** stays keyed by PAGE pathname. Registry
  lookups for refetches use the page URL the client's refetch hit.
- **Fingerprint-skip** folds the frame URL into the fingerprint. A
  frame URL change yields a distinct fp; the client's `?cached=id:fp`
  no longer matches; server re-renders with the new scope.
- **Nested partials inside a framed subtree** get their own top-
  level cache entries client-side. Without this, a navigate-back-
  then-forward on a frame that introduces new inner partials would
  produce unfilled placeholders (the parent refetch emits a
  placeholder for the inner; the client must have the inner cached
  by id). Both streaming and cache-mode client merges now recurse.
- **`<Cache>` keys** include frame-scoped accessor reads via the
  `resolveManifest(manifest, frameRequest)` path. A cached framed
  Partial has per-(id, fp, frame-URL) entries.
- **Server actions** don't automatically know about frames. If an
  action's `invalidate: { selector: "#cart" }` refers to a Partial
  whose selector contains `#cart` AND which declared `frame="cart"`,
  the refetch targets it like any other `#`-token. Convention: the
  frame's root Partial should carry `#<frameName>` so the client's
  `partials=<frameName>` hint from `_dispatchFrameRefetch` lands on
  the right effective id. See `notes/SELECTOR_API.md` §Frames.

## Known sharp edges

- **Session GC.** In-memory map grows unbounded. Prod needs Redis +
  TTL.
- **Session ID in a non-HttpOnly cookie.** Current `setCookie`
  doesn't mark `HttpOnly`. Fine for research; production needs
  HttpOnly + Secure + SameSite=Lax.
- ~~**Frame name collision.**~~ **RESOLVED** — frame names are now
  scoped to their enclosing frame. Two `<Partial frame="list">`
  under different parent frames resolve to distinct dotted paths
  (`"products.list"` vs `"blog.list"`); only a duplicate at the same
  nesting level collides. See the `PartialCtx.frameChain` thread in
  `src/lib/partial-context.ts`. Historical entry preserved so blame
  tells the story.
- **Reading accessors after `await`.** The scope cell is shared per
  request; sibling frames mutate it. Hoist reads to the top (same
  rule as the cache manifest).
- **Two history axes, not one.** Frame navigation defaults to
  `history: "auto"` which patches the current entry's state via
  `navigation.updateCurrentEntry({ state })` — no new browser entry,
  no browser-back pollution. A per-frame back/forward stack lives
  inside the current entry's state at
  `state.__frameHistory[name] = { past, future }`, and is what
  `frame.back()` / `forward()` walk. Explicit `history: "push"`
  still creates a browser entry (for bookmarkable drawer URLs);
  `history: "replace"` is a pure URL sync (no per-frame push — use
  for search-as-you-type). The browser's global back button stays
  attached to real page navigations; drawer-shaped frame navs never
  show up there by default.

## Two history axes — the `history` option per handle

| Mode | Window handle | Frame handle (default: `"auto"`) |
|---|---|---|
| `"auto"` | Browser default: push on URL change, replace otherwise. | **`updateCurrentEntry({ state })`** — no new browser entry. Pushes prior frame URL onto `__frameHistory[name].past`, clears `future`. Drawer-friendly. |
| `"push"` | New browser entry. | New browser entry AND push on per-frame stack. Use when the user should be able to bookmark / share the open state (e.g. a deep product frame URL), or when browser-back should walk frame state too. |
| `"replace"` | Replace current entry. | Replace current entry, **no** per-frame stack mutation. Pure URL sync — search-as-you-type driving a frame URL. |

`frame.canGoBack` / `canGoForward` read from `__frameHistory[name]`
on the current entry — NOT from `navigation.entries()`. That means
browser back/forward and frame back/forward are two independent
axes: browser-back leaves the page, frame-back rewinds the drawer.

## Rules of thumb

1. Frame name = Partial id. The frame-refetch convention is
   `?partials=<name>`, which maps 1:1 to the Partial id.
2. Read accessors at the top of the body, before any `await`.
3. Default navigation doesn't touch the window URL. If you want
   shareable state, use page-level URLs (`useNavigation()` with no
   frame) instead of frames.
4. Cookies are page-global, not frame-scoped. Frame Requests carry
   the page's cookies by construction.
5. If you need a URL scope without server rendering (pure client UI),
   you don't need a frame — use `useState` or localStorage + a
   `<WhenStored>` activator.
