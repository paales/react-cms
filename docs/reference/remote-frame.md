# `<RemoteFrame>` — cross-process composition

A `<RemoteFrame>` embeds a parton hosted by a different process
(same-origin or cross-origin) into the host's render. The
framework fetches the remote's Flight bytes, rewrites module
references as needed, registers the remote's partials in the
host's registry, and stitches the decoded subtree into the host's
outer response. Inside the host's tree, the remote frame is
indistinguishable from a locally-rendered subtree.

Most call sites don't use `<RemoteFrame>` directly — they use
typed bindings produced by `yarn parton add`. See
[Typed bindings](#typed-bindings) below.

```tsx
import { RemoteFrame } from "@parton/framework"
import { Suspense } from "react"

<Suspense fallback={<Spinner />}>
  <RemoteFrame
    url="https://stripe.example/__remote/payment-form"
    capability={{ cart_id: "abc", currency: "USD", total: 49.95 }}
  />
</Suspense>
```

## Props

```ts
interface RemoteFrameProps {
  url: string
  capability?: Capability
  namespace?: string
}
```

| Prop | Notes |
|---|---|
| `url` | Absolute URL or same-origin path of the remote endpoint. Relative paths resolve against the current request's URL via `getRequest()`. |
| `capability` | Host-declared values the remote can read via `getCapability()`. Flat record of JSON-serializable values; serialized as the `x-parton-capability` header. |
| `namespace` | Prefix applied to every id + label registered from this remote's trailer. `magento` turns the remote's `stocks` spec into `magento:stocks` in the host's registry, so selectors stay collision-free across multiple remotes. Set automatically by `parton add` bindings. |

The remote's payload is always streamed through the row-level
rewriter — within-remote Suspense reveals reach the host
incrementally. Module-ref rewriting auto-derives from `url`:
relative paths skip rewrite (host bundle owns the modules);
absolute paths rewrite relative module refs to the remote origin
so the host browser can dynamically import them.

### Streaming + correct refetch routing for nested partials

Snapshots arrive at the END of the remote's stream (the trailer
carries each PartialBoundary's `emittedFp` and descendant-fold
fields, which can only be computed post-render). The trailer's
`.then` callback would normally fire AFTER the host's outer stream
has flushed and committed — leaving the route-hint table empty
for any nested addressable partial the remote rendered.

The framework's commit-defer mechanism (`deferCommitUntil` on
`partial-registry.ts`) closes that race. `<RemoteFrame>` registers
a promise that resolves when its trailer has been parsed and the
snapshots written; the stream-wrapping helpers
(`wrapStreamWithFpTrailer`, `wrapStreamWithCommitOnly`) call
`Promise.allSettled(_drainPendingDefers())` before firing commit.
Every nested addressable partial therefore lands in the host's
hint table before the response goes out, so
`nav.reload({selector: "magento:cart-summary"})` from the host
finds the snapshot and routes back to the remote — even on the
very first render of the page.

## Typed bindings

`yarn parton add <name> <origin>` generates per-spec typed
wrappers in the host repo, so call sites don't write URLs by
hand and the capability shape is enforced at compile time.

```sh
$ yarn parton add magento http://localhost:5181
Fetching manifest from http://localhost:5181/__remote/manifest.json
Fetching types from http://localhost:5181/__remote/types.d.ts
Wrote src/remote/magento/types.ts
Wrote src/remote/magento/index.ts
Bound 4 spec(s) from http://localhost:5181.
```

The generated `index.ts` exports one component per addressable
spec from the remote:

```ts
import { remote } from "@parton/framework"
import type { PaymentCap } from "./types.ts"

const ORIGIN = "http://localhost:5181"
const NAMESPACE = "magento"

export const MagentoPaymentSummary = remote<PaymentCap>({
  origin: ORIGIN,
  selector: "magento-payment-summary",
  namespace: NAMESPACE,
})

export const MagentoStocks = remote({
  origin: ORIGIN,
  selector: "magento-stocks",
  namespace: NAMESPACE,
})
```

