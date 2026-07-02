# Flight gotchas

A few RSC-specific quirks the framework works around. They live one
level below the API surface.

The wire-format facts the byte-level rewriters bake in — row framing
(and its one exception: length-prefixed `T` text rows, which are NOT
newline-terminated), `$` / `$L` / `$@` ref shapes with `:deref`
suffixes, `$$` escaping, `$undefined`, `I` / `$S` row shapes and their
flush order, composite keys, duplicate-row tolerance, UTF-8 validity —
are pinned by the conformance canary
`framework/src/lib/__tests__/flight-format-canary.rsc.test.tsx`. It
renders fixtures through the real Flight runtime and asserts each fact
against the emitted bytes, so a React / `@vitejs/plugin-rsc` upgrade
that changes the format breaks that file with the moved assumption
named, instead of silently mis-splicing a cached payload.

## Composite keys on dynamic partials

Flight composites the outer `.map()` key with a client-component's
own `key` into `"outerKey,innerKey"` on the wire. A
`<SpecComponent key={item.id} />` produced inside a `.map()` would
emit `"item.id,item.id"` on a wrapping `<Suspense key={item.id}>`,
which the client reconciles as a different identity than the plain
`"item.id"` emitted in streaming mode — forcing a remount that
wipes client state inside the partial.

Fix: wrap in a keyed `<Fragment>` instead of putting the key on the
spec component itself.

```tsx
{items.map((item) => (
  <Fragment key={item.id}>
    <ItemSpec />
  </Fragment>
))}
```

## Decoding flattens streaming

`createFromReadableStream` returns a tree whose nested chunks are
Flight lazy refs; forcing them (a decode → re-encode round-trip)
resolves every Suspense boundary and destroys streaming pacing.
That's why the byte cache and `<RemoteFrame>` never decode stored /
proxied payloads to React trees — they rewrite at the row/line
level (`flight-graph.ts`, `flight-rewrite.ts`) and let the client
resolve lazies natively. See
[`cache-internals.md`](./cache-internals.md).

## `data-partial-id` + `data-partial-match` on placeholders

Placeholder elements carry both `data-partial-id` and
`data-partial-match` (in addition to a composite key
`"<id>|<matchKey>"`) because Flight composite-key behavior also
affects the `<i>`'s key for placeholders emitted inside `.map()`
walks. The client looks up the cached subtree under
`Map<id, Map<matchKey, ReactNode>>` from those two attributes;
`key` is reserved for React sibling reconciliation only and is not
used for cache lookups. matchKey is a 16-char hex hash of
`stableStringify(matchParams)` so the three-segment `id:matchKey:fp`
wire token parses unambiguously regardless of the id's content.

## `key` on a `<PartialBoundary>` element

The framework never puts a `key` on a `<PartialBoundary>` — the
inner Suspense already has one. Doing so would composite as
`"id,id"` on the wire and break reconciliation.

## Why no `createContext` in server bundles

React's RSC build (`react.react-server.js`) deliberately excludes
`createContext`. Server components can't create their own
providers. The framework works around this by:

- Implementing **server context** ([`server-context.md`](./server-context.md)):
  a small patch threads a parton's `parent` through React's Flight task
  graph, so partons read it ambiently without a `createContext`.
- Stamping the rendering parton's identity (with its frame-resolved
  `request`) on the same per-component frame, so the tracked
  server-hooks read it without a `createContext`.
