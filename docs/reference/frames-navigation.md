# Frames + navigation

A **frame** is a server-iframe — a region of the page whose URL
scope is independent of the window URL. Wrap a subtree in `<Frame
name initialUrl>` to open a frame scope. Partials inside resolve
against the frame URL — both `match` and the tracked server-hooks see
the frame-resolved request (the framework swaps the request URL via
the ambient frame chain). So a framed spec routes *and* keys on its
frame's URL, not the page's: `match: "/cart/open"` placed in a cart
frame gates on the frame, exactly like a `pathname()` read tracking
the frame's URL.

```tsx
const CartContent = parton(function CartContentRender(_: RenderArgs) {
  const state = parseCartState(pathname())   // tracked read of the FRAME url
  return <CartPanel state={state} />
}, { selector: "#cart" })

<Frame name="cart" initialUrl="/cart/closed">
  <CartContent />
</Frame>
```

`<Frame>` is a plain React component — no constructor. It extends the
ambient frame chain with its name, writes `initialUrl` to the
session-frame-URL store (so descendants find it via session lookup),
and provides the `useNavigation("cart")` context to client
descendants. Partons inside the frame inherit the extended frame
chain via server context — no threading.

Multiple sibling partials can live in one frame:

```tsx
<Frame name="cart" initialUrl="/cart/closed">
  <CartHeader />
  <CartBody />
  <CartFooter />
</Frame>
```

## Resolution order

For a frame at path `[outer, inner]` (joined as `"outer.inner"`):

1. Server session entry for that path (cookie-backed; survives
   nav).
2. The frame's `initialUrl` prop (cold-session default — `<Frame>`
   writes it to the session on first render).
3. The page request (frame and page agree — no-op frame).

## Nested frames

Nest a `<Frame>` inside another to extend the frame chain:

```tsx
<Frame name="cart" initialUrl="/cart/closed">
  <CartContent>
    <Frame name="tab" initialUrl="/items">
      <CartTab />
    </Frame>
  </CartContent>
</Frame>
```

The inner `<Frame>` extends the frame chain from `["cart"]` to
`["cart", "tab"]`. Inside `CartTab`, `useNavigation("tab")` binds to
the nested frame and resolves against the `cart.tab` session entry.
A second `tab` frame nested under `menu` resolves to `menu.tab` —
independent state.

## Navigation

Client-side: `useNavigation(frameName?)` returns a handle. The
handle's `reload()` and `navigate()` methods are **React hooks** —
call them once during render to bind a tuple of
`[fire, progress]` for one call site. `progress` is a
`{ committed, streaming, finished }` triple of booleans, monotonic
within a single fire and reset to `false` on the next.

The handle's read getters are **isomorphic**:
`useNavigation().currentEntry.url` resolves on the server render too,
not just the client. SSR has no browser Navigation API, so the window
scope reads the page URL seeded by `PartialRoot` and a frame scope reads
its `<Frame initialUrl>` (both cross Flight as context); after hydration
the live browser handle takes over. This is what lets a URL-derived view
— an active link, a breadcrumb — render correctly on the first paint
with no hydration flash, while its host partial keeps fp-skipping (the
URL is never a tracked server read).

```tsx
const nav = useNavigation()                       // window scope
const [reload, { committed, finished }] = nav.reload()
const [navigate] = useNavigation("cart").navigate()

<Button
  onClick={() => reload({ selector: "#cart" })}
  disabled={committed && !finished}
>
  Refresh cart
</Button>
<Button onClick={() => navigate("/cart/open")}>Open cart drawer</Button>
```

Common spinner predicates:

| Predicate | Reads as |
|---|---|
| `committed && !finished` | "in flight, post-commit" — the classic disabled-button case. |
| `committed && !streaming` | "asked, no rows back yet" — clears the moment the first segment paints. |
| `streaming && !finished` | "rows arriving" — useful for progressive-reveal spinners. |

Fire functions:

- `reload()` — whole-page reload.
- `reload({ selector })` — targeted refetch of the matching Partials.
- `navigate(target)` — push a new URL.
- `navigate(target, options)` — targeted refetch + URL update.

