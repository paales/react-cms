# Cache

Server-side render-output caching. A parton opts in by returning an
`expiresAt` timestamp from its `vary` callback — the framework uses
that as the freshness deadline for the byte cache AND as a wake
hint for the segment driver.

```tsx
const ProductHero = parton(ProductHeroRender, {
  match: "/p/:slug",
  vary: ({ params, search: { variant = "default" }, time }) => ({
    slug: params.slug,
    variant,
    expiresAt: time.in(60_000),
    staleUntil: time.in(90_000),
  }),
})
```

Within `expiresAt`: serve cached bytes (no re-render). Past
`expiresAt` but within `staleUntil`: serve cached AND fire a
background refresh. Past both: miss.

`expiresAt` / `staleUntil` are **reserved keys** in `vary`'s
return — the framework strips them before computing the partial's
fp and before spreading the result into Render's props. They don't
participate in identity, just in TTL.

## Time helpers

The `vary` scope exposes a `time` object with pre-computed boundary
timestamps so authors don't call `Date.now()` themselves:

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

Common patterns:

```ts
// Cached for 60s
vary: ({ time }) => ({ expiresAt: time.in(60_000) })

// Re-render at the next minute boundary (clock displays)
vary: ({ time }) => ({
  minute: Math.floor(time.now / 60_000),
  expiresAt: time.nextMinute,
})

// Cache forever — content never moves
vary: ({ time }) => ({ expiresAt: time.never })
```

## Cache key

```ts
key = hash([
  spec.id,
  structuralFingerprint,    // function-ref-derived shape salt
  innerPartialIds.sorted,   // Partials nested inside the cached subtree
  spec.varyResult,          // the dependency surface declared by `vary`,
                            // minus the stripped `expiresAt` / `staleUntil`
])
```

The cache key surface is `vary`'s return value, minus the reserved
keys. There's no separate "vary scalars on top of an opaque
manifest" — whatever `vary` returns IS what the cache keys on.

## Composition with inner partials

A cached spec may contain other specs in its rendered output. Those
inner partials must stay live across cache hits — refetching them
shouldn't have to wait for the outer spec's TTL.

`<Cache>` (an internal wrapper applied when `vary` returns a finite
`expiresAt`):

1. Walks the rendered tree, replaces every `PartialBoundary` with a
   `<i hidden data-partial>` placeholder.
2. Stores the placeholder-bearing tree as Flight bytes.
3. On hit: decodes the cached bytes, re-injects current live
   `PartialBoundary` elements at each placeholder. Inner partials
   render through their normal pipeline (vary, fingerprint, skip).

## Stale-while-revalidate

```ts
vary: ({ time }) => ({
  expiresAt: time.in(60_000),
  staleUntil: time.in(90_000),
})
```

Within `expiresAt`: serve cached, no refresh. Past `expiresAt` but
within `staleUntil`: serve cached AND fire a background re-render
that overwrites the entry. Past both: miss.

The background refresh is in-flight-deduped per base key — a
thundering herd of cache hits past TTL kicks off exactly one
refresh.

## Bypass

To opt out of caching for a render, don't return `expiresAt` (or
return a value `≤ now`). Useful in dev when iterating on a
component whose `vary` doesn't yet capture every dependency.

## Invalidation

Three axes:

1. **Server-action directives.** An action returns `{invalidate:
   {selector: "cart price"}}` and the framework refetches every spec
   whose id or label list contains "cart" or "price" on the next
   render — bypassing their cache by marking them as explicit
   refetch targets.
2. **Vary-result change.** A page nav whose URL changes a value in
   the spec's vary result produces a different cache key. The old
   entry stays in the store but isn't queried.
3. **`expiresAt` elapsing.** Past the TTL the entry is treated as
   a miss; next render is fresh.

## Live updates

`expiresAt` is also a wake hint for the segment driver's
`?streaming=1` long-poll. When a live connection holds the response
open, the driver races against the earliest `expiresAt` across the
route's snapshots and re-renders at the boundary — so a clock
display with `expiresAt: time.nextSecond` ticks once a second
without any userspace timer. See
[`docs/internals/streaming.md`](../internals/streaming.md).

## Related

- [`docs/partial.md`](./partial.md) for the constructor surface
- [`docs/frames-navigation.md`](./frames-navigation.md) for frames
- [`docs/cms.md`](./cms.md) for CMS-driven cache key contributions
- [`docs/internals/streaming.md`](../internals/streaming.md) for the
  live-update path
