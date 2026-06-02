# Forward-looking ideas

Open backlog. Resolved items aren't tracked here — they're either
deleted (when there's no useful pre-shipment rationale to preserve)
or moved to [`../archive/`](../archive/) with a Superseded banner
(when the design exploration is worth keeping for context).

---

## Backlog

### Scoped selectors

Resolve selector tokens (`#foo` / `.bar`) per module or per spec-tree
path instead of in a global flat namespace. Today the framework
throws on duplicate `#` tokens at render time, forcing factories to
hand-disambiguate internal names; scoping lets the same name be
reused across invocations.

String tokens are brittle past a single codebase — highest-leverage
backlog item before multi-team adoption.

### Pattern-based cache invalidation

Today, cache entries are invalidated by spec id or by tag. The `vary`
result that produced each cache key is stored alongside, so a third
invalidation axis is mechanically available: "drop every cache entry
whose `vary` result contains `cookie:user_id=42`" (or
`pathname:/p/abc`, etc.). Useful when a session-level change (logout,
locale switch, A/B bucket flip) needs to fan out across every spec
that depended on it without the caller knowing each affected partial
id.

Open questions:
- **Storage shape.** Vary results are hashed into the cache key, not
  stored as queryable fields. Either keep a side-index
  `(key → varyResult)` to walk, or accept O(n) scan over cache
  entries on invalidation (probably fine for sub-10k entries).
- **Surface.** Extend `getServerNavigation().reload(...)` to accept
  a `match: { cookie: "user_id", value: "42" }` shape alongside the
  current `selector` form. Same call site, additional dimension.
- **Cross-key dimensions.** Matching on `cookie` keys assumes the
  vary result encodes them in a stable shape. Today `vary` returns
  whatever the author writes; folding the destructured scope keys
  (`{cookies: {user_id: "42"}}`) into the stored vary result would
  give the matcher something deterministic to query.

### Cross-tab sync via BroadcastChannel

When tab A runs a server action that invalidates `["cart"]`, tab B is stale. A BroadcastChannel propagating invalidation signals across same-origin tabs would make multi-tab behaviour correct by default. Strictly simpler than server-push realtime (no websocket infra) and probably what 90% of apps actually need.

### Persist optimistic unsaved cell values

`useCell` shows the optimistic-aware value (`latestSentByCell`) while writes are pending; on reconcile the server's value wins. The optimistic value lives in React memory and dies on reload. For drafts and rapid-edit flows the user may close the tab mid-write, return, and expect the unsaved value to still be there.

Persist `latestSentByCell` to `sessionStorage` (or IndexedDB for larger payloads) keyed by cell id + partition key, with a short TTL. On mount, hydrate the optimistic map from storage. Only persist entries with `pendingByCell[id] > 0` — once a write settles, drop the persisted entry. Open questions: cross-tab coherence (two tabs both write the same cell — last-write-wins?), and whether to surface the persisted state to the renderer differently from a fresh in-flight write.

### Sharp edge: `reload({selector})` is too broad by default

Today `getServerNavigation().reload({ selector: "cart" })` with no constraints bumps **every** cart-tagged parton across every connected viewer. The grammar supports per-request scoping via query-string constraints (`cart?cart_id=${cartId}`), but the safe pattern is opt-in: forget the constraint and one user's cart mutation causes every other viewer's cart to refetch on their next nav. Silent footgun — the caller sees correct local behaviour; the cross-user fan-out only shows up under load or as unnecessary upstream round-trips.

Cells partially mitigate via the value-fold (re-renders that produce identical bytes hit fp-skip on the way out), but the registry walk + re-render still happens. For GraphQL-backed partons like `cart`, the re-render is a real Magento round-trip per viewer.

Possible directions:
- **Syntactic sugar.** `reload({ selector: "cart", scope: { cart_id: cartId } })` as a readable alternative to query-string interpolation. Same semantics; easier to read for multi-key cases.
- **Auto-scope from declared read keys.** If the framework tracks which `readCookie` / `readHeader` calls happened during the action body, fold those into default constraints. Small instrumentation cost, large ergonomic win — the action says what it touched without naming each axis.
- **Dev warning on bare bumps.** Warn when a `reload({selector})` would match >1 distinct vary tuple in the current registry snapshot. Catches the footgun in development; ships nothing to production.

Not urgent: the cart action is the only real per-user mutation in-tree today; CMS draft is process-global; cells absorb the bare-bump cost via fp-skip. Real pressure arrives when a multi-user app ships several per-user mutating actions and the upstream round-trips start showing in flame graphs.

