/**
 * Flight-payload extraction for the convergence fuzzer — decodes ONE
 * Flight document's text (a payload segment or a reassembled lane
 * body) into per-parton observations, by structural walk of the row
 * graph rather than regexes over raw text (dev-build Flight captures
 * raw props into debug rows, which a text scan would mis-read as
 * fresh renders — see CLAUDE.md).
 *
 * The walk starts at row 0 and follows only STRUCTURAL positions of
 * each element tuple (`["$", type, key, props]` — type + props), never
 * the dev-build owner/stack positions (4+), and skips `D`-tagged debug
 * rows entirely. What it recognizes:
 *
 *   - a fresh parton emission — the `PartialErrorBoundary` client
 *     reference, whose props carry `partialId` / `partialFingerprint`
 *     / `partialMatchKey`;
 *   - a hole / confirmation placeholder — `<i data-partial-id …>`,
 *     `data-partial-confirm` distinguishing the culling confirmation;
 *   - a cull pair — the `CullPair` client reference (`id`, `culled`);
 *   - parked context — anything under `<Activity mode="hidden">`
 *     (match-miss keepalive emissions, hidden variant siblings);
 *   - fixture stamps — `[S|<id>|<state>]` string tokens the fuzz
 *     fixture bodies embed, the content-level oracle currency.
 */

export interface PartonObservation {
  id: string
  /** `fresh` — a rendered PEB body; `hole` — a placeholder the client
   *  MAY fill from cache; `confirm` — a culling confirmation (the
   *  served state's fp matched the client's advertisement). */
  kind: "fresh" | "hole" | "confirm"
  /** The emission's `partialFingerprint` (fresh only). */
  fp: string | null
  matchKey: string | null
  /** Inside an `<Activity mode="hidden">` — a parked emission, not
   *  part of the displayed tree. */
  parked: boolean
}

export interface ExtractedPayload {
  /** Every parton observation reachable from the document root, in
   *  document order. One id can observe more than once (a visible
   *  emission plus hidden variant siblings). */
  observations: PartonObservation[]
  /** CullPair verdicts by id: the pair's `culled` prop. Pairs inside
   *  a hidden Activity are excluded (parked variants). */
  pairs: Map<string, boolean>
  /** Fixture stamps by id: the `<state>` half of `[S|<id>|<state>]`. */
  stamps: Map<string, string>
}

const STAMP_RE = /\[S\|([a-z0-9-]+)\|([^\]]*)\]/g
const REF_RE = /^\$(?:[L@])?([0-9a-f]+)$/

interface Row {
  value: unknown
  /** `I` row: the module specifier (`/src/lib/….tsx#Export`). */
  importName?: string
}

function parseRows(text: string): Map<string, Row> {
  const rows = new Map<string, Row>()
  for (const line of text.split("\n")) {
    const colon = line.indexOf(":")
    if (colon <= 0) continue
    const id = line.slice(0, colon)
    if (!/^[0-9a-f]+$/.test(id)) continue
    const body = line.slice(colon + 1)
    if (body.startsWith("D")) continue // debug row — never structural
    if (body.startsWith("I")) {
      try {
        const arr = JSON.parse(body.slice(1)) as unknown[]
        if (typeof arr[0] === "string") rows.set(id, { value: undefined, importName: arr[0] })
      } catch {
        /* not an import row we understand — skip */
      }
      continue
    }
    try {
      rows.set(id, { value: JSON.parse(body), importName: rows.get(id)?.importName })
    } catch {
      /* non-JSON row (raw text, truncated) — skip */
    }
  }
  return rows
}

