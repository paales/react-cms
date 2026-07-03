/**
 * Vite plugin: brotli/gzip middleware for dev + preview servers.
 *
 * `vite-plugin-compression` only pre-compresses static assets at build
 * time (writes `.br` / `.gz` files alongside `.js` / `.css`). Our RSC
 * responses are dynamic streams served by a fetch handler, so there's
 * no static file for a pre-pass to compress. This plugin installs a
 * connect middleware that wraps `res.writeHead` / `res.write` /
 * `res.end` with a `zlib.createBrotliCompress` (or `createGzip`)
 * transform.
 *
 * Three gotchas worth knowing about:
 *
 *  1. `@vitejs/plugin-rsc`'s preview hook explicitly deletes the
 *     incoming `Accept-Encoding` header before its fetch handler runs
 *     (so the production handler doesn't compress twice). This plugin
 *     registers with `enforce: "pre"` AND uses the eager
 *     `server.middlewares.use(...)` form inside `configureServer` /
 *     `configurePreviewServer` so its middleware lands first in the
 *     chain, captures `Accept-Encoding`, and installs response hooks
 *     before vite-rsc strips the header.
 *
 *  2. vite-rsc routes the response through `srvx`'s `toNodeHandler`,
 *     which calls `res.writeHead(status, statusText, rawHeaders)` with
 *     a flat key/value array — bypassing `res.setHeader()`. So
 *     `res.getHeader("content-type")` returns `undefined` inside our
 *     `res.write` patch. We inspect the headers argument of the
 *     intercepted `writeHead` call directly instead.
 *
 *  3. For long-lived `markConnectionLive()` streams we MUST flush the
 *     compressor after every write — Brotli buffers heavily by default,
 *     so without flushing, tick segments would queue up in the
 *     compressor and never reach the browser until the connection
 *     closes. `Z_SYNC_FLUSH` (gzip) and `BROTLI_OPERATION_FLUSH`
 *     (brotli) emit any pending bytes downstream without ending the
 *     stream.
 *
 *  4. This middleware OWNS the encoding decision: it strips the
 *     request's `Accept-Encoding` after capturing it, so vite
 *     preview's built-in compression middleware (which never flushes
 *     mid-stream) stands down. And it honors
 *     `Cache-Control: no-transform` — the segment driver stamps that
 *     on held-open streams whose framed lanes must not sit in ANY
 *     compressor buffer (see docs/internals/streaming.md § The stream
 *     must pass through untransformed).
 */

import {
  createBrotliCompress,
  createGzip,
  constants as zlib,
} from "node:zlib"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { Plugin } from "vite"

const COMPRESSIBLE_CT =
  /^(?:text\/|application\/(?:json|javascript|xml|x-component)|[^;]+\+(?:json|xml))/i

// Brotli quality 4 ≈ nginx's default for dynamic responses — good ratio
// without burning CPU per request. Gzip 6 is the universal "balanced"
// default.
const BROTLI_QUALITY = 4
const GZIP_LEVEL = 6
// Skip compression for bodies under 1 KB when `Content-Length` is set.
// Streaming responses don't set length and always compress.
const THRESHOLD = 1024

type Encoding = "br" | "gzip"
type HeaderArrayOrObject =
  | Record<string, number | string | string[] | undefined>
  | Array<string | number>
  | undefined

interface NormalizedHeaders {
  contentType: string | undefined
  contentLength: number | undefined
}

function pickEncoding(accept: string | undefined): Encoding | null {
  if (!accept) return null
  const lower = accept.toLowerCase()
  if (/(?:^|[,\s])br(?:\s*;|\s*,|\s*$)/.test(lower)) return "br"
  if (/(?:^|[,\s])gzip(?:\s*;|\s*,|\s*$)/.test(lower)) return "gzip"
  return null
}