### Keepalive follow-ups (server-driven TTL, device-aware eviction)

Keepalive itself (matchKey-keyed Activity siblings + fp-trailer
cold→warm drift recovery) is shipped — see
[`../reference/partial.md`](../reference/partial.md) § `keepalive`
and [`../internals/render-pipeline.md`](../internals/render-pipeline.md)
§ "Cold → warm fp drift and the trailer". Two extensions remain:

- **Server-driven cache-control on the wire.** Today `keepalive`
  has no time component — variants stay cached until the next
  layout boundary prunes them. The natural extension is to surface
  the spec's `cache: { maxAge, staleWhileRevalidate }` numbers via
  the same trailer channel and have the client use them to decide
  when to even send the id in `?cached=` on the next nav (within
  `maxAge`: paint cached, skip the network round-trip for this id
  entirely; within SWR window: include in `?cached=` and
  revalidate in background; past both: include and treat as cold).
- **Device-aware eviction over the variant pool.** Per-page prune
  already covers cross-layout cleanup, but within-id multi-matchKey
  accumulation is unbounded — deep `/pokemon/<n>` browsing keeps
  every visited variant's hidden Activity in the fiber tree. React
  still ticks low-priority work on hidden Activities, so the
  steady-state cost scales with depth. The natural fix is an LRU
  over the variant pool sized by something the harness can read
  (`navigator.deviceMemory` plus a measured budget?), but the
  device-capability story isn't fleshed out yet — deferred until a
  real pressure signal exists in-tree.

Both can be layered on the current trailer + matchKey infrastructure
without breaking the API surface.

### Restart-streaming via segmented Flight (cursor-frequency updates)

The fp-trailer is one segment after the main Flight bytes. The same
framing (4-byte sentinel-with-tag + length-prefix per segment)
generalises to N segments: server keeps the response stream open,
emits Flight payload + sentinel + Flight payload + sentinel + …,
client splits on sentinels and calls `setPayload(payload)` once per
segment. Effectively Server-Sent Events with Flight payloads as
events — the client just keeps reconciling into the same React tree
on every segment.

For a cursor-position firehose (10–60 updates/sec), the server-side
shape is: render-to-readable-stream → wait for next state mutation →
render again → emit as next segment, looping until the request
aborts. State-push from client to server stays a separate channel
(parallel POST stream, websocket, or just a different `Request`) —
the asymmetry (RSC down, state up) is intrinsic.

Open questions if/when we build this:
- **Server-side iteration loop.** How does `<Root>` know to
  re-render? Probably an explicit `useRevalidate` primitive or an
  external state observer.
- **Segment framing in flight-trailer-marker.** Vary the tag to
  distinguish `next-payload` from `fp-updates` — same sentinel
  shape, different ASCII tag means same parser dispatches on it.
- **Backpressure.** If client renders slowly, server keeps emitting.
  Bounded queue + drop-oldest is probably what we want for cursor
  positions.

### Activate ⇄ deactivate symmetry (deferred + infinite-scroll unload)

Today `useActivate(partialId, subscribe)` fires once and the partial
stays live. There's no path back to dormant. The infinite-scroll
case wants symmetry: as items leave the viewport, the framework
should drop them from the rendered tree and re-stub them as deferred
placeholders, so a 50,000-row list doesn't grow unbounded in memory.

Same primitive shape, two phases:
- **Activation.** `<WhenVisible>` fires `useActivate(id).fire()` when
  the placeholder enters the viewport.
- **Deactivation.** When it leaves, fire `useActivate(id).deactivate()`,
  which re-stubs the partial back to its `fallback` and frees the
  rendered subtree.

Open questions:
- **Lifecycle policy per spec.** `unmountWhen={<WhenHidden/>}`, TTL
  after last activation, memory-pressure eviction. Probably layered.
- **Scroll restoration.** The placeholder takes some space; the
  framework needs to either reserve the original height or accept
  reflow. The current `<WhenVisible>` already deals with this on
  activate; the deactivation side needs the mirror.
- **State on reactivation.** Does deactivation re-run `vary` on the
  next activation? If yes, infinite-scroll back-up re-fetches stale
  rows; if no, stale snapshots accumulate. Probably: deactivation
  freezes the snapshot, reactivation runs `vary` fresh.

### Speculation Rules API — cross-document prefetch complement

