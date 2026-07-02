# RemoteFrame — open design questions

> Captured 2026-05-17 from an extended design conversation; shipped-
> state list and terminology refreshed 2026-07-02. Snapshots
> the open questions and tentative directions for `<RemoteFrame>`
> beyond what's shipped today. Pick up by reading the current state in
> [`docs/reference/remote-frame.md`](../reference/remote-frame.md),
> then walking this doc's sections in roughly the priority order at
> the bottom. Every section is an open direction — parked, not dead.

## What's shipped

- `<RemoteFrame url capability? namespace?>` — streams Flight
  bytes from a remote endpoint, decodes, registers snapshots, stitches.
  (No `parent` prop — the ambient parton flows through server
  context, like any other placement.) Always streams; trailer arrives
  at end-of-stream and lands before host commit via `deferCommitUntil`.
- `remote<Cap>({ origin, selector, namespace })` typed binding factory.
- `parton add|update|remove|list` CLI that installs bindings into the
  host repo under `src/remote/<name>/`.
- Manifest (`/__remote/manifest.json`) + types file (`/__remote/types.d.ts`)
  + per-spec Flight endpoint (`/__remote/<selector>`) via
  `createRemoteHandler`.
- Namespacing: every id + label from a remote is prefixed with the
  install name (`magento:stocks`), preventing collisions across
  remotes and making selectors self-describing.
- Cross-origin selector-refetch routing via `snap.source.{origin,
  remoteId, capability}` — nested addressable partials route correctly
  on the very first render. (Same-origin remotes skip the `source`
  stamp: the host has the spec in its own catalog, and the local
  Component path is strictly faster than a fresh RemoteFrame fetch.)
- Capability scoping: host-declared values reach the remote via
  `x-parton-capability` header; remote sees nothing else (no cookies,
  no host URL, `credentials: omit`).
- `<Frame>` + parton + RemoteFrame composes for per-frame navigation
  inside a remote without reloading the host or affecting other frames.

## The meta finding: the host↔remote contract

`capability` today is a flat record of values the host passes at
render time. Once you look at real installations, that one field
splits into three with different lifecycles + trust models:

| | Lifecycle | Set by | Trust model |
|---|---|---|---|
| **Permissions** | Per-install | User (at install) | Remote DECLARES what it needs; user grants |
| **Config** | Per-placement | CMS author | Authored content stored at host or remote |
| **Resolution** | Per-render | Host spec code | Wire from session/URL/lookup to declared shape |

Almost every open question below is a different cut on this same
split. Worth deciding the wire shape for permissions + config before
building each piece — once those land, the rest (caching, batching,
auth) compose on top.

## Section 1 — Permission declarations + install flow

**Question.** How does a remote spec declare what data it needs from
the host, so the host's user can grant permission at install time?

**Tentative shape.** Capability upgrades from a structural type to a
runtime declaration that ships in the manifest:

```ts
parton(Render, {
  selector: "magento-payment-summary",
  capability: {
    type: "PaymentCap",
    fields: {
      cart_id:  { description: "Active cart identifier" },
      currency: { description: "Display currency code" },
      total:    { description: "Pre-tax total" },
    },
    reason: "Renders payment options from cart contents.",
  },
})
```

Manifest carries this. `parton add` shows the requested permissions
in the CLI; in-CMS install shows a dialog and persists the grant
per-(install, user). Declaration is the contract; the host's spec
author still decides where the actual values come from at render
time (session lookup, backend call, URL param).

**Open:**
- Where does the install decision live? Per-install in CMS storage
  (app-store model) or developer-accepts-at-build-time (npm-install
  model)? Different UX.
- How is a denied permission represented? Render-time error, fallback
  UI, or skip-the-RemoteFrame-entirely?
- Optional vs required fields — does the remote ship partial-render
  paths for missing optional capabilities?

**Depends on / unlocks**: this design ripples through auth (section 7),
config (section 2), caching (section 3). Probably should land first.

