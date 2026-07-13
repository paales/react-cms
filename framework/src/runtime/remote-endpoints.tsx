/**
 * Remote metadata endpoints — static concerns of the page-embed model.
 *
 * Embedding needs NO dedicated render route: a `<RemoteFrame>` fetches
 * an ORDINARY page URL as Flight (the embed headers — see
 * `lib/page-embed.ts`), so an app exposing one parton publishes a page
 * whose route renders just that parton. What remains here is the
 * static metadata the `parton add` CLI consumes:
 *
 *   OPTIONS  *                         → CORS preflight (204)
 *   GET      /__remote/manifest.json   → embeddable-page inventory
 *   GET      /__remote/types.d.ts      → author-provided types file
 *
 * Any other path returns `null` so the caller can fall through to
 * its normal page handler.
 *
 * The manifest lists every addressable spec; specs whose `match`
 * carries a STATIC pathname (a literal URLPattern — no params, no
 * wildcards) additionally advertise it as `path`: the page a typed
 * binding embeds. The classification reads the compiled pattern's
 * grammar, not a guess about intent — a pathname pattern without
 * URLPattern syntax IS a single fixed page.
 */

import { promises as fs } from "node:fs"
import { listSpecs } from "../lib/spec-catalog.ts"
import type { CompiledMatch } from "../lib/match.ts"
import {
  CellWriteDenied,
  _listPublishedCellIds,
  getCellById,
  resolveCellValue,
  type CellInterface,
} from "../lib/cell.ts"
import {
  REMOTE_ACTION_INVOKE_PATH,
  REMOTE_CELL_ATTACH_PATH,
  REMOTE_CELL_VALUE_PATH,
  REMOTE_CELL_WRITE_PATH,
} from "../lib/page-embed.ts"
import { writeOneCell } from "./cell-write.ts"
import {
  CAPABILITY_HEADER,
  decodeCapability,
  runWithCapability,
  type Capability,
} from "./capability.ts"
import { runWithRequestAsync } from "./context.ts"
import { _getEmbedAction } from "./embed-actions.ts"
import {
  _addCommittedBumpObserver,
  encodeArgsForSelector,
  runInvalidationTransaction,
  type ParsedSelector,
} from "./invalidation-registry.ts"

export interface RemoteHandlerOptions {
  /** Short app name. Appears in the manifest so generated bindings
   *  carry a stable identifier. */
  name: string
  /** Absolute filesystem path to the author's `remote-types.ts` (or
   *  any TypeScript file). The handler serves its raw contents at
   *  `/__remote/types.d.ts` so the CLI can copy them into the
   *  consumer's repo. Omit if the app doesn't expose typed
   *  capability bindings. */
  typesPath?: string
}

/** Permissive CORS for v1 — capability scoping is the trust boundary
 *  the host can rely on; embed fetches are `credentials: "omit"`.
 *  POST covers the interactive endpoints (`cells/write`,
 *  `actions/invoke`), which a HOST browser calls cross-origin. */
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "*",
  "access-control-expose-headers": "*",
}

const MANIFEST_PATH = "/__remote/manifest.json"
const TYPES_PATH = "/__remote/types.d.ts"

export interface RemoteManifestSpec {
  /** Canonical spec id (the first refetch label). */
  selector: string
  /** PascalCase export name the CLI will use in generated bindings. */
  exportName: string
  /** Refetch labels (first is `selector`). */
  labels: string[]
  /** The embeddable page path for this spec — its `match`'s static
   *  pathname — or null when the spec has no single fixed page (no
   *  match, params, wildcards). The CLI generates bindings only for
   *  specs with a path. */
  path: string | null
  /** Type name in the served `types.d.ts`, or null if the spec
   *  doesn't declare a capability. */
  capabilityType: string | null
  /** Bound-cell requirements for embed renders — the spec's `cells`
   *  declaration (`required` per name), or null. The host binds these
   *  at its call site; runtime enforcement lives with the producer's
   *  spec pipeline. */
  cells: Record<string, { required: boolean }> | null
}

export interface RemoteManifest {
  name: string
  origin: string
  specs: RemoteManifestSpec[]
  /** Ids of the cells this app PUBLISHES across the boundary
   *  (`publish` on the cell) — the remoteCell inventory. */
  publishes: string[]
}

/** URLPattern pathname syntax — `:name` params, `*` wildcards, groups,
 *  and modifiers. A pathname pattern containing none of these is a
 *  literal path (one fixed page). */
function staticPathOf(match: CompiledMatch | undefined): string | null {
  const pathname = match?.urlPattern?.pathname
  if (!pathname) return null
  return /[:*?+(){}]/.test(pathname) ? null : pathname
}

