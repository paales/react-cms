# Frame scoping — what holds the scope

**Status:** `React.cache` mutation cell (current).
**History:** tried Context → ALS + Flight → ALS-only → `React.cache`.
**Regression gate:** the `/frames-demo` playwright suite.

## TL;DR (2026-04-21)

Per-frame URL/request scoping uses a `React.cache()`-backed mutable
cell, following the pattern of
https://github.com/zhangyu1818/react-server-only-context. The cell
is a per-request singleton; `FrameWrapper` mutates it before
rendering children; tracked accessors read it.

```ts
const frameScopeCell = cache(() => ({ current: null }));
function setCurrentFrameScope(scope) { frameScopeCell().current = scope; }
function getCurrentFrameScope() { return frameScopeCell().current; }
```

This preserves **progressive streaming inside framed subtrees** —
which is non-negotiable. Earlier iterations using AsyncLocalStorage
required a Flight render+decode round-trip to contain the scope,
which buffered the whole subtree before the frame's body could
return. With `React.cache` we just mutate the cell and hand off
children synchronously.

**The discipline** is the same as the cache manifest's
`HoistingViolationError`: read accessors at the top of an async
server component body, BEFORE any `await`. After an `await` the
cell may have been mutated by a sibling frame.

## Why not the other options

### React Context

Would be ideal — `use(FrameContext)` in server components, provider
wraps children, React walks descendents with the context active. It
works under `react-dom/server.edge` (eight-test spike passed).

**Blocker:** React's RSC build (`react.react-server.js`) does not
export `createContext`. Server components can't create provider
trees. Verified:

```bash
$ node -e "const r = require('./node_modules/react/cjs/react.react-server.development.js'); console.log(Object.keys(r).filter(k=>k.match(/context/i)))"
[]
```

If a future React RSC build adds `createContext`, switching to
that is pure simplification.

### `AsyncLocalStorage.run`

Classic Node ALS. Does not propagate to children: `als.run(s, () =>
JSX)` closes before React walks the returned JSX. Descendants see
no store. Spike proved it.

### `AsyncLocalStorage.enterWith`

Propagates to descendants (one-way set on current async context)
but LEAKS to siblings and to everything rendered after a nested
frame returns. Not isolatable. Spike proved it.

### ALS + Flight render+decode

Open an ALS scope, render children through
`renderToReadableStream`, decode, return the tree. The async walk
happens inside the scope so descendants inherit. Correct, but the
Flight round-trip buffers the whole subtree before returning — a
slow async component inside a framed subtree blocks the outer
render.

We shipped this briefly and rolled it back when we hit the
streaming regression.

### `React.cache` mutation (current)

Works because:

1. `React.cache(fn)` returns the same object reference for a given
   function + identity during one request. So
   `frameScopeCell()` is the shared cell every reader sees.
2. `FrameWrapper` mutates the cell synchronously before React
   walks its children. Depth-first rendering gives descendants the
   frame's scope at their moment of render.
3. No Flight round-trip, no ALS context threading — streams fine.

Caveat documented by the library's author and confirmed in our
spike: **nested/sibling providers can race** if a descendant reads
the cell AFTER an `await` — another frame's mutation may have
replaced the value. The "read before await" discipline handles
this. Our existing `HoistingViolationError` already enforces the
discipline for cache manifest keys; framed accessors ride on the
same rule.

## Rules of thumb

1. Scope lives with the tree and the render walk? `React.cache`.
2. Scope lives with the async chain AND is set once, top-level?
   ALS (what `runWithRequestAsync` does).
3. Reading a scope value across an `await` in a server component?
   Read at the top, assign to a local, then await.
4. Sibling / nested frames? They share the cell; read before await
   and everything resolves. If a component awaits and then reads,
   the cell may have drifted — hoist the read.

## Sharp edge: fingerprint drift between render modes (2026-04-23)

