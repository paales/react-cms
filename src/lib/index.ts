export { SchemaGraph, fetchSchema } from "./schema.ts";
export { AccessRecorder } from "./access-recorder.ts";
export { compileQuery, compileSelectionSet, raw } from "./query-compiler.ts";
export { createProxy } from "./proxy-node.ts";
export {
  orchestrate,
  createLazyProxy,
  clearPatternCache,
  getPatternCache,
  type QueryConfig,
} from "./orchestrator.ts";
export { renderForDiscovery } from "./discovery.ts";
export {
  resolve,
  resolveData,
  getQueryRoot,
  type ResolveMeta,
} from "./resolve.ts";
export { Partials, type PartialProps } from "./partial.tsx";
export { PartialsClient, getCachedPartialIds, usePartial, type PartialDebugEntry } from "./partial-client.tsx";
export { PartialErrorBoundary } from "./partial-error-boundary.tsx";
export { invalidateByTags, clearCache, getCacheStats } from "./partial-cache.ts";
