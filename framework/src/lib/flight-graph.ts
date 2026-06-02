/**
 * Reference-graph rewriter for the Flight wire format.
 *
 * Where `flight-rewrite.ts` is a line-by-line transformer (rewrite one
 * row's bytes in isolation), this module understands the *graph*: a
 * Flight row references other rows by id (`$<id>`, `$L<id>`, `$@<id>`,
 * with an optional `:deref.path` suffix), and a rendered subtree is the
 * transitive closure of one root row's references.
 *
 * It powers the cache's hole machinery without ever decoding to a React
 * tree (which forces every Suspense boundary to resolve — the flatten):
 *
 * - `stripHoles` (store): finds inner-parton boundaries, replaces each
 *   with an `<i hidden data-partial-id>` placeholder row, and GCs the
 *   now-unreferenced content rows. Buffered — runs off the storage
 *   branch, not the hot path.
 * - `spliceHoles` (hit): streams the stored scaffolding rows through
 *   untouched and, at each placeholder, splices a freshly-rendered
 *   parton's rows — renumbered into a collision-free id range and
 *   deduped against the scaffold's client-module / symbol rows. The
 *   fresh render's own Suspense streams as its bytes arrive.
 *
 * Ref vs literal: a Flight ref is a JSON *string value* like `"$1f"`;
 * literal content beginning with `$` is escaped on the wire as `"$$…"`.
 * So ref rewriting JSON-walks each row's data and remaps only true
 * ref-strings — never a regex over the text, which would corrupt a
 * price string like `"$5.00"`.
 */

import { parseRow, serializeRow, type FlightRow } from "./flight-rewrite.ts"

const ENCODER = new TextEncoder()
const DECODER = new TextDecoder()

/** A parton boundary the cache treats as a live hole. */
export interface HoleRef {
  /** Row id of the parton's wire element (the seam the parent `$L`s). */
  rowId: string
  /** Registered partial id — drives the fresh render on splice. */
  partialId: string
  /** Variant key carried on the boundary, if any. */
  matchKey?: string
}

// ─── Row text <-> bytes ────────────────────────────────────────────────

/** Split buffered Flight bytes into non-empty row strings. */
export function splitRows(bytes: Uint8Array): string[] {
  return DECODER.decode(bytes).split("\n").filter((r) => r.length > 0)
}

/** Join row strings back to bytes (each row newline-terminated). */
export function joinRows(rows: string[]): Uint8Array {
  return ENCODER.encode(rows.map((r) => r + "\n").join(""))
}

// ─── Ref grammar ───────────────────────────────────────────────────────

/** Matches a Flight reference string: `$`, optional `L`/`@`, a hex id,
 *  optional `:deref.path`. Excludes `$` alone, `$$literal`, `$Sym`,
 *  `$Y`, `$undefined` (second char is not `L`/`@`/hex). */
const REF_RE = /^\$([L@]?)([0-9a-f]+)(:.*)?$/

interface ParsedRef {
  prefix: string
  id: string
  suffix: string
}

function asRef(s: string): ParsedRef | null {
  const m = REF_RE.exec(s)
  if (!m) return null
  return { prefix: m[1], id: m[2], suffix: m[3] ?? "" }
}

function refString(prefix: string, id: string, suffix: string): string {
  return `$${prefix}${id}${suffix}`
}

/** Recursively rewrite every ref-string's id via `remap`, preserving
 *  prefix + deref suffix. Non-ref strings, numbers, etc. pass through. */
function remapRefs(value: unknown, remap: (id: string) => string): unknown {
  if (typeof value === "string") {
    const ref = asRef(value)
    if (!ref) return value
    return refString(ref.prefix, remap(ref.id), ref.suffix)
  }
  if (Array.isArray(value)) return value.map((v) => remapRefs(v, remap))
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(value as Record<string, unknown>)) {
      out[k] = remapRefs((value as Record<string, unknown>)[k], remap)
    }
    return out
  }
  return value
}

