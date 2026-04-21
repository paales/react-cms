# Notes index

Active design notes that still reflect the current codebase. Historical
design documents and debugging sessions live in `../archive/README.md`.

## Current

| File                          | What it covers                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PARTIAL_ARCHITECTURE.md`     | **North-star doc.** The one-paragraph goal, what follows from it, the mental model for server/client state and request lifecycle, and an implementation-status table tracking the convergence of the code against the goal. Read this first.                                                                                                                                                                                     |
| `NAVIGATE_UNIFIED.md`         | The single client navigation surface — `useNavigation()` with `navigate(url, {ids, tags, silent})` and `reload({ids, tags})`. How page-scope, frame-scope, silent URL writes, and targeted refetches collapse into one handle. Supersedes the removed `usePartial` / `__inputs` / `usePartialParams` / `silentReplace` surface (see `../archive/USE_PARTIAL_AND_INPUTS.md`). |
| `AUTO_TRACKED_CACHE_KEYS.md`  | Auto-derived cache keys via tracked request accessors (`getCookie` / `getHeader` / `getSearchParam` / `getRoute`) with a Cache-Control-shaped `cache` prop (`{maxAge, staleWhileRevalidate, vary?, bypass?}`). Accessors hoist like React hooks; conditional reads throw `HoistingViolationError`. **Status: implemented.** Predecessor design notes are in `../archive/` (`SERVER_CACHE_NOTES.md`, `PARTIAL_CACHE_DESIGN.md`). |
| `DYNAMIC_PARTIAL_REGISTRY.md` | Why the route-scoped registry exists, how `<PartialBoundary>` populates it during render, how `clearRoute` keeps it in sync, how `<PartialRoot>` consults it on refetch. Updated 2026-04-21 for the `__inputs`→ambient-frame-URL fold transition.                                                                                                                                                                                 |
| `DEFER_ACTIVATORS.md`         | `<Partial defer>` + the `useActivate` primitive. Three defer modes (unset, `true`, single activator), activator contract, state-source interaction. Reference activators (`<WhenVisible>`, `<WhenStored>`) live in userspace at `src/app/components/`. Updated 2026-04-21 — `fire()` takes no args; activators that pass state write to a URL first.                                                                              |
| `SERVER_ISOLATION.md`         | Audit of module-scoped mutable state across `src/lib` + `src/framework`. Categorizes every `let` / `Map` / `Set` as client-only, intentional shared, or ALS-scoped. **No request-scoped leaks today** — doc sets the rule for future additions.                                                                                                                                                                                  |
| `FRAME_SCOPING.md`            | Decision note: nested per-subtree scopes use React Context + `use()`, not `AsyncLocalStorage`. ALS stays for the top-level request. Regression cover in `src/framework/__tests__/nested-context.test.tsx`.                                                                                                                                                                                                                        |
| `FRAMES.md`                   | The Frame primitive — `<Partial frame="name">` opens a URL scope with its own navigation, persisted in a server session, optionally projected into the window URL for sharing. Building blocks, the three tenors (menu / cart / quick-view), URL projection semantics, sharp edges.                                                                                                                                               |
| `CACHE_SCOPING.md`            | Short reference: the three storage tiers (`<Cache>` bytes = global, registry = route-scoped, client `_cache`/`_template` = per-tab). What counts as a "route" on each side (pathname vs pathname+search). Scaling on high-cardinality routes (50k products) — `getPathname(pattern)`, LRU cap, structure/data split. Eviction table.                                                                                              |
| `IDEAS.md`                    | Forward-looking backlog — lazy partials, prefetch links, event hooks, `_cache` pruning, per-partial opt-out, optimistic UI. Resolved ideas are retained with a "RESOLVED" / "SUPERSEDED" banner pointing to where the work landed.                                                                                                                                                                                                |

## Archive

`../archive/` holds design proposals that shipped, debugging sessions
whose insights are folded into subsequent docs, and removed APIs
preserved for historical context. Useful when reading older PRs /
commits; do not consult for how-the-code-works-today. See
`../archive/README.md` for an index.

Recent additions (2026-04-21):

- `USE_PARTIAL_AND_INPUTS.md` — the removed `usePartial` / `__inputs` / `usePartialParams` / `silentReplace` surface.
- `LESSONS.md`, `LESSONS_FROM_REFACTOR.md`, `LESSONS_2026-04-19.md` — point-in-time debugging trails from the pre-unified-navigation era. Insights still load-bearing in the code; superseded as canonical documentation by `NAVIGATE_UNIFIED.md` + `PARTIAL_ARCHITECTURE.md`.

## Also load-bearing

- `../CLAUDE.md` — project instructions (authoritative for the
  `<Partial>` / `<PartialRoot>` / `useNavigation` API and the GraphQL
  data layer).
- `../proxy-design/README.md` — the legacy proxy data layer. Not wired
  into the app; kept for reference.
