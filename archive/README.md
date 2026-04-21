# Archive

Historical design documents and debugging sessions. Each of these
either (a) describes code that no longer exists, (b) proposes a
change that has since landed and is covered by current docs, or
(c) captures a debugging trail whose *conclusions* are folded into
`../LESSONS.md` or `../LESSONS_FROM_REFACTOR.md`.

Kept for context; **do not consult for how the code works today.**
For that, start at `../README.md`.

| File | Why archived |
|---|---|
| `AGENTS.md` | Describes the old `<Partials namespace="...">` API. Replaced by `<PartialRoot>` + `<Partial>` (see `../../CLAUDE.md`). Was at repo root; moved here 2026-04-18. |
| `BARE_KEY_REFETCH.md` | Documents the switch from version-stamped Suspense keys to bare `key={id}`. Change landed 2026-04-16; insights rolled into `LESSONS.md` §1–§3 (also here). |
| `PARTIAL_WRAPPER_DESIGN.md` | The design proposal that introduced `<PartialRoot>` + `<Partial>`, the activator-component pattern (`<WhenVisible>`), and the decision to reject the HTMX-style trigger DSL. Implemented; kept as rationale. |
| `PLAN.md` | Original data-layer plan (proxy-based auto-discovery, `resolve()`, section architecture). The proxy direction was abandoned in favor of hand-written GraphQL queries with `graphql-request` + gql.tada. See `../../proxy-design/README.md` for a shorter current-state note. |
| `REFACTOR_PROGRESS.md` | In-progress log from the 2026-04-18 unified-path refactor. Superseded by `LESSONS_FROM_REFACTOR.md` (also here). |
| `STREAMING_DEBUG_NOTES.md` | 584 lines of pre-refactor debugging across the streaming / cache / substitute paths. Heavy references to deleted helpers (`collectPartials`, `transformForStreaming`, `stripNested`, `buildTemplate`, `patchNested`, `renderTemplate`). The surviving insights — Flight lazy-ref truncation, `Children.forEach` touches lazy refs, the `navigationType === "reload"` intercept fix — are reflected in the code and in `LESSONS.md`. |
| `SERVER_CACHE_NOTES.md` | Original `<Cache dep ttl staleWhileRevalidate>` design + Flight-buffer round-trip mechanics + strip-on-store / reinject-on-return. The mechanics are still load-bearing inside `src/lib/cache.tsx`; the surface (`<Cache>` as a user-facing component, `dep` as the key source) is replaced by `<Partial cache={…}>` with auto-tracked manifest keys. See `../notes/AUTO_TRACKED_CACHE_KEYS.md` for the current model. |
| `PARTIAL_CACHE_DESIGN.md` | Proposal to fold `<Cache>` into `<Partial cache={…}>`. Implemented; `cache` value semantics were further reshaped to a Cache-Control object (`{maxAge, staleWhileRevalidate, vary?, bypass?}`) by the auto-tracking work. See `../notes/AUTO_TRACKED_CACHE_KEYS.md`. |
| `USE_PARTIAL_AND_INPUTS.md` | Historical reference for `usePartial`, `__inputs`, `usePartialParams`, `silentReplace` — all removed 2026-04-21. Everything they did is now one `useNavigation()` surface with `ids` / `tags` / `silent` options. See `../notes/NAVIGATE_UNIFIED.md` for the replacement. |
| `LESSONS.md` | Refetch-mechanics lessons from 2026-04-16 → 2026-04-17 (bare-key Suspense reconciliation, fingerprint-based skip, flipped transition default, Flight serialization losing implicit keys). Describes a surface area that has since been rebuilt; insights still load-bearing in `partial-client.tsx` but no longer canonical documentation. Archived 2026-04-21. |
| `LESSONS_FROM_REFACTOR.md` | The 2026-04-18 unified-path refactor (`als.enterWith` vs `als.run`, conditional Suspense wrap, prop-based wrapper detection, `partialId` vs `node.key`, test-mock reset pattern). Archived 2026-04-21 — subsequent `__inputs`/`usePartial` removal changes the API surface the refactor was shaping. |
| `LESSONS_2026-04-19.md` | `seedRegistry` and `buildTemplate` removal, the Flight-composite key problem on placeholders, `cloneElement` drilling through wrappers, `startTransition` + slow children = invisibly-stale UX. Archived 2026-04-21 — `refreshRegistry`/`applyInputs` mechanisms it discusses are superseded by the ambient-frame-URL fingerprint fold in `../notes/DYNAMIC_PARTIAL_REGISTRY.md` and `../notes/NAVIGATE_UNIFIED.md`. |
