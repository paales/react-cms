/**
 * Targeted-refetch orchestration for the client.
 *
 * `enqueueRefetch` is the single dispatch point every selector-scoped
 * refetch goes through — microtask-batched so multiple fires in one
 * tick coalesce into one channel statement. A batch states the page
 * URL with the labels as its one-shot `?__force=` overlay (intent
 * "silent"); the response arrives on the held stream as a whole-tree
 * payload segment with the targets laned explicit after the reopen.
 * Pre-establishment batches latch and ride the attach they trigger
 * (`_channelNavigate`'s attach-with-intent). A DEGRADED page has no
 * freshness transport: fires resolve as no-ops — the page is
 * browser-native, and document loads are its renders.
 *
 * Also home to the framework-internal "silent navigation" info brand
 * (the signal a `nav.navigate()` initiator sends so the page-level
 * intercept stands down) and the client-side selector parser.
 */

import { _channelNavigate } from "./channel-client.ts"

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
// coalesce into one channel statement. Keeps tag-fanout and multi-id
// event handlers cheap: three buttons clicked in the same frame
// produce one statement with `?__force=a,b,c`. Each batched entry
// carries its own `streaming` / `finished` deferreds so the batched
// statement can fan out its two milestones (covering segment
// committed, covering segment settled) back to every caller
// separately.

/** Two-milestone return mirroring the navigation handles. */
export interface RefetchMilestones {
  streaming: Promise<void>
  finished: Promise<void>
}

interface RefetchBatchEntry {
  /** Selector labels — become the statement's `?__force=` overlay. The
   *  server resolves them against the route's snapshots (id first,
   *  then label fan-out) and lanes each target EXPLICIT. */
  labels: string[]
  /** Render mode for the commit — `false` (default) wraps in
   *  `startTransition`; `true` opts into progressive streaming with
   *  Suspense fallbacks. Mirrors the `streaming` option on
   *  `FrameworkNavigateOptions` / `FrameworkReloadOptions`. */
  streaming: boolean
  /** Abort signal for this entry — per-selector supersede sets this to
   *  a fresh `AbortController`'s signal; a superseded fire's record
   *  rejects with AbortError. */
  signal?: AbortSignal
  /** Resolver for this entry's `streaming` milestone — the covering
   *  segment's commit. */
  resolveStreaming: () => void
  rejectStreaming: (err: unknown) => void
  /** Resolver for this entry's `finished` milestone — the covering
   *  segment's settle. */
  resolveFinished: () => void
  rejectFinished: (err: unknown) => void
}

let _batchRef: RefetchBatchEntry[] = []
let _batchScheduled = false

// Labels of refetch statements whose covering segment has not settled.
// The transport keeps ONE pending url frame (newest statement wins
// pre-flush), so a batch flushed while an earlier batch is still
// uncovered must RESTATE the earlier targets — its `?__force=` is the
// union — or a same-frame pair of distinct-selector fires would drop
// the first fire's targets. Restating a force that was already served
// costs one extra explicit lane render; dropping one loses the refetch.
const _uncoveredForces = new Map<object, readonly string[]>()

function flushRefetchBatch(batch: RefetchBatchEntry[]): void {
  const labelSet = new Set<string>()
  let streamingMode = false
  for (const entry of batch) {
    for (const l of entry.labels) labelSet.add(l)
    if (entry.streaming) streamingMode = true
  }

  // Combine per-entry signals so the batched statement aborts when any
  // caller superseded. Batched callers share fate by construction —
  // they're one statement. (In practice batched entries usually come
  // from the same event handler; cross-supersede happens only across
  // microtasks so each fire is in its own batch.)
  const signals = batch
    .map((e) => e.signal)
    .filter((s): s is AbortSignal => s != null)
  const signal =
    signals.length === 0
      ? undefined
      : signals.length === 1
        ? signals[0]
        : AbortSignal.any(signals)

  // The batch as a url statement: the page URL with the labels as its
  // `?__force=` overlay, intent "silent". `__force`, not a target
  // list: the statement's segment is WHOLE-TREE (the URL may have
  // moved with the batch — a `navigate({selector})` — and every parton
  // must re-evaluate it; fp-skip prunes the unchanged to placeholders),
  // with the named targets forced past fp-skip server-side. The
  // connection's mirror is the manifest — nothing re-advertises.
  // Pre-establishment the statement latches and rides the attach it
  // triggers; only a DEGRADED page answers null.
  const stated = new URL(window.location.href)
  const restated = new Set(labelSet)
  for (const labels of _uncoveredForces.values()) {
    for (const l of labels) restated.add(l)
  }
  if (restated.size > 0) {
    stated.searchParams.set("__force", [...restated].join(","))
  }
  const routed = _channelNavigate({
    url: stated.pathname + stated.search,
    intent: "silent",
    streaming: streamingMode,
    signal,
  })
  if (!routed) {
    // Degraded: no freshness transport exists. Resolve as no-ops — the
    // page's renders are document loads now.
    for (const e of batch) {
      e.resolveStreaming()
      e.resolveFinished()
    }
    return
  }
  if (labelSet.size > 0) {
    const token = {}
    _uncoveredForces.set(token, [...labelSet])
    // The covering segment's settle retires the restatement duty —
    // rejections (abort, teardown) retire it too.
    routed.finished.then(
      () => _uncoveredForces.delete(token),
      () => _uncoveredForces.delete(token),
    )
  }
  routed.streaming.then(
    () => {
      for (const e of batch) e.resolveStreaming()
    },
    (err) => {
      for (const e of batch) e.rejectStreaming(err)
    },
  )
  routed.finished.then(
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
 * coalesce into one statement. Returns synchronously with
 * `{streaming, finished}` promises — the caller can attach handlers
 * on either milestone independently. On supersede, the shared
 * `AbortSignal` propagates an `AbortError` to both milestones.
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
