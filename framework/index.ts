// Public API surface for @parton/framework.
//
// The package contains three layers under src/:
//   - lib/        the partials library (spec constructor, render runtime)
//   - runtime/    RSC plumbing (request context, errors, CMS runtime, session)
//   - test/       in-process Flight test harness (consumed by per-package tests)
//
// This barrel re-exports the user-facing surface so server-side consumers can
// `import { … } from "@parton/framework"`. Deep paths
// (`@parton/framework/runtime/cms-runtime.ts`) remain available for the
// RSC adapter entry, which legitimately needs framework internals.
//
// ── Cross-`"use *"` re-export caveat ───────────────────────────────────
// A `"use client"` file that needs symbols originating in another file
// with a directive (`"use client"` hooks like `useNavigation`, OR
// `"use server"` actions like `__cellWrite`) MUST import from the
// deep path, not through this server-side barrel. Pulling those
// symbols through the barrel mis-resolves the Flight client/server
// reference and surfaces at runtime as
// `chunk.reason.enqueueModel is not a function`.
//   ✗ import { useNavigation } from "@parton/framework"            (in "use client")
//   ✓ import { useNavigation } from "@parton/framework/lib/partial-client.tsx"
//   ✗ import { __cellWrite } from "@parton/framework"               (in "use client")
//   ✓ import { __cellWrite } from "@parton/framework/runtime/cell-actions.ts"
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

// ── Navigation error surface ────────────────────────────────────────────
export {
  NavigationError,
  type NavigationErrorKind,
} from "./src/runtime/navigation-error.ts"

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
  markConnectionLive,
} from "./src/runtime/context.ts"

// ── Navigation API (server-readable) ────────────────────────────────────
export { getNavigation } from "./src/runtime/navigation-api.ts"

// ── Server-side navigation handle ───────────────────────────────────────
// Symmetric to client `getNavigation()`. Reads/writes the invalidation
// registry; use in server actions and external server-side tasks.
export {
  getServerNavigation,
  type ServerNavigation,
} from "./src/runtime/server-navigation.ts"

// ── Invalidation registry ──────────────────────────────────────────────
export {
  refreshSelector,
  runInvalidationTransaction,
  parseSelector,
  parseSelectors,
} from "./src/runtime/invalidation-registry.ts"

// ── Cell storage (pluggable backend) ────────────────────────────────────
export {
  getCellStorage,
  setCellStorage,
  getEphemeralCellStorage,
  defaultCellsPath,
  MemoryCellStorage,
  JsonFileCellStorage,
  type CellStorage,
  type CellPartitionKey,
} from "./src/runtime/cell-storage.ts"

// ── Cell write debug hook (server, demo-only) ──────────────────────────
// Lets a server-side demo install a per-batch latency simulator so the
// auto-batched write pipeline produces variable RTTs without losing
// the microtask-coalescing path. Production code leaves it null. Lives
// in its own module because `cell-actions.ts` is `"use server"` and
// every export there must be an async server action.
export { _setCellWriteDelaySimulator } from "./src/runtime/cell-write-delay.ts"

// ── CMS runtime (server) ────────────────────────────────────────────────
export {
  EDITOR_COOKIE,
  getSpecById,
  getSlotBlockMeta,
  listAllCmsNodes,
  listSlotBlockIds,
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
  type SlotBlockMeta,
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
  configureSessionStore,
  ensureSessionId,
  setSessionFrameUrl,
  type SessionReadSurface,
} from "./src/runtime/session.ts"

// ── Capability scoping (RemoteFrame) ───────────────────────────────────
export {
  getCapability,
  type Capability,
  type CapabilityValue,
} from "./src/runtime/capability.ts"

// ── Remote endpoint dispatch (host side of <RemoteFrame>) ──────────────
export {
  createRemoteHandler,
  buildRemoteManifest,
  type RemoteHandlerOptions,
  type RemoteManifest,
  type RemoteManifestSpec,
} from "./src/runtime/remote-endpoints.tsx"

// `__cellWrite` (a server action) is deliberately NOT re-exported
// here. `"use client"` files calling it must deep-import from
// `@parton/framework/runtime/cell-actions.ts` — see the
// cross-`"use *"` caveat above. Most authors won't touch
// `__cellWrite` directly; cell handles' `.set` rides Flight as a
// bound server-action ref to the same action.