## Section 2 — Block-shape configuration at injection site

**Question.** A CMS author drops a remote block into a slot and sets
"show these stock symbols". The config lives at the placement; the
remote receives it on each render. How?

**Tentative shape.** Remote spec authored with a `schema` (using
`cms.text(...)` etc.). Manifest carries a serializable form of the
schema. CLI emits a `block()` wrapper alongside the `remote()` one:

```ts
// generated when the remote declares a schema
export const MagentoStocksBlock = block(
  ({ symbols }) => <MagentoStocks searchParams={{ symbols }} />,
  {
    selector: "magento-stocks",
    schema: ({ cms }) => ({
      symbols: cms.text("symbols", "Symbols to show"),
    }),
  },
)
```

CMS author places `MagentoStocksBlock`, edits `symbols` in the editor,
content stored in the host's CMS. Host passes the value to the remote
at render via `searchParams` or a dedicated `config` prop.

**Open:**
- Config wire shape: `searchParams` (URL-visible, cacheable) or a
  separate `config` prop in the capability header (cleaner separation,
  harder to cache by URL)?
- CLI output: emit BOTH the raw `MagentoStocks` and `MagentoStocksBlock`
  for schema-having remotes, or only the block?
- Schema in the manifest: how do you serialise `cms.reference(slot)` or
  `cms.blocks(...)` — fields whose meaning depends on the host's slot
  catalogue?
- Where is the config STORED — host's CMS (default) or could it round-
  trip to the remote (so the remote owns its config storage)? See
  section 11.

**Depends on**: schema serialisation needs the host + remote to share
a CMS field type vocabulary.

## Section 3 — fp-skip before reaching the remote

**Question.** When the remote's inputs haven't changed, don't even
hit the remote.

**Tentative shape.** Wrap the binding in a parton whose body reads
the inputs through tracked hooks (`searchParam()` + a capability
hash) — the reads fold into its fingerprint automatically — plus
`cache: { maxAge }`. The framework's cache primitive already handles
fp-based skip — if the wrapper's fp matches a cached entry, the cache
replays bytes and the RemoteFrame inside never gets called.

The CLI could emit bindings pre-wrapped in such a parton, reading the
obvious inputs, with a conservative default cache (short maxAge or
dedup-within-request).

**Open:**
- Cache-by-default for every binding, or opt-in? Commerce caching has
  real correctness gotchas (stale inventory, stale prices).
- Per-user capability values mean cache entries don't cross users. Is
  that obvious enough that authors won't accidentally over-cache?
- Capability fold into the cache key needs a stable hash — capability
  serialisation already handles that for the wire, reuse here.

**Depends on**: nothing critical — could ship today as a binding-level
opt-in.

## Section 4 — Same-origin batching

**Question.** A page has three `<MagentoFoo>`, `<MagentoBar>`,
`<MagentoBaz>` placements. Today that's three fetches to the same
origin.

**Tentative shape.** Per-request batch queue keyed by origin:

- Each RemoteFrame placement registers `{selector, capability, resolve}`
  in the queue, awaits one microtask.
- After queue settles, one `GET <origin>/__remote/?ids=a,b,c` fires.
- Per-id capabilities ship in an envelope (`x-parton-capabilities:
  { id: cap, ... }`).
- Response is multi-payload — length-prefixed sections, one per id.
- Host splits the response, fans out per-id Flight bytes + snapshot
  trailer to each waiting placement.

Single-placement renders skip the batching window (no siblings
coming) — restores today's single-fetch shape.

**Open:**
- Per-id error contract in the response — one bad spec must not fail
  the batch.
- Microtask window adds latency to the always-batched case; can be
  tuned (sync-only batching for placements visible in the same render
  tick).
- Per-id capabilities mean the request header can get large. HTTP/2
  HPACK helps; HTTP/1.1 might choke on huge headers.

**Depends on**: wire-shape of capability (section 1) — batched
header format reuses the same encoding.

