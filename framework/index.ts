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
// ── Cross-`"use *"` re-export caveat ───────────────────────────────────
// A `"use client"` file that needs symbols originating in another file
// with a directive (`"use client"` hooks like `useNavigation`, OR
// `"use server"` actions like `setSessionValue`) MUST import from the
// deep path, not through this server-side barrel. Pulling those
// symbols through the barrel mis-resolves the Flight client/server
// reference and surfaces at runtime as
// `chunk.reason.enqueueModel is not a function`.
//   ✗ import { useNavigation } from "@react-cms/framework"            (in "use client")
//   ✓ import { useNavigation } from "@react-cms/framework/lib/partial-client.tsx"
//   ✗ import { setSessionValue } from "@react-cms/framework"          (in "use client")
//   ✓ import { setSessionValue } from "@react-cms/framework/runtime/session-actions.ts"
// Symbols from plain server modules (`getNavigation` from
// `navigation-api.ts`, `notFound` from `errors.ts`) re-export through
// this barrel cleanly.

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

// ── Session (frame URLs, per-key values, read surface) ─────────────────
export {
  setSessionFrameUrl,
  type SessionReadSurface,
} from "./src/runtime/session.ts"

// `setSessionValue` (a server action) is deliberately NOT re-exported
// here. `"use client"` files calling it must deep-import from
// `@react-cms/framework/runtime/session-actions.ts` — see the
// cross-`"use *"` caveat above.