/** Collect the ids of every ref-string reachable inside `value`. */
function collectRefIds(value: unknown, into: Set<string>): void {
  if (typeof value === "string") {
    const ref = asRef(value)
    if (ref) into.add(ref.id)
    return
  }
  if (Array.isArray(value)) {
    for (const v of value) collectRefIds(v, into)
    return
  }
  if (value !== null && typeof value === "object") {
    for (const k of Object.keys(value as Record<string, unknown>)) {
      collectRefIds((value as Record<string, unknown>)[k], into)
    }
  }
}

/** Parse a row's data as JSON; undefined when it isn't JSON (bare/empty). */
function tryParse(data: string): unknown {
  if (data.length === 0) return undefined
  try {
    return JSON.parse(data)
  } catch {
    return undefined
  }
}

// ─── Hole detection ────────────────────────────────────────────────────

/** Walk an element down its wrapper chain to a `PartialErrorBoundary`
 *  (the element whose props carry `partialId`), descending only through
 *  single-child wrapper elements — `<Activity>` / `<Suspense>` / the PEB
 *  import, all of which serialize with a `$…` reference as their type. A
 *  parton's wire element is exactly this chain, and an async/Suspended
 *  parton outlines it to its own row.
 *
 *  The chain ends at content: a string-typed (HTML) element like `div`,
 *  or a wrapper whose `children` is a multi-element array rather than a
 *  single nested element. So a content row that merely *inlines* a
 *  synchronous parton among its children returns null here — that parton
 *  stays frozen in the cached bytes (static content) instead of
 *  mis-stripping the whole content row. Dynamic holes fetch, hence
 *  suspend, hence always outline — so this never costs a real hole. */
function findTopLevelHole(data: unknown): { partialId: string; matchKey?: string } | null {
  if (!Array.isArray(data) || data[0] !== "$") return null
  const props = data[3]
  if (props === null || typeof props !== "object") return null
  const p = props as Record<string, unknown>
  if (typeof p.partialId === "string") {
    return {
      partialId: p.partialId,
      matchKey: typeof p.partialMatchKey === "string" ? p.partialMatchKey : undefined,
    }
  }
  // Wrapper element — its type is a `$…` reference, not an HTML tag.
  // Descend its single element child; a content child or multi-child
  // array ends the chain.
  const type = data[1]
  if (typeof type === "string" && asRef(type)) {
    const children = p.children
    if (Array.isArray(children) && children[0] === "$") return findTopLevelHole(children)
  }
  return null
}

/** Is this row a parton's wire element — the strip unit the splice
 *  replaces wholesale? True only when the row's top-level element is the
 *  wrapper chain down to a PEB (see `findTopLevelHole`). In the cached
 *  body every such `partialId` belongs to an inner hole; the cached
 *  spec's own boundary sits outside the `<Cache>` wrap. */
function holeOf(row: FlightRow): HoleRef | null {
  const found = findTopLevelHole(tryParse(row.data))
  if (!found) return null
  return { rowId: row.id, partialId: found.partialId, matchKey: found.matchKey }
}

/** Placeholder element row: `<i hidden data-partial-id=…>`. Reuses the
 *  same shape the tree-level path emitted, so a stored payload that's
 *  never spliced still decodes to an inert hidden element. */
function placeholderRow(hole: HoleRef): FlightRow {
  const props: Record<string, unknown> = {
    hidden: true,
    "data-partial": true,
    "data-partial-id": hole.partialId,
  }
  if (hole.matchKey) props["data-partial-matchkey"] = hole.matchKey
  const element = ["$", "i", null, props]
  return { id: hole.rowId, type: "", data: JSON.stringify(element) }
}

// ─── Reachability GC ───────────────────────────────────────────────────

/** Ids reachable from `roots` by following refs in each row's data.
 *  Rows sharing an id (e.g. a model row + its `D` debug row) are one
 *  node — reaching the id keeps the whole group. */
function reachableFrom(rowsById: Map<string, FlightRow[]>, roots: string[]): Set<string> {
  const seen = new Set<string>()
  const stack = [...roots]
  while (stack.length > 0) {
    const id = stack.pop() as string
    if (seen.has(id)) continue
    seen.add(id)
    const group = rowsById.get(id)
    if (!group) continue
    const refs = new Set<string>()
    for (const row of group) collectRefIds(tryParse(row.data), refs)
    for (const r of refs) if (!seen.has(r)) stack.push(r)
  }
  return seen
}

