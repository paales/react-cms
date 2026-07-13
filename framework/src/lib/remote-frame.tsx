/**
 * `<RemoteFrame>` — embed an ordinary page (the iframe model).
 *
 * A `<RemoteFrame url>` pointed at a page URL — same-origin path or
 * cross-origin URL — fetches that page as Flight (the `x-parton-render`
 * header; the URL stays the page URL, no special route), slices the
 * payload to the page's body content, and stitches the decoded subtree
 * into the host's render. Like an iframe, minus the separate browsing
 * context. Because the target is just a page, an app can embed itself.
 *
 * Producer contract: the embed-depth header makes the target's
 * `PartialRoot` skip the page shell (PageUrlProvider + PartialsClient —
 * the host document already runs both) and wrap the app tree in the
 * explicit slice marker (`EMBED_BODY_TAG`). Consumer contract:
 * `pageEmbedRewriter` unwraps the marker and the document singletons,
 * and strips head/title/meta/link + hint rows so embedded metadata
 * can't hijack the host's head. See `lib/page-embed.ts`.
 *
 * Identity: every placement mints a namespace (`embedNamespaceFor` —
 * host parent path × page location × occurrence) and sends it as the
 * embed-ns header; the producer folds it into every effective parton
 * id it registers and serializes. Duplicate embeds of one page and a
 * page embedding ITSELF therefore carry distinct, hydration-stable
 * ids end-to-end.
 *
 * The response is segmented Flight (the same wire the browser client
 * reads), split with `splitSegments`: the first segment's body is the
 * Flight payload; its trailer map carries a `snapshots` entry that
 * registers every parton the embedded page rendered into the HOST's
 * registry — stamped `source: { kind: "page", … }` so a selector-
 * targeted refetch routes back as `?partials=<id>` at the embedded
 * URL (`_pageEmbedRefetch`). Registration rides `deferCommitUntil`,
 * so the host's commit waits for the trailer.
 *
 * Recursion terminates on the depth header with an inert marker
 * element, never a throw: a thrown rejection's containment is
 * timing-dependent (an already-rejected lazy throws synchronously
 * into the enclosing task row and surfaces at the nearest OUTER
 * boundary), so position-stable termination requires a value.
 *
 * Place inside a Suspense boundary if the remote may be slow:
 *
 *   <Suspense fallback={<Spinner />}>
 *     <RemoteFrame url="/pricing-widget" />
 *   </Suspense>
 */

import { createElement, type ReactNode } from "react"
import { createFromReadableStream } from "./flight-runtime.ts"
import {
  composeRewriters,
  moduleRefRewriter,
  rewriteFlightStream,
  type RowRewriter,
} from "./flight-rewrite.ts"
import { splitSegments } from "./fp-trailer-split.ts"
import {
  EMBED_BOX_TAG,
  EMBED_CELLS_HEADER,
  EMBED_DEPTH_HEADER,
  EMBED_GRANT_HEADER,
  EMBED_LIMIT_ATTR,
  EMBED_NS_HEADER,
  MAX_EMBED_DEPTH,
  embedDepthOf,
  embedNamespaceFor,
  embedNamespaceOf,
  encodeEmbedGrants,
  grantsVocabularyConstrained,
  normalizeEmbedGrants,
  pageEmbedRewriter,
  type EmbedGrant,
} from "./page-embed.ts"
import {
  getCellById,
  isBoundCell,
  isCellHandle,
  isModuleCell,
  type CellArgs,
  type ResolvedCell,
} from "./cell.ts"
import { EmbedInteractiveBridge } from "./embed-interactive.tsx"
import { createTierRewriter } from "./tier-rewrite.ts"
import { ParentContext } from "./partial-context.ts"
import { deferCommitUntil, registerPartial, type PageSnapshotSource } from "./partial-registry.ts"
import { getPartialState } from "./partial-request-state.ts"
import { getServerContext } from "./server-context.ts"
import { TAG_SNAPSHOTS, deserializeSnapshot, type SerializedSnapshot } from "./snapshot-trailer.ts"
import { getRequest } from "../runtime/context.ts"
import { HEADER_RSC_RENDER } from "../runtime/request.tsx"
import { CAPABILITY_HEADER, encodeCapability, type Capability } from "../runtime/capability.ts"

