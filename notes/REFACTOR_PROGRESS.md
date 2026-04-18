# Refactor progress log — unified Partial runtime path

**Session:** 2026-04-18
**Goal:** "The full monty" — collapse the two Partial discovery paths
(static walker + runtime registry) into a single runtime path. Move
fingerprint compute, `__inputs` override, skip decisions, duplicate-id
detection into the `Partial` component itself. Delete
`collectPartials`, `transformForStreaming`, `stripNested`. Make
`PartialRoot` a thin orchestrator.

**Status:** ~85% done. Code shape is in. 54/56 unit tests pass. Most
playwright tests pass (20/23). Three real bugs left, plus some clean-up.

---

## What landed

### New files

- **`src/lib/partial-request-state.ts`** — `AsyncLocalStorage`-backed
  request state. Holds parsed `?partials=`, `?tags=`, `?cached=`,
  `__inputs`, the `seenIds` set for duplicate detection, etc. Uses
  `als.enterWith(state)` (not `als.run`) because React's RSC render
  of the returned JSX happens in the caller's async continuation — we
  need the store to persist past `PartialRoot`'s return. Exported
  `requirePartialState()` throws a clear error if used outside
  `<PartialRoot>`.

### Files rewritten

- **`src/lib/partial-component.tsx`**. `Partial` now:
  1. Reads request state via `requirePartialState()`.
  2. Throws on duplicate ids (using `seenIds`).
  3. Computes its own structural fingerprint.
  4. Registers with the route registry (via `<PartialBoundary>`).
  5. Applies `__inputs` override.
  6. Decides render vs placeholder (cache mode filter, fingerprint
     match on nav).
  7. Wraps the output in `<Suspense>` only when a `fallback` was
     provided — without a fallback, the outer wrapper is
     `<PartialErrorBoundary key={id}>`. (Reason documented below
     under "Real bug #1 fix".)

- **`src/lib/partial.tsx`**. `PartialRoot` is now ~100 lines. It:
  - Parses request params.
  - Seeds the registry from the static JSX tree (`seedRegistry`).
    This is the ONLY remaining "walk the input JSX" call — purely
    to bootstrap so a first-request cache-mode refetch can resolve
    ids without a full-render warmup.
  - Resolves tag filters via the registry (no separate tag index).
  - Registry-miss falls back to a full streaming render.
  - Streaming mode: `enterPartialState(streamState)` and return
    `<PartialsClient>{children}</PartialsClient>`.
  - Cache mode: render each requested id from its registry snapshot
    as `<Partial ...>{snap.content}</Partial>` — each Partial body
    re-runs its logic.

  Deletions: `collectPartials`, `transformForStreaming`, `stripNested`,
  the `registrySupplement` scaffolding, the `fingerprints` / `freshIds`
  props on `<PartialsClient>`, the version-stamping machinery (was
  already gone from previous commit).

- **`src/lib/partial-error-boundary.tsx`**. Now takes an optional
  `partialFingerprint` prop. During `render()` (client side) it calls
  `registerClientPartial(id, fingerprint)` into the shared
  `_fingerprints` map. This replaces the old "server passes
  fingerprints to PartialsClient as a prop" plumbing.

- **`src/lib/partial-client.tsx`**. Dropped the `freshIds` and
  `fingerprints` props. `cacheFromStreamingChildren` now walks for
  "partial wrapper" elements using a new `isPartialWrapper()` helper
  — a keyed `<Suspense>` or any keyed element with a `partialId`
  prop. `substituteNested` uses the same helper to identify
  substitutable subtrees.

- **`src/lib/__tests__/partial.test.tsx`**. Extensive rewrite to
  remove the 25+ `vi.mocked(...).PartialsClient = (...)` capture
  patterns — replaced with a single module-level `renderCapture`
  object the mocked `PartialErrorBoundary` populates during render.
  Resets at the start of each mocked-`<PartialsClient>` render so
  tests see only the current render's output. Also flipped the
  Walker-discovery-limits tests from "does NOT discover" to
  "DOES discover" to match the new behavior.

---

## What's broken

### Playwright failures (3)

```
e2e/bare-infinite-scroll.spec.ts:44  infinite scroll loads page-2 then page-3
e2e/bare-infinite-scroll.spec.ts:100 back navigation restores ?end and renders full range
e2e/cache-demo.spec.ts:77            clock partial stays fresh on every request
```