## Section 5 — Failure UX end-to-end

**Question.** What does the user see when a RemoteFrame fails? Remote
500s, timeouts, malformed trailer, network drop mid-stream, capability
rejected, remote spec throws.

**Today.** `RemoteFrame` throws `Error("RemoteFrame: fetch failed
for <url> (status N)")`. `PartialErrorBoundary` catches and shows its
default red card. No retry semantics, no degraded modes.

**Tentative shape.**
- Per-RemoteFrame `fallback` prop (`React.ReactNode`) for the
  PartialErrorBoundary's inline-error path.
- A typed error category mirroring `NavigationError`: `RemoteFrameError`
  with `kind: "fetch" | "decode" | "capability" | "timeout"` and the
  underlying cause.
- Retry policy via an optional prop (`retry: { attempts, backoffMs }`)
  with circuit-breaker semantics (after N failures, fall through to
  fallback for a cooldown window).
- Degraded-mode contract: the binding can ship a `fallback` component
  that's pure-host (renders without the remote's data) for the
  "remote is dead" case. Useful for commerce ("show cart, hide
  payment options").

**Open:**
- Should fallbacks for cross-origin remote outages live with the
  binding (host repo) or be authored by the host's app developer per
  placement? Both have value.
- Timeout default — none today. Reasonable production default? 10s?
  Configurable per-binding?
- Error surface in the manifest — does the remote declare its
  expected failure modes (rate-limit codes, auth-required codes) so
  the host can map them to specific UX?

**Depends on**: nothing — could ship today as a refinement of the
existing error-throw path.

## Section 6 — Auth + signed capability tokens

**Question.** Today's capability header is trust-the-network: the
remote believes whatever's in `x-parton-capability`. For real
third-party deployments the remote needs to verify the host's
claims (this cart-id actually exists, this user actually owns it).

**Tentative shape.** HMAC-signed (or asymmetric) tokens with
expiration + issuer claim:

- The host's install flow obtains a signing key from the remote (or
  vice-versa for asymmetric).
- Each capability payload is signed before going over the wire.
- The remote verifies + decodes; rejection returns 401 with a typed
  error the host's RemoteFrame surfaces.
- Per-install key rotation; expirations short enough to limit blast
  radius from a leaked key.

**Open:**
- JWT vs PASETO vs custom HMAC — team taste. PASETO sidesteps the
  JWT footguns (alg confusion, none algorithm) but is less ubiquitous.
- Key storage: per-install secret in CMS storage (encrypted at rest)?
  Process env (per-deployment)? Both?
- For "Adobe-vetted module in a trusted deployment" the signing
  overhead is wasted ceremony. Opt-in per binding (binding declares
  `auth: "signed" | "trust-network"`)?
- Authorization vs authentication: signing proves "host claims X";
  authorization is "is this host allowed to ask this remote?" Latter
  may need a separate access-control layer.

**Depends on / unlocks**: section 1 (permissions) — the install flow
provisions the signing material. Section 4 (batching) — batched
requests need per-id signatures.

## Section 7 — Versioning + binding drift

**Question.** Bindings in `src/remote/magento/` were generated months
ago. The remote has evolved — renamed a spec, added a capability
field, removed an export. What happens?

**Today.** Nothing checks. The host's render calls the old binding,
hits the remote's new endpoint, gets… whatever happens. Silent drift.

**Tentative shape.**
- Manifest carries a `version` field (semver or content-hash).
- `parton add` records the version in the generated `index.ts` header.
- `parton update` diffs versions; refuses major-version jumps without
  `--force`; warns on capability-field additions/removals.
- Runtime: the host sends its bindings' version in the fetch header
  (`x-parton-binding-version`); the remote returns a `Warning` header
  on mismatch.
- A `parton check` CLI subcommand to scan installed remotes for
  drift without re-fetching.

**Open:**
- What counts as a breaking change to a binding? Capability field
  removal (yes), addition (probably no), description change (no),
  selector rename (yes).
