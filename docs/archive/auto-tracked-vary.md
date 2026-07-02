> Superseded 2026-07-02 by [docs/reference/partial.md](../reference/partial.md) — the
> `vary` option is removed; tracked reads are the shipped design.

# Auto-tracked vary — abolishing the declared `vary` callback

Status: **design + spike**. The decision is made: tracked reads
(server-hooks) will replace the declared `vary` callback entirely; the
`vary` option is removed from the constructor at the end of this arc.
This note designs the end state and the road there, and records what
the spike proved. It builds on [`server-hooks.md`](./server-hooks.md)
(the mechanism: `getCurrentParton`, store-and-reread, the dep-record)
— read that first; this note is §2 + §5 of its roadmap, worked out.

The spike (same commit as this note) shipped:

- the two missing request-dimension hooks — `header()`, `pathname()`
  — completing the `VaryScope` read surface;
- the **cold-record fp-skip gate** (partial.tsx + `committedDepsEvidence`
  in partial-registry.ts), which is what makes "cold degrades to
  over-fetch, never stale" actually true rather than aspirational;
- three representative conversions in `e2e-testing` (cookie:
  `MagentoHeader`; search-param + byte-cache: `MagentoProducts`;
  wrapper + descendants + schema-2nd-arg: the `SearchArea` family in
  `pokemon.tsx`);
- parity probes: `auto-tracked-vary.rsc.test.tsx` (fp lifecycle,
  fp-skip/refetch parity against a declared-vary twin, descendant-fold
  un-skip, the gate) alongside the earlier `tracked-reads-fp.rsc.test.tsx`.

## Why remove `vary` (not just allow hooks alongside it)

`vary` exists to declare, ahead of the render, what the render will
read. That is a shadow copy of the body's real read set, and shadow
copies drift: the wrapper-vary rule (below), the `__href: url.href`
hand-folds of the past, and the "wrapper fp-skip starves a
descendant" class of bugs are all drift between the declaration and
the truth. The per-component ALS made read-attribution reliable, so
the truth is now directly observable — the read IS the dependency,
exactly like a cell. One mental model, no declaration to keep in sync,
and the dependency surface is data (flat keys) instead of code (an
opaque callback), which the fold and future optimizations can exploit
(§7).

## 1. The tracked-read surface (VaryScope → hooks)

| `VaryScope` field | Hook | Status | Dep key | Re-read at fold by |
|---|---|---|---|---|
| `search` | `searchParam(name)` | landed | `search:<name>` | `url.searchParams.get` |
| `cookies` | `cookie(name)` | landed | `cookie:<name>` | `parseCookies(request)` (includes same-request `setCookie` writes) |
| `headers` | `header(name)` | **this spike** | `header:<lowername>` | `request.headers.get` (`x-parton-*` invisible, as in the vary scope) |
| `pathname` | `pathname()` | **this spike** | `pathname:` | `url.pathname` |
| `params` | `param(name)` | landed | none — match params already fold via `matchKey` | n/a |
| (inline patterns) | `match(pattern)` | landed | `match:<pattern>` | re-`exec`, named groups only |
| `session` | `session()` | landed | `session:` | `getSessionId()` |
| `url` | — deliberately none | — | — | — |
| `time` / `expiresAt` / `staleUntil` | `expires(ts)` / `staleUntil(ts)` | **missing** (design below) | none — wake hints, never fp | n/a |
| `instanceId` | `getCurrentParton().id` | landed | n/a (identity, not a dep) | n/a |

Beyond the `VaryScope` parity set, the same dep-record already carries
axes `vary` never had: `visible()` (viewport culling), inline
`localCell` (`cell:<id>?<partition>`, folded as invalidation-ts), and
schema-phase `tag()` (label-set fold). Render-phase `tag()` still
needs its store-and-reread ride (server-hooks.md roadmap §1).

**Absence is a value.** The fold encoding (`evalDepKeys`) must
distinguish an absent read from an empty one: `?search=` (present,
empty — dialog open) and no `?search` at all (dialog closed) return
`""` vs `null` from the hook, and Renders branch on exactly that. A
declared vary got this for free (`stableStringify` drops `undefined`
keys but keeps `""`); the dep encoding initially collapsed both to
`key=` and the converted search dialog fp-skipped into its closed
body on `/?search=` — caught by e2e, fixed by encoding absence as the
bare key (`search:q` vs `search:q=`), probed in
`auto-tracked-vary.rsc.test.tsx`. Rule for any future dep kind: the
value encoding must be injective over the hook's observable return
space, null-ness included.

