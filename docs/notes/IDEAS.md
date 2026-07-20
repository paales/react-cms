# Forward-looking ideas

Design ideas that still need thought — nothing else. Resolved items
are deleted (or moved to [`../archive/`](../archive/) with a
Superseded banner when the exploration is worth keeping). Bugs and
debt don't live here either: a bug earns a minimal reproducing test in
the same sitting it's found, or it doesn't exist yet — vague sightings
are not tracked.

---

## Backlog

### Module-scoped auto-ids

The spec catalog is one flat namespace keyed by id — a duplicate claim
throws at construct time naming both definition sites, but two modules
still can't both auto-name a Render `SearchResults`. The durable fix
folds module identity into auto-derived ids
(`greeting-page/second-parton`, the way `use client` references are
stamped `path#export`). Findings from the 2026-07 identity arc:
nothing in the toolchain reaches `parton()` with a module id today
(the `@vitejs/plugin-rsc` patch is runtime-only, and `parton()` runs
at module eval); a stack-derived path is a dev/prod-divergent
heuristic. The real lever is a compile-time transform stamping the
importer's root-relative module id into `parton()` / `block()` /
`_buildPartial`, byte-identical across dev and prod, with a one-time
re-key of wire ids and auto-named `block()` storage keys. Deferred
until multi-team adoption pressure — but it's the highest-leverage
item before that day.

### Server-driven client cache-control

The server already speaks freshness (`expires()` / `staleUntil()`,
`cache: { maxAge, staleWhileRevalidate }`); the client's keepalive
variants have no time component — they advertise in the manifest until
a layout prune. The idea: carry those numbers on the existing
fp-trailer channel and let the client decide per id — within `maxAge`,
paint cached and skip advertising entirely; inside the SWR window,
advertise and revalidate in background; past both, treat as cold.
Layers on the trailer + matchKey infrastructure with no API change.

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

### `<PartialForm>` as a composed primitive

A higher-level form primitive combining cells (per-field draft, via
`useCell(cell).input(opts)`) with an optimistic submit overlay owning
the submit lifecycle — validation, blur, submit-button state, error
display. The `cell.input()` ↔ RHF `register()` comparison in
[`../reference/cells.md`](../reference/cells.md) is the design surface
to start from. Waits for a real form flow that exercises
submit + validation + draft together.

### Scroller: streaming sources, signed feeds, variable heights

`scroller()` shipped as the window model (`../reference/scroller.md`
— placed span + CSS-arithmetic reservations; the interval-tree
predecessor lives in this arc's git history). Refinements, each
waiting on a forcing caller:

- **Streaming / async-iterator sources.** `range` is offset/limit.
  A feed whose tail streams (chat, activity) wants a source adapter
  over a tail cell + `expires()`, not a new core.
- **Signed spans for prepend feeds.** The span extends append-ward
  today. Anchoring item 0 at first-load and letting indexes go
  signed (the world's chunk coords, in 1D) covers newest-first feeds
  without re-keying.
- **Reservation estimate refinement.** Variable heights shipped
  (rows are `minmax(estimate, auto)`; native anchoring + the
  id-referenced backstop pin the viewport — see
  `../reference/scroller.md`). The reservations still size purely
  from the declared estimate; if real collections drift far from it,
  a measured-average feedback (client-observed mean row height
  refining the reservation calc) is the next lever. Wait for a
  collection that actually drifts.

### The flush boundary — lane bodies buffer to completion

Measured (2026-07-20, browse demo, WS frame timestamps vs commit
polling): a materializing leaf's bytes reach the client ~1.05s after
its backend query returns in ~100ms, and the commit follows the bytes
within ~40ms — the whole wait is server-side. The gate is
architectural: a lane body drains its Flight render into a buffered
chunk list before anything is emitted (`segmented-response.ts`,
`publishBroadcastBody` and the per-connection iteration), so a leaf
whose streamed Suspense content is slow (the demo's 1s price sleep —
any real slow sub-parton) holds its OWN shell hostage: the cards
could paint with price fallbacks the instant the shell rows exist,
but the shell and the fills share one buffered frame. Producer lanes
(chat) already hold open and stream, so the wire grammar has the
vocabulary; the design question is making progressive intra-lane
flush the NORMAL body shape — shell rows flush as produced, Suspense
fills follow — without breaking the broadcast slot (which must
buffer to replay), fp-heal finalization at drain, and the delivery
accounting. The document path has the sibling problem (buffered
Brotli; only `markConnectionLive` flushes). One boundary, two
transports — likely one arc.

### Scroller × broadcast eligibility

D2's classifier marks every cull-gated parton broadcast-ineligible
(the `visible:` dep is per-viewer). Under `scroller()`, every leaf
and item placement is cull-gated — so N viewers of one live-priced
catalog cost N× per-item lanes, exactly the shape broadcast lanes
kill. The body's output is viewer-independent; only the gate is
per-viewer. Investigate "broadcast-eligible when resolved-visible":
publish keyed on the resolved state, per-connection gating stays
local. Delivery-plane change — design against the shared bench.

### Scroller: seed reads fold raw, not resolved

A cull seed's tracked reads (the anchor's `searchParam("page")`)
record raw dep keys, so every span leaf's fp moves when the anchor
value moves — a window move re-sends the whole span even where the
seed VERDICT (and every measured gate) is unchanged. The
resolved-visibility term (`visible:<id>?seed=`) already folds the
verdict; investigate suppressing the seed's raw keys when a
measurement exists (measurement wins the gate), so the anchor stops
being a span-wide fp mover. Needs the fold's re-eval path to re-run
seeds for unmeasured instances.

### A 2D `space` for scroller — wait for the second caller

The scroller is the 1D instance of the world's quadtree; the shared
substance (recursive cull-gated level minting, staggered runways,
seed-by-intersection) is real but small, and the differences
dominate: the world is coordinate-driven (procedural chunks, fixed
px boxes, no estimate, telemetry warming, no URL anchor) where the
scroller is source-driven (range slices, flow layout, estimate,
anchor param). Folding both under one constructor now would be a
false unification — every option would mean something different per
space — and converting the world churns eight validators for zero
behavioral gain while deleting the demo code whose explanatory
comments ARE the exhibit. Extract the shared core only when a real
second 2D caller appears (a coordinate-addressed data grid:
calendar, sheet). `website/src/app/world/quad.tsx` is the donor.
