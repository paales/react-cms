/**
 * Schema-aware proxy that records property access and serves data.
 *
 * Two modes:
 * - Discovery mode (no data): records accesses, .value returns mock values
 * - Data mode (with data): records accesses, .value returns real values
 *
 * Every field access returns a child proxy (for chaining/traversal).
 * .value unwraps to the actual primitive/data value.
 * Every proxy is thenable — use(proxy) works with React's use() hook.
 */

import type { AccessRecorder } from "./access-recorder.js"
import type { SchemaGraph } from "./schema.js"

const PROXY_INTERNALS = Symbol("proxy-internals")

interface ProxyInternals {
  schema: SchemaGraph
  typeName: string
  path: string[]
  recorder: AccessRecorder
  data: unknown
  hasData: boolean
  /** Parent node's data object — used by apply() to resolve aliased data keys */
  parentData?: Record<string, unknown>
}

/**
 * Create a proxy node that tracks access and optionally holds data.
 */
export function createProxyNode(
  schema: SchemaGraph,
  typeName: string,
  path: string[],
  recorder: AccessRecorder,
  data?: unknown,
  parentData?: Record<string, unknown>,
): unknown {
  const internals: ProxyInternals = {
    schema,
    typeName,
    path,
    recorder,
    data: data ?? undefined,
    hasData: arguments.length >= 5,
    parentData,
  }

  const target = Object.assign(() => {}, { [PROXY_INTERNALS]: internals })

  return new Proxy(target, {
    get(_target, prop, _receiver) {
      if (prop === PROXY_INTERNALS) return internals

      // .$value — always unwrap (escape hatch when type has a "value" field)
      if (prop === "$value") {
        return resolveValue(internals)
      }

      // .value — unwrap to actual data or mock, UNLESS the type
      // has a real field called "value" (e.g., Magento Money.value)
      if (prop === "value") {
        const hasValueField = schema.getField(typeName, "value") != null
        if (!hasValueField) {
          return resolveValue(internals)
        }
        // Fall through to regular property access
      }

      // .then — thenable for use()
      if (prop === "then") {
        return (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
          try {
            resolve(resolveValue(internals))
          } catch (e) {
            reject(e)
          }
        }
      }

      // Array methods
      if (prop === "map" || prop === "find" || prop === "filter" || prop === "at") {
        return createArrayMethod(internals, prop as string)
      }

      // .length — for arrays
      if (prop === "length") {
        if (internals.hasData && Array.isArray(internals.data)) {
          return internals.data.length
        }
        return 1
      }

      // Symbol access — don't track
      if (typeof prop === "symbol") return undefined

      const fieldName = prop as string

      // Numeric index access — array element (not recorded as a field)
      if (/^\d+$/.test(fieldName)) {
        if (internals.hasData && Array.isArray(internals.data)) {
          const item = internals.data[Number(fieldName)]
          if (item == null) return undefined
          // Use __typename for concrete type resolution
          let itemTypeName = typeName
          if (typeof item === "object" && !Array.isArray(item)) {
            const tn = (item as Record<string, unknown>).__typename
            if (typeof tn === "string" && schema.getType(tn)) itemTypeName = tn
          }
          return createProxyNode(schema, itemTypeName, path, recorder, item)
        }
        return createProxyNode(schema, typeName, path, recorder)
      }

      // Regular property access — always returns a child proxy
      const childPath = [...path, fieldName]
      recorder.recordAccess(childPath)

      const fieldType = schema.getFieldType(typeName, fieldName)
      let childTypeName = fieldType?.name ?? "Unknown"

      let childData: unknown
      let childHasData = false
      if (internals.hasData && internals.data != null && typeof internals.data === "object") {
        childData = (internals.data as Record<string, unknown>)[fieldName]
        childHasData = true
      }

      // Use __typename from data for concrete type resolution
      if (
        childHasData &&
        childData != null &&
        typeof childData === "object" &&
        !Array.isArray(childData)
      ) {
        const typename = (childData as Record<string, unknown>).__typename
        if (typeof typename === "string" && schema.getType(typename)) {
          childTypeName = typename
        }
      }

      // Pass current data as parentData so the child's apply() can
      // resolve aliased data keys when the same field is queried
      // with different arguments.
      const parentForChild =
        internals.hasData && internals.data != null && typeof internals.data === "object"
          ? (internals.data as Record<string, unknown>)
          : undefined

      if (childHasData) {
        return createProxyNode(
          schema,
          childTypeName,
          childPath,
          recorder,
          childData,
          parentForChild,
        )
      }
      return createProxyNode(schema, childTypeName, childPath, recorder)
    },

    // Parameterized field access: pokemon.types({ first: 10 })
    apply(_target, _thisArg, argsList) {
      const args = argsList[0] as Record<string, unknown> | undefined

      if (args) {
        const fieldName = path[path.length - 1]
        const alias = recorder.resolveAlias(path, args)

        if (alias !== fieldName) {
          // Different alias — record under aliased path and resolve data
          const aliasedPath = [...path.slice(0, -1), alias]
          recorder.recordAccess(aliasedPath, args)

          if (internals.parentData) {
            const resolvedData = internals.parentData[alias]
            return createProxyNode(
              schema,
              typeName,
              aliasedPath,
              recorder,
              resolvedData,
              internals.parentData,
            )
          }
          return createProxyNode(schema, typeName, aliasedPath, recorder)
        }

        // No alias needed — record args on current path
        recorder.recordAccess(path, args)
      }

      if (internals.hasData) {
        return createProxyNode(
          schema,
          typeName,
          path,
          recorder,
          internals.data,
          internals.parentData,
        )
      }
      return createProxyNode(schema, typeName, path, recorder)
    },
  })
}

