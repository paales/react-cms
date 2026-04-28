/**
 * The `resolve` function: query-root proxy lifecycle.
 *
 * Pass schema + executor + render function. No factory, no pre-binding.
 *
 *   resolve(getSchema, execute, (q, { query }) => {
 *     const products = q.products({ filter: {}, pageSize: 12 }).items;
 *     return <ProductGrid products={products} />;
 *   })
 *
 * Deep components access the query root via getQueryRoot():
 *
 *   function CartPartial() {
 *     const q = getQueryRoot();
 *     return <span>{q.cart({ cart_id }).total_quantity.value}</span>;
 *   }
 */

import { AsyncLocalStorage } from "node:async_hooks"
import type { ReactNode } from "react"
import { AccessRecorder } from "./access-recorder.ts"
import { renderForDiscovery } from "./discovery.ts"
import { createProxy } from "./proxy-node.ts"
import { compileQuery } from "./query-compiler.ts"
import type { SchemaGraph } from "./schema.ts"

export interface ResolveMeta {
  query: string
}

type GetSchema = () => Promise<SchemaGraph>
type Execute = <T>(query: string) => Promise<T>
type RenderFn = (query: any, meta: ResolveMeta) => ReactNode
type AccessFn = (query: any) => void

interface QueryRootContext {
  proxy: unknown
  isDiscovery: boolean
}

const queryRootStorage = new AsyncLocalStorage<QueryRootContext>()

/**
 * Get the current query root proxy from anywhere in the component tree.
 * Works during both discovery (phantom proxy) and data (real proxy) passes.
 */
export function getQueryRoot(): any {
  const ctx = queryRootStorage.getStore()
  if (!ctx) {
    throw new Error("getQueryRoot() must be called inside a resolve() render function")
  }
  return ctx.proxy
}

/**
 * Returns true during the discovery (phantom) pass.
 * Used by Partials to skip filtering during discovery so all
 * field accesses are recorded regardless of partial filter.
 */
export function isDiscoveryPass(): boolean {
  return queryRootStorage.getStore()?.isDiscovery ?? false
}

async function discoverAndFetch(
  getSchema: GetSchema,
  execute: Execute,
  discoverFn: (phantom: any) => void,
) {
  const schema = await getSchema()
  const queryTypeName = schema.getQueryTypeName()

  // Phase 1: Discovery
  const recorder = new AccessRecorder()
  const phantom = createProxy(schema, queryTypeName, recorder)
  queryRootStorage.run({ proxy: phantom, isDiscovery: true }, () => discoverFn(phantom))

  // Phase 2: Compile query
  const tree = recorder.getAccessTree()
  const query = compileQuery(tree)

  // Phase 3: Fetch
  const data = await execute<Record<string, unknown>>(query)

  // Phase 4: Create data-backed query root proxy.
  // Reuse the discovery recorder — it holds alias mappings for fields
  // queried multiple times with different arguments.
  const dataProxy = createProxy(schema, queryTypeName, recorder, data)

  return { dataProxy, query }
}

/**
 * Resolve: discovery → compile → fetch → render.
 */
export async function resolve(
  getSchema: GetSchema,
  execute: Execute,
  renderFn: RenderFn,
): Promise<ReactNode> {
  const { dataProxy, query } = await discoverAndFetch(getSchema, execute, (phantom) => {
    renderForDiscovery(renderFn(phantom, { query: "" }))
  })

  return queryRootStorage.run({ proxy: dataProxy, isDiscovery: false }, () =>
    renderFn(dataProxy as any, { query }),
  )
}

/**
 * Resolve data only — returns data-backed query root proxy + compiled query.
 * Touch fields in the access function to define the query shape.
 *
 * Returns { data, query } instead of the bare proxy because
 * proxies are thenable (for use() compatibility), and `await thenable`
 * would unwrap the proxy to its raw data.
 */
export async function resolveData(
  getSchema: GetSchema,
  execute: Execute,
  accessFn: AccessFn,
): Promise<{ data: any; query: string }> {
  const { dataProxy, query } = await discoverAndFetch(getSchema, execute, accessFn)
  return { data: dataProxy, query }
}
