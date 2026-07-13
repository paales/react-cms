/**
 * Page-embed wire protocol — the slice layer under `<RemoteFrame>`
 * (the iframe model: ordinary pages are the unit of federation).
 *
 * A page embed requests an ORDINARY page URL — no special endpoint —
 * with three explicit request signals:
 *
 *   - `x-parton-render: 1` (HEADER_RSC_RENDER) so the page handler
 *     returns Flight instead of an HTML document,
 *   - `x-parton-embed-depth: N` (EMBED_DEPTH_HEADER) marking the
 *     render as an embed at nesting depth N, and
 *   - `x-parton-embed-ns: <ns>` (EMBED_NS_HEADER) — the host's
 *     placement-scoped id namespace. The producer folds it into every
 *     effective parton id it mints for that render, so two embeds of
 *     the same page (and a page embedding ITSELF) carry distinct,
 *     hydration-stable ids on the wire and in every registry.
 *
 * The producer side keys on the depth header: `PartialRoot` sees a
 * depth > 0 and, instead of the page shell (PageUrlProvider +
 * PartialsClient — the host document already runs both), emits the
 * app tree wrapped in the slice marker element:
 *
 *   ["$","parton-embed-body",null,{"children": …app tree…}]
 *
 * That marker is the explicit wire signal the consumer slices on —
 * PartialRoot writes it, nothing is inferred from page structure.
 *
 * The consumer side (`<RemoteFrame>` in remote-frame.tsx) streams the
 * response through `pageEmbedRewriter`, a row-local `RowRewriter` for
 * `rewriteFlightStream`. Per model row it JSON-walks the data and:
 *
 *   - unwraps the slice marker to its children,
 *   - unwraps the document singletons `<html>` / `<body>` to their
 *     children (React 19 renders these into the host DOCUMENT's
 *     singletons — an embedded body className would restyle the host
 *     page),
 *   - drops `<head>` and the document-metadata hoistables
 *     `<title>` / `<meta>` / `<link>` wherever they appear (React
 *     hoists them from anywhere — embedded metadata must not hijack
 *     the host's head),
 *   - drops hint rows (`:H<code>…` — preload/preinit directives that
 *     would inject into the host document's head).
 *
 * Everything else — content rows, client-module imports, Suspense
 * refs, symbol rows — passes through untouched, so within-embed
 * Suspense pacing is preserved and the host's existing decode path
 * (`createFromReadableStream`) sees a plain Flight payload whose root
 * resolves to "everything inside the embedded page's body".
 *
 * The tag classification here mirrors react-dom's own: html/head/body
 * are the singleton set, title/meta/link the hoistable set. Keying on
 * those element types is the protocol's real signal, not a guess —
 * an element typed "head" in a Flight row IS the document head.
 */

import type { RowRewriter } from "./flight-rewrite.ts"
import { hash } from "./hash.ts"
import { stableStringify } from "./stable-stringify.ts"

/** Explicit embed-depth request header. Present (≥ 1) exactly when the
 *  render is a page embed; absent/0 for every ordinary render. The
 *  consumer (`<RemoteFrame>`) writes `hostDepth + 1`; `PartialRoot`
 *  reads it to pick the embed render branch. `x-parton-*` headers are
 *  stripped from the vary-facing header surface, so app code never
 *  sees it. */
export const EMBED_DEPTH_HEADER = "x-parton-embed-depth"

/** Placement-scoped id namespace for an embed render. The host mints
 *  it per placement (`embedNamespaceFor`) and the producer folds it
 *  into every effective parton id (`applyEmbedNamespace`), so ids stay
 *  collision-free across duplicate embeds and self-embedding. */
export const EMBED_NS_HEADER = "x-parton-embed-ns"

/** Grant-set request header for an embed render. Present exactly when
 *  the host's call site declared a `grant` (`<RemoteFrame grant>`);
 *  value is the comma-joined, sorted grant-name set. The producer
 *  reads it (`getEmbedGrants()` in `runtime/capability.ts`) to render
 *  its embed-surface variant; the HOST's tier rewriter is the
 *  enforcement — the header is a statement of what the splice will
 *  admit, never a promise the producer keeps. */
