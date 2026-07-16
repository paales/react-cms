# Forward-looking ideas

Open backlog. Resolved items aren't tracked here — they're deleted
(when there's no useful pre-shipment rationale to preserve), collapsed
to a one-line resolved pointer (when readers are likely to come
looking for what happened), or moved to [`../archive/`](../archive/)
with a Superseded banner (when the design exploration is worth
keeping for context).

---

## Known issues

Confirmed bugs and debt awaiting a lane — measured, not yet fixed.

### Warm-tick bench ~2× slower since every parton fingerprints

CI evidence (same runner class, same workflow): the Server warm-tick
bench job finished in 7m32s at `6cd2da8` and times out at 15m on
`be20eb1` — the harness's duplicate-id crash was fixed in between, so
the timeout is pure runtime growth. The window contains the two
commits that added per-parton per-render work: the placement fold
(`0adcf92`, a hash per auto-id placement) and the selector deletion
(`2f332d1`, every bare parton now runs the full fp/registry pipeline
it used to skip). The CI TIMEOUT itself was a separate bench-harness
deadlock (the soak fixture's fold-mismatched selector — fixed), and
the same stale selector was under-counting warm renders (rndr=2 vs
the documented 3), so every pre-fix measurement is unfaithful —
including the first same-machine ratios recorded here (warm p50 3.6×
at N=10 down to 1.4× at N=1000 vs the `614100a` baseline, loaded
box). Re-measure on a quiet machine post-fix, then
`yarn bench:server --prof` the warm-tick hot path before deciding:
optimize (memoize fold inputs? cheaper fp source concat?) vs
re-budget for the new model's honest cost. The bench is the CPU
canary — its smoke ticks are a CI gate again, but the committed
baselines must not be regenerated until this is resolved.

### Test-infra: `refreshSelector` bumps cross Playwright workers

Invalidation-timestamp bumps are process-global, not partitioned by
`x-test-scope` — a tag bump in one worker's spec wakes partons in
another's. Two spec files run `mode: "serial"` as a workaround while
the playwright config still claims workers>1 is safe. Needs real
scoping or a documented ownership rule.

### Interactive-Chrome `/__parton/channel` POST 503s

Real browser tabs occasionally wedge with 503s on the channel POST;
Playwright doesn't reproduce it. Investigated: the framework NEVER
emits 503 on the channel POST — `handleChannelPost`
(`connection-session.ts`) only ever answers 403/400/404/204, and the
one 503 in the tree (`drainAttachRefusal`, `drain.ts`) is wired to the
ATTACH leg (`/__parton/live`), not the channel POST. So a channel 503
is produced UPSTREAM (reverse proxy / LB / Node server) under
connection-pool exhaustion: real Chrome accumulates long-held
`/__parton/live` fetch streams (fetch transport, bfcache/tab-suspend
leaving sockets half-open for the 5-min `KEEPALIVE_MS`, the ~10s
WS-upgrade overlap `HANDOVER_DRAIN_TIMEOUT_MS`, network flaps), and a
bounded upstream pool 503s new POSTs until a held stream frees.
Playwright never bfcaches, upgrades to WS, or flaps, so it never
saturates the pool. Remediation is reducing held-stream occupation
(shorter/adaptive fetch keepalive; close the held stream on
`pagehide`/`freeze`), not a channel-handler change.

---

## Backlog

### A declared 404 boundary — skipping the wasted render on unmatched URLs

A document GET for a URL no spec matches (a favicon probe with no
`public/` file, a mistyped URL) renders the whole tree just to have
the app's fallback throw `notFound()` — the full `<Root/>` output is
discarded. A pre-render short-circuit on "no registered match pattern
covers this pathname" was tried and REVERTED: it 404'd the website's
entire world, because an app built of bare matchless partons renders
real content at every pathname — the registry alone cannot
distinguish "no page here" from "every URL is a page". The missing
piece is an app-DECLARED signal: the 404-fallback surface (today an
app component that walks `getRegisteredMatchPatterns()` and throws)
could register its existence with the framework, and only THEN may
the entry short-circuit unmatched document GETs ahead of the render.
Ship it as a framework-provided fallback primitive with the
registration built in, replacing e2e-testing's hand-rolled one.

### Scoped selectors / module-scoped auto-ids

Resolve selector tokens (`#foo` / `.bar`) per module or per spec-tree
path instead of in a global flat namespace. Today the spec catalog is
one flat map keyed by id — a same-generation duplicate claim now
THROWS at construct time naming both definition sites (the collision
gate in `spec-catalog.ts`), so the failure is loud, but the namespace
is still flat: two modules can't both auto-name a Render
`SearchResults`.

The durable fix is folding module identity into AUTO-derived ids —
`greeting-page/second-parton`, the way `use client` references are
stamped with `path#export`. Findings from the identity-fix arc
(2026-07): nothing in the toolchain reaches `parton()` with a module
id today. The `@vitejs/plugin-rsc` patch is a RUNTIME Flight patch
(per-component ALS for server context) — module identity at define
time isn't in it, and `parton()` executes at module-eval time when no
render/request context exists. A stack-derived path is a heuristic
(dev fs paths vs prod bundle paths diverge → ids would differ between
dev and prod, breaking cached fps and CMS auto storage keys), so the
real lever is a NEW compile-time transform stamping the importer's
root-relative module id into `parton()` / `block()` calls — it must
cover both constructor forms plus `_buildPartial`, keep dev/prod ids
byte-identical, and accept a one-time re-key of wire ids and
auto-named `block()` storage keys. Deferred until that transform is
worth its weight (multi-team adoption pressure).

String tokens are brittle past a single codebase — highest-leverage
backlog item before multi-team adoption.

### Pattern-based cache invalidation

Today, cache entries are invalidated by spec id or by tag. The dep
result that produced each cache key is stored alongside, so a third
invalidation axis is mechanically available: "drop every cache entry
whose dep record contains `cookie:user_id=42`" (or
`pathname:/p/abc`, etc.). Useful when a session-level change (logout,
locale switch, A/B bucket flip) needs to fan out across every spec
that depended on it without the caller knowing each affected partial
id.

Open questions:

- **Storage shape.** Dep records are hashed into the cache key, not
  stored as queryable fields. Either keep a side-index
  `(key → depsKey)` to walk, or accept O(n) scan over cache
  entries on invalidation (probably fine for sub-10k entries).
- **Surface.** Extend `getServerNavigation().reload(...)` to accept
  a `match: { cookie: "user_id", value: "42" }` shape alongside the
  current `selector` form. Same call site, additional dimension.
- **Cross-key dimensions.** Matching on `cookie` keys assumes the
  dep record encodes them in a stable shape. Dep keys are already
  deterministic (`cookie:user_id`), so the matcher has a stable
  surface to query.

### Live in-place re-embed after an in-embed cell write

An in-embed `cell.set` (the client-reference write path) commits and
fans out — the standalone page and any refetch/re-embed see the new
value — but the EMBEDDED copy updates in place only when a streaming
lane rides an open live connection to it. Pushing that lane for the
in-embed-write case is a delivery-plane follow-up, not a write-path
gap.

### Cross-tab sync via BroadcastChannel

When tab A runs a server action that invalidates `["cart"]`, tab B is stale — unless it holds a `?live=1` heartbeat connection, in which case the process-global invalidation registry wakes its segment stream and pushes the update. But the heartbeat costs one long-poll connection per tab. A BroadcastChannel propagating invalidation signals across same-origin tabs would make multi-tab behaviour correct by default without every tab holding a stream open (one tab holds the connection, the others hear the bump and refetch).

### Persist optimistic unsaved cell values

`useCell` shows the optimistic-aware value (`latestSentByCell`) while writes are pending; on reconcile the server's value wins. The optimistic value lives in React memory and dies on reload. For drafts and rapid-edit flows the user may close the tab mid-write, return, and expect the unsaved value to still be there.

Persist `latestSentByCell` to `sessionStorage` (or IndexedDB for larger payloads) keyed by cell id + partition key, with a short TTL. On mount, hydrate the optimistic map from storage. Only persist entries with `pendingByCell[id] > 0` — once a write settles, drop the persisted entry. Open questions: cross-tab coherence (two tabs both write the same cell — last-write-wins?), and whether to surface the persisted state to the renderer differently from a fresh in-flight write.

### Sharp edge: a bare `refreshSelector(name)` is too broad by default

Today `refreshSelector("cart")` with no constraints bumps **every** parton that reads `tag("cart")`, across every connected viewer. The grammar supports per-request scoping via query-string constraints (`cart?cart_id=${cartId}`, matched as a subset of the parton's constraint surface — match params + bound cell args), but the safe pattern is opt-in: forget the constraint and one user's cart mutation causes every other viewer's cart to refetch on their next nav. Silent footgun — the caller sees correct local behaviour; the cross-user fan-out only shows up under load.

Cells mitigate twice: partition-scoped writes (`cell.set` bumps `cell:<id>?<args>`, never the bare label) and storage-as-authoritative reads (a bare-bump re-render reads cell storage, so no upstream round-trip unless the loader misses). But the registry walk + re-render still happens per viewer, and any non-cell loader in the re-rendered body is a real upstream round-trip.

Possible directions:

- **Syntactic sugar.** `refreshSelector("cart", { scope: { cart_id: cartId } })` as a readable alternative to query-string interpolation. Same semantics; easier to read for multi-key cases.
- **Auto-scope from declared read keys.** If the framework tracks which `readCookie` / `readHeader` calls happened during the action body, fold those into default constraints. Render bodies already get this for free (the read is the dependency — tracked hooks fold into the fp via dep records); action bodies have no equivalent instrumentation yet. Small cost, large ergonomic win — the action says what it touched without naming each axis.
- **Dev warning on bare bumps.** Warn when a `refreshSelector(name)` would match >1 distinct constraint tuple in the current registry snapshot. Catches the footgun in development; ships nothing to production.

Not urgent: the cart action is the only real per-user mutation in-tree today; CMS draft is process-global; cells absorb the bare-bump cost via fp-skip. Real pressure arrives when a multi-user app ships several per-user mutating actions and the upstream round-trips start showing in flame graphs.

### Keepalive follow-ups (server-driven TTL, device-aware eviction)

Keepalive itself (matchKey-keyed Activity siblings + fp-trailer
cold→warm drift recovery) is shipped — see
[`../reference/partial.md`](../reference/partial.md) § `keepalive`
and [`../internals/render-pipeline.md`](../internals/render-pipeline.md)
§ "Cold → warm fp drift and the trailer". Two extensions remain:

- **Server-driven cache-control on the wire.** Today `keepalive`
  has no time component on the client — variants stay cached until
  the next layout boundary prunes them. The server side already has
  the freshness vocabulary (`expires()` / `staleUntil()` wake hints,
  `cache: { maxAge, staleWhileRevalidate }`); the extension is to
  surface those numbers via the same trailer channel and have the
  client use them to decide
  when to even advertise the id in its cached manifest on the next nav (within
  `maxAge`: paint cached, skip the network round-trip for this id
  entirely; within SWR window: advertise in the manifest and
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

### Restart-streaming via segmented Flight — resolved by the live segment driver

Shipped as the segmented live response: the driver keeps the stream
open for `?live=1` subscriptions (the opt-in `<LivePageHeartbeat>`
long-poll) or `markConnectionLive()`, wakes on any invalidation-registry
bump or `expires()` boundary, re-renders, and emits the next
`next`-tagged segment; per-parton lanes multiplex high-frequency
streams. The open questions resolved themselves: the iteration loop is
the registry wait + wake hints (no `useRevalidate`), framing reuses the
fp-trailer sentinel with distinct tags, and backpressure is intrinsic —
each segment renders _current_ state, so intermediate states coalesce.
See [`../internals/streaming.md`](../internals/streaming.md).

### Activate ⇄ deactivate symmetry — resolved by read-tracked culling

Shipped as `visible()` — not the per-item `deactivate()` sketch, but a
tri-state tracked read that folds a parton's viewport state into its
fingerprint, so it self-refetches (full ⇄ skeleton) as it enters or
leaves view. Design + framework-level findings live in
[`view-culling.md`](./view-culling.md).

### Speculation Rules API — cross-document prefetch complement

**Shipped — the in-app path.** `useNavigation().preload(target)` warms a
destination's partials into the client RSC cache on hover: a
same-document, warm-only GET walked into
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
  and issue an RSC refetch GET. `intercept()` only applies to
  same-document navigations, so a speculation never fires for an
  intercepted link; and even when one does fire (a nav parton doesn't
  intercept), an activated prerender is a _cold_ parton boot (fresh
  `_currentPagePartials`) and a prefetch warms the _document_ entry, not
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
  can't be sensibly prerendered; the recorded dep sets already tell
  us which (the read is the dependency). Default could be "prerender
  any spec whose tracked reads are only `params` + `pathname`" — with
  the caveat that dep records exist only after a first render, so the
  gate needs a warm registry or a dry render.
- **Sitemap-only vs sitemap+prerender.** They share the enumeration
  but have different cost profiles; probably two phases of the same
  pipeline.

### Pluggable stores for horizontal scale

Cells (`setCellStorage`, the `CellStorage` adapter contract) and CMS
content (`setCmsStorage`) already have pluggable backends. Still
per-process: sessions (in-memory with a TTL sweep;
`configureSessionStore` configures, doesn't swap the store), the
render byte-cache, and the partial registry. Define a `Store<K, V>`
interface for those three and audit each for value serializability.
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

Per-user fingerprints already derive automatically the moment a body
reads the principal through a tracked hook (`session()` / a `cookie()`
read) — the read is the dependency. What's undecided: whether the
principal becomes a first-class hook (`user()`, with the provider
wiring behind it) or stays an app-level cookie read + action-handler
concern. Investigate whether CSRF protection inherits from
same-origin + session cookies (Next.js's stance) or needs a
framework-issued token. Provider impl downstream.

### Head metadata

Surface a sync per-spec `title` contribution the framework collects
and emits in `<head>` before the body streams. React 19's metadata
hoisting handles _placement_ (an inline `<title>` rendered anywhere
hoists), but not _timing_ — a title rendered after an await arrives
too late in the stream for first paint. The contribution needs a
pre-body surface, and the spec constructor has no pre-render callback
to hang it on — the natural candidate is a spec option (static or a
sync function of match params). Open Graph / canonical /
structured-data not urgent.

### Performance tracing

Add a per-partial instrumentation interface (`onPartialStart` /
`onPartialEnd` / `onCacheHit` etc.) for slow-spec warnings, trace
propagation across partial boundaries, and cache hit/miss metrics.
OpenTelemetry adapter as one impl; bring-your-own logger as another.

### i18n — locale routing + translations

Locale as a request _dimension_ already works with zero declaration: a
body that reads the locale cookie/header through a tracked hook folds
it into its fingerprint like any other read. What's missing is
everything above that: locale-aware routing (`/nl/p/:slug`), a
translation function, and locale as a CMS content axis (see
[`cell-dimensionality.md`](./cell-dimensionality.md) for the storage
side). Required for the "CMS" framing — multi-locale content is
table-stakes for a CMS.

### Error recovery

Layer on top of `PartialErrorBoundary`: typed errors, retry/backoff
policies, circuit breakers, serve-stale-on-error (reuse the SWR
entry on transient errors), error → observability hook.

### a11y defaults for refetch

`aria-busy` during pending refetches, focus restoration policy
across swaps, live-region announcements. Currently on the app —
will be pile-of-ad-hoc in a year without framework-level defaults.

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

### RemoteFrame v2 — signed capability tokens

Today the capability header is trust-the-network: the remote
believes whatever the host puts in `x-parton-capability`. For
real third-party deployments, the remote needs to verify the
host's claims (this cart-id actually exists, this user actually
owns it, this total is what was quoted). HMAC-signed tokens
with an expiration and an issuer are the obvious shape — pick
JWT or PASETO depending on team taste. Full design cut in
[`remote-frame-design.md`](./remote-frame-design.md) §6.

The signing key lives at the host; the verification key is
either the host's public key (asymmetric) or a shared secret
(symmetric, simpler but harder to rotate). For Stripe-style
"third-party serves a checkout widget" the signature is
non-optional; for "Adobe-vetted module in a trusted deployment"
it's overkill.

### RemoteFrame — same-origin batching

Today every `<RemoteFrame>` placement fires its own fetch — N
placements against the same origin are N separate requests
(even identical `(url, capability)` copies). Common case in commerce: a checkout
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

The second claim is the one that distinguishes this from Next.js App Router in the long run. Everything that reinstates a static walker (typed partial registries via codegen, explicit route manifests, declarative input schemas resolved at build time) works against it. When evaluating future directions, the test is: _can this self-register at render time instead of requiring a pre-render walk?_ The current `parton` / `block` constructors pass that test — every spec self-registers when its module loads. Typed-handle codegen fails it. Keep that principle sharp — it's the architectural load-bearing idea and it's easy to erode one convenient walker at a time.

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
doc. Cells today are global or session-scoped (`partition:
({session}) => …` — cookie-shared across tabs). The cross-tab leak via
session-scoped frame URL — tab A opens a drawer, tab B's drawer opens
on next render — wants a per-tab axis the server can read sync. Stamp
a per-tab id (`sessionStorage`-backed nonce) into a header on every
request; expose as a tracked read (`tab()`, folding into the fp like
`session()`) and as a cell partition axis, plus `useTabState("key",
value)` on the client. Sharp constraint (JSON-serializable, small) so
it doesn't become the dumping ground for "state I didn't want to
think about."

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