- Should drift surface at runtime (header warning) or only at install
  time (CLI check)? Latter is friendlier; former catches the case
  where the developer never re-runs `parton update`.
- Version reuse across multiple bindings in the same manifest — one
  version per remote, or per spec?

**Depends on**: nothing — orthogonal to other items.

## Section 8 — Server actions inside a remote payload

**Question.** A remote spec ships a client component that imports
`setCartItem` from a `"use server"` module. Where does the action
run? Where does the response stitch?

**Today.** Module references in the remote's Flight bytes are
rewritten to absolute URLs at the remote's origin. So a client
component's source modules load from the remote. But when that
client component dispatches a server action, the browser fires an
action POST with default `credentials: "include"`, hitting the
remote — without the capability header that the RemoteFrame's
GET carried. Untested; probably broken.

**Tentative shape.**
- Action POSTs from inside a remote payload must include the
  capability header (re-passed from the original placement).
- Probably needs a wrapper around action dispatch that knows
  "this action lives at remote X, attach capability Y" — the host's
  browser code injects the header automatically.
- Action response stitching: the action returns a payload and may
  bump selectors in-body (`getServerNavigation().reload({selector})`)
  — but the bump lands in the REMOTE's invalidation registry. For a
  remote action, the resulting refetch needs to route back through
  the same remote endpoint with capability.

**Open:**
- Cookie passing — actions today rely on the browser sending cookies
  automatically (`credentials: include`). RemoteFrame is `credentials:
  omit`. What's the right default for actions inside a remote?
- CSRF: if remote actions accept POST without same-origin check, the
  capability becomes the auth boundary (section 6 again).
- Long-running / streaming actions — RSC actions can stream back over
  time; does the host's stitch path handle a remote action's stream?

**Depends on**: section 6 (signed tokens) — without signing, the
capability-as-CSRF-token story is weak.

## Section 9 — Sessions at the remote

**Question.** Capability is per-request data. "Logged into Magento as
user X" is per-session. How does the host's user have a session
relationship with the remote?

**Two models on the table.**

a. **Capability carries an opaque session token** the host obtained
   out-of-band (e.g. via a server-to-server call when the user logged
   into the host). Token is opaque to the host; the remote validates.
b. **Remote owns its own login flow** that runs in iframes/popups
   when the user first interacts. Browser session cookies for the
   remote origin live in the user's browser; `credentials: include`
   on action POSTs picks them up.

**Open:**
- Model (a) makes the host the auth broker; great for single-sign-on
  but requires the host to know about the remote's auth backend.
- Model (b) decouples auth; user might see a popup at first
  interaction. Worse first-impression UX; cleaner trust model.
- Hybrid: host issues a short-lived "intent-to-auth" token via
  capability, remote uses it to bootstrap its own session cookie on
  first interaction.

**Depends on**: section 6 (signed tokens) — model (a) is signed
capabilities with a session claim; model (b) is full opt-out of
shared auth.

## Section 10 — Remote-to-remote composition

**Question.** Can a Magento spec embed a Stripe `<RemoteFrame>`?

**Tentative shape.** Yes structurally — the Magento render renders a
RemoteFrame pointed at Stripe. The host's outer encoder consumes the
Magento bytes; inside those bytes is another `<RemoteFrame>` element
that the host's React renderer encounters and dispatches. So the
mechanism already works.

What's open is the trust shape: Stripe sees a capability from Magento,
not from the host. Magento knows its host but Stripe doesn't.
Refetch routing for a transitively-nested partial needs to route
through Magento, not directly to Stripe (Stripe's bytes are
re-stitched by Magento's bytes are re-stitched by host's bytes).

**Open:**
- Refetch URL construction for a transitively-nested remote: today's
  `partialFromSnapshot` uses a single `source.origin`. Need a chain
  (`[Stripe-via-Magento, Magento-via-host]`) and refetch hits the
  outermost remote which re-renders, re-embedding the inner remote.
