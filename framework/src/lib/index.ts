// Public API surface for the parton partials library.

export {
  parton,
  PartialRoot,
  PartialBoundary,
  ROOT,
  type PartialCtx,
  type PartialOptions,
  type PartialComponentProps,
  type PartialBuilder,
  type SpecComponent,
  type SpecExtraProps,
  type SelectorToken,
  type SelectorTokens,
  type VaryScope,
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

// Server-hooks — free functions a parton's Render calls to read a request
// dimension AND record it as an fp dependency (the inline-tracking
// replacement for `vary`): `cookie()`, `searchParam()`, `param()`. Plus
// `tag()` (a render-time invalidation label) and `getCurrentParton()` (the
// parton's own identity). See current-parton.ts / server-hooks.ts.
export {
  cookie,
  searchParam,
  param,
  match,
  session,
  visible,
  header,
  pathname,
} from "./server-hooks.ts"
export { tag, getCurrentParton, type CurrentParton, type VisibleOptions } from "./current-parton.ts"

export {
  PartialsClient,
  getCachedPartialIds,
  useActivate,
  useNavigation,
  useScrollRestore,
  type ActivatorFire,
} from "./partial-client.tsx"

export {
  localCell,
  buildResolvedCell,
  computeCellPartitionKey,
  computeScopedCellPartitionKey,
  finalizeScopedCell,
  getCellById,
  isBoundCell,
  isCellHandle,
  isModuleCell,
  isScopedCellDescriptor,
  makeScopedCellFactories,
  resolveCellValue,
  type BoundCell,
  type CellInterface,
  type LocalCell,
  type CellArgs,
  type CellShape,
  type CellShapeSpec,
  type CellValue,
  type CellVaryScope,
  type LocalCellOpts,
  type ResolvedCell,
  type ScopedCellDescriptor,
  type ScopedCellFactories,
  type ScopedLocalCellOpts,
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
  usePartonAction,
  type CellInputBindings,
  type CellInputOpts,
  type ClientCell,
} from "./cell-client.tsx"

export {
  getActionById,
  getSchemaForParton,
  isResolvedAction,
  registerAction,
  registerSchema,
  type ActionHandler,
  type ResolvedAction,
  type SchemaCallback,
} from "./parton-actions.ts"

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
