/**
 * Frame naming + URL contexts, the frames-tree read/write model, and
 * `<FrameNameProvider>` — the EAGER half of the frame machinery.
 *
 * These render during hydration (a framed spec mounts its provider on
 * first paint) and read during render (`useNavigation()` resolves the
 * ambient frame, projects a framed `currentEntry.url`). They depend on
 * nothing heavy — react, the Navigation API shim, the frame-URL cache —
 * so they stay in the initial chunk. The navigation MACHINERY (the
 * imperative handles, the refetch dispatch — everything that touches the
 * channel transport / refetch) lives in the late-loaded `frame-client.tsx`.
 */

import {
  createContext,
  useContext,
  useEffect,
  useEffectEvent,
  useMemo,
  type ReactNode,
} from "react"
import {
  getNavigation,
  type FrameEntryState,
  type FrameNavigationHistoryEntry,
  type ImperativeNavigation,
  type NavigateTarget,
  type NavigationMilestones,
} from "../runtime/navigation-api.ts"
import { getFrameUrl, hasFrameUrl, setFrameUrl } from "./partial-client-state.ts"

// ─── The late-loaded navigation executor seam ─────────────────────
//
// The navigate/reload/preload/back EXECUTORS live in the late-loaded
// `frame-client.tsx` (they touch the channel transport). It binds its
// surface here on load. `useNavigation()`'s eager handles dispatch a
// fire SYNCHRONOUSLY through the bound executor when it is present — the
// normal case, since the live layer loads it once post-commit, before
// any user interaction. A synchronous dispatch is what keeps a fire's
// browser-navigation and milestone timing identical to a non-split
// build (a `nav.reload()` deferred a task lands outside its gesture and
// races the reload it triggered). Only a fire BEFORE the executor has
// bound (pre-live-boot — rare) takes the async-import fallback.

/** The `frame-client` surface `useNavigation()`'s eager handles call. */
export interface NavExecutor {
  buildWindowNavigationHandle(ssrUrl?: string | null): ImperativeNavigation
  buildFrameHandle(path: readonly string[], ssrUrl?: string | null): ImperativeNavigation
  executePreload(target: NavigateTarget, frameName: string | null): Promise<void>
  _frame(pathOrName: string | readonly string[]): ImperativeNavigation
}

let boundNavExecutor: NavExecutor | null = null

/** `frame-client` binds its executor surface here on load. */
export function _bindNavExecutor(exec: NavExecutor): void {
  boundNavExecutor = exec
}

/** The bound executor, or `null` before the live layer has loaded it. */
export function _navExecutor(): NavExecutor | null {
  return boundNavExecutor
}

// ─── Frame naming + URL contexts ──────────────────────────────────

/**
 * Client-side context carrying the AMBIENT frame path (outer-most to
 * inner-most). Populated by `<FrameNameProvider>` (rendered as part of
 * `<Partial frame="X">`) which stacks its own local name onto any
 * enclosing chain. Empty array at the page root. Lets
 * `useNavigation()` default to "the enclosing frame" without every
 * caller passing the path explicitly, and gives nested frames a
 * canonical identity (`["products","list"]` → `"products.list"`) for
 * session/state lookup.
 */
export const FrameNameContext = createContext<readonly string[]>(
  Object.freeze([]) as readonly string[],
)

/** Per-frame URL map (frame key → resolved URL), accumulated down the
 *  tree by `FrameNameProvider`. SSR / pre-hydration counterpart to the
 *  module-level frame-URL cache: a framed `useNavigation(name)` reads it
 *  so `currentEntry.url` is correct on the first server paint, before the
 *  browser Navigation API exists. The live handle supersedes it after
 *  hydration. */
export const FrameUrlContext = createContext<ReadonlyMap<string, string>>(new Map<string, string>())

/** Dotted canonical name for a frame path. */
export function joinFramePath(path: readonly string[]): string {
  return path.join(".")
}