export function buildRemoteManifest(name: string, origin: string): RemoteManifest {
  const specs = listSpecs()
    .filter((s) => s.addressable !== false)
    .map<RemoteManifestSpec>((s) => ({
      selector: s.id,
      exportName: pascalCase(s.id),
      labels: s.labels,
      path: staticPathOf(s.match),
      capabilityType: s.capabilityType ?? null,
      cells: s.cells
        ? Object.fromEntries(
            Object.entries(s.cells).map(([n, r]) => [n, { required: r.required === true }]),
          )
        : null,
    }))
    .sort((a, b) => a.selector.localeCompare(b.selector))
  return { name, origin, specs, publishes: _listPublishedCellIds() }
}

function pascalCase(input: string): string {
  return input
    .split(/[-_/.\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("")
}

// ─── Interaction + remoteCell endpoints ───────────────────────────────

/** JSON response helper with the permissive CORS surface. */
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json;charset=utf-8", ...CORS_HEADERS },
  })
}

function statusResponse(status: number): Response {
  return new Response(null, { status, headers: CORS_HEADERS })
}

/** Whether `capability` may attach to / read this cell across the
 *  boundary. Publication is per cell (`publish` on the definition);
 *  a guard callback authorizes each caller's presented bag. A throw
 *  in the guard denies. */
function cellPublishedFor(cell: CellInterface<unknown>, capability: Capability): boolean {
  const p = cell.publish
  if (p === undefined || p === false) return false
  if (p === true) return true
  try {
    return p(capability) === true
  } catch {
    return false
  }
}

/** `ParsedSelector` → the selector grammar string (type tags intact) —
 *  the same inverse `invalidation-bridge.ts` ships on its batches, so
 *  a subscriber feeds these straight into `deliverInvalidationBumps`. */
function selectorToString(p: ParsedSelector): string {
  const encoded = encodeArgsForSelector(p.constraints)
  return encoded ? `${p.name}?${encoded}` : p.name
}

/** A capability-scoped cell write from an interactive embed — the
 *  ordinary write pipeline (validation, `write`, `writeGuard`) inside
 *  the caller's request scope, with `getCapability()` resolving the
 *  presented bag so guards can compose with it. */
async function handleEmbedCellWrite(request: Request): Promise<Response> {
  let body: { cell?: unknown; partition?: unknown; value?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return statusResponse(400)
  }
  if (typeof body.cell !== "string") return statusResponse(400)
  const partition =
    body.partition !== null && typeof body.partition === "object" && !Array.isArray(body.partition)
      ? (body.partition as Record<string, unknown>)
      : {}
  if (getCellById(body.cell) === undefined) return statusResponse(404)
  const capability = decodeCapability(request.headers.get(CAPABILITY_HEADER))
  try {
    await runWithRequestAsync(request, () =>
      runWithCapability(capability, () =>
        runInvalidationTransaction(async () => {
          writeOneCell(body.cell as string, body.value, { partition })
        }),
      ),
    )
  } catch (err) {
    return statusResponse(err instanceof CellWriteDenied ? 403 : 400)
  }
  return statusResponse(204)
}

/** Invoke a registered embed action (`embedAction`) — the reachable
 *  action surface is exactly the explicit name registry; the payload
 *  is untrusted input the handler owns. */
async function handleEmbedActionInvoke(request: Request): Promise<Response> {
  let body: { action?: unknown; payload?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return statusResponse(400)
  }
  if (typeof body.action !== "string") return statusResponse(400)
  const entry = _getEmbedAction(body.action)
  if (entry === undefined) return statusResponse(404)
  const capability = decodeCapability(request.headers.get(CAPABILITY_HEADER))
  if (entry.guard !== undefined) {
    let allowed = false
    try {
      allowed = entry.guard(capability, body.payload) === true
    } catch {
      allowed = false
    }
    if (!allowed) return statusResponse(403)
  }
  try {
    await runWithRequestAsync(request, () =>
      runWithCapability(capability, () =>
        runInvalidationTransaction(async () => {
          await entry.handler(body.payload)
        }),
      ),
    )
  } catch {
    return statusResponse(500)
  }
  return statusResponse(204)
}

/** The remoteCell ATTACH — a server-to-server wake subscription on
 *  this process's committed bumps, filtered to the named PUBLISHED
 *  cells. The response is a held NDJSON stream of
 *  `{selectors: [...]}` batches — doorbells only, never values (the
 *  subscriber re-reads through the value endpoint; the store is the
 *  truth and this process is its edge). Auth is per cell: every
 *  requested id must be published to the presented capability, or the
 *  whole attach refuses 403 (no partial subscriptions — the caller's
 *  statement is the unit). */
