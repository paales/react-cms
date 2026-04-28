/**
 * Orchestrator: ties together the proxy, query compilation, and data fetching.
 *
 * Given a GraphQL endpoint and schema, it:
 * 1. Runs a "discovery" render with phantom proxies to collect access patterns
 * 2. Compiles recorded paths into a GraphQL query
 * 3. Fetches data
 * 4. Returns data-backed proxies for the real render
 */

import { AccessRecorder } from "./access-recorder.ts"
import { createProxy } from "./proxy-node.ts"
import { compileQuery } from "./query-compiler.ts"
import type { SchemaGraph } from "./schema.ts"

export interface QueryConfig {
  /** The root GraphQL field (e.g., 'pokemon_v2_pokemon') */
  rootField: string
  /** Arguments for the root field */
  rootArgs?: Record<string, unknown>
  /** The schema type name for the root (e.g., 'pokemon_v2_pokemon') */
  typeName: string
}

export interface OrchestratorResult<T> {
  /** The compiled GraphQL query */
  query: string
  /** The raw fetched data */
  rawData: T
  /** A data-backed proxy for the real render */
  proxy: unknown
  /** The access recorder (for inspection/debugging) */
  recorder: AccessRecorder
}

/**
 * Cache of discovered access patterns per component identity.
 * Maps component name → access tree, so subsequent renders skip discovery.
 */
const patternCache = new Map<string, ReturnType<AccessRecorder["getAccessTree"]>>()

export function clearPatternCache() {
  patternCache.clear()
}

export function getPatternCache() {
  return new Map(patternCache)
}

/**
 * Run the full discovery → compile → fetch → data proxy flow.
 *
 * @param schema - The introspected GraphQL schema
 * @param endpoint - The GraphQL endpoint URL
 * @param config - Query configuration (root field, args, type)
 * @param renderFn - A function that accesses proxy fields (simulates component render)
 * @param cacheKey - Optional key for caching discovered patterns
 */
export async function orchestrate<T = unknown>(
  schema: SchemaGraph,
  endpoint: string,
  config: QueryConfig,
  renderFn: (proxy: unknown) => void,
  cacheKey?: string,
): Promise<OrchestratorResult<T>> {
  const recorder = new AccessRecorder()

  // Check pattern cache first
  const cachedPatterns = cacheKey ? patternCache.get(cacheKey) : undefined

  if (cachedPatterns) {
    // Skip discovery, use cached patterns to build query
    for (const path of flattenTree(cachedPatterns)) {
      recorder.recordAccess(path)
    }
  } else {
    // Phase 1: Discovery render — run the render function with phantom proxy
    const phantom = createProxy(schema, config.typeName, recorder)
    renderFn(phantom)

    // Cache the patterns if a key was provided
    if (cacheKey) {
      patternCache.set(cacheKey, recorder.getAccessTree())
    }
  }

  // Phase 2: Compile query
  const tree = recorder.getAccessTree()
  const query = compileQuery(tree, config.rootField, config.rootArgs)

  // Phase 3: Fetch data
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  })

  if (!response.ok) {
    throw new Error(`GraphQL fetch failed: ${response.status}`)
  }

  const json = (await response.json()) as {
    data: Record<string, T>
    errors?: Array<{ message: string }>
  }

  if (json.errors?.length) {
    throw new Error(`GraphQL errors: ${json.errors.map((e) => e.message).join(", ")}`)
  }

  const rawData = json.data[config.rootField] as T

  // Phase 4: Create data-backed proxy for real render
  const dataRecorder = new AccessRecorder()
  const proxy = createProxy(schema, config.typeName, dataRecorder, rawData)

  return { query, rawData, proxy, recorder: dataRecorder }
}

/**
 * Simpler API: create a proxy that fetches data on first .value access.
 * Returns a "lazy" proxy — discovery happens on construction,
 * data fetching is triggered and resolved via the proxy's thenable interface.
 */
export function createLazyProxy(
  schema: SchemaGraph,
  endpoint: string,
  config: QueryConfig,
  renderFn: (proxy: unknown) => void,
  cacheKey?: string,
): unknown {
  // Run discovery synchronously
  const discoveryRecorder = new AccessRecorder()

  const cachedPatterns = cacheKey ? patternCache.get(cacheKey) : undefined
  if (cachedPatterns) {
    for (const path of flattenTree(cachedPatterns)) {
      discoveryRecorder.recordAccess(path)
    }
  } else {
    const phantom = createProxy(schema, config.typeName, discoveryRecorder)
    renderFn(phantom)
    if (cacheKey) {
      patternCache.set(cacheKey, discoveryRecorder.getAccessTree())
    }
  }

  // Compile and start fetch
  const tree = discoveryRecorder.getAccessTree()
  const query = compileQuery(tree, config.rootField, config.rootArgs)

  const dataPromise = fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  })
    .then((res) => {
      if (!res.ok) throw new Error(`GraphQL fetch failed: ${res.status}`)
      return res.json() as Promise<{
        data: Record<string, unknown>
        errors?: Array<{ message: string }>
      }>
    })
    .then((json) => {
      if (json.errors?.length) {
        throw new Error(`GraphQL errors: ${json.errors.map((e) => e.message).join(", ")}`)
      }
      return json.data[config.rootField]
    })

  // Return a proxy that resolves data from the promise
  const dataRecorder = new AccessRecorder()
  return createAsyncProxy(schema, config.typeName, dataRecorder, dataPromise)
}

/**
 * Create a proxy backed by a Promise. Property access returns child async proxies.
 * .value and .then() await the data promise.
 */
function createAsyncProxy(
  schema: SchemaGraph,
  typeName: string,
  recorder: AccessRecorder,
  dataPromise: Promise<unknown>,
  path: string[] = [],
): unknown {
  const target = Object.assign(() => {}, {})

  return new Proxy(target, {
    get(_target, prop) {
      if (prop === "value") {
        // Record the access
        if (path.length > 0) recorder.recordAccess(path)
        // Return a promise that resolves to the value at this path
        return dataPromise.then((data) => resolvePath(data, path))
      }

      if (prop === "then") {
        if (path.length > 0) recorder.recordAccess(path)
        return (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
          dataPromise.then((data) => resolve(resolvePath(data, path))).catch(reject)
        }
      }

      if (prop === "map") {
        return (callback: (item: unknown, index: number) => unknown) => {
          return dataPromise.then((data) => {
            const arr = resolvePath(data, path) as unknown[]
            return arr.map((item, index) => {
              const itemProxy = createProxy(schema, typeName, recorder, item)
              return callback(itemProxy, index)
            })
          })
        }
      }

      if (typeof prop === "symbol") return undefined

      const childPath = [...path, prop as string]
      recorder.recordAccess(childPath)

      const fieldType = schema.getFieldType(typeName, prop as string)
      const childTypeName = fieldType?.name ?? typeName

      return createAsyncProxy(schema, childTypeName, recorder, dataPromise, childPath)
    },
  })
}

function resolvePath(data: unknown, path: string[]): unknown {
  let current = data
  for (const key of path) {
    if (current == null || typeof current !== "object") return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

/** Flatten an access tree back into array paths for re-recording */
function flattenTree(
  tree: ReturnType<AccessRecorder["getAccessTree"]>,
  prefix: string[] = [],
): string[][] {
  const paths: string[][] = []
  for (const node of tree) {
    const current = [...prefix, node.field]
    if (node.children.length === 0) {
      paths.push(current)
    } else {
      paths.push(...flattenTree(node.children, current))
    }
  }
  return paths
}
