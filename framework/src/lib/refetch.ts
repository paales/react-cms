/**
 * Targeted-refetch orchestration for the client.
 *
 * `enqueueRefetch` is the single dispatch point every selector-scoped
 * refetch goes through — microtask-batched so multiple fires in one
 * tick coalesce into one HTTP request, stamped with a monotonic issue
 * seq (see `refetch-ordering.ts`) so late-arriving superseded
 * responses can't clobber newer trees.
 *
 * Also home to the framework-internal "silent navigation" info brand
 * (the signal a `nav.navigate()` initiator sends so the page-level
 * intercept stands down) and the client-side selector parser.
 */

import type { AttachStatement } from "./channel-protocol.ts"
import {
  getAllCachedPartialTokens,
  getCachedPartialIds,
  inFlightKey,
} from "./partial-client-state.ts"
import { claimRefetchCommit, nextRefetchSeq } from "./refetch-ordering.ts"

// ─── Framework-internal navigation info ───────────────────────────
//
// The Navigation API's `info` option is a one-shot payload delivered
// on the resulting `navigate` event. Unlike `state` it is not
// persisted on the history entry, so it's a natural channel for
// signalling intent from initiator to listener.
//
// Two framework-internal paths still go through `nav.navigate()` and
// need the page-level intercept to stand down:
//   - window-scoped silent nav (URL-only update, or caller dispatches
//     its own targeted refetch via `enqueueRefetch`)
//   - frame nav with explicit `history: "push" | "replace"` (caller
//     dispatches `_dispatchFrameRefetch` itself)
//
// Frame navs with the default `history: "auto"` do NOT stamp silent
// info — they patch state via `updateCurrentEntry`, which fires
// `currententrychange` but not `navigate`, so there's nothing for the
// listener to intercept.
//
// Any non-framework-branded `info` (user-provided via
// `navigate(url, { info })`) passes straight through as a normal
// page-level navigation.

interface FrameworkSilentInfo {
  __framework: "silent-navigate"
  mode: "window" | "frame"
  name?: string
}

export function makeSilentInfo(mode: "window" | "frame", name?: string): FrameworkSilentInfo {
  return { __framework: "silent-navigate", mode, name }
}

export function isFrameworkSilentInfo(info: unknown): info is FrameworkSilentInfo {
  return (
    info != null &&
    typeof info === "object" &&
    (info as { __framework?: unknown }).__framework === "silent-navigate"
  )
}

// ─── Selector parsing (client-side, mirrors partial.tsx) ─────────────
//
// Selectors at the use site (`reload({selector})` / `navigate(url,
// {selector})`) are flat lists of labels. The framework strips
// leading `#` / `.` characters as cosmetic — both `"#hero"` and
// `"hero"` resolve to the same label.

export function parseSelectorClient(input: string | string[] | undefined): {
  labels: string[]
} {
  if (input == null) return { labels: [] }
  const tokens = Array.isArray(input)
    ? input.map((t) => (typeof t === "string" ? t.trim() : "")).filter(Boolean)
    : input
        .split(/\s+/)
        .map((t) => t.trim())
        .filter(Boolean)
  const labels: string[] = []
  for (const tok of tokens) {
    const name = tok.startsWith("#") || tok.startsWith(".") ? tok.slice(1) : tok
    if (name && !labels.includes(name)) labels.push(name)
  }
  return { labels }
}

// ─── Microtask-batched targeted-refetch dispatcher ────────────────
//
// Multiple `reload` / `navigate({ selector })` calls in the same tick
// coalesce into one refetch request. Keeps tag-fanout and multi-id
// event handlers cheap: three buttons clicked in the same frame
// produce one request with `?partials=a,b,c`. Each batched entry
// carries its own `streaming` / `finished` deferreds so the batched
// request can fan out its two milestones (first-segment received,
// full body drained) back to every caller separately.

/** Two-milestone return mirroring the host's `fetchRscPayload`. */
export interface RefetchMilestones {
  streaming: Promise<void>
  finished: Promise<void>
}

