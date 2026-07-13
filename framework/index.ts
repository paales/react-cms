// Public API surface for @parton/framework.
//
// The package contains four layers under src/:
//   - lib/        the partials library (spec constructor, render runtime)
//   - runtime/    RSC plumbing (request context, errors, CMS runtime, session)
//   - entry/      the app entry factories (createRscHandler, renderHTML,
//                 bootBrowser) that thin app entry files delegate to
//   - test/       in-process Flight test harness (consumed by per-package tests)
//
// This barrel re-exports the user-facing surface so server-side consumers can
// `import { … } from "@parton/framework"`. Deep paths
// (`@parton/framework/entry/rsc.tsx`) remain available for the app's
// entry files and for `"use client"` modules (see the caveat below).
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
// ── Match gate ──────────────────────────────────────────────────────────
export { TRANSPORT_PARAMS } from "./src/lib/match.ts"
export type { MatchInit, MatchPattern, FieldTest, ValueTest } from "./src/lib/match.ts"

export { NotFoundError, RedirectError, notFound, redirect } from "./src/runtime/errors.ts"

export { Redirect } from "./src/runtime/redirect-client.tsx"

// ── Navigation error surface ────────────────────────────────────────────
export { NavigationError, type NavigationErrorKind } from "./src/runtime/navigation-error.ts"

// ── Framework runtime — request context (server) ────────────────────────
//
// `getRequest` / `setRequest` / `runWithRequestAsync` are deliberately NOT
// re-exported here. User code reads request state through `vary`'s scope
// (url / pathname / search / cookies / headers) and writes side-effects
// through actions; reaching into the request ALS imperatively defeats the
// dependency declaration vary exists for. The framework's RSC handler
// (`src/entry/rsc.tsx`) imports those internals via relative paths —
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
export { getServerNavigation, type ServerNavigation } from "./src/runtime/server-navigation.ts"

// ── Invalidation registry ──────────────────────────────────────────────
export {
  refreshSelector,
  runInvalidationTransaction,
  parseSelector,
  parseSelectors,
} from "./src/runtime/invalidation-registry.ts"

// ── Invalidation bridge (cross-process doorbell seam) ───────────────────
// The deployment-level seam a multi-process app wires its bump
// transport into: `setInvalidationBridge` publishes committed bump
// batches, `deliverInvalidationBumps` applies received ones. Selectors
// only — values live in the shared store (`setCellStorage`), never on
// the bus. The transport itself stays with the deployment.
export {
  setInvalidationBridge,
  deliverInvalidationBumps,
  invalidationBridgeOrigin,
  type InvalidationBridge,
  type InvalidationBumpBatch,
} from "./src/runtime/invalidation-bridge.ts"

// ── Deploy-and-drain ────────────────────────────────────────────────────
// The graceful half of process shutdown: refuse new attaches, settle
// every held connection (the `drain` wire frame signals the client's
// prompt reattach), exit. `createRscHandler` wires SIGTERM → drain
// automatically (`drain: false` opts out); `beginDrain` is the seam an
// app-owned supervisor calls itself. See docs/internals/channel.md
// § Deploy-and-drain.
export {
  beginDrain,
  isDraining,
  DEFAULT_DRAIN_DEADLINE_MS,
  type DrainResult,
} from "./src/runtime/drain.ts"

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
export { getCatalogManifest, type BlockManifest } from "./src/runtime/cms-prerender.ts"

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
// `getEmbedGrants` is the grant half of the capability: the value bag
// says what an embedded render may READ, the grant set what its
// payload may REFERENCE (`docs/reference/remote-frame.md` § Grants).
// A producer branches on it to render its embed-surface variant. The
// vocabulary components themselves are a deliberate deep-path surface
// (`@parton/framework/lib/vocabulary.tsx`) — names like `Text` are
// too generic for the package namespace.
export {
  getCapability,
  getEmbedGrants,
  type Capability,
  type CapabilityValue,
} from "./src/runtime/capability.ts"
export type { EmbedGrant } from "./src/lib/page-embed.ts"

// ── Remote endpoint dispatch (host side of <RemoteFrame>) ──────────────
export {
  createRemoteHandler,
  buildRemoteManifest,
  type RemoteHandlerOptions,
  type RemoteManifest,
  type RemoteManifestSpec,
} from "./src/runtime/remote-endpoints.tsx"

// ── Embed actions (producer side of the Interactive grant) ─────────────
// Named server functions interactive embeds of this app may invoke —
// the explicit invocable surface below the Client tier (no Flight
// action id ever crosses a granted splice).
export { embedAction, type EmbedActionOptions } from "./src/runtime/embed-actions.ts"

// ── remoteCell (host side — outward state across the boundary) ─────────
// A read-only handle on a cell another parton process PUBLISHES
// (`publish` on the cell definition): server-to-server wake attach +
// doorbell re-emission through `deliverInvalidationBumps` + on-demand
// value reads. See `docs/reference/remote-frame.md` § remoteCell.
export {
  remoteCell,
  type RemoteCellHandle,
  type RemoteCellOpts,
} from "./src/runtime/remote-cell.ts"

// `__cellWrite` (a server action) is deliberately NOT re-exported
// here. `"use client"` files calling it must deep-import from
// `@parton/framework/runtime/cell-actions.ts` — see the
// cross-`"use *"` caveat above. Most authors won't touch
// `__cellWrite` directly; cell handles' `.set` rides Flight as a
// bound server-action ref to the same action.
