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
  cells?: Record<string, ResolvedCell<unknown>>
}
```

| Prop         | Notes                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`        | The page URL to embed. Absolute URL (cross-origin) or same-origin path; relative paths resolve against the current request's URL.                                                                                                                                                                                                                                                      |
| `capability` | Host-declared values the embedded render can read via `getCapability()`. Flat record of JSON-serializable values; serialized as the `x-parton-capability` header and decoded into scope on the embed-flagged page render.                                                                                                                                                              |
| `namespace`  | Human name for this embed — a prefix on the minted **placement namespace**, so registry / wire ids read `magento~<hash>:…` instead of `e~<hash>:…`. Purely cosmetic: identity does not depend on it, the placement namespace disambiguates on its own. Set automatically by `parton add` bindings.                                                                                     |
| `grant`      | Trust grant for the embedded payload — a grant **set** (a bare name is the singleton set). Omitted = full trust: the payload splices as-is. Present = enforced at splice time by the tier rewriter; shipped grants are `"paint"` and `"interactive"`. See [Grants](#grants--the-paint-tier). Replayed on targeted refetch, so a placement can never re-fetch wider than it was placed. |
| `cells`      | Bound cells — the **inward** state contract. RESOLVED cells only, keyed by the names the remote's spec declares; the projected **values** cross with the embed request. See [Bound cells](#bound-cells--inward-state).                                                                                                                                                                 |

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

The `~` character is framework-reserved in id grammar; app ids must
not use it. The namespace deliberately excludes the URL's search
params, so a frame-driven embed (`?step=payment`) keeps one identity
while its content moves.

**Labels stay bare.** A parton's labels are its recorded reads — the
`cell:<id>` deps of the cells it resolved, and the names it passed to
`tag()` — and they register in the host's registry exactly as the
producer shipped them. Labels are class-level fan-out targets, so the
producer's own `refreshSelector("price")` keeps reaching every
embedded instance that read `tag("price")`; prefixing them host-side
would break precisely that. `namespace` scopes the placement's ids,
never its labels.

## Refetch — `?partials=` at the embedded URL

The embedded page's render registers its partons in the producer's
own registry, and ships them to the host as a `snapshots` trailer
entry after the Flight bytes (same `\xFF[parton:snapshots:N]` marker
grammar as the fp/url/settled entries — the segment splitter's
trailer map carries it, and commit-defer holds the host's commit open
until registration lands). Each snapshot registers in the HOST's
registry stamped:

```ts
source: { kind: "page", url, ns, capability? }
```

A wake that resolves to a page-sourced snapshot — a cell write, or a
`refreshSelector` whose `cell:`/`tag:` selector matches a dep the
embedded render recorded — re-embeds the page with the ordinary
protocol: a page GET at the **embedded URL**
with `?partials=<id>` plus the embed headers, replaying the stored
placement namespace and capability. The producer answers a _focused_
render: it reconstructs just the target(s) from its own registry (the
same isolated-render path a local lane takes) and ships a fresh
trailer. A registry miss on the producer falls back to the whole
page — over-fetch, never fail.

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
  async function MagentoPaymentSummaryRender(_: RenderArgs) {
    const cap = getCapability()
    // …
  },
  {
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

## Bound cells — inward state

State crosses the boundary **inward as bound cells, never ambient**:
the remote's spec declares requirements, the host binds explicitly at
the call site, and the projected **values** cross with the embed
request. Nothing crosses without appearing in the host's source; the
remote never sees a session token, a cell handle, or the host's
storage — it sees values.

The remote declares its requirements on the spec (`cells` — the
manifest advertises them):

```tsx
// Remote (e2e-magento) — /remote/cart-note
const MagentoCartNote = parton(
  async function CartNoteRender(_: RenderArgs) {
    const { cart, locale } = getBoundCells() // exactly the declared names
    // …
  },
  {
    match: "/remote/cart-note",
    cells: { cart: { required: true }, locale: {} },
  },
)
```

The host resolves its cell **in the parton body** and binds the
resolved view:

```tsx
// Host
const cart = await hostCart.resolve() // the read IS the dependency
;<MagentoCartNote cells={{ cart }} />
```

The contract:

- **Resolved cells only.** `cells` takes `ResolvedCell`s — the
  in-body `await cell.resolve(args)` that produced one is what records
  the partition-scoped `cell:` dep on the ENCLOSING parton. A
  host-side write therefore moves that parton's fp, re-runs its body,
  and the re-embed projects fresh values — re-projection is the
  ordinary dep machinery, no new subscription. Passing an unresolved
  handle or `.with()` binding throws with the fix (resolving inside
  the frame could not record the dep, which would be silent
  staleness).
- **Values ride the request body.** Bindings make the embed fetch a
  POST (`x-parton-embed-cells: 1`, JSON body `{cells: {name: value}}`)
  — projected values may be arbitrarily large, and header lines have
  hard ceilings. Without bindings the fetch stays the ordinary GET.
- **The declaration is the runtime enforcement.** On an embed render,
  a missing `required` binding **throws before the body runs** — the
  explicit produce-side failure surfaces at the host placement's
  boundary as the parton's error card (the page around it keeps
  working). An UNDECLARED binding never crosses `getBoundCells()`.
  Standalone visits of the page enforce nothing and read `{}` — an
  embeddable page stays browsable by itself.
- **Refetch re-resolves, never replays.** The placement's snapshot
  source stamps each binding's cell id + partition; a targeted refetch
  re-resolves them against CURRENT storage, so a focused re-embed
  always projects the live host value.
- **Typegen is deferred DX.** gql.tada-style typed bindings generated
  from the manifest's `cells` inventory are the planned DX layer; the
  runtime declaration above is the load-bearing contract.

Worked example: `/bound-cells-demo` (host) embedding e2e-magento's
`/remote/cart-note`, spec `e2e/bound-cells.spec.ts`.

## Grants — the Paint tier

Trust is a payload constraint verified at splice time, not a property
of a route: any page can be embedded at any tier, and the grant
decides which rows survive. The capability carries a grant **set**
(`EmbedGrant`); shipped presets are **Paint** — pull-only server
output into framework-vetted components — and **Interactive** (below).
Below the Client tier there is **zero remote module loading**: the
payload may reference only the [vocabulary](#the-vocabulary), whose
tags resolve entirely from the host's own bundle.

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

**The worked example — the embassy district.** The website world
(`website/src/app/world/embassy-*.tsx`) ships the forcing caller, one
chunk west of the origin: an embassy building whose bulletin is
`<RemoteFrame url="/embassy/bulletin" grant="paint">` — the app
embedding one of its own pages. `/embassy/bulletin` is an ordinary
page (the world page's match carves out `/embassy`, so the body
carries the bulletin alone — the lean-embed-surface verdict), authored
against the vocabulary plus one deliberate raw-HTML row: contraband
that renders standalone but degrades at the border, captioned in-world
by the building's plaque. The world themes the splice via `--parton-*`
custom properties on `.embassy-building`. `website/validate-embassy.mjs`
proves the exhibit end-to-end: standalone browsability, splice into
the contained box, the custom-property handshake (the spliced heading
wears a violet the standalone page doesn't), contraband dropped
(dev-marker / prod-silent, structured log line in both), district tint,
world hygiene.

### The Interactive grant

`grant="interactive"` is Paint's constraints **plus** the vocabulary's
interactive members — components that bind to **cells and actions the
remote hosts**. The wire stays set-shaped: an interactive tag carries
audited attributes NAMING a cell or action (never a module ref, never
a Flight action id — the tier rewriter strips those below the Client
tier), and the **host-bundle interaction bridge** — a client component
`RemoteFrame` mounts inside the embed box — wires the behavior by DOM
delegation. The remote decides WHAT is writable/invocable; the host's
own bundle owns the code that does the writing.

```tsx
// Remote — the page binds ITS cells/actions:
const qty = await qtyCell.resolve()
<TextField cell={qty} label="Quantity" />
<Button action="place-bid">…</Button>

// Remote — the invocable surface is an explicit registry:
embedAction("place-bid", async () => {
  await bidCell.update((v) => v + 50)
})

// Host — the install carries the grant:
<RemoteFrame url="…/remote/interactive-panel" grant="interactive" />
```

The pieces:

- **Action refs are namespaced to the remote origin structurally**:
  a tag carries only the bare name; the bridge posts it to the origin
  the placement was spliced from (`POST /__remote/actions/invoke`), so
  a payload can never route an invocation to a third origin. The
  invocable surface is exactly the producer's `embedAction` registry —
  unknown names 404; an action's optional `guard(capability, payload)`
  refuses with 403 before the handler runs.
- **Cell writes ride the ordinary pipeline.** A `TextField` edit POSTs
  `{cell, partition, value}` to the remote's `/__remote/cells/write`:
  shape validation, `write` canonicalisation, and the cell's
  **`writeGuard`** all run — the guard composes with the capability
  (`getCapability()` resolves the presented bag), so _who may write_
  stays a property of the cell. Every bridge POST carries the
  placement's capability header.
- **Optimistic self-echo is mandatory** — writes cross a network hop
  and the UI must not wait. A `TextField`'s `<input>` is UNCONTROLLED
  (the DOM is the optimistic value, shown at keystroke); writes flush
  through a per-cell single-inflight, replace-coalescing queue (the
  `useCell().input()` discipline); a `Button` holds `data-pending`
  for the hop. The SERVER echo is one coalesced self-refetch after the
  queue drains: the bridge forces the enclosing host parton's
  effective id (the framework-internal id-forcing protocol), that
  parton re-renders, and the fresh remote render replaces the spliced
  content in place.
- **Authoring rule:** an interactive embed must sit inside a **host
  parton** — its effective id is the echo's refresh target, and
  outside one the bridge throws its wiring error rather than dropping
  the echo. The bridge stamps `data-interactive-ready` on its wrapper
  once its listeners are live (the embed's DOM streams in before the
  bridge hydrates) — the explicit signal specs and tools wait on.
- Under a plain Paint grant the SAME interactive rows **degrade in
  place** like any non-vocabulary row — a placement's grant, not the
  payload, decides interactivity.

Worked example: `/interactive-tier-demo` (host) embedding
e2e-magento's `/remote/interactive-panel` under both grants, spec
`e2e/interactive-tier.spec.ts`.

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

Interactive members — admitted only when the placement's grant set
holds `interactive` (the audit table marks them `grant:
"interactive"`); under plain Paint they degrade like any
non-vocabulary row:

| Component   | Tag                          | Audited props                                                                                                                                                                                  |
| ----------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TextField` | `parton-textfield` + `input` | wrapper: `cell-id`, `cell-partition` (explicit partition JSON), `label`; inner input: `name`, `type` (`text/number`), `defaultValue` (the uncontrolled optimistic value), `min`, `max`, `step` |
| `Button`    | `parton-button`              | `action` (bare `embedAction` name — the bridge namespaces it to the placement's origin), `payload` (opaque JSON the producer's handler validates)                                              |

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

Paint itself carries no interactivity at all — the interactive members
above exist only for placements granted `interactive`. Further members
(Form, Tabs, links) join the table as real embed surfaces need them.

## remoteCell — outward state

State crosses the boundary **outward as remoteCell**: a remote
PUBLISHES a cell, and a host process holds a read-only handle whose
freshness rides the same doorbell contract the in-process bridge seam
uses (`setInvalidationBridge` — the seam's second caller). The store
is the truth; the remote's process is that store's edge.

```ts
// Remote — publication is opt-in per cell:
export const magentoBid = localCell({
  id: "magento.bid",
  shape: "number",
  initial: 100,
  publish: true, // or (capability) => boolean — per-caller authorization
})

// Host — a read-only handle on the remote's cell:
const bid = remoteCell<number>({
  origin: "http://localhost:5181",
  id: "magento.bid", // the remote's wire id — selector identity crosses verbatim
  initial: 0,
  capability: { tier: "gold" }, // presented on attach + every read
})

// Host parton — an ordinary read; the dep records like a local cell's:
const current = await bid.resolve()
```

The contract:

- **The attach is a server-to-server wake subscription.** On the
  handle's first resolve the host POSTs
  `/__remote/cells/attach` (`{cells: [ids]}` + the capability header)
  and holds the NDJSON response: one `{selectors: […]}` line per
  committed bump batch on the remote — `cell:<id>?<partition>`
  strings, **doorbells, never values**. Auth is per cell against its
  `publish` declaration; any unpublished (or unknown — existence is
  not disclosed) id refuses the whole attach with 403.
- **A doorbell drops, re-emits, and lets the read pull.** The host
  transport drops its cached row(s) for the named partitions, then
  re-emits the batch through `deliverInvalidationBumps` — the bridge
  seam's ordinary inbound path (fresh local ts, wake-index delivery),
  so every host parton whose recorded deps name the cell re-renders,
  held connections laning it live. The re-render's `resolve()` misses
  the dropped row and the handle's loader GETs
  `/__remote/cells/value?cell=<id>&args=<json>` — the value-read
  path. Values are fetched only when something actually re-reads
  them; a doorbell nobody renders costs one dropped row.
- **Failure degrades, never corrupts.** A torn attach stream
  reconnects with backoff (batches missed while down degrade to the
  next doorbell). A 403 is permanent for the handle (its capability is
  fixed at construction): logged once, reads fail explicitly.
- **Read-only.** Writes belong to the owning process — reach them
  through an interactive embed's actions/cell writes, or an app-level
  API. The handle is deliberately NOT in the host's cell registry
  (the id names the REMOTE's cell).
- The manifest advertises publications (`publishes: [ids]`); the
  attach/value endpoints exist only when the producer configures
  `remote: { name }` on `createRscHandler`.

Worked example: `/remote-cell-demo` (host) reading e2e-magento's
`magento.bid` live across the two dev processes, spec
`e2e/remote-cell.spec.ts`.

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

The manifest lists every spec; a spec whose `match` carries a
**static pathname** (a literal URLPattern — no params, no wildcards)
advertises it as `path`, and the CLI generates bindings only for
those. A nested parton with no page of its own (reached via its
parent page's trailer) advertises `path: null`. Each spec also
advertises its bound-cell requirements (`cells` — the declaration the
host binds against), and the manifest's top-level `publishes` lists
the ids of every cell the app publishes across the boundary (the
remoteCell inventory).

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
- **`/embed-duplicate-demo`** — the same page embedded twice; a tag
  bump fans out to both.
- **`/embed-refetch-demo`** — targeted refetch routing through
  `?partials=` at the embedded URL.
- **`/remote-frame-demo`** — five same-origin embeds of `/remote/*`
  pages: parallel streaming, client-component hydration, producer-side
  byte cache, tag-driven refresh.
- **`/remote-frame-crossorigin-demo`** — embeds four `e2e-magento`
  pages (port 5181) via typed bindings, including a capability-scoped
  payment summary and a frame-navigated checkout step.
- **`/paint-tier-demo`** — two `e2e-magento` pages under
  `grant="paint"`: a vocabulary-only summary (host-themed via
  `--parton-*` custom properties) and a mixed page whose raw `<div>`
  and client component degrade in place (`paint-tier.spec.ts` also
  asserts zero non-image browser traffic to the remote origin).
- **`/interactive-tier-demo`** — e2e-magento's interactive panel under
  `grant="interactive"` (quantity TextField → the remote's cell; bid
  Button → the remote's `place-bid` embedAction) and the SAME page
  under `grant="paint"`, its interactive rows degraded.
- **`/bound-cells-demo`** — a host cart cell bound into
  `/remote/cart-note` (`cells={{cart}}`); a host-side write
  re-projects the embed; a sibling placement with no binding shows the
  produce-side required-cell failure at its own boundary.
- **`/remote-cell-demo`** — a read-only `remoteCell` on e2e-magento's
  published `magento.bid`: a write committed in the remote process
  lands on the host page live (doorbell → value re-read → held-stream
  lane).
- **The embassy district** (website world, west of the origin) — the
  in-world Paint-tier exhibit: a self-embed of `/embassy/bulletin`
  under `grant="paint"`, world-themed, with a contraband row degraded
  at the border. See the worked example above;
  `website/validate-embassy.mjs` is its gate.
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
