# fp-trailer + multi-fp — WIP (paused 2026-05-14)

Status: paused mid-implementation. The infrastructure is in place
and the cold→warm fp-skip mechanism works on its own; an interaction
with `magento-add-to-cart` was uncovered just before pause and is
the load-bearing thing to fix before this can land. Re-entry context
below.

---

## What this is solving

Keepalive (already landed in commit `20893b5`) preserves React state
across cross-route nav by wrapping each spec's body in `<Activity>`.
The fp-trailer extension solves the **cold→warm fp instability**
that keepalive exposed: on the first render of a route in a fresh
scope, `computeDescendantFold` returns `""` because no descendant
snapshots are registered yet, so the spec emits `fp_cold`. After
that render commits, snapshots exist and the very same spec on the
next request would compute a non-empty `descendantFold` → `fp_warm`.
With a single-fp client pool, the client sends `fp_cold` on the
next visit, the server computes `fp_warm`, mismatch → fresh
re-render. Keepalive then pays a wasted body run on the FIRST
re-visit after the cold.

The trailer ships `fp_warm` down to the client in the SAME response
so the next visit fp-skips immediately. See conversation log in
`docs/archive/` if pulled out, otherwise read this file and the
relevant module headers.

## Wire format

Two transports, both pre-existing TransformStream-flush patterns:

- **SSR (`text/html`)**: `<!--fp-trailer:JSON-->` comment appended
  after `</html>`. Lives at the document root as a `Comment` node.
  Client-side, `_applyFpTrailerFromDocument` (in `partial-client.tsx`)
  walks `document.childNodes` + `document.documentElement.childNodes`
  looking for it on hydration. `--` inside the JSON is escaped to
  `-\-` so it can't prematurely close the comment.

- **RSC (`text/x-component`)**: was a 12-byte binary sentinel
  (`\xFF\xFE` + `fp-updat` + `\xFD\xFC`) followed by a 4-byte BE
  length and JSON, appended at the response tail. The marker constant
  lives in `framework/src/lib/fp-trailer-marker.ts`. Implementation
  in `fp-trailer.ts` (`wrapStreamWithFpTrailer`) and `fp-trailer-split.ts`
  (client splitter). **Currently disabled** — RSC responses go
  through `wrapStreamWithCommitOnly` instead. See "The bug" below.

## Multi-fp wire format (required)

The trailer mechanism requires multi-fp client state. Without it,
the PEB's `registerClientPartial(id, fp_cold)` during hydration
would overwrite the trailer's `fp_warm` (or vice versa depending on
ordering), so `?cached=` carries only one fp and the server matches
only one.

Implementation:
- `_currentPageFingerprints: Map<string, Set<string>>` (was `Map<string, string>`).
- `registerClientPartial` adds to the set rather than replacing.
- `getCachedPartialIds()` flattens all `(id, fp)` pairs into the
  `?cached=` token list (e.g. `cart-badge:fp_cold,cart-badge:fp_warm`).
- Server-side `parseCachedFingerprints` returns
  `Map<string, Set<string>>` and accumulates fps per id.
- Server's `shouldSkip` check uses `cachedFps.has(fp)` rather than
  `cachedFp === fp`.

## What's in the working tree (uncommitted)