export interface RemoteFrameProps {
  /** Page URL to embed. Absolute URL (cross-origin) or same-origin
   *  path; relative paths resolve against the current request's URL. */
  url: string
  /** Host-declared scope the embedded render can read. Flat record of
   *  JSON-serializable values; serialized as the
   *  `x-parton-capability` header and decoded into `getCapability()`
   *  scope on the embed-flagged page render. The embedded page sees
   *  ONLY what's declared here — the host's cookies don't cross (the
   *  fetch is `credentials: "omit"`, even same-origin). */
  capability?: Capability
  /** Human namespace for this embed's refetch labels — the typed
   *  bindings' install name (`magento` turns the embedded page's
   *  `stocks` label into `magento:stocks` in the host's registry, so
   *  host-side selectors are self-describing and collision-free
   *  across remotes). Also prefixes the minted placement namespace
   *  for debuggable registry ids. Identity does NOT depend on it —
   *  the placement namespace disambiguates on its own. */
  namespace?: string
  /** Trust grant for the embedded payload — a grant SET (a name is
   *  shorthand for the singleton set). Omitted = full trust: the
   *  payload splices as-is (today's behavior). Present = the tier
   *  rewriter enforces it at splice time: below the Client tier only
   *  the framework vocabulary survives (`grant="paint"` — no client
   *  modules load, non-vocabulary rows degrade per the violation
   *  policy), and the spliced content renders inside a host-defined
   *  `<parton-embed-box>` with `contain: strict`. `"interactive"`
   *  additionally admits the vocabulary's interactive members and
   *  mounts the host-bundle interaction bridge inside the box. The
   *  grant also crosses as a request header so the producer can
   *  render its embed-surface variant — a statement, never the
   *  enforcement. */
  grant?: EmbedGrant | readonly EmbedGrant[]
  /** Bound cells — the inward state contract (`remote-frame.md` §
   *  Bound cells). RESOLVED cells only, keyed by the names the
   *  remote's spec declares (`cells: { cart: { required: true } }`):
   *
   *      const cart = await cartCell.resolve()
   *      <RemoteFrame url=… cells={{ cart }} />
   *
   *  Resolving in the enclosing parton's BODY is load-bearing — the
   *  read IS the dependency: it records the partition-scoped `cell:`
   *  dep on that parton, so a host-side write re-renders it and this
   *  frame re-projects with fresh values. The projected VALUES cross
   *  in the embed request's body; the remote sees values, never
   *  handles, tokens, or storage. A refetch of the placement
   *  RE-RESOLVES each binding (stamped cell id + partition on the
   *  snapshot source) — projections are never replayed stale. */
  cells?: Record<string, ResolvedCell<unknown>>
}

/** A placement's bound-cell bindings, normalized: the wire-projection
 *  values plus the re-resolution stamps a refetch replays. */
interface ResolvedCellBindings {
  projection: Record<string, unknown>
  stamps: Record<string, { cellId: string; args?: CellArgs }>
}

/** Normalize the `cells` prop. Accepts RESOLVED cells only — a module
 *  handle or `.with()` binding resolved inside this frame could not
 *  record its dep on the ENCLOSING parton (dep recording is
 *  per-parton-body), which would silently break re-projection — the
 *  exact staleness class the tracking invariant exists to prevent, so
 *  it throws with the fix instead. */
