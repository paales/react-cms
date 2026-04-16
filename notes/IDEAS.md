Server utility components:

```tsx
<Suspense fallback={<LoadingComponent />}>
  <RealComponent />
</Suspense>
```

Not sure how this should handle user errors, we don't usually get some obscure AND recoverable errors. -->

```tsx
<ErrorBoundary fallback={"Oh noo"}>
  <RealComponent />
</ErrorBoundary>
```

Uses Activity for it's children?

```tsx
<IntersectionObserver>
  <PartialComponent />
</IntersectionObserver>
```

Not sure what to do? How is this different than Suspense?

```tsx
<Optimistic preview={<OptimisticComponent />}>
  <RealComponent />
</Optimistic>
```

Client utility components, maybe this now replaced by Activity.

```tsx
<MediaQuery></MediaQuery>
<LazyHydrate></LazyHydrate>
<ViewTransition><Partial/></ViewTransition>?
```

GraphQL @defer support in combination with Suspense.
GraphQL response cache and query caching. Add a product to the cart and dont need to refetch the cart because the same normalized cache is shared between the two requests, creating a faster roundtrip.

---

## Borrowed-from-Inertia candidates (2026-04-16)

### Lazy partials (`<Partial lazy>`)
Server-side counterpart to `<WhenVisible>`. On initial render the partial's content does not execute — only the fallback is streamed. An explicit `usePartial(id).refetch()` (from a button, WhenVisible, hover-prefetch, websocket, whatever) triggers the first real render. Rationale: `<WhenVisible>` is one specific *activation* strategy; `lazy` is the *deferral* decision, orthogonal to who triggers it. Inspired by Inertia's `Inertia::lazy()`. See chat 2026-04-16.

### Refetch-trigger pattern (not a new primitive)
Document `<WhenVisible>` as one instance of a broader pattern: any client condition → `usePartial(id).refetch()`. Likely a `useRefetchTrigger(id, signal)` hook or just a convention. Other canonical instances: poll (`setInterval`), hover-prefetch, websocket message, `visibilitychange`. No framework code needed — just a coherent story + a couple of examples in the docs.

### Prefetch links
`<PartialPrefetch id="trivia" on="hover">` or `<Link prefetch>` for full-page nav. Fires a refetch on hover/mousedown intent, populates `_cache` so the real click/scroll-activation is instant. Short TTL (~30s) so stale hovered data doesn't sit around. Pairs naturally with `lazy` and `<WhenVisible>`.

### Rich refetch event hooks + per-partial progress
`usePartial` returns `isPending` today. Inertia emits `start / progress / success / error / finish` on every visit. Adding callback options to the refetch call (`refetch(props, { onSuccess, onError, onProgress })`) or an event emitter keyed per-partial would let apps build NProgress-style top bars, per-partial progress affordances, and analytics without forking the framework.

Deliberately skipped (Inertia has these, we don't need them): Deferred Props (Suspense is better), useForm (RSC actions cover it), stacked modals (too specific), full Visit API surface.

---

## State-preserving refetches (2026-04-16)

Today's partial-refetch dichotomy in `partial.tsx`:
- **Fresh mount** (default, `<Suspense key={id#version}>`) → React unmounts/remounts → progressive streaming of nested Suspense boundaries works, **client state inside is destroyed**.
- **Revalidate** (opt-in `?revalidate=1`, bare `<Suspense key={id}>`) → reconcile in place → **client state preserved**, no progressive streaming (startTransition waits for whole subtree).

Live-search is the canonical casualty: every keystroke that refetches risks nuking input focus, selection, scroll, IME state. Cart-badge works in revalidate mode because it has no inner Suspense boundaries to stream.

The `revalidate` flag exists *purely* because of how React reconciled pending Suspense subtrees in the React version this was built against. If that changed in React 19 stable, the whole distinction might collapse.

Things to investigate, in order:

1. **Re-test streaming-on-update in React 19 stable.** Bare-key refetch + multiple nested async Suspense boundaries. Do chunks flush progressively without the remount? If yes → delete the `revalidate` branch, default to bare key, problem solved.
2. **If (1) fails**, decouple render identity (what Suspense's `key` controls) from state identity (what client components care about). Candidate: a `<PartialState scope="search-form">` boundary — tiny client component that caches its children's state via context/ref, survives parent Suspense remounts. Non-trivial to make work with arbitrary client hooks inside, but tractable for known state holders.
3. **`<Activity/>` is *not* the fix.** Activity keeps a subtree mounted-but-paused; it doesn't let a *new* render *inherit* the paused tree's state. Useful for tab-style preservation, not for "server content updated, client state stays."
4. **Ship the instance-identity debugger.** `useRef(() => randomColor())` rendered as a small corner dot in dev builds. Dot color changes → component remounted. Turns "did my component just remount" from a guessing game into a glance. Lives alongside the PartialDebugPanel status dots.

Chat context: 2026-04-16 — user flagged that the current fresh-mount / revalidate split is load-bearing only because of streaming, and may be removable.
