# Notes index

Active design notes that still reflect the current codebase. Historical
design documents and debugging sessions live in `archive/`.

## Current

| File | What it covers |
|---|---|
| `LESSONS_FROM_REFACTOR.md` | The 2026-04-18 unified-path refactor — `als.enterWith` vs `als.run`, conditional Suspense wrap, prop-based wrapper detection, `partialId` vs `node.key`, test-mock reset pattern. The authoritative post-mortem for the current Partial runtime. |
| `LESSONS.md` | Earlier refetch-mechanics lessons (2026-04-16 → 2026-04-17) — bare-key Suspense reconciliation, fingerprint-based skip, flipped transition default, Flight serialization losing implicit keys. Pairs with `LESSONS_FROM_REFACTOR.md`. |
| `DYNAMIC_PARTIAL_REGISTRY.md` | Why the route-scoped registry exists, how `<PartialBoundary>` populates it during render, how `<PartialRoot>` consults it on refetch. Updated 2026-04-18 for the unified-path model. |
| `SERVER_CACHE_NOTES.md` | `<Cache>` component design — Flight-buffer round-trip, TTL + LRU + SWR, strip-on-store / reinject-on-return so dynamic Partials inside a cached region stay live. |
| `DEFER_ACTIVATORS.md` | `<Partial defer>` + activator components (`<WhenVisible>`, `<WhenStored>`, `<AnyOf>`) and the `useActivate` primitive. Three defer modes, activator contract, state-source interaction. |
| `IDEAS.md` | Forward-looking backlog — lazy partials, prefetch links, event hooks, `_cache` pruning, per-partial opt-out. Resolved ideas are retained with a "RESOLVED" banner pointing to where the work landed. |

## Archive

`archive/` holds design proposals that shipped, debugging sessions whose
insights are folded into the current lessons docs, and the original
project plan. Useful as historical context; do not consult for
how-the-code-works-today. See `archive/README.md` for an index.

## Also load-bearing

- `../CLAUDE.md` — project instructions (authoritative for the
  `<Partial>` / `<PartialRoot>` API and the GraphQL data layer).
- `../proxy-design/README.md` — the legacy proxy data layer. Not wired
  into the app; kept for reference.