interface RefetchBatchEntry {
  /** Selector labels — become `?partials=…` on the wire. The server
   *  walks snapshots looking for matching labels (or matching ids)
   *  and re-renders each match. */
  labels: string[]
  /** Render mode for the commit — `false` (default) wraps in
   *  `startTransition`; `true` opts into progressive streaming with
   *  Suspense fallbacks. Mirrors the `streaming` option on
   *  `FrameworkNavigateOptions` / `FrameworkReloadOptions`. */
  streaming: boolean
  /** Open as a live subscription — adds `?live=1` so the server's
   *  segment driver holds the connection open and pushes future
   *  segments. Only the heartbeat sets this; targeted refetches are
   *  one-shot. Mirrors `FrameworkReloadOptions.live`. */
  live: boolean
  /** Abort signal for the in-flight HTTP fetch on this entry. Per-
   *  selector supersede sets this to a fresh `AbortController`'s signal
   *  and aborts predecessors when the newer fire's `streaming`
   *  resolves. Passed straight through to `__rsc_partial_refetch`. */
  signal?: AbortSignal
  /** Extra query params appended to the refetch url (not the page url).
   *  Mirrors `FrameworkReloadOptions.params` — ephemeral per-request
   *  view state read via tracked `searchParam()` reads. */
  params?: Record<string, string>
  /** This fire is a culling flip (only the visibility controller sets
   *  it — see `visibility.tsx`). Its targets are REVALIDATIONS, not
   *  forces: their cached fp tokens stay in `?cached=` (a normal
   *  explicit target's are stripped) and the request carries
   *  `?__cullFlip=1`, so the server may fp-skip an explicit target —
   *  the placeholder that confirms the client's parked copy. */
  cullFlip?: boolean
  /** The live fire's attach halves (anchor + seed) — the transport
   *  fills the manifest and ships the batch as an attach POST whose
   *  body is the full client statement. Only the heartbeat sets it.
   *  Mirrors `FrameworkReloadOptions.attach`. */
  attach?: Omit<AttachStatement, "cached">
  /** Resolver for this entry's `streaming` milestone — called when the
   *  flushed batch's first segment lands. */
  resolveStreaming: () => void
  rejectStreaming: (err: unknown) => void
  /** Resolver for this entry's `finished` milestone — called when the
   *  flushed batch's full response drains. */
  resolveFinished: () => void
  rejectFinished: (err: unknown) => void
}

let _batchRef: RefetchBatchEntry[] = []
let _batchScheduled = false

