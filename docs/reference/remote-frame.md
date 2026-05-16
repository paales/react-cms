# `<RemoteFrame>` — cross-process composition

A `<RemoteFrame>` embeds a parton hosted by a different process
(same-origin or cross-origin) into the host's render. The
framework fetches the remote's Flight bytes, rewrites module
references as needed, registers the remote's partials in the
host's registry, and stitches the decoded subtree into the host's
outer response. Inside the host's tree, the remote frame is
indistinguishable from a locally-rendered subtree.

```tsx
import { RemoteFrame } from "@parton/framework"
import { Suspense } from "react"

<Suspense fallback={<Spinner />}>
  <RemoteFrame
    src="https://stripe.example/__remote/payment-form"
    parent={parent}
    capability={{ cart_id: "abc", currency: "USD", total: 49.95 }}
  />
</Suspense>
```

## Props

```ts
interface RemoteFrameProps {
  src: string
  parent: PartialCtx
  capability?: Capability
  rewriter?: RowRewriter
  rewriteModuleRefs?: boolean | ((path: string) => string)
  headers?: Record<string, string>
}
```

| Prop | Notes |
|---|---|
| `src` | Absolute URL or same-origin path. Relative paths resolve against the current request's URL via `getRequest()`. |
| `parent` | Host `PartialCtx`. Passed for placement consistency; the remote runs in its own process scope, so this isn't forwarded over the wire. |
| `capability` | Host-declared values the remote can read via `getCapability()`. Flat record of JSON-serializable values; serialized as the `x-parton-capability` header. |
| `rewriter` | Author-supplied per-row Flight rewriter. Composes with the auto-derived module-ref rewriter (module rewrite runs first; author runs second). |
| `rewriteModuleRefs` | `true` (default for absolute `src`) — rewrite relative module paths to the remote origin. `false` — pass through. A function — custom transform. `/@fs/` and `/@id/` paths are left alone (dev-mode filesystem-absolute, both processes can resolve them). |
| `headers` | Extra headers on the remote fetch. Composed with `capability` (capability wins on collision). |

The fetch is always `credentials: "omit"`. The host's cookies do
NOT leak to the remote, even on same-origin embeddings. The only
host context the remote receives is what's explicitly forwarded
via `capability`.

## The remote endpoint

A remote endpoint is an HTTP route that returns a focused Flight
payload for a single parton. In `e2e-testing` and `e2e-magento`,
the routes live in `entry.rsc.tsx` under `/__remote/<spec-id>`:

```ts
if (url.pathname.startsWith("/__remote/")) {
  const id = decodeURIComponent(url.pathname.slice("/__remote/".length))
  const spec = getSpecById(id)
  if (!spec) return new Response(`Unknown spec: ${id}`, { status: 404 })

  const capability = decodeCapability(request.headers.get(CAPABILITY_HEADER))
  const { result: stream } = await runWithRequestAsync(request, async () => {
    enterRequestRegistry("__remote", "streaming")
    return runWithCapability(capability, () => {
      const flightStream = renderToReadableStream(<spec.Component parent={ROOT} />, {
        onError: silenceClientDisconnect,
      })
      return wrapStreamWithSnapshotTrailer(flightStream, () => {
        const reg = getActiveRegistry()
        return reg ? reg.pendingWrites : new Map()
      })
    })
  })
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/x-component;charset=utf-8",
      "access-control-allow-origin": "*",
    },
  })
}
```

Three context boundaries wrap the render:

1. **`runWithRequestAsync(request, ...)`** — request ALS for
   `getRequest()` / `getCookie()` / etc.
2. **`enterRequestRegistry("__remote", "streaming")`** —
   PartialBoundary's `registerPartial` side effect has a place to
   write. The remote's registry is throwaway; only `pendingWrites`
   matters, captured by the snapshot trailer at flush time.
3. **`runWithCapability(capability, ...)`** — the host-declared
   capability becomes available via `getCapability()`.

The remote's CORS handler answers `OPTIONS` preflight with
permissive `access-control-allow-*`. Production deployments
should tighten this to the host's origin.

## Capability scoping

