# Cache

Server-side render-output caching. A parton opts in by setting the
`cache` option; the framework stores the rendered Flight bytes for
the spec's subtree and replays them on hit. Distinct from the
`expires()` wake hint — that controls when the fp becomes stale
(wake hint for the segment driver, no byte storage). Caching needs
an explicit opt-in.

The cache lives on the server, full stop. parton is
server-at-the-edge semantics: the DOCUMENT is the CDN-cacheable
artifact, and everything after first paint is a stateful connection
to a live server process — rendered partials exist only as segments
and lanes on the held stream, never as shared-CDN artifacts.
Broadcast semantics (one rendered payload fanned out to many
clients) are a later investigation tied to the multi-instance bus
question ([`../notes/channel-design.md`](../notes/channel-design.md)).

```tsx
const ProductHero = parton(ProductHeroRender, {
  match: "/p/:slug",
  cache: { maxAge: 60, staleWhileRevalidate: 30 },
})
```

Within `maxAge`: serve cached bytes (no re-render). Past `maxAge`
but within `maxAge + staleWhileRevalidate`: serve cached AND fire
a background refresh. Past both: miss.

## Options

```ts
interface CacheOptions {
  maxAge?: number                  // fresh window in seconds
  staleWhileRevalidate?: number    // additional stale-but-servable window
  slowSource?: {…}                 // dev-only debug
}
```

## Time-based reactivity vs. byte caching

The `expires()` hook lets a parton declare **when its fp becomes
stale** without caching anything:

```tsx
function LiveClockRender() {
  const clock = time()
  expires(clock.nextSecond)
  return <span>{new Date(clock.now).toISOString()}</span>
}
```

`expires()` writes a wake hint onto the snapshot — never into the
fp or Render props — and the segment driver's live-update loop wakes
at the boundary. Each segment emits a fresh render. **No byte
storage.**

To combine both — cached AND time-reactive — set `cache` and call
`expires()` in the body:

```tsx
const HotProduct = parton(HotProductRender, {
  match: "/p/:slug",
  cache: { maxAge: 60 },
})

async function HotProductRender({ slug }: { slug: string } & RenderArgs) {
  expires(time().in(60_000))
  …
}
```

There's no useful configuration where the two TTLs differ — the
cache short-circuits the re-execution that `expires()` would
trigger, so keep them aligned.

## `time()` helpers

```ts
interface TimeScope {
  readonly now: number          // Date.now() captured at scope construction
  readonly nextSecond: number   // next whole-second boundary
  readonly nextMinute: number   // next whole-minute boundary
  readonly nextHour: number     // next whole-hour boundary
  readonly nextDay: number      // next UTC-day boundary
  in(ms: number): number        // now + ms
  readonly never: number        // +Infinity — sentinel for "never expires"
}
```

## Cache key

```ts
lookup = `${spec.id}:${structuralFingerprint}:${hash(matchParams)}`
```

`structuralFingerprint` folds the spec's prior dep record (re-read at
the current request), prop-resolved cells, call-site props,
invalidation bumps, and the descendant fold — so it moves whenever
any of those change (including an inner partial added or removed). The trailing
match-params hash is a stable, legible axis on top of that.

The WRITE key is computed after the render, folding the LIVE tracked-
read set — so no entry is ever keyed dep-less. A cold record (no
prior snapshot, empty pre-render fold) therefore misses into a fresh
render rather than serving bytes keyed under different read values,
and per-value entries coexist: the cold path over-fetches, never
serves stale. Wake hints (`expires()` / `staleUntil()`) never enter
the key, so a per-millisecond boundary never shifts it.

## Composition with inner partials

A cached spec may contain other specs in its rendered output. Those
inner partials stay live across cache hits — they re-render fresh per
request, and refetching them never waits for the outer spec's TTL.

This happens at the Flight **wire** level, never by decoding the
cached bytes to a tree (which would force every Suspense boundary to
resolve). `<Cache>` (internal, applied when `cache` is set):

1. **On store:** strips every inner-parton boundary in the rendered
   bytes to an `<i hidden data-partial-id>` placeholder row and drops
   the content it referenced — the stored payload is the lean
   scaffolding.
