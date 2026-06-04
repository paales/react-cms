# Server hooks

Status: active. Foundation landed (`getCurrentParton`, `tag`); the rest is a
staged plan with open architectural decisions flagged per step below.

## Thesis

The server-context patch — a per-component `AsyncLocalStorage` the Flight
render site enters per component, riding React's task graph (see
[`../internals/server-context.md`](../internals/server-context.md)) — gave
Server Components a value that flows down the render tree, survives `await`,
and isolates siblings. `createServerContext` was the first use (downward
*provision*). This note is the second: **server-hooks** — free functions,
called anywhere in a parton's render, that read or register against the
*current parton* via the same ALS. It's the client-hook ergonomic
(`useState`-style ambient binding) on the server, without the rules-of-hooks
fragility — every server-hook is explicitly keyed, never positional, so it's
safe in conditionals, loops, and after awaits.

## Why now — the 2d607fc reversal

An earlier version had exactly this: `<Partial>` + "tracked accessors" that
auto-derived a parton's dependency surface from what it read. It was abandoned
(commit `2d607fc`) for ONE reason: the tracker pointed at "the current partial"
through a request-level cell that **drifted across awaits and under sibling
interleaving** — the framework couldn't reliably attribute a read back to the
parton that did it. The fix was to move reads into an explicit, eager, pure
`vary` callback and the module-scope `parton(Render, options)` constructor,
which made attribution unnecessary.

The per-component ALS makes attribution **reliable** — a read lands on the
right parton before/after any await, and siblings don't cross-contaminate
(probed in `current-parton.rsc.test.tsx`, the exact drift case). So the reason
for the explicit era is gone and the tracked direction is open again, on a
sounder mechanism.

## The mechanism — `getCurrentParton`

`framework/src/lib/current-parton.ts`. The parton wrapper stamps its own
effective id (plus a per-render tag accumulator) onto the rendering task;
`getCurrentParton()` reads it back. Rides the same `__partonStorage` ALS the
server-context reader uses — no new ALS, no patch change. Unlike
`createServerContext` (a provider scopes DESCENDANTS and deliberately never
reads its own overlay), this is read-your-OWN-value, so it's a direct task
field, not a context entry, and is not inherited by descendant tasks — each
parton stamps its own; a non-parton child reads `undefined`.

## The two-axis fingerprint model

A parton's fp already folds two kinds of dependency. Server-hooks populate both
ambiently instead of via the `vary` / `selector` declarations:

- **Derived inputs** — `cookie` / `session` / `param` / … . Re-evaluated from
  the request every nav; their VALUES fold in (`|vary=`); a value change
  re-renders. Re-derivable, value-compared. (Today: `vary`.)
- **Tags** — `tag(name)`. NOT re-derived, NOT value-compared; a write-only
  subscription whose bump-TIMESTAMP folds in (`|inv=` via `queryMatchingTs`).
  Only an explicit `revalidate(name)` moves it. (Today: `selector`, but static;
  `tag()` is per-render dynamic — e.g. a GraphQL `__typename:id` entity key.)

The fp FORMULA is unchanged (`partial.tsx` ~1612). Server-hooks only swap the
front door from declarations to ambient calls.

### Fold the tag, not the value

