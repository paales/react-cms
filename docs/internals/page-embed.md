# Page embed — the slice pipeline

How `<RemoteFrame>` turns an ordinary page response into a spliceable
subtree. The author-facing contract is
[`../reference/remote-frame.md`](../reference/remote-frame.md); this
page is the mechanism. Code: `framework/src/lib/page-embed.ts` (wire
protocol + rewriter + identity helpers + the grant grammar + the
`/__remote` endpoint paths), `lib/remote-frame.tsx` (the consumer +
bound-cell projection), the embed branches in `lib/partial.tsx`
(`PartialRoot`, the id mint, the bare emission, the `cells`
requirement gate, `partialFromSnapshot`) and `entry/rsc.tsx`
(`handleEmbedRender`), `lib/snapshot-trailer.ts` (the registration
payload), `lib/tier-rewrite.ts` (grant enforcement + violation
policy), `lib/vocabulary.tsx` (the vetted tag set + audit table),
`lib/embed-interactive.tsx` (the Interactive grant's host-bundle
bridge), `runtime/embed-actions.ts` (the invocable-action registry),
`runtime/remote-cell.ts` (the host half of remoteCell).

## The request — explicit headers, an ordinary URL

An embed fetch targets the page URL with three headers; nothing is
ever inferred from URL shape:

| Header                 | Value           | Meaning                                                                                                                                                                                                         |
| ---------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `x-parton-render`      | `1`             | Return Flight, not an HTML document. `parseRenderRequest` classifies a GET carrying it as an RSC render, so the URL stays the page URL — match gates, tracked reads, and route keying evaluate the page itself. |
| `x-parton-embed-depth` | `hostDepth + 1` | This render is an embed at depth N. `PartialRoot` branches on it; the recursion guard counts with it.                                                                                                           |
| `x-parton-embed-ns`    | `e~<hash>`      | The placement namespace the producer folds into every effective parton id it mints (see Identity below).                                                                                                        |

Plus `x-parton-capability` when the call site declares one,
`x-parton-embed-grant` when it declares a `grant` (the comma-joined,
sorted grant set — a STATEMENT the producer uses to render its
embed-surface variant; enforcement is the host's tier rewriter,
below), `x-parton-embed-cells: 1` when it binds cells — the request
is then a **POST** whose JSON body carries the projected values
(`{cells: {name: value}}`; values may exceed any header ceiling, so
they ride the body; `parseRenderRequest` keys on the render header
either way, never the method) — and the test harness's `x-test-scope`
forward. `credentials: "omit"` always.
All `x-parton-*` headers are stripped from the vary-facing header
surface, so app code (and `headers` match gates) never see them.

## The producer

`handleEmbedRender` in `entry/rsc.tsx` answers every header-marked
Flight GET. Two shapes, one response contract:

- **Whole page** — the ordinary `<Root/>` render. `PartialRoot` sees
  `embedDepthOf(headers) > 0` and, after entering the request
  registry + partial state as usual, returns the app tree wrapped in
  the slice-marker element instead of the page shell:

  ```
  ["$","parton-embed-body",null,{"children": …app tree…}]
  ```

  The marker is the wire signal the consumer slices on — the producer
  writes it; nothing is guessed from page structure. It never reaches
  a DOM.

- **Focused** (`?partials=<id>[,<id>…]` present on an embed-flagged
  request — the refetch protocol): the entry enters its own registry
  context on the page's routeKey (`computeRouteKey` keys on the URL
  base, so the transport param can't shift the bucket; `partials` is
  also in match's `TRANSPORT_PARAMS`), looks each id up with
  `lookupPartial`, and renders `partialFromSnapshot(id, snap)` per
  target inside a lane-shaped partial state (`isPartialRefetch`,
  `explicitIds`) — the exact isolated-render path a local forced lane
  takes. Any registry miss falls back to the whole page (over-fetch,
  never fail).

