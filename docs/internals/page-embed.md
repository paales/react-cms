# Page embed — the slice pipeline

How `<RemoteFrame>` turns an ordinary page response into a spliceable
subtree. The author-facing contract is
[`../reference/remote-frame.md`](../reference/remote-frame.md); this
page is the mechanism. Code: `framework/src/lib/page-embed.ts` (wire
protocol + rewriter + identity helpers + the grant grammar),
`lib/remote-frame.tsx` (the consumer), the embed branches in
`lib/partial.tsx` (`PartialRoot`, the id mint, the bare emission,
`partialFromSnapshot`) and `entry/rsc.tsx` (`handleEmbedRender`),
`lib/snapshot-trailer.ts` (the registration payload),
`lib/tier-rewrite.ts` (grant enforcement + violation policy),
`lib/vocabulary.tsx` (the vetted tag set + audit table).

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
below), and the test harness's `x-test-scope` forward.
`credentials: "omit"` always.
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
scope (`runWithCapability` around the stream build), and both wrap
the stream as:

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
registry — labels prefixed with the human `namespace` when given, and
`source: {kind: "page", url, ns, namespace?, capability?}` stamped —
under `deferCommitUntil`, so the host's stream wrappers hold commit
until registration lands (route-hint writes visible before the
response goes out; selector refetch never hits a registry miss).
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

## The tier rewriter (grants)

`createTierRewriter` (`lib/tier-rewrite.ts`) is the enforcement for a
vocabulary-constrained grant set (`client ∉ grants` — v1: Paint,
`grantsVocabularyConstrained` in `page-embed.ts`). It composes onto
the ONE splice pipeline after `pageEmbedRewriter` (the shipped
head/meta/hint strip is tier zero); `moduleRefRewriter` is never in a
granted pipeline — below the Client tier zero remote modules load,
same- or cross-origin. Stateful per stream (mint one per response):

| Row / element                                        | Action                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `I` import rows                                      | Dropped; id → module path recorded in the module ledger. `virtual:vite-rsc/*` specifiers (the css-dedup helper beside the page root — bundler head plumbing whose managed `link`s died at tier zero) go to a SILENT ledger instead.                                              |
| `D` / `W` rows                                       | Dropped — the remote's debug channel (dev-only; raw pre-audit props, source paths, `$E` sources). Makes dev splice like prod.                                                                                                                                                    |
| symbol rows (`"$S…"`)                                | Ledgered + passed; admission is decided at the element that uses one.                                                                                                                                                                                                            |
| vocabulary tags (the `VOCABULARY` table)             | Props re-audited: audited attrs re-validated through `sanitizeVocabAttr` (a bad value drops the ATTR), `children` walked, everything else stripped. Re-emitted as a bare 4-tuple — stripping the dev builds' trailing debug-ref entries is what orphans the debug metadata rows. |
| `react.suspense` / `react.fragment` element types    | Pass (structural — streaming pacing and grouping, no code).                                                                                                                                                                                                                      |
| any other element type / disallowed symbol           | **Violation** — degrade in place.                                                                                                                                                                                                                                                |
| element referencing a dropped module (type or value) | **Violation** (`offense: "module"`); a silent-ledger (plumbing) reference degrades quietly.                                                                                                                                                                                      |
| vocabulary element with outlined (`"$n"`) props      | **Violation** (`offense: "opaque-props"`) — unauditable row-locally; same safe direction as tier zero's outlined-singleton rule.                                                                                                                                                 |
| unresolvable element-type reference                  | Degrades WITHOUT a log — reachable only from debug metadata (owner/source refs in type position); real content types are tags, symbols, or module refs, and both ledgers flush before use (format-canary-pinned).                                                                |

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

Labels are deliberately NOT placement-prefixed (class-level fan-out;
producer invalidation selectors must keep matching). The human
`namespace` prefix on labels is applied host-side at trailer
registration.

## Refetch routing

`partialFromSnapshot` on a `source.kind === "page"` snapshot returns
`_pageEmbedRefetch(id, source)` — a focused re-embed of
`source.url + ?partials=<id>` with the STORED `ns` (never re-derived:
the refetch runs outside the placement's tree position) and stored
capability, at `embedDepthOf(current) + 1`. Host lanes, broadcast
probes, and the entry's own focused path all route through
`partialFromSnapshot`, so every refetch consumer gets embed routing
for free. Same-origin, this means producer-side invalidations
(shared process registry) lane focused re-embeds onto held host
connections with zero extra machinery.

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