- Capability propagation: does Stripe see only what Magento declares,
  or does the host's capability flow through too? Probably the former
  (each hop owns its own contract).
- Three-tier auth: host signs to Magento, Magento signs to Stripe.

**Depends on**: sections 6 + 9 — auth + sessions need to compose
transitively.

## Section 11 — CMS editing of remote-stored content

**Question.** If a remote owns the storage for its blocks (the
remote app stores `magento-stocks.symbols`), can the host's CMS
editor edit it?

**Today.** Block content storage lives at the host (`cms/data/`).
Sections 2 + 10 raise the possibility of remote-stored config.

**Tentative shape.**
- Editor talks to remote's CMS storage via an additional endpoint:
  `POST <origin>/__remote/cms/<storage-key>` with content body +
  capability header.
- Cross-origin CMS editing means CORS on the storage POST, auth
  on the storage POST (section 6), and a way for the editor's UI
  to refresh after a remote edit lands.
- Or, simpler: blocks at remotes are READ-ONLY from the host's
  editor; authored via the remote's own CMS.

**Open:**
- Conflict resolution between host-edit and remote-edit of the same
  storage key.
- Editor permissions: who can edit a remote block — anyone with
  CMS editor access at the host, or only users with auth at the
  remote?
- Storage migration: a block that started host-stored and moves to
  remote-stored.

**Depends on**: sections 2 + 6.

## Section 12 — CSS + asset loading cross-origin

**Question.** Module-ref rewriting handles JS. The remote's CSS,
fonts, and images — how do they load?

**Today.** Untested at any real scale. In dev mode both apps share
the filesystem (`/@fs/...` paths just work); production hasn't been
exercised for assets.

**Tentative shape.**
- CSS loaded from the remote needs `cross-origin` on the link element
  and CORS headers on the CSS responses.
- Asset preloading hints in the manifest (the remote declares its
  required fonts, hero images) so the host can `<link rel="preload">`
  them while waiting for the Flight bytes.
- FOUC mitigation: the remote's bytes include the CSS link tag
  inline; CSS loads in parallel with the rest of the remote's
  rendering. Probably needs explicit `<link rel="preload" as="style">`
  injection.

**Open:**
- Bundle splitting: the remote's CSS might include rules that
  conflict with the host's CSS. Scoped styles? CSS modules with
  unique hashes per build (vite default)?
- Image CDN strategy: remote's images served from remote origin or
  a shared CDN? Latter is faster; former is simpler.

**Depends on**: nothing critical — production deployment concern,
deferred until first real cross-org demo.

## Section 13 — Hydration order + client state preservation

**Question.** The remote's client components hydrate when the
remote's JS arrives (likely after the host's). State in a `useState`
inside a remote component: does it survive a refetch that replaces
the same id?

**Today.** Untested. React's reconciliation usually handles this if
the React tree's key + position match across renders, but
cross-origin module identity (two different bundles serving the same
client component) is a known foot-gun — React's `===` check on the
component function fails.

**Tentative shape.**
- Document the contract: client state inside a remote partial
  survives refetch if the partial's id is stable across renders.
- Module identity: probably needs the host to import client modules
  via a stable URL even if the remote rebuilds (asset hashing per
  build breaks this).
- Effect ordering: remote's `useEffect`s fire on a different
  schedule than host's; document this so authors don't assume
  cross-frame ordering.

**Open:**
- A stable-id strategy for remote client modules. Pin via SRI hash
  + content-addressable URL?
- Diff-detection: if a refetch returns a "new version" of the
  component (different module hash), should React tear down + remount
  or attempt to migrate state?

**Depends on**: section 7 (versioning).

## Section 14 — Centered dev environment for a parton

**Question.** Remote spec authors don't always have the consuming
host running. How do they iterate?

