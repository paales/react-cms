// Public API surface for the React-CMS partials library.

export {
  ReactCms,
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
  type ActivatorProps,
  type DeferSpec,
  type InferV,
  type InferRenderProps,
  type ParseRoute,
  getSpecComponentById,
  getRegisteredMatchPatterns,
} from "./partial.tsx"

// CMS block constructor — composes around `ReactCms.partial`.
export {
  block,
  type BlockOptions,
  type SchemaScope,
} from "../runtime/cms-block.ts"

export {
  PartialsClient,
  getCachedPartialIds,
  useActivate,
  useEnclosingPartialId,
  useNavigation,
  useScrollRestore,
  type ActivatorFire,
} from "./partial-client.tsx"

export type {
  FrameworkNavigation,
  FrameworkNavigateOptions,
  FrameworkReloadOptions,
  FrameworkNavigationResult,
  NavigateTarget,
} from "../runtime/navigation-api.ts"

export { PartialErrorBoundary } from "./partial-error-boundary.tsx"
export { invalidateByTags, clearCache, getCacheStats } from "./partial-cache.ts"
