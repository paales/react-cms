# `defer` + activators — design notes

**Added:** 2026-04-18
**Files:** `src/lib/partial-component.tsx`, `src/lib/partial-client.tsx`, `src/lib/when-visible.tsx`, `src/lib/when-stored.tsx`, `src/lib/any-of.tsx`

---

## Why

`<WhenVisible>` used to do two jobs: (1) check request state to decide "render content or fallback"; (2) install an IntersectionObserver that fires `usePartial(id).refetch()`. Job #1 duplicated the decision `<Partial>` already makes with `state.explicitIds`. Collapsing it into `<Partial>` gives us:

- **One pipe for every client-side state source.** Add an activator, don't re-teach the framework.
- **`defer={true}` as an escape hatch** for activation that isn't structural — cookie banner, websocket, cross-page signal — so the Partial doesn't need to contain its own trigger.
- **Uniform contract** for activators: `{ partialId, children }` both injected.

Previously rejected in `archive/PARTIAL_WRAPPER_DESIGN.md` §11 on the argument "app logic doesn't fit in a config DSL". That argument still holds for an enum/object DSL (`defer={{on: "visible", debounce: 300}}`). It doesn't hold against `defer={<ActivatorElement/>}`: the activator IS app code, just reshaped into a component slot.

## Shape

```tsx
<Partial id="feed" fallback={<Skel/>} defer={<WhenVisible rootMargin="200px"/>}>
  <Feed/>
</Partial>
```

Three modes for `defer`:

| Value | Semantics |
|---|---|
| unset / `false` | Eager render (existing behavior). |
| `true` | Emit fallback; no automatic trigger. App calls `usePartial(id).refetch()` from anywhere. |
| `ReactElement` | Framework clones with `{partialId, children: fallback}`. Activator renders fallback + installs trigger. |

## Activator contract

```ts
interface ActivatorProps {
  partialId?: string;   // INJECTED — required at runtime; optional at type level
  children?: ReactNode; // INJECTED — the fallback
}
```

Public author types mark both as optional (the author doesn't set them), but an activator throws if `partialId` is missing at runtime. Custom props the author adds (`rootMargin`, `threshold`, `storageKey`) are preserved by the framework's `cloneElement`.

## `useActivate` — the primitive

Every activator is one `useActivate` call:

```ts
useActivate(partialId, (fire) => {
  const obs = new IntersectionObserver(
    (e) => e.some(x => x.isIntersecting) && fire(),
    { rootMargin, threshold },
  );
  obs.observe(node);
  return () => obs.disconnect();
});
```

`fire(inputs?)` calls `usePartial(partialId).refetch(inputs)`. Inputs land in `__inputs` and apply as prop overrides via `cloneElement` on the Partial's content. Default is one-shot (subsequent `fire` calls are no-ops). Opt into repeat-firing with `{once: false}` — useful for Partials that can become dormant again (§ Re-defer on stale below).

`subscribe` is captured via ref, so the latest closure is used when the subscription fires. The effect doesn't re-run when `subscribe` changes — if re-subscription on prop change is needed, remount the activator by setting `key`.

## State source interaction

Activators split on what the server can / cannot read:

- **Server-readable** (URL, cookie, header): don't use `defer`. The Partial's content reads `getRequest()` and branches directly.
- **Client-only** (visibility, idle, storage, matchMedia, events): use `defer` + an activator that listens and fires refetch.

For activators that need to pass state to the server, two channels:

- `refetch({ key: value })` → `__inputs` → applied as prop override on the Partial's content's root child.
- `setTransientParams({ key: value })` then `refetch()` → ends up in the fetch URL → content reads via `getRequest()`.

`<WhenStored>` uses the first. Something like `<WhenMediaQuery>` would typically use the second (param-based feature gating on the server).

## Fallback semantics

`<Partial fallback>` has two simultaneous jobs:

- **Suspense fallback** while async children resolve (existing).
- **Dormant display** when `defer` is active.

One prop, two activation reasons. The Partial body picks the path based on `defer`.

## What ships

- `<Partial defer>` prop (`partial-component.tsx`).
- `useActivate` hook (`partial-client.tsx`).
- `<WhenVisible>` — IntersectionObserver activator (~70 lines, was ~130 across two files).
- `<WhenStored storageKey as>` — localStorage/sessionStorage activator; passes the stored value through `__inputs`.
- `<AnyOf activators={...}>` — first-to-fire composition. First activator in the list gets the fallback as children (and therefore the DOM range for observer-style activators); others get `null`.

## What doesn't ship

- **Dev-mode warning** for stranded `defer={true}` Partials. Planned for the general partial debugging toolkit, not for this slice.
- **Other activators** (`<WhenIdle>`, `<WhenMediaQuery>`, `<WhenEvent>`): 20–30 lines each whenever they're needed. The `useActivate` contract makes them uniform.

## Known sharp edges

1. **`defer={true}` can strand a Partial.** If the app forgets to wire a refetch, the Partial is dormant forever. No framework defense today; future dev warning will catch it.
2. **`cloneElement` injects props the author didn't write.** `partialId` and `children` appear from the framework. Typed: `ActivatorProps` documents the contract.
3. **Re-defer on stale not supported in v1.** Once activated, a Partial stays live for the session. If a Partial should go dormant again (unload after scrolling off-screen, expire after N seconds), the activator would need the equivalent of a reverse-refetch — there's no primitive today. `{once: false}` on `useActivate` is the first piece of that story.
4. **`<Cache>` around a deferred Partial is fine** — when dormant, content doesn't run, so Cache never fires. First activation is a cold miss; Cache populates on first real render.
5. **`<AnyOf>` only lets the first activator be DOM-observing.** Subsequent activators receive `null` children (no DOM range to observe). Window-level activators (storage, idle, events) compose freely.
6. **Partials must be direct JSX descendants of `<PartialRoot>`.** A Partial hidden inside an intermediate opaque server component (e.g. `<Partial id="nav"><AppNav/></Partial>` where `AppNav` contains its own `<Partial>`) executes twice — once via `buildTemplate`'s template tree, once via `children` — and throws `Duplicate partial id`. Pattern: keep `<Partial>` declarations visible at the top of the JSX tree; wrap shared JSX (like a nav bar) OUTSIDE in a `<Partial id="…">`. This is a framework invariant, not specific to defer, but defer demos surfaced it. Fix is to either (a) use shared renderless components that are wrapped by `<Partial>` at the callsite, or (b) inline the layout. See `src/app/components/app-nav.tsx` and `src/app/pages/defer-demo.tsx` for the pattern.
