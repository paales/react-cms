/**
 * GraphQL schema introspection and type lookup.
 *
 * Fetches the schema from a GraphQL endpoint and provides
 * type information needed by the proxy (field types, whether
 * a field is a scalar/object/list, etc.)
 */

export interface SchemaField {
  name: string
  type: SchemaType
  args: SchemaArg[]
}

export interface SchemaArg {
  name: string
  type: SchemaType
}

export interface SchemaType {
  kind: "SCALAR" | "OBJECT" | "LIST" | "NON_NULL" | "ENUM" | "INPUT_OBJECT" | "INTERFACE" | "UNION"
  name: string | null
  ofType: SchemaType | null
}

export interface SchemaObjectType {
  name: string
  fields: SchemaField[]
}

export class SchemaGraph {
  private types: Map<string, SchemaObjectType>
  private queryRootName: string

  constructor(types: SchemaObjectType[], queryRootName = "Query") {
    this.types = new Map()
    for (const type of types) {
      this.types.set(type.name, type)
    }
    this.queryRootName = queryRootName
  }

  getQueryTypeName(): string {
    return this.queryRootName
  }

  getType(typeName: string): SchemaObjectType | undefined {
    return this.types.get(typeName)
  }

  getField(typeName: string, fieldName: string): SchemaField | undefined {
    return this.types.get(typeName)?.fields.find((f) => f.name === fieldName)
  }

  /**
   * Unwrap NON_NULL and LIST wrappers to get the named type.
   */
  unwrapType(type: SchemaType): {
    name: string
    kind: string
    isList: boolean
  } {
    let isList = false
    let current = type
    while (current.ofType) {
      if (current.kind === "LIST") isList = true
      current = current.ofType
    }
    return { name: current.name ?? "Unknown", kind: current.kind, isList }
  }

  /**
   * Get the resolved (unwrapped) type info for a field.
   */
  getFieldType(
    typeName: string,
    fieldName: string,
  ): { name: string; kind: string; isList: boolean } | undefined {
    const field = this.getField(typeName, fieldName)
    if (!field) return undefined
    return this.unwrapType(field.type)
  }

  /**
   * Check if a field resolves to a scalar or enum (leaf value).
   */
  isLeaf(typeName: string, fieldName: string): boolean {
    const fieldType = this.getFieldType(typeName, fieldName)
    if (!fieldType) return true // Unknown fields treated as leaves
    return fieldType.kind === "SCALAR" || fieldType.kind === "ENUM"
  }

  /**
   * Check if a field resolves to a list.
   */
  isList(typeName: string, fieldName: string): boolean {
    const fieldType = this.getFieldType(typeName, fieldName)
    return fieldType?.isList ?? false
  }

  /**
   * Get a mock value for a scalar type.
   */
  getMockValue(scalarName: string): string | number | boolean {
    switch (scalarName) {
      case "String":
        return "__mock_string__"
      case "Int":
        return 0
      case "Float":
        return 0.0
      case "Boolean":
        return true
      case "ID":
        return "__mock_id__"
      default:
        return "__mock__"
    }
  }
}

const INTROSPECTION_QUERY = `
  query IntrospectionQuery {
    __schema {
      queryType { name }
      types {
        name
        kind
        fields {
          name
          type {
            kind
            name
            ofType {
              kind
              name
              ofType {
                kind
                name
                ofType {
                  kind
                  name
                  ofType {
                    kind
                    name
                  }
                }
              }
            }
          }
          args {
            name
            type {
              kind
              name
              ofType {
                kind
                name
                ofType {
                  kind
                  name
                }
              }
            }
          }
        }
      }
    }
  }
`

export async function fetchSchema(endpoint: string): Promise<SchemaGraph> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: INTROSPECTION_QUERY }),
  })

  if (!response.ok) {
    throw new Error(`Schema introspection failed: ${response.status}`)
  }

  const json = (await response.json()) as {
    data: {
      __schema: {
        queryType: { name: string }
        types: Array<{
          name: string
          kind: string
          fields: SchemaField[] | null
        }>
      }
    }
  }

  const queryRootName = json.data.__schema.queryType.name

  const objectTypes = json.data.__schema.types
    .filter((t) => (t.kind === "OBJECT" || t.kind === "INTERFACE") && !t.name.startsWith("__"))
    .map((t) => ({
      name: t.name,
      fields: t.fields ?? [],
    }))

  return new SchemaGraph(objectTypes, queryRootName)
}