**Shipped — the in-app path.** `useNavigation().preload(target)` warms a
destination's partials into the client RSC cache on hover: a
same-document, warm-only GET (`?cached=`) walked into
`_currentPagePartials` without committing, so the subsequent click
fp-skips and substitutes from cache. See
[`../reference/frames-navigation.md`](../reference/frames-navigation.md)
§Preload and
[`../internals/render-pipeline.md`](../internals/render-pipeline.md)
§"Preload (warm-only client commit)". That covers the common case (hover
a `<Link>`, arrive warm) entirely in framework JS.

What it does NOT cover is the **cross-document** case — the only thing
the [Speculation Rules API][spec-rules] can help with, and the two don't
overlap:

- Speculation Rules acts on cross-document (MPA) navigations: `prerender`
  loads a whole document into a hidden tab; `prefetch` warms the
  document's HTTP-cache entry.
- Parton `<Link>`s are **same-document** — they `intercept()` the nav
  and issue an RSC `?cached=` GET. `intercept()` only applies to
  same-document navigations, so a speculation never fires for an
  intercepted link; and even when one does fire (a nav parton doesn't
  intercept), an activated prerender is a *cold* parton boot (fresh
  `_currentPagePartials`) and a prefetch warms the *document* entry, not
  the RSC request. So Speculation Rules can't warm the client RSC cache
  — that's exactly the gap `preload` fills.

Where it still adds value (research spike, lower priority now the in-app
path ships): genuinely cross-document entry points — cold first paint of
a deep link, cross-origin links, a hard-nav fallback before JS boots.
Open questions for that surface:

- **Per-link rules from the server.** Emit a
  `<script type="speculationrules">` block (prefetch by default; opt in
  to prerender, which executes RSC actions / can mutate session). Borrow
  the `eagerness` model (`moderate` default) and the
  `Sec-Speculation-Tags` header for server-side attribution.
- **Hover-without-JS.** Speculation Rules fire on `:hover` selectors
  with zero client JS — the one thing `preload`'s pointer-enter handler
  can't do (it needs hydration). Useful for the pre-hydration window.
- **Composes with `defer`.** A `<WhenVisible>` partial could carry a
  prefetch rule firing before the intersection, so activation is warm.

[spec-rules]: https://developer.mozilla.org/en-US/docs/Web/API/Speculation_Rules_API

### Side-channel re-render directives on every response

Server actions today can `return { invalidate: { selector } }` and
the framework refetches the targeted partials on the next render.
That's the only path from server to client for triggering an
out-of-band partial re-render. A generalisation: every response —
not just action returns — could carry zero-or-more invalidate /
re-render directives that travel alongside the actual payload.

Use cases:
- **Flash / toast tied to an action.** `return { flash: "Added to
  cart" }` displayed by a `<FlashPartial>` subscribed to the action
  return channel.
- **Server-side staleness detection.** While handling any request,
  the server notices a partial the client is showing is now stale
  (price changed in DB, stock dropped to zero, etc.) and tells the
  client to refetch it.
- **Coalesced realtime.** Instead of websockets, every navigation
  or partial refetch pulls down any pending directives the server
  has accumulated for this session/user.

Not a new primitive — extends the existing action-return directive
surface to non-action requests. Open question: what's the wire
shape (piggyback in the RSC stream as a synthetic
`invalidate-partial` frame, or a sidecar JSON field on the response)?

### Sitemap / route list generation + prerender

The framework knows every URLPattern any spec was constructed with
(`getRegisteredMatchPatterns()`). What it doesn't know: the
cardinal URLs each pattern resolves to. `/p/:slug` needs the list
of slugs, which lives in CMS data or an upstream catalog (Magento,
PIM), not in the framework. Two related questions:

- **Sitemap.** A `sitemap.xml` builder needs to enumerate every URL
  the app responds to. The pattern set is half the answer; spec
  authors need a way to declare "to enumerate me, call this loader"
  (e.g. `enumerate: () => listProductSlugs()`). The framework can
  then walk patterns × enumerated params to produce the URL list.
- **Prerender / warm-cache.** Given the URL list, the framework
  could render each ahead of time and stash the bytes in the
  existing `<Cache>` store. Pure static export ("Astro islands")
  isn't the real use case — partial dynamism is part of the design
  — but warm-caching the cold paths at deploy time is.

Open questions:
- **Enumerate API shape.** Async generator? Paginated callback?
  Static array?
- **Opt-in vs opt-out.** Some specs depend on cookies/headers and
  can't be sensibly prerendered; the `vary` signature already tells
  us which. Default could be "prerender any spec whose `vary` reads
  only `params` + `pathname`."