The `namespace` is the install name (`magento` in this case).
Every id + label that comes off this remote is registered in the
host as `magento:<bare-id>`, so two remotes with overlapping
selectors don't collide and `nav.reload({selector: "magento:foo"})`
is self-describing about where the refetch routes to.

Host call sites:

```tsx
import { MagentoPaymentSummary, MagentoStocks } from "@/remote/magento"

<MagentoPaymentSummary
  capability={{ cart_id: "...", currency: "EUR", total: 127.45 }}
/>
<MagentoStocks />
```

When a spec varies on URL search params, the binding accepts a
`searchParams` prop that gets appended to the fetch URL:

```tsx
<MagentoCheckoutStep searchParams={{ step: "payment" }} />
```

`yarn parton update <name>` re-runs the fetch using the origin
recorded in the generated `index.ts`. `yarn parton list` shows
installed remotes; `yarn parton remove <name>` deletes a binding
directory.

### Authoring the remote side

Mark the spec's capability schema by name (the same name exported
from the remote's `remote-types.ts`):

```ts
// e2e-magento/src/app/remote-specs.tsx
export const MagentoPaymentSummary = parton(
  async function Render(_: RenderArgs) {
    const cap = getCapability()
    // …
  },
  {
    selector: "magento-payment-summary",
    capabilityType: "PaymentCap",
  },
)
```

```ts
// e2e-magento/src/app/remote-types.ts
export type PaymentCap = {
  cart_id: string
  currency: string
  total: number
}
```

Expose the endpoints via the `remote` config on the app's entry
handler (`entry.rsc.tsx`):

```tsx
import { createRscHandler } from "@parton/framework/entry/rsc.tsx"

export default createRscHandler({
  Root,
  remote: {
    name: "magento",
    typesPath: new URL("./app/remote-types.ts", import.meta.url).pathname,
  },
})
```

An app assembling a custom request handler mounts the underlying
primitive directly:

```tsx
import { createRemoteHandler } from "@parton/framework"

const remote = createRemoteHandler({
  name: "magento",
  renderToFlightStream: (element) =>
    renderToReadableStream(element, { onError: silenceClientDisconnect }),
  typesPath: new URL("./app/remote-types.ts", import.meta.url).pathname,
})

async function handler(request: Request): Promise<Response> {
  const r = await remote(request)
  if (r) return r
  // …fall through to the app's page handler
}
```

`createRemoteHandler` claims four routes:

| Route | Body |
|---|---|
| `OPTIONS *` | CORS preflight (204) |
| `GET /__remote/manifest.json` | Spec inventory for the CLI |
| `GET /__remote/types.d.ts` | Author-provided `remote-types.ts` file |
| `GET /__remote/<selector>` | Focused Flight bytes + snapshot trailer |

Everything else returns `null`, so the caller falls through to
its normal page handler.

## Selector-targeted refetch routing

`nav.reload({selector: "<id>"})` from a client component refetches
the partial. Routing depends on whether the snapshot was registered
by a local render or by `<RemoteFrame>`:

- **Local**: `partialFromSnapshot` looks up the spec Component in
  the local catalog and re-renders. Fast.
- **Remote (cross-origin)**: `partialFromSnapshot` returns a fresh
  `<RemoteFrame url={origin}/__remote/{remoteId} capability={...} namespace={ns} />`.
  The host fetches the remote endpoint again, re-stitches with the
  same namespace so the registry stays stable across re-renders.

The distinction lives on the snapshot via `source: { kind:
"remote", origin, capability?, remoteId }`. `remoteId` is the
spec's bare id at the remote — separate from the host-side
registry id, which may be namespaced (`magento:stocks` vs
`stocks`). RemoteFrame stamps `source` only for genuinely-
cross-origin remotes — same-origin remotes use the local catalog
path (faster, no round-trip to the same machine).