function flushRefetchBatch(batch: RefetchBatchEntry[]): void {
  const handler = (
    window as Window & {
      __rsc_partial_refetch?: (
        url: string,
        signal?: AbortSignal,
        claimCommit?: () => boolean,
        attach?: AttachStatement,
      ) => RefetchMilestones
    }
  ).__rsc_partial_refetch
  if (!handler) {
    // Host bundle hasn't wired the handler yet (SSR / pre-hydration).
    // Resolve every entry as a no-op so callers don't hang.
    for (const e of batch) {
      e.resolveStreaming()
      e.resolveFinished()
    }
    return
  }

  const labelSet = new Set<string>()
  // Labels wanted by a NON-cull-flip entry — the force-refetch
  // targets whose cached tokens must be stripped below. A label
  // wanted only by cull-flip entries keeps its tokens (fp-skip is
  // the point of a culling revalidation).
  const forcedLabels = new Set<string>()
  let streamingMode = false
  let liveMode = false
  let cullFlip = false
  let attach: Omit<AttachStatement, "cached"> | undefined
  const extraParams = new Map<string, string>()
  for (const entry of batch) {
    for (const l of entry.labels) {
      labelSet.add(l)
      if (!entry.cullFlip) forcedLabels.add(l)
    }
    if (entry.streaming) streamingMode = true
    if (entry.live) liveMode = true
    if (entry.cullFlip) cullFlip = true
    // At most one attach per batch by construction: the heartbeat is
    // the sole producer and its fires are strictly sequential.
    if (entry.attach) attach = entry.attach
    if (entry.params) for (const [k, v] of Object.entries(entry.params)) extraParams.set(k, v)
  }

  // Combine per-entry signals so the batched fetch aborts when any
  // caller superseded. Batched callers share fate by construction —
  // they're one HTTP request. (In practice batched entries usually
  // come from the same event handler; cross-supersede happens only
  // across microtasks so each fire is in its own batch.)
  const signals = batch
    .map((e) => e.signal)
    .filter((s): s is AbortSignal => s != null)
  const signal =
    signals.length === 0
      ? undefined
      : signals.length === 1
        ? signals[0]
        : AbortSignal.any(signals)

  const url = new URL(window.location.href)
  if (labelSet.size > 0) url.searchParams.set("partials", [...labelSet].join(","))
  if (streamingMode) url.searchParams.set("streaming", "1")
  // `?live=1` is the server hold-open signal — distinct from
  // `?streaming=1` (client commit mode). Only the heartbeat sets it;
  // targeted refetches stay one-shot and the connection closes.
  if (liveMode) url.searchParams.set("live", "1")
  // The culling-flip stamp — the explicit producer-written signal
  // that lets the server fp-skip this fire's targets (see
  // `PartialRequestState.cullFlip`). Transport-only; match gates
  // never see it.
  if (cullFlip) url.searchParams.set("__cullFlip", "1")

  // Send cached fingerprints so the server can fp-skip unchanged
  // partials. With a selector, strip cached tokens whose id prefix
  // matches a FORCED label (those entries are explicit refetch
  // targets — server must re-render them, not match-and-skip);
  // cull-flip targets keep theirs, so the server can confirm a
  // parked copy with a placeholder instead of re-shipping bytes.
  // With no selector (streaming heartbeat, full-page refetch), send
  // every cached entry so the fp-skip cascade prunes the page to
  // deltas.
  //
  // Two manifest forms, split by transport: an ATTACH batch carries
  // the FULL manifest in the POST body (no request line to protect —
  // see `getAllCachedPartialTokens`), while a discrete GET keeps the
  // capped `?cached=` URL form. The forced-label strip applies to
  // both — an explicit target must re-render on either transport.
  const cachedIds = attach ? getAllCachedPartialTokens() : getCachedPartialIds()
  const targetPrefixes = [...forcedLabels].map((l) => `${l}:`)
  const cached =
    targetPrefixes.length > 0
      ? cachedIds.filter((t) => !targetPrefixes.some((p) => t.startsWith(p)))
      : cachedIds
  if (!attach && cached.length > 0) {
    url.searchParams.set("cached", cached.join(","))
  }

  // Caller-supplied per-request params (ephemeral view state) — appended
  // to the refetch url only; the page url is untouched.
  for (const [k, v] of extraParams) url.searchParams.set(k, v)

  // Monotonic commit ordering. Stamp this fire with the next issue seq
  // for its selector key, and hand the host a commit gate bound to it.
  // The host calls the gate before each segment commit and drops the
  // commit when a newer fire for the same selector has already landed —
  // so a superseded fire whose response arrives late can't clobber the
  // newer tree. Keyed on the sorted label set (matches `?partials=` and
  // `inFlightKey`); a label-less batch (no selector) gets no gate.
  const orderKey = inFlightKey([...labelSet])
  let claimCommit: (() => boolean) | undefined
  if (orderKey != null) {
    const seq = nextRefetchSeq(orderKey)
    claimCommit = () => claimRefetchCommit(orderKey, seq)
  }

  const milestones = handler(
    url.toString(),
    signal,
    claimCommit,
    attach
      ? {
          cached,
          since: attach.since,
          visible: attach.visible,
          applied: attach.applied,
        }
      : undefined,
  )
  milestones.streaming.then(
    () => {
      for (const e of batch) e.resolveStreaming()
    },
    (err) => {
      for (const e of batch) e.rejectStreaming(err)
    },
  )
  milestones.finished.then(
    () => {
      for (const e of batch) e.resolveFinished()
    },
    (err) => {
      for (const e of batch) e.rejectFinished(err)
    },
  )
}

/**
 * Enqueue a targeted refetch. Multiple calls in the same microtask
 * coalesce into one request. Returns synchronously with
 * `{streaming, finished}` promises — the caller can attach handlers
 * on either milestone independently. Both reject with whatever
 * `__rsc_partial_refetch` rejected with (typically a
 * `NavigationError` from `fetchRscPayload`); on supersede, the
 * shared `AbortSignal` propagates an `AbortError` to both milestones.
 */
export function enqueueRefetch(
  entry: Omit<
    RefetchBatchEntry,
    | "resolveStreaming"
    | "rejectStreaming"
    | "resolveFinished"
    | "rejectFinished"
  >,
): RefetchMilestones {
  let resolveStreaming!: () => void
  let rejectStreaming!: (err: unknown) => void
  let resolveFinished!: () => void
  let rejectFinished!: (err: unknown) => void
  const streaming = new Promise<void>((res, rej) => {
    resolveStreaming = res
    rejectStreaming = rej
  })
  const finished = new Promise<void>((res, rej) => {
    resolveFinished = res
    rejectFinished = rej
  })
  // Pre-attach no-op handlers so a rejection that lands before the
  // downstream consumer's `.then(_, handler)` registers doesn't
  // surface as unhandledrejection. The pre-attach does NOT consume
  // the rejection — subsequent handlers still see the error.
  streaming.catch(() => {})
  finished.catch(() => {})

  _batchRef.push({
    ...entry,
    resolveStreaming,
    rejectStreaming,
    resolveFinished,
    rejectFinished,
  })
  if (!_batchScheduled) {
    _batchScheduled = true
    queueMicrotask(() => {
      const batch = _batchRef
      _batchRef = []
      _batchScheduled = false
      flushRefetchBatch(batch)
    })
  }
  return { streaming, finished }
}