function resolveCellBindings(
  cells: Record<string, ResolvedCell<unknown>> | undefined,
): ResolvedCellBindings | null {
  if (cells === undefined) return null
  const projection: Record<string, unknown> = {}
  const stamps: Record<string, { cellId: string; args?: CellArgs }> = {}
  for (const [name, binding] of Object.entries(cells)) {
    if (isBoundCell(binding) || isModuleCell(binding) || !isCellHandle(binding)) {
      throw new Error(
        `RemoteFrame: cells.${name} must be a RESOLVED cell — ` +
          `\`const ${name} = await cell.resolve(args)\` in the enclosing parton's body ` +
          `(the in-body read records the dependency that re-projects this embed), ` +
          `then \`cells={{ ${name} }}\`.`,
      )
    }
    projection[name] = binding.value
    stamps[name] = {
      cellId: binding.id,
      ...(binding.partition !== undefined ? { args: binding.partition } : {}),
    }
  }
  return { projection, stamps }
}

/** Re-resolve a stored placement's cell stamps against CURRENT
 *  storage — the refetch half of the bound-cell contract. A stamp
 *  without explicit args re-derives the partition from the cell's own
 *  `partition` callback against the refetch's request scope (the same
 *  derivation the original in-body resolve used). A cell id the
 *  process no longer knows (HMR unload) is omitted — the producer's
 *  requirement check surfaces it explicitly if it was required. */
async function projectionFromStamps(
  stamps: Readonly<Record<string, { cellId: string; args?: CellArgs }>>,
): Promise<ResolvedCellBindings> {
  const projection: Record<string, unknown> = {}
  const out: Record<string, { cellId: string; args?: CellArgs }> = {}
  for (const [name, stamp] of Object.entries(stamps)) {
    const handle = getCellById(stamp.cellId)
    if (handle === undefined) continue
    const resolved = await handle.resolve(stamp.args)
    projection[name] = resolved.value
    out[name] = stamp
  }
  return { projection, stamps: out }
}

function defaultModuleRewrite(srcOrigin: string): (path: string) => string {
  return (path) => {
    // Already-absolute URLs and bare package specifiers: leave alone.
    if (path.startsWith("http://") || path.startsWith("https://")) return path

    // Dev-mode filesystem-absolute paths (`/@fs/Users/...`). Both
    // host and remote run on the same machine in development, so
    // either process can serve the same path. Adding the remote
    // origin would actually break the host's vite-rsc plugin —
    // it rejects cross-origin URLs as invalid client references.
    // For shared framework modules (PartialErrorBoundary etc.)
    // the host can resolve `/@fs/...framework/...` against its own
    // bundle. Leaving these alone makes dev "just work".
    if (path.startsWith("/@fs/") || path.startsWith("/@id/")) return path

    if (path.startsWith("./") || path.startsWith("../") || path.startsWith("/")) {
      try {
        return new URL(path, srcOrigin).href
      } catch {
        return path
      }
    }
    return path
  }
}

function isAbsoluteUrl(url: string): boolean {
  return url.startsWith("http://") || url.startsWith("https://")
}

export async function RemoteFrame({
  url,
  capability,
  namespace,
  grant,
  cells,
}: RemoteFrameProps): Promise<ReactNode> {
  // Resolve `url` to an absolute form. `fetch` in the server runtime
  // doesn't accept bare-path inputs — and the origin decides whether
  // module-ref rewriting applies.
  const hostRequest = getRequest()
  const absoluteUrl = isAbsoluteUrl(url) ? url : new URL(url, hostRequest.url).href
  const target = new URL(absoluteUrl)

  // Placement identity. The occurrence counter separates same-URL
  // siblings under one parent parton; it lives on the per-request
  // partial state, so a whole-page render assigns occurrences in tree
  // order — deterministic across renders of the same page. The URL
  // key is origin + pathname (no search), so a frame-driven embed
  // (`?step=…`) keeps one identity while its content moves.
  const hostParentPath = getServerContext(ParentContext).path
  const urlKey = `${target.origin}${target.pathname}`
  const state = getPartialState()
  let occurrence = 0
  if (state) {
    const seq = (state.embedSeq ??= new Map<string, number>())
    const key = `${hostParentPath.join("/")}|${urlKey}`
    occurrence = seq.get(key) ?? 0
    seq.set(key, occurrence + 1)
  }
  const ns = embedNamespaceFor({
    namespace,
    hostNs: embedNamespaceOf(hostRequest.headers),
    hostParentPath,
    urlKey,
    occurrence,
  })

  return embedPage({
    url: absoluteUrl,
    ns,
    namespace,
    capability,
    cells: resolveCellBindings(cells),
    grants: normalizeEmbedGrants(grant),
    depth: embedDepthOf(hostRequest.headers) + 1,
  })
}