Notes on the deliberate gaps:

- **No `url()` hook.** A whole-URL dep would move the fp on every
  navigation — including the framework's own `?cached=`/`?partials=`
  params — which is the anonymous-wildcard bug class all over again.
  Everything a spec legitimately needs is a narrower read:
  `pathname()`, `searchParam()`, `match(pattern)` (which takes a full
  `URLPatternInit`, so hash/port/hostname dimensions are expressible
  as patterns when genuinely needed).
- **Wake hints** (`expiresAt`/`staleUntil`) are not dependencies —
  they're TTL signals stripped from vary's return today
  (`stripReservedVaryKeys`) and stored on the snapshot. Hooks-world
  design: `expires(at)` and `staleUntil(at)` write mutable fields on
  the `CurrentParton`; the boundary passes a live box (the same
  live-reference trick the `deps` Set uses) so render-body calls land
  before the segment driver / byte cache consult the snapshot at
  flush. `time` itself needs no tracking — reading the clock is not a
  dependency; only the declared boundary matters. A `time()` hook
  returning the existing `TimeScope` keeps the `time.nextSecond`
  ergonomics: `expires(time().nextSecond)`.
- **Session values.** `SessionReadSurface` is just `{id}` now (named
  session values moved to cells), so `session()` is full parity
  already; per-session data partitions via cell `vary`.

## 2. Cold-render semantics — store-and-reread, spelled out

The fp is computed BEFORE Render runs. What folds
(`partial.tsx` fingerprint section):

    foldDeps = selfDeps ∪ priorSnap.deps        // re-read at current request

- **Schema-phase reads fold with NO lag** — `schema` runs before the
  fp, so its reads are in `selfDeps` at fold time. Verified: this is
  what lets a `cache:`+tracked spec key its byte-cache from render 1
  (cache-demo, and the converted `MagentoProducts`/`Stage2`/`Stage3`).
- **Render-body reads lag one render** — render 1 of a variant emits a
  dep-less fp (`fp_cold`); the record it writes makes render 2+
  accurate (`fp_warm`). The fp-trailer closes the client-facing lag in
  the SAME response: `computeFpUpdates` re-evaluates each snapshot's
  deps at flush (`evalDepKeys(snap.deps, …)`) and ships `fp_cold →
  fp_warm`, so fp-skip works on the very next nav.

Consequences, per mechanism:

**(a) fp-skip — the cold-record hazard and its gate.** A dep-less
`fp_cold` is not request-reproducible: two requests with DIFFERENT
read values produce the SAME `fp_cold` whenever no dep record exists.
Concretely: client renders at `cookie=a` (caches `fp_cold`), server
restarts (or the nav lands in a route bucket whose snapshot hint is
uncommitted — see §4), client revisits at `cookie=b` declaring
`?cached=…fp_cold`. The server, with no `priorSnap`, folds no deps,
recomputes `fp_cold`, matches, and would skip — serving `a`-bytes at
`b`. **Stale**, and strictly worse than the declared-vary twin (whose
fp re-derives from the request). The spike closes this with the
cold-record gate in `partial.tsx`:

    skip requires:  opts.vary != null            // declared surface is request-reproducible
                 ∨  priorSnap != null            // this route-variant has a dep record
                 ∨  committedDepsEvidence(id) === "depless"

The evidence check (`partial-registry.ts`) scans the id's committed
variants across ALL routes: if some variant recorded tracked reads,
a dep-less fp match is untrustworthy → decline, render, never stale.
If every committed variant recorded an EMPTY read set, the skip is
sound — an empty read set is a fixed point under the tracking
invariant (reads are conditioned only on tracked inputs; with none
read, no input exists that could make a future render start reading),
so this id provably has a request-independent body. That preserves the
drawer-stack UX (`/inspect` ↔ `/inspect/p/3` fp-skips the base grid
across route buckets — `partial-wildcard-fp.rsc.test.tsx` still
passes) while making hooks-only specs cold-safe
(probes in `auto-tracked-vary.rsc.test.tsx`).

