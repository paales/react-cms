# Server hooks

Status: active. Foundation landed (`getCurrentParton`, `tag`); the rest is a
staged plan with open architectural decisions flagged per step below.

## Thesis

The server-context patch — a per-component frame in an `AsyncLocalStorage` the
Flight render site enters per component, carried to descendants by a
`createTask` snapshot (see
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
  is byte-identical. Probe `tracked-reads-fp.rsc.test.tsx`.
- ✅ **Descendant fold + trailer mirror** — `descendantContribution`
  (`partial.tsx`) re-reads a descendant's stored deps, and the fp-trailer's warm
  recompute (`recomputeFpWithFold` + its own fold, `fp-trailer.ts`) mirrors it —
  so an ancestor's fp moves when a nested auto-tracked spec's reads change, and
  the cold→warm drift ships the deps-bearing warm fp (the cold fp has no prior
  deps, so without the mirror an auto-tracked spec could never fp-skip). Both
  additive. Descendant-fold probe in `tracked-reads-fp.rsc.test.tsx`; e2e green.

With this, **auto-tracked request reads are a complete `vary` replacement** —
own fp, ancestor fold, and warm-fp drift all handled. Cells (§3) and the
migration (§5) remain. All kept internal (not in the public barrel) — no app
consumer yet.

## Roadmap

§4 is resolved (constructor stays). The rest is additive — each step is a no-op
for specs that don't opt into the new hooks, so existing specs + e2e stay green
throughout, and the `vary`/`schema` removal is the final migration step (§5).

### 1. Render-phase `tag()` — remaining
The descendant fold + trailer mirror landed (above), so tracked *request reads*
are complete. What's left from the original §1 is render-phase `tag()`: `tag()`
folds in the schema phase today (before the fp); a render-body `tag()` lands
after the fp and rides the same dep-record store-and-reread the tracked hooks
now use (record on the live Set, fold the prior render's set at the next fp).
Small, additive, and the same shape as `cookie()`/`searchParam()` — the entity
tags a GraphQL response yields (`__typename:id`) would be recorded here.

### 2. Auto-tracked vary (`vary` becomes implicit)
Designed in full — surface, cold semantics, the three non-fp roles, the
wrapper-rule dissolution, `park()`, migration phases, perf — in
[`auto-tracked-vary.md`](./auto-tracked-vary.md). The spike alongside it
landed `header()` + `pathname()` (completing the VaryScope read surface),
the cold-record fp-skip gate (`committedDepsEvidence` — what makes
"cold degrades to over-fetch, never stale" mechanically true), and
hooks-only conversions of representative e2e specs. **Decided:** `vary`
is removed (§5), tracked hooks replace it; the cold/edge case just
re-renders (now enforced by the gate, not assumed).

### 3. Inline `localCell` (server-hook cells)
**Increment 1 landed** (read + client-write): `const v = await localCell("k",
{…})` in Render resolves against the calling parton (id `<partonId>/<key>`, via
the self-context), folds its invalidation into the fp through the dep-record (a
`cell:` branch in `evalDepKeys` — the cell's timestamp is its "value", reusing
the `cookie()`/`searchParam()` store-and-reread), and returns a `ResolvedCell`
whose `.set` writes from the client. Added as an overload of `localCell` (string
first arg → inline; object → the existing module form). Additive — the
schema-callback cell path is untouched. Probe `inline-localcell.rsc.test.tsx`.

Fork decided: **(b) cell-record** (the action reads a record, not a
re-render).

- ✅ **Increment 2 — action enumeration.** At render, `localCell("key", …)`
  records `(key, descriptor, partition)` via `registerInlineCell`
  (`lib/parton-actions.ts`), and `resolveSchemaForAction` reads it
  (`getInlineCellsForParton`, alongside the schema callback) so an `actions`
  handler resolves the cell by key without a render — auto-write, explicit
  handler write, and transactional rollback all behave as they do for a
  `schema` cell. The record lives in a MODULE-GLOBAL registry, **not** the
  per-request snapshot store: the dispatcher runs in a SEPARATE request where
  the render's snapshot isn't visible (the same reason the schema callback is
  registered module-globally). Keyed by the parton's effective id — which
  equals the spec id, and the action's bound id, for a singleton placement
  (forms-demo); consistent multi-instance keying waits on the partition
  rework below. Probe `inline-cell-action.rsc.test.tsx`.
- ✅ **Partitioning** (`session()` + a cell `vary`). An inline cell takes a
  re-derivable `vary: ({session}) => ({sid: session.id})` partition (mirrors
  the module-cell `vary`); the action re-runs it against its OWN request, so
  a per-session cell resolves the caller's slot there, not the last render's
  recorded one. `session()` (a server-hook) folds the session into the fp so
  the parton re-renders on a session change. Crucially, the partition is
  threaded through the inline cell's fp DEP — recorded as the
  partition-scoped selector `cell:<id>?<partition>`, the exact string the
  write fires — so the own-fp fold (`evalDepKeys` → `parseSelector` →
  `queryMatchingTs` with the constraints), the refetch label (the bare
  `cell:<id>` name), and the partition constraint all match a
  partition-scoped write. A partitioned inline cell therefore LIVE-refetches,
  not just persists across a reload. `buildCellSelector` /
  `encodeArgsForSelector` moved to `invalidation-registry.ts` (alongside
  `parseSelector`, their inverse) so the dep and the write share one
  encoding. Probe `inline-cell-action.rsc.test.tsx` (per-session
  re-derivation).
- ✅ **Migration — forms-demo.** Its five `schema` cells became inline
  `localCell("key", { vary: bySession })`; the two-step builder collapsed to
  a single-step `parton(Render, { match, actions })`; `save` resolves the
  inline cells by key (increment 2). e2e `forms-demo.spec.ts` — save commits
  + records the snapshot, notes persist per-keystroke — green. The broader §5
  migration (every spec off `vary`/`schema`) is still the final step.

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