/**
 * Focused re-embed for a page-sourced snapshot — the refetch half of
 * the page-embed contract. `partialFromSnapshot` (partial.tsx) calls
 * this when a selector-targeted refetch resolves to a snapshot whose
 * `source.kind === "page"`: the ordinary protocol, `?partials=<id>`
 * at the embedded URL, with the ORIGINAL placement namespace and
 * capability replayed off the stamp (never re-derived — the refetch
 * runs outside the placement's tree position).
 */
export function _pageEmbedRefetch(id: string, source: PageSnapshotSource): ReactNode {
  return <EmbedRefetch id={id} source={source} />
}

async function EmbedRefetch({
  id,
  source,
}: {
  id: string
  source: PageSnapshotSource
}): Promise<ReactNode> {
  return embedPage({
    url: source.url,
    ns: source.ns,
    namespace: source.namespace,
    capability: source.capability as Capability | undefined,
    // Bound cells RE-RESOLVE at refetch time — the stamps name the
    // cells, current storage supplies the values. Replaying the
    // original projected values would freeze the embed at placement-
    // time host state.
    cells: source.cells ? await projectionFromStamps(source.cells) : null,
    grants: source.grant ? new Set(source.grant) : null,
    depth: embedDepthOf(getRequest().headers) + 1,
    partials: id,
  })
}

