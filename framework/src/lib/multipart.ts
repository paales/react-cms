/**
 * Streaming parser for GraphQL incremental delivery (`@defer` / `@stream`),
 * served as `multipart/mixed`:
 *
 *   --boundary
 *   Content-Type: application/json
 *
 *   { "data": {...}, "hasNext": true }            ← initial payload
 *   --boundary
 *   Content-Type: application/json
 *
 *   { "incremental": [{ "data": {...}, "path": [...] }], "hasNext": false }
 *   --boundary--
 *
 * `parseMultipartStream` yields each chunk AS IT ARRIVES off the response
 * body (initial payload first, then one entry per deferred patch) — the
 * unit the defer-aware cell loader consumes to resolve pending fragment
 * partitions incrementally. `parseMultipartResponse` is the buffered
 * convenience: it drains the stream and returns the fully-merged data.
 */

/** A deferred patch: `data` to merge at `path` in the base result. */
export interface IncrementalPatch {
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

/** The initial (non-deferred) payload. */
export interface InitialChunk<T> {
  kind: "initial"
  data: T
  hasNext: boolean
}

/** One deferred patch as it arrives. */
export interface PatchChunk {
  kind: "patch"
  patch: IncrementalPatch
  hasNext: boolean
}

export type DeferChunk<T> = InitialChunk<T> | PatchChunk

export function isMultipartResponse(response: Response): boolean {
  return (response.headers.get("content-type") ?? "").includes("multipart")
}

/**
 * Stream a multipart/mixed GraphQL response, yielding each chunk as its
 * bytes arrive. Non-multipart responses yield a single `initial` chunk.
 * Throws on GraphQL `errors` in any chunk.
 */
export async function* parseMultipartStream<T>(
  response: Response,
): AsyncGenerator<DeferChunk<T>, void, unknown> {
  const contentType = response.headers.get("content-type") ?? ""

  if (!contentType.includes("multipart")) {
    const json = (await response.json()) as { data: T; errors?: Array<{ message: string }> }
    if (json.errors?.length) {
      throw new Error(`GraphQL errors: ${json.errors.map((e) => e.message).join(", ")}`)
    }
    yield { kind: "initial", data: json.data, hasNext: false }
    return
  }

  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^\s;]+))/)
  const boundary = `--${boundaryMatch?.[1] ?? boundaryMatch?.[2] ?? "-"}`

  const body = response.body
  if (!body) throw new Error("multipart response has no body")
  const reader = body.getReader()
  const decoder = new TextDecoder()

  let buffer = ""
  let sawInitial = false

  const emit = function* (part: string): Generator<DeferChunk<T>> {
    const chunk = parseChunkJSON(part)
    if (!chunk) return
    if (chunk.errors?.length) {
      throw new Error(`GraphQL errors: ${chunk.errors.map((e) => e.message).join(", ")}`)
    }
    const hasNext = chunk.hasNext ?? false
    if (chunk.data !== undefined && !sawInitial) {
      sawInitial = true
      yield { kind: "initial", data: chunk.data as T, hasNext }
    }
    for (const patch of chunk.incremental ?? []) {
      yield { kind: "patch", patch, hasNext }
    }
  }

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    // Everything up to the LAST boundary marker is complete; the tail
    // after it may still be arriving, so keep it in the buffer.
    const parts = buffer.split(boundary)
    buffer = parts.pop() ?? ""
    for (const part of parts) yield* emit(part)
  }
  // Flush any trailing complete part (before the closing `--`).
  for (const part of buffer.split(boundary)) yield* emit(part)
}

/**
 * Buffered convenience — drain the multipart stream and return the
 * fully-merged data object. Use when you don't need incremental
 * delivery (the loader awaits the complete result).
 */
export async function parseMultipartResponse<T>(response: Response): Promise<T> {
  let base: Record<string, unknown> | null = null
  for await (const chunk of parseMultipartStream<T>(response)) {
    if (chunk.kind === "initial") {
      base = chunk.data as Record<string, unknown>
    } else if (base) {
      mergeIncremental(base, [chunk.patch])
    }
  }
  if (base == null) throw new Error("No data in multipart response")
  return base as T
}

/** Extract the JSON object from a multipart part (skipping its headers). */
function parseChunkJSON(part: string): GraphQLChunk | null {
  const start = part.indexOf("{")
  if (start < 0) return null
  try {
    return JSON.parse(part.slice(start, part.lastIndexOf("}") + 1))
  } catch {
    return null
  }
}

/** Merge incremental patches into the base data object in place. */
export function mergeIncremental(base: Record<string, unknown>, patches: IncrementalPatch[]): void {
  for (const patch of patches) {
    let target: unknown = base
    for (const segment of patch.path) {
      if (target == null || typeof target !== "object") {
        target = null
        break
      }
      target = (target as Record<string | number, unknown>)[segment]
    }
    if (target != null && typeof target === "object") {
      Object.assign(target, patch.data)
    }
  }
}