The first two I haven't investigated yet.

The third has a subtle diagnostic twist: the test uses a regex
`/Server time: ([^<]+)</` against the full HTML response. The captured
value on BOTH requests is a very long string of Clock component
*source code* (escaped). That means the FIRST occurrence of
"Server time: " in the HTML is inside the Flight-data script payload,
not inside the rendered Clock DIV.

Normally rendered body content comes before the Flight scripts, so the
first match would be the rendered content. Something in my refactor
has the SSR body missing or reordering. I saw earlier that the magento
body was almost empty (just `<main>` with the refresh button + footer
+ debug toolbar) until I fixed `isPartialWrapper`.

**After the `isPartialWrapper` fix** (keyed Suspense OR keyed element
with a `partialId` prop), magento HTML renders fully again and 4/5
failing tests recovered. But `cache-demo` and `bare-infinite-scroll`
still fail. I suspect the clock test is hitting a related shape where
SSR isn't rendering the Clock Partial's output into the HTML at the
expected position.

### Two unit tests still failing in full-suite runs

```
Cart invalidation: header must not re-render > __populateCache renders all partials (first action), subsequent only renders cart
Dynamic Partial discovery via route-scoped registry > dynamic partial is registered when it renders and can be refetched
```

Both cases: do a populateCache / full render FIRST, then a cache-mode
refetch. Second render's `renderCapture.freshIds` is expected to be
`["cart"]` / `["price-B"]`, but shows all ids. Passes when run alone.

The mocked `PartialsClient` clears `renderCapture` at the start of
every render, so cumulation shouldn't be the cause. My hypothesis:
the mocked `PartialsClient`'s reset-and-capture pattern doesn't fire
for these second-render scenarios because... actually I don't fully
understand yet. These *did* fail in suite runs before my last changes
and the cross-test ordering might still be influencing state.

---

## Real bugs found + fixed along the way

### Bug #1 — Unconditional Suspense wrap hid nested Partial substitutions

**Symptom:** magento price refresh button was confirmed to fire the
RSC request and the server WAS sending fresh content (curl showed
different tick + different fluctuated price). DOM stayed stale. Full
body was missing on /magento.

**Root cause:** I had changed Partial to always wrap its output in
`<Suspense key={id}>`, even when no fallback was provided. The
client's `substituteNested` walker has a "don't descend into
Suspense" rule (Flight lazy refs inside). When `cache["products"]`
was a `<Suspense>` containing nested `<Suspense key="price-abc">`
subtrees, substituteNested returned products as-is and never swapped
in the fresh `cache["price-abc"]`.

**Fix:** only wrap in Suspense when a fallback is provided. Without,
outer is `<PartialErrorBoundary key={id}>`. `substituteNested` can
walk into that and substitute nested keyed partials. Matches the
pre-refactor shape that worked.

### Bug #2 — `isPartialWrapper` type-identity check broke in SSR

**Symptom:** after Bug #1 fix, magento HTML body was empty again (only
refresh-all-prices button).

**Root cause:** `isPartialWrapper` used
`node.type === PartialErrorBoundary` (identity check). In the SSR
environment, the imported `PartialErrorBoundary` class from
`partial-error-boundary.tsx` didn't always `===` the `type` on
client-component elements coming from the Flight-decode path — the
RSC → SSR module graph boundary produced different references.

**Fix:** detect via the `partialId` prop, which `<Partial>` always
sets on its wrapper. `isPartialWrapper(node)` now returns true for:
(a) keyed Suspense, or (b) any keyed element whose props include a
string `partialId`. Prop-based identification survives the module-ref
boundary. Full body now renders correctly.

### Bug #3 — ALS scope didn't survive `als.run(state, () => <JSX/>)`

**Symptom:** every unit test threw "must be rendered inside
<PartialRoot>" when `Partial` tried to `requirePartialState()`.

**Root cause:** `als.run(state, fn)` scopes the store only for
synchronous code inside `fn` plus awaits chained off it. React's
rendering of the JSX `fn` returns happens in the caller's
continuation, outside that scope.

**Fix:** switched to `als.enterWith(state)` which sets the store on
the current async context itself. React's render inherits via normal
async propagation.

### Bug #4 — Custom mock overrides in tests broke the stable-mock pattern