async function embedPage(args: {
  url: string
  ns: string
  namespace?: string
  capability?: Capability
  /** Normalized bound-cell bindings (`null` = none bound). */
  cells: ResolvedCellBindings | null
  /** Canonical grant set (`null` = ungoverned, full trust). */
  grants: ReadonlySet<string> | null
  depth: number
  /** Focused refetch target — appended as `?partials=<id>` so the
   *  producer renders just that parton from its own registry. */
  partials?: string
}): Promise<ReactNode> {
  // Recursion guard — see the module doc. A marker, never a throw.
  if (args.depth > MAX_EMBED_DEPTH) {
    return <div hidden {...{ [EMBED_LIMIT_ATTR]: args.url }} />
  }
  const hostRequest = getRequest()
  const fetchUrl = new URL(args.url)
  if (args.partials !== undefined) fetchUrl.searchParams.set("partials", args.partials)

  const requestHeaders: Record<string, string> = {
    [HEADER_RSC_RENDER]: "1",
    [EMBED_DEPTH_HEADER]: String(args.depth),
    [EMBED_NS_HEADER]: args.ns,
  }
  if (args.capability !== undefined) {
    requestHeaders[CAPABILITY_HEADER] = encodeCapability(args.capability)
  }
  if (args.grants !== null) {
    requestHeaders[EMBED_GRANT_HEADER] = encodeEmbedGrants(args.grants)
  }
  // Requests spawned on behalf of a scoped request inherit its scope:
  // the test harness partitions process-wide server state per
  // `x-test-scope` (see `runtime/context.ts` — `deriveScope`), and an
  // embedded render is part of the host request's work. Without the
  // forward, every embed lands in the shared default bucket — parallel
  // workers then contend on each other's producer-side registries.
  const hostScopeHeader = hostRequest.headers.get("x-test-scope")
  if (hostScopeHeader) requestHeaders["x-test-scope"] = hostScopeHeader

  // Bound-cell projection rides the request BODY (values may be
  // large; header lines have hard ceilings), which makes the fetch a
  // POST — the cells header, not the method, is the producer's
  // dispatch signal (`parseRenderRequest` keys on the render header
  // either way).
  let body: string | undefined
  if (args.cells !== null) {
    requestHeaders[EMBED_CELLS_HEADER] = "1"
    requestHeaders["content-type"] = "application/json;charset=utf-8"
    body = JSON.stringify({ cells: args.cells.projection })
  }

  const response = await fetch(fetchUrl.href, {
    method: body === undefined ? "GET" : "POST",
    headers: requestHeaders,
    credentials: "omit",
    ...(body !== undefined ? { body } : {}),
  })
  if (!response.ok || !response.body) {
    throw new Error(
      `RemoteFrame: page fetch failed for ${fetchUrl.href} (status ${response.status})`,
    )
  }

  // First segment only: an embed GET renders one segment and closes.
  // The splitter strips every `\xFF` trailer entry out of the body
  // stream (Flight decoders never see them) and resolves them as a
  // tag → bytes map.
  const iter = splitSegments(response.body)[Symbol.asyncIterator]()
  const first = await iter.next()
  if (first.done || first.value.kind !== "payload") {
    throw new Error(`RemoteFrame: empty page response for ${fetchUrl.href}`)
  }
  const segment = first.value

  // Register the snapshots the embedded page shipped, then release the
  // connection (an embedded page holding a live connection would
  // otherwise park it open). Runs in this frame's ALS scope — the
  // HOST's request registry — and rides the commit-defer contract:
  // the host's stream wrappers await this before commit, so the
  // route-hint write for every embedded parton lands before the
  // response goes out and selector refetch never hits a registry miss.
  const registration = segment.trailers.then((trailers) => {
    const bytes = trailers.get(TAG_SNAPSHOTS)
    if (bytes) {
      try {
        const raw = JSON.parse(new TextDecoder().decode(bytes)) as Record<
          string,
          SerializedSnapshot
        >
        const source: PageSnapshotSource = {
          kind: "page",
          url: args.url,
          ns: args.ns,
          ...(args.namespace !== undefined ? { namespace: args.namespace } : {}),
          ...(args.capability !== undefined
            ? { capability: args.capability as Record<string, unknown> }
            : {}),
          // Replayed on refetch so a granted placement can never be
          // re-fetched wider than it was placed.
          ...(args.grants !== null ? { grant: [...args.grants] } : {}),
          // Cell STAMPS (id + partition), never values — a refetch
          // re-resolves against current storage.
          ...(args.cells !== null ? { cells: args.cells.stamps } : {}),
        }
        for (const [id, ser] of Object.entries(raw)) {
          const snap = deserializeSnapshot(ser)
          registerPartial(id, {
            ...snap,
            labels: args.namespace ? snap.labels.map((l) => `${args.namespace}:${l}`) : snap.labels,
            source,
          })
        }
      } catch {
        // Malformed trailer — skip registration, keep the render.
      }
    }
    void iter.return?.()
  })
  registration.catch(() => {})
  deferCommitUntil(registration)

  // Rewriter pipeline — grant first, then origin. A vocabulary-
  // constrained grant (no `client` member — v1: Paint) composes the
  // tier rewriter onto the slice: no module-ref rewriting at ALL,
  // same- or cross-origin — below the Client tier zero remote modules
  // load, and the tier rewriter drops every `I` row outright.
  // Ungoverned embeds keep the origin rule: the host's bundle owns
  // same-origin modules; a cross-origin payload's relative module
  // paths are rewritten to absolute URLs at the remote origin so the
  // host browser can dynamically import them.
  const sameOrigin = (() => {
    try {
      return new URL(hostRequest.url).origin === fetchUrl.origin
    } catch {
      return false
    }
  })()
  const vocabularyConstrained = grantsVocabularyConstrained(args.grants)
  const pipeline: RowRewriter = vocabularyConstrained
    ? composeRewriters(
        pageEmbedRewriter,
        createTierRewriter({ grants: args.grants!, url: args.url }),
      )
    : sameOrigin
      ? pageEmbedRewriter
      : composeRewriters(
          pageEmbedRewriter,
          moduleRefRewriter(defaultModuleRewrite(fetchUrl.origin)),
        )

  // A page payload's root row is the entry contract `{ root, … }`
  // (the same shape every app entry renders for the browser client);
  // the embedded tree hangs off `root`.
  const payload = await createFromReadableStream<{ root: ReactNode }>(
    rewriteFlightStream(segment.body, pipeline),
  )
  if (args.grants !== null) {
    // Under the Interactive grant the spliced (inert) payload mounts
    // inside the HOST-bundle interaction bridge: a client component of
    // the host's own module graph (RemoteFrame's JSX is encoded by the
    // HOST encoder — no remote module crosses) that wires the
    // vocabulary's interactive tags to the REMOTE's cells and actions
    // by DOM delegation. See `lib/embed-interactive.tsx`.
    const inner = args.grants.has("interactive") ? (
      <EmbedInteractiveBridge
        origin={fetchUrl.origin}
        capability={args.capability !== undefined ? encodeCapability(args.capability) : null}
      >
        {payload.root}
      </EmbedInteractiveBridge>
    ) : (
      payload.root
    )
    // The host-defined box a granted embed renders inside. The
    // framework stamps the containment (blast-radius ceiling —
    // `contain: strict` = size/layout/paint; the Layout grant is what
    // will drop `size`); the HOST owns the box's dimensions via CSS on
    // the tag — size containment means the content never sizes it.
    return createElement(
      EMBED_BOX_TAG,
      {
        "data-grant": encodeEmbedGrants(args.grants),
        style: { display: "block", contain: "strict" },
      },
      inner,
    )
  }
  return payload.root
}

