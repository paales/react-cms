# Errors — the recovery contract

What throws where, what the boundary shows, what retries, and how an
app observes or opts out. The short version: **framework sentinels are
control flow and pass through untouched; a loader failure in a
byte-cached parton serves the last good render with an explicit
staleness marker and retries on a capped backoff; the error card is
reserved for partons with no known-good bytes.**

## What throws where

| Throw site                                                                                                      | What happens                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `notFound()` / `redirect()` — anywhere in a page or parton body                                                 | Control flow, never an error. The sentinel sets the framework control channel eagerly and bubbles past every boundary; the RSC entry translates it into the HTTP status / `Location`. The recovery machinery neither stores, serves stale, nor retries for it. |
| `RenderCancelledError` / aborts                                                                                 | Render lifecycle (a wound-down connection, a superseded lane). Not a failure: no log, no store, no retry.                                                                                                                                                      |
| Schema / props cell resolution, or a **synchronous** `Render` throw                                             | Runs above the per-parton boundary; the spec wrapper contains it as the parton's error card in place ([partial.md § Error containment](./partial.md#error-containment)). Not covered by recovery — resolution failures happen before the body exists.          |
| The **async body** (`Render`'s returned promise) rejecting — a cell loader, a GraphQL read, any awaited failure | The loader-failure case this page is about. For a byte-cached spec the recovery engine intercepts it server-side (below); otherwise the error rides Flight to the parton's client boundary and shows the card.                                                 |
| A **descendant server component** inside the body's returned JSX                                                | Settles the body cleanly, so recovery does not engage; the throw streams into the parton's client boundary as today. Keep loaders in the parton body (where reads record anyway) if you want them covered.                                                     |

## Serve-last-known-good (byte-cached partons)

For a spec with the `cache` option, the byte cache doubles as the
recovery substrate. When a fresh render's body rejects:

1. **Nothing is stored.** A cache entry is always a good render —
   error rows never enter the store, and a stale-while-revalidate
   refresh whose body failed leaves the existing entry untouched.
2. **If a last-known-good entry exists** for the same (id, variant)
   axis — any previously stored good render, even one whose fp or TTL
   has since moved — its bytes are replayed in place of the error,
   wrapped in the staleness marker (below). The client sees the last
   good content, not a card.
3. **If no last-known-good exists** (first visit during an outage),
   the error streams to the parton's client boundary: the bounded
   error card, scoped to the one parton. This is the ONLY case a
   fresh error card is shown.
4. **A retry is scheduled** either way (next section). A successful
   attempt stores, clears the failure streak, and serves fresh —
   recovery has no separate "recovered" path, success is just the
   ordinary store. Repeated failure keeps the NEWEST good render up.

The guard costs no streaming: a miss on an axis holding a
last-known-good waits only for the parton's own loader to settle
before releasing the tree — descendant Suspense streams as usual. (A
descendant's throw is outside the loader contract either way; see the
table above.)

## Retry / backoff

An errored parton re-renders on a capped exponential backoff
(1s · 2ⁿ⁻¹, capped at 16s). The schedule rides the existing wake
machinery: the failure writes its `nextRetryAt` into the render's
wake-hint box — **the errored snapshot declares its own retry
boundary**, exactly the `expires()` shape — so:

- on a live connection, the segment driver's deadline wheel re-lanes
  the parton at the boundary and the re-attempt happens server-side;
  the recovering emission replaces the card / stale content in place
  (the client boundary clears itself on a new emission);
- on request-driven pages, the expired boundary blocks fp-skip and
  the next render attempts;
- **within** the window, a miss serves last-known-good WITHOUT
  running the failing loader — backoff means the loader is not
  hammered, by construction.

## The staleness marker

A last-known-good serve is explicitly marked — a context the UI reads,
never an inference from content age:

```tsx
"use client"
import { usePartonStale } from "@parton/framework/client"

function StaleBadge() {
  const stale = usePartonStale() // PartonStale | null
  if (!stale) return null
  return <span data-stale>{`stale — retrying (attempt ${stale.attempts})`}</span>
}
```

`PartonStale` carries `{ since, attempts, retryAt }`. The provider is
zero-DOM and wraps only stale replays, so the parton's markup stays
byte-identical to the stored render; mount the reading component
inside the cached body (it ships with the good bytes and lights up
only when they are replayed under the marker). Fresh renders,
ordinary cache hits, and SWR serves all read `null`.

## Opting out

```tsx
cache: { maxAge: 60, staleIfError: false }   // never serve stale on error
cache: { maxAge: 60, staleIfError: 300 }     // error-servable ≤ 5min past staleUntil
```

`staleIfError` (HTTP's directive, same name) bounds the error-serve
window past the entry's ordinary `staleUntil`. Omitted = unbounded —
the pilot-friendly default: last-known-good beats an error card at any
age, because the marker makes the age explicit. `false` opts the spec
out entirely (always-authoritative surfaces); retry scheduling still
applies.

## Observability

```ts
import { onPartonError, type PartonErrorEvent } from "@parton/framework"

const off = onPartonError((e: PartonErrorEvent) => {
  // { partonId, error, attempts, servedStale, retryAt }
  metrics.count("parton.render_error", { id: e.partonId, stale: e.servedStale })
})
```

One event per **attempt** (backoff-window serves that skip the loader
don't emit). `error` is the body's real rejection value — sentinels
and cancellations never produce an event. With no handler registered
the framework logs one concise `console.error` line per attempt; the
raw error + stack is independently logged under a digest by the
Flight render's `onError` reporter, so prod's redacted client digest
always traces to a server log line.

## The client boundary

`PartialErrorBoundary` wraps every parton on the client. Its contract:

- a descendant throw becomes the inline error card (or the spec's
  `fallback`-less default) with a retry button; sibling partons and
  the page chrome are untouched;
- `__framework`-branded errors re-throw past it (sentinels to the RSC
  entry, `NavigationError` to the host boundary);
- **an errored boundary clears when a new emission arrives** — the
  server-side retry's recovering render replaces the card without any
  client-side bookkeeping;
- while errored, the boundary **withholds its fp advertisement** — an
  error card is not the content the fp names, so the server can never
  fp-skip a recovery render against it (over-fetch, never a pinned
  card).

## Non-cached partons

Without the `cache` option there is no byte substrate to serve from:
a body failure shows the card, and re-render happens on the next
navigation/refetch (the withheld fp guarantees it actually re-runs)
or the manual retry button. If a flaky loader needs the full
serve-stale + scheduled-retry contract, give the spec a `cache`
option — even a small `maxAge` enrolls it; the recovery windows are
governed by `staleIfError`, not by how long the fresh window is.

## The worked example — the flaky district

The website world (`website/src/app/world/`) ships the forcing
caller: a plane region whose chunk loaders fail on a deterministic
(coords × 12s-bucket) schedule (`flaky.ts` — no `Math.random` in
bodies, per the tracking invariant). Scroll south-west from the
origin: first-visit failures show the bounded card, visited chunks
serve last-known-good wearing an amber `STALE` badge
(`stale-badge.tsx` reading `usePartonStale()`), and recovery clears
badges as buckets roll and retries land.

## Related

- [`cache.md`](./cache.md) — the byte cache the recovery rides
- [`../internals/cache-internals.md`](../internals/cache-internals.md) — mechanism
- [`partial.md`](./partial.md#error-containment) — resolution-phase containment