export const EMBED_GRANT_HEADER = "x-parton-embed-grant"

/** Marks an embed request that carries a bound-cell projection in its
 *  BODY (the request is then a POST — headers have hard size ceilings
 *  and projected cell values may be arbitrarily large; a page's cart
 *  easily exceeds a header line). Value is always `"1"`; the body is
 *  UTF-8 JSON `{ cells: { <name>: <value> } }`. Present exactly when
 *  the host's call site bound cells (`<RemoteFrame cells>`). */
export const EMBED_CELLS_HEADER = "x-parton-embed-cells"

// ─── Remote interaction + remoteCell endpoints (wire paths) ───────────
// Framework-owned endpoints `createRemoteHandler` serves on a producer
// (the app must configure `remote: { name }` — publication is opt-in
// at the app level like the manifest). Defined here because this
// module is the embed wire-grammar home and is import-safe on the
// client (the interaction bridge posts to `write`/`invoke` from the
// host browser).

/** POST — a capability-scoped cell write from an interactive embed.
 *  Body `{cell, partition, value}`; the ordinary write pipeline runs
 *  (shape validation, `write` canonicalisation, `writeGuard` — which
 *  composes with the capability via `getCapability()`). */
export const REMOTE_CELL_WRITE_PATH = "/__remote/cells/write"

/** POST — invoke a remote-hosted embed action (`embedAction` on the
 *  producer). Body `{action, payload}`. */
export const REMOTE_ACTION_INVOKE_PATH = "/__remote/actions/invoke"

/** POST — server-to-server wake subscription on a producer's
 *  PUBLISHED cells (the remoteCell attach). Body `{cells: [ids]}`;
 *  response is a held NDJSON stream of committed-bump batches
 *  (`{selectors: [...]}` lines — doorbells, never values). */
export const REMOTE_CELL_ATTACH_PATH = "/__remote/cells/attach"

/** GET — read a published cell's value (`?cell=<id>&args=<json>`).
 *  The store-is-truth read path a remoteCell doorbell triggers. */
export const REMOTE_CELL_VALUE_PATH = "/__remote/cells/value"

/** Capability header name, restated here for client-safe imports (the
 *  canonical definition sits in `runtime/capability.ts`, which pulls
 *  `node:async_hooks` and cannot load in a browser bundle). */
export const CAPABILITY_HEADER_NAME = "x-parton-capability"

/** A capability grant name. The capability carries a grant SET, not a
 *  ladder — see docs/notes/remote-frame-arc.md § Trust. Shipped:
 *  `paint` (pull-only vocabulary) and `interactive` (paint plus the
 *  vocabulary's interactive members bound to cells and actions the
 *  remote hosts). The arc's further members (`layout`, `style`,
 *  `client`, `url`) join this union as their increments land. */
export type EmbedGrant = "paint" | "interactive"

/** Normalize a call-site `grant` value to the canonical set form.
 *  `undefined` → `null`: an ungoverned (full-trust) embed — today's
 *  tier-zero behavior, nothing on the wire. */
export function normalizeEmbedGrants(
  grant: EmbedGrant | readonly EmbedGrant[] | undefined,
): ReadonlySet<string> | null {
  if (grant === undefined) return null
  const set = new Set<string>(typeof grant === "string" ? [grant] : grant)
  return set
}

/** Wire form: sorted, comma-joined — order-independent equality. */
export function encodeEmbedGrants(grants: ReadonlySet<string>): string {
  return [...grants].sort().join(",")
}

/** The grant set an embed render carries, or `null` for an ungoverned
 *  render (no header — full trust, tier zero). Unknown grant names
 *  are preserved: a newer host's grant must not silently widen on an
 *  older producer, and set membership is the only operation. */
export function embedGrantsOf(headers: Headers): ReadonlySet<string> | null {
  const raw = headers.get(EMBED_GRANT_HEADER)
  if (raw === null) return null
  const names = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  return new Set(names)
}

/** Whether a grant set constrains the payload to the framework
 *  vocabulary. Below the Client tier there is ZERO remote module
 *  loading — the payload may reference only framework-vetted
 *  components the host resolves from its own bundle — so the
 *  predicate is `client ∉ grants`. `null` (ungoverned) is
 *  unconstrained. */