function resolveValue(internals: ProxyInternals): unknown {
  if (internals.hasData) {
    return internals.data
  }
  // Discovery mode — mock based on schema type
  const { schema, typeName } = internals
  if (schema.getType(typeName)) {
    return {}
  }
  return schema.getMockValue(typeName)
}

function createArrayMethod(internals: ProxyInternals, method: string) {
  const { schema, typeName, path, recorder, data, hasData } = internals

  if (method === "at") {
    return (index: number) => {
      const items = hasData && Array.isArray(data) ? data : [undefined]
      const item = items.at(index)
      const childHasData = hasData && item !== undefined

      if (childHasData) {
        return createProxyNode(schema, typeName, path, recorder, item)
      }
      return createProxyNode(schema, typeName, path, recorder)
    }
  }

  return (callback: (item: unknown, index: number) => unknown) => {
    if (hasData && Array.isArray(data)) {
      const proxied = data.map((item, index) => {
        // Use __typename for concrete type resolution on array items
        let itemTypeName = typeName
        if (item != null && typeof item === "object" && !Array.isArray(item)) {
          const typename = (item as Record<string, unknown>).__typename
          if (typeof typename === "string" && schema.getType(typename)) {
            itemTypeName = typename
          }
        }
        return {
          proxy: createProxyNode(schema, itemTypeName, path, recorder, item),
          index,
        }
      })

      if (method === "map") {
        return proxied.map(({ proxy, index }) => callback(proxy, index))
      }
      if (method === "find") {
        const found = proxied.find(({ proxy, index }) => callback(proxy, index))
        return found?.proxy
      }
      if (method === "filter") {
        return proxied
          .filter(({ proxy, index }) => callback(proxy, index))
          .map(({ proxy }) => proxy)
      }
      return proxied.map(({ proxy, index }) => callback(proxy, index))
    }

    // Discovery mode — one phantom item
    const phantomItem = createProxyNode(schema, typeName, path, recorder)

    if (method === "map") {
      return [callback(phantomItem, 0)]
    }
    if (method === "find") {
      callback(phantomItem, 0)
      return phantomItem
    }
    if (method === "filter") {
      callback(phantomItem, 0)
      return [phantomItem]
    }

    return undefined
  }
}

/**
 * Create a root proxy for a GraphQL type.
 */
export function createProxy(
  schema: SchemaGraph,
  typeName: string,
  recorder: AccessRecorder,
  data?: unknown,
): unknown {
  if (arguments.length >= 4) {
    // Use __typename from root data for concrete type resolution
    let resolvedType = typeName
    if (data != null && typeof data === "object" && !Array.isArray(data)) {
      const tn = (data as Record<string, unknown>).__typename
      if (typeof tn === "string" && schema.getType(tn)) resolvedType = tn
    }
    return createProxyNode(schema, resolvedType, [], recorder, data)
  }
  return createProxyNode(schema, typeName, [], recorder)
}