The host explicitly declares what the remote can read. Anything
not declared, the remote doesn't see.

```tsx
// Host
<RemoteFrame
  src="https://stripe.example/__remote/payment-method-picker"
  capability={{
    cart_id: cart.id,
    currency: cart.currency,
    total: cart.total,
    idempotency_key: requestId,
  }}
  parent={parent}
/>

// Remote spec
import { parton, getCapability, type RenderArgs } from "@parton/framework"

const PaymentMethodPicker = parton(
  async function Render(_: RenderArgs) {
    const cap = getCapability()
    const methods = await listAcceptedMethods({
      cartId: String(cap.cart_id),
      currency: String(cap.currency),
      total: Number(cap.total),
    })
    return <Methods methods={methods} idempotencyKey={String(cap.idempotency_key)} />
  },
  { selector: "payment-method-picker" },
)
```

Wire shape: `x-parton-capability: <base64url JSON>`. The framework
encodes/decodes via `encodeCapability` / `decodeCapability` in
`framework/src/runtime/capability.ts`. Empty/missing/malformed
header decodes to `{}` — the remote sees nothing from the host.

The capability is the trust boundary: a misbehaving remote can't
read host cookies, session, or other host state. It only sees
what the slot owner explicitly forwarded. v2 will add signed
capability tokens so the remote can also trust the host's claims
(not just receive them); v1 is trust-the-network.

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

The host's `<RemoteFrame>` parses the trailer via
`parseSnapshotTrailer` (in `framework/src/lib/snapshot-trailer.ts`)
and re-registers each snapshot in the host's request registry via
`registerPartial`. Selector refetch (`nav.reload({selector: "..."})`)
now finds the id and routes through the normal cache-mode path.

Same-origin v1: the refetch hits the host's local spec catalog
(both processes share the same spec definitions). Cross-origin
v2 will need a `source: "remote:<origin>"` field on the snapshot
so the host's refetch dispatcher routes back to the remote
endpoint rather than rendering locally.

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

The default policy auto-derives from `src`:

| `src` shape | Module-ref rewrite |
|---|---|
| Relative path (`/__remote/foo`) | No rewrite. Same-origin; host bundle owns the modules. |
| Absolute URL (`http://remote.example/...`) | Rewrite relative paths (`./X.tsx`, `/X.tsx`) to `<remote-origin>/X.tsx`. |
| `/@fs/...` paths in the remote payload | Left alone. Both processes on the same dev machine can resolve them. |
| `http://...` / `https://...` paths in the payload | Left alone (already absolute). |
| Bare specifiers (`lodash`, `@scope/x`) | Left alone. |

Override via `rewriteModuleRefs: false` (no rewrite) or
`rewriteModuleRefs: (path) => path` (custom transform).

## Streaming trade-off

The current `<RemoteFrame>` implementation buffers the full
remote response before decoding. The reason: the snapshot
trailer arrives at the END of the response, and we want to
register snapshots BEFORE the outer Flight encoder commits.
Buffering keeps the ordering simple.

Cost: streaming inside a single remote payload is lost. Multiple
remote frames still arrive in parallel (each in its own Suspense
boundary) — what doesn't work is a single remote with nested
Suspense streaming each reveal to the host. Holdback-streaming
is filed in `snapshot-trailer.ts` as a follow-up.

## Demos

- **`/remote-frame-demo`** — five same-origin remote frames
  exercising parallel streaming, client-component hydration,
  cache-on-remote-spec, and selector-targeted refetch.
- **`/remote-frame-crossorigin-demo`** — requires
  `yarn dev:magento` running in parallel. Embeds three partons
  hosted by `e2e-magento` on port 5181, including a capability-
  scoped payment summary that reads `cart_id` / `currency` /
  `total` from `getCapability()`.

## Related

- [`partial.md`](./partial.md) — the `parton` constructor.
- [`cache.md`](./cache.md) — caching options that apply to a
  remote spec (the cache lives at the remote, not the host).
- [`docs/internals/cache-internals.md`](../internals/cache-internals.md)
  — the cache's auto-detect path (same `flight-rewrite` primitive
  as `<RemoteFrame>`).
