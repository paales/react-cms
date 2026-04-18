## Borrowed-from-Inertia candidates (2026-04-16)

### Lazy partials — SHIPPED as `<Partial defer>` (2026-04-18)

`defer={true}` emits fallback only; app calls `usePartial(id).refetch()` whenever. `defer={<Activator/>}` wires a client-side trigger automatically. Companion hook `useActivate(partialId, subscribe)` is the primitive every activator is built on. See `DEFER_ACTIVATORS.md`.

### Refetch-trigger pattern — SHIPPED as `useActivate`

`<WhenVisible>` is now one of several activators composed from the `useActivate(partialId, subscribe)` hook. Adding a new trigger type (idle, event, mediaQuery) is ~30 lines against that contract. Canonical activators today: `<WhenVisible>`, `<WhenStored>`, `<AnyOf>`.

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
`archive/BARE_KEY_REFETCH.md`.

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

2. **Prune stale `_cache` entries.** `cache.clear()` used to run on
   every streaming render to evict stale entries. That's gone (it
   was clobbering the new skipped partials). Entries accumulate
   across navigations. For the demo app it's fine; a real CMS with
   many routes needs a drop-if-not-in-template pass. Keep entries
   only for ids present in the current `template`.

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

1. **Double-render on miss.** The fix renders, strips, re-encodes.
   Doubles first-load latency. Acceptable for the demo; if a real
   miss rate shows up in practice, a "strip while streaming" path
   would avoid the second render.
2. **Post-HMR cold hit.** If the cache hit lands on a request after
   `clearRegistry()` (HMR, new process), `lookupPartial` returns
   nothing and reinject produces placeholders only. Today this is
   harmless in practice — the test harness clears both stores
   together via `/__test/clear-caches`, and real dev restarts flush
   both via the HMR listener. Worth keeping in mind if we ever add
   a cross-process cache backend (Redis).