**Symptom:** a few test assertions (`freshIds` from
`PartialsClient` props) returned `undefined` in later tests, even
though earlier tests that set the same assertion worked.

**Root cause:** vitest doesn't auto-reset `vi.mocked(...)` module
replacements across tests. Earlier tests with custom
`PartialsClient = (...)` replacements had clobbered the mock's
`renderCapture` reset logic, breaking the snapshot mechanism for
subsequent tests.

**Fix:** removed all 25 `vi.mocked(...).PartialsClient = ...`
overrides. The stable mocked `PartialsClient` captures top-level
props (`mode`, `template`, `children`) and resets `renderCapture` at
each call. Tests now read from `renderCapture` directly.

---

## What still needs doing

1. **Fix the cache-demo clock test.** Investigate why "Server time: "
   isn't in the expected place in HTML. Likely related to either
   the `<Partial id="clock" fallback={...}>` flow (it has a fallback,
   so wraps in Suspense) or the SSR timing of its resolution.

2. **Fix the bare-infinite-scroll tests.** Haven't looked at these
   yet. They likely hit related nav / partial plumbing.

3. **Investigate the cross-test order dependency in the two unit
   test failures.** Both involve a full-render-then-cache-refetch
   pattern; the cache-refetch's freshIds should be filtered to only
   the requested id but shows all. Either the `renderCapture` reset
   isn't firing for the second render, or `Partial` isn't skipping
   properly in cache mode.

4. **Run the full playwright + vitest suites to green.**

5. **Write a `LESSONS_FROM_REFACTOR.md`** capturing the key
   architectural decisions:
   - Why `als.enterWith` instead of `als.run`.
   - Why Partial conditionally wraps in Suspense (vs. always).
   - Why `isPartialWrapper` uses prop-based identification.
   - The test-mock reset pattern (stable mock + `renderCapture`).
   - The double-render issue in the earlier naïve cache-mode
     implementation (template triggers full server-render; used to
     double-render nested Partials when both parent and child
     requested).

6. **Clean up leftover references** — comments mentioning the
   deleted `transformForStreaming` / `collectPartials`, stale
   imports, etc.

7. **Commit in meaningful chunks** once green. Probably:
   - (a) The new unified-path refactor itself.
   - (b) Test updates.
   - (c) Notes.

---

## Files touched (uncommitted)

```
 M notes/IDEAS.md                           (unrelated format nudge)
 M src/lib/__tests__/partial.test.tsx       (major rewrite of 25+ tests)
 M src/lib/partial-client.tsx                (drop freshIds/fingerprints props, isPartialWrapper)
 M src/lib/partial-component.tsx            (self-managing Partial with skip logic)
 M src/lib/partial-error-boundary.tsx       (take partialFingerprint, register client-side)
 M src/lib/partial.tsx                      (thin PartialRoot + seedRegistry)
?? src/lib/partial-request-state.ts         (NEW — ALS state)
?? user-ideas.md                            (user notes, leave alone)
```

All 23 playwright tests + 161 vitest tests were green before starting.
Currently 20/23 + 54/56 unit tests pass.

---

## Open architectural questions

1. **Should we keep `seedRegistry` or drop it?** It's ~30 lines of
   JSX walking that only runs once per request. It enables
   first-request cache-mode refetches and fast cold-start tag
   resolution. Trade-off: 30 lines of "two paths" smell vs. the UX
   win of not needing a warmup render. Probably keep.

2. **Can we eliminate `template` entirely?** Today template is
   `buildTemplate(children)` — a tree with placeholders for static
   Partials. On cache-mode refetch, client uses template to render
   structure + fill placeholders from cache. If we sent just the
   requested partials and trusted the client's last-known template,
   we could drop serializing the template prop on every refetch.
   This would also sidestep the "template render duplicates child
   Partials' render" performance gotcha. Worth exploring after this
   round stabilizes.

3. **The `cacheFromStreamingChildren` "don't descend into Suspense"
   rule** is still load-bearing. Any walker that needs to see INSIDE
   a cached Suspense's children (like substituting nested partials
   inside a cache hit) has to wait for the Suspense's lazy refs to
   resolve — which they have by refetch time, but forcing resolution
   via walk on server side is unsound. The fix for Bug #1 sidestepped
   this (outer partial wrapper is not a Suspense unless necessary).
   Still worth thinking about as a design principle.
