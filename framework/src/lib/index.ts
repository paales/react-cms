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

export type {
  FrameworkNavigation,
  FrameworkNavigateOptions,
  FrameworkReloadOptions,
  Navigate,
  NavigateStatus,
  NavigateTarget,
  Reload,
  ReloadStatus,
} from "../runtime/navigation-api.ts"
export { NavigationError, type NavigationErrorKind } from "../runtime/navigation-error.ts"

export { PartialErrorBoundary } from "./partial-error-boundary.tsx"
export { invalidateByTags, clearCache, getCacheStats } from "./partial-cache.ts"
export { RemoteFrame, remote, type RemoteFrameProps } from "./remote-frame.tsx"
