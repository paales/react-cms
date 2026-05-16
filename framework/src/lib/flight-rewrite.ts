/**
 * Row-level streaming rewriter for the Flight wire format.
 *
 * Splits the source byte stream on row boundaries (`\n`), parses
 * each row's id / type / data, applies a per-row callback, and emits
 * the rewritten bytes downstream. Rows pass through as soon as
 * they're complete — Suspense pacing in the source stream is
 * preserved in the output. No tree decode / re-encode, no
 * `resolveLazies` walk.
 *
 * Two consumers in scope:
 *
 * - The cache, to store and replay bytes without the decode →
 *   resolveLazies → re-encode round-trip that flattens streaming.
 *   A cached subtree with nested Suspense boundaries staggers each
 *   reveal at replay time instead of painting all-at-once.
 *
 * - `<RemoteFrame>` (future), to rewrite module references on the
 *   wire (`./remote/X.tsx` → `https://stripe.example/X.js`), inject
 *   capability-scoped ids, and route placeholder markers in a
 *   cross-origin Flight payload — all without decoding the tree.
 *
 * Not a complete Flight parser. Recognizes only the row envelope
 * (`<hex-id>:<type><data>\n`). The row data is opaque to this
 * module; rewriters that need to inspect it `JSON.parse` it
 * themselves.
 *
 * Why splitting on raw `\n` is safe: Flight row data is JSON
 * (when present), and JSON encodes literal newlines inside strings
 * as `\\n`. A 0x0a byte in the stream can only mean end-of-row.
 *
 * See `docs/notes/replicated-state.md` and the prior conversation
 * captured in `docs/notes/transient-client-state.md` for the
 * design context.
 */

const ENCODER = new TextEncoder()

export interface FlightRow {
  /** Hex row identifier. */
  id: string
  /** Single-char type prefix (`I`, `D`, `H`, etc.) or empty for bare rows. */
  type: string
  /** Row payload (post-type-prefix). Opaque string; usually JSON. */
  data: string
}

/**
 * Per-row callback. Receives the parsed row; returns one of:
 *
 * - The same `FlightRow` — pass through unchanged.
 * - A mutated `FlightRow` — re-serialized as `<id>:<type><data>`.
 * - A `string` — emitted verbatim (without trailing `\n`; rewriter
 *   may include its own internal newlines for multi-row emissions).
 * - `null` — row dropped entirely.
 */
export type RowRewriter = (row: FlightRow) => FlightRow | string | null

/** No-op rewriter. Every row passes through unchanged. */
export const passthroughRewriter: RowRewriter = (row) => row

/**
 * Transforms a Flight byte stream row-by-row through `rewriter`.
 * Output bytes are emitted as soon as each row is rewritten, so
 * source-level streaming is preserved end-to-end.
 */
export function rewriteFlightStream(
  source: ReadableStream<Uint8Array>,
  rewriter: RowRewriter,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  const reader = source.getReader()
  let buffer = ""

  function emitLine(
    controller: ReadableStreamDefaultController<Uint8Array>,
    line: string,
  ): boolean {
    const row = parseRow(line)
    const result = rewriter(row)
    if (result === null) return false
    const out = typeof result === "string" ? result : serializeRow(result)
    controller.enqueue(ENCODER.encode(out + "\n"))
    return true
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (true) {
        const newlineIdx = buffer.indexOf("\n")
        if (newlineIdx >= 0) {
          const line = buffer.slice(0, newlineIdx)
          buffer = buffer.slice(newlineIdx + 1)
          // If the rewriter dropped this row, loop to try the next
          // one. `pull` MUST enqueue or close before returning.
          if (emitLine(controller, line)) return
          continue
        }
        const { done, value } = await reader.read()
        if (done) {
          if (buffer.length > 0) {
            // Trailing data without final newline — emit as a row.
            // Valid Flight always terminates rows with `\n`; this is
            // a lenient fallback.
            const line = buffer
            buffer = ""
            emitLine(controller, line)
          }
          controller.close()
          return
        }
        buffer += decoder.decode(value, { stream: true })
      }
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })
}

/**
 * Parses `<hex-id>:<type-prefix?><data>` into structured fields.
 *
 * Type prefix is a single uppercase ASCII letter immediately
 * followed by a JSON-start character (`{`, `[`, `"`, `t`, `f`, `n`,
 * `-`, or digit). Anything else after the colon is treated as bare
 * data with empty type.
 */
export function parseRow(line: string): FlightRow {
  const colonIdx = line.indexOf(":")
  if (colonIdx === -1) {
    // No colon — not a valid row envelope. Treat as opaque bare data
    // so the rewriter at least sees the bytes.
    return { id: "", type: "", data: line }
  }
  const id = line.slice(0, colonIdx)
  const rest = line.slice(colonIdx + 1)
  if (rest.length === 0) {
    return { id, type: "", data: "" }
  }
  const ch = rest.charCodeAt(0)
  if (ch >= 0x41 && ch <= 0x5a && rest.length > 1) {
    // A-Z followed by JSON start = type prefix.
    const next = rest.charCodeAt(1)
    if (
      next === 0x7b || // {
      next === 0x5b || // [
      next === 0x22 || // "
      next === 0x74 || // t
      next === 0x66 || // f
      next === 0x6e || // n
      next === 0x2d || // -
      (next >= 0x30 && next <= 0x39) // 0-9
    ) {
      return { id, type: rest[0], data: rest.slice(1) }
    }
  }
  return { id, type: "", data: rest }
}

/** Inverse of `parseRow`. */
export function serializeRow(row: FlightRow): string {
  return `${row.id}:${row.type}${row.data}`
}

/**
 * Composes multiple rewriters left-to-right. A `null` short-circuits
 * (the row is dropped). A `string` short-circuits and is emitted
 * verbatim — subsequent rewriters in the chain don't see it.
 */
export function composeRewriters(...rewriters: RowRewriter[]): RowRewriter {
  return (row) => {
    let current: FlightRow = row
    for (const r of rewriters) {
      const result = r(current)
      if (result === null) return null
      if (typeof result === "string") return result
      current = result
    }
    return current
  }
}

/**
 * Builds a rewriter that rewrites client-module references in `I`
 * rows. Flight encodes a client component import as a row like:
 *
 *   `1:I["./Button.tsx","main"]`
 *
 * where the first JSON element is the module path the host's bundle
 * resolves. For a `<RemoteFrame>`, the remote's module paths are
 * meaningless to the host — they need to point at the remote
 * origin's asset URLs so the host browser can dynamically import
 * them.
 *
 * `transform` receives the raw module-path string and returns the
 * rewritten one. Pass-through for paths the rewriter doesn't care
 * about: return the input unchanged.
 *
 *   const rw = moduleRefRewriter((path) =>
 *     path.startsWith("./") || path.startsWith("/")
 *       ? new URL(path, "https://stripe.example/").href
 *       : path,
 *   )
 *
 * The rewriter only touches rows whose `type === "I"` and whose
 * data parses as a JSON array starting with a string. Anything
 * else passes through.
 */
export function moduleRefRewriter(transform: (path: string) => string): RowRewriter {
  return (row) => {
    if (row.type !== "I") return row
    let parsed: unknown
    try {
      parsed = JSON.parse(row.data)
    } catch {
      return row
    }
    if (!Array.isArray(parsed) || typeof parsed[0] !== "string") return row
    const next = transform(parsed[0])
    if (next === parsed[0]) return row
    const out = [...parsed]
    out[0] = next
    return { ...row, data: JSON.stringify(out) }
  }
}
