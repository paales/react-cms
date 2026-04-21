# Partial architecture — the north star

**Last updated:** 2026-04-21 (post `usePartial`/`__inputs` removal; see `NAVIGATE_UNIFIED.md` for the unified client surface)

This is the intended end-state of the `<Partial>` system. It's the
contract the runtime should uphold; the current implementation is
converging on it (see **Implementation status** at the bottom for
what's left).

---

## The goal, in one paragraph

The Partial system is a uniform, fully dynamic rendering primitive:
`<Partial id="…">` can be declared anywhere in the JSX tree — at the
root, nested inside another Partial, or produced deep inside a `.map()`
or any opaque server component — and every declaration is treated
identically, with no structural invariants and no static analysis.
Each Partial discovers itself by running: the moment its body
executes, it registers its content, fingerprint, and tags into a
route-scoped registry. A full request renders the tree once and
streams it to the client, which in a single walk populates a per-id
cache and derives the structural template it will reconcile against
on subsequent refetches. A targeted refetch — triggered by
`useNavigation().reload({ids|tags})`, `useNavigation().navigate(url,
{ids|tags})`, or a server-action invalidation directive — renders
only the requested Partials directly from their registered
snapshots, skipping every ancestor; the client merges the fresh
entries into its cache and re-renders against its persisted
template, so the surrounding layout stays structurally identical
while targeted content swaps in place. State that varies between
refetches flows through URLs (page URL for shareable state, frame
URL for subtree-scoped state) and is read server-side through
tracked accessors — there is no `__inputs` / prop-override channel.
Because every rendered Partial contributes a fingerprint back to
the client — whether it was declared at the root or generated deep
inside a loop — each refetch tells the server precisely what the
client already has, and the server skips anything whose shape
hasn't changed; the skip-on-unchanged optimization applies uniformly
to the entire tree, not just its static roots.

---

## What follows from the goal

**No static walker on the server.** Every decision — render fresh,
emit placeholder, register in the registry — is made inside the
`<Partial>` body when it runs. The old `buildTemplate` /
`seedRegistry` / `refreshRegistry` pre-walks are all gone.

One narrow, non-decision-making walk remains and is load-bearing:

- **`stripPartials` / `reinject`** (`cache.tsx`) walk the subtree
  handed to `<Cache>` to hollow out partial-bearing regions
  before serialization and splice live partial elements back in
  after decode. This is the strip-on-store / reinject-on-return
  composition described in the Caching section of the top-level
  `CLAUDE.md`. This runs on the rendered output, not on author
  JSX — it's a runtime walk, not a static one.

The stale-snapshot problem that `refreshRegistry` used to solve
(snapshots captured in request N have closures from request N, but
request N+1's cache-mode refetch needs the current request's values)
is now handled by ambient-scope folding: the Partial's fingerprint
includes its own frame URL (if any) plus the enclosing frame URL
(if it sits inside a framed subtree), so a refetch against a new
URL yields a distinct fingerprint, a distinct `<Cache>` key, and a
clean miss. Request-varying state reaches descendants through URL
accessors (or scalar props passed down by a parent that reads the
accessor), not through client-supplied prop overrides. See
`NAVIGATE_UNIFIED.md` for the client-side dispatcher and
`/archive/USE_PARTIAL_AND_INPUTS.md` for the predecessor
`fingerprint-after-applyInputs` design.

**One primitive, one rule.** `<Partial>` behaves the same whether
it's at the top of a page, nested inside another Partial, or
generated inside a `.map()`. Authors never have to know whether a
Partial is "static" or "dynamic" — the framework doesn't track that
distinction.

**The client owns the template.** The structural layout skeleton is
derived on the client from the first full-payload render and
persisted in module state. Refetches carry only the refetched
partials over the wire — layout bytes don't repeat.

**Fingerprints cover everything.** Every rendered Partial registers
its fingerprint client-side; the client reports all of them to the
server on every refetch. The server skips unchanged subtrees
uniformly — a deep `.map()` row gets the same fingerprint-skip
treatment as a top-level nav.

**Server work is proportional to what's asked for.** A refetch for
one partial renders one partial. Ancestor components do not
execute; the registry provides the snapshot and the `<Partial>`
body renders it directly.

---

## Mental model

**Server state:** a route-scoped registry of `{id → {content,
fallback, errorWith, tags}}` snapshots. Populated as Partials run;
consulted on refetch.

**Client state (module-level, survives refetch remounts):**
- `_cache`: rendered wrappers by partial id.
- `_fingerprints`: fingerprint by partial id (every Partial, including
  deep ones — populated as wrappers mount).
- `_template`: the structural layout skeleton with placeholders;
  derived on each full-payload render, persisted across refetches.

**Request lifecycle:**

1. **Full request** — server renders the whole tree; Partials
   self-register. Client walks the payload once: populates `_cache`,
   derives `_template`, stores it. Wrappers mount → `_fingerprints`
   fills in.
2. **Refetch** (`?partials=…` or `?tags=…`) — server renders just
   the requested Partials from their snapshots, skipping all
   ancestors. Client merges into `_cache` and re-renders against
   the persisted `_template`. Dispatched client-side by
   `useNavigation().reload()` / `.navigate(url, {ids|tags})` —
   see `NAVIGATE_UNIFIED.md`.
3. **Server action with `{invalidate}`** — server rewrites the URL
   with `?partials=` / `?tags=` and runs the refetch path. If the
   client has no cache, falls back to a full render with
   `__populateCache=1` to seed.

**Skip pipeline:** on every refetch, the client sends `?cached=id:fp`
for every entry in `_fingerprints`. If a requested (or ambient)
Partial's fingerprint matches, the server emits a placeholder
instead of rendering. The client keeps its existing entry.

---

## What does not exist (and why)

- **`buildTemplate` / `seedRegistry`** — pre-render static JSX
  walks that drove rendering decisions. Not needed: the client
  derives the template, and every Partial self-registers at
  render time. (The remaining targeted walks — `refreshRegistry`
  and `stripPartials` — refresh snapshots and rewrite cached
  subtrees; they do not gate rendering.)
- **"Opaque component contains Partial" invariant** — gone.
  `<AppNav/>` can hold a `<Partial>` inside and live anywhere in the
  JSX tree; render-time registration doesn't care about JSX
  topology.
- **Mode distinction** in `PartialsClient` — one code path handles
  both full-tree and partial-list payloads. The shape of the
  payload tells the client which it is.

---

## Implementation status

| Part | Status |
|---|---|
| Route-scoped registry, `<PartialBoundary>` self-registration | ✅ shipped |
| `<Partial>` body handles all decisions at render time | ✅ shipped |
| Client `_cache` + `_fingerprints` populated from rendered payload | ✅ shipped |
| Cache-mode refetch renders from registry snapshots, bypassing ancestors | ✅ shipped |
| `getCachedPartialIds()` reports deep Partials (fingerprint-skip covers entire tree) | ✅ shipped |
| Client-derived `_template`, persisted across refetches | ✅ shipped |
| `buildTemplate` + `seedRegistry` removed | ✅ shipped |
| No "opaque component" invariant; `<AppNav/>` can be declared freely | ✅ shipped |
| Server-side registry cleared at the start of each streaming render (stale-shape safety) | ✅ shipped |
| `refreshRegistry` static walker removed; stale-snapshot correctness driven by fingerprint-after-applyInputs | ✅ shipped (2026-04-19) |
| `usePartial` / `__inputs` / `silentReplace` / `usePartialParams` all removed; single `useNavigation()` surface with `ids`/`tags`/`silent` on `navigate` and `reload` | ✅ shipped (2026-04-21) |
| Stale-snapshot correctness now driven by ambient-frame-URL fold into fingerprint (applyInputs is gone) | ✅ shipped (2026-04-21) |

The architecture in this doc matches the code as of 2026-04-21.
Mode-selection inside `PartialsClient` (`mode="streaming"` vs
`mode="cache"`) is still an internal distinction for merging fresh
payloads into the persisted template — the public contract and the
server's response shape are uniform; only the internal merge path
differs. Unifying the two is cosmetic and deferred.
