# `defer` + activators — design notes

**Added:** 2026-04-18
**Updated:** 2026-04-21 (post `usePartial` removal — `fire()` now takes no args; activators that need to pass state to the server write it to a URL and let the targeted reload pick it up via tracked accessors).
**Files:** `src/lib/partial-component.tsx`, `src/lib/partial-client.tsx`. Reference activator implementations live in userspace: `src/app/components/when-visible.tsx`, `src/app/components/when-stored.tsx`.
**Related:** `NAVIGATE_UNIFIED.md` covers the `useNavigation().reload(...)` surface that activators now fire into.

---

## Why

`<WhenVisible>` used to do two jobs: (1) check request state to decide "render content or fallback"; (2) install an IntersectionObserver that fires a targeted refetch. Job #1 duplicated the decision `<Partial>` already makes with `state.explicitIds`. Collapsing it into `<Partial>` gives us:

- **One pipe for every client-side state source.** Add an activator, don't re-teach the framework.
- **`defer={true}` as an escape hatch** for activation that isn't structural — cookie banner, websocket, cross-page signal — so the Partial doesn't need to contain its own trigger.
- **Uniform contract** for activators: `{ partialId, children }` both injected.

Previously rejected in `/archive/PARTIAL_WRAPPER_DESIGN.md` §11 on the argument "app logic doesn't fit in a config DSL". That argument still holds for an enum/object DSL (`defer={{on: "visible", debounce: 300}}`). It doesn't hold against `defer={<ActivatorElement/>}`: the activator IS app code, just reshaped into a component slot.

## Shape

```tsx
<Partial
  id="feed"
  fallback={<Skel />}
  defer={<WhenVisible rootMargin="200px" />}
>
  <Feed />
</Partial>
```

Three modes for `defer`:

| Value           | Semantics                                                                                                             |
| --------------- | --------------------------------------------------------------------------------------------------------------------- |
| unset / `false` | Eager render (existing behavior).                                                                                     |
| `true`          | Emit fallback; no automatic trigger. App calls `useNavigation().reload({ids: [id]})` from anywhere.                   |
| `ReactElement`  | Framework clones with `{partialId, children: fallback}`. Activator renders fallback + installs trigger.               |

Composition across activators is not a framework primitive. If an author wants "fire when visible OR when a key appears in storage," they write a single activator that subscribes to both sources and calls `fire()` from the first one to arrive.

## Activator contract

```ts
interface ActivatorProps {
  partialId?: string; // INJECTED — required at runtime; optional at type level
  children?: ReactNode; // INJECTED — the fallback
}
```

Public author types mark both as optional (the author doesn't set them), but an activator throws if `partialId` is missing at runtime. Custom props the author adds (`rootMargin`, `threshold`, `storageKey`) are preserved by the framework's `cloneElement`.

## `useActivate` — the primitive

Every activator is one `useActivate` call:

```ts
useActivate(partialId, (fire) => {
  const obs = new IntersectionObserver(
    (e) => e.some((x) => x.isIntersecting) && fire(),
    { rootMargin, threshold },
  );
  obs.observe(node);
  return () => obs.disconnect();
});
```

`fire()` dispatches `useNavigation().reload({ ids: [partialId] })` — a targeted refetch, microtask-batched with any other in-tick reloads. Default is one-shot (subsequent `fire` calls are no-ops). Opt into repeat-firing with `{once: false}` — useful for Partials that can become dormant again (§ Re-defer on stale below).

`subscribe` is captured via ref, so the latest closure is used when the subscription fires. The effect doesn't re-run when `subscribe` changes — if re-subscription on prop change is needed, remount the activator by setting `key`.

## State source interaction

Activators split on what the server can / cannot read:

- **Server-readable** (URL, cookie, header): don't use `defer`. The Partial's content reads `getSearchParam` / `getCookie` / `getHeader` / `getPathname` and branches directly.
- **Client-only** (visibility, idle, storage, matchMedia, events): use `defer` + an activator that listens and fires a targeted reload.

**Activators that need to pass state to the server write it to a URL before firing.** The server then reads it through tracked accessors on re-render. Two shapes:

- Page URL: `history.replaceState(history.state, "", urlWithParam)` then `fire()`. Partial body reads `getSearchParam("...")`.
- Frame URL: `frame("name").navigate(urlWithParam)` without a separate `fire` — the frame-navigate call is itself the refetch.

`<WhenStored>` uses the first pattern: reads `localStorage[key]`, writes `?<as>=<value>` to the page URL via `history.replaceState`, then fires. See `src/app/components/when-stored.tsx` for the implementation. A hypothetical `<WhenMediaQuery>` would do the same with a query param.

There is no longer a `__inputs` / prop-override channel — state either lives in a URL (page or frame), in a cookie, in a header, or in client-only React state. See `NAVIGATE_UNIFIED.md` for the rationale.

## Fallback semantics

`<Partial fallback>` has two simultaneous jobs:

- **Suspense fallback** while async children resolve (existing).
- **Dormant display** when `defer` is active.

One prop, two activation reasons. The Partial body picks the path based on `defer`.

## What ships

- `<Partial defer>` prop (`partial-component.tsx`).
- `useActivate` hook (`partial-client.tsx`) — the primitive every activator is built on.

Activators are userspace. The demo app provides two reference
implementations in `src/app/components/`:

- `<WhenVisible>` — IntersectionObserver activator using React 19 Fragment refs.
- `<WhenStored storageKey as>` — `localStorage`/`sessionStorage` activator; writes the stored value to `?<as>=<value>` on the page URL before firing.

New activators (`<WhenIdle>`, `<WhenMediaQuery>`, `<WhenEvent>`) are ~20–30 lines each against the `useActivate(partialId, subscribe)` contract. There is no "framework activator" registry — the framework only owns the `defer` prop + `useActivate` primitive.

## What doesn't ship

- **Dev-mode warning** for stranded `defer={true}` Partials. Planned for the general partial debugging toolkit, not for this slice.
- **A composition primitive.** `defer` takes one element. Authors who need "any of these should fire" write a bespoke activator. This was tried as a framework-level array/fragment `DeferSpec` in 2026-04-19 and removed the same day — the single-element shape is the lowest surface that works.

## Known sharp edges

1. **`defer={true}` can strand a Partial.** If the app forgets to wire a refetch, the Partial is dormant forever. No framework defense today; future dev warning will catch it.
2. **`cloneElement` injects props the author didn't write.** `partialId` and `children` appear from the framework. Typed: `ActivatorProps` documents the contract.
3. **Re-defer on stale not supported in v1.** Once activated, a Partial stays live for the session. If a Partial should go dormant again (unload after scrolling off-screen, expire after N seconds), the activator would need the equivalent of a reverse-refetch — there's no primitive today. `{once: false}` on `useActivate` is the first piece of that story.
4. **`<Cache>` around a deferred Partial is fine** — when dormant, content doesn't run, so Cache never fires. First activation is a cold miss; Cache populates on first real render.
5. **No framework-level composition.** Only one activator per `defer`. Custom composite activators are always possible in userspace.