/** Parse a dotted frame path into its component names. Empty → []. */
export function splitFramePath(dotted: string): readonly string[] {
  if (!dotted) return []
  return dotted.split(".").filter(Boolean)
}

// ─── Frames tree on the navigation entry ──────────────────────────

/**
 * Multi-frame URL snapshot carried on each navigation entry. Every
 * pushed entry stores the URL of every known frame so browser
 * back/forward can diff two entries and dispatch refetches for the
 * frames that changed. See `docs/frames-navigation.md`.
 */
const FRAMES_KEY = "__frames"

/**
 * Tree-shaped per-frame record on a navigation entry. Every
 * `<Partial frame="X">` (at any nesting depth) contributes one node,
 * keyed by its local name inside its parent's `__frames`.
 *
 *   state.__frames = {
 *     cart:     { url: "/cart/open", __frameHistory: {...} },
 *     products: { url: "/products", __frameHistory: {...},
 *                 __frames: {
 *                   list: { url: "/list?page=3", __frameHistory: {...} }
 *                 } }
 *   }
 *
 * `__frameHistory` and `__frameState` live at each node, scoped to
 * that node's navigation — a nested frame's history doesn't pollute
 * its parent's and vice versa.
 */
export interface FrameHistoryEntry {
  past: string[]
  future: string[]
}

export interface FrameNode {
  /** Current URL for this frame. Not always present — a node may
   *  exist only to carry `__frames` for descendants (e.g. a parent
   *  node whose children mutated first). Readers fall back to
   *  the module-level frame-URL cache. */
  url?: string
  __frameHistory?: FrameHistoryEntry
  __frameState?: Record<string, unknown>
  __frames?: Record<string, FrameNode>
}

export interface FramesTree {
  [localName: string]: FrameNode
}

/**
 * Read the per-frame URL tree from a navigation entry's state.
 * Exported for the browser bootstrap's traverse listener
 * (`../entry/live-boot.tsx`).
 */
export function _readFramesSnapshot(state: unknown): FramesTree {
  if (state == null || typeof state !== "object") return {}
  const v = (state as Record<string, unknown>)[FRAMES_KEY]
  if (v == null || typeof v !== "object") return {}
  return v as FramesTree
}

/** Walk the tree at `path`, returning the node or `undefined`. */
export function _readFrameNode(state: unknown, path: readonly string[]): FrameNode | undefined {
  let cursor: FrameNode | undefined = undefined
  let level: FramesTree = _readFramesSnapshot(state)
  for (const name of path) {
    cursor = level[name]
    if (cursor == null) return undefined
    level = cursor.__frames ?? {}
  }
  return cursor
}

/**
 * Flatten the tree into `{dottedPath: url}` pairs — used by browser
 * traverse diffing in `../entry/live-boot.tsx` to detect which frames
 * changed between two entries.
 */
export function _collectFramePaths(
  tree: FramesTree,
  prefix: readonly string[] = [],
): Record<string, { url: string }> {
  const out: Record<string, { url: string }> = {}
  for (const [name, node] of Object.entries(tree)) {
    const path = [...prefix, name]
    if (node.url != null) out[path.join(".")] = { url: node.url }
    if (node.__frames) {
      Object.assign(out, _collectFramePaths(node.__frames, path))
    }
  }
  return out
}

/**
 * Immutably patch a frame node at `path`. Returns a new state object
 * with parent chain cloned; creates missing intermediate nodes as
 * empty containers.
 */