function readHeader(headers: HeaderArrayOrObject, name: string): string | undefined {
  if (!headers) return undefined
  const target = name.toLowerCase()
  if (Array.isArray(headers)) {
    for (let i = 0; i < headers.length - 1; i += 2) {
      const key = headers[i]
      if (typeof key === "string" && key.toLowerCase() === target) {
        const value = headers[i + 1]
        return value == null ? undefined : String(value)
      }
    }
    return undefined
  }
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === target) {
      const value = headers[key]
      if (value == null) return undefined
      return Array.isArray(value) ? value[0] : String(value)
    }
  }
  return undefined
}

function inspectHeaders(headers: HeaderArrayOrObject): NormalizedHeaders {
  const contentType = readHeader(headers, "content-type")
  const lengthStr = readHeader(headers, "content-length")
  let contentLength: number | undefined
  if (lengthStr != null) {
    const n = parseInt(lengthStr, 10)
    if (!Number.isNaN(n)) contentLength = n
  }
  return { contentType, contentLength }
}

function removeHeader(headers: HeaderArrayOrObject, name: string): HeaderArrayOrObject {
  if (!headers) return headers
  const target = name.toLowerCase()
  if (Array.isArray(headers)) {
    const out: typeof headers = []
    for (let i = 0; i < headers.length - 1; i += 2) {
      const key = headers[i]
      if (typeof key === "string" && key.toLowerCase() === target) continue
      out.push(headers[i], headers[i + 1])
    }
    return out
  }
  const out: Record<string, number | string | string[] | undefined> = {}
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === target) continue
    out[key] = headers[key]
  }
  return out
}

function appendHeader(
  headers: HeaderArrayOrObject,
  name: string,
  value: string,
): HeaderArrayOrObject {
  if (!headers) return [name, value]
  if (Array.isArray(headers)) return [...headers, name, value]
  return { ...headers, [name]: value }
}