## Frame navigation (navigating within a RemoteFrame)

Falls out of composing `<Frame>` + a parton wrapper + the
bound remote — no dedicated primitive needed:

```tsx
import { MagentoCheckoutStep } from "@/remote/magento"

<Frame name="checkout" initialUrl="/?step=shipping">
  <CheckoutStepNav />          {/* client buttons: nav.navigate(?step=…) */}
  <RemoteCheckoutFrame />
</Frame>

const RemoteCheckoutFrame = parton(
  function Render(_: RenderArgs) {
    const step = searchParam("step", "shipping")   // tracked read, frame URL
    return (
      <Suspense fallback={…}>
        <MagentoCheckoutStep searchParams={{ step }} />
      </Suspense>
    )
  },
  { selector: "remote-checkout-frame" },
)
```

How it composes:

1. `<Frame>` opens a per-name URL scope (session-backed; survives
   reloads; per-tab shared).
2. The wrapper parton's body reads `?step=` from the frame URL —
   `searchParam()` is a tracked read against the frame-resolved
   request.
3. The parton threads `step` into the binding's `searchParams`.
4. Client buttons inside the frame call
   `useNavigation("checkout").navigate("/?step=…")`. The frame
   URL updates; the tracked read moves the wrapper's fingerprint;
   the binding re-fetches.
5. The page URL is unaffected; other frames are unaffected.

## Freshness on a live connection

A remote's changes never wake the host's segment driver: the remote
is another process, so its invalidations land in ITS registry, not
the host's. On a held live connection the remote's freshness rides
the **whole-tree reconcile cadence** — the periodic full segment the
driver emits on long-lived connections re-fetches every
`<RemoteFrame>` in the tree, and idle connections get the same pass
from the keepalive-reopen's first segment. There are no remote lanes,
by decision: a third-party origin's latency belongs on the scheduled
pass, not on per-wake lane traffic.

Two bounded consequences, documented rather than engineered around:

- **Navigation supersede covers the remote wait.** A navigation
  segment whose tree contains a `<RemoteFrame>` settles only after
  the remote's trailer arrives (`deferCommitUntil`), so the remote
  origin's latency lands on that segment's settle — and inside the
  window where a newer `url` frame can abort the in-flight
  navigation render server-side. A torn wait costs nothing: the
  superseding statement's segment re-fetches the remote.
- **Bounded staleness after a remote deploy.** A redeploy shifts the
  remote's fingerprints wholesale, outside the host's epoch checks —
  an attached client keeps showing the old remote content until the
  next reconcile's full pass re-fetches and re-registers it. The
  staleness window is at most one reconcile interval and
  self-corrects; see [`../internals/channel.md`](../internals/channel.md)
  §The whole-tree reconcile.

## Security note: credentials omit

The fetch is always `credentials: "omit"`. The host's cookies do
NOT leak to the remote, even on same-origin embeddings. The only
host context the remote receives is what's explicitly forwarded
via `capability`.

## Capability scoping

The host explicitly declares what the remote can read. Anything
not declared, the remote doesn't see.

```tsx
// Host
<MagentoPaymentSummary
  capability={{
    cart_id: cart.id,
    currency: cart.currency,
    total: cart.total,
  }}
/>

// Remote spec
const MagentoPaymentSummary = parton(
  async function Render(_: RenderArgs) {
    const cap = getCapability()
    const cartId = String(cap.cart_id)
    // …
  },
  {
    selector: "magento-payment-summary",
    capabilityType: "PaymentCap",
  },
)
```

Wire shape: `x-parton-capability: <base64url JSON>`. The framework
encodes/decodes via `encodeCapability` / `decodeCapability` in
`framework/src/runtime/capability.ts`. Empty/missing/malformed
header decodes to `{}` — the remote sees nothing from the host.

