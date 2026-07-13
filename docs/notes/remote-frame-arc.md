# RemoteFrame — the federation arc

> Design note, 2026-07-13. The consolidated design for federation:
> multiple parton apps composing across trust boundaries — and, by
> the same seam, multiple processes of one app. Synthesizes the
> page-embed spike (`feat/remoteframe-fullpage`, design detail in
> `remote-frame-iframe.md` on that branch), the cross-process bus
> prototype (`feat/multi-process-harness`), and the capability-tier
> design work. Where this contradicts
> [`remote-frame-design.md`](./remote-frame-design.md), this note
> wins; that note's numbered sections remain the detail backlog for
> the increments below.

## The thesis

The unit of federation is an ordinary page. Trust is a payload
constraint verified at splice time, not a property of a route.
State crosses the boundary as cells — explicitly bound inward,
subscribed outward. A bump is a doorbell, never a payload; the
store is the truth. Federation across origins and fan-out across
processes are the same primitive at two trust levels, attached to
the same seam.

## The unit: ordinary pages

There is no special route. A `<RemoteFrame>` pointed at a page URL
fetches that page as Flight (`x-parton-render` header — the URL
stays the page URL), the producer's `PartialRoot` sees the
embed-depth header and emits the app tree inside an explicit slice
marker instead of the page shell, and the host slices with a
row-local `RowRewriter`: unwrap the marker and the `html`/`body`
singletons, drop `head`/`title`/`meta`/`link` and hint rows. The
response is ordinary segmented Flight, so `splitSegments` carries
the trailer map (snapshots registration rides the same path as
today's parton kind). Recursion terminates on a depth header with
an inert marker, never a throw (thrown-rejection containment is
timing-dependent).

Consequences:

- **`/__remote/<id>` dies.** An app exposing one parton publishes a
  page whose route renders just that parton — addressable,
  cacheable, navigable, testable in a browser by itself.
- **Refetch inside an embed is `?partials=` at the embedded URL** —
  the ordinary protocol, no parallel surface.
- **Frame navigation over an embed** is `<Frame>` composition with
  a page URL; nothing new.
- An **embeddable page** is an ordinary page with a constrained
  diet — authored against the vocabulary (below) so it survives a
  low-tier splice. Remotes author dedicated embed surfaces the way
  Shopify apps author UI-extension surfaces, separate from their
  own full app shell.

## Trust: tiers as payload constraints

The tier is a property of the **payload**, verified at splice time
— not of the endpoint. Any page can be embedded at any tier; the
grant decides which rows survive. Enforcement is composed
`RowRewriter`s on the one splice pipeline (the shipped
head/meta/hint strip is tier zero, already in code). The capability
carries a **grant set**, not a ladder — Layout-without-Style and
Interactive-without-Layout are both coherent; the names below are
the useful presets.

| Grant | The payload may | Containment / enforcement |
|---|---|---|
| **Paint** | Reference only the framework vocabulary (server output into vetted components). | Host-defined box, `contain: strict`. Non-vocabulary element types and module refs are rewritten out. Pull-only; no interactivity crosses. |
| **Interactive** | Bind vocabulary client components (TextField, Form, Tabs, links) to cells and actions the remote hosts. | Same vocabulary rule; action refs are namespaced to the remote origin and authorized by the capability. Optimistic self-echo is mandatory (writes cross a network hop). |
| **Layout** | Size intrinsically — participate in the host's flow layout. | Precisely: drop `contain: size`, keep `contain: layout paint` (fixed-position escapes stay trapped). Backstop is host `min/max-*` bounds — constrain, never determine. Blast radius: reflow/CLS, bounded. |
| **Style** | Ship its own CSS. | CSS files proxied through the host origin (perf, privacy, and the enforcement point). Isolation candidate: declarative shadow DOM (spike pending — see unknowns); host styles reach inward via `adoptedStyleSheets`, theming via custom properties. |
| **Client** | Load its own client modules into the host realm. | No isolation — organizational trust (distributed architecture, sibling teams). The framework provides coherence, not sandboxing: shared-externals contract (React, the client runtime), version-skew handling, asset proxying, cross-origin HMR. For genuinely untrusted client code the answer is an iframe, not RemoteFrame. |
| **URL** | Follow the host's URL — route on a projection of the host request. | The request mask (below). |

The technical gradient underneath the trust gradient: **below
Client tier there is zero remote module loading.** Vocabulary
components are framework-shipped and resolve from the host's own
bundle; the remote only emits refs. The entire cross-origin module
problem (CORS on assets, two Reacts, HMR across origins) is
confined to the Client tier, where the trust level already assumes
coordination.

Violation policy (a low-tier splice meets a non-vocabulary row):
leaning **degrade + loud telemetry** — resolve to nothing, log a
tier violation, surface in the dev overlay — matching the
framework's degrade-never-block posture. Open decision; see
unknowns.

## The vocabulary

A framework-shipped, framework-vetted component set (stack/layout
primitives; form fields; Tabs/Accordion/links at the Interactive
grant). Vetted means the prop surface is audited once, centrally:
no `style`/`className` passthrough, sanitized `href` schemes, no
`dangerouslySetInnerHTML` reachability. The host styles the
vocabulary with CSS (custom properties / parts) — the host controls
appearance, the remote controls content, neither controls the
other's code. Precedent: Shopify admin UI extensions.

## The URL grant: dimensionality across the boundary

The remote's dimensionality is not declared by hand — the framework
already computes it. It is published across the boundary with the
same two-part structure it has in-process:

- **Declared**: the manifest advertises each embeddable page's
  compiled match signature (`match.ts` signatures are stable and
  serializable) — skip-safe from the first render.
- **Observed**: each snapshot returns the recorded read-set as a
  trailer, so the host learns true per-URL dimensionality after one
  render — the fp-trailer contract crossing the boundary.

One inversion at the trust line: in-process the cold gate errs
toward over-fetching; across a boundary over-*forwarding* is a
privacy leak, so the default flips — the host forwards only what is
granted, and an ungranted read resolves to `null`.

The host declares the grant as a **mask** at the call site:

```tsx
<RemoteFrame url={remote} capability={cap}
  request={{ match: "/p/:path", searchParams: ["variant"], cookies: [] }} />
```

The projection of the host request through mask ∩ manifest is
everything the remote sees — and it is the host's **byte-cache key**
for the remote snapshot. Bounding is two tools for two problems:
the mask bounds *which* dimensions can exist (a remote can never
make the host vary on an ungranted cookie); the existing byte-cache
LRU bounds *how many values* an unbounded dimension like `:path`
produces — exactly as the host's own pages are bounded. A match
miss **parks** the remote frame, cached variant preserved — local
parton semantics, evaluated host-side against the projected
request. Inside a `<Frame>`, the projection applies to the
frame-resolved request; the frame chain already owns that.

This is the third boundary contract with the identical shape —
remote declares requirements, host grants a subset, the
intersection is enforced at splice time. Cells, vocabulary, request
dimensions: same pattern.

## State across the boundary

**Inward — bound cells, never ambient.** The remote's manifest
declares requirements (`requires cart: CartShape, optional
locale`); the host binds explicitly at the call site
(`cells={{cart: cartCell}}`). Nothing crosses without appearing in
the host's source; the host's placement records the dep, so a
cartCell bump re-projects the remote's inputs. The remote never
sees a session token — it sees bound values. Typed bindings are
generated gql.tada-style from the manifest: the manifest is
enforced at runtime (load-bearing), the typegen is DX only — never
correctness-bearing static analysis.

**Outward — remoteCell.** A remote publishes a cell; the host
attaches to the remote's channel as an ordinary wake subscriber
(`cell:<id>?<partition>` — the wake index doesn't care that the
subscriber is a server) and re-emits deliveries into its own
registry, so host partons that read the remoteCell re-render. The
envelope protocol, acks, and subscription model exist; the new work
is server-to-server attach + capability auth.

**The bridge seam.** `setInvalidationBridge` (prototyped on
`feat/multi-process-harness`) is the single seam with two callers:
the same-trust broker bus (processes of one app) and the
cross-trust capability-authorized channel attach (remoteCell).
Design it once for both. Solving remoteCell solves horizontal
fan-out; they differ only in what crosses uninspected.

## Consistency: the store is the truth, the bus is a doorbell

1. **The shared store is the sole authority for values, per key.**
   Each key's writes are ordered by the store itself. Values never
   travel on the bus.
2. **Bumps are at-least-once, unordered notifications, published
   only after the write is visible in the store.**
   Publish-after-commit is the only ordering the bus needs: bumps
   are idempotent (a duplicate or late bump triggers a re-read and
   an fp compare — wasted re-render at worst, never wrongness).
3. **Fingerprints and caches are process-local; cross-process
   movement degrades to over-fetch, never stale.** A failed-over
   client's fps mismatch and re-render fully — the cold-record-gate
   posture extended across processes.
4. **`atomic()` is one store commit plus one bump batch.**
   Cross-process contention is per-key last-writer-wins by default;
   where that's wrong (bidding), `cell.update(fn)` is a
   compare-and-retry read-modify-write at the store level. No
   general cross-process transactions.

The bus transport can stay trivially simple (at-least-once,
after-visibility); the correctness burden lands on the per-key
storage adapter — which is also the research→PoC gating item (see
[`research-to-poc.md`](./research-to-poc.md)).

## Identity: placement-scoped prefixing

Namespace prefixing (shipped for the parton kind) solves cross-app
collisions but not two placements of the same remote in one host
page, nor self-embedding (the spike's hydration finding). The fix
is the same mechanism with a finer key: fold the host's ambient
parton path — unique per placement, already available — into the
prefix. Per-placement ids fix self-embed hydration, disambiguate
duplicate embeds, and give `?partials=` refetch an unambiguous
target.

## Time: deadlines and staleness

`deadline="300ms"` is a **host-side race** against the remote's
first snapshot commit — never a promise the remote enforces. On
loss, render the fallback; the second knob is the on-late policy:
`swap` (content streams in when it arrives — lanes already love
late arrival) or `drop` (strict budget). Remote snapshots are
spliceable bytes, so deadline composes with
serve-stale-while-revalidate from the byte cache: cached remote
paints instantly, fresh streams behind. Per-frame policy — a
marketing widget wants stale-ok, a payment form wants `noStale`.

## What survives / adapts / dies

Delta to the spike doc's table, after the tier decision:

- `GET /__remote/<selector>` and `createRemoteHandler`'s render
  wrapper — **die** (pages + the embed branch of `PartialRoot`).
- `remote()` typed binding — **adapts**: origin + page path +
  grant set + required cells.
- Manifest — **adapts**: an inventory of embeddable pages with
  their tier claims, dimensionality, and cell requirements
  (candidate: `/.well-known/parton.json`). Tier claims are DX; the
  rewriter is the enforcement.
- Flight row rewriting, snapshot trailer, `deferCommitUntil`,
  `credentials: "omit"` — **survive** unchanged; the tier system is
  more rewriters on the same pipeline.

## Known unknowns

- **Violation policy** — silent drop vs visible marker vs
  dev-loud/prod-silent for non-vocabulary rows. Decide deliberately
  before the vocabulary ships.
- **Declarative shadow DOM × Flight/SSR/hydration** — decides
  whether the Style tier is cheap or a style-delivery subsystem.
  Spike, don't debate.
- **Embed economics** — decode→re-encode per hop, per-embed
  fetches. Measure on a many-frame page; byte-splicing (à la
  `spliceHoles`) and same-origin batching are the known escape
  hatches if it matters.
- **Wire compatibility** — deliberately postponed; the wire is
  unstable for a while. Discipline in the meantime: keep the
  inventory of boundary-crossing grammars current (selector
  grammar, snapshot-trailer markers, embed marker + headers,
  manifest schema, capability encoding, bus line protocol) so
  versioning later is a checklist, not archaeology.

## Increments

1. **Same-origin page embed** — the spike; landed on
   `feat/remoteframe-fullpage`.
2. **Identity + refetch routing** — per-placement id
   discrimination; snapshots trailer on embed-flagged page
   responses; `source: {kind: "page", url}` refetch.
3. **Bridge seam + storage adapter** — `setInvalidationBridge`
   designed for both callers; per-key store with
   publish-after-commit and `cell.update(fn)`. (Shared spine with
   research→PoC.)
4. **Vocabulary v1 + Paint tier** — the vetted component set, the
   tier rewriter, capability decode on embed-flagged page renders
   (`runWithCapability` on the page path), violation policy.
5. **Interactive tier + bound cells + remoteCell** — manifest cell
   requirements, explicit binding, server-to-server attach.
6. **URL grant** — mask ∩ manifest, projection cache key,
   park-on-miss, observed-read-set trailer.
7. **Style + Client tiers, cross-origin** — shadow DOM spike
   verdict, shared-externals contract, validated against a real
   second origin (`e2e-magento` builds).

The demo thread that forces each increment in order: an **embassy
district** in the world — a paint-only remote region, an
interactive one with a bound cart cell, one that follows the host
URL, and one that misses its deadline on purpose.
