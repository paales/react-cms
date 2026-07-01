/**
 * Client-side frame machinery + navigation handles.
 *
 * A frame (`<Partial frame="X">`) opens a per-name URL scope whose
 * state lives in the window navigation entry's `state.__frames` tree.
 * This module owns that tree's read/write path, the
 * `<FrameNameProvider>` that scopes descendants to a frame, and the
 * two imperative handle builders — window-scoped and frame-scoped
 * Proxies over `window.navigation` — that `useNavigation()` (see
 * `use-navigation.tsx`) wraps into the hook surface.
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
  type FrameworkNavigateOptions,
  type FrameworkReloadOptions,
  type ImperativeNavigation,
  type NavigateTarget,
  type NavigationMilestones,
} from "../runtime/navigation-api.ts"
import {
  abortPredecessors,
  getFrameUrl,
  hasFrameUrl,
  inFlightKey,
  registerInFlight,
  setFrameUrl,
  unregisterInFlight,
  type InFlightEntry,
} from "./partial-client-state.ts"
import {
  enqueueRefetch,
  makeSilentInfo,
  parseSelectorClient,
  type RefetchMilestones,
} from "./refetch.ts"

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
export const FrameUrlContext = createContext<ReadonlyMap<string, string>>(
  new Map<string, string>(),
)

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
interface FrameHistoryEntry {
  past: string[]
  future: string[]
}

interface FrameNode {
  /** Current URL for this frame. Not always present — a node may
   *  exist only to carry `__frames` for descendants (e.g. a parent
   *  node whose children mutated first). Readers fall back to
   *  the module-level frame-URL cache. */
  url?: string
  __frameHistory?: FrameHistoryEntry
  __frameState?: Record<string, unknown>
  __frames?: Record<string, FrameNode>
}

interface FramesTree {
  [localName: string]: FrameNode
}

/**
 * Read the per-frame URL tree from a navigation entry's state.
 * Exported for `entry.browser.tsx`'s traverse listener.
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
 * traverse diffing in `entry.browser.tsx` to detect which frames
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
function writeFrameNode(
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

function emptyHistoryEntry(): FrameHistoryEntry {
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
function runFrameTreeWrite(write: () => Promise<unknown> | undefined): void {
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

// ─── Frame refetch dispatch ───────────────────────────────────────

/**
 * Runs a frame refetch end-to-end: writes the cached URL, builds the
 * refetch URL with `__frame` + `__frameUrl`, dispatches to the RSC
 * refetch handler. Shared between `frame.navigate()` and the browser-
 * traverse listener (which re-invokes it for each frame whose URL
 * differs between the destination entry and the current one).
 *
 * Returns the handler's `{streaming, finished}` milestones so frame
 * `navigate` / `reload` can pipe them straight through to their own
 * `NavigationMilestones`. Callers awaiting completion use `.finished`.
 */
export function _dispatchFrameRefetch(
  path: readonly string[],
  url: string,
  options?: FrameworkNavigateOptions,
  signal?: AbortSignal,
): RefetchMilestones {
  const key = joinFramePath(path)
  setFrameUrl(key, url)
  const handler = (
    window as Window & {
      __rsc_partial_refetch?: (
        url: string,
        signal?: AbortSignal,
      ) => RefetchMilestones
    }
  ).__rsc_partial_refetch
  if (!handler) {
    return { streaming: Promise.resolve(), finished: Promise.resolve() }
  }
  const refetchUrl = new URL(window.location.href)
  refetchUrl.searchParams.set("__frame", key)
  refetchUrl.searchParams.set("__frameUrl", url)
  // Narrow to the TOP-LEVEL frame of the path as the partials filter.
  // For a top-level frame (path `["cart"]`), that's `partials=cart` —
  // same as pre-nesting behavior. For a nested frame (path
  // `["cart", "tab"]`), that's still `partials=cart` — we need the
  // root-of-the-subtree rendered FRESH so its descendants (the
  // nested frame included) re-run their bodies with the updated
  // session URL. Narrowing to the nested leaf's selector would be
  // more precise but requires a server-side registry lookup on
  // `framePath` to bridge local name → effective id; the ancestor
  // hint correctly widens the render until that's built.
  //
  // Without this hint, the parent frame's fingerprint (which hasn't
  // changed — only the nested child's frame URL did) would match
  // `?cached=`, the server would emit a placeholder, and the client
  // would keep showing stale nested content.
  //
  // Frame refetches invoked from the urlChanged path in
  // `entry.browser.tsx` deliberately DO NOT set `partials=` — they
  // want a full render so URL-dependent content (e.g. main listing
  // switching on `?product=`) rerenders while `__frame` still
  // updates the session.
  refetchUrl.searchParams.set("partials", path[0])
  if (options?.streaming) {
    refetchUrl.searchParams.set("streaming", "1")
  }
  return handler(refetchUrl.toString(), signal)
}

