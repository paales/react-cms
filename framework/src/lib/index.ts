// Public API surface for the parton partials library.

export {
  parton,
  PartialRoot,
  PartialBoundary,
  ROOT,
  type PartialCtx,
  type PartialOptions,
  type CullConfig,
  type CullProps,
  type PartialComponentProps,
  type PartialBuilder,
  type SpecComponent,
  type SpecExtraProps,
  type RenderArgs,
  type PartonProps,
  type ActivatorProps,
  type DeferSpec,
  type InferV,
  type InferRenderProps,
  type ParseRoute,
  getSpecComponentById,
  getRegisteredMatchPatterns,
} from "./partial.tsx"

// CMS block constructor — composes around `parton`.
export { block, type BlockOptions, type SchemaScope } from "../runtime/cms-block.ts"

// Server context — `createServerContext(default)` returns a provider
// component (`<Ctx value={…}>…</Ctx>`) plus the handle for
// `getServerContext(Ctx)`, readable anywhere in a Server Component's render.
export { createServerContext, getServerContext, type ServerContext } from "./server-context.ts"

// Server-hooks — free functions a parton's schema/Render calls to read
// a request dimension AND record it as an fp dependency: `cookie()`,
// `searchParam()`, `param()`, the wake hooks. Plus `tag()`
// (a render-time invalidation label) and `getCurrentParton()` (the
// parton's own identity). See current-parton.ts / server-hooks.ts.
export {
  cookie,
  searchParam,
  param,
  match,
  session,
  header,
  pathname,
  untrackedUrl,
  expires,
  staleUntil,
  time,
  registerDepKind,
  getBoundCells,
} from "./server-hooks.ts"
export { tag, getCurrentParton, type CurrentParton } from "./current-parton.ts"

// `<Frame>` — scope opener for a per-name URL space (plain server
// component). One of the five public surfaces (see intro.md).
export { Frame } from "./frame.tsx"

// The client hooks (`useNavigation`, `useActivate`, `useScrollRestore`,
// `useCell`, `usePartonStale`) and their client-only types live in the
// companion `@parton/framework/client` barrel — a `"use client"` module
// imports them from there so Flight keeps each reference pointed at its
// defining module. `PartialsClient` / `getCachedPartialIds` stay
// framework-internal (entry/browser.tsx deep-imports them).

export {
  atomic,
  localCell,
  CellWriteDenied,
  buildResolvedCell,
  computeCellPartitionKey,
  finalizeScopedCell,
  getCellById,
  isBoundCell,
  isCellHandle,
  isModuleCell,
  isScopedCellDescriptor,
  resolveCellValue,
  type BoundCell,
  type CellInterface,
  type LocalCell,
  type CellArgs,
  type CellShape,
  type CellShapeSpec,
  type CellValue,
  type CellPartitionScope,
  type LocalCellOpts,
  type ResolvedCell,
  type ScopedCellDescriptor,
  type ValueOfShape,
} from "./cell.ts"

// The GraphQL data layer (gqlCell family, `graphqlBackend`) lives at the
// `@parton/framework/graphql` subpath — see src/graphql/index.ts.

// `useCell` and its `ClientCell` / `CellInputBindings` / `CellInputOpts`
// types are the client mutation surface — exported from
// `@parton/framework/client`.

export { type TimeScope } from "./time.ts"

export type {
  FrameworkNavigation,
  FrameworkNavigateOptions,
  FrameworkReloadOptions,
  Navigate,
  NavigateStatus,
  NavigateTarget,
  NavigationMilestones,
  NavigationProgress,
  Reload,
  ReloadStatus,
} from "../runtime/navigation-api.ts"
export { NavigationError, type NavigationErrorKind } from "../runtime/navigation-error.ts"

// `PartialErrorBoundary` is a client component a server tree places
// around a flaky subtree — exported from both barrels (one defining
// module, one client reference). `usePartonStale` (its client hook)
// and the `PartonStale` type live in `@parton/framework/client`.
export { PartialErrorBoundary } from "./partial-error-boundary.tsx"

// Error recovery — the serve-last-known-good engine riding the byte
// cache (docs/reference/errors.md). `onPartonError` is the
// observability hook for failed parton renders.
export { onPartonError, type PartonErrorEvent } from "./cache.tsx"
export { RemoteFrame, remote, type RemoteFrameProps } from "./remote-frame.tsx"

// Predictive warming — the server-side projector registration the
// segment driver's warm pass consults (segmented-response.ts). The
// client-side statement (`reportTelemetry`) lives in
// `@parton/framework/client`.
export { registerWarmProjector, type WarmCandidate, type WarmProjector } from "./warm-projection.ts"
export type { SessionTelemetry } from "./connection-session.ts"
