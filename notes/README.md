# Notes index

Active design notes that still reflect the current codebase. Historical
design documents and debugging sessions live in `/archive/README.md`.

## Current

| File                          | What it covers                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PARTIAL_ARCHITECTURE.md`     | **North-star doc.** The one-paragraph goal, what follows from it, the mental model for server/client state and request lifecycle, and an implementation-status table tracking the convergence of the code against the goal. Read this first.                                                                                                                                                                                     |
| `AUTO_TRACKED_CACHE_KEYS.md`  | Auto-derived cache keys via tracked request accessors (`getCookie` / `getHeader` / `getSearchParam` / `getRoute`) with a Cache-Control-shaped `cache` prop (`{maxAge, staleWhileRevalidate, vary?, bypass?}`). Accessors hoist like React hooks; conditional reads throw `HoistingViolationError`. **Status: implemented.** Predecessor design notes are in `/archive/` (`SERVER_CACHE_NOTES.md`, `PARTIAL_CACHE_DESIGN.md`). |
| `LESSONS_2026-04-19.md`       | Latest session — removing `seedRegistry` and `buildTemplate`, the Flight-composite key problem on placeholders, `cloneElement` can't drill through wrappers, `startTransition` + slow children = invisibly-stale UX, "stash + checkout" to tell regressions from pre-existing.                                                                                                                                                   |
| `LESSONS_FROM_REFACTOR.md`    | The 2026-04-18 unified-path refactor — `als.enterWith` vs `als.run`, conditional Suspense wrap, prop-based wrapper detection, `partialId` vs `node.key`, test-mock reset pattern. Side notes updated 2026-04-19 for what's since shipped.                                                                                                                                                                                        |
| `LESSONS.md`                  | Earlier refetch-mechanics lessons (2026-04-16 → 2026-04-17) — bare-key Suspense reconciliation, fingerprint-based skip, flipped transition default, Flight serialization losing implicit keys. Pairs with `LESSONS_FROM_REFACTOR.md`.                                                                                                                                                                                            |
| `DYNAMIC_PARTIAL_REGISTRY.md` | Why the route-scoped registry exists, how `<PartialBoundary>` populates it during render, how `refreshRegistry` / `clearRoute` keep it in sync, how `<PartialRoot>` consults it on refetch. Updated 2026-04-19 (`seedRegistry` removed).                                                                                                                                                                                         |
| `DEFER_ACTIVATORS.md`         | `<Partial defer>` + the `useActivate` primitive. Three defer modes (unset, `true`, single activator), activator contract, state-source interaction. Reference activators (`<WhenVisible>`, `<WhenStored>`) live in userspace at `src/app/components/`.                                                                                                                                                                           |
| `SERVER_ISOLATION.md`         | Audit of module-scoped mutable state across `src/lib` + `src/framework`. Categorizes every `let` / `Map` / `Set` as client-only, intentional shared, or ALS-scoped. **No request-scoped leaks today** — doc sets the rule for future additions.                                                                                                                                                                                  |
| `CACHE_SCOPING.md`            | Short reference: the three storage tiers (`<Cache>` bytes = global, registry = route-scoped, client `_cache`/`_template` = per-tab). What counts as a "route" on each side (pathname vs pathname+search). Scaling on high-cardinality routes (50k products) — `getPathname(pattern)`, LRU cap, structure/data split. Eviction table.                                                                                              |
| `IDEAS.md`                    | Forward-looking backlog — lazy partials, prefetch links, event hooks, `_cache` pruning, per-partial opt-out. Resolved ideas are retained with a "RESOLVED" banner pointing to where the work landed.                                                                                                                                                                                                                             |

## Archive

`/archive/` holds design proposals that shipped, debugging sessions whose
insights are folded into the current lessons docs, and the original
project plan. Useful as historical context; do not consult for
how-the-code-works-today. See `/archive/README.md` for an index.

## Also load-bearing

- `../CLAUDE.md` — project instructions (authoritative for the
  `<Partial>` / `<PartialRoot>` API and the GraphQL data layer).
- `../proxy-design/README.md` — the legacy proxy data layer. Not wired
  into the app; kept for reference.
