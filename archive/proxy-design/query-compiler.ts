/**
 * Compiles an access path tree into a GraphQL query string.
 */

import type { AccessPath } from "./access-recorder.js"

/**
 * Wrap a string to be inserted as a raw GraphQL expression (no quotes).
 * Use for object literals, enums, etc: raw("{id: asc}"), raw("PUBLISHED")
 */
export function raw(value: string): RawGraphQL {
  return new RawGraphQL(value)
}

export class RawGraphQL {
  constructor(public readonly value: string) {}
  toString() {
    return this.value
  }
}

export function compileValue(value: unknown): string {
  if (value instanceof RawGraphQL) return value.value
  if (typeof value === "string") return `"${value}"`
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (value === null) return "null"
  if (Array.isArray(value)) return `[${value.map(compileValue).join(", ")}]`
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
    return `{${entries.map(([k, v]) => `${k}: ${compileValue(v)}`).join(", ")}}`
  }
  return String(value)
}

function compileArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args)
  if (entries.length === 0) return ""

  const parts = entries.map(([key, value]) => `${key}: ${compileValue(value)}`)

  return `(${parts.join(", ")})`
}

function compileNode(node: AccessPath, indent: number): string {
  const padding = "  ".repeat(indent)
  const args = node.args ? compileArgs(node.args) : ""
  const prefix = node.alias ? `${node.alias}: ` : ""

  if (node.children.length === 0) {
    return `${padding}${prefix}${node.field}${args}`
  }

  const children = node.children.map((child) => compileNode(child, indent + 1)).join("\n")

  // Inject __typename for all object selections
  return `${padding}${prefix}${node.field}${args} {\n${padding}  __typename\n${children}\n${padding}}`
}

/**
 * Compile an access tree into a GraphQL query body (without the query wrapper).
 * Returns just the selection set, e.g.:
 *   name
 *   sprites {
 *     front_default
 *   }
 */
export function compileSelectionSet(tree: AccessPath[]): string {
  return tree.map((node) => compileNode(node, 0)).join("\n")
}

/**
 * Compile an access tree into a full GraphQL query.
 *
 * @param tree - The access path tree from the recorder
 * @param rootField - The root field to query (e.g., 'pokemon_v2_pokemon')
 * @param rootArgs - Arguments for the root field (e.g., { where: { id: { _eq: 1 } } })
 */
export function compileQuery(
  tree: AccessPath[],
  rootField?: string,
  rootArgs?: Record<string, unknown>,
): string {
  if (rootField) {
    const args = rootArgs ? compileArgs(rootArgs) : ""
    const selection = tree.map((node) => compileNode(node, 2)).join("\n")
    return `query {\n  ${rootField}${args} {\n    __typename\n${selection}\n  }\n}`
  }

  const selection = tree.map((node) => compileNode(node, 1)).join("\n")
  return `query {\n  __typename\n${selection}\n}`
}