2. **On hit:** streams the scaffolding back row by row and, at each
   placeholder, splices a freshly-rendered parton (renumbered so the
   parent's reference resolves to it). The inner parton's own Suspense
   streams as its bytes arrive — the cached frame is byte-replayed
   while its holes render live.

A region with no inner partials strips to zero holes and replays as a
pure byte passthrough — same path, streaming intact. See
[`docs/internals/cache-internals.md`](../internals/cache-internals.md).

## Stale-while-revalidate

```ts
cache: { maxAge: 60, staleWhileRevalidate: 30 }
```

Within `maxAge`: serve cached, no refresh. Past `maxAge` but within
`maxAge + staleWhileRevalidate`: serve cached AND fire a background
re-render that overwrites the entry. Past both: miss.

The background refresh is in-flight-deduped per base key — a
thundering herd of cache hits past TTL kicks off exactly one
refresh.

## Invalidation

Three axes:

1. **Server-side `reload({selector})`.** An action body (or any
   server-side task) calls `getServerNavigation().reload({selector:
   "cart price"})` and the framework bumps the invalidation registry
   so every spec whose id or label list contains "cart" or "price"
   sees a fresh fingerprint on the next render — bypassing their
   cache.

   > **Scope per-user state.** A bare selector like `"cart"` has no
   > constraints and matches every cart-tagged parton across every
   > viewer — one user's mutation fans out to every other user's
   > next nav. For per-request state, add a query-string fragment:
   > `reload({ selector: "cart?cart_id=" + cartId })` matches only
   > partons whose effective constraint surface (match params ∪
   > bound cell args) contains `cart_id=<cartId>`. The author owns
   > this discipline; the framework can't auto-scope because it
   > doesn't know which constraint keys are partition axes vs
   > incidental reads. See "Sharp edge: `reload({selector})`
   > is too broad by default" in
   > [`../notes/IDEAS.md`](../notes/IDEAS.md) for the ergonomic
   > follow-up being tracked.
2. **Tracked-input change.** A page nav that changes a tracked
   read's value (or a match param) produces a different cache key.
   The old entry stays in the store but isn't queried.
3. **TTL elapsing.** Past `maxAge` (no swr) or `maxAge + swr`, the
   entry is treated as a miss; next render is fresh.

## Live updates

See [`docs/internals/streaming.md`](../internals/streaming.md) for
the time-based reactivity path. Short version: the `expires()`
boundary is a wake hint for the segment driver holding the page's
live connection. The `cache` prop is independent — caching is byte
storage, `expires()` is a freshness boundary.

## Predictive warming

On a live connection, the byte cache can be filled BEFORE a cullable
parton scrolls into view. Two small surfaces, one mechanism:

```tsx
// "use client" — state the scroll context (deep path per the barrel caveat)
import { reportTelemetry } from "@parton/framework/lib/telemetry.ts"
reportTelemetry({ viewport: { w, h }, scroll: { x, y, vx, vy } })

// server module — map a statement onto the parked partons it will reach
import { registerWarmProjector } from "@parton/framework"
registerWarmProjector((telemetry, candidates) => projectAhead(telemetry, candidates))
```

`reportTelemetry` is the channel's lossy class: newest-wins, rides
envelopes other statements justify (it never generates traffic of
its own), droppable. The projector owns the geometry — how a scroll
vector maps onto parton coordinates (`candidates` carry each parked
parton's `type` + placement props) — and returns ids in priority
order; the segment driver renders them into the byte cache at its
park point, bounded, backpressure-aware, and without emitting a
byte. The next real viewport flip then replays warm bytes.
`useNavigation().preload(target)` fills the same caches by explicit
intent — its `warm` statement runs one byte-silent whole-tree render
of the stated target at the same park point, under the same bounds
(see [`frames-navigation.md`](./frames-navigation.md#preload--a-warm-intent-before-the-click)).
The worked example is the website world
(`website/src/app/world/{scroller.tsx,warm.ts,chunk.tsx}`);
mechanics in [`../internals/streaming.md`](../internals/streaming.md)
§Predictive warming at park.

Only the subtree pays off: the parton's own body function is
invoked on every render, hit or miss (its returned tree is what a
miss stores), so put the costly work — slow fetches, heavy
composition — in child components inside the cached subtree. Tracked
reads and cell resolves stay in the parton body, where they record
(a plain child component's reads are not attributed).

## Related

- [`partial.md`](./partial.md) for the constructor surface
- [`frames-navigation.md`](./frames-navigation.md) for frames
- [`cms.md`](./cms.md) for CMS-driven cache key contributions
- [`../internals/streaming.md`](../internals/streaming.md) for the
  live-update path