`target` is a string, a `URL`, or an updater function
`(url: URL) => URL | string`. `selector` is one or more labels —
whitespace-joined string or array, leading `#`/`.` is cosmetic and
stripped. Refetch fans out across every spec whose labels include
any of the wanted tokens (or whose id equals one of them).

The fire function returns `NavigationMilestones` **synchronously** —
a `{ committed, streaming, finished }` object of three promises
mirroring the browser's `NavigationResult` plus a framework-native
`streaming` milestone for the first refetch segment. Chain `await`
on any of the three if you need to sequence work — typically
`navigate(...).finished` — or fire-and-forget the object. Two
reload calls in the same microtask coalesce into one request.

```tsx
// Wait for the first segment to land (rows visible), then…
const { streaming } = navigate(url, { selector: ".search-results" })
await streaming
// …kick off something the user can do as soon as they see results.
```

**Transport.** Navigations and refetches — window AND frame scoped —
ride the live channel: the fire becomes a `url` frame on a channel
envelope and the response arrives on the held stream in stream order
— a whole-tree segment for a window move, the frame's own subtrees
as lanes for a frame move — with identical milestone semantics
(`streaming` at the covering render's commit, `finished` at its
settle). A frame fire that supersedes an unsettled one for the same
frame ships an explicit `cancel` statement in the same envelope,
which aborts the in-flight server render directly (the chat's
open/close races resolve there). Pre-establishment a fire latches
and rides the ATTACH it triggers (attach-with-intent: window intent
folds into the statement's `url`; frame intent rides its `frames`) —
the first interaction never waits. On a DEGRADED page the navigate
listener stands down and links and form posts are browser-native
document loads; a degraded frame fire is a document GET carrying
`__frame`/`__frameUrl` params. This is a transport detail; nothing
about the API surface changes. Mechanics:
[`../internals/channel.md`](../internals/channel.md) §Navigation
rides the channel, §Frames ride the channel.

### Supersede ordering for selector refetches

A selector-filtered `navigate({selector})` or `reload({selector})`
becomes a `url` statement on the channel — the page URL with the
labels as a one-shot `?__force=` overlay, intent "silent"; multiple
fires in one microtask coalesce into one statement. Ordering is the
held stream's: responses arrive in stream order and every emission
carries the navigation point it was rendered as-of, so a newer
fire's segment can never be clobbered by an older one's, and a
delivery predating a client-side navigation is dropped at commit.
Until the newer fire's segment commits, the older content keeps
filling its Suspense boundaries, so the user sees the previous
query's results gradually being replaced rather than vanishing
mid-keystroke. A rapid `history: "replace"` burst can still reject a
superseded fire's milestones with `AbortError` — the browser
Navigation API superseding the entry, a normal lifecycle signal, not
surfaced through error boundaries — and `reload`'s caller-supplied
`signal` rejects its own fire the same way.

A search input becomes a one-liner per keystroke:

```tsx
const [navigate, progress] = useNavigation().navigate()

function onChange(next: string) {
  navigate((url) => withQuery(url, next), {
    history: "replace",
    selector: ".search-results",
    streaming: true,
  }).finished.catch(ignoreAbort)
}
```

No stagger / debounce / queue — the held stream's ordering handles
supersession and the React transition wrapper handles visual
continuity.

When called with no name, `useNavigation()` looks up the closest
ambient frame from the React context (set by `<Frame>`) and falls
back to the window. Buttons inside a framed spec naturally navigate
that frame; buttons outside drive the window.

### Multiple buttons in one component

Each `nav.reload()` / `nav.navigate()` call site owns its own
`progress` — sibling buttons stay clickable while one is loading.
For multiple buttons, prefer one tuple-bound child per button over
shared state:

```tsx
function PartialControls() {
  return (["hero", "stats"] as const).map((id) => (
    <RefreshButton key={id} id={id} />
  ))
}

function RefreshButton({ id }: { id: string }) {
  const [reload, { committed, finished }] = useNavigation().reload()
  const pending = committed && !finished
  return (
    <Button onClick={() => reload({ selector: `#${id}` })} disabled={pending}>
      Refresh {id}
    </Button>
  )
}
```

### `@self` — refetch the enclosing partial

`"@self"` is a special selector token the hook resolves to the
enclosing partial's effective id (read from the React context that
`PartialErrorBoundary` populates). Lets a client component inside a
partial body fire `reload({ selector: "@self" })` without threading
the id through props.

```tsx
const [reload, { committed, finished }] = useNavigation().reload()
const pending = committed && !finished
return (
  <Button onClick={() => reload({ selector: "@self" })} disabled={pending}>
    Refresh this card
  </Button>
)
```

Works in `selector`, as a string or an array mixed with other labels:

```tsx
reload({ selector: ["@self", ".price"] })
```

Used outside any partial, `@self` rejects every milestone with a
`NavigationError` (kind `decode`, message explains the wiring) —
loud failure beats silent drop.

### Error handling

Failures (network down, HTTP 5xx, Flight decode error) reject the
fire's `committed` / `streaming` / `finished` promises with a typed
`NavigationError`. The hook also throws the error from the calling
component's next render — bubbling to the nearest enclosing React
error boundary. `<GlobalErrorBoundary>` catches by default and
renders the "Something went wrong" page; hosts that want scoped
recovery can wrap their own boundary closer to the affected
subtree.

```tsx
import { NavigationError } from "@parton/framework"