// ─── NavigateTarget resolution ────────────────────────────────────
//
// `FrameworkNavigation.navigate(target, ...)` accepts a URL string, a
// URL instance, or an updater function `(current: URL) => URL | string`.
// Both handle scopes synthesize an absolute URL for the updater so
// authors write the same code regardless of whether they hold a page
// or frame handle. For frames, the origin is the page origin (frame
// URLs are same-origin by construction) and a cross-origin result
// from the updater throws a hard error — frame refetches have no
// meaning outside the page's origin.

/** Resolve a `NavigateTarget` against a base URL. */
function applyTarget(target: NavigateTarget, base: URL): URL {
  if (typeof target === "function") {
    const result = target(new URL(base.href))
    return typeof result === "string" ? new URL(result, base) : result
  }
  if (target instanceof URL) return new URL(target.href)
  return new URL(target, base)
}

export function resolveWindowTarget(target: NavigateTarget): string {
  const base = new URL(window.location.href)
  return applyTarget(target, base).href
}

function resolveFrameTarget(target: NavigateTarget, frameName: string): string {
  const base = new URL(getFrameUrl(frameName) ?? "/", window.location.origin)
  const next = applyTarget(target, base)
  if (next.origin !== base.origin) {
    throw new Error(`frame "${frameName}" cannot navigate cross-origin (got ${next.origin})`)
  }
  return next.pathname + next.search + next.hash
}

// ─── Browser NavigationResult helpers ─────────────────────────────

/**
 * Await the browser's `NavigationResult.committed` (or resolve
 * immediately if absent — TS 6's `lib.dom.d.ts` marks it optional).
 * The framework's `NavigationMilestones.committed` is built off this
 * — it resolves once the browser entry exists and `currentEntry` can
 * be read.
 */
async function awaitCommitted(result: NavigationResult): Promise<void> {
  // The browser's NavigationResult exposes BOTH `committed` and
  // `finished`. When a newer `history:"replace"` navigation supersedes
  // this one (rapid search keystrokes), the browser rejects BOTH with
  // AbortError. If we await only `committed`, the `finished` rejection
  // is an orphaned promise → "Uncaught (in promise) AbortError:
  // BodyStreamBuffer was aborted" in the console. Consume `finished`
  // with a no-op so the supersede stays silent; callers that need the
  // finished milestone await it themselves via `awaitFinished`.
  silenceNavResultRejections(result)
  if (result.committed) await result.committed
}

/**
 * Attach no-op rejection handlers to a NavigationResult's `committed`
 * and `finished` promises so a browser-driven supersede (AbortError on
 * both) never surfaces as an unhandled rejection. The handlers don't
 * consume the rejection for real consumers — a later `await
 * result.committed` / `awaitFinished(result)` still observes it.
 */
function silenceNavResultRejections(result: NavigationResult): void {
  result.committed?.catch(() => {})
  result.finished?.catch(() => {})
}

/**
 * Await the browser's `NavigationResult.finished` (full commit +
 * any intercepted handler). The page-level navigate-event handler
 * does the framework's full-page refetch — `finished` resolves only
 * after that handler's promise settles.
 */
async function awaitFinished(result: NavigationResult): Promise<void> {
  if (result.finished) await result.finished
}

