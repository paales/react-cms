/**
 * Tier enforcement — the grant-driven `RowRewriter` composed onto the
 * ONE embed splice pipeline (after `pageEmbedRewriter`, which already
 * strips document chrome and hint rows — tier zero).
 *
 * A vocabulary-constrained grant (any grant set without `client` —
 * v1: Paint) means the payload may reference only the framework
 * vocabulary (`lib/vocabulary.tsx`). Enforcement is structural, at
 * splice time, on the host:
 *
 *   - `I` rows (client-module imports) are dropped — below the Client
 *     tier there is ZERO remote module loading. The rewriter records
 *     each dropped row id; an element whose type references one is a
 *     violation (`offense: "module"`).
 *   - Element rows are re-audited against the `VOCABULARY` table:
 *     admitted tags keep only their audited attributes (values
 *     re-validated through the same `sanitizeVocabAttr` the emit side
 *     uses — a bad attribute drops the ATTRIBUTE, never the element);
 *     any other element type degrades (`offense: "element"`).
 *   - Structural React symbols pass: `react.suspense` and
 *     `react.fragment` carry streaming pacing and grouping, reference
 *     no code, and render nothing of their own. Any other symbol
 *     (Activity et al — framework machinery that has no business on a
 *     vocabulary surface) degrades like an unknown element.
 *   - A vocabulary element whose props are outlined to another row
 *     (`"$<id>"` — Flight dedup) can't be audited row-locally and
 *     degrades (`offense: "opaque-props"`) — the safe direction,
 *     mirroring `pageEmbedRewriter`'s outlined-singleton rule.
 *
 * The transform stays row-local over the JSON (no cross-row graph
 * walk, no buffering); the only cross-row state is the id ledgers for
 * module and symbol rows, both of which Flight flushes before any row
 * that references them (pinned by the format canary).
 *
 * One SILENT drop rides along: `@vitejs/plugin-rsc` injects a CSS
 * resources block beside the page root — `<link rel="stylesheet">`
 * elements (already dead at tier zero: link is head-directed) plus a
 * client helper from its own `virtual:vite-rsc/…` module namespace
 * that exists only to dedupe those links. That's bundler head
 * plumbing, not page content — a module specifier in the plugin's
 * virtual namespace IS that plumbing (the same protocol-signal
 * reasoning as tier zero's "an element typed `head` IS the document
 * head") — so it drops without a marker or a log line. The drop is
 * unconditional either way; only the loudness differs, so nothing can
 * be smuggled through the quiet path. (Prod builds hash the specifier
 * away; there the helper degrades as an ordinary module violation —
 * safe direction, one log line.)
 *
 * The DEV debug channel is dropped wholesale: `D` (debug-info attach)
 * and `W` (console replay) rows carry the remote's introspection data
 * — component names, source paths, `$E` function sources, and RAW
 * pre-audit props — none of which is vocabulary, all of which
 * references remote source. Admitted elements are re-emitted as bare
 * 4-tuples (type, key, props — the dev builds' trailing debug-ref
 * entries stripped), so the debug metadata rows those refs pointed at
 * end up orphaned and are never reached by the host's re-encode —
 * the same orphaning `pageEmbedRewriter` relies on for dropped-head
 * content. Prod payloads carry none of this; the drop makes dev and
 * prod splice identically.
 *
 * The rewriter still WALKS metadata rows it cannot distinguish from
 * content (they are plain model rows); violations found there degrade
 * in place (harmless — the rows are orphaned) but must not flood the
 * host log with duplicates of every content violation. Hence the log
 * dedupe: one structured line per distinct (offense, type) per
 * splice. An element-type reference that resolves to NEITHER ledger
 * (possible only in debug metadata, where owner/source refs sit in
 * type position — real content types are tags, symbols, or module
 * refs, and both ledgers flush first) degrades silently.
 *
 * Violation policy — decided as DEGRADE + LOUD (the framework's
 * degrade-never-block posture; docs/notes/remote-frame-arc.md §
 * Known unknowns): the offending row resolves to nothing, one
 * structured log line fires per distinct (offense, type) per splice,
 * and in DEV a visible `parton-tier-violation` marker takes the
 * dropped element's place so the degradation is impossible to miss
 * while building. Prod: silent degrade + the log line. The whole
 * policy is `tierViolationPolicy` — ONE function; flipping the
 * decision (block, fully silent, custom overlay) is an edit there,
 * not a hunt through conditionals.
 */