- **Sitemap-only vs sitemap+prerender.** They share the enumeration
  but have different cost profiles; probably two phases of the same
  pipeline.

### Pluggable stores for horizontal scale

Define a `Store<K, V>` interface for sessions, render cache, and
partial registry, and audit each store for value serializability.
Sessions and the render cache are JSON-serializable; partial registry
snapshots carry `fallback: ReactNode` — either drop and re-derive on
lookup, or accept that the registry stays per-instance (warms at
first render). Backend choice downstream.

### CMS storage

Define the storage interface contract: consistency (transactional vs
eventually consistent + invalidation signals), observers (per-key
subscription? coarse change event?), authorisation (per-row,
per-namespace, or none-at-this-layer). Today's default is a
per-process JSON cache keyed on `Date.now()` — demo-only.
`setCmsStorage()` is the swap point; backing store choice downstream.

### Auth and CSRF

Decide whether the principal is a `vary` axis (so per-user cache keys
derive automatically) or stays action-handler-only. Investigate
whether CSRF protection inherits from same-origin + session cookies
(Next.js's stance) or needs a framework-issued token. Provider impl
downstream.

### Head metadata

Surface a sync `title` contribution per spec (e.g. a `title` field in
`vary`'s return) that the framework collects and emits in `<head>`
before the body streams. Today's inline `<title>` only resolves after
the stream awaits — too late for first paint. Open Graph / canonical /
structured-data not urgent.

### Performance tracing

Add a per-partial instrumentation interface (`onPartialStart` /
`onPartialEnd` / `onCacheHit` etc.) for slow-spec warnings, trace
propagation across partial boundaries, and cache hit/miss metrics.
OpenTelemetry adapter as one impl; bring-your-own logger as another.

### i18n as a vary axis

Add locale as a first-class `vary` axis alongside cookies / headers /
session, with locale-aware routing and a translation function.
Required for the "CMS" framing — multi-locale content is table-stakes
for a CMS.

### Error recovery

Layer on top of `PartialErrorBoundary`: typed errors, retry/backoff
policies, circuit breakers, serve-stale-on-error (reuse the SWR
entry on transient errors), error → observability hook.

### Testing harness for partials

A primitive for unit-testing a single partial with a mocked request
context. Forces `getRequest()` / `getCookie()` / etc. to be
injectable (not just ambient); pays large DX dividends.

### a11y defaults for refetch

`aria-busy` during pending refetches, focus restoration policy
across swaps, live-region announcements. Currently on the app —
will be pile-of-ad-hoc in a year without framework-level defaults.

### Abolish id

The id concept resolves through too many paths (spec auto-derive,
JSX prop, slot-wiring's `__contentKey` internal channel, singleton via
selector `#token`). Goal is to remove it almost entirely from the
public surface — identity should fall out of placement, not be
threaded as a separate prop. Touches partial.tsx, slot wiring, and
the CMS storage layer.

### Split framework barrel into server + client

Replace the single `framework/index.ts` barrel with explicit
`framework/server.ts` and `framework/client.ts` entry points. Today's
single barrel can't re-export `"use client"` hooks or `"use server"`
actions without footguns (see the cross-`"use *"` caveat in
CLAUDE.md); deep-imports work around it. Two barrels match the
actual `"use *"` boundary. Related: `framework/src/lib/` and
`framework/src/runtime/` could re-organize along the same client /
server axis instead of their current names.

### Audit frame-state write paths

`<Frame>` writes session on cold render; `PartialRoot` also writes
session from `?__frame=&__frameUrl=` URL params on every request.
Two paths into one store — worth checking if they can collapse.

### RemoteFrame v2 — cross-origin refetch routing

Same-origin v1 of `<RemoteFrame>` routes selector-targeted
refetches through the host's local spec catalog. That works
because both processes share the same parton definitions in dev.
For true cross-origin (different deployments, different
codebases), the host doesn't have the remote's spec — the
refetch needs to round-trip back to the remote endpoint.

The fix: when the snapshot trailer carries snapshots from a
remote, annotate them with `source: "remote:<origin>"`. The
host's refetch dispatcher checks the field: if remote-sourced,
fire a fetch to `<origin>/__remote/<id>` instead of running the
local spec. The response stitches in via the same RemoteFrame
machinery (snapshot trailer, module-ref rewrite, etc.).

Open questions: how does the targeted-refetch URL carry the
parent-path context? Today partial-refetch URLs use the host's
URL; for a remote refetch they'd need to point at the remote
endpoint with a way to carry capability + selector-token info.
Probably: same `?partials=<id>` shape but origin from the
snapshot's `source` field.

### RemoteFrame v2 — signed capability tokens

Today the capability header is trust-the-network: the remote
believes whatever the host puts in `x-parton-capability`. For
real third-party deployments, the remote needs to verify the
host's claims (this cart-id actually exists, this user actually
owns it, this total is what was quoted). HMAC-signed tokens
with an expiration and an issuer are the obvious shape — pick
JWT or PASETO depending on team taste.

The signing key lives at the host; the verification key is
either the host's public key (asymmetric) or a shared secret
(symmetric, simpler but harder to rotate). For Stripe-style
"third-party serves a checkout widget" the signature is
non-optional; for "Adobe-vetted module in a trusted deployment"
it's overkill.

### RemoteFrame — same-origin batching

Today `<RemoteFrame>` dedups identical `(src, capability)`
placements (single fetch shared across copies). But multiple
RemoteFrames pointing at DIFFERENT ids on the same origin still
fire N separate requests. Common case in commerce: a checkout
page with three Stripe remotes (payment-method picker, summary,
upsells) — three round-trips to Stripe instead of one.

Batching design: the host collects same-origin RemoteFrame
placements within a microtask window, issues one
`GET <origin>/__remote/?ids=a,b,c`, the remote returns a
length-prefixed multi-payload response. Each placement's Flight
payload + snapshot trailer is split out and decoded
independently.

Capability complication: each placement can carry its own
capability. The batched request must transport per-id
capabilities — probably an envelope like
`X-Parton-Capabilities: { id: cap, ... }` on the request and
matching per-id sections in the response. Without per-id caps,
batching would have to fall back to one-fetch-per-distinct-cap,
which still helps when caps are uniform.

Open: how the remote endpoint structures the batched response.
Length-prefixed sections (like the existing snapshot trailer)
keep parsing simple; a multipart shape compresses better with
HTTP/2 frame coalescing but adds a content-type parser.

---

## Meta principle — prefer runtime discovery to static analysis

The framework makes two layered claims:

1. **Partials as addressable RSC subtrees** — solid, working, primitive is coherent.
2. **Runtime discovery over static analysis** — no static walkers, no codegen, no build-time manifest. The spec catalog and the partial registry both populate at first render.

The second claim is the one that distinguishes this from Next.js App Router in the long run. Everything that reinstates a static walker (typed partial registries via codegen, explicit route manifests, declarative input schemas resolved at build time) works against it. When evaluating future directions, the test is: *can this self-register at render time instead of requiring a pre-render walk?* The current `parton` / `block` constructors pass that test — every spec self-registers when its module loads. Typed-handle codegen fails it. Keep that principle sharp — it's the architectural load-bearing idea and it's easy to erode one convenient walker at a time.

---

## Transient client state — resolved by cells

Original design exploration archived to
[`../archive/transient-client-state.md`](../archive/transient-client-state.md).
Directions A and B (server-authoritative state the partial reads;
optimistic overlay for in-flight writes) collapsed into the **cell**
primitive — see [`../reference/cells.md`](../reference/cells.md) and
[`../internals/cell-internals.md`](../internals/cell-internals.md).
The cell's `value` is optimistic-aware via `useCell`, so consumers
bind once and never see pending state directly. Two threads from the
original doc remain open and live below as standalone backlog items.

## Per-tab session axis

Original framing: Direction C from the archived `transient-client-state`
doc. Cells today are global or session-scoped (cookie-shared across
tabs). The cross-tab leak via session-scoped frame URL — tab A opens
a drawer, tab B's drawer opens on next render — wants a per-tab axis
the server can read sync. Stamp a per-tab id (`sessionStorage`-backed
nonce) into a header on every request; expose as
`vary: ({tab}) => ({...})` and `useTabState("key", value)` on the
client. Sharp constraint (JSON-serializable, small) so it doesn't
become the dumping ground for "state I didn't want to think about."

## `<PartialForm>` as a composed primitive

Original framing: Direction D from the archived `transient-client-state`
doc. Whether to ship a higher-level form primitive that combines cells
(per-field draft) + an optimistic submit overlay. Cells already
handle the per-field side via `useCell(cell).input(opts)`; the form
primitive would own the submit lifecycle (validation, blur, submit
button state, error display). The `cell.input()` ↔ RHF `register()`
comparison in [`../reference/cells.md`](../reference/cells.md) is
the design surface to start from. Waits for a multi-step CMS draft
caller — defer until there's a real form flow that exercises
submit + validation + draft together.