/**
 * Typed binding factory for an embeddable page.
 *
 * The CLI's `parton add` command generates files that call this with
 * the remote origin + page path baked in, producing a typed component
 * the host imports and renders directly:
 *
 *     // generated bindings (src/remote/magento/index.ts)
 *     export const MagentoPaymentSummary = remote<PaymentCap>({
 *       origin: "http://localhost:5181",
 *       path: "/remote/magento-payment-summary",
 *       namespace: "magento",
 *     })
 *
 *     // host call site
 *     <MagentoPaymentSummary
 *       capability={{ cart_id: "...", currency: "EUR", total: 127.45 }}
 *     />
 *
 * The capability shape is enforced at compile time — the host cannot
 * pass a value that doesn't match what the remote page declared. The
 * `namespace` is the CLI's install name; it prefixes the embedded
 * page's refetch labels in the host registry (`magento:stocks`), so
 * host-side selectors stay collision-free across remotes.
 */
export function remote<Cap = void>(opts: {
  origin: string
  path: string
  namespace?: string
  /** Trust grant baked into the binding — see `RemoteFrameProps.grant`.
   *  A binding is origin + page path + grant set (+ capability type);
   *  the grant is a property of the INSTALL, not of each call site. */
  grant?: EmbedGrant | readonly EmbedGrant[]
}): (
  props: {
    /** Optional URL search params appended to the embedded page URL.
     *  Useful when the page varies on its own `?step=…` etc. and the
     *  host drives that variant from a wrapper parton's tracked
     *  reads. */
    searchParams?: Record<string, string>
    /** Bound cells — RESOLVED in the enclosing parton's body; see
     *  `RemoteFrameProps.cells`. */
    cells?: Record<string, ResolvedCell<unknown>>
  } & (Cap extends void ? { capability?: never } : { capability: Cap }),
) => Promise<ReactNode> {
  return async function RemoteBinding(props) {
    const url = new URL(opts.path, opts.origin)
    if (props.searchParams) {
      for (const [k, v] of Object.entries(props.searchParams)) url.searchParams.set(k, v)
    }
    return await RemoteFrame({
      url: url.href,
      capability: (props as { capability?: Capability }).capability,
      namespace: opts.namespace,
      grant: opts.grant,
      cells: props.cells,
    })
  }
}
