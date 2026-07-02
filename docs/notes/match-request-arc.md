# match-request arc — landing checklist + open regression

Status: **built, unmerged.** Branch `match-request` (8 commits on top of
`72e48e0`). Everything is green EXCEPT a probabilistic regression in the
search overlay, which blocks the merge.

## What the arc contains (all committed, unit tiers green)

1. `757461b` — match gates the Request: per-field predicates +
   `searchParams`/`cookies`/`headers` record gates; original-header
   rule; URL-pattern half owns route keys/params/404.
2. `f878304` — park() dissolved into match (list pages + chat messages
   are predicate gates; miss parks).
3. `317c59b` — `cell.resolve(args?)` in-body resolution + public
   `atomic()` (transactional storage overlay: one wake, rollback).
4. `a6b2c4a` — every app parton converted off `schema`/`actions`
   (forms-demo = plain-server-function proving ground).
5. `6c06251` — `schema` + `actions` + `usePartonAction` + both
   parton-actions modules + inline action registry deleted;
   addressable = selector || match.
6. `898e2c4` — registry freshness guard (`_seq`): late commits from
   long-lived connections no longer clobber fresher dep records.
7. `a0cd1b0` — `fpSkip: false` option; editor chrome opts out of
   client-cache serving (its links embed the full URL). cms-edit 42/42.

## The blocking regression

`search-streaming.spec.ts:11` (and, likely related,
`search-result-ordering.spec.ts:48`, `remote-frame-crossorigin.spec.ts:172`)
fail ~50% of runs on this branch; master is 6/6 green on the same spec.

Signature: on `/pokemon/1?search=url&q=a`, after full hydration, checking
the `streaming-toggle` checkbox "does not change its state" — the toggle
is plain client `useState`, so a reset means its owning subtree
REMOUNTED at click time: a concurrently landing payload/lane commit
produced a tree whose identity differs from the mounted one
(Activity/keyed-wrapper identity is the usual suspect).

What's been ruled out: the deletion diff is surgically clean
(cell-client batcher intact, renderProps assembly untouched,
deriveMatchKey logic equivalent under CompiledMatch — verified line by
line); the freshness guard and fpSkip are off-path for this page.
Bisect attempts mislead because the failure is probabilistic —
verify any hypothesis with `--repeat-each=3` minimum.

Prime suspects, in order:
- matchKey instability for specs under the `*q=:query` search-pattern
  ancestor across live-connection segments vs navs (keyed `<Activity>`
  remount on key drift).
- The SearchArea stage conversion (`pokemonSearchCell.resolve(stageArgs(n, q))`
  in bodies) interacting with the whole-tree keepalive-reopen segment:
  a reopen commit racing the click.
- The `?cached=` pool shape post-conversion (search-result-ordering's
  bounded-pool failure may be the same root observed statically).

## Remaining before merge (in order)

1. Root-cause + fix the remount race; get search-streaming to 10/10.
2. Full `yarn test` + `yarn test:e2e` at retries:0; flake-census rules.
3. Docs rewrite (agent brief drafted): partial.md constructor
   `{ match, selector, cache, defer, fallback, keepalive, fpSkip }`,
   match-gates section, cells.md resolve()/atomic(), CLAUDE.md
   authoring rules, block.md (block schema stays), internals.
4. Merge to master, final gates, remove worktree, archive this note.