export function grantsVocabularyConstrained(grants: ReadonlySet<string> | null): boolean {
  return grants !== null && !grants.has("client")
}

/** Element type of the host-defined box a GRANTED embed renders
 *  inside. The framework stamps `contain: strict` inline (size /
 *  layout / paint containment — the Paint tier's blast-radius
 *  ceiling; the Layout grant is what will drop `size`); the HOST owns
 *  the box's dimensions via CSS (`parton-embed-box { … }` — size
 *  containment means content never sizes it). Carries the grant set
 *  as `data-grant`. */
export const EMBED_BOX_TAG = "parton-embed-box"

/** Hard cap on embed nesting. A page that embeds itself terminates
 *  deterministically: each hop increments the depth header, and the
 *  `RemoteFrame` at depth `MAX_EMBED_DEPTH` renders the inert
 *  `EMBED_LIMIT_ATTR` marker instead of fetching — the same silent
 *  termination a browser applies to a recursively-nested iframe. */
export const MAX_EMBED_DEPTH = 3

/** Attribute on the inert element a depth-capped embed renders in
 *  place of the frame. Explicit, queryable termination signal
 *  (`div[data-parton-embed-limit]`); carries the target URL as its
 *  value. */
export const EMBED_LIMIT_ATTR = "data-parton-embed-limit"

/** The slice marker element type `PartialRoot` emits around the app
 *  tree on an embed render. Never reaches a DOM — the consumer's
 *  rewriter unwraps it on the wire before decode. */
export const EMBED_BODY_TAG = "parton-embed-body"

/** Parse the embed depth off a request's headers. Absent or malformed
 *  → 0 (an ordinary, non-embed render). */
export function embedDepthOf(headers: Headers): number {
  const raw = headers.get(EMBED_DEPTH_HEADER)
  if (!raw) return 0
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : 0
}

/** The placement namespace this render mints ids under, or `null` for
 *  an ordinary (non-embed) render. */
export function embedNamespaceOf(headers: Headers): string | null {
  const raw = headers.get(EMBED_NS_HEADER)
  if (!raw) return null
  // The grammar below (`e~` / `<name>~` + hash) never contains a
  // colon, so `<ns>:<id>` splits unambiguously.
  return raw.includes(":") ? null : raw
}

/**
 * Mint the placement namespace for one embed placement on the host.
 *
 * The key folds the host render's OWN inbound namespace (`null` on an
 * ordinary page render — this is what separates the levels of a page
 * embedding ITSELF, whose frames otherwise sit at the same tree
 * position on every level), the host's ambient parton path (unique
 * per placement in the tree), the embedded page's location (origin +
 * pathname — deliberately NOT the search params, so a frame-driven
 * embed like `?step=payment` keeps ONE stable identity while its
 * content moves), and an occurrence counter that separates same-URL
 * siblings under one parent. `namespace` (the human install name,
 * when the call site passes one) prefixes the hash for debuggable
 * registry ids.
 *
 * Stability contract: the derivation is a pure function of the host
 * tree position (the inbound namespace included — itself derived the
 * same way one level up), so every whole-page render of the same host
 * page mints the same namespace — SSR, hydration, and later
 * navigations agree. Targeted refetch never re-derives: the namespace
 * is stored on the snapshot's `source` stamp and replayed.
 */
export function embedNamespaceFor(args: {
  namespace?: string
  hostNs: string | null
  hostParentPath: readonly string[]
  urlKey: string
  occurrence: number
}): string {
  const key = hash(
    stableStringify([args.hostNs, args.hostParentPath, args.urlKey, args.occurrence]),
  )
  return `${args.namespace ?? "e"}~${key}`
}

/** Strip a placement namespace off an effective id, if present. The
 *  namespace grammar reserves `~` (`e~<hash>` / `<name>~<hash>`; app
 *  ids must not use `~`), so the check is a protocol signal, not a
 *  guess: a leading `:`-segment containing `~` IS an embed namespace.
 *  Recurses so a nested chain's doubly-registered id still resolves
 *  to its bare catalog id. */