import type { FlightRow, RowRewriter } from "./flight-rewrite.ts"
import { TIER_VIOLATION_TAG, VOCABULARY, sanitizeVocabAttr } from "./vocabulary.tsx"

export interface TierViolation {
  /** Embedded page URL the offending row arrived from. */
  url: string
  /** The grant set the splice ran under. */
  grants: readonly string[]
  offense: "element" | "module" | "opaque-props"
  /** Offending element type, symbol name, or module path. */
  type: string
}

/**
 * THE tier-violation policy point — degrade + loud.
 *
 * Returns the node that takes the offending element's place in the
 * row (`null` = nothing), and emits the structured log line when
 * `log` is set (the rewriter dedupes: once per distinct offense per
 * splice). Every behavior of a violation — what replaces the row,
 * what gets logged, how DEV differs from prod — lives here and only
 * here.
 */
export function tierViolationPolicy(
  violation: TierViolation,
  opts: { dev: boolean; log: boolean; key?: string | null },
): unknown {
  if (opts.log) {
    // One structured line per offending row — greppable in host logs,
    // prod and dev alike. The DEV console gets the same line; the
    // visible marker below is what makes dev "loud".
    console.error(`[parton] tier-violation ${JSON.stringify(violation)}`)
  }
  if (!opts.dev) return null
  // DEV marker: a raw Flight element tuple for the reserved
  // `parton-tier-violation` tag (styled by the vocabulary
  // stylesheet). Preserves the dropped element's key so array
  // positions stay stable.
  return [
    "$",
    TIER_VIOLATION_TAG,
    opts.key ?? null,
    { "data-offense": violation.offense, "data-type": violation.type },
  ]
}

/** Structural symbols admitted below the Client tier. */
const ALLOWED_SYMBOLS = new Set(["react.suspense", "react.fragment"])

/** Module specifiers that are bundler plumbing, not page content —
 *  dropped silently (see the module doc). */
function isBundlerPlumbing(path: string): boolean {
  return path.includes("virtual:vite-rsc/")
}

/** `"$5"` / `"$L5"` / `"$@5"` element-type reference → row id. */
function refRowId(type: string): string | null {
  const m = /^\$([L@]?)([0-9a-fA-F]+)$/.exec(type)
  return m ? m[2] : null
}

/**
 * Build the tier rewriter for one embed splice. Stateful per stream
 * (module/symbol row ledgers) — mint a fresh one per response.
 */