The capability is the trust boundary: a misbehaving remote can't
read host cookies, session, or other host state. It only sees
what the slot owner explicitly forwarded. Signed capability tokens
(so the remote can also trust the host's claims, not just receive
them) are filed in IDEAS.md; v1 is trust-the-network.

## Snapshot trailer

The remote endpoint's render emits PartialBoundary elements that
register snapshots in the REMOTE's request registry. The host
never sees those by default — selector-targeted refetch would
miss. The snapshot trailer fixes this.

After the Flight bytes, the remote appends:

```
<12-byte SNAPSHOT_TRAILER_MARKER>
<4-byte big-endian length>
<UTF-8 JSON: { id: SerializedSnapshot, ... }>
```

The host's `<RemoteFrame>` parses the trailer via the streaming
splitter in `framework/src/lib/snapshot-trailer.ts` and registers
each snapshot in the host's request registry via `registerPartial`.
Selector refetch then finds the id and routes through the normal
isolated-render path (`partialFromSnapshot`).

## Module-ref rewriting

Flight serializes client-component imports as wire rows like:

```
1:I["./Button.tsx", "main"]
```

The string is a module path the host's bundle has to resolve. For
a cross-origin remote, the path is meaningless to the host —
`moduleRefRewriter` (in `framework/src/lib/flight-rewrite.ts`)
rewrites it to an absolute URL at the remote's origin so the host
browser can dynamically import.

The policy auto-derives from `url`:

| `url` shape | Module-ref rewrite |
|---|---|
| Relative path (`/__remote/foo`) | No rewrite. Same-origin; host bundle owns the modules. |
| Absolute URL (`http://remote.example/...`) | Rewrite relative paths (`./X.tsx`, `/X.tsx`) to `<remote-origin>/X.tsx`. |
| `/@fs/...` paths in the remote payload | Left alone. Both processes on the same dev machine can resolve them. |
| `http://...` / `https://...` paths in the payload | Left alone (already absolute). |
| Bare specifiers (`lodash`, `@scope/x`) | Left alone. |

## Production deployment

`<RemoteFrame>` is designed for independently-deployed remote
processes. The dev-mode demos run host + remote on the same
machine for convenience, but each app builds independently
(`yarn build` for the host, `yarn build:magento` for the remote)
and serves independently (`yarn preview` and `yarn preview:magento`,
or `yarn preview:all` to run both with clean port assignments).

In dev, both apps' vite-rsc plugins happen to resolve `/@fs/...`
filesystem-absolute module paths against the same files (so
shared `@parton/framework` modules like `PartialErrorBoundary`
load correctly cross-origin without rewriting). The
auto-derived `defaultModuleRewrite` skips `/@fs/` and `/@id/`
paths for this reason. In production, the bundled asset URLs
are stable per-deployment (hashed paths under `/assets/...`),
the rewriter prepends the remote origin, and CORS on the JS
assets allows the host browser to load them.

Cross-origin demo, production-mode validation:

```sh
yarn build:all       # builds host + magento
yarn preview:all     # serves both: host:5173, magento:5181
# Open http://localhost:5173/remote-frame-crossorigin-demo
```

## Demos

- **`/remote-frame-demo`** — five same-origin remote frames
  exercising parallel streaming, client-component hydration,
  cache-on-remote-spec, and selector-targeted refetch.
- **`/remote-frame-crossorigin-demo`** — requires
  `yarn dev:magento` running in parallel. Embeds four partons
  hosted by `e2e-magento` on port 5181 via typed bindings,
  including a capability-scoped payment summary and a
  checkout-step navigator that exercises `searchParams`.

## Related

- [`partial.md`](./partial.md) — the `parton` constructor.
- [`cache.md`](./cache.md) — caching options that apply to a
  remote spec (the cache lives at the remote, not the host).
- [`../internals/cache-internals.md`](../internals/cache-internals.md)
  — the cache's hole strip/splice, built on the same Flight
  row-parsing primitive as `<RemoteFrame>`'s rewriter.
