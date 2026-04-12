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
export { resolve, resolveData, getQueryRoot, type ResolveMeta } from "./resolve.ts";
export { SectionList } from "./section.tsx";
export { SectionListClient } from "./section-client.tsx";