async function handleRemoteCellAttach(request: Request): Promise<Response> {
  let body: { cells?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return statusResponse(400)
  }
  if (!Array.isArray(body.cells) || body.cells.length === 0) return statusResponse(400)
  const ids: string[] = []
  for (const raw of body.cells) {
    if (typeof raw !== "string") return statusResponse(400)
    ids.push(raw)
  }
  const capability = decodeCapability(request.headers.get(CAPABILITY_HEADER))
  for (const id of ids) {
    const cell = getCellById(id)
    // Unknown ids refuse like unpublished ones — existence is not
    // disclosed to an unauthorized caller.
    if (cell === undefined || !cellPublishedFor(cell, capability)) return statusResponse(403)
  }
  const names = new Set(ids.map((id) => `cell:${id}`))
  const encoder = new TextEncoder()
  let dispose: (() => void) | null = null
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // The acceptance line — the subscriber knows the attach stands
      // before the first bump arrives.
      controller.enqueue(encoder.encode(`{"ok":true}\n`))
      dispose = _addCommittedBumpObserver((batch) => {
        const selectors = batch.filter((p) => names.has(p.name)).map(selectorToString)
        if (selectors.length === 0) return
        try {
          controller.enqueue(encoder.encode(JSON.stringify({ selectors }) + "\n"))
        } catch {
          // Consumer gone mid-enqueue — the cancel path disposes.
          dispose?.()
          dispose = null
        }
      })
    },
    cancel() {
      dispose?.()
      dispose = null
    },
  })
  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson;charset=utf-8",
      "cache-control": "no-transform",
      ...CORS_HEADERS,
    },
  })
}

/** The remoteCell VALUE READ — the store-is-truth path a doorbell
 *  triggers. Resolves through the cell's ordinary pipeline (loader on
 *  a cold slot), at the EXPLICIT partition the caller names. */
async function handleRemoteCellValue(request: Request, url: URL): Promise<Response> {
  const id = url.searchParams.get("cell")
  if (!id) return statusResponse(400)
  const cell = getCellById(id)
  const capability = decodeCapability(request.headers.get(CAPABILITY_HEADER))
  if (cell === undefined || !cellPublishedFor(cell, capability)) return statusResponse(403)
  let args: Record<string, unknown> = {}
  const rawArgs = url.searchParams.get("args")
  if (rawArgs !== null) {
    try {
      const parsed = JSON.parse(rawArgs) as unknown
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>
      } else {
        return statusResponse(400)
      }
    } catch {
      return statusResponse(400)
    }
  }
  try {
    const { result } = await runWithRequestAsync(request, () =>
      runWithCapability(capability, () => resolveCellValue(cell, args)),
    )
    return json(200, { value: result === undefined ? null : result })
  } catch {
    return statusResponse(500)
  }
}

export function createRemoteHandler(
  opts: RemoteHandlerOptions,
): (request: Request) => Promise<Response | null> {
  return async function remoteHandler(request: Request): Promise<Response | null> {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: { ...CORS_HEADERS, "access-control-max-age": "600" },
      })
    }

    const url = new URL(request.url)

    if (request.method === "POST" && url.pathname === REMOTE_CELL_WRITE_PATH) {
      return handleEmbedCellWrite(request)
    }
    if (request.method === "POST" && url.pathname === REMOTE_ACTION_INVOKE_PATH) {
      return handleEmbedActionInvoke(request)
    }
    if (request.method === "POST" && url.pathname === REMOTE_CELL_ATTACH_PATH) {
      return handleRemoteCellAttach(request)
    }
    if (request.method === "GET" && url.pathname === REMOTE_CELL_VALUE_PATH) {
      return handleRemoteCellValue(request, url)
    }

    if (url.pathname === MANIFEST_PATH) {
      const manifest = buildRemoteManifest(opts.name, url.origin)
      return new Response(JSON.stringify(manifest, null, 2), {
        status: 200,
        headers: {
          "content-type": "application/json;charset=utf-8",
          ...CORS_HEADERS,
        },
      })
    }

    if (url.pathname === TYPES_PATH) {
      if (!opts.typesPath) {
        return new Response("// no types declared by this remote\n", {
          status: 200,
          headers: {
            "content-type": "text/plain;charset=utf-8",
            ...CORS_HEADERS,
          },
        })
      }
      try {
        const body = await fs.readFile(opts.typesPath, "utf8")
        return new Response(body, {
          status: 200,
          headers: {
            "content-type": "text/plain;charset=utf-8",
            ...CORS_HEADERS,
          },
        })
      } catch (err) {
        return new Response(`// failed to read ${opts.typesPath}: ${(err as Error).message}\n`, {
          status: 500,
          headers: {
            "content-type": "text/plain;charset=utf-8",
            ...CORS_HEADERS,
          },
        })
      }
    }

    return null
  }
}