The tracking invariant is a real (and documentable) contract: a
Render's tracked-read set must be a function of tracked inputs, props,
and invalidation-covered data (cells/tags) — not of untracked
nondeterminism (`Date.now()` branching into a `cookie()` read). This
is the same contract every fine-grained-reactivity system (MobX, Vue,
Solid) rests on, and it's the reason store-and-reread is sound at all:
any change in the read set is preceded by a change in some
previously-read value, which moves the fp, which re-renders and
re-records.

When `vary` is finally removed, the first disjunct disappears and the
gate is just record-or-depless-evidence. Cost model: one over-render
per (id × route bucket) per process cold start, for specs with tracked
reads. That is the "auto-track is reactivity; cold degrades to
over-fetch" tradeoff from server-hooks.md, now mechanized instead of
assumed.

**(b) The descendant fold.** An ancestor folds descendants from the
FOLD BASE — the prior-commit canonical snapshots for (scope,
routeKey). A descendant rendering for the first time this pass is
invisible to its ancestor's fold (by design: React renders top-down,
so this-pass registrations can't be folded anyway); the trailer
recomputes the ancestor's fold post-commit and ships the warm fp. So
an ancestor folding a "descendant with no recorded deps yet" is not a
distinct corner — it's the same one-response lag, closed the same way.
What matters is that `descendantContribution` re-reads a descendant's
STORED deps against the CURRENT request (`evalDepKeys(snap.deps,
request)`, frame-resolved), so once recorded, a descendant's read
moves every ancestor's fp with zero lag. Probes: tracked-reads-fp
(fp inequality) and auto-tracked-vary (behavioral un-skip: wrapper
fp-skips at `cookie=a`, renders fresh at `cookie=b` where only the
CHILD reads the cookie).

**(c) Cache-keyed specs.** The byte cache keys on `structuralFp`,
computed pre-render. Schema-phase reads are in that fp from render 1
— cache-safe, verified. Render-BODY reads on a `cache:` spec are a
**stale-bytes hazard**: render 1 writes the cache under a dep-less
key; a later cold-registry request with different read values computes
the same dep-less key and HITS the stale entry. (The fp-skip gate does
not protect the byte cache — `<Cache>` lookup is fp-key equality, not
a skip decision.) Interim rule, enforced by convention in the
conversions: **a `cache:` spec does its request reads in `schema`**.
Migration-phase framework fix (so the rule can die): defer the cache
WRITE key to post-render — fold the live `selfDeps` into the key at
collect time, so no entry is ever keyed dep-less; pre-render lookups
(which fold `priorSnap.deps`) then either hit a deps-complete entry or
miss into a fresh render. Reads stay correct on every path; the cold
path over-fetches, never serves stale.

## 3. Replacing `vary`'s three non-fp roles

`vary` is not just the fp surface. Three other things hang off its
return value today; each needs a hooks-era answer.

**(a) Render-props typing.** Today `InferV` = vary's return type
(minus reserved keys), and Render receives `{...vary, ...schema,
...actions, children}`. With hooks called inside Render, the
framework-supplied prop bag shrinks to: match params (typed
`ParseRoute<pattern>` — `match` stays an option, §5) + schema results
+ actions + `children`. `InferVaryOrMatch` loses its vary branch and
becomes `ParseRoute` only; everything else a body needs, it READS,
and the hook return types carry the information (`cookie():
string | undefined`, `searchParam(): string | null`, …). Two typing
upgrades land with the migration:

- **Typed `match()` hook**: `match<P extends string>(pattern: P):
  Prettify<ParseRoute<P>> | null` (and a `URLPatternInit` overload
  returning `Record<string, string> | null`). Inline pattern reads get
  the same param typing the `match` OPTION enjoys today —
  `const { slug } = match("/p/:slug") ?? {}` is fully typed.
- `searchParam(name, fallback: string): string` convenience overload,
  so the ubiquitous `?? ""` reads as a default, not a null-dance.