`<Partial>`'s fingerprint folded in an **ambient frame key** —
`getCurrentFrameScope()?.name + url` — for descendants of a framed
ancestor, so the structural fp changed when the enclosing frame's
URL changed (otherwise the client-skip path would reuse stale bytes
for stage Partials inside a frame whose URL just moved).

The cell leaks that read to sibling subtrees too. Concrete trigger:
`<ChatOverlay>` is rendered as a sibling of the page content in
`root.tsx`. Its `<Partial frame="chat-overlay">` runs, mutates the
cell, then React schedules the sibling page's Partials — they read
the cell and see `inFrame=chat-overlay` in their fingerprint input
even though they are not inside the chat frame. On the RSC-refetch
path the page renders without the sibling overlay, so the cell is
clean and the fingerprint differs. Result: `<Partial cache>` inside
a leak-affected subtree thrashes — full and refetch renders produce
different `baseKey` strings, never share a cache entry.

Fix (first pass): `src/lib/partial-component.tsx` now computes two
hashes. `structuralFp = hash(fingerprintElement(content) +
ownFrameKey)` — feeds `<Cache id= fingerprint=>` so the cache key is
stable across render modes. `fp = hash(… + ambientFrameKey)` — still
used for the client fingerprint-match skip so stage Partials inside
a frame still invalidate on frame-URL changes. The two can diverge
only in the exact leak-induced case; for legitimate nested frames
they are equal by construction (own and ambient frame URLs match).

Repro that drove the first pass: `e2e/cache-demo.spec.ts:48` (RSC
refetch of the `#slow` Partial on `/cache-demo?flavor=…`) hit the
slow render path on every refetch before the split, passed after.

**Fix (second pass, 2026-04-23 — sibling leak into self-framing fp).**
The split above kept the `<Cache>` key stable but `fp` still carried
the sibling leak. Symptom: open the `<ChatOverlay>` on `/` (which
follows pokemon's `<Partial frame="search">` in render order), let
it stream, then navigate to `/magento` (no sibling frame). The
cached fp from `/` contained `inFrame=search:…`; the server's fresh
fp on `/magento` did not; cross-page fingerprint-skip missed, the
overlay re-rendered and the streamed chat briefly vanished.

Resolution: `ambientFrameKey` is now skipped entirely when the
Partial opens its own frame (`frame != null`). A self-framing
Partial's content runs under its own scope (via `FrameWrapper`), so
a sibling's leaked mutation has no semantic meaning for it. For
nested (non-framed) Partials inside a framed ancestor the ambient
fold is retained — that's the legitimate use it was added for, and
the regression test
`src/lib/__tests__/partial-frame-scope.rsc.test.tsx` pins both
halves. E2E cover in `e2e/chat-overlay-cross-page-nav.spec.ts`.

After the second pass `fp` and `structuralFp` are equal for every
self-framing Partial (the only difference between them was the
`ambientFrameKey` term, which now evaluates to `""` in that case).
The split remains load-bearing for nested non-framed Partials, where
`ambientFrameKey` carries the enclosing frame URL.

## Workaround: `<Partial varyOn>` for descendants of a frame-bearing parent (2026-04-26)

The cell leak surfaces in another way for sibling subtrees that
deliberately read the PAGE request instead of any leaked frame URL.
The CMS editor's field panel is the canonical case: it sits next to a
`<Partial frame="preview">` and reads `?select=` / `?config=` from the
page URL. It can't use `getSearchParam` (would resolve against the
preview frame's URL whenever the leak fires) so it reads via
`getRequest()` instead. The cost: those reads don't contribute to the
structural fingerprint, so the fp-skip handshake serves stale bytes
across same-route navs.

`<Partial varyOn>` (added 2026-04-26) is the safety hatch — declare
the URL deps explicitly and the framework folds them into the fp,
resolved against the page request directly (sidesteps the cell). See
`notes/VARY_ON.md`.

A "real" fix for the leak — Flight-round-trip containment of
FrameWrapper — remains punted because it kills progressive streaming
inside framed subtrees. As long as that constraint stands, declarative
`varyOn` is the contract for descendants that need the page URL.
