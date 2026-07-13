# `<RemoteFrame>` — embedding ordinary pages

The unit of federation is an ordinary page. A `<RemoteFrame url>`
pointed at a page URL — a path on the app's own origin, or an
absolute URL on another one — fetches that page as Flight, slices
out the document chrome, and stitches everything inside the page's
body into the host's render. Like an iframe, minus the separate
browsing context. There is no special route: any page any client
could visit is embeddable, which also means an app can embed
**itself**.

```tsx
import { RemoteFrame } from "@parton/framework"
import { Suspense } from "react"
;<Suspense fallback={<Spinner />}>
  <RemoteFrame
    url="https://stripe.example/remote/payment-form"
    capability={{ cart_id: "abc", currency: "USD", total: 49.95 }}
  />
</Suspense>
```

An app that wants to expose one parton publishes a _page_ whose
route renders just that parton — addressable, cacheable, navigable,
and testable in a browser by itself. An **embeddable page** is an
ordinary page with a constrained diet: everything in its body is
spliced into the host, so a page that mounts the app's full shell
chrome ships that chrome into every host that embeds it (see
[Embed economics](#embed-economics)).

Most cross-origin call sites use typed bindings produced by
`yarn parton add` — see [Typed bindings](#typed-bindings).

## Props

```ts
interface RemoteFrameProps {
  url: string
  capability?: Capability
  namespace?: string
  grant?: EmbedGrant | readonly EmbedGrant[]
}
```

| Prop         | Notes                                                                                                                                                                                                                                                                                                                                                    |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`        | The page URL to embed. Absolute URL (cross-origin) or same-origin path; relative paths resolve against the current request's URL.                                                                                                                                                                                                                        |
| `capability` | Host-declared values the embedded render can read via `getCapability()`. Flat record of JSON-serializable values; serialized as the `x-parton-capability` header and decoded into scope on the embed-flagged page render.                                                                                                                                |
| `namespace`  | Human prefix for the embed's refetch **labels** in the host registry (`magento` turns the embedded page's `stocks` label into `magento:stocks`), so host-side selectors are self-describing across remotes. Identity does not depend on it — see below. Set automatically by `parton add` bindings.                                                      |
| `grant`      | Trust grant for the embedded payload — a grant **set** (a bare name is the singleton set). Omitted = full trust: the payload splices as-is. Present = enforced at splice time by the tier rewriter; v1 ships `"paint"`. See [Grants](#grants--the-paint-tier). Replayed on targeted refetch, so a placement can never re-fetch wider than it was placed. |

## How an embed renders

1. The frame fetches the page URL with two explicit request signals:
   `x-parton-render: 1` (return Flight, not an HTML document — the
   URL stays the page URL) and `x-parton-embed-depth: N` (this render
   is an embed at nesting depth N), plus the placement namespace
   header (below). `credentials: "omit"` always — the host's cookies
   never reach the embedded render, even same-origin.
2. The producer's `PartialRoot` sees the depth header and emits the
   app tree inside an explicit slice-marker element instead of the
   page shell (the host document already runs `PageUrlProvider` +
   `PartialsClient`).
3. The host streams the response through a row-local rewriter that
   unwraps the marker and the `html`/`body` document singletons, and
   drops `head`/`title`/`meta`/`link` and resource-hint rows —
   embedded metadata can never hijack the host's head. Everything
   else passes through byte-identical, so within-embed Suspense
   pacing streams through to the client.
4. The decoded subtree is returned as JSX; the outer Flight encoder
   serializes it into the host's response.

Mechanics (wire grammar, the rewriter, the recursion guard, ALS
isolation) live in
[`../internals/page-embed.md`](../internals/page-embed.md).

A page embedding **itself** terminates deterministically: each hop
increments the depth header, and the frame rendered at the max depth
(3) renders an inert `<div hidden data-parton-embed-limit>` marker
instead of fetching — the silent termination a browser applies to a
recursively-nested iframe.

## Identity — placement-scoped namespaces

Every placement of a `<RemoteFrame>` mints a **placement namespace**
(`e~<hash>`, or `<namespace>~<hash>` with the human prefix) from its
position in the host tree: the host render's own inbound namespace,
the ambient parton path, the embedded page's origin + pathname, and
an occurrence counter for same-URL siblings. The namespace crosses as
the `x-parton-embed-ns` header and the producer folds it into every
effective parton id it mints for that render.

Consequences:

- Two embeds of the **same page** in one host page carry distinct
  ids end-to-end (wire, client cache, both registries).
- A page embedding **itself** mounts distinct ids per nesting level,
  so the full chain hydrates.
- The embedded page's ids are stable across SSR, hydration, and
  re-renders of the same host page (the derivation is a pure function
  of tree position), and a targeted refetch **replays** the stored
  namespace rather than re-deriving it.

The `~` character is framework-reserved in id grammar; app selectors
must not use it. The namespace deliberately excludes the URL's search
params, so a frame-driven embed (`?step=payment`) keeps one identity
while its content moves.

**Labels stay bare.** Refetch labels are class-level fan-out targets;
the producer's own invalidation selectors keep matching them, and a
host-side `reload({selector: "price"})` fans out to every embedded
instance carrying the label. The optional `namespace` prop prefixes
labels host-side (`magento:stocks`) for cross-remote hygiene.

## Refetch — `?partials=` at the embedded URL

The embedded page's render registers its partons in the producer's
own registry, and ships them to the host as a `snapshots` trailer
entry after the Flight bytes (same `\xFF[parton:snapshots:N]` marker
grammar as the fp/url/settled entries — the segment splitter's
trailer map carries it, and commit-defer holds the host's commit open
until registration lands). Each snapshot registers in the HOST's
registry stamped:

```ts
source: { kind: "page", url, ns, namespace?, capability? }
```

`nav.reload({selector})` resolving to a page-sourced snapshot
re-embeds the page with the ordinary protocol — a page GET at the
**embedded URL** with `?partials=<id>` plus the embed headers,
replaying the stored placement namespace and capability. The producer
answers a _focused_ render: it reconstructs just the target(s) from
its own registry (the same isolated-render path a local lane takes)
and ships a fresh trailer. A registry miss on the producer falls back
to the whole page — over-fetch, never fail.

Nested embeds chain: each hop stamps its OWN fetch URL when
registering, so a refetch retraces exactly the hops that produced the
content.

## Freshness

- **Same-origin embeds share the process registry**, so a cell write
  or `refreshSelector` whose labels match an embedded snapshot wakes
  the host's live connections and lanes a focused re-embed — embedded
  content stays live with zero extra machinery.
- **Cross-origin**, the remote's invalidations land in its own
  process. On a held connection the remote's freshness rides the
  whole-tree reconcile cadence — the periodic full segment re-runs
  every `<RemoteFrame>` in the tree. A remote redeploy is therefore
  stale for at most one reconcile interval; see
  [`../internals/channel.md`](../internals/channel.md).
- An embed fetch carries no client cache manifest, so the embedded
  page renders fully on every hop (over-fetch, never stale). A
  producer-side `cache: { maxAge }` on the embedded parton still
  applies — the second embed of its page replays the producer's byte
  cache.

## Capability scoping

The host explicitly declares what the embedded render can read; the
embedded page sees nothing else — an embed is an anonymous visitor
plus the capability you hand it.

```tsx
// Host
;<MagentoPaymentSummary
  capability={{ cart_id: cart.id, currency: cart.currency, total: cart.total }}
/>

// Embedded page's parton
const MagentoPaymentSummary = parton(
  async function Render(_: RenderArgs) {
    const cap = getCapability()
    // …
  },
  {
    selector: "magento-payment-summary",
    match: "/remote/magento-payment-summary",
    capabilityType: "PaymentCap",
  },
)
```

Wire shape: `x-parton-capability: <base64url JSON>`
(`encodeCapability` / `decodeCapability` in
`framework/src/runtime/capability.ts`). The entry decodes it into
`getCapability()` scope on every embed-flagged page render.
Empty/missing/malformed decodes to `{}`. Signed capability tokens are
filed in IDEAS.md; v1 is trust-the-network.

## Grants — the Paint tier

Trust is a payload constraint verified at splice time, not a property
of a route: any page can be embedded at any tier, and the grant
decides which rows survive. The capability carries a grant **set**
(`EmbedGrant`); v1 ships the **Paint** preset — pull-only server
output into framework-vetted components. Below the Client tier there
is **zero remote module loading**: the payload may reference only the
[vocabulary](#the-vocabulary), whose tags resolve entirely from the
host's own bundle.

```tsx
<RemoteFrame url="http://localhost:5181/remote/paint-summary" grant="paint" />
```

Under a grant:

- The host's tier rewriter (composed onto the one splice pipeline)
  drops every client-module import and re-audits every element row
  against the vocabulary table. Non-vocabulary rows **degrade, never
  block**: the row resolves to nothing, one structured
  `[parton] tier-violation {…}` line lands in the host log (deduped
  per distinct offense per splice), and in DEV a visible
  `<parton-tier-violation>` marker takes the element's place — prod
  degrades silently. The rest of the page keeps painting.
- The spliced content renders inside a **host-defined box** — a
  `<parton-embed-box data-grant="paint">` element the framework stamps
  with `contain: strict`. Size containment means content never sizes
  the box: the host MUST give it dimensions
  (`parton-embed-box { height: … }`). The Layout grant (future) is
  what drops `size` containment.
- The grant also crosses to the producer as the
  `x-parton-embed-grant` header — a statement, never the enforcement.
  The producer reads it with `getEmbedGrants()` (main barrel) to
  render its **embed-surface variant** — e.g. skip the app shell
  chrome that would otherwise degrade at the splice (see
  `e2e-magento/src/app/root.tsx`). The framework itself consults it
  the same way: a parton rendering under a vocabulary-constrained
  grant emits its body **bare** — no client boundary, no Activity
  parking, no placeholders, no snapshot registration (pull-only:
  nothing is independently refetchable). A match miss renders `null`.
- No capability values are implied — `grant` and `capability` are the
  two halves of the capability: what the render may READ vs what its
  payload may REFERENCE. v1 grants are unsigned trust-the-network
  declarations, like the capability bag.

## The vocabulary

The framework-shipped, framework-vetted component set a
vocabulary-constrained payload may reference. Server components — the
remote imports them from the deep path (deliberately not the main
barrel; names like `Text` are too generic to spray into the package
namespace):

```tsx
import { Stack, Row, Text, Heading } from "@parton/framework/lib/vocabulary.tsx"
```

Their rendered output is a closed set of reserved custom-element tags
with audited attributes — that tag grammar IS the ref encoding: a
remote's Flight row names a vocabulary component by tag, and the tag
resolves from the **host's** bundle (the `<VocabularyStyles/>`
stylesheet the host renders once). No module reference ever crosses.
The remote controls content, the host controls appearance, neither
controls the other's code (precedent: Shopify admin UI extensions).

v1 components and their full audited prop surfaces (everything else
is stripped — no `style`/`className`, no event props, no
`dangerouslySetInnerHTML` reachability; every tag also admits an
inert `data-testid`):

| Component | Tag              | Audited props                                                                                                                       |
| --------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `Stack`   | `parton-stack`   | `gap` (`none/xs/sm/md/lg`), `align` (`start/center/end/stretch/baseline`)                                                           |
| `Row`     | `parton-row`     | `gap`, `align`, `justify` (`start/center/end/between`), `wrap`                                                                      |
| `Box`     | `parton-box`     | `padding` (space scale), `tone` (`default/subtle/emphasis`)                                                                         |
| `Text`    | `parton-text`    | `size` (`xs/sm/md/lg`), `tone` (`default/muted/strong/positive/critical`), `align`                                                  |
| `Heading` | `parton-heading` | `level` (1–4; emits `role="heading"` + `aria-level`)                                                                                |
| `Image`   | `img`            | `src` (**absolute http(s) only** — relative would resolve against the host origin), `alt`, `width`, `height`, `loading`, `decoding` |
| `Divider` | `parton-divider` | —                                                                                                                                   |

The audit lives ONCE, centrally, in the `VOCABULARY` table
(`framework/src/lib/vocabulary.tsx`): the components serialize their
props through it (emit side) and the tier rewriter re-validates every
row against it (enforce side) — a hand-crafted payload gains nothing
the components couldn't emit. A bad attribute value drops the
attribute, never the element.

**Host styling.** The host renders `<VocabularyStyles/>` once
(hoisted + deduped) and themes via `--parton-*` CSS custom
properties, which inherit straight through the containment boundary:

```tsx
<VocabularyStyles />
<section style={{ "--parton-text-color": "rgb(190,24,93)", "--parton-gap-md": "14px" }}>
  <MagentoPaintSummary />
</section>
```

Interactive members (TextField, Form, Tabs, links) belong to the
Interactive grant — a later increment; Paint carries no interactivity
at all.

## Typed bindings

`yarn parton add <name> <origin>` fetches the remote's manifest and
generates per-page typed wrappers in the host repo:

```ts
import { remote } from "@parton/framework"
import type { PaymentCap } from "./types.ts"

export const MagentoPaymentSummary = remote<PaymentCap>({
  origin: "http://localhost:5181",
  path: "/remote/magento-payment-summary",
  namespace: "magento",
})
```

A binding is origin + **page path** + **grant set** (+ capability
type) — the grant is a property of the install, not of each call site
(`remote({ …, grant: "paint" })`). The `searchParams` prop appends to
the page URL, so a wrapper parton can drive the embedded page's
variant from a tracked read:

```tsx
<MagentoCheckoutStep searchParams={{ step }} />
```

`yarn parton update <name>` re-fetches; `list` / `remove` manage the
binding directories.

### The manifest

`createRscHandler`'s `remote` config serves the static metadata
endpoints (embedding itself needs no config — every page answers the
embed headers):

| Route                         | Body                                  |
| ----------------------------- | ------------------------------------- |
| `OPTIONS *`                   | CORS preflight (204)                  |
| `GET /__remote/manifest.json` | Embeddable-page inventory for the CLI |
| `GET /__remote/types.d.ts`    | Author-provided capability types file |

The manifest lists every addressable spec; a spec whose `match`
carries a **static pathname** (a literal URLPattern — no params, no
wildcards) advertises it as `path`, and the CLI generates bindings
only for those. A nested addressable parton with no page of its own
(reached via its parent page's trailer) advertises `path: null`.

## Frame navigation (navigating within an embed)

Composes from existing primitives — `<Frame>` opens a URL scope, a
wrapper parton reads it with a tracked `searchParam()` and threads it
into the binding's `searchParams`; client buttons navigate the frame.
The embedded page re-fetches with the new URL; the page URL and other
frames are untouched. See
[`frames-navigation.md`](./frames-navigation.md) — nothing here is
embed-specific.

## Module references (cross-origin)

Module references exist only on **ungoverned** (full-trust) embeds —
below the Client tier the tier rewriter drops every import row, so
none of the following applies to a granted frame.

Flight serializes client-component imports as module paths. Same
origin, the host bundle owns them — no rewrite. Cross-origin,
`moduleRefRewriter` rewrites relative paths (`./X.tsx`, `/X.tsx`) to
absolute URLs at the remote origin so the host browser can import
them; `/@fs/` + `/@id/` dev paths and bare specifiers are left alone
(both dev processes share a machine; see
[`../internals/page-embed.md`](../internals/page-embed.md) for the
table). In production the remote's hashed asset URLs are stable and
CORS on its JS assets lets the host browser load them.

## Embed economics

Measured 2026-07-13 on the prod preview build
(`e2e-testing/scripts/measure-embed-econ.mjs`; `/embed-econ` = 8
same-origin embeds of `/econ-item`, `/embed-econ-inline` = the same
content inline ×8; N=60):

|                      | inline ×8 | 8 embeds | unit page |
| -------------------- | --------- | -------- | --------- |
| server CPU / request | 16 ms     | 89 ms    | 7 ms      |
| document p50 (total) | 15 ms     | 65 ms    | 7 ms      |
| document p50 (TTFB)  | 11 ms     | 4 ms     | 5 ms      |
| document bytes       | 307 KB    | 839 KB   | 88 KB     |

Per embed hop: **~9 ms server CPU**, of which ~7 ms is the
producer's own whole-page render — the decode→re-encode splice itself
is ~2 ms at ~88 KB payloads. TTFB _improves_ with embeds (the host
shell streams while frames resolve); total wall, CPU, and bytes pay
for each embedded page's full body — including any app chrome the
embeddable page carries, ×N frames. The lever is authoring lean
embed surfaces, not the splice. If per-hop cost ever dominates, the
known escape hatch is byte-splicing the embedded rows into the host
stream (à la the cache's `spliceHoles`) instead of decode→re-encode —
measured, not yet warranted.

## Demos

- **`/embed-demo`** — embeds `/pokemon/1` (a full content page);
  `/embed-nested-demo` chains two levels; `/embed-self-demo` embeds
  itself (depth termination + per-level identity).
- **`/embed-duplicate-demo`** — the same page embedded twice; a label
  refetch fans out to both.
- **`/embed-refetch-demo`** — targeted refetch routing through
  `?partials=` at the embedded URL.
- **`/remote-frame-demo`** — five same-origin embeds of `/remote/*`
  pages: parallel streaming, client-component hydration, producer-side
  byte cache, selector refetch.
- **`/remote-frame-crossorigin-demo`** — embeds four `e2e-magento`
  pages (port 5181) via typed bindings, including a capability-scoped
  payment summary and a frame-navigated checkout step.
- **`/paint-tier-demo`** — two `e2e-magento` pages under
  `grant="paint"`: a vocabulary-only summary (host-themed via
  `--parton-*` custom properties) and a mixed page whose raw `<div>`
  and client component degrade in place (`paint-tier.spec.ts` also
  asserts zero non-image browser traffic to the remote origin).
- **`/embed-econ`** / **`/embed-econ-inline`** — the economics
  measurement surfaces.

## Related

- [`../internals/page-embed.md`](../internals/page-embed.md) — the
  slice pipeline: wire grammar, rewriter, identity, trailer.
- [`partial.md`](./partial.md) — the `parton` constructor.
- [`cache.md`](./cache.md) — caching options on embedded specs (the
  cache lives at the producer, not the host).
- [`../notes/remote-frame-arc.md`](../notes/remote-frame-arc.md) —
  the federation arc: the trust-tier table, bound cells, remoteCell
  (design; the Interactive/Layout/Style/Client/URL grants are later
  increments — Paint is shipped, above).