| File | Change |
|---|---|
| `framework/src/lib/fp-trailer-marker.ts` | NEW. 12-byte sentinel constant shared between server + client. |
| `framework/src/lib/fp-trailer.ts` | NEW. Server-side helpers: `wrapStreamWithFpTrailer` (binary), `wrapStreamWithCommitOnly`, `wrapSsrStreamWithFpTrailer` (HTML comment). All three commit the registry at flush. `recomputeFp` mirrors `partial.tsx`'s fp formula for use against an explicit snapshot map. |
| `framework/src/lib/fp-trailer-split.ts` | NEW. Client-side `splitAtFpTrailer` for binary trailer extraction. **Currently unused** since RSC binary trailer is disabled. |
| `framework/src/lib/partial-registry.ts` | Added `emittedFp` to `PartialSnapshot`; added `_readSnapshotsForRoute(scope, routeKey)` to read snapshots without ALS access (called from flush). |
| `framework/src/lib/partial.tsx` | Added `emittedFp` prop on `PartialBoundary` (threaded through all three call sites — shouldSkip, defer, active). Switched `parseCachedFingerprints` to `Map<id, Set<fp>>`. Switched `shouldSkip`'s fp match to `set.has(fp)`. |
| `framework/src/lib/partial-client.tsx` | `_currentPageFingerprints: Map<id, Set<fp>>`. `registerClientPartial` adds to set. `getCachedPartialIds` flattens. Added `_applyFpTrailerFromDocument` (scans for HTML comment trailer). |
| `framework/src/lib/partial-request-state.ts` | `cachedFingerprints: Map<id, Set<fp>>`. |
| `e2e-testing/src/entry.rsc.tsx` | RSC path: `wrapStreamWithCommitOnly(rscStream, _captureCommitHandle())`. SSR path: `wrapStreamWithCommitOnly` on the rscStream passed to `renderHTML`, plus `wrapSsrStreamWithFpTrailer` on the HTML output. notFound path also uses HTML trailer wrap. |
| `e2e-testing/src/entry.browser.tsx` | Initial hydration calls `_applyFpTrailerFromDocument()` between `createFromReadableStream` and `hydrateRoot`. `fetchRscPayload` and `setServerCallback` no longer use the splitter (the SSR HTML comment is the only channel currently). |
| `e2e-testing/e2e/cold-warm-fp-skip.spec.ts` | NEW. Asserts the second visit to `/magento` after a round-trip fp-skips (response < 80KB vs ~257KB cold). |
| `e2e-testing/e2e/preview/cold-warm-fp-skip.spec.ts` | NEW. Same assertion against prod preview. Passes consistently. |
| `e2e-testing/e2e/cart-badge-after-revisit.spec.ts` | NEW. The user's reported scenario: home → magento → back → forward → Add to Cart. Cart badge should update. **Currently failing** with multi-fp ON. |
| `e2e-testing/e2e/preview/cart-badge-after-revisit.spec.ts` | NEW. Same in prod. **Currently failing**. |

## The bug — multi-fp wire breaks `magento-add-to-cart`

The pre-existing `e2e/magento-add-to-cart.spec.ts` test passes on the
keepalive-only commit (`20893b5`) and **fails on the current tree**.
The failure is deterministic in isolation. Specifically:

1. `page.goto("/magento")` — cart badge renders with quantity `0`.
2. Click Add-to-Cart on a simple product (button `.nth(1)`).
3. Action POST runs, returns `{revalidate: {selector: ".cart"}}`.
4. Framework processes the directive, refetches `cart-badge` in
   cache mode.
5. Response comes back with the new cart-badge content (quantity = 1
   or more).
6. **Cart badge UI stays at `0`.** No transition to the new value.
7. Hard refresh shows the updated count — so the server-side state
   is correct, the client just isn't reconciling the new content
   into the displayed cart-badge.

Bisection done so far:
- Multi-fp OFF (`Map<id, string>`, single-fp wire): test PASSES.
- Multi-fp ON (`Map<id, Set<fp>>`): test FAILS.

Everything else identical between the two. The HTML trailer is not
involved (test fails even with the trailer wrap reverted to
commit-only).

### What I noticed but didn't conclude