Net: `typeof Spec.props` and `PartonProps<V>` survive unchanged in
shape; `V` just stops including vary keys. The prop bag becomes
"what the placement gives you" (params, cells, actions, children);
"what the request tells you" moves into the body as reads — which is
the honest split.

**(b) `schema`'s second argument** (the parton vary output, used to
bind cells from request-derived params). Dissolved directly: `schema`
runs inside the parton frame, BEFORE the fp, so tracked hooks work in
it and fold lag-free — a schema that needs `q` reads
`searchParam("q")` itself instead of receiving vary's copy:

    // before
    vary:   ({ search: { q = "" } }) => ({ q }),
    schema: (_f, vary) => ({ results: stageCell(vary.q) }),
    // after
    schema: () => {
      const q = searchParam("q") ?? ""
      return { q, results: stageCell(q) }
    },

The spike converted `Stage2`/`Stage3` (pokemon.tsx) and
`MagentoProducts` this way; the 2nd parameter (and its `as`-cast
wart — TS can't thread a sibling callback's return) can be deleted
with `vary`. Longer term the `schema` option itself dissolves into
inline `localCell` + body reads (server-hooks.md §3, already landed
for forms-demo), but that's a separate, later step — vary removal must
not wait for it.

**(c) Actions' partition binding.** `partonVaryForActions` (=
vary's output) is baked into every `ResolvedAction` ref; the dispatcher
re-runs the registered schema callback against it to resolve cells in
the action request. Hooks-world: the baked partition reduces to match
params (`varyResult = {...params}` when no vary), and the dispatcher
gains what the render already has — **a stamped `CurrentParton`**
(id = the bound parton id, request = the action's own request, params
re-derived by running the spec's `match` against it, fresh
`tags`/`deps` sets that go nowhere). Then tracked hooks inside a
schema callback (or inline-cell `vary`) read the ACTION's request —
which is strictly more correct than replaying render-time values: the
action sees the caller's current cookies/session, exactly like
inline-cell partitioning already re-derives per-session slots
(`inline-cell-action.rsc.test.tsx`). What remains baked in the ref is
only the match-param record (the action must know WHICH variant's
cells to resolve even if the POST URL doesn't carry the route). This
is small framework work, listed in the migration (the spike didn't
need it — none of the converted specs declare `actions`).

**(d) — the fourth, internal consumer.** `block()`
(runtime/cms-block.ts) composes an `augmentedVary` that folds the
resolved CMS content hash into the spec's fp and propagates the user
vary's null. This is framework-owned and migrates with the same tools
it gives authors: the content hash becomes a tracked dep recorded in
the block's schema phase (a `cms:<contentKey>` dep kind whose
`evalDepKeys` branch re-reads the content-store row hash — the CMS
prerender/catalog already keeps a sync-readable copy), or, simpler, a
schema-phase `tag(cms:<contentKey>)` + invalidation bump on publish.
Decide during migration; either is lag-free because block schema runs
pre-fp.

## 4. The wrapper-vary rule — dissolved, with one honest residue

The rule (CLAUDE.md): *"Wrapper specs need a `vary` that captures
their descendants' URL deps, otherwise fp-skip on the wrapper blocks
descendant re-renders."*

**Within a route bucket: dissolved — provably.** A wrapper's fp folds
`computeDescendantFold`, whose contributions re-run each registered
descendant's `match` + re-read its stored dep keys against the CURRENT
request. Any URL/cookie/header/session change that would change a
registered descendant's output moves the wrapper's fp, so the skip is
declined and the descendant re-renders. This holds for declared vary
(the fold re-runs it) and for tracked reads (store-and-reread), is
byte-covered by the trailer for the cold→warm drift, and is probed
behaviorally: `auto-tracked-vary.rsc.test.tsx` shows a wrapper
fp-skipping while its hook-reading child's cookie is stable and
rendering fresh the moment it changes. The reference doc's
"Transitive fingerprint propagation" section already states this;
what auto-tracking adds is that it extends to reads the wrapper's
author never declared anywhere.