Both shapes decode the capability header into `getCapability()`
scope (`runWithCapability` around the stream build) — and, on a
cells-flagged POST, the body's projection into the bound-cell scope
(`runWithBoundCellProjection`, `runtime/capability.ts`). The
projection is PAGE-scoped and raw; the SPEC boundary is where it
narrows: a cell-declaring parton (`cells` option) filters it to its
declared names before stamping `boundCells` onto the current-parton
context (`getBoundCells()` reads it), and on an embed render a
missing `required` name throws before the body runs — the parton's
own error containment ships the failure as its error card, which is
what the host splices. Standalone renders skip both the filter's
enforcement and the projection (`{}`). A malformed projection body
decodes to none — required checks then fail explicitly rather than
rendering against silent nulls. Both shapes wrap the stream as:

```
renderToReadableStream({ root })
  → wrapStreamWithCommitOnly        (defers drained, registry commit)
  → wrapStreamWithSnapshotTrailer   (the `snapshots` entry)
```

The inner flush drains the commit-defer list first, so a NESTED
embed's trailer registrations land before the outer flush reads the
snapshot set. The snapshots getter never reads ALS-at-flush (fragile
across stream runtimes — the same reason the fp-trailer captures
scope + routeKey at wrap time): the focused path captures its own
registry ctx (`pendingWrites`); the whole-page path reads
`_readSnapshotsForRoute(scope, routeKey)` — fully populated by the
render's eager-publish + commit — **filtered to the inbound
namespace**. The committed route set is a union across placements
(same-origin embeds share the process store), and a foreign
placement's id shipped here would get re-stamped with this
placement's namespace on the host; its next refetch would then
replay the wrong namespace into the producer and mint a
double-prefixed id the host's template can never match. Every id
this render minted carries the inbound namespace, so the prefix IS
the filter.

## The trailer

`\xFF[parton:snapshots:N]\n` + N bytes of UTF-8 JSON
`{id → SerializedSnapshot}` — the same `buildMarker` grammar as the
fp/url/settled entries, so the consumer reads it off `splitSegments`'
trailer map with no dedicated splitter. Serialization drops
`fallback` (JSX), `cache` (producer-side decision), and `source`
(each hop re-stamps with ITS fetch URL — exactly the hop a refetch
must retrace).

## The consumer

`RemoteFrame` resolves the URL, mints the placement namespace, and
`embedPage` fetches. The response is segmented Flight (the same wire
the browser client reads); the consumer takes the FIRST segment only
and cancels the iterator after its trailers resolve — an embedded
page holding a live connection would otherwise park it open.

Trailer handling registers each snapshot into the HOST's request
registry — labels AS SHIPPED (bare), and
`source: {kind: "page", url, ns, capability?, grant?, cells?}`
stamped (`cells` holds per-binding STAMPS — cell id + resolved
partition, never the projected values; in-memory only, since
`serializeSnapshot` drops `source` wholesale) —
under `deferCommitUntil`, so the host's stream wrappers hold commit
until registration lands (route-hint writes visible before the
response goes out; a targeted lane never hits a registry miss).
The source stamp is part of the registry's VARIANT KEY
(`variantKeyOf` in partial-registry.ts): same-origin, host and
producer share one canonical store, and both register the SAME id
with the same parent path — the sourced variant stores beside the
producer's local one instead of clobbering it, so the producer's
focused `?partials=` lookup keeps resolving its own local snapshot
(a sourced snapshot there would recurse the embed into itself until
the depth cap).

The body streams through `pageEmbedRewriter`, a row-local
`RowRewriter` on `rewriteFlightStream`:

| Row / element           | Action                      | Why                                                                                                                                            |
| ----------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `parton-embed-body`     | unwrap → children           | The slice marker.                                                                                                                              |
| `html`, `body`          | unwrap → children           | React 19 document singletons — rendered anywhere they attach to the host DOCUMENT; an embedded `<body className>` would restyle the host page. |
| `head`                  | drop                        | The embedded document head, wholesale.                                                                                                         |
| `title`, `meta`, `link` | drop                        | Hoistables — React hoists them into the head from anywhere; embedded metadata must not hijack the host's head.                                 |
| `:H<code>` hint rows    | drop                        | Wire-level preload/preinit directives aimed at the document head.                                                                              |
| everything else         | pass through byte-identical | Content rows, `I` imports, Suspense refs, symbol rows — within-embed Suspense pacing survives.                                                 |

