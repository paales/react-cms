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
  type Cell,
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
export { invalidateByTags, clearCache, getCacheStats } from "./partial-cache.ts"
export { RemoteFrame, remote, type RemoteFrameProps } from "./remote-frame.tsx"
