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
import { getNavigation } from "../runtime/navigation-api.ts"
import { hasFrameUrl, setFrameUrl } from "./partial-client-state.ts"

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
