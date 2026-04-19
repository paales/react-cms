## Borrowed-from-Inertia candidates (2026-04-16)

### Lazy partials — SHIPPED as `<Partial defer>` (2026-04-18)

`defer={true}` emits fallback only; app calls `usePartial(id).refetch()` whenever. `defer={<Activator/>}` wires a client-side trigger automatically. Companion hook `useActivate(partialId, subscribe)` is the primitive every activator is built on. See `DEFER_ACTIVATORS.md`.

### Refetch-trigger pattern — SHIPPED as `useActivate`

`<WhenVisible>` is one reference activator built on the `useActivate(partialId, subscribe)` hook. Adding a new trigger type (idle, event, mediaQuery) is ~30 lines against that contract. Reference activators (`<WhenVisible>`, `<WhenStored>`) live in userspace (`src/app/components/`) — the framework only ships `defer` + `useActivate`. The `<AnyOf>` wrapper and a subsequent array/fragment `DeferSpec` experiment were both removed on 2026-04-19: `defer` takes one element; composition is written as a bespoke activator when needed.

### Prefetch links

`<PartialPrefetch id="trivia" on="hover">` or `<Link prefetch>` for full-page nav. Fires a refetch on hover/mousedown intent, populates `_cache` so the real click/scroll-activation is instant. Short TTL (~30s) so stale hovered data doesn't sit around. Pairs naturally with `lazy` and `<WhenVisible>`.

### Rich refetch event hooks + per-partial progress

`usePartial` returns `isPending` today. Inertia emits `start / progress / success / error / finish` on every visit. Adding callback options to the refetch call (`refetch(props, { onSuccess, onError, onProgress })`) or an event emitter keyed per-partial would let apps build NProgress-style top bars, per-partial progress affordances, and analytics without forking the framework.