export function writeFrameNode(
  priorState: unknown,
  path: readonly string[],
  patch: (node: FrameNode) => FrameNode,
): Record<string, unknown> {
  if (path.length === 0) {
    throw new Error("writeFrameNode: path must be non-empty")
  }
  const base = (priorState as Record<string, unknown> | null) ?? {}
  const rootTree: FramesTree = { ...(_readFramesSnapshot(priorState) ?? {}) }

  // Walk into the tree, cloning each node we pass through.
  let levelTree = rootTree
  for (let i = 0; i < path.length - 1; i++) {
    const name = path[i]
    const existing = levelTree[name] ?? {}
    const childrenCopy = { ...(existing.__frames ?? {}) }
    const cloned: FrameNode = { ...existing, __frames: childrenCopy }
    levelTree[name] = cloned
    levelTree = childrenCopy
  }
  const leafName = path[path.length - 1]
  levelTree[leafName] = patch(levelTree[leafName] ?? {})

  return { ...base, [FRAMES_KEY]: rootTree }
}

export function emptyHistoryEntry(): FrameHistoryEntry {
  return { past: [], future: [] }
}

// ─── Frames-tree write serialisation ──────────────────────────────

/**
 * Tail of the frames-tree write queue: the promise the NEXT
 * read-modify-write must wait on, or `null` when no write is holding
 * the tree. See `runFrameTreeWrite`.
 */
let _frameTreeWriteTail: Promise<void> | null = null

/**
 * Run a read-modify-write cycle on the frames tree, serialised against
 * every other cycle.
 *
 * All frames-tree mutations are clone-and-patch: read the current
 * entry's state, `writeFrameNode` a new snapshot, hand it to the
 * Navigation API. For `updateCurrentEntry` that cycle is synchronous —
 * atomic on its own — but an explicit `history: "push" | "replace"`
 * frame nav bakes its snapshot into `nav.navigate(...)`, whose entry
 * commits ASYNCHRONOUSLY. Any other frames-tree write that reads the
 * entry inside that window works from a snapshot missing the pending
 * navigation's node — and whichever write lands last silently drops
 * the other frame's update (two navs read the same state, clone
 * independently, last commit wins).
 *
 * The queue closes that window with mutual exclusion, not timing:
 * a `write` whose returned promise is still pending HOLDS the tree
 * (a push-mode nav returns its browser `committed`), and every later
 * cycle queues behind it, re-reading the then-current entry when its
 * turn comes. When no write is holding the tree, the cycle runs
 * synchronously — the common single-writer path keeps its
 * updateCurrentEntry-is-synchronous semantics.
 *
 * `write` returns the promise to hold the tree until (settled either
 * way), or `undefined` when its mutation applied synchronously. A
 * queued `write` that throws is contained so the queue keeps
 * draining; write closures are expected to report their own failures
 * through their navigation milestones.
 */
export function runFrameTreeWrite(write: () => Promise<unknown> | undefined): void {
  const settle = (hold: Promise<unknown> | undefined): Promise<void> | null => {
    if (hold == null) return null
    return hold.then(
      () => undefined,
      () => undefined,
    )
  }

  if (_frameTreeWriteTail == null) {
    const settled = settle(write())
    if (settled == null) return
    const release: Promise<void> = settled.then(() => {
      if (_frameTreeWriteTail === release) _frameTreeWriteTail = null
    })
    _frameTreeWriteTail = release
    return
  }

  const release: Promise<void> = _frameTreeWriteTail
    .then(() => {
      try {
        return settle(write()) ?? undefined
      } catch {
        return undefined
      }
    })
    .then(() => {
      if (_frameTreeWriteTail === release) _frameTreeWriteTail = null
    })
  _frameTreeWriteTail = release
}

// ─── FrameNameProvider ────────────────────────────────────────────

/**
 * Wraps descendants so `useNavigation()` calls inside them bind to this
 * frame by default. Also seeds the current navigation entry's state
 * with this frame's initial URL + an empty history stack on first
 * mount, so `frame.canGoBack` / `canGoForward` read a well-formed
 * shape even before the first frame nav.
 */
