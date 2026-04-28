import { djb2 as hashStr } from "../../src/lib/hash.ts"

/**
 * Records property access paths during a render pass.
 *
 * The recorder collects paths like ['name'], ['sprites', 'front_default']
 * and merges them into a tree structure for query compilation.
 *
 * When the same field is called multiple times with different arguments
 * (e.g., two components querying pokemon_v2_pokemon with different
 * filters), the recorder assigns GraphQL aliases so both queries
 * coexist without merging args.
 */

export interface AccessPath {
  /** The field name at this level */
  field: string
  /** GraphQL alias (when same field used with different args) */
  alias?: string
  /** Arguments passed (for parameterized fields) */
  args?: Record<string, unknown>
  /** Whether this field was accessed as a list (.map, .find, etc.) */
  isList?: boolean
  /** Nested field accesses */
  children: AccessPath[]
}

export class AccessRecorder {
  private roots: Map<string, AccessPath> = new Map()

  /** Track distinct arg sets per field path: pathKey → (argsKey → alias) */
  private paramEntries: Map<string, Map<string, string>> = new Map()
  /** Reverse lookup: alias → original field name */
  private aliasToField: Map<string, string> = new Map()

  /**
   * Resolve (or create) an alias for a parameterized field.
   *
   * First unique arg set for a field uses the original name.
   * Subsequent distinct arg sets get a hash-based alias.
   * Same args always return the same alias (deterministic).
   */
  resolveAlias(path: string[], args: Record<string, unknown>): string {
    const fieldName = path[path.length - 1]
    const pathKey = path.join(".")
    const argsKey = stableArgsKey(args)

    let entries = this.paramEntries.get(pathKey)
    if (!entries) {
      entries = new Map()
      this.paramEntries.set(pathKey, entries)
    }

    const existing = entries.get(argsKey)
    if (existing) return existing

    if (entries.size === 0) {
      // First arg set — use original field name (no alias)
      entries.set(argsKey, fieldName)
      return fieldName
    }

    // Additional arg set — hash-based alias
    const alias = `${fieldName}__${hashStr(argsKey)}`
    entries.set(argsKey, alias)
    this.aliasToField.set(alias, fieldName)
    return alias
  }

  /**
   * Record a field access path.
   * Paths are arrays of field names from root to leaf.
   */
  recordAccess(path: string[], args?: Record<string, unknown>, listIndices?: Set<number>): void {
    if (path.length === 0) return

    const [first, ...rest] = path
    let node = this.roots.get(first)
    if (!node) {
      // Check if this is an aliased key
      const field = this.aliasToField.get(first) ?? first
      node = {
        field,
        alias: first !== field ? first : undefined,
        children: [],
      }
      this.roots.set(first, node)
    }

    if (listIndices?.has(0)) {
      node.isList = true
    }

    let current = node
    for (let i = 0; i < rest.length; i++) {
      const fieldName = rest[i]
      let child = current.children.find((c) => c.field === fieldName)
      if (!child) {
        child = { field: fieldName, children: [] }
        current.children.push(child)
      }
      if (listIndices?.has(i + 1)) {
        child.isList = true
      }
      current = child
    }

    // Attach args to the deepest node if this is a parameterized access
    if (args && Object.keys(args).length > 0) {
      current.args = { ...current.args, ...args }
    }
  }

  /**
   * Get all recorded access paths as a tree.
   */
  getAccessTree(): AccessPath[] {
    return Array.from(this.roots.values())
  }

  /**
   * Reset all recorded paths.
   */
  reset(): void {
    this.roots.clear()
    this.paramEntries.clear()
    this.aliasToField.clear()
  }
}

function stableArgsKey(args: Record<string, unknown>): string {
  return Object.keys(args)
    .sort()
    .map((k) => `${k}=${String(args[k])}`)
    .join("&")
}
