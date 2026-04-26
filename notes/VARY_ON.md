# `<Partial varyOn>` — declarative URL/cookie/header dependencies

**Added 2026-04-26.** Closes the regression where a same-route nav (e.g.
clicking the `slug=alpha` configuration tab in `/cms-edit`) flipped the
URL but the field panel stayed on the previous config until a hard
refresh.

## TL;DR

A Partial whose body reads request state — URL params, cookies,
headers, pathname patterns — must declare what it reads so the
structural fingerprint can change when those values change. Otherwise
the fp-skip handshake serves stale bytes.

```tsx
<Partial
  parent={ROOT}
  selector="#cms-edit-fields"
  varyOn={["url:select", "url:config"]}
>
  <FieldPanel />
</Partial>
```

`varyOn` accepts the same accessor-spec syntax tracked accessors use:

| Spec                     | Resolves to                                    |
| ------------------------ | ---------------------------------------------- |
| `"url:<name>"`           | `searchParams.get(name)`                       |
| `"cookie:<name>"`        | `getCookie(name)`                              |
| `"header:<name>"`        | `headers.get(name)` (lowercased internally)    |
| `"pathname:/p/:slug"`    | `matchRoutePattern(pathname, pattern)` → JSON  |

Resolved against:

1. The Partial's own frame request, if it declares `frame=…`.
2. Otherwise the closest ambient frame's request (looked up DIRECTLY
   from session via the explicitly-threaded `parent.frameChain` —
   bypasses the leaky per-request `frameScopeCell`, so the resolution
   is correct under sibling-interleaved renders too).
3. Otherwise the page request from the ALS `getRequest()`.

Folded into BOTH `structuralFp` (so a `<Cache>` baseKey differentiates
per-vary value — separate cache slots) and the full `fp` (so the
fp-skip handshake refuses to skip when the declared input changed).

## The bug it fixes

`/cms-edit?select=cms-demo-greeting`'s field panel reads the active
config from `?select=` and `?config=` via `getRequest()` — not
`getSearchParam`, deliberately, to dodge the preview frame's
scope-cell leak (see the comment at the top of `TreeContents` in
`cms-edit.tsx`). `getRequest()` doesn't contribute to the structural
fingerprint, so a plain-anchor click on a config tab:

1. Flipped the URL to `?select=cms-demo-greeting&config=0`.
2. Triggered a full streaming render server-side.
3. `cms-edit-root`'s structural fp was unchanged — fp-match → server
   emitted a placeholder.
4. Client used its cached `cms-edit-root` wrapper, which contained the
   cached `cms-edit-fields` wrapper. No descent into `cms-edit-fields`.
5. The field panel stayed on the previous config's values; the URL
   bar showed the new params; refresh recovered.

`varyOn` makes the dependency explicit and folds it into the
fingerprint, so the URL change differentiates the fp.

## Why the ancestor fold is necessary

`cms-edit-root` declares no `varyOn` of its own. If only descendant
fps captured the URL change, `cms-edit-root` would still fp-match its
cached fp, emit a placeholder, and the client would never receive the
fresh `cms-edit-fields` wrapper — the bug would persist.

So the Partial body's fingerprint pass also folds in **descendant**
varyOn contributions:

1. **Static JSX walk** of the Partial's `rawContent` finds every
   `<Partial>` element directly visible in the children JSX (no
   opaque function component in between). Resolves each declared
   `varyOn` against the descendant's own effective request and folds
   the values.
2. **Previous-render registry walk** finds Partials whose
   `parentPath` includes this Partial's id — catches dynamic
   Partials (`.map()`-generated, function-component-wrapped) when
   the author threaded `parent={capturePartialContext()}`.

Contributions are deduped by descendant effective id. Empty key
when no descendant declares `varyOn`.

The over-folding bias: a stale snapshot in the previous-render
registry (Partial that no longer exists in the current tree) still
contributes its `varyOn` to ancestor fps. Result: ancestor fps differ
more often than strictly necessary — extra re-renders, never stale
subtrees. Acceptable trade.

## Limitation: opaque function components

Static walk stops at non-Partial function components. So
`<TreePanel>` containing `<Partial selector="#cms-edit-tree" varyOn=…>`
is invisible until `TreePanel` first renders and `cms-edit-tree`
registers a snapshot. After the first render, the registry walk
catches it — **but only if** `cms-edit-tree` was created with
`parent={capturePartialContext()}` (so `parentPath` includes the
ancestor id). With `parent={ROOT}` the registry can't link it back.

For these cases:
- Add `varyOn` to the wrapping ancestor (the safety-net pattern in
  `cms-edit.tsx` — `cms-edit-tree` carries `varyOn={["url:select"]}`
  AND the page-root could carry the union if needed).
