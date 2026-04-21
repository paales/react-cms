# usePartial, __inputs, usePartialParams, silentReplace — historical reference

**Archived:** 2026-04-21
**Replaced by:** `notes/NAVIGATE_UNIFIED.md` (and the `useNavigation()` API documented in `CLAUDE.md`).

This doc captures the three client APIs that drove client→server state between 2026-04-16 and 2026-04-21. All four are removed from the codebase. Keep this as context when reading older PRs, diffs, or lessons docs that mention them.

---

## What was there

### `usePartial(selector: string)`

Hook returning `[refetch, isPending]`. Lived in `src/lib/partial-client.tsx`.

```ts
const [refetch, isPending] = usePartial("cart");
const [refetch] = usePartial("#cart");           // same
const [refetch] = usePartial(".price");          // all Partials tagged "price"
const [refetch] = usePartial(".price.featured"); // intersection: both tags required

refetch();                                    // targeted refetch, no props
refetch({ query: "pika" });                   // refetch with prop overrides (see __inputs)
refetch(props, { disableTransition: true });  // per-chunk streaming commit
```

Selectors parsed via `parseSelector`, resolved against a client-side tag index `_partialTags` (populated by `PartialErrorBoundary` on render). A selector resolving to N ids fanned out into one microtask-batched RSC request.

### `__inputs` — prop overrides on refetch

`refetch(props)` serialized `props` as JSON into `?__inputs={id: {prop: value}}` on the refetch URL. Server-side, `PartialRoot` parsed it into `PartialRequestState.partialInputs`. The `<Partial>` body applied overrides via `cloneElement` on its content:

```ts
const override = state.partialInputs[id];
const rawContent = override ? applyInputs(children, override) : children;
```

The fingerprint was computed **after** `applyInputs`, so a refetch whose inputs changed a scalar prop produced a distinct fp (and a distinct `<Cache>` key). This made cache-mode refetches correct even when they returned from a stale snapshot — the content element was freshened by `cloneElement` before the fp was hashed.

### `usePartialParams()`

Hook for writing transient search params onto the NEXT refetch URL without mutating `window.location`.

```ts
const setParams = usePartialParams();
setParams({ q: "pika" });  // ?q=pika rides on the next refetch URL; browser URL unchanged
const [refetch] = usePartial("search");
refetch();  // URL: /?q=pika&partials=search
```

Stored in a module-level `_transientParams`, consumed + cleared by the next `flush` in `PartialsClient`.

### `silentReplace(url)`

Lived in `src/framework/silent-replace.ts`. Wrote the URL via `history.replaceState` and set a time-windowed flag (`_silentUntil`) that the page-level navigate intercept in `entry.browser.tsx` read via `consumeSilentFlag()` and bailed out on. The same flag mechanism powered frame navigation's silent push.

## Why it was removed

Three smaller issues added up to one architectural one:

1. **`__inputs` is a hidden state channel.** Prop overrides that don't live in any URL break bookmarkability, don't survive a server-side render, and require the `fingerprint-after-applyInputs` gymnastics to keep Cache keys honest. On a cold load the server has no inputs to apply, so the author has to separately wire the initial-render state too.

2. **Three URL-writing paths.** `history.pushState` direct (frame navigate internally, cache-demo's flavor toggle, WhenStored's value write), `silentReplace` (infinite scroll's `?pages=`, URL-mode search's `?q=`), and `useNavigation().navigate` (page-level and frame navigation). Each with its own interaction with the Navigation API intercept.

3. **Selector grammar is client-only machinery.** `_partialTags` client index + `parseSelector` + `resolveSelector` existed for refetch dispatch. Server-side tag resolution (`resolveTagsToIds` in `partial.tsx`) was the authoritative path anyway. The client index was a performance-hostile duplicate — it missed dynamically-registered partials that hadn't mounted yet on the client.

4. **Architectural:** state is either reflected in _some_ URL (page URL for shareable state, frame URL for subtree-scoped state) or it's transient UI state that belongs in React state / refs. The `__inputs` escape hatch let authors route state through neither, which turned into a maintenance tax every time we revisited the cache / fingerprint / scope rules.

## What replaced each piece

| Old | New |
|---|---|
| `usePartial(id).refetch()` | `useNavigation().reload({ ids: [id] })` |
| `usePartial(".tag").refetch()` | `useNavigation().reload({ tags: ["tag"] })` |
| `usePartial(".a.b").refetch()` (intersection) | Union only (`{tags: ["a","b"]}` matches either). For intersection: give the intersection its own tag, or list explicit ids. |
| `refetch({ key: value })` (`__inputs`) | Put the state in a URL: `nav.navigate(newUrl, { tags: [...] })`. The server reads it through tracked accessors. |
| `usePartialParams()` + transient refetch | No longer needed; write state to a URL (page or frame) before navigating. Frame URLs are session-backed and don't pollute the window. |
| `silentReplace(url)` | `useNavigation().navigate(url, { history: "replace", silent: true })` |
| `silentReplace(url); dispatchStage1(); dispatchStage2();` | `useNavigation().navigate(url, { history: "replace", ids: ["stage-1", "stage-2"] })` (single call, URL + targeted refetch) |
| `useActivate(id, (fire) => { fire({ key: value }); })` | `useActivate(id, (fire) => { history.replaceState(…?key=value); fire(); })`. See `src/app/components/when-stored.tsx`. |

## The migration

Shipped 2026-04-21. Deleted:

- `usePartial`, `usePartialParams`, `parseSelector`, `resolveSelector`, `ParsedSelector`, `_partialTags`, `_transientParams`, `PartialRefetchContext`, `PartialRefetchOptions` (all from `src/lib/partial-client.tsx`).
- `__inputs` parsing in `partial.tsx`, `applyInputs` in `partial-component.tsx`, `partialInputs` field in `PartialRequestState`.
- `src/framework/silent-replace.ts` (moved in-module as private helpers of `partial-client.tsx`).
- The `partialTags` prop on `PartialErrorBoundary`.

Added:

- `ids`, `tags`, `silent` on `NavigateOptions`.
- Module-level microtask-batched refetch dispatcher (`enqueueRefetch` + `flushRefetchBatch`).
- Ambient frame URL folded into every Partial's fingerprint, so stages inside a frame subtree get URL-correct fingerprint-skip decisions.

## Why keep this doc

The removed surface is referenced by commits, PR descriptions, earlier lessons docs (`LESSONS_2026-04-19.md` §1 talks about fingerprint-after-applyInputs), and probably a few test names in the history. When reading those, resolve the names here rather than re-deriving them from git.
