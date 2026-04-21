# Lessons learned — refetch mechanics

Session: 2026-04-16 → 2026-04-17. Tightening the partial refetch path:
bare-key Suspense reconciliation, fingerprint-based skip, flipped
transition default, and the round-trip that was silently dropping
implicit keys.

> **Companion doc:** `LESSONS_FROM_REFACTOR.md` (2026-04-18) captures
> the separate lessons from collapsing the two Partial discovery paths
> into one — `als.enterWith` vs `als.run`, conditional Suspense wrap,
> prop-based wrapper detection, `partialId` vs `node.key`, the test-mock
> reset pattern. Read both together for the full post-mortem.

---

## 1. Re-validate assumptions against the current React every time

The previous iteration of this code was built against an earlier
React canary. Multiple pieces of "load-bearing complexity" turned out
to be unnecessary on React 19.3:

- **Version-stamped Suspense keys** (`${id}#${streamVersion}`) existed
  to force unmount/remount so fallbacks flashed on refetch. On 19.3,
  a plain re-render with bare keys + non-transition commit already
  shows the fallback.
- **`flushSync`** on the RSC payload commit was ceremony. A post-await
  `setState` is already outside any transition; React schedules it
  the same way.
- **`cache.clear()` on every streaming render** was belt-and-braces
  cleanup that actively fought the fingerprint-skip optimization.

Rule of thumb: before preserving a workaround, write the minimal repro
and check whether it still reproduces. Don't assume a comment that
says "required" or "ONLY way" is still accurate — it was true *once*.

## 2. React's suspend behavior is fully determined by the commit path

Same JSX, same refetch response, two different UXs depending on how
we commit on the client:

| Commit path | Non-transition (plain setState / flushSync) | Transition (startTransition) |
|---|---|---|
| Pending children | Shows fallback | Preserves old UI |
| Per-chunk streaming | Yes — each boundary commits as its Flight chunk resolves | No — waits for the whole new subtree |
| Client state inside the Suspense | Preserved (kids hidden behind fallback, not unmounted) | Preserved (never hides) |

Two useful defaults pop out of this table:

- **Default = transition.** Most refetches "replace a value in place"
  (cart, price, time). Users prefer one atomic swap to a fallback
  flash every few hundred ms.
- **Opt-in streaming for fan-out updates** (search results, filters,
  multi-row lists where per-row reveal hides tail latency).

That's the shape of the new `disableTransition` option.

## 3. Fallback on re-suspend does NOT unmount the old children

React 19's Suspense keeps the last-committed children in the DOM
(hidden) while the fallback renders alongside. The `[data-testid=
"foo-content"]` element is still `querySelector`-findable during the
fallback window.

Three of our e2e observers had this shape:

```js
if (content) parts.push(`S${i}:content`);
else if (fallback) parts.push(`S${i}:fallback`);
```

They reported "content" for the whole refetch because the content
element never left the DOM — fallback-first was never evaluated.
Warmer rule: **if you want to know the user's visible state, check
the fallback first** (its presence means the user is seeing it).

## 4. Flight serialization loses implicit keys on static siblings

```tsx
<a>
  {maybeImg && <img/>}
  <h2>...</h2>
  <div>...</div>
</a>
```

Through Flight, this round-trips with `children` as an array. When a
tree walker rebuilds the element via `cloneElement(node, {}, decoded)`,
React treats that explicit array as a list and requires `key=` on
each child — which static JSX never declared because it never needed
to. Result: every card on every search refetch threw "each child in
a list should have a unique key" warnings.

Fix in every walker that rebuilds nodes (`resolveLazies`,
`substituteNested`, `stripPartials`, `reinject`):
spread arrays into variadic children so the implicit positional keys
stay:

```ts
return Array.isArray(newChildren)
  ? cloneElement(node, {}, ...newChildren)
  : cloneElement(node, {}, newChildren);
```

General rule: any time a walker reconstructs a React element from a
decoded Flight tree, it inherits the array shape of the original
serialization. Don't forward that array straight into `cloneElement`
unless you want React to treat it as a list.

## 5. Fingerprints answer "is the shape the same?" — enough for skip

The fingerprint is structural: component type + scalar props +
recursion through children. It *doesn't* capture:

- Data fetched inside async server components (no way to know without
  rendering).
- Request context (`getRequest().url`, cookies).

But it captures the signal that matters for nav-triggered refetches:
if no prop anywhere in the subtree changed, the shape will be the
same after rendering too. That's enough to emit a placeholder and
let the client fill from `_cache`.

The `cachedFingerprints` map was already populated from `?cached=`
but never consulted — wiring it into the streaming-mode transform
was a ~15-line change and ~55% reduction in nav RSC payload on the
demo route.

## 6. Opaque function components are walker blind spots

`stripPartials(children)` walks the JSX *input* tree. Children of
`<Cache><ProductGrid/></Cache>` is `<ProductGrid/>` — an unrendered
component. The `.map(p => <Partial id={"price-" + p.sku}/>)` inside
is invisible until render, by which point stripPartials has already
run and missed them.

Current behavior: dynamic partials inside Cache are baked into the
cached bytes on first miss and served verbatim on every hit (frozen
prices). Tag-based refetch (`?tags=price`) still refreshes them via
the registry, but the cache entry itself is stale.

The real fix is non-trivial (render first → strip rendered tree →
re-encode, store partial IDs on the entry so hits can replay via
registry). Documented in IDEAS.md for a later pass. The lesson:
**any walker that runs on JSX input sees only what the static tree
exposes.** Some things only exist after render.

## 7. Dev-server state is implicit test infrastructure

Playwright and Vitest both hit `localhost:5173`. If an old Vite
instance is listening (from a previous session, crashed run, HMR
glitch), everything silently runs against the *wrong* codebase —
expectations mismatch, perf numbers lie, warnings come from stale
bundles. Symptom that tipped us off: dev starting on `5174` with a
log line "Port 5173 is in use, trying another one…".

Cache state matters too. `<Cache>` doesn't have cross-test isolation
beyond the explicit `/__test/clear-caches` endpoint. Any vitest that
depends on cold-miss timing needs an explicit `beforeEach` to clear
the store, or it'll flake against whatever the previous test left
behind.

## 8. "Empirical first" beats "reason through React's scheduler"

Four of the non-trivial wins in this pass came from *just trying the
smallest possible change and running the test suite* instead of
reasoning further:

- Removing version stamping (expected "breaks streaming" → actually
  works fine).
- Removing flushSync (expected "timing becomes unpredictable" →
  same numbers, cleaner code).
- Relying on fingerprint for skip (expected "need a new protocol" →
  the client was already sending them).
- Skipping `cache.clear()` (expected "stale entries leak" → no
  observable issue).

The tests are fast enough (~1 min for the whole playwright suite)
that guessing and checking is often cheaper than deriving from first
principles.