export function createTierRewriter(opts: {
  grants: ReadonlySet<string>
  /** Embedded page URL — carried on every violation report. */
  url: string
  /** Override the DEV/prod verdict (defaults to the build flag). */
  dev?: boolean
}): RowRewriter {
  const dev = opts.dev ?? import.meta.env?.DEV === true
  const grants = [...opts.grants].sort()
  /** Dropped `I` row id → module path. */
  const moduleRows = new Map<string, string>()
  /** Dropped `I` row ids that are bundler plumbing — references
   *  degrade to nothing, silently. */
  const plumbingRows = new Set<string>()
  /** Symbol row id → symbol name (`"$Sreact.suspense"` rows). */
  const symbolRows = new Map<string, string>()
  /** Log dedupe — one structured line per distinct (offense, type)
   *  per splice. Dev payloads duplicate every content element into
   *  debug metadata rows this rewriter can't tell apart from content;
   *  without the dedupe each violation would log once per copy. */
  const logged = new Set<string>()

  function degrade(offense: TierViolation["offense"], type: string, key: string | null): unknown {
    const dedupeKey = `${offense}|${type}`
    const log = !logged.has(dedupeKey)
    logged.add(dedupeKey)
    return tierViolationPolicy({ url: opts.url, grants, offense, type }, { dev, log, key })
  }

  /** Audit one vocabulary element against its table entry. Rebuilt as
   *  a bare 4-tuple — dev builds' trailing debug-ref entries are
   *  stripped, which is what orphans the debug metadata rows. */
  function auditVocab(tag: string, key: string | null, props: unknown): unknown {
    if (props !== null && (typeof props !== "object" || Array.isArray(props))) {
      // Outlined / non-object props — unauditable row-locally.
      return degrade("opaque-props", tag, key)
    }
    const spec = VOCABULARY[tag]
    const bag = (props ?? {}) as Record<string, unknown>
    const clean: Record<string, unknown> = {}
    for (const [name, value] of Object.entries(bag)) {
      if (name === "children") {
        if (spec.children) clean.children = walk(value)
        continue
      }
      const rule = spec.attrs[name]
      if (!rule) continue // unlisted prop — sanitize-drop, not a violation
      const sane = sanitizeVocabAttr(rule, value)
      if (sane !== null) clean[name] = sane
    }
    return ["$", tag, key, clean]
  }

  function walkElement(value: unknown[]): unknown {
    const type = value[1] as string
    const key = typeof value[2] === "string" ? value[2] : null
    const props = value[3]

    // Reserved-tag / audited-HTML vocabulary member. Admission is
    // grant-gated per tag: a member carrying a `grant` requirement
    // (the interactive set) survives only a splice whose grant set
    // holds it — under plain Paint it degrades exactly like any
    // non-vocabulary row.
    if (!type.startsWith("$")) {
      const spec = Object.prototype.hasOwnProperty.call(VOCABULARY, type)
        ? VOCABULARY[type]
        : undefined
      if (spec !== undefined && (spec.grant === undefined || opts.grants.has(spec.grant))) {
        return auditVocab(type, key, props)
      }
      return degrade("element", type, key)
    }

    // Inline well-known symbol (`"$Sreact.suspense"`).
    if (type.startsWith("$S")) {
      const name = type.slice(2)
      if (ALLOWED_SYMBOLS.has(name)) return ["$", type, value[2], walk(props)]
      return degrade("element", name, key)
    }

    // Row reference — a symbol row, or a dropped client-module import.
    const rowId = refRowId(type)
    if (rowId !== null) {
      if (plumbingRows.has(rowId)) return null
      const modulePath = moduleRows.get(rowId)
      if (modulePath !== undefined) return degrade("module", modulePath, key)
      const symbol = symbolRows.get(rowId)
      if (symbol !== undefined) {
        if (ALLOWED_SYMBOLS.has(symbol)) return ["$", type, value[2], walk(props)]
        return degrade("element", symbol, key)
      }
    }
    // Unresolvable element-type reference. Real content types are
    // tags, symbols, or module refs — the ledgers flush first — so
    // this arm is reached only by debug metadata (owner/source refs in
    // type position). Degrade without a log line; the safe direction
    // stays, the host log stays signal.
    return tierViolationPolicy(
      { url: opts.url, grants, offense: "element", type },
      { dev, log: false, key },
    )
  }

  function walk(value: unknown): unknown {
    if (typeof value === "string" && value.startsWith("$")) {
      // A bare `$…` string is a wire REFERENCE (literals are escaped
      // `$$…`). One pointing at a dropped module row would strand the
      // decoder on a row that never arrives — degrade it in place.
      const rid = refRowId(value)
      if (rid !== null) {
        if (plumbingRows.has(rid)) return null
        if (moduleRows.has(rid)) return degrade("module", moduleRows.get(rid)!, null)
      }
      return value
    }
    if (Array.isArray(value)) {
      if (value[0] === "$" && typeof value[1] === "string") return walkElement(value)
      return value.map((item) => walk(item))
    }
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {}
      for (const k of Object.keys(value as Record<string, unknown>)) {
        out[k] = walk((value as Record<string, unknown>)[k])
      }
      return out
    }
    return value
  }

  return (row: FlightRow) => {
    // Client-module import: record + drop. The log fires on the
    // element that references it, not on the import itself — an
    // unreferenced import degrades silently.
    if (row.type === "I") {
      let path = row.data
      try {
        const parsed = JSON.parse(row.data)
        if (Array.isArray(parsed) && typeof parsed[0] === "string") path = parsed[0]
      } catch {
        // keep the raw data as the reported path
      }
      if (isBundlerPlumbing(path)) plumbingRows.add(row.id)
      else moduleRows.set(row.id, path)
      return null
    }
    // The remote's debug channel — see the module doc. Prod payloads
    // carry neither row kind; dropping them makes dev splice like prod.
    if (row.type === "D" || row.type === "W") return null
    if (row.type !== "" || row.data.length === 0) return row
    let parsed: unknown
    try {
      parsed = JSON.parse(row.data)
    } catch {
      return row
    }
    // Symbol row (`"$Sreact.suspense"`): ledger + pass. The row alone
    // references no code; admission is decided at the element that
    // uses it.
    if (typeof parsed === "string" && parsed.startsWith("$S")) {
      symbolRows.set(row.id, parsed.slice(2))
      return row
    }
    return { ...row, data: JSON.stringify(walk(parsed)) }
  }
}