function indexById(rows: FlightRow[]): Map<string, FlightRow[]> {
  const map = new Map<string, FlightRow[]>()
  for (const row of rows) {
    const group = map.get(row.id)
    if (group) group.push(row)
    else map.set(row.id, [row])
  }
  return map
}

// ─── Strip (store) ─────────────────────────────────────────────────────

export interface StripResult {
  bytes: Uint8Array
  holes: HoleRef[]
  meta: SpliceMeta
}

/**
 * Replace every inner-parton boundary with a placeholder row and GC the
 * content it referenced. The returned bytes are the stable cache
 * scaffolding; `holes` records what to re-render on a hit.
 *
 * Buffered: callers run this on the storage branch, off the hot path.
 */
export function stripHoles(bytes: Uint8Array): StripResult {
  const rows = splitRows(bytes).map(parseRow)
  const holes: HoleRef[] = []
  const holeRowIds = new Set<string>()

  const stripped: FlightRow[] = rows.map((row) => {
    if (holeRowIds.has(row.id)) return row // already a placeholder for this id
    const hole = holeOf(row)
    if (!hole) return row
    holes.push(hole)
    holeRowIds.add(hole.rowId)
    return placeholderRow(hole)
  })

  // GC: drop rows no longer reachable from the root (`0`) now that the
  // hole roots are inert placeholders. Keeps the stored payload lean —
  // the frozen hole content never ships.
  const byId = indexById(stripped)
  const reachable = reachableFrom(byId, ["0"])
  const kept = stripped.filter((row) => row.id === "" || reachable.has(row.id))

  return { bytes: joinRows(kept.map(serializeRow)), holes, meta: metaOfRows(kept) }
}

// ─── Splice metadata ───────────────────────────────────────────────────

/** Precomputed-at-store-time facts the streaming splice needs without
 *  buffering the scaffold: the highest row id (to renumber fresh holes
 *  above it) and the scaffold's shareable import / symbol rows (so fresh
 *  holes dedup to them). */
export interface SpliceMeta {
  maxId: number
  /** `dedupKey` → scaffold row id, as entries (JSON-friendly for a
   *  future non-memory store). */
  shared: Array<[string, string]>
}

/** Data strings whose row can be shared across scaffold + fresh holes:
 *  client-module imports (`I`) and symbol rows (`"$Sreact.…"`). */
function dedupKey(row: FlightRow): string | null {
  if (row.type === "I") return `I:${row.data}`
  if (row.type === "" && /^"\$S/.test(row.data)) return `S:${row.data}`
  return null
}

function metaOfRows(rows: FlightRow[]): SpliceMeta {
  let maxId = 0
  const shared: Array<[string, string]> = []
  const seen = new Set<string>()
  for (const row of rows) {
    const n = parseInt(row.id, 16)
    if (!Number.isNaN(n) && n > maxId) maxId = n
    const key = dedupKey(row)
    if (key && !seen.has(key)) {
      seen.add(key)
      shared.push([key, row.id])
    }
  }
  return { maxId, shared }
}

/** Compute splice metadata from scaffold bytes. Exported for tests +
 *  callers that hold scaffold bytes without a fresh `stripHoles`. */
export function scaffoldMeta(bytes: Uint8Array): SpliceMeta {
  return metaOfRows(splitRows(bytes).map(parseRow))
}

// ─── Splice (hit) ──────────────────────────────────────────────────────

const ID_BLOCK = 0x100000

function toHex(n: number): string {
  return n.toString(16)
}

/**
 * Stream the stored scaffolding and splice a fresh render at each hole.
 *
 * The scaffold arrives as a *stream* (fast `bytesToStream`, or throttled
 * for the `slowSource` diagnostic / a slow remote source) and passes
 * through row-by-row at feed pace — so a no-hole payload degenerates to
 * pure passthrough (the streaming-preservation path, unified). Each
 * hole's fresh rows are renumbered into a private id block (root → the
 * hole's seam id, so the parent's `$L` resolves to the fresh render) and
 * merged in as they arrive, so the hole's own Suspense streams through.
 * Import / symbol rows the scaffold already declares are dropped and
 * their refs remapped to the scaffold's id — no payload growth.
 */
export function spliceHoles<H extends HoleRef>(
  scaffold: ReadableStream<Uint8Array>,
  holes: H[],
  meta: SpliceMeta,
  renderHole: (hole: H) => ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const holeRowIds = new Set(holes.map((h) => h.rowId))
  const shared = new Map(meta.shared)

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      // Scaffold passthrough + concurrent hole splices share the
      // controller; JS is single-threaded so enqueues interleave safely.
      await Promise.all([
        pipeScaffold(scaffold, holeRowIds, controller),
        ...holes.map((hole, i) =>
          spliceOne(controller, hole, meta.maxId + 1 + i * ID_BLOCK, shared, renderHole),
        ),
      ])
      controller.close()
    },
  })
}

