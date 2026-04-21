# Lessons from the unified-path refactor

Session: 2026-04-18. The "full monty" that collapsed the two Partial
discovery paths (static walker + runtime registry) into a single
runtime path. `PartialRoot` is now a thin orchestrator; every
fingerprint / skip / `__inputs` / duplicate-id decision lives inside
`<Partial>` itself.

Five lessons worth the space.

---

## 1. `als.enterWith`, not `als.run`, when the scope must outlive the function

The request state lives in an `AsyncLocalStorage`. First attempt:

```ts
return als.run(state, () => <PartialRoot>{children}</PartialRoot>);
```

Every `<Partial>` inside that tree threw "must be rendered inside
`<PartialRoot>`".

`als.run(state, fn)` scopes the store only for synchronous work inside
`fn` plus awaits chained off it. React's RSC renderer doesn't render
the returned JSX inside `fn` — it returns the element, React renders
it later in the caller's async continuation, outside the scope.

```ts
als.enterWith(state);  // <-- correct
return state;          // JSX rendered later still sees the store
```

`enterWith` sets the store on the current async context directly, so
any subsequent async work inherits it through the normal propagation
rules. Use `enterWith` any time the scope must outlive the function
that created it.

## 2. Don't always wrap a Partial in `<Suspense>`

First shape of the refactor: every Partial gets

```jsx
<Suspense key={id}>
  <PartialErrorBoundary>{content}</PartialErrorBoundary>
</Suspense>
```

so Flight preserves the key. Magento's price refresh then stopped
working: the server streamed fresh content, but the DOM stayed stale.

The client's `substituteNested` walker deliberately does **not**
descend into Suspense subtrees — the children may be unresolved Flight
lazies, and forcing them to resolve via walk is unsound. With every
Partial wrapped in Suspense, a cached ancestor (`products`) containing
nested partials (`price-ABC`) was a Suspense-within-Suspense; when we
refetched `price-ABC`, substituteNested saw the outer `products`
Suspense and returned it as-is, never swapping in the fresh
`price-ABC`.

Fix: wrap in Suspense only when the caller provides a `fallback`.
Without a fallback, the outer wrapper is `<PartialErrorBoundary key={id}>`.
The walker happily descends into that — it's a regular client class
component, not a Suspense.

General principle: Suspense is a blocker for structural walkers.
Don't add one just to preserve a key — the key can live on any
client-visible wrapper.

## 3. Don't rely on `node.type` identity across the RSC/SSR module boundary

After the Suspense change, magento's body rendered empty on SSR. The
`isPartialWrapper` check was `node.type === PartialErrorBoundary`.
That identity comparison held during direct rendering in the RSC
environment, but broke on the SSR side: the class reference we
imported did not `===` the `type` that came back on elements decoded
from Flight. Module graphs differ across the RSC / SSR boundary and
client references deserialize to distinct live classes.

Fix: detect wrappers by a **prop** the server always sets, not by
class identity.

```ts
function isPartialWrapper(node) {
  if (node.key == null) return false;
  if (node.type === Suspense) return true;          // React built-in, safe
  return typeof node.props?.partialId === "string"; // stable across boundaries
}
```

Props travel through Flight verbatim. Class identity doesn't.

## 4. Use `partialId`, not `key`, as the cache lookup key

A Partial produced inside `.map()` has a key from the caller *and* a
key on its returned wrapper. When the returned wrapper is a client
component, Flight combines the two into a composite string:

```
<Partial key="page-1" id="page-1"><PageBlock/></Partial>
  returns
<PartialErrorBoundary key="page-1">…</PartialErrorBoundary>
  over Flight arrives as
key="page-1,page-1"          // <-- wat
```

Suspense (a React built-in) doesn't get this treatment — its key stays
clean. So the client caching code, which used `String(node.key)` as
the cache key, worked for Suspense-wrapped partials but silently
failed for ErrorBoundary-wrapped ones: the cache stored under
`"page-1,page-1"` and the template lookup asked for `"page-1"`.

Fix: extract the id from the `partialId` prop whenever possible, fall
back to `key` only for Suspense (where it's reliably clean).

```ts
function getPartialId(node) {
  if (typeof node.props?.partialId === "string") return node.props.partialId;
  if (node.type === Suspense) return String(node.key ?? "");
  return null;
}
```

Treat `node.key` as unstable any time it might cross `.map()` + client
component. Treat explicit prop-based ids as the source of truth.

## 5. Module-mock reset has to live inside the mock body, not `afterEach`

Vitest doesn't auto-reset module-level `vi.mock(...)` replacements
across tests. The original test file set custom `PartialsClient`
implementations in ~25 tests like:

```ts
vi.mocked(await import("../partial-client.tsx")).PartialsClient = (...) => …;
```

Later tests read from module-level capture state, which earlier tests
had clobbered. Failures appeared **only in suite runs, never in
isolation** — a classic "passes alone, fails together" smell.

Fix: one stable mock, reset in place at the start of each render:

```ts
const renderCapture = { freshIds: [], fingerprints: {}, … };

vi.mock("../partial-client.tsx", () => ({
  PartialsClient: ({ children, mode, template }) => {
    // Reset at the top of every render, not in afterEach.
    renderCapture.freshIds.length = 0;
    for (const k of Object.keys(renderCapture.fingerprints)) {
      delete renderCapture.fingerprints[k];
    }
    renderCapture.mode = mode;
    renderCapture.template = template;
    renderCapture.children = children;
    return children;
  },
  …
}));
```

Two rules that fell out of the fix:

- Clear in place (`arr.length = 0`), don't reassign. Tests capture a
  stable reference with `const x = renderCapture.freshIds` — a
  reassignment would leave them pointing at the old array.
- Reset where the data is produced (in the mock), not where it's
  consumed (`afterEach`). The mock knows when a fresh render starts;
  `afterEach` only knows when the previous test ended.

---

## Side notes

- **Historical status line — both side notes below have shipped.** See
  `LESSONS_2026-04-19.md` and `PARTIAL_ARCHITECTURE.md` for the
  current state.
- ~~`seedRegistry` survived the cut.~~ **Removed 2026-04-19**, replaced
  by `refreshRegistry` — a targeted walk that updates existing
  snapshots each request but does not add new ids. The "seed so
  first-request cache-mode can resolve" role is now handled by
  the registry-miss fallback (falls through to streaming mode,
  populates, re-renders).
- ~~`buildTemplate` + `<i hidden data-partial>` placeholders.~~
  **Server-side `buildTemplate` removed 2026-04-19.** The client
  derives the template from the rendered payload and persists it
  in module state across refetches — no per-refetch template
  bytes on the wire. The `<i hidden data-partial data-partial-id>`
  placeholder shape stays; it's emitted by `deriveTemplate` on the
  client and by the Partial body on fingerprint-match skips.
- The `cacheFromStreamingChildren` "don't descend into a cached
  Suspense" rule is still load-bearing for progressive streaming.
  Fix for bug #2 sidestepped it (the outer partial wrapper isn't a
  Suspense unless the caller opted in), but the rule itself stays.