The classification mirrors react-dom's own singleton + hoistable
sets — an element typed `head` in a Flight row IS the document head.
The transform is row-local (no cross-row graph walk, no buffering):
the reference graph stays intact and rows orphaned by a drop (the
head's outlined content) are simply never reached by the host's
re-encode. Unwrap with outlined props (dedup) drops the element —
the safe direction for a singleton.

The payload's root row is the entry contract `{root, …}`; the
consumer decodes and returns `.root`. Cross-origin, an UNGOVERNED
pipeline composes `moduleRefRewriter` after the slice (same-origin
skips it — origin equality, not URL shape). A granted embed replaces
that arm entirely — see the tier rewriter below.

## A resolved cell's `set` across the splice

A parton that resolves a cell and hands the whole `ResolvedCell` to a
`"use client"` component would normally carry `set` as the cell's
**bound** server-action ref (`__cellWrite.bind(null, id)` /
`__scopedCellWrite.bind(null, id, partition)`). The host decodes the
embedded payload and re-encodes `payload.root` into its OWN document
Flight render — and a decoded server reference bound to a partition
OBJECT cannot be re-encoded: `renderToReadableStream` stalls, the
host document stream never closes (a single-string-bound id survives;
the object arg is what stalls). So `buildResolvedCell` (`lib/cell.ts`)
detects the embed render (`inEmbedRender` — `embedDepthOf(headers) >
0`) and builds `set` as a CLIENT reference (`embedCellWrite`,
`lib/cell-client.tsx`) instead. Client references re-encode across an
ungoverned same-origin embed exactly like any client component in the
payload — no server reference reaches the host re-encode.

The write routing rides across as DATA: the cell `id` and (baked)
`partition` are already fields on the `ResolvedCell`. Invoked as a
method (`cell.set(value)`), `embedCellWrite` reads them off `this` and
routes the write through the SAME coalescing batcher `useCell` uses
(`__cellWriteBatch` — the cell's `writeGuard` + `cell:` invalidation
fan-out unchanged), so a denial rejects the returned promise exactly
like the direct-ref path outside an embed. `useCell` never touched
`set` (it reconstructs the write from `id` + `partition`), so it works
across the splice with no change. Under a vocabulary-constrained grant
the producer emits BARE — no client boundary receives a `ResolvedCell`
— so this path is reached only by ungoverned embeds; the grant gate is
structural. Cross-origin ungoverned, the client ref resolves against
the producer origin (like every ungoverned client module), so the
write reaches the producer's own action endpoint — no NEW write
channel the grant vocabulary doesn't already permit.

## The tier rewriter (grants)

`createTierRewriter` (`lib/tier-rewrite.ts`) is the enforcement for a
vocabulary-constrained grant set (`client ∉ grants` — v1: Paint,
`grantsVocabularyConstrained` in `page-embed.ts`). It composes onto
the ONE splice pipeline after `pageEmbedRewriter` (the shipped
head/meta/hint strip is tier zero); `moduleRefRewriter` is never in a
granted pipeline — below the Client tier zero remote modules load,
same- or cross-origin. Stateful per stream (mint one per response):

| Row / element                                        | Action                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `I` import rows                                      | Dropped; id → module path recorded in the module ledger. `virtual:vite-rsc/*` specifiers (the css-dedup helper beside the page root — bundler head plumbing whose managed `link`s died at tier zero) go to a SILENT ledger instead.                                                                                                                                                                                                                                                                                                              |
| `D` / `W` rows                                       | Dropped — the remote's debug channel (dev-only; raw pre-audit props, source paths, `$E` sources). Makes dev splice like prod.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| symbol rows (`"$S…"`)                                | Ledgered + passed; admission is decided at the element that uses one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| vocabulary tags (the `VOCABULARY` table)             | Admission is GRANT-GATED per tag: a member carrying a `grant` requirement (the interactive set — `parton-textfield`, `input`, `parton-button`) survives only a splice whose grant set holds it; under plain Paint it degrades like a non-member. Admitted tags' props re-audited: audited attrs re-validated through `sanitizeVocabAttr` (a bad value drops the ATTR), `children` walked, everything else stripped. Re-emitted as a bare 4-tuple — stripping the dev builds' trailing debug-ref entries is what orphans the debug metadata rows. |
| `react.suspense` / `react.fragment` element types    | Pass (structural — streaming pacing and grouping, no code).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| any other element type / disallowed symbol           | **Violation** — degrade in place.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| element referencing a dropped module (type or value) | **Violation** (`offense: "module"`); a silent-ledger (plumbing) reference degrades quietly.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| vocabulary element with outlined (`"$n"`) props      | **Violation** (`offense: "opaque-props"`) — unauditable row-locally; same safe direction as tier zero's outlined-singleton rule.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| unresolvable element-type reference                  | Degrades WITHOUT a log — reachable only from debug metadata (owner/source refs in type position); real content types are tags, symbols, or module refs, and both ledgers flush before use (format-canary-pinned).                                                                                                                                                                                                                                                                                                                                |

**Violation policy — degrade + loud, one function.**
`tierViolationPolicy` is the single flip point: the offending element
resolves to nothing (never blocks — siblings keep painting), one
structured `[parton] tier-violation {url, grants, offense, type}`
line fires (deduped per distinct (offense, type) per splice — dev
payloads duplicate every content element into debug metadata rows the
rewriter can't tell apart from content), and in DEV a visible
`<parton-tier-violation data-offense data-type>` marker (styled by
the vocabulary stylesheet) takes the element's place; prod returns
`null`. Changing the policy (block, fully silent, custom overlay) is
an edit to that one function.

**The host-defined box.** A granted embed's decoded subtree is
wrapped in `<parton-embed-box data-grant="…">` with inline
`contain: strict` — the blast-radius ceiling (the Layout grant is
what will drop `size` containment). The host owns the box's
dimensions via CSS; size containment means content never sizes it.

**Producer cooperation — the bare emission.** The grant header also
reaches the producer, and `createSpecComponent` (partial.tsx) reads
it (`embedGrantsOf` + `grantsVocabularyConstrained`): under a
vocabulary-constrained render a parton emits its body BARE — no
`PartialErrorBoundary` client wrapper, no Activity parking or
placeholders (a match miss renders `null`), no cull machinery, no
defer activator, no `Cache` wrap, and NO registration (empty
snapshots trailer — pull-only, nothing is independently
refetchable). Suspense stays, so within-embed streaming pacing
survives; descendants still scope through `ParentContext`. This is
cooperation, not enforcement — a producer that ships the apparatus
anyway just gets it degraded at the splice (the boundary is a module
ref). App shells branch the same way via `getEmbedGrants()`
(capability.ts — reads the header off the request scope) to keep raw
chrome elements off the surface; `e2e-magento`'s `Root` is the
reference.

The grant is stamped into the snapshot `source`
(`grant: readonly string[]`) and replayed by `_pageEmbedRefetch`, so
a granted placement can never re-fetch wider than it was placed.

## Recursion — a marker, never a throw

Each hop writes `hostDepth + 1`; at depth > `MAX_EMBED_DEPTH` (3) the
frame renders `<div hidden data-parton-embed-limit="<url>">` instead
of fetching. A thrown rejection's containment is timing-dependent: an
encoder reaching the embedded lazy while pending outlines it to its
own row (deep containment), but an already-rejected lazy throws
synchronously into the enclosing task row and surfaces at the nearest
OUTER boundary — on a warm self-embed that replaced the whole page.
Position-stable termination requires a value.

## Identity — the placement namespace

`embedNamespaceFor` hashes `[hostNs, hostParentPath, urlKey,
occurrence]`:

- `hostNs` — the host render's own inbound `x-parton-embed-ns`
  (`null` on an ordinary render). This is what separates the LEVELS
  of a self-embedding page, whose frames sit at the same tree
  position on every level.
- `hostParentPath` — the ambient parton path
  (`getServerContext(ParentContext)`), unique per placement under
  distinct partons.
- `urlKey` — origin + pathname (no search: a `?step=` frame-driven
  embed keeps one identity).
- `occurrence` — a per-request counter on the partial state
  (`embedSeq`), keyed by parent-path + urlKey, separating same-URL
  siblings in tree order (deterministic across renders of the same
  page).

The producer applies it at the single id-mint choke point in
`createSpecComponent`: after `effectiveIdForInstance`, an embed
render prefixes the id (`applyEmbedNamespace` — idempotent, so a
focused refetch's `__instanceId` ids, already prefixed, pass through
while the descendants it spawns mint bare ids that gain the prefix).
The prefixed id flows everywhere ids flow: the boundary's client
props, placeholders, wire tokens, both registries, the trailer.
`deriveMatchKey`'s ancestor walk strips the namespace
(`stripEmbedNamespace`) before catalog lookups — the catalog is
keyed by bare spec ids. The `~` in the grammar is framework-reserved,
which is what makes both the idempotence check and the strip a
protocol signal rather than a guess.

Labels are deliberately NOT namespaced — neither by the placement
namespace nor by the human `namespace`. They name the embedded
partons' cell/tag invalidation subscriptions (class-level fan-out
targets), and the producer's own bumps must keep matching them so a
`refreshSelector` wake lanes a `_pageEmbedRefetch` back through the
embedded URL.

## Refetch routing

`partialFromSnapshot` on a `source.kind === "page"` snapshot returns
`_pageEmbedRefetch(id, source)` — a focused re-embed of
`source.url + ?partials=<id>` with the STORED `ns` (never re-derived:
the refetch runs outside the placement's tree position) and stored
capability, at `embedDepthOf(current) + 1`. Bound-cell stamps are
RE-RESOLVED against current storage (`projectionFromStamps` — a stamp
without explicit args re-derives the partition from the cell's own
callback against the refetch's request scope), so a focused re-embed
always projects the LIVE host value — replaying the placement-time
projection would freeze the embed at stale host state. Host lanes,
broadcast probes, and the entry's own focused path all route through
`partialFromSnapshot`, so every refetch consumer gets embed routing
for free. Same-origin, this means producer-side invalidations
(shared process registry) lane focused re-embeds onto held host
connections with zero extra machinery.

## The interaction bridge (Interactive grant)

`RemoteFrame` mounts `EmbedInteractiveBridge`
(`lib/embed-interactive.tsx`, `"use client"` — a HOST-bundle client
reference: the frame's JSX is encoded by the host encoder, so no
remote module is involved) inside the embed box when the grant set
holds `interactive`, wrapping the spliced payload in a
`display: contents` `parton-embed-interactive` element. Mechanics:

- **DOM delegation, names off audited attributes.** One `input` and
  one `click` listener on the wrapper. An input inside
  `parton-textfield[cell-id]` queues a write of the field's DOM value
  at the tag's explicit `cell-partition` (JSON — the browser has no
  session of the remote to derive one from); a `parton-button[action]`
  click invokes the bare action name. Both POST to the placement's
  ORIGIN (a prop RemoteFrame stamped server-side) with the placement's
  encoded capability header — the origin namespace is structural, not
  parsed off the payload.
- **Write queue = the `useCell().input()` discipline**: per
  (cell, partition), single-inflight + replace-coalesce — rapid typing
  costs one round-trip at a time and only the latest value sends. The
  input itself is UNCONTROLLED (`defaultValue` on the wire), so the
  DOM is the optimistic value and a server refresh at the same tree
  position never clobbers the user's in-progress text.
- **The server echo is a self-refetch** — the bridge forces the
  enclosing host parton's effective id (read off `PartialIdContext`,
  dispatched through `enqueueRefetch` — the framework-internal
  id-forcing protocol; authors never target partons), whose re-render
  re-embeds the page. Coalesced to one fire per settled burst, only
  when every queue drained (a refetch under a still-pending newer
  value would echo older server state). Hence the placement rule: an
  interactive embed sits inside a host parton — outside one the bridge
  has no id to force and throws its wiring error.
- **`data-interactive-ready`** on the wrapper is the wired signal
  (set in the same effect that attaches the listeners, removed on
  cleanup): the embed's DOM streams in and paints before this client
  component hydrates, so observers wait on the marker, never timing.

## The `/__remote` interaction + cell endpoints

`createRemoteHandler` (mounted only when the app configures
`remote: { name }`) serves the producer half; all four run inside
`runWithRequestAsync` + `runWithCapability` so cell partitions,
`writeGuard`s, and action guards see the caller's scope and presented
capability:

| Endpoint                        | Contract                                                                                                                                                                                                                                                                                                    |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /__remote/cells/write`    | `{cell, partition, value}` → `writeOneCell` in an invalidation transaction — the ordinary choke point (shape validation → 400, `writeGuard` deny → 403, unknown id → 404). Open-by-default like every cell write; `writeGuard` + capability is the per-cell lock.                                           |
| `POST /__remote/actions/invoke` | `{action, payload}` → the `embedAction` registry (`runtime/embed-actions.ts`). Unknown name → 404; `guard(capability, payload)` false → 403 before the handler; the handler runs in an invalidation transaction (one bump batch, throw discards). The payload is untrusted input the handler owns.          |
| `POST /__remote/cells/attach`   | `{cells: [ids]}` → per-id `publish` check against the presented capability (any refusal 403s the whole attach; unknown ids refuse identically — existence undisclosed). Response: held NDJSON — an acceptance line, then one `{selectors}` line per committed bump batch, filtered to the subscribed names. |
| `GET /__remote/cells/value`     | `?cell=<id>&args=<json>` → same publish check → `resolveCellValue` at the EXPLICIT partition (loader runs on a cold slot) → `{value}`.                                                                                                                                                                      |

The attach's feed is `_addCommittedBumpObserver`
(`invalidation-registry.ts`) — an observer SET beside the single-slot
bridge tap, same delivery contract (one batch per synchronous commit
section, strictly post-commit, inbound applies suppressed), so an open
subscription and an installed `setInvalidationBridge` coexist.

Host side, `remoteCell` (`runtime/remote-cell.ts`) holds the attach
loop (first resolve starts it; 1s-backoff reconnect; 403 is permanent
for the handle — same capability, same answer): per doorbell it drops
the matching row(s) of its PRIVATE cache adapter (per-handle, scope ×
partition — never the app's persistent storage; the drop spans every
scope because bumps are scope-agnostic) and re-emits the batch via
`deliverInvalidationBumps` under origin `remote-cell:<origin>`. The
handle itself is an UNREGISTERED local-cell handle
(`_buildLocalCellHandle` — registering would claim the remote's id in
this process's write registry) whose loader GETs the value endpoint,
forwarding the ambient request's `x-test-scope` the way the embed
fetch does.

## Isolation

The embedded render runs in its own request scope (`fetch` →
`runWithRequestAsync` server-side): `getRequest()` inside the
embedded page sees the embedded URL, nested cleanly inside the
host's in-flight ALS context — no scope bleed either direction
(covered by `page-embed.rsc.test.tsx`, whose fetch stub renders the
requested page through the same harness in-process — genuine
self-embedding). Session/cookies never cross (`credentials: "omit"`);
the capability header is the one explicit channel.

## Test-harness note

The bare vitest rsc worker has no client-module loader, so a decoded
client-reference lazy can never resolve through the vendored Flight
runtime. `page-embed.rsc.test.tsx`'s producer stub therefore rewrites
`I` rows to a literal `"client-ref"` element type before the host
consumes them — decode→re-encode works, `partialId` props survive
verbatim for wire assertions. Production embeds resolve refs through
the real plugin runtime; the shim exists only below the app-runtime
line.
