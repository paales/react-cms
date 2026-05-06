// Public API surface for @react-cms/framework.
//
// The package contains three layers under src/:
//   - lib/        the partials library (spec constructor, render runtime)
//   - runtime/    RSC plumbing (request context, errors, CMS runtime, session)
//   - test/       in-process Flight test harness (consumed by per-package tests)
//
// This barrel re-exports the user-facing surface so server-side consumers can
// `import { … } from "@react-cms/framework"`. Deep paths
// (`@react-cms/framework/runtime/cms-runtime.ts`) remain available for the
// RSC adapter entry, which legitimately needs framework internals.
//
// ── "use client" caveat ────────────────────────────────────────────────
// A `"use client"` file that needs `useNavigation` / `useActivate` /
// `useScrollRestore` (anything originating in `lib/partial-client.tsx`,
// itself a `"use client"` file) MUST import from the deep path
// (`@react-cms/framework/lib/partial-client.tsx`). Pulling those hooks
// through this server-side barrel mis-resolves the Flight client
// reference and surfaces at runtime as
// `chunk.reason.enqueueModel is not a function`.
// Symbols exported from non-`"use client"` modules (e.g. `getNavigation`
// from `navigation-api.ts`) re-export through the barrel cleanly.

// ── Partial spec API (lib/) ─────────────────────────────────────────────
export * from "./src/lib/index.ts"

// ── Framework runtime — control + errors ────────────────────────────────
export {
  NotFoundError,
  RedirectError,
  notFound,
  redirect,
} from "./src/runtime/errors.ts"

export { Redirect } from "./src/runtime/redirect-client.tsx"

// ── Framework runtime — request context (server) ────────────────────────
//
// `getRequest` / `setRequest` / `runWithRequestAsync` are deliberately NOT
// re-exported here. User code reads request state through `vary`'s scope
// (url / pathname / search / cookies / headers) and writes side-effects
// through actions; reaching into the request ALS imperatively defeats the
// dependency declaration vary exists for. The RSC adapter entry
// (`entry.rsc.tsx`) imports those internals directly via deep paths —
// that's the only legitimate consumer.
export {
  setFrameworkControl,
  getFrameworkControl,
  setCookie,
  readCookie,
  isTestMode,
  getScope,
  matchRoutePattern,
} from "./src/runtime/context.ts"

// ── Navigation API (server-readable) ────────────────────────────────────
export { getNavigation } from "./src/runtime/navigation-api.ts"

// ── CMS runtime (server) ────────────────────────────────────────────────
export {
  EDITOR_COOKIE,
  getSpecByType,
  listAllCmsNodes,
  listSpecTypes,
  lookupCmsNode,
  lookupDraftNode,
  parseSlotEntryId,
  pickBestConfigIndex,
  publishDraft,
  resolveCmsNode,
  revertDraftNode,
  warmCmsCache,
  writeDraftNode,
  type CmsConfig,
  type CmsNode,
  type ContentFieldKind,
  type MatchClause,
  type Reference,
} from "./src/runtime/cms-runtime.ts"

// ── CMS prerender (build-time catalog) ──────────────────────────────────
export {
  getCatalogManifest,
  type BlockManifest,
} from "./src/runtime/cms-prerender.ts"

// ── Partial registry — read-only snapshot lookups for the editor ───────
export { getRouteSnapshots } from "./src/lib/partial-registry.ts"

// ── Dev-only debug overlay ─────────────────────────────────────────────
export { PartialsDebug } from "./src/lib/partial-debug.tsx"

// ── Session (frame URLs, scopes) ────────────────────────────────────────
export { setSessionFrameUrl } from "./src/runtime/session.ts"