Deliberately skipped (Inertia has these, we don't need them): Deferred Props (Suspense is better), useForm (RSC actions cover it), stacked modals (too specific), full Visit API surface.

---

## State-preserving refetches — RESOLVED (2026-04-16 → 2026-04-17)

**Resolution:** bare-key + `startTransition` default. The old
`?revalidate=1` flag and `streamVersion` key stamping are gone. React
19.3 on a bare-key refetch reconciles in place AND streams per-chunk
(outside transitions), so the fresh-mount / revalidate split was
unnecessary. Full write-up: `LESSONS.md` §1–§3 and
`/archive/BARE_KEY_REFETCH.md`.

Open tail:

- **Instance-identity debugger.** `useRef(() => randomColor())`
  rendered as a small corner dot in dev builds. Dot color changes →
  component remounted. Turns "did my component just remount" from a
  guessing game into a glance. Still worth building; lives alongside
  the PartialDebugPanel status dots.

---

## Fingerprint-skip v2 (2026-04-17)

Navigations now use the fingerprint-compare already embedded in the
`?cached=id:fp,…` protocol: server renders the skipped partials as
`<i data-partial hidden key={id}/>` placeholders, client fills from
its `_cache`. Empirical win on `/pokemon/1 → /pokemon/1?search=url`:
~75 KB → ~34 KB (~55% smaller). Regression test in
`e2e/fingerprint-skip.spec.ts`.

Follow-ups worth considering:

1. **Widen the match.** Today the fingerprint is purely structural
   (component name + scalar props + recursion). Two refetches of
   `<Partial id="cart">` from different carts hash the same because
   they carry no discriminating prop. In practice that's fine because
   carts render via `getRequest()` context, not props — but it means
   the server still has to execute the partial to know the output
   differs. A **content fingerprint** (hash of the decoded Flight
   bytes) would let two matching _renders_ share cached bytes, but
   costs a render to compute. Probably not worth it unless we see
   "server re-rendering identical output repeatedly" in practice.

2. **Prune stale `_cache` entries — RESOLVED (2026-04-19).** After
   every streaming render, the client now collects the placeholder
   ids in the derived template and drops `_cache` entries whose id
   isn't in that set. `_fingerprints` is cleared in the same pass —
   every live id is re-registered by its `PartialErrorBoundary`
   during the subsequent React render (both top-level and deep
   inside cached ancestors). The old problem — an earlier
   `cache.clear()` was clobbering skipped placeholders — is avoided
   by pruning AFTER `cacheFromStreamingChildren` + `deriveTemplate`
   run, so placeholders emitted for fingerprint-match ids still find
   their cache entry. Regression cover:
   `e2e/cache-prune-across-nav.spec.ts`.

3. **Per-partial opt-out.** An author may want a partial that
   _always_ re-renders on nav regardless of fingerprint match
   (e.g., a server-time readout). Would need a prop on `<Partial>`
   like `alwaysFresh` (or its inverse `cacheOnNav`) plus a filter
   in the skip loop. Not needed yet, but predictable ask.

---

## Cache + dynamic Partials — RESOLVED (2026-04-17)

**Resolution:** `<Cache>` now uses strip-on-store + reinject-on-return.
The rendered tree has its partial-bearing subtrees replaced with `<i
data-partial>` placeholders before the bytes are stored; on hit, the
registry is consulted to splice live `<PartialBoundary>` elements
back into the decoded tree. Dynamic partials inside a cached region
stay live. See `SERVER_CACHE_NOTES.md · Follow-up · The fix: strip-
on-store + reinject-on-return` for the implementation notes.

Open tails:

1. **Double-render on miss — RESOLVED.** On cold miss
   `renderToReadableStream` runs once; `stream.tee()` splits it
   into a user branch (decoded immediately, streamed to the outer
   render) and a storage branch (buffered, re-stripped of dynamic
   wrappers, re-encoded, stored in the background). User-facing
   latency is not doubled; inner async work (GraphQL) still fires
   exactly once. CPU / memory overhead from the storage-side
   encode → decode → re-encode cycle remains, but runs off the
   critical path. See `renderMissAndStore` in `cache.tsx`.
2. **Post-HMR cold hit.** If the cache hit lands on a request after
   `clearRegistry()` (HMR, new process), `lookupPartial` returns
   nothing and reinject produces placeholders only. Today this is
   harmless in practice — the test harness clears both stores
   together via `/__test/clear-caches`, and real dev restarts flush
   both via the HMR listener. Worth keeping in mind if we ever add
   a cross-process cache backend (Redis).

---

## Stringly-typed ids — selector-based addressing (2026-04-19)

**Problem.** `<Partial id="hero">` on the server and `usePartial("hero")` on the client are linked only by a string. No rename support, no uniqueness guarantee beyond the runtime throw, no help for dynamic ids (`price-${sku}`) that self-register via `PartialBoundary`. `user-ideas.md` §stringly-typed-ids has the raw notes.

**Direction being explored: CSS-selector addressing.** Keep the string, but treat it like `className` / `id` on DOM: non-unique `tagName={"price product"}` alongside a unique (optional) `id`. `usePartial` accepts a selector string and the returned handle acts on the matched set:

- `usePartial("#header")` — unique-id match (today's behavior, sugar for "tag with uniqueness constraint").
- `usePartial(".price")` — every Partial carrying the `price` tag. Refetching the handle refetches all matches.
- `usePartial('.price[data-sku="ABC"]')` — attribute selector keys by arbitrary data, which eliminates the id-family problem: dynamic Partials stop being a special case.

Why this beats the alternatives we considered:

- **Typed handles / `definePartial`** — nice type story but breaks on the server/client split (a server component can't be imported into a client bundle, so `usePartial(HeroHandle)` needs a bundler-level `"use partial"` directive à la `"use server"`. Doable, but large).
- **Typed factories / partial families** — HOC-shaped, which the user rejected as a primitive. Collapses into the selector story anyway (a family is just `.tagName[attr=value]`).
- **Codegen union types** — still worth doing as a cheap stepping stone (scan for `<Partial id>` literals, emit `type PartialId = "hero" | …` for autocomplete + typo detection), but doesn't solve dynamic ids.

**Two decisions this design needs.**

1. Does `usePartial(".price")` return one handle that batches across matches, or a list? Recommend one handle — "refetch the selection" is the operation.
2. If selectors are the public API, is `id` just "tag with uniqueness constraint"? Likely yes — collapse the concepts. `#foo` becomes the uniqueness-checked form of `.foo`.

**Pseudo-selectors are a growth vector.** `.price:cached`, `.price:stale`, `.price:visible` give you a vocabulary to grow into (condition-scoped invalidation, observability filters) without inventing new APIs per case.

**Tag-first refetch policy.** A related simplification: de-emphasize per-id refetch in favor of tag-based invalidation as the primary channel. Most "refetch this specific thing" calls are really "invalidate this *kind* of thing." If tags are the public API and ids are the internal address, the stringly-typed surface shrinks considerably.

---

## Framework direction — backlog (2026-04-19)

Captured from a design session that walked the full app + lib + framework surface and compared it against `user-ideas.md`. These are directions that are not yet in-flight anywhere; some overlap with user-ideas at a conceptual level but add a concrete shape.

### Request-scoped data loader / dedup

Two Partials that both call `client.request(ProductsQuery)` today each hit the API. There's no per-request memo. A `useLoader(key, fn)` primitive — or a DataLoader-style batcher for per-row fetches — would dedupe within one render and make dynamic Partials (price-per-sku) composable without N+1. This is the simpler, framework-level analogue of the GraphQL normalized cache in `user-ideas.md` §graphql-response-cache; worth shipping first because it's independent of the data layer.

### Optimistic updates as a Partial primitive

Server-action → invalidate is round-tripping. `<Partial optimistic={(prev, input) => next}>` would render the optimistic state immediately and reconcile on commit. Same plumbing as `__inputs`, different phase of the lifecycle. Pairs naturally with the form primitives below.

### Cache invalidation by manifest value

Today `<Cache>` entries can be invalidated by id or tag. The manifest store already records *which* cookies/headers/URL params each entry depends on (see `AUTO_TRACKED_CACHE_KEYS.md`). So `invalidateByManifest({ cookie: "user_id", value: "42" })` could walk the manifest store and drop every entry read under that cookie value. Missing third axis of invalidation; falls out nearly for free from the tracked-accessor design.

### Cross-tab sync via BroadcastChannel

When tab A runs a server action that invalidates `["cart"]`, tab B is stale. A BroadcastChannel propagating invalidation signals across same-origin tabs would make multi-tab behaviour correct by default. Strictly simpler than server-push realtime (no websocket infra) and probably what 90% of apps actually need.

### Re-defer / unmount policy

`DEFER_ACTIVATORS.md` §Known-sharp-edges flags this: once activated, a Partial can't go dormant again. Design space: `<Partial unmountWhen={<WhenHidden/>}>`, memory-pressure eviction, TTL after last interaction. Relevant for long-session CMS pages where hundreds of Partials accumulate.

### Form primitives on top of Partials

React 19 actions + `useFormState` + the existing `invalidate` directive can be unified into a `<PartialForm partial="cart" action={addToCart}>` primitive: action runs, returns new cart, partial re-renders, progressive enhancement works without JS. No new protocol — ergonomics on top of what `entry.rsc.tsx` §server-action-handling already implements.

### Speculation Rules API integration

Browsers now have native prerender/prefetch. A framework-level `<PartialPrefetch>` could emit `<script type="speculationrules">` for likely-next refetch URLs, getting hover-prefetch without JS. Complement to the existing hover-prefetch idea earlier in this doc (§Prefetch-links).

### Flash / toast return channel from server actions

Actions invalidate Partials; they could also `return { flash: "Added to cart" }`. A `<FlashPartial>` that subscribes to action return values and displays transient messages would let actions communicate outcomes without the app hand-wiring channels. Small but high-leverage for CMS authoring flows.

### Deployment-unit split / remote Partials

The strip-and-reinject mechanics in `cache.tsx` already support this: the outer cached bytes can come from anywhere as long as placeholders get reinjected on the way out. Framed this way, each Partial becomes independently deployable — one in a worker, one on origin, one from a CDN HTML fragment. This is probably where the "Remote rendered" idea in `user-ideas.md` naturally wants to land.

### Static export / SSG mode

A build step that renders a route at build time, marks the Partials that can't be prerendered (anything reading cookies/headers — the manifest already tells us), and emits an HTML shell plus stubs for the dynamic Partials. Astro-style "islands of dynamism in a static shell," strongly aligned with the "CMS" framing in the repo name.

---

## Operational concerns — not yet designed (2026-04-19)

Things the framework will need before it can host a real app. Flagged here so they don't get forgotten behind the more interesting primitive work.

- **Error recovery beyond `errorWith`.** `PartialErrorBoundary` exists but the design stops at "show a fallback and a retry button." Missing: typed errors, retry/backoff policies, circuit breakers, serve-stale-on-error (the SWR entry is still there — why not reuse it on transient errors?), error → observability hook.
- **Testing harness for Partials.** No primitive for unit-testing a single Partial with mocked request context. Would force `getRequest()` / `getCookie()` / etc. to be injectable (not just ambient) and pay large DX dividends.
- **Accessibility defaults for refetch.** `aria-busy` during pending, focus restoration policy across swaps, live-region announcements. Currently on the app; will be pile-of-ad-hoc in a year.
- **Per-Partial observability.** Trace context threaded through Partial boundaries so logs group automatically. Pairs with the debug-overlay idea in `user-ideas.md` §partial-debugging-component.
- **i18n as a Partial concern.** Locale switching that refetches only locale-sensitive Partials (`tags={["i18n"]}`). Locale as a first-class input alongside URL/cookie state.
- **CMS authoring mode.** Conspicuously absent given the repo name. Directions: draft/preview modes as a Partial property, author-editable regions identified by tag/selector, per-Partial publish workflows, edit-in-place overlays. If the framework's positioning is "CMS," this isn't optional — it's the core use case.

---

## Meta principle — prefer runtime discovery to static analysis (2026-04-19)

Reading the architecture end-to-end, the framework is making two layered claims:

1. **Partials as addressable RSC subtrees** — solid, working, primitive is coherent.
2. **Runtime discovery over static analysis** — fully realized. Every architectural lessons doc (`LESSONS.md`, `LESSONS_FROM_REFACTOR.md`, `LESSONS_2026-04-19.md`) is about removing one more pre-walk, and as of 2026-04-19 the last one (`refreshRegistry`) is gone.

The second claim is the one that distinguishes this from Next.js App Router in the long run. Everything that reinstates a static walker (typed partial registries via codegen, explicit route manifests, declarative input schemas resolved at build time) works against it. When evaluating future directions, the test is: *can this self-register at render time instead of requiring a pre-render walk?* The selector addressing scheme above passes that test. Typed-handle codegen fails it. Keep that principle sharp — it's the architectural load-bearing idea and it's easy to erode one convenient walker at a time.

### How `refreshRegistry` was eliminated (2026-04-19)

The old walker refreshed registry snapshots before cache-mode refetches so their captured closures (e.g. `<SearchStage2 query={searchQuery}/>` where `searchQuery` came from the URL) reflected the current request. It existed because:

- `cloneElement(__inputs)` couldn't drill through a `<Cache dep>` wrapper to reach the inner content.
- The Partial's fingerprint was hashed from pre-override `children`, so even when `__inputs` did apply, the cache key stayed pinned to the stale snapshot's values → cache hit on stale bytes.

Two changes made the walker redundant:

1. `<Cache>` was folded into `<Partial cache>` (part of the auto-tracked cache-keys work), removing the intermediate wrapper. `cloneElement(__inputs)` now reaches the content component directly.
2. `<Partial>`'s fingerprint is now computed AFTER `applyInputs` (`partial-component.tsx`). A cache-mode refetch whose inputs change a prop yields a distinct fingerprint, a distinct `<Cache>` key, and correctly misses stale entries.

With those in place, deleting `refreshRegistry` kept all unit tests and e2e tests passing. The PartialRoot now has exactly two branches (streaming + cache-mode) with no author-JSX walking in either; `stripPartials`/`reinject` in `cache.tsx` is the only remaining walker and it operates on rendered output, not on author JSX.

### Follow-up backlog

- **Unify the two PartialRoot branches** into one. With the walker gone, cache-mode exists only as an optimization (skip ancestor execution on a refetch by rendering directly from snapshots). An alternative: always stream, and have authors wrap expensive ancestors in `<Partial cache>`. The ergonomic trade-off is worth a design pass — the simplification would also let `PartialsClient` shed its `mode` prop.
- **Dynamic-partial-inside-cached-ancestor on partial refetch.** If a refetch targets a dynamic partial whose ancestor is wrapped in `<Partial cache>`, cache-mode pulls the dynamic partial's snapshot directly (works today). Under a unified always-streaming model the ancestor's Partial body would need to NOT skip when it contains a requested descendant — but that requires knowing topology ahead of render, i.e., a static walker. Likely the reason to keep cache-mode as the optimization path, even after the refresh walker is gone.