A tag is a pure revalidation target — it deliberately does NOT carry the
fetched value into the fp (the value isn't re-derivable later anyway). Read
side: `tag()` the entities a query touched (`Cart:1234`). Write side: a
mutation `revalidate()`s the entities it changed. GraphQL is free here —
`__typename + id` is the entity key. This is the Apollo/Relay
normalized-invalidation model, applied to RSC fp-skip rather than a client
cache. Open knob: granularity (tag the root entity only, or every entity
reachable in the response).

## Direction split — what this does and does NOT change

- **Downward** (ancestor→descendant, known before the descendant renders):
  server-hooks + `createServerContext`. This is what's unlocked.
- **Upward** (descendant→ancestor fp): unchanged. Still the fp-trailer (warm
  descendant fold). Server-hooks are downward-only and do not eliminate it.
- **Auto-track is reactivity**, and its cost/benefit flips across the dynamic
  range: a warm long-lived process amortizes and fp-skips cheaply; a cold/edge
  process can't fp-skip a variant it never rendered, so it degrades to a full
  render — an OVER-FETCH, never stale (fp-skip needs a positive fp match;
  missing state → render). So "survive a process switch losslessly" is a later
  shared-store optimization, not a correctness requirement.

## Decision rule — where a downward value lives

- Request-invariant (whole request/process) → request ALS
  (`runtime/context.ts`): the Request, scope, capability.
- Per-subtree, known before render → `createServerContext`: theme, locale,
  principal, the parton parent.
- Must move cache identity / re-render on change → fold into the fp: derived
  inputs (`vary` / tracked reads) and tags (`selector` / `tag()`).
- Known only after render (bubbles up) → fp-trailer. Intrinsic.

## Decision (2026-06-04)

`parton()` stays a module-scope **constructor** — NOT a runtime `<Parton>`
component. This keeps the spec catalog populated at module load, so cold
reconstruct (`partialFromSnapshot` → `componentById`) and the action dispatcher's
schema lookup keep working untouched; the §4 reconstruct kernel below is moot.
What moves *out* of the constructor's options is `vary` and `localCell`/`schema`
— their reads become tracked server-hooks inside `Render`, folding into the fp
via the dep-record + store-and-reread.

## Status

- ✅ **Self-context** (`getCurrentParton`) — commit `e927c5a`. Probe
  `current-parton.rsc.test.tsx`: own-id survives an await, a nested child reads
  the child not the parent, staggered siblings stay isolated (the drift case).
- ✅ **`tag()` + fp-fold** (schema phase) — commit `aee88b0`. Folds into
  `expandedLabels`; a `refreshSelector(name)` shifts the fp; byte-identical for
  any spec that doesn't call it. Probe `tag-fp.rsc.test.tsx`.
- ✅ **Tracked-read hooks** (`cookie()`, `searchParam()`) — own-fp fold via
  store-and-reread (a render's recorded dep keys re-read at the next render's
  fp). A tracked read moves the fp like a `vary` axis; a spec that never tracks
  is byte-identical. Probe `tracked-reads-fp.rsc.test.tsx`. Own fp only — the
  descendant fold (§1), cells (§3), and the migration (§5) follow.

All kept internal (not in the public barrel) — no app consumer yet.

## Roadmap

§4 is resolved (constructor stays). The rest is additive — each step is a no-op
for specs that don't opt into the new hooks, so existing specs + e2e stay green
throughout, and the `vary`/`schema` removal is the final migration step (§5).

### 1. Descendant fold for tracked reads + render-phase `tag()` — NEXT
Own-fp store-and-reread landed (the tracked-read hooks above; deps stored on the
snapshot as a live Set, re-read at the next fp). Two pieces remain: **(a)
descendant fold** — `descendantContribution` must re-evaluate a descendant's
stored `deps` (additive: present → fold via `evalDepKeys`, absent → today's
`vary` path), so an ancestor's fp reflects an auto-tracked descendant's reads.
Until this lands, auto-tracked specs are correct standalone but not fold-covered
*under a wrapper* (no in-tree caller yet). **(b) render-phase `tag()`** — `tag()`
folds in the schema phase today (before the fp); a render-body tag rides the same
dep-record store-and-reread. Both additive, both testable in isolation.

### 2. Auto-tracked vary (`vary` becomes implicit)
Reads via tracked hooks (`cookie()`, `session()`, `param()`, cells) accumulate
the dependency surface; `vary`'s bail role becomes a plain early `return` in
Render. **Decisions:** (a) value→label fold for cells (don't resolve a cell to
compute the fp — check its version/label, so a nav can fp-skip without the
GraphQL round-trip the schema phase does today); (b) the stateless-cold-skip
tradeoff — a captured/generated vary is STATEFUL (a cold process must render),
an explicit vary is request-reproducible — but it degrades to over-fetch (full
render), never stale, so it's a perf cost not a correctness one. **Decided:**
`vary` is removed (§5), tracked hooks replace it; the cold/edge case just
re-renders.

### 3. Inline `localCell` (server-hook cells)
Inline `const x = localCell('k', …)` in Render removes the `schema` callback —
but the schema callback is the **replayable shape** the action dispatcher
re-runs WITHOUT a render (`resolveSchemaForAction`, `parton-actions.ts`) to
resolve a parton's cells. Since the constructor stays (§4 resolved), the action
has the Component in the catalog and can **re-render the parton to enumerate its
cells**, OR inline cells **register a `(key, partition, shape)` record into the
snapshot** at render-time that the action reads back. **Decision:**
re-render-to-enumerate vs snapshot cell-record (the latter avoids a render but
adds a durable record). The partition source moves to an ambient
`session()`-style read. forms-demo is the migration target once this lands (its
`save` action is exactly the enumeration consumer).

### 4. `<Parton>` component (retire the constructor) — RESOLVED: constructor stays
Decided (see Decision above): `parton()` remains a module-scope constructor, so
the catalog stays module-load-populated and cold reconstruct
(`partialFromSnapshot` → `componentById`, `descendantContribution`,
`deriveMatchKey`) keeps working untouched. The placement-identity / "Abolish id"
direction — and its cross-process Component-reference kernel (whether plugin-rsc
mints stable refs for an arbitrary server function) — is set aside. Identity
keeps coming from the constructor's derived id + per-placement prop hash, which
is already deterministic and cross-process stable.

### 5. Migrate specs off `vary`/`schema`, then remove the options
Once §1–§3 land, migrate every spec's `vary` reads to tracked hooks and its
`schema` cells to inline `localCell`, then drop the `vary`/`schema` options from
the constructor. This is the behavior-changing, every-spec step — done last,
each spec validated against both test tiers.

## Non-goals
- Eliminating the fp-trailer (upward; intrinsic).
- A runtime `<Parton>` component / placement identity (§4 — constructor stays).
- Patching global `fetch` for tracking — opt-in wrappers only; raw `fetch`
  stays the no-reactivity escape (an untracked read just doesn't reload on
  nav, a fine default).