/** Walk one Flight document's text into parton observations. */
export function extractPartonView(text: string): ExtractedPayload {
  const rows = parseRows(text)
  const out: ExtractedPayload = {
    observations: [],
    pairs: new Map(),
    stamps: new Map(),
  }
  // Guards re-entrant refs (shared props rows) per hidden-context so a
  // cycle can't loop; repeated visits of the same row in the same
  // context are idempotent for our maps and skipped for observations.
  const visiting = new Set<string>()

  const resolveRef = (s: string): { row: Row | undefined; id: string } | null => {
    const m = REF_RE.exec(s)
    if (!m) return null
    return { row: rows.get(m[1]), id: m[1] }
  }

  const scanStamps = (s: string): void => {
    STAMP_RE.lastIndex = 0
    for (let m = STAMP_RE.exec(s); m !== null; m = STAMP_RE.exec(s)) {
      out.stamps.set(m[1], m[2])
    }
  }

  const walk = (value: unknown, hidden: boolean): void => {
    if (typeof value === "string") {
      const ref = resolveRef(value)
      if (ref) {
        if (ref.row === undefined) return
        const key = `${ref.id}|${hidden ? 1 : 0}`
        if (visiting.has(key)) return
        visiting.add(key)
        if (ref.row.importName !== undefined) return // bare import ref
        walk(ref.row.value, hidden)
        return
      }
      scanStamps(value)
      return
    }
    if (Array.isArray(value)) {
      if (value[0] === "$" && value.length >= 4) {
        walkElement(value, hidden)
        return
      }
      for (const item of value) walk(item, hidden)
      return
    }
    if (value !== null && typeof value === "object") {
      for (const v of Object.values(value as Record<string, unknown>)) walk(v, hidden)
    }
  }

  const resolveProps = (raw: unknown): Record<string, unknown> | null => {
    if (typeof raw === "string") {
      const ref = resolveRef(raw)
      if (ref?.row && typeof ref.row.value === "object" && ref.row.value !== null) {
        return ref.row.value as Record<string, unknown>
      }
      return null
    }
    if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
      return raw as Record<string, unknown>
    }
    return null
  }

  const typeImportName = (type: unknown): string | null => {
    if (typeof type !== "string") return null
    const ref = resolveRef(type)
    return ref?.row?.importName ?? null
  }

  const walkElement = (el: unknown[], hidden: boolean): void => {
    let type = el[1]
    const props = resolveProps(el[3])
    if (props === null) return
    const imported = typeImportName(type)
    // Symbol element types are outlined to their own row (`"$16"` →
    // `16:"$Sreact.activity"`) — resolve the indirection before the
    // symbol checks below.
    if (typeof type === "string" && imported === null) {
      const ref = resolveRef(type)
      if (ref?.row !== undefined && typeof ref.row.value === "string") type = ref.row.value
    }

    // <Activity mode="hidden"> opens parked context for its subtree.
    if (type === "$Sreact.activity") {
      const mode = props.mode
      walk(props.children, hidden || mode === "hidden")
      return
    }
    // CullPair — the culled verdict for its id; children carry the
    // content slot (PEB body or placeholder). The skeleton subtree is
    // client-rendered fixture chrome — walked for completeness, it
    // carries no parton markers.
    if (imported !== null && imported.endsWith("#CullPair")) {
      const id = props.id
      if (typeof id === "string" && !hidden) {
        out.pairs.set(id, props.culled === true)
      }
      walk(props.children, hidden)
      return
    }
    // Fresh parton emission — the PEB client reference.
    if (typeof props.partialId === "string" && typeof props.partialFingerprint === "string") {
      out.observations.push({
        id: props.partialId,
        kind: "fresh",
        fp: props.partialFingerprint,
        matchKey: typeof props.partialMatchKey === "string" ? props.partialMatchKey : null,
        parked: hidden,
      })
      walk(props.children, hidden)
      return
    }
    // Hole / confirmation placeholder.
    if (type === "i" && typeof props["data-partial-id"] === "string") {
      out.observations.push({
        id: props["data-partial-id"],
        kind: props["data-partial-confirm"] === true ? "confirm" : "hole",
        fp: null,
        matchKey:
          typeof props["data-partial-match"] === "string" ? props["data-partial-match"] : null,
        parked: hidden,
      })
      return
    }
    walk(props, hidden)
  }

  const root = rows.get("0")
  if (root !== undefined) walk(root.value, false)
  return out
}
