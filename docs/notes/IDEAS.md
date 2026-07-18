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

### Warm-tick micro-optimizations (profiled, unclaimed)

The 2026-07 warm-tick profile (the measurement that retired the "~2×
slower" scare — dev-signal parity, prod ~1.25×, the honest price of
per-placement identity; budgets re-recorded at `ba4a1b3`) left two
concrete candidates on the table, together worth maybe 8–12% of the
prod tick:

- **Fold the fp in one pass.** `partial.tsx` hashes overlapping
  concatenations three times per parton (`ownStructuralFp` →
  `structuralFp` → `fp`); `hash()` is ~12.6% of the prod tick.
  Collapse to one pass over the sources + cheap suffix folds.
- **Pre-parse dep-key selectors at record time.** `evalDepKeys`
  re-runs `parseSelector` on every `cell:` dep string on every
  descendant-fold pass — the pulse category's one visible dev delta
  (+9–15%). Parse once when the dep is recorded, store the compiled
  form.

Not urgent — no single frame is pathological; the remaining delta is
inherent to minting and carrying placement-qualified ids. Take these
when a lean-end budget actually pinches.

### Live in-place re-embed after an in-embed cell write

An in-embed `cell.set` (the client-reference write path) commits and
fans out — the standalone page and any refetch/re-embed see the new
value — but the EMBEDDED copy updates in place only when a streaming
lane rides an open live connection to it. Pushing that lane for the
in-embed-write case is a delivery-plane follow-up, not a write-path
gap.

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

### Speculation Rules — the cross-document spike

The in-app path is shipped (`useNavigation().preload` warms the client
RSC cache on hover; a DEGRADED page's preload already emits a
`<script type="speculationrules">` prefetch as its carrier —
`frame-client.tsx`). What remains is the genuinely cross-document
surface Speculation Rules alone can reach: server-emitted per-link
rules (prefetch by default, opt-in prerender, the `eagerness` model),
hover-without-JS in the pre-hydration window, and a `<WhenVisible>`
prefetch co-rider so activation lands warm. Research spike, low
priority.

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

### Package layout — finish the server/client split, classic monorepo shape

Half shipped: `framework/src/client.ts` is the `./client` export (the
DX floor), so the client half of the `"use *"` boundary has its
barrel. Remaining, as one batched mechanical move: name the main
barrel what it now is (a `./server` entry, with `.` kept as alias or
deprecated), re-organize `framework/src/lib/` / `src/runtime/` along
the same client/server axis instead of their current names, and
consider the classic `packages/` + `examples/` monorepo shape with a
short usage guide for which entry to import where (each package
stating whether it has both exports). Import-churn-heavy — do it in a
quiet moment between arcs, never mid-arc.

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

Archived to
[`../archive/transient-client-state.md`](../archive/transient-client-state.md);
directions A + B became the cell primitive
([`../reference/cells.md`](../reference/cells.md)). Two threads from
that doc stay live below.

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
