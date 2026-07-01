# Frame scope internals

A parton reads its frame chain from server context — the ambient
parton's `frameChain` (see [`server-context.md`](./server-context.md)).
It opens no frame of its own; `<Frame>` is what extends the chain. Its
`vary` callback receives the frame-resolved `Request` as an argument.

```ts
// inside createSpecComponent (framework/src/lib/partial.tsx):
const parent = getAmbientParent()
const ourFrameChain = parent.frameChain
const ourRequest =
  ourFrameChain.length > 0 ? resolveFrameRequest(ourFrameChain) : getRequest()
```

`<Frame name>` reads the same ambient parent, appends `name` to the
chain, and sets that as its descendants' context, so they inherit the
extended chain. `resolveFrameRequest` looks the URL up via
`getSessionFrameUrl(path)` (a `<Frame>`'s `initialUrl` is written there
on cold render) and falls back to the page request.

## Why server context, not an ALS cell

RSC sibling interleaving makes a per-request mutable cell unsafe: a
sibling spec's body can overwrite the cell between an ancestor's
setup and its descendant's body. The frame chain rides server context
instead — threaded through the parton ALS frame — which survives
`await` and isolates siblings, so the chain propagates without any
per-request cell drift. `vary` runs once per spec invocation with the resolved
request as an argument.

## Wire protocol

Frame navigation drops `?__frame=<dotted-path>&__frameUrl=<url>` on
the URL. `PartialRoot` reads them on every request and writes the
URL into the session before any spec runs. The session is
cookie-backed (`__frame_sid`); state lives in the in-memory store in
`framework/src/runtime/session.ts`. Entries expire on inactivity —
every read or write refreshes the session's idle clock, so an active
session's frame URLs never vanish under the user; sessions idle past
the TTL (default 30 minutes, `configureSessionStore({ idleTtlMs })`)
are dropped, bounding the store in a long-lived process.

## Client-side handle

`useNavigation(name?)` returns the navigation handle for the named
frame, or for the closest ambient frame in the React context (set
by `FrameNameProvider` from `framework/src/lib/partial-client.tsx`). Buttons
inside a framed spec naturally drive that frame.

## Sharp edges

- **Same-name frames at different depths.** Two `<Frame name="tab">`
  under different ancestors (e.g. `cart.tab` and `menu.tab`) coexist
  because the framework keys every frame by its full dotted path.
- **`initialUrl` as cold-session default.** Once the session has a
  URL for the frame, the prop is ignored; clear the entry with
  `clearSessionFrame(path)` to reset.