export function FrameNameProvider({
  path,
  initialUrl,
  children,
}: {
  path: readonly string[]
  initialUrl: string
  children: ReactNode
}) {
  const key = joinFramePath(path)
  const parentFrameUrls = useContext(FrameUrlContext)
  // Thread this frame's server-resolved URL down via context so SSR can
  // resolve a framed `currentEntry.url` — the `useEffect` below seeds
  // the client-only frame-URL cache, which never runs during SSR. Nested
  // frames accumulate into one map.
  const frameUrls = useMemo(() => {
    const next = new Map(parentFrameUrls)
    next.set(key, initialUrl)
    return next
  }, [parentFrameUrls, key, initialUrl])
  // Seed the nav entry's frame node for this `path`. Wrapped in useEffectEvent
  // so the effect keys off `key` (the stable join of `path`) without reacting
  // to `path`'s per-render array identity — it reads the current path each
  // time `key` changes.
  const seedFrameNode = useEffectEvent(() => {
    const nav = getNavigation()
    if (!nav) return
    runFrameTreeWrite(() => {
      const current = nav.currentEntry?.getState() ?? null
      const existing = _readFrameNode(current, path)
      const hasUrl = existing?.url != null
      const hasHistory = existing?.__frameHistory != null
      if (!hasUrl || !hasHistory) {
        nav.updateCurrentEntry({
          state: writeFrameNode(current, path, (node) => ({
            ...node,
            url: node.url ?? initialUrl,
            __frameHistory: node.__frameHistory ?? emptyHistoryEntry(),
          })),
        })
      }
      return undefined
    })
  })
  useEffect(() => {
    // Client cache: so `useNavigation(path).currentEntry.url` is non-null on
    // cold load.
    if (!hasFrameUrl(key)) {
      setFrameUrl(key, initialUrl)
    }
    seedFrameNode()
  }, [key, initialUrl])
  return (
    <FrameUrlContext value={frameUrls}>
      <FrameNameContext value={path}>{children}</FrameNameContext>
    </FrameUrlContext>
  )
}

// ─── Eager handle building blocks ─────────────────────────────────
//
// The render-time surface of the navigation handles: the SSR stub, the
// frame-entry projection (read during render for `currentEntry.url` /
// `canGoBack`), and the milestone-deferred shells a fire returns
// synchronously. These touch nothing heavy — react, the Navigation API
// shim, the eager frames-tree readers — so `useNavigation()` builds its
// handle here without pulling the channel transport into the initial
// chunk. The navigate/reload EXECUTORS (which touch the channel) live in
// the late-loaded `frame-client.tsx`; the eager handle dispatches into
// them on invocation.

/**
 * Project a window `NavigationHistoryEntry` into a frame-scoped
 * `FrameNavigationHistoryEntry`: `url` reports the frame's URL
 * (absolute, against the page origin); `getState()` returns the node
 * at `path`'s `__frameState` bucket, not the whole window state.
 */
export function projectEntryForFrame(
  entry: NavigationHistoryEntry | null,
  path: readonly string[],
): FrameNavigationHistoryEntry | null {
  if (!entry) return null
  const key = joinFramePath(path)
  const node = _readFrameNode(entry.getState(), path)
  const frameUrl = node?.url ?? getFrameUrl(key) ?? "/"
  const origin = typeof window !== "undefined" ? window.location.origin : "http://_"
  const absoluteUrl = new URL(frameUrl, origin).href
  return new Proxy(entry, {
    get(_target, prop, _receiver) {
      if (prop === "url") return absoluteUrl
      if (prop === "getState") {
        return function getState(): FrameEntryState | null {
          const bucket = _readFrameNode(entry.getState(), path)?.__frameState
          if (bucket == null || typeof bucket !== "object") return null
          return bucket as FrameEntryState
        }
      }
      // Native NavigationHistoryEntry getters (url, key, id, index,
      // sameDocument) throw "Illegal invocation" when invoked with a
      // non-NavigationHistoryEntry `this` — so we must bypass the
      // Proxy receiver and read directly off the underlying entry.
      const value = (entry as unknown as Record<string | symbol, unknown>)[prop]
      return typeof value === "function" ? value.bind(entry) : value
    },
  }) as FrameNavigationHistoryEntry
}