function middleware(req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void): void {
  if (req.method === "HEAD") return next()

  const encoding = pickEncoding(req.headers["accept-encoding"])
  if (!encoding) return next()

  // Own the encoding decision: strip the request's Accept-Encoding so
  // every downstream compressor stands down. Vite's preview server
  // ships its own compression middleware (`@polka/compression`) that
  // would otherwise wrap the same response — and it never flushes
  // mid-stream, so on a held-open segment connection whose traffic has
  // gone quiet, framed lanes sit inside its brotli block indefinitely
  // and the client pipeline appears frozen. With the header stripped,
  // this middleware is the only compressor that may touch these
  // responses — and it honors `no-transform` (below), so the streams
  // that must not be buffered aren't compressed at all.
  delete req.headers["accept-encoding"]

  const origWrite = res.write.bind(res)
  const origEnd = res.end.bind(res)
  const origWriteHead = res.writeHead.bind(res)

  let compressor: ReturnType<typeof createBrotliCompress> | ReturnType<typeof createGzip> | null = null
  let decided = false

  function shouldCompress(
    contentType: string | undefined,
    contentLength: number | undefined,
    cacheControl: string | undefined,
  ): boolean {
    if (res.statusCode === 204 || res.statusCode === 304) return false
    // `Cache-Control: no-transform` is the producer's declaration that
    // the payload's byte timing IS the protocol — the segment driver
    // stamps it on held-open streams whose framed lanes must reach the
    // client the moment they drain. Compressing such a stream couples
    // its delivery to compressor block/flush behavior; honoring the
    // header keeps every transform off the wire.
    if (cacheControl != null && /no-transform/i.test(cacheControl)) return false
    if (!contentType || !COMPRESSIBLE_CT.test(contentType)) return false
    if (contentLength != null && contentLength < THRESHOLD) return false
    return true
  }

  function installCompressor(): void {
    compressor =
      encoding === "br"
        ? createBrotliCompress({
            chunkSize: 1024,
            params: {
              [zlib.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
              [zlib.BROTLI_PARAM_MODE]: zlib.BROTLI_MODE_TEXT,
            },
          })
        : createGzip({ chunkSize: 1024, level: GZIP_LEVEL })
    // Backpressure plumbing. The compressor is a Transform stream sitting
    // between the producer (whoever's writing to `res`) and the real
    // socket (origWrite). Two directions to handle:
    //
    //  • Producer → compressor: when `compressor.write(buf)` returns
    //    false, our patched `res.write` returns false too. `.pipe()`
    //    pauses and waits for `res.emit("drain")`. We forward the
    //    compressor's own drain event to res so `.pipe()` resumes.
    //
    //  • Compressor → socket: when `origWrite(chunk)` returns false the
    //    socket is congested. We pause the compressor (which stops its
    //    "data" emissions) and resume on the next time origWrite
    //    accepts a write. We use the original socket's "drain" event
    //    via `res.on("drain", ...)` — but our patched res.emit isn't
    //    in the way of internal Node emits (Node fires "drain"
    //    directly on the response object via the socket).
    compressor.on("data", (chunk: Buffer) => {
      if (!origWrite(chunk)) {
        compressor!.pause()
        res.once("drain", () => compressor!.resume())
      }
    })
    compressor.on("drain", () => {
      res.emit("drain")
    })
    compressor.on("end", () => {
      origEnd()
    })
    compressor.on("error", (err) => {
      try {
        res.destroy(err)
      } catch {}
    })
  }

  function decideFromSetHeaders(): void {
    if (decided) return
    decided = true
    const ct = res.getHeader("content-type")
    const ctStr =
      ct == null
        ? undefined
        : Array.isArray(ct)
          ? String(ct[0])
          : String(ct)
    const lenHeader = res.getHeader("content-length")
    let len: number | undefined
    if (lenHeader != null) {
      const n =
        typeof lenHeader === "number" ? lenHeader : parseInt(String(lenHeader), 10)
      if (!Number.isNaN(n)) len = n
    }
    const cc = res.getHeader("cache-control")
    const ccStr = cc == null ? undefined : Array.isArray(cc) ? cc.join(", ") : String(cc)
    if (!shouldCompress(ctStr, len, ccStr)) return
    res.removeHeader("content-length")
    res.setHeader("content-encoding", encoding!)
    const vary = res.getHeader("vary")
    if (vary == null) res.setHeader("vary", "Accept-Encoding")
    else if (typeof vary === "string" && !/accept-encoding/i.test(vary)) {
      res.setHeader("vary", `${vary}, Accept-Encoding`)
    }
    installCompressor()
  }

  res.writeHead = function patchedWriteHead(
    statusCode: number,
    statusMessageOrHeaders?: string | HeaderArrayOrObject,
    maybeHeaders?: HeaderArrayOrObject,
  ): ServerResponse {
    if (decided) {
      return origWriteHead(statusCode, statusMessageOrHeaders as any, maybeHeaders as any)
    }
    decided = true

    let statusMessage: string | undefined
    let headers: HeaderArrayOrObject
    if (typeof statusMessageOrHeaders === "string") {
      statusMessage = statusMessageOrHeaders
      headers = maybeHeaders
    } else {
      headers = statusMessageOrHeaders as HeaderArrayOrObject
    }

    const fromArg = inspectHeaders(headers)
    const fromSet = (() => {
      const ct = res.getHeader("content-type")
      const ctStr =
        ct == null
          ? undefined
          : Array.isArray(ct)
            ? String(ct[0])
            : String(ct)
      const len = res.getHeader("content-length")
      let lenN: number | undefined
      if (len != null) {
        const n = typeof len === "number" ? len : parseInt(String(len), 10)
        if (!Number.isNaN(n)) lenN = n
      }
      return { contentType: ctStr, contentLength: lenN }
    })()
    const contentType = fromArg.contentType ?? fromSet.contentType
    const contentLength = fromArg.contentLength ?? fromSet.contentLength
    const cacheControl =
      readHeader(headers, "cache-control") ??
      (() => {
        const cc = res.getHeader("cache-control")
        return cc == null ? undefined : Array.isArray(cc) ? cc.join(", ") : String(cc)
      })()
    res.statusCode = statusCode

    if (!shouldCompress(contentType, contentLength, cacheControl)) {
      return origWriteHead(statusCode, statusMessage as any, headers as any)
    }
    let nextHeaders = removeHeader(headers, "content-length")
    nextHeaders = appendHeader(nextHeaders, "content-encoding", encoding!)
    const existingVary = readHeader(nextHeaders, "vary") ?? (res.getHeader("vary") as string | undefined)
    if (!existingVary) nextHeaders = appendHeader(nextHeaders, "vary", "Accept-Encoding")
    else if (!/accept-encoding/i.test(existingVary)) {
      nextHeaders = removeHeader(nextHeaders, "vary")
      nextHeaders = appendHeader(nextHeaders, "vary", `${existingVary}, Accept-Encoding`)
    }
    if (res.hasHeader("content-length")) res.removeHeader("content-length")
    installCompressor()
    return origWriteHead(statusCode, statusMessage as any, nextHeaders as any)
  } as ServerResponse["writeHead"]

  res.write = function patchedWrite(chunk: unknown, encodingOrCb?: unknown, cb?: unknown) {
    decideFromSetHeaders()
    if (!compressor) {
      return (origWrite as (...a: unknown[]) => boolean)(chunk, encodingOrCb, cb)
    }
    const writeEncoding = typeof encodingOrCb === "string" ? (encodingOrCb as BufferEncoding) : undefined
    const writeCb =
      typeof encodingOrCb === "function"
        ? (encodingOrCb as () => void)
        : typeof cb === "function"
          ? (cb as () => void)
          : undefined
    const buf =
      typeof chunk === "string"
        ? Buffer.from(chunk, writeEncoding)
        : (chunk as Buffer | Uint8Array)
    const ok = compressor.write(buf)
    const flushOp =
      encoding === "br" ? zlib.BROTLI_OPERATION_FLUSH : zlib.Z_SYNC_FLUSH
    ;(compressor as unknown as {
      flush(op: number, cb: () => void): void
    }).flush(flushOp, () => {
      if (writeCb) writeCb()
    })
    return ok
  } as ServerResponse["write"]

  res.end = function patchedEnd(chunk?: unknown, encodingOrCb?: unknown, cb?: unknown) {
    decideFromSetHeaders()
    if (!compressor) {
      return (origEnd as (...a: unknown[]) => ServerResponse)(chunk, encodingOrCb, cb)
    }
    if (chunk != null && typeof chunk !== "function") {
      const writeEncoding =
        typeof encodingOrCb === "string" ? (encodingOrCb as BufferEncoding) : undefined
      const buf =
        typeof chunk === "string"
          ? Buffer.from(chunk, writeEncoding)
          : (chunk as Buffer | Uint8Array)
      compressor.write(buf)
    }
    compressor.end()
    const endCb =
      typeof chunk === "function"
        ? (chunk as () => void)
        : typeof encodingOrCb === "function"
          ? (encodingOrCb as () => void)
          : typeof cb === "function"
            ? (cb as () => void)
            : undefined
    if (endCb) compressor.once("end", endCb)
    return res
  } as ServerResponse["end"]

  next()
}

/**
 * Registers brotli/gzip compression middleware for both Vite dev and
 * preview servers. Place BEFORE `rsc()` in the `plugins` array so the
 * middleware lands first in the connect chain — vite-rsc's preview
 * hook strips `Accept-Encoding` from the request, and we need to read
 * it first.
 */
export function rscCompression(): Plugin {
  return {
    name: "parton:rsc-compression",
    enforce: "pre",
    configureServer(server) {
      server.middlewares.use(middleware)
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware)
    },
  }
}