export function stripEmbedNamespace(id: string): string {
  const colon = id.indexOf(":")
  if (colon <= 0) return id
  const head = id.slice(0, colon)
  return head.includes("~") ? stripEmbedNamespace(id.slice(colon + 1)) : id
}

/** Fold the placement namespace into an effective parton id.
 *  Idempotent: a focused `?partials=` refetch renders from stored
 *  snapshots whose ids already carry the namespace (`__instanceId`,
 *  slot wiring), while the descendants it spawns mint bare ids — both
 *  pass through here, and only the bare ones gain the prefix. The `~`
 *  in the namespace grammar is framework-reserved, so an app id can
 *  never alias the check. */
export function applyEmbedNamespace(ns: string, id: string): string {
  return id.startsWith(`${ns}:`) ? id : `${ns}:${id}`
}

// ─── Row-local slice transform ─────────────────────────────────────────

/** Document singletons: React renders these into the host document's
 *  singleton elements, so an embed must unwrap them to their children.
 *  The slice marker unwraps the same way. */
const UNWRAP_TYPES = new Set<string>([EMBED_BODY_TAG, "html", "body"])

/** `<head>` and the metadata hoistables: dropped entirely. React
 *  hoists title/meta/link into the document head from anywhere in the
 *  tree — embedded metadata must not reach the host's head. */
const DROP_TYPES = new Set<string>(["head", "title", "meta", "link"])

/** Key an UNWRAPPED children array. Before the unwrap these elements
 *  were an element's static children (exempt from React's key rule);
 *  after it they float as bare array items in the host tree, which
 *  React validates. Positional keys are correct here — the slice is a
 *  fixed structural transform of one payload, so positions are stable
 *  across SSR, hydration, and re-renders. Author-keyed elements keep
 *  their keys; refs and non-element items pass through. */
function keyUnwrapped(value: unknown): unknown {
  if (!Array.isArray(value) || value[0] === "$") return value
  return value.map((item, i) => {
    if (Array.isArray(item) && item[0] === "$" && typeof item[1] === "string" && item[2] == null) {
      const keyed = [...item]
      keyed[2] = `pe:${i}`
      return keyed
    }
    return item
  })
}

/** A Flight element tuple is `["$", type, key, props, …]`. Literal
 *  strings beginning with `$` are escaped as `$$…` on the wire, so a
 *  raw `"$"` in first position is unambiguously an element. */
function transformNode(value: unknown): unknown {
  if (Array.isArray(value)) {
    if (value[0] === "$" && typeof value[1] === "string") {
      const type = value[1]
      if (DROP_TYPES.has(type)) return null
      if (UNWRAP_TYPES.has(type)) {
        const props = value[3]
        if (props !== null && typeof props === "object" && !Array.isArray(props)) {
          return keyUnwrapped(transformNode((props as Record<string, unknown>).children ?? null))
        }
        // Props outlined to another row (dedup) — the wrapper's
        // children aren't visible row-locally. Dropping the element
        // is the safe direction: a leaked <html>/<body> would restyle
        // the host document.
        return null
      }
    }
    return value.map(transformNode)
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>)) {
      out[key] = transformNode((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

/**
 * Streaming, row-local slice for an embedded page's Flight payload.
 * Pass to `rewriteFlightStream`. Only model rows (empty type prefix)
 * are inspected — imports (`I`), errors (`E`), debug (`D`), console
 * (`W`), and text (`T`) rows pass through untouched. The transform is
 * row-local (no cross-row graph walk, no buffering): the payload's
 * reference graph stays intact, and rows orphaned by a drop (the
 * head's outlined content) are simply never reached by the host's
 * re-encode.
 */
export const pageEmbedRewriter: RowRewriter = (row) => {
  // Hint rows (`:H<code><json>`) — resource-preload directives aimed
  // at the document head. They parse as bare rows with an empty id;
  // the `H` + code letter is the protocol's hint grammar.
  if (row.id === "" && row.type === "" && /^H[a-zA-Z]/.test(row.data)) return null
  if (row.type !== "") return row
  if (row.data.length === 0) return row
  let parsed: unknown
  try {
    parsed = JSON.parse(row.data)
  } catch {
    return row
  }
  return { ...row, data: JSON.stringify(transformNode(parsed)) }
}