- Or thread `parent={capturePartialContext()}` so the registry can
  track the relationship.

## On auto-tracking (the open question)

> "Can `varyOn` be auto-tracked from `getSearchParam` / `getPathname`
> / `getCookie`?"

**Short answer:** not without sacrificing progressive streaming for
non-cached Partials. Here's the wall.

The framework already has a tracked-accessor infrastructure: a
per-Partial **manifest scope** (`runWithCacheManifest` / `ManifestScope`
in `framework/context.ts`) that auto-collects `(kind, name)` tuples
when the body or its descendants call `getSearchParam` /
`getCookie` / `getHeader` / `getPathname`. This manifest is what
`<Cache>` keys cached bytes against. So in theory, folding the same
manifest into the Partial's structural fingerprint would give us
auto-tracked `varyOn` for free.

The catch is **scope propagation across React's render walk**.
`<Cache>` works because it does a **Flight render** of its children:

```ts
return runWithCacheManifest(scope, async () =>
  cacheImpl(id, fingerprint, options, children, scope, frameRequest),
);
// inside cacheImpl:
const stream = renderToReadableStream(stripped); // ← children render
const bytes = await readAll(stream);              //   inside the ALS scope
```

The Flight round-trip keeps the children's render INSIDE the
`als.run()` callback, so descendant `trackAccess` calls land in the
manifest. The cost: the whole subtree is buffered before the Cache
returns — **no progressive streaming** through a Cache boundary.

For `<Cache>`, we accept that cost (cached subtrees are a one-shot
hit-or-miss anyway). For non-cached Partials it's not acceptable —
streaming inside framed subtrees is load-bearing for slow async
content (search results, chat overlay, anywhere we want fallback +
per-row reveal).

Other options we've evaluated (see `notes/FRAME_SCOPING.md` for the
full chain — same architectural problem):

- **`AsyncLocalStorage.run` without Flight** — the callback returns
  the JSX synchronously; React renders children OUTSIDE the run.
  Descendant accessors see no scope. Spike proved it.
- **`AsyncLocalStorage.enterWith`** — propagates to the current
  async context but leaks to siblings and to anything rendered after
  a nested frame returns. Not isolatable.
- **React Context** — the RSC build of React deliberately omits
  `createContext`. Server components can't create providers.
- **`React.cache` mutation cell** — what frame scope already uses.
  Mutates a per-request singleton. Sibling-interleaved renders see
  the wrong value. Documented sharp edge with the "read before await"
  discipline as the workaround. Not fp-tracking-safe at scale because
  attributing reads to the wrong Partial would under-fingerprint
  (unsafe — fp matches when content actually differs).

So the realistic shape of "auto":

- **Inside `<Cache>`**: already auto-tracked (manifest folds into the
  cache key today). Folding it into the Partial's structural fp too
  is a small change — we'd close a related sharp edge where a
  cached Partial's URL deps don't invalidate sibling fp-skips. This
  is a worthwhile follow-up.
- **Outside `<Cache>`**: declarative `varyOn` is the contract. The
  body knows what state it reads; declaring it costs one prop;
  the framework handles resolution + ancestor fold + frame-scope
  routing automatically.
- **Hybrid (future)**: a `trackVary` opt-in prop on `<Partial>` that
  triggers a Flight round-trip on first render to harvest the
  manifest, caches it for subsequent renders. Cost: the first render
  buffers (no streaming inside the Partial); subsequent renders are
  free. Probably worth building when the developer-ergonomics gap
  starts hurting — `varyOn` as the explicit fallback covers the
  important cases today.

## How to use it

| Situation                                                          | What to do                                                    |
| ------------------------------------------------------------------ | ------------------------------------------------------------- |
| Partial reads URL/cookie state at body level via tracked accessor  | `<Partial varyOn={["url:foo", "cookie:bar"]}>`                |
| Partial reads via `getRequest()` (frame-scope-leak workaround)     | `<Partial varyOn={[…explicit list]}>`                         |
| Partial wraps `<Cache>` and reads via tracked accessors inside    | No `varyOn` needed — `<Cache>` already keys per manifest      |
| Partial whose content depends only on JSX shape (props from above) | No `varyOn` needed — structural fingerprint captures it       |
| Ancestor whose descendants might vary independently                | Static walk + registry handle it; no `varyOn` needed at the ancestor unless its descendants are hidden behind opaque components |

## Tests

- `e2e/cms-edit-config-tab.spec.ts` — the original repro (config tab
  click → form reflects new config).
- `e2e/cms-edit.spec.ts` and `e2e/cms-nav-stress.spec.ts` regression
  suites continue to pass.
