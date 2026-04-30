# Frame scope internals

After the 2026-04-28 rewrite, frame scoping is no longer a
React.cache-backed mutable cell. Each spec computes its frame chain
explicitly from `parent.frameChain` plus its own `frame` option;
its `vary` callback receives the frame-resolved `Request` as an
argument.

```ts
// inside createSpecComponent (framework/src/lib/partial.tsx):
const ourFrameChain = opts.frame
  ? [...parent.frameChain, opts.frame]
  : parent.frameChain
const ourRequest =
  opts.frame != null
    ? resolveFrameRequest(ourFrameChain, opts.frameUrl)
    : ourFrameChain.length > 0
      ? resolveFrameRequest(ourFrameChain, undefined)
      : getRequest()
```

`resolveFrameRequest` looks the URL up via `getSessionFrameUrl(path)`
and falls back to the spec's `frameUrl` option, then to the page
request.

## Why no cell anymore

The previous design used a per-request mutable cell that descendants
read post-await. This drifted under RSC sibling interleaving — a
sibling spec's body could overwrite the cell between an ancestor's
setup and its descendant's body. The "read accessors at the sync
top of the body" rule was a workaround.

With the constructor model:

- Each spec receives `parent: PartialCtx` as an explicit prop. The
  `frameChain` propagates without any ALS / cell, immune to sibling
  interleaving.
- Vary runs once per spec invocation with the resolved request as
  an argument. There's no cell to drift.

## Wire protocol

Frame navigation drops `?__frame=<dotted-path>&__frameUrl=<url>` on
the URL. `PartialRoot` reads them on every request and writes the
URL into the session before any spec runs. The session is
cookie-backed (`__frame_sid`); state lives in
`framework/src/runtime/session.ts`.

## Client-side handle

`useNavigation(name?)` returns the navigation handle for the named
frame, or for the closest ambient frame in the React context (set
by `FrameNameProvider` from `framework/src/lib/partial-client.tsx`). Buttons
inside a framed spec naturally drive that frame.

## Sharp edges

- **Same-name frames at different depths.** Two specs with
  `frame="tab"` under different ancestors (e.g. `cart.tab` and
  `menu.tab`) coexist because the framework keys every frame by its
  full dotted path.
- **`frameUrl` as cold-session default.** Once the session has a
  URL for the frame, the option is ignored; clear the entry with
  `clearSessionFrame(path)` to reset.
