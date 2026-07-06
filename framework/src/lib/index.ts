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
  type SelectorToken,
  type SelectorTokens,
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
export {
  block,
  type BlockOptions,
  type SchemaScope,
} from "../runtime/cms-block.ts"

// Server context — `createServerContext(default)` returns a provider
// component (`<Ctx value={…}>…</Ctx>`) plus the handle for
// `getServerContext(Ctx)`, readable anywhere in a Server Component's render.
export {
  createServerContext,
  getServerContext,
  type ServerContext,
} from "./server-context.ts"

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
  expires,
  staleUntil,
  time,
  registerDepKind,
} from "./server-hooks.ts"
export { tag, getCurrentParton, type CurrentParton } from "./current-parton.ts"

export {
  PartialsClient,
  getCachedPartialIds,
  useActivate,
  useNavigation,
  useScrollRestore,
  type ActivatorFire,
} from "./partial-client.tsx"

export {
  atomic,
  localCell,
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

export {
  gqlCell,
  gqlCellBuilder,
  runQuery,
  fragmentCell,
  hydrateFragmentsFromResult,
  spreadSitesOf,
  _clearFragmentCellRegistry,
  type GqlCell,
  type GqlCellOpts,
  type GqlClient,
  type FragmentCell,
  type FragmentCellOpts,
  type FragmentOf,
  type RewriteSpreads,
} from "./cell-gql.ts"

export {
  useCell,
  type CellInputBindings,
  type CellInputOpts,
  type ClientCell,
} from "./cell-client.tsx"


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

export { PartialErrorBoundary } from "./partial-error-boundary.tsx"
export { RemoteFrame, remote, type RemoteFrameProps } from "./remote-frame.tsx"