The failing test log shows TWO `POST /magento_.rsc?cached=…` requests
in a row. The first carries one fp per id; the second carries TWO
fps for some ids (`app-nav`, `editor-shell`, `chat-overlay`) — which
is multi-fp behavior accumulating fps over time. The same test on
the keepalive-only commit also shows two POSTs (button #0 fails
silently with "needs options", test loops to button #1), so two
POSTs alone aren't the bug — but the multi-fp accumulation between
them might be.

Concretely: the second POST sends both `fp_cold` AND `fp_new` for
e.g. `app-nav` in `?cached=`. Server's `shouldSkip` is
`cachedFps.has(fp)`. The set contains both old AND new fps for
non-targeted partials. The server matches one of them → fp-skip →
emits placeholder. Client uses cached subtree.

For `cart-badge` specifically, it's `isExplicit` (in `?partials=`
via `?tags=cart`'s `resolveSelectorToIds`), so it bypasses
`shouldSkip` entirely. That part is fine.

But maybe the response somehow doesn't include cart-badge's fresh
content because of a multi-fp side effect on `resolveSelectorToIds`
or on the rendering path? Unclear. Worth instrumenting
`resolveSelectorToIds`, `partialFromSnapshot`, and the cache-mode
emission to confirm cart-badge's body actually runs on the action
response.

## Tests to keep + their state

- `e2e/cold-warm-fp-skip.spec.ts` — dev tier. Passes in isolation,
  flaky in suite (probably scope state).
- `e2e/preview/cold-warm-fp-skip.spec.ts` — prod tier. Consistently
  passes.
- `e2e/cart-badge-after-revisit.spec.ts` — dev tier. Fails (mirrors
  the bug).
- `e2e/preview/cart-badge-after-revisit.spec.ts` — prod tier. Fails
  the same way (qty stays unchanged).
- `e2e/magento-add-to-cart.spec.ts` — pre-existing, was passing on
  prior commit. **Currently failing** for the same reason as the
  new specs above.

## Hypotheses (ranked)

1. **`resolveSelectorToIds` interaction with multi-fp.** Maybe the
   set-based `cachedFingerprints` changes how the server resolves
   what to render on `?tags=cart`. Worth a server-side
   `console.log` in `resolveSelectorToIds` + the cart-badge spec's
   `Component` to confirm whether the spec runs at all on the
   action POST, and what its current fp is.

2. **Cache substitution races.** With multi-fp, `cacheFromStreamingChildren`
   calls `registerClientPartial(id, fp)` which now ADDS to set
   rather than replacing. If the substitution logic somewhere reads
   "the current fp" rather than "the cached element", multi-fp
   could break it. But the cache map (`_currentPagePartials`) is
   still id-keyed and overwrite-on-walk, so this is unlikely
   unless I'm missing something.

3. **Server's `shouldSkip` over-triggers for some adjacent
   partial.** If a partial OTHER than cart-badge fp-skips when it
   shouldn't (because its set contains both old + new fps), the
   cache-mode response might miss bytes the client needs to
   reconcile cart-badge. Less likely since each partial has its
   own fp lookup, but worth checking.

4. **A new request lifecycle interaction I haven't traced.** The
   `commitOnly`/`captureCommitHandle` rewiring on RSC responses
   might be subtly different from the old `wrapStreamWithRegistryCommit`
   path. Worth diffing the two.

## What to try first when re-entering

1. **Run the failing test with server-side logs.** Add console.log
   in `parseCachedFingerprints`, `resolveSelectorToIds`, and
   cart-badge's `Component`. Confirm:
   - The action POST has cart-badge in `combinedRequestedIds`.
   - cart-badge's `Component` runs, with the right `vary` (new
     cart_id).
   - The response stream actually contains the fresh cart-badge
     bytes (not a placeholder).

2. **If the response IS correct**, the bug is client-side. Add
   logging in `cacheFromStreamingChildren` and `renderTemplate` to
   confirm the cache is updated AND the substitution puts the new
   element at the right spot.

3. **If response is wrong** (placeholder where it should be fresh
   content), the bug is server-side. Most likely candidate:
   `shouldSkip` on cart-badge or one of its ancestors. Check if
   `isExplicit` is true for cart-badge in the action POST.

## What to NOT do

- Don't revert the multi-fp work — it's a real prerequisite for
  the cold→warm fix and works correctly outside this one
  regression. The single-fp shape can't carry both `fp_cold` (from
  PEB hydration) and `fp_warm` (from the trailer) on the same id,
  so reverting puts us back to the cold→warm symptom the user
  observed in the first place.
- Don't ship the binary RSC trailer yet — disabling it was a
  reasonable expedient and the SSR HTML comment already covers the
  most-common entry point (cold page load). Binary RSC trailer
  can come back once the multi-fp interaction is understood, OR
  the design can stay HTML-only.
- Don't move forward without a green `magento-add-to-cart.spec.ts`
  — that's a pre-existing pinned regression and the cleanest signal
  that something is wrong with the action-response handling.

## Follow-ups already noted in IDEAS.md

- Per-fingerprint variant pool (pokemon/1 ↔ pokemon/2). The
  multi-fp wire is half of this; the cached subtree pool still
  needs to become `Map<id, Map<fp, ReactNode>>`.
- Server-driven cache-control on the wire. Same trailer channel
  can carry per-spec `maxAge` / SWR numbers; client uses them to
  suppress `?cached=` inclusion within the fresh window.
- Restart-streaming via segmented Flight (N segments per response
  for cursor-frequency updates). Reuses the same framing.