// Inline handling — opt out of the bubbler by catching `.finished`.
const [navigate] = useNavigation().navigate()
navigate(url, { selector: "#cart" }).finished.catch((err) => {
  if (err instanceof NavigationError) {
    // err.kind: "network" | "http" | "decode"
    // err.status — HTTP status when kind === "http"
    // err.url    — what was being fetched
    showToast(err.message)
  }
})
```

`AbortError` (a newer navigation supersedes one in flight, or the
per-selector queue aborted this fire) is a normal lifecycle
signal, not a failure — `finished` flips true, `error` stays
unsurfaced, nothing bubbles. Inline `.catch` handlers should treat
`err.name === "AbortError"` as a no-op.

When a supersede tears the in-flight RSC stream *mid-render*, React's
Flight client may throw a stream error (`"Connection closed."`) rather
than a clean `AbortError` — thrown while rendering the superseded
payload, so it lands in an error boundary, not a `.catch`. The
framework's `<NavigationErrorBoundary>` (wrapped around the rendered
payload root by the browser bootstrap, *inside* the component that
owns the payload state) recovers from these transient tears in place —
remounting against the superseding navigation's payload — so a fast
click-through or back/forward never strands the app on the global
error page. Genuine render errors still bubble to
`<GlobalErrorBoundary>`. A tear in a *deferred* part whose server
render fails closes the whole payload stream; that case still surfaces
the error page (the page genuinely failed to render) — contain it
server-side at the failing partial.

### Driving a refetch with fresh data

A targeted refetch carries a *signal* — the `selector` — and the
re-rendered spec sources its request-dependent inputs through its
tracked reads / `match` / cells, which re-resolve against the current
request. To drive a refetch with a fresh value, write it where the
spec reads it: the page URL (`navigate(url, { selector })`), a frame
URL, or a cookie (`navigate(url, { cookies, selector })`). The
refetch derives its fingerprint from the recorded read set
re-evaluated at the current request, so an input moves the result
when it flows through one of those scopes. Activators (the
framework's `useActivate`; the example app's `<WhenVisible>` /
`<WhenMounted>` wrappers; manual buttons) are triggers that fire
`reload({ selector })`.

### Other commit knobs

| Option | Effect |
|---|---|
| `streaming: true` | Progressive reveal — commit without `startTransition`, so Suspense fallbacks paint and Flight chunks land per-row. Default is `false` (transition-wrapped, atomic swap, no fallback flash). Purely a CLIENT commit-mode switch. Not to be confused with the `streaming` milestone in `progress` — the option is a behavior switch, the milestone is an event marker. |
| `silent: true` | Update the URL without firing any refetch. Wins over `selector` if both are set. Ignored on frame handles. `navigate`-only. |
| `signal` | Caller-supplied `AbortSignal` — aborting before the fire completes rejects its milestones with `AbortError`; the covering statement's response is a channel delivery the supersede ordering already arbitrates. `reload`-only. |
| `cookies` | Write client-side cookies before the refetch fires. `navigate`-only — `reload` does not accept it. See [Cookies](#cookies). |

### Cookies

`navigate` accepts a `cookies` option that writes `document.cookie`
synchronously before the refetch fetch is issued, so the new values
travel in the upcoming request's `Cookie` header:

```tsx
const [navigate] = useNavigation().navigate()
navigate(window.location.pathname + window.location.search, {
  cookies: { theme: "dark" },
  selector: "theme-aware",
})
```

The example above passes the current URL, so `history: "auto"` (the
default) resolves to **replace** — no new history entry, just a
refetch with the new cookie. To navigate AND set a cookie, pass a
different URL:

```tsx
navigate("/checkout", { cookies: { currency: "EUR" } })
```

Here `auto` resolves to **push** and the cookie rides along into
the navigation.

`reload` deliberately does NOT accept `cookies` — cookies represent
a client-state change, and that change implies a `navigate`. The
`navigate(currentUrl, { cookies })` form is the canonical
"refetch with new cookies" call.

`cookies` is a plain `Record<string, string>`. An empty string
deletes the cookie (`max-age=0`); any other value writes it with
defaults `path=/`, `samesite=lax`, `max-age=31536000` (one year).
Frame handles also write to `document.cookie` — a global write, the
same any other handle would do. There is no per-frame cookie scope
today.

### Preload — a warm intent before the click

`useNavigation().preload(target)` states a route the user is about
to visit — a WARM intent, advisory by nature. Attached, it ships a
lossy `warm` frame on the channel (newest-wins: sweeping the pointer
across a nav bar keeps only the latest hover); the server's segment
driver runs ONE byte-silent whole-tree render of the stated target
at its park point — bounded, window-respecting, never keepalive
activity — filling the server's caches (`<Cache>` byte-cache
entries, loader caches) and the target route's registered snapshots.
The navigation statement that follows renders against warm caches.
Nothing reaches the client until the navigation itself.

Unlike `reload` / `navigate`, `preload` is a **plain imperative
method**, not a hook — call it from an event handler (typically
pointer-enter on a link):

```tsx
const nav = useNavigation()
<a href={href} onPointerEnter={() => void nav.preload(href)}>{label}</a>
```

The click stays an ordinary navigation that **always revalidates**
against the server — it just renders warm. Edges:

- **Degraded page:** the preload appends a Speculation Rules prefetch
  for the target document — the browser warms the document's HTTP
  cache entry, which is exactly what a degraded navigation loads.
- **Pre-establishment:** dropped. A preload must never trigger an
  attach (the navigation itself will), and a stale hint is worth
  less than none.
- **Best-effort.** A dropped warm just means the next navigation pays
  full freight. Fire-and-forget — the returned promise settles when
  the statement is handed off; callers normally ignore it.
- **Window-scoped today.** A frame handle's `preload` is a no-op — a
  frame's content is session-scoped subtree state with no standalone
  route to warm, and an unsupported scope degrades silently rather
  than throwing into an event handler.

## Frame URL on the wire

Attached, a frame move is a frame-scoped `url` frame on a channel
envelope — the endpoint writes the frame URL into the session and
the driver lanes the frame's subtrees on the held stream. The
document carrier

```
?__frame=<dotted-path>&__frameUrl=<url>
```

exists for renders with no channel: a degraded page's frame
navigation and the CMS preview iframe. `PartialRoot` reads the
params off the document URL and writes the session before any spec
runs. Subsequent specs that open the named frame pick up the new URL
via `getSessionFrameUrl()`.

## Sharp edges

- **Frame URL is shared per session.** Two tabs viewing the same
  app see each other's frame state through the session cookie.
  Per-tab frame state would require per-tab session ids (not yet
  implemented).
- **`initialUrl` is a fallback, not an override.** `<Frame>` writes
  it to session on first render only if the session has no entry for
  the frame path. Once the user navigates the frame, the session URL
  takes over. Use `clearSessionFrame(path)` to drop it.
- **Nested frames just nest.** Place an inner `<Frame>` anywhere inside
  the outer one's children; it inherits the outer frame chain via server
  context and extends it with its own name. No threading.