// ─── Deferred / milestone helpers ─────────────────────────────────

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (err: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/**
 * Build a fresh `NavigationMilestones` shell. Each milestone has a
 * no-op rejection handler pre-attached so an un-listened branch
 * doesn't surface as unhandledrejection when the rejection comes
 * through — the pre-attach doesn't consume the rejection, so
 * subsequent consumer handlers still see the error.
 */
function makeMilestoneDeferreds(): {
  committed: Deferred<NavigationHistoryEntry>
  streaming: Deferred<void>
  finished: Deferred<NavigationHistoryEntry>
} {
  const committed = deferred<NavigationHistoryEntry>()
  const streaming = deferred<void>()
  const finished = deferred<NavigationHistoryEntry>()
  committed.promise.catch(() => {})
  streaming.promise.catch(() => {})
  finished.promise.catch(() => {})
  return { committed, streaming, finished }
}

function parseOptionsSelector(
  options: FrameworkNavigateOptions | FrameworkReloadOptions | undefined,
): { labels: string[] } {
  if (!options?.selector) return { labels: [] }
  return parseSelectorClient(options.selector)
}

// ─── Frame entry projection ───────────────────────────────────────

/**
 * Project a window `NavigationHistoryEntry` into a frame-scoped
 * `FrameNavigationHistoryEntry`: `url` reports the frame's URL
 * (absolute, against the page origin); `getState()` returns the node
 * at `path`'s `__frameState` bucket, not the whole window state.
 */
function projectEntryForFrame(
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

function nullImperativeNavigation(
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

// ─── Handle builders ──────────────────────────────────────────────

/**
 * Apply client-side cookie writes from a `navigate` options bag.
 * Called synchronously at the entry of the window AND frame
 * `navigate` paths so the new cookie values are present in
 * `document.cookie` before the refetch fetch issues — the browser
 * picks them up automatically and ships them in the `Cookie` header.
 *
 * Cookies are NOT supported on `reload` — refetches that need a new
 * cookie value go through `navigate(currentUrl, {cookies})` instead.
 * With `history: "auto"` the URL-unchanged case resolves to a
 * replace, so the effect is identical to a reload plus the cookie
 * write, but the API surface stays strict: cookies imply a
 * `navigate`.
 *
 * Frame handles share this global write — `document.cookie` is not
 * frame-scoped at the browser layer, so a frame.navigate({cookies})
 * writes the same cookie any other handle would. Per-frame cookie
 * scoping would need a different mechanism (a server-side cookie
 * namespace, or a synthetic header) and can be layered later.
 *
 * Empty string deletes the cookie (`max-age=0`). Defaults: `path=/`,
 * `samesite=lax`, `max-age=31536000`. Callers that need different
 * attributes can append them in the value string (cookies do not
 * have a structured-write API in browsers).
 */
function applyClientCookies(cookies: Record<string, string> | undefined): void {
  if (!cookies) return
  for (const [name, value] of Object.entries(cookies)) {
    if (value === "") {
      document.cookie = `${encodeURIComponent(name)}=; path=/; max-age=0; samesite=lax`
    } else {
      document.cookie = `${encodeURIComponent(name)}=${encodeURIComponent(value)}; path=/; max-age=31536000; samesite=lax`
    }
  }
}

/**
 * Window-scoped handle — a Proxy over `window.navigation` with
 * `name: null`, an extended `navigate()` (updater callback, targeted
 * refetch via `selector`, `silent` URL-only updates) and an extended
 * `reload()` (targeted refetch without a URL change). Everything
 * else passes straight through to the browser.
 */
export function buildWindowNavigationHandle(ssrUrl?: string | null): ImperativeNavigation {
  const nav = getNavigation()
  // No browser Navigation API → SSR or pre-hydration. Fall back to the
  // Flight-borne page URL so `currentEntry.url` is correct on first
  // paint; the live handle takes over once `window.navigation` exists.
  if (!nav) return nullImperativeNavigation(null, ssrUrl ?? null)

  const windowNavigate = (
    target: NavigateTarget,
    options?: FrameworkNavigateOptions,
  ): NavigationMilestones => {
    applyClientCookies(options?.cookies)
    const url = resolveWindowTarget(target)
    const parsed = parseOptionsSelector(options)
    const filtered = parsed.labels.length > 0
    const silent = options?.silent === true
    const m = makeMilestoneDeferreds()

    if (filtered || silent) {
      // URL-only update — the page-level listener sees the branded
      // info and declines to intercept, so no refetch fires from its
      // side. If we have a selector filter, dispatch the targeted
      // refetch ourselves after commit.
      const result = nav.navigate(url, {
        history: options?.history ?? "push",
        state: options?.state ?? null,
        info: makeSilentInfo("window"),
      })

      void (async () => {
        try {
          await awaitCommitted(result)
          m.committed.resolve(nav.currentEntry!)
          if (silent) {
            m.streaming.resolve()
            m.finished.resolve(nav.currentEntry!)
            return
          }
          // Targeted refetches are NEVER aborted on supersede. A
          // refetch is one Flight document feeding the whole root;
          // aborting it mid-decode rejects the entire document (not
          // just the superseded section) and crashes the page through
          // the nearest error boundary. Superseded fires drain and
          // commit — they're small once fp-skipped — but the monotonic
          // commit guard (`refetch-ordering.ts`) drops a late older
          // fire's commit so it can't clobber a newer one. `navigate`
          // has no caller signal (unlike `reload`), so nothing cancels
          // a window-nav fire.
          const refetch = enqueueRefetch({
            labels: parsed.labels,
            streaming: options?.streaming ?? false,
            // Navigation is one-shot — a held-open subscription belongs
            // to the heartbeat's `reload({live: true})`, not a nav.
            live: false,
          })
          await refetch.streaming
          m.streaming.resolve()
          await refetch.finished
          m.finished.resolve(nav.currentEntry!)
        } catch (err) {
          m.committed.reject(err)
          m.streaming.reject(err)
          m.finished.reject(err)
        }
      })()
      return {
        committed: m.committed.promise,
        streaming: m.streaming.promise,
        finished: m.finished.promise,
      }
    }

    // Full-page nav: the navigate-event listener intercepts and runs
    // the framework's main refetch via `fetchRscPayload(...).finished`,
    // so `result.finished` covers both the browser commit and the full
    // body drain. No per-segment hook is exposed today, so `streaming`
    // collapses to `finished`.
    const result = nav.navigate(url, {
      history: options?.history,
      state: options?.state,
      info: options?.info,
    })
    void (async () => {
      try {
        await awaitCommitted(result)
        m.committed.resolve(nav.currentEntry!)
        await awaitFinished(result)
        m.streaming.resolve()
        m.finished.resolve(nav.currentEntry!)
      } catch (err) {
        m.committed.reject(err)
        m.streaming.reject(err)
        m.finished.reject(err)
      }
    })()
    return {
      committed: m.committed.promise,
      streaming: m.streaming.promise,
      finished: m.finished.promise,
    }
  }

  const windowReload = (
    options?: FrameworkReloadOptions,
  ): NavigationMilestones => {
    const parsed = parseOptionsSelector(options)
    const m = makeMilestoneDeferreds()

    // Three ways to reach the in-place refetch path (no browser reload):
    //
    //   1. Selector filter (`reload({selector: "#cart"})`) — targeted
    //      partial refetch. Existing behaviour.
    //   2. Live subscription (`reload({live: true})`) without a
    //      selector — the framework heartbeat. Full-page top-down
    //      re-render with fp-skip pruning unchanged partials; the
    //      `?live=1` URL flag holds the connection open for live
    //      updates.
    //   3. Streaming opt-in (`reload({streaming: true})`) — the client
    //      commits the response progressively. A render-mode switch, not
    //      a browser reload, so it stays in-place too.
    //
    // Only a bare `reload()` (no selector, no streaming, no live) falls
    // through to `nav.reload()` — that's the user-facing "reload this
    // URL" command and IS supposed to do a real browser reload.
    const wantsInPlace =
      parsed.labels.length > 0 || options?.streaming === true || options?.live === true
    if (wantsInPlace) {
      m.committed.resolve(nav.currentEntry!)
      void (async () => {
        try {
          // Targeted refetches are NEVER aborted on supersede — see the
          // note in `windowNavigate`. Only the caller's own
          // `options.signal` cancels a fire; the heartbeat passes one so
          // its long-poll connection tears down on nav-away.
          const refetch = enqueueRefetch({
            labels: parsed.labels,
            streaming: options?.streaming ?? false,
            // `live: true` (the heartbeat) holds the connection open as
            // a subscription; a bare `reload({selector, streaming})` is
            // one-shot and closes once its segment drains.
            live: options?.live ?? false,
            signal: options?.signal,
            params: options?.params,
          })
          await refetch.streaming
          m.streaming.resolve()
          await refetch.finished
          m.finished.resolve(nav.currentEntry!)
        } catch (err) {
          m.streaming.reject(err)
          m.finished.reject(err)
        }
      })()
      return {
        committed: m.committed.promise,
        streaming: m.streaming.promise,
        finished: m.finished.promise,
      }
    }

    const result = nav.reload({ state: options?.state, info: options?.info })
    void (async () => {
      try {
        await awaitCommitted(result)
        m.committed.resolve(nav.currentEntry!)
        await awaitFinished(result)
        m.streaming.resolve()
        m.finished.resolve(nav.currentEntry!)
      } catch (err) {
        m.committed.reject(err)
        m.streaming.reject(err)
        m.finished.reject(err)
      }
    })()
    return {
      committed: m.committed.promise,
      streaming: m.streaming.promise,
      finished: m.finished.promise,
    }
  }

  return new Proxy(nav, {
    get(_target, prop, _receiver) {
      if (prop === "name") return null
      if (prop === "navigate") return windowNavigate
      if (prop === "reload") return windowReload
      // Native Navigation getters (currentEntry, canGoBack,
      // canGoForward, transition, activation) throw "Illegal
      // invocation" when invoked with a non-Navigation `this`, so we
      // have to bypass the Proxy receiver and read directly off
      // `window.navigation`.
      const value = (nav as unknown as Record<string | symbol, unknown>)[prop]
      return typeof value === "function" ? value.bind(nav) : value
    },
  }) as unknown as ImperativeNavigation
}

/**
 * Frame-scoped handle — a Proxy over `window.navigation` with
 * frame-scoped overrides.
 *
 * `navigate` defaults to `history: "auto"` which patches the current
 * browser entry via `updateCurrentEntry` (no new entry) and pushes
 * the prior frame URL onto `__frameHistory[name].past`. Browser
 * back/forward is left alone; `frame.back()` walks the in-state
 * stack. Explicit `history: "push" | "replace"` still uses
 * `nav.navigate()` for callers that want a bookmarkable drawer URL
 * or a pure URL sync (search-as-you-type).
 *
 * `back` / `forward` / `canGoBack` / `canGoForward` read the
 * in-state `__frameHistory[name]` arrays instead of scanning
 * browser entries — this is what lets a drawer have a back stack
 * without polluting browser history. `currentEntry` / `entries()`
 * project the frame URL and state; `updateCurrentEntry` merges user
 * state under `__frameState[name]`.
 */
export function buildFrameHandle(
  path: readonly string[],
  ssrUrl?: string | null,
): ImperativeNavigation {
  const nav = getNavigation()
  const key = joinFramePath(path)
  // No browser Navigation API → SSR / pre-hydration. Resolve
  // `currentEntry.url` from the Flight-borne frame URL so a framed
  // `useNavigation()` is correct on first paint; the live handle takes
  // over once `window.navigation` exists.
  if (!nav) return nullImperativeNavigation(key, ssrUrl ?? null)
  if (path.length === 0) {
    throw new Error("buildFrameHandle: path must be non-empty")
  }

  const frameNavigate = (
    target: NavigateTarget,
    options?: FrameworkNavigateOptions,
  ): NavigationMilestones => {
    applyClientCookies(options?.cookies)
    const url = resolveFrameTarget(target, key)
    const historyMode: NavigationHistoryBehavior = options?.history ?? "auto"

    // Fallback prior URL for the per-frame history push, captured
    // BEFORE the cache write below overwrites it. Only consulted when
    // the entry carries no node for this frame yet (first nav before
    // FrameNameProvider seeded it).
    const cachedPriorUrl = getFrameUrl(key) ?? null

    // Seed the client-side frame-URL cache BEFORE we touch Navigation —
    // `nav.navigate`/`updateCurrentEntry` fires events synchronously
    // that bump reactive consumers; waiting would have them read a
    // stale URL.
    setFrameUrl(key, url)

    const m = makeMilestoneDeferreds()

    // Frame nav participates in the same per-selector supersede queue
    // as `windowNavigate({selector})` — keyed by the top-level frame
    // name (which is also the `partials=` value the server sees), so
    // a `?chat=closed` frame nav fires while a prior `?chat=open`
    // segment-loop fetch is still streaming, the older fetch aborts
    // when the newer one's first segment lands. Without this, the
    // chat overlay's open response keeps streaming tick updates and
    // races the close response's commit.
    const inFlightK = inFlightKey([path[0]])
    const controller = inFlightK ? new AbortController() : undefined
    const inFlightEntry: InFlightEntry | null =
      inFlightK && controller ? { controller } : null
    if (inFlightK && inFlightEntry) registerInFlight(inFlightK, inFlightEntry)

    // The frames-tree read-modify-write runs under the write
    // serialiser (see `runFrameTreeWrite`): the entry state is read,
    // patched and committed as one exclusive cycle, so concurrent
    // frame navs can't clone the same snapshot and drop each other's
    // updates. A push/replace nav holds the serialiser until its
    // browser entry commits (the snapshot is baked into
    // `nav.navigate`); the auto path applies synchronously.
    runFrameTreeWrite(() => {
      const priorState =
        (nav.currentEntry?.getState() as Record<string, unknown> | null) ?? {}
      const priorNode = _readFrameNode(priorState, path)
      // Prior URL for this frame — prefer the entry snapshot, fall back
      // to the module-level cache for first nav before FrameNameProvider
      // seeded the entry.
      const priorUrl = priorNode?.url ?? cachedPriorUrl

      // History update policy per mode:
      //   auto  — push prior URL onto past, clear future. (DEFAULT)
      //   push  — same push on the per-frame stack, PLUS a new browser
      //           entry (drawer URLs the user wants in browser history).
      //   replace — no change to the per-frame stack (pure URL sync).
      const pushToHistory = historyMode === "auto" || historyMode === "push"

      const userState = (options?.state as Record<string, unknown> | null) ?? null
      const baseState = { ...priorState, ...(userState ?? {}) }
      const nextState = writeFrameNode(baseState, path, (node) => {
        const existingHistory = node.__frameHistory ?? emptyHistoryEntry()
        const nextHistory: FrameHistoryEntry = pushToHistory
          ? {
              past:
                priorUrl != null && priorUrl !== url
                  ? [...existingHistory.past, priorUrl]
                  : existingHistory.past,
              future: [],
            }
          : existingHistory
        return { ...node, url, __frameHistory: nextHistory }
      })

      if (historyMode === "auto") {
        // No new browser entry. updateCurrentEntry patches state in
        // place, fires currententrychange (consumers update) but NOT
        // navigate — no silent-info bypass needed. `committed` resolves
        // immediately because there's no browser commit to wait on.
        nav.updateCurrentEntry({ state: nextState })
        m.committed.resolve(nav.currentEntry!)
        const refetch = _dispatchFrameRefetch(path, url, options, controller?.signal)
        void (async () => {
          try {
            await refetch.streaming
            if (inFlightK && inFlightEntry) abortPredecessors(inFlightK, inFlightEntry)
            m.streaming.resolve()
            await refetch.finished
            m.finished.resolve(nav.currentEntry!)
          } catch (err) {
            m.streaming.reject(err)
            m.finished.reject(err)
          } finally {
            if (inFlightK && inFlightEntry) unregisterInFlight(inFlightK, inFlightEntry)
          }
        })()
        // State applied synchronously — release the serialiser.
        return undefined
      }

      // Explicit push/replace — browser entry grows/replaces. Use the
      // silent-info brand so the page-level listener doesn't also fire
      // a full-page refetch.
      const result = nav.navigate(window.location.href, {
        history: historyMode,
        state: nextState,
        info: makeSilentInfo("frame", key),
      })
      void (async () => {
        try {
          await awaitCommitted(result)
          m.committed.resolve(nav.currentEntry!)
          const refetch = _dispatchFrameRefetch(path, url, options, controller?.signal)
          await refetch.streaming
          if (inFlightK && inFlightEntry) abortPredecessors(inFlightK, inFlightEntry)
          m.streaming.resolve()
          await refetch.finished
          m.finished.resolve(nav.currentEntry!)
        } catch (err) {
          m.committed.reject(err)
          m.streaming.reject(err)
          m.finished.reject(err)
        } finally {
          if (inFlightK && inFlightEntry) unregisterInFlight(inFlightK, inFlightEntry)
        }
      })()
      // Hold the serialiser until the browser entry (with the baked
      // state snapshot) commits or the navigation aborts.
      return result.committed?.catch(() => {})
    })

    return {
      committed: m.committed.promise,
      streaming: m.streaming.promise,
      finished: m.finished.promise,
    }
  }

  const frameReload = (
    options?: FrameworkReloadOptions,
  ): NavigationMilestones => {
    const url = getFrameUrl(key)
    const m = makeMilestoneDeferreds()
    const entry = nav.currentEntry!
    m.committed.resolve(entry)
    if (!url) {
      // No frame URL known — there's nothing to refetch.
      m.streaming.resolve()
      m.finished.resolve(entry)
      return {
        committed: m.committed.promise,
        streaming: m.streaming.promise,
        finished: m.finished.promise,
      }
    }
    const refetch = _dispatchFrameRefetch(path, url, options)
    void (async () => {
      try {
        await refetch.streaming
        m.streaming.resolve()
        await refetch.finished
        m.finished.resolve(nav.currentEntry!)
      } catch (err) {
        m.streaming.reject(err)
        m.finished.reject(err)
      }
    })()
    return {
      committed: m.committed.promise,
      streaming: m.streaming.promise,
      finished: m.finished.promise,
    }
  }

  /**
   * Move within the per-entry `__frameHistory` arrays. No browser
   * traversal — pure state patch via `updateCurrentEntry` plus a
   * refetch dispatch. Missing / empty stack → no-op with stub result.
   * The read-compute-patch cycle runs under the frames-tree write
   * serialiser, like every other frames-tree mutation.
   */
  const frameTraverseInState = (direction: "back" | "forward"): NavigationResult => {
    const stub = null as unknown as NavigationHistoryEntry
    const committed = deferred<NavigationHistoryEntry>()
    const finished = deferred<NavigationHistoryEntry>()
    committed.promise.catch(() => {})
    finished.promise.catch(() => {})
    runFrameTreeWrite(() => {
      const priorState =
        (nav.currentEntry?.getState() as Record<string, unknown> | null) ?? {}
      const priorNode = _readFrameNode(priorState, path)
      const history = priorNode?.__frameHistory ?? emptyHistoryEntry()
      const currentUrl = priorNode?.url ?? getFrameUrl(key) ?? null

      let nextUrl: string | null = null
      let nextPast = history.past
      let nextFuture = history.future
      if (direction === "back") {
        if (history.past.length === 0) {
          committed.resolve(stub)
          finished.resolve(stub)
          return undefined
        }
        nextUrl = history.past[history.past.length - 1]
        nextPast = history.past.slice(0, -1)
        nextFuture = currentUrl != null ? [currentUrl, ...history.future] : history.future
      } else {
        if (history.future.length === 0) {
          committed.resolve(stub)
          finished.resolve(stub)
          return undefined
        }
        nextUrl = history.future[0]
        nextFuture = history.future.slice(1)
        nextPast = currentUrl != null ? [...history.past, currentUrl] : history.past
      }

      const resolvedNextUrl = nextUrl
      const nextState = writeFrameNode(priorState, path, (node) => ({
        ...node,
        url: resolvedNextUrl,
        __frameHistory: { past: nextPast, future: nextFuture },
      }))

      setFrameUrl(key, resolvedNextUrl)
      nav.updateCurrentEntry({ state: nextState })
      const work = _dispatchFrameRefetch(path, resolvedNextUrl)
      const resolveEntry = () => nav.currentEntry ?? stub
      committed.resolve(resolveEntry())
      work.finished.then(
        () => finished.resolve(resolveEntry()),
        (err) => finished.reject(err),
      )
      return undefined
    })
    return {
      committed: committed.promise,
      finished: finished.promise,
    }
  }

  const frameUpdateCurrentEntry = (options: NavigationUpdateCurrentEntryOptions): void => {
    runFrameTreeWrite(() => {
      const current = (nav.currentEntry?.getState() as Record<string, unknown> | null) ?? {}
      const patch = options.state as Record<string, unknown> | null
      const next = writeFrameNode(current, path, (node) => ({
        ...node,
        __frameState: { ...(node.__frameState ?? {}), ...(patch ?? {}) },
      }))
      nav.updateCurrentEntry({ state: next })
      return undefined
    })
  }

  return new Proxy(nav, {
    get(target, prop) {
      if (prop === "name") return key
      if (prop === "navigate") return frameNavigate
      if (prop === "reload") return frameReload
      if (prop === "back") return () => frameTraverseInState("back")
      if (prop === "forward") return () => frameTraverseInState("forward")
      if (prop === "canGoBack") {
        const node = _readFrameNode(target.currentEntry?.getState(), path)
        return (node?.__frameHistory?.past.length ?? 0) > 0
      }
      if (prop === "canGoForward") {
        const node = _readFrameNode(target.currentEntry?.getState(), path)
        return (node?.__frameHistory?.future.length ?? 0) > 0
      }
      if (prop === "currentEntry") return projectEntryForFrame(target.currentEntry, path)
      if (prop === "entries") {
        return () =>
          target
            .entries()
            .map((e) => projectEntryForFrame(e, path))
            .filter((e): e is FrameNavigationHistoryEntry => e !== null)
      }
      if (prop === "updateCurrentEntry") return frameUpdateCurrentEntry
      // See window-handle Proxy above — native Navigation getters
      // throw "Illegal invocation" when reached via the Proxy
      // receiver, so we read directly off `target` (window.navigation).
      const value = (target as unknown as Record<string | symbol, unknown>)[prop]
      return typeof value === "function" ? value.bind(target) : value
    },
  }) as unknown as ImperativeNavigation
}

/**
 * Framework-internal plain-function handle for a frame. Accepts the
 * frame's full dotted path (e.g. `"cart"` or `"products.list"`) or an
 * equivalent array of local names.
 *
 * @internal Not part of the public API. App code should always use
 * {@link useNavigation} — it's reactive, participates in React's
 * render lifecycle, and subscribes to navigation events. `_frame()`
 * exists only for framework code that runs outside a render (class-
 * component methods, module scope, callbacks invoked from
 * `useActivate` subscriptions — where the hook can't reach).
 */
export function _frame(pathOrName: string | readonly string[]): ImperativeNavigation {
  const path = Array.isArray(pathOrName) ? pathOrName : splitFramePath(pathOrName as string)
  return buildFrameHandle(path)
}

/**
 * Framework-internal plain-function handle for the window.
 *
 * @internal Not part of the public API. App code should always use
 * {@link useNavigation} — it's reactive, participates in React's
 * render lifecycle, and subscribes to navigation events. `_windowNav()`
 * exists only for framework code that runs outside a render (class-
 * component methods, module scope, callbacks invoked from
 * `useActivate` subscriptions — where the hook can't reach). A
 * subscribe callback needs the handle threaded in as a parameter
 * from the component's render, not fetched here.
 *
 * Always pick this over reaching into `window.navigation` directly:
 * it respects the framework's silent-info convention so internal URL
 * syncs don't trigger a full page refetch.
 */
export function _windowNav(): ImperativeNavigation {
  return buildWindowNavigationHandle()
}