**Tentative shape.** `/__dev/<selector>` route on any parton-serving
app — renders the spec centered with a URL bar above (drives the
spec's tracked request reads — `match` params, `searchParam()`), a
capability form on the side (provides capability values), a refresh
button. Storybook for partons, in-framework.

**Open:**
- Should this be a framework helper (`createDevHandler`) the apps opt
  into, or always on?
- For specs that read cookies/session, the dev form needs to
  fake those — how is "fake session" surfaced?
- Story persistence: can authors save a set of "test cases" (URL +
  capability combos) for regression?

**Depends on**: nothing — could ship today as a separate concern.

## Section 15 — Cross-app HMR

**Question.** Remote's spec changes during development. Host doesn't
know.

**Today.** Manual page reload. Filed in IDEAS.md.

**Tentative shape.**
- Remote dev server posts SSE on spec module update.
- Host dev server subscribes (one SSE connection per installed
  binding), invalidates its cache entries for that selector when
  it gets a message.
- Host pushes HMR to browser, browser refetches the selector.

**Open:**
- SSE channel auth — same auth as the bindings (section 6) or just
  trust the dev-mode broadcast?
- Multi-host situation: one remote, many subscribed hosts. Broadcast
  to all? Bounded fan-out?
- Production-mode equivalent (server-pushed invalidation when remote
  data changes) is a separate, harder problem (section 15-but-prod).

**Depends on**: nothing — orthogonal dev-mode improvement.

## Stuff deliberately deferred

These showed up in the conversation but don't warrant their own
section yet:

- **A11y across stitch points** — focus management, ARIA labels in
  nested remote partons. Standard React concern; not RemoteFrame-
  specific.
- **Subresource Integrity (SRI)** on remote bytes — would be nice in
  production; defer until first real third-party deployment.
- **Service worker offline replay** of remote payloads — speculative;
  no real use case yet.
- **Multi-tenancy at the remote** (one remote serving N hosts) —
  emerges from auth (section 6) design, not its own concern.
- **Build-time bundling** of remote payloads into the host (SSG-style)
  — interesting but loses the "dynamic" property that motivates
  RemoteFrame in the first place.

## Priority + dependency graph

Rough order. Each later item depends on at least one earlier item
landing.

1. **Permissions wire shape** (section 1) — shapes everything else.
2. **Failure UX** (section 5) — testable today, will bite the first
   real demo if absent. Independent of others.
3. **Versioning** (section 7) — independent; should land before any
   third-party deployment.
4. **Block-shape configuration** (section 2) — needs permissions
   wire shape (1) to know what config carries.
5. **Auth + signed tokens** (section 6) — needs permissions (1) +
   versioning (7).
6. **Server actions in remote payloads** (section 8) — needs auth (6).
7. **Sessions at remote** (section 9) — needs auth (6).
8. **fp-skip + caching** (section 3) — orthogonal but easier once
   permissions (1) shape the cache-key surface.
9. **Same-origin batching** (section 4) — needs permissions (1)
   wire shape for per-id capability transport.
10. **Remote-to-remote composition** (section 10) — needs auth +
    sessions (6 + 9) to compose transitively.
11. **CMS editing of remote-stored content** (section 11) — needs
    blocks (2) + auth (6).
12. **CSS + asset loading** (section 12) — production deployment
    concern; defer until first real cross-org demo.
13. **Hydration + client state** (section 13) — needs versioning (7)
    for stable module identity.
14. **Centered dev environment** (section 14) — orthogonal,
    independent.
15. **Cross-app HMR** (section 15) — orthogonal, dev-mode only.

## Reading order for a future session

If you have time for one section: read the **meta finding** at the
top (the host↔remote contract split into permissions / config /
resolution). Almost every open question is a different cut on the
same split, and the wire shape for permissions decides most of the
downstream.

If you have time for two: add **section 5 (failure UX)** — it's
addressable today and the absence will bite the first real-world
demo.

If you have time for three: add **section 6 (auth)** — it's the
load-bearing piece for everything you'd actually deploy.
