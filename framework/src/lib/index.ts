// Public API surface for the React-CMS partials library.

export {
  ReactCms,
  PartialRoot,
  PartialBoundary,
  ROOT,
  type PartialCtx,
  type PartialOptions,
  type PartialComponentProps,
  type SpecComponent,
  type SpecExtraProps,
  type SelectorToken,
  type SelectorTokens,
  type VaryScope,
  type RenderArgs,
  type ActivatorProps,
  type DeferSpec,
  getSpecComponentById,
  lookupSpecComponentForCmsId,
  getRegisteredMatchPatterns,
} from "./partial.tsx"

export {
  Children,
  Child,
  type ChildrenProps,
  type ChildProps,
} from "./slot.tsx"


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
  FrameworkNavigationResult,
  NavigateTarget,
} from "../runtime/navigation-api.ts"

export { PartialErrorBoundary } from "./partial-error-boundary.tsx"
export { invalidateByTags, clearCache, getCacheStats } from "./partial-cache.ts"