/** Forward scaffold rows to the output at feed pace, dropping the inert
 *  placeholder rows (their seam ids are reused by the fresh roots). */
async function pipeScaffold(
  scaffold: ReadableStream<Uint8Array>,
  holeRowIds: Set<string>,
  controller: ReadableStreamDefaultController<Uint8Array>,
): Promise<void> {
  const reader = scaffold.getReader()
  let buffer = ""
  const handle = (line: string): void => {
    if (line.length === 0) return
    const row = parseRow(line)
    if (holeRowIds.has(row.id)) return
    controller.enqueue(ENCODER.encode(serializeRow(row) + "\n"))
  }
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += DECODER.decode(value, { stream: true })
    let nl: number
    while ((nl = buffer.indexOf("\n")) >= 0) {
      handle(buffer.slice(0, nl))
      buffer = buffer.slice(nl + 1)
    }
  }
  if (buffer.length > 0) handle(buffer)
}

async function spliceOne<H extends HoleRef>(
  controller: ReadableStreamDefaultController<Uint8Array>,
  hole: H,
  base: number,
  scaffoldShared: Map<string, string>,
  renderHole: (hole: H) => ReadableStream<Uint8Array>,
): Promise<void> {
  // Per-hole id remap: fresh root `0` → the seam id (so the parent's
  // `$L<seam>` resolves here); shared import/symbol rows → the scaffold's
  // existing id; everything else → a private block above the scaffold.
  const dropped = new Set<string>() // fresh ids whose row is deduped away
  const remap = (id: string): string => {
    if (id === "0") return hole.rowId
    const n = parseInt(id, 16)
    if (Number.isNaN(n)) return id
    return toHex(base + n)
  }

  // First pass over each row: decide dedup mapping before emitting refs.
  const sharedRemap = new Map<string, string>() // fresh id -> scaffold id

  const reader = renderHole(hole).getReader()
  let buffer = ""
  const handleLine = (line: string): void => {
    if (line.length === 0) return
    const row = parseRow(line)
    const key = dedupKey(row)
    if (key) {
      const existing = scaffoldShared.get(key)
      if (existing) {
        // Scaffold already has this module/symbol — drop the fresh row,
        // route its refs to the scaffold's id.
        sharedRemap.set(row.id, existing)
        dropped.add(row.id)
        return
      }
    }
    const idRemap = (id: string): string => sharedRemap.get(id) ?? remap(id)
    if (dropped.has(row.id)) return
    const newId = idRemap(row.id)
    const parsed = tryParse(row.data)
    const newData =
      parsed === undefined ? row.data : JSON.stringify(remapRefs(parsed, idRemap))
    controller.enqueue(ENCODER.encode(serializeRow({ ...row, id: newId, data: newData }) + "\n"))
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += DECODER.decode(value, { stream: true })
    let nl: number
    while ((nl = buffer.indexOf("\n")) >= 0) {
      handleLine(buffer.slice(0, nl))
      buffer = buffer.slice(nl + 1)
    }
  }
  if (buffer.length > 0) handleLine(buffer)
}
