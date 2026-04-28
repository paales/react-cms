/**
 * Multipart response parser for GraphQL incremental delivery (@defer).
 *
 * Handles the multipart/mixed format used by GraphQL servers:
 * - First chunk: { data: {...}, hasNext: true }
 * - Subsequent: { incremental: [{ data: {...}, path: [...] }], hasNext: false }
 *
 * Merges all chunks into a single complete data object.
 */

interface IncrementalPatch {
  data: Record<string, unknown>
  path: (string | number)[]
  label?: string
}

interface GraphQLChunk {
  data?: Record<string, unknown>
  incremental?: IncrementalPatch[]
  hasNext?: boolean
  errors?: Array<{ message: string }>
}

/**
 * Parse a multipart/mixed GraphQL response and merge all incremental patches.
 * Returns the fully merged data object.
 */
export async function parseMultipartResponse<T>(response: Response): Promise<T> {
  const contentType = response.headers.get("content-type") ?? ""

  // Not multipart — just parse as normal JSON
  if (!contentType.includes("multipart")) {
    const json = (await response.json()) as {
      data: T
      errors?: Array<{ message: string }>
    }
    if (json.errors?.length) {
      throw new Error(`GraphQL errors: ${json.errors.map((e) => e.message).join(", ")}`)
    }
    return json.data
  }

  // Extract boundary from Content-Type
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^\s;]+))/)
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2] ?? "-"

  const text = await response.text()
  const parts = splitMultipartBody(text, boundary)

  let baseData: Record<string, unknown> | null = null
  const allErrors: Array<{ message: string }> = []

  for (const part of parts) {
    const chunk = parseChunkJSON(part)
    if (!chunk) continue

    if (chunk.errors) {
      allErrors.push(...chunk.errors)
    }

    if (chunk.data && !baseData) {
      baseData = chunk.data
    }

    if (chunk.incremental && baseData) {
      mergeIncremental(baseData, chunk.incremental)
    }
  }

  if (allErrors.length > 0) {
    throw new Error(`GraphQL errors: ${allErrors.map((e) => e.message).join(", ")}`)
  }

  if (!baseData) {
    throw new Error("No data in multipart response")
  }

  return baseData as T
}

/**
 * Check if a response is a multipart GraphQL response.
 */
export function isMultipartResponse(response: Response): boolean {
  const contentType = response.headers.get("content-type") ?? ""
  return contentType.includes("multipart")
}

/**
 * Split a multipart body into its constituent parts.
 */
function splitMultipartBody(text: string, boundary: string): string[] {
  const separator = `--${boundary}`
  const parts = text.split(separator)

  return parts
    .map((part) => part.trim())
    .filter((part) => part && part !== "--" && !part.startsWith("--"))
}

/**
 * Extract JSON from a multipart chunk (skip headers).
 */
function parseChunkJSON(part: string): GraphQLChunk | null {
  // Headers and body are separated by a blank line
  const headerBodySplit = part.indexOf("\r\n\r\n")
  const body = headerBodySplit >= 0 ? part.slice(headerBodySplit + 4) : part

  // Also try with just \n\n
  const altSplit = body.indexOf("\n\n")
  const jsonStr = altSplit >= 0 && headerBodySplit < 0 ? body.slice(altSplit + 2) : body

  // Find the JSON object in the string
  const jsonStart = jsonStr.indexOf("{")
  if (jsonStart < 0) return null

  try {
    return JSON.parse(jsonStr.slice(jsonStart))
  } catch {
    return null
  }
}

/**
 * Merge incremental patches into the base data object.
 * Each patch has a `path` (e.g., ["products", "items", 0]) and `data`.
 */
function mergeIncremental(base: Record<string, unknown>, patches: IncrementalPatch[]): void {
  for (const patch of patches) {
    let target: any = base
    for (const segment of patch.path) {
      if (target == null) break
      target = target[segment]
    }
    if (target != null && typeof target === "object") {
      Object.assign(target, patch.data)
    }
  }
}