**Across route buckets: the residue.** Snapshot records are keyed by
(scope, routeKey), where routeKey = the set of registered URLPatterns
matching the URL. A navigation that flips any spec's match-gate is BY
CONSTRUCTION a routeKey change (the match set is the routeKey), and
the first visit to a new bucket has an empty fold base — the wrapper
computes a dep-less, fold-less fp that can collide with the fp the
client cached in the OLD bucket. That collision is exactly what the
wrapper-vary rule papered over (`vary: ({pathname}) => ({pathname})`
made the wrapper's OWN fp move). The spike's cold-record gate closes
it without the hand-fold: a first visit to an uncommitted bucket has
`priorSnap == null`, so a spec with tracked-read evidence declines the
skip and renders (over-fetch, never stale) — probed by the
cross-bucket test. Specs with provably-empty read sets (the
`"depless"` evidence) keep the cross-bucket skip, which is the
load-bearing UX case (`/inspect` ↔ `/inspect/p/3` keeping the base
grid cached).

So: **the rule dissolves.** No wrapper declares a URL surface for its
descendants' sake. What replaces the rule is not another authoring
rule but a framework guarantee: same-bucket changes ride the fold;
bucket transitions ride the gate (first visit renders, then the bucket
is warm). A wrapper that GENUINELY consumes the URL (renders the
wildcard tail) reads `pathname()`/`match()` like any other dependency
— that's not the rule surviving, that's just a read being a read. The
CLAUDE.md spec-authoring bullet gets deleted in the migration commit;
its replacement is the tracking-invariant contract from §2.

## 5. `vary`-null and the match gate

`match` **stays**. It is not part of `vary`'s job being replaced: it
chooses *which instance* (variant identity via matchKey, route buckets
via routeKey, typed params via ParseRoute) and is the declarative,
pre-render gate that keepalive parking is built on. Hooks replace the
*what does it show* axis only.

`vary → null` today means "matched, but don't render — park my cached
variants" (skip-semantics case 2: hidden Activity + placeholder per
cached matchKey, NO snapshot registration, NO fp emission). Its uses
are value-conditional gates the match pattern can't express (`if (page
> pages) return null`). Hooks-world replacement, two tiers:

- **`return null` from Render** — for "render nothing" WITHOUT park
  semantics. The spec registers (deps recorded, fp emitted, labels
  live), emits an empty body. This is strictly better tracking-wise
  (the null-decision's reads are recorded, so the fold un-parks
  ancestors correctly) and is already the norm — `SearchBody` returns
  null when `?search` is absent today. Cost: the client's cached
  variant is replaced by the empty body rather than parked; fine for
  bodies that are cheap to restore.
- **`park()` — a schema-phase hook** (to build, migration phase 1) —
  for real park semantics. It must fire BEFORE the fp/boundary
  emission (the parked path returns `emitParkedKeepalive` INSTEAD of a
  boundary), and the schema phase is exactly the pre-fp,
  parton-stamped slot for it. Shape: `park()` throws a branded
  `ParkSignal` the wrapper catches (throw, not sentinel-return, so it
  composes under helper functions and early exit is unconditional):

      // ListPagePartials, migrated
      schema: () => {
        const pages = Math.max(1, Number(searchParam("pages")) || 1)
        if (page > pages) park()
        return { page, isFirst: page === 1 }
      }

  Un-parking needs no snapshot or fp: the spec component executes its
  match+schema phases on EVERY parent render pass (only Render is
  skipped while parked), so the park decision re-evaluates per request
  from live reads, just as vary-null re-evaluated per request. Reads
  made before `park()` need no dep record for correctness — parked
  emission carries no fp to be wrong about.

The parked-vs-empty distinction is the real design content here:
vary-null conflated "no data" with "park me", and authors picked
whichever vary could express. Hooks-world makes it an explicit choice
between `return null` (cheap, tracked, replaces content) and `park()`
(pre-fp, preserves parked client state).

In-repo vary-null users to migrate onto `park()`:
`ListPagePartials` (pokemon.tsx) and `ChatMessagePartial`
(chat-overlay.tsx), plus `block()`'s user-vary-null propagation (§3d).
(`docs.tsx` is a different migration case worth flagging: its vary
does `statSync` — an UNTRACKED input folded as a vary value. Hooks
give it an honest home: fold the mtime via `tag(doc:<path>)` + a
revalidate on write, or a dedicated dep kind, rather than re-statting
per fold.)

## 6. Migration path

**Phase 0 — landed (incl. this spike).** Full request-dimension hook
surface; store-and-reread own-fp fold; descendant-fold + trailer
mirrors; cold-record gate; inline localCell + action enumeration;
conversions proving each category (cookie, search-param,
search-param+cache, wrapper+descendants, schema-2nd-arg) with both
test tiers green. Coexistence is additive: a spec that declares `vary`
is byte-identical to before; a spec that doesn't and tracks nothing is
byte-identical too (empty dep set folds `""`).

**Phase 1 — framework prep (each additive, individually testable).**
1. `park()` schema-phase hook (§5) + `Park` branded signal.
2. Wake hooks `expires()`/`staleUntil()` (+ `time()`), live wake box
   on the boundary; then drop `stripReservedVaryKeys` with vary.
3. Action-dispatch parton stamping (§3c): synthetic `CurrentParton`
   around `resolveSchemaForAction`, partition baking reduced to match
   params.
4. Byte-cache write-key deferral (§2c), retiring the
   "reads-in-schema for `cache:` specs" convention.
5. Render-phase `tag()` dep-ride (server-hooks.md §1).
6. `block()` off `augmentedVary` (§3d).
7. Typed `match()` hook + `searchParam` default overload (§3a).

**Phase 2 — the one coherent change** (the author's
land-it-as-one-unit workflow):
- Convert every remaining `vary` in `e2e-testing` (~15 specs:
  header/search wrappers, list pages + load-more via `park()`,
  streaming-demo's `expiresAt` via wake hooks, chat overlay,
  remote-frame demos, docs).
- Delete: the `vary` option + `VaryScope` + `InferVaryOrMatch`'s vary
  branch; `stripReservedVaryKeys`; the spec-catalog `vary` field and
  `descendantContribution`'s vary re-run branch (contributions become
  pure params/deps/inv re-reads); `partonVaryForActions`;
  `parseVaryKey`/varyKey plumbing that only existed to re-run vary
  (snapshot `varyKey` stays as the params record).
- The gate's first disjunct (`opts.vary != null`) disappears —
  record-or-depless-evidence for everyone.
- Addressability: `addressable` is currently `selector || vary ||
  schema || match`. Vary-conferred addressability becomes an explicit
  `selector` (the spike's conversions set one equal to the
  auto-derived name, keeping ids and wire behavior identical — same
  recipe for the rest).
- Docs: rewrite `docs/reference/partial.md` (options table, skip
  semantics, "vary chooses what it shows" → "reads choose what it
  shows"), CLAUDE.md spec-authoring rules (wrapper-vary bullet out,
  tracking-invariant contract in), `docs/internals/render-pipeline.md`
  + `cache-internals.md`; archive this note and server-hooks.md into
  the reference entry.
- Both tiers green; one commit.

**End-state API** — a spec is a Render plus placement options only:

    const Stage = parton(
      async function StageRender({ results, q }: typeof StageB.props) {
        // reads ARE the dependency surface
        const compact = cookie("layout") === "compact"
        …
      },
      {
        match: "/search",            // which instance (identity, typed params)
        selector: "#stage",          // addressability / refetch labels
        schema: () => {              // framework-resolved deps (pre-fp reads)
          const q = searchParam("q") ?? ""
          return { q, results: searchCell.with({ q }) }
        },
        cache: { maxAge: 60 },
        actions: { … },
      },
    )

Out of scope, explicitly: cell `vary` (the partition callback on
module/inline cells) is a DIFFERENT contract — re-derivable
partitioning, evaluated in both render and action contexts — and
stays. Whether it should be renamed `partition` once parton-vary is
gone (freeing the word) is an open question below.

## 7. Perf — the fold, with deps instead of vary

The warm-tick bench attributes the superlinear scaling to the O(tree)
fold tax (bench/README.md — fingerprint/fold + Flight encode dominate;
depth scenario D ∈ {1,4,16} measures exactly the fold's
prove-unchanged cost). Comparing per-contribution cost:

- **Declared vary**: build a full `VaryScope` (URL parse, cookie
  parse, headers→record, session+time surfaces), run the author's
  callback, strip reserved keys, `stableStringify` the result. Twice,
  really — once in the live fold, once in the trailer mirror.
- **evalDepKeys**: sort the (tiny) key list; per key a direct lookup
  (cookie map, `searchParams.get`, header get, cached-compile
  URLPattern exec, `queryMatchingTs`). No author code, no result
  stringify. It currently re-parses the URL + cookies per call — an
  easy per-request memo, since the inputs are (request, keys).

So auto-track is at worst comparable and typically cheaper per
contribution. The structural difference is bigger than the constants:
**a dep record is data, an opaque callback is not.** Three
optimizations become available that `vary` categorically blocks:

1. **Per-request dep-value table.** All dep keys across all snapshots
   draw from one small value space (`cookie:x`, `search:q`, …).
   Evaluate each distinct key ONCE per request into a table; every
   contribution is then string concatenation. vary can't share work
   across specs — every callback is its own world.
2. **Cross-request contribution memoization.** A contribution is a
   pure function of (snapshot identity, dep values, inv-ts). With the
   value table, `depsKey` strings are cheap equality handles — a tick
   that changed one cell's ts can reuse every untouched contribution
   from the previous tick. The live-tick fold cost trends toward
   O(changed deps), not O(tree).
3. **Inverted dep index** (dep key → dependent snapshot ids), the
   classic fine-grained-reactivity structure — a cookie change knows
   its dependents without walking snapshots at all. This is the road
   the bench's depth curve wants.

None of this is spike work; it's why the migration IMPROVES the
warm-tick story rather than taxing it. The one regression to watch:
the multi-fp client pool (`?cached=` carries cold+warm per id) grows
by one entry per hooks-spec cold render; the client's existing
prune-to-live-tree keeps it bounded.

## What the spike proved

- A hooks-only parton matches its declared-vary twin's observable
  lifecycle: stable fp ⇒ fp-skip; changed read ⇒ fresh render — with
  the single documented divergence (cold fp lags one render; trailer
  ships the drift in-response). (`auto-tracked-vary.rsc.test.tsx`)
- The descendant fold un-skips an ancestor purely from a nested
  spec's tracked read — the wrapper-vary rule's same-bucket half is
  gone in practice, not just in argument.
- The cold-record hazard is real (reproduced as a failing behavior
  before the gate: dep-less fp collision across a registry clear and
  across route buckets) and the gate + depless-evidence closes it
  without sacrificing the `/inspect` drawer-stack skip.
- The dep-value encoding must be injective over null-ness ("absence is
  a value" above) — a genuine parity bug the declared twin didn't have,
  found by the converted search dialog's e2e suite and now locked in by
  an rsc probe.
- Real conversions hold up end-to-end (search dialog family incl.
  frame scope, magento header cookie → cart-badge flow, cached product
  grid) against the e2e suite.

## Open questions (author input wanted)

1. **`park()` shape** — throw-a-branded-signal from `schema` (proposed)
   vs a sentinel return vs keeping a tiny sync `gate:` option. Throwing
   from schema is the only shape that needs no new option and stays
   pre-fp; confirm before phase 1.
2. **Gate scope after vary dies** — the depless-evidence carve-out
   keeps cross-bucket/cold skips for read-free specs. Acceptable to
   ALSO decline those (simpler rule, one more over-render per bucket
   per process) or is the `/inspect`-style UX worth the evidence scan?
   (Scan is O(variants of one id), memoizable; I'd keep it.)
3. **Cell `vary` naming** — once parton-vary is gone, rename the cell
   partition callback to `partition` (clearer, frees `vary` from two
   meanings), or leave as-is to avoid churn?
4. **Byte-cache write-key deferral (§2c)** vs keeping the
   "request reads for `cache:` specs live in `schema`" rule
   permanently. The rule is simple and self-documenting; the deferral
   removes a footgun. Both are sound.
5. **`header()` granularity** — fold the raw header value (current)
   or normalized derivatives (e.g. parsed `accept-language` primary
   tag) to avoid fp churn from q-factor noise? Could be a userland
   helper over `header()`; flagging because it decides whether the
   framework ships opinionated readers.
6. **Typed `match()` hook now or at migration** — it changes a public
   signature (`Record<string,string> | null` → `ParseRoute<P> | null`);
   landing it early gives conversions better types, landing it late
   keeps phase 1 smaller.