// ─── SSR / no-Navigation stub ─────────────────────────────────────
//
// `useNavigation()` is a hook that must run in React's render phase,
// but RSC renders happen server-side where `globalThis.navigation` is
// undefined. Return a stub that type-checks with no-op behavior — any
// actual invocation only happens on the client after hydration.

export function nullImperativeNavigation(
  name: string | null,
  url?: string | null,
): ImperativeNavigation {
  const stubEntry = null as unknown as NavigationHistoryEntry
  // On the server (and pre-hydration) there is no browser Navigation
  // API, but a Flight-borne URL still lets `currentEntry.url` resolve
  // correctly for the first paint. Synthesize a minimal entry carrying
  // just that URL; everything else stays inert until the live browser
  // handle takes over after hydration.
  const ssrEntry =
    url == null
      ? null
      : ({
          url,
          key: "",
          id: "",
          index: 0,
          sameDocument: true,
          getState: () => null,
          ondispose: null,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
          dispatchEvent: () => false,
        } as unknown as NavigationHistoryEntry)
  const stubMilestones = (): NavigationMilestones => ({
    committed: Promise.resolve(stubEntry),
    streaming: Promise.resolve(),
    finished: Promise.resolve(stubEntry),
  })
  const stubNavResult = {
    committed: Promise.resolve(stubEntry),
    finished: Promise.resolve(stubEntry),
  } as unknown as NavigationResult
  return {
    name,
    currentEntry: ssrEntry,
    canGoBack: false,
    canGoForward: false,
    transition: null,
    activation: null,
    entries: () => [],
    navigate: stubMilestones,
    reload: stubMilestones,
    back: () => stubNavResult,
    forward: () => stubNavResult,
    traverseTo: () => stubNavResult,
    updateCurrentEntry: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
    oncurrententrychange: null,
    onnavigate: null,
    onnavigateerror: null,
    onnavigatesuccess: null,
  } as unknown as ImperativeNavigation
}

// ─── Milestone deferreds ──────────────────────────────────────────

export interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (err: unknown) => void
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

export interface MilestoneDeferreds {
  committed: Deferred<NavigationHistoryEntry>
  streaming: Deferred<void>
  finished: Deferred<NavigationHistoryEntry>
}

/**
 * Build a fresh milestone-deferred triple. Each promise has a no-op
 * rejection handler pre-attached so an un-listened branch doesn't
 * surface as unhandledrejection when the rejection comes through — the
 * pre-attach doesn't consume the rejection, so subsequent consumer
 * handlers still see the error.
 *
 * The eager handle creates one of these SYNCHRONOUSLY on each fire and
 * returns its `.promise`s, then hands the triple to the late-loaded
 * executor to resolve/reject — so a fire's `{committed, streaming,
 * finished}` shape is available in the same tick the caller invoked it,
 * even while the executor module is still importing.
 */
export function makeMilestoneDeferreds(): MilestoneDeferreds {
  const committed = deferred<NavigationHistoryEntry>()
  const streaming = deferred<void>()
  const finished = deferred<NavigationHistoryEntry>()
  committed.promise.catch(() => {})
  streaming.promise.catch(() => {})
  finished.promise.catch(() => {})
  return { committed, streaming, finished }
}

/** Expose the three deferreds as a plain `NavigationMilestones`. */
export function milestonesOf(m: MilestoneDeferreds): NavigationMilestones {
  return {
    committed: m.committed.promise,
    streaming: m.streaming.promise,
    finished: m.finished.promise,
  }
}

/** Reject all three milestones — the eager handle's failure path when
 *  the executor module fails to load. */
export function rejectMilestones(m: MilestoneDeferreds, err: unknown): void {
  m.committed.reject(err)
  m.streaming.reject(err)
  m.finished.reject(err)
}
