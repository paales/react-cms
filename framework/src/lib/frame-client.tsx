/**
 * Client-side frame navigation machinery — the LATE-LOADED half.
 *
 * A frame (`<Partial frame="X">`) opens a per-name URL scope whose
 * state lives in the window navigation entry's `state.__frames` tree.
 * This module owns the frame refetch dispatch and the two imperative
 * handle builders — window-scoped and frame-scoped Proxies over
 * `window.navigation` — that `useNavigation()` (see `use-navigation.tsx`)
 * wraps into the hook surface. Everything here reaches the channel
 * transport / refetch, so it is dynamically imported off the boot path;
 * the eager frame contexts, the frames-tree read/write model and
 * `<FrameNameProvider>` live in `frame-context.tsx`.
 */

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
import { _channelCookieChange, _channelFrameNavigate } from "./channel-client.ts"
import {
  emptyHistoryEntry,
  type FrameHistoryEntry,
  joinFramePath,
  _readFrameNode,
  runFrameTreeWrite,
  splitFramePath,
  writeFrameNode,
} from "./frame-context.tsx"
import { getFrameUrl, setFrameUrl } from "./partial-client-state.ts"
import { enqueueRefetch, makeSilentInfo, type RefetchMilestones } from "./refetch.ts"

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
  // The statement: a FRAME-scoped url frame. Attached, it rides the
  // held stream — the endpoint writes the session frame URL, the
  // driver lanes the frame's targets, and the milestones resolve off
  // the covering lane's correlation flag. Pre-establishment it latches
  // and rides the attach it triggers (the statement's `frames`
  // intent). A superseding statement for the same frame ships its
  // `cancel` co-rider in the same envelope. Intent is descriptive:
  // the frame's history work is client-local in-state (or a
  // silent-info browser entry), done by send time.
  const routed = _channelFrameNavigate({
    path,
    url,
    intent: "silent",
    streaming: options?.streaming === true,
    signal,
  })
  if (routed) return routed
  // DEGRADED: no framework transport exists. The frame move is a
  // document navigation carrying `__frame`/`__frameUrl` document
  // params — the SSR render writes them into the session and renders
  // the frame state (a plain website's version of the drawer link).
  // The listener stands down (degraded), so this is a full load.
  const target = new URL(window.location.href)
  target.searchParams.append("__frame", key)
  target.searchParams.append("__frameUrl", url)
  getNavigation()?.navigate(target.href, { history: "replace" })
  return { streaming: Promise.resolve(), finished: Promise.resolve() }
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

function nullImperativeNavigation(name: string | null, url?: string | null): ImperativeNavigation {
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
  // The wire form each change would carry in the `Cookie` header —
  // URL-encoded value, or `null` for a delete — so the channel overlay
  // and a later reattach's raw header agree on the same value.
  const changes: Record<string, string | null> = {}
  for (const [name, value] of Object.entries(cookies)) {
    if (value === "") {
      document.cookie = `${encodeURIComponent(name)}=; path=/; max-age=0; samesite=lax`
      changes[name] = null
    } else {
      document.cookie = `${encodeURIComponent(name)}=${encodeURIComponent(value)}; path=/; max-age=31536000; samesite=lax`
      changes[name] = encodeURIComponent(value)
    }
  }
  // State the change to the held connection instead of tearing it: the
  // server applies it to the connection's cookie overlay and re-lanes
  // the cookie's readers on the held stream, no reattach. With no
  // connection open this is a no-op — the next attach's `Cookie` header
  // carries the fresh jar.
  _channelCookieChange(changes)
}

/**
 * Window-scoped handle — a Proxy over `window.navigation` with
 * `name: null`, an extended `navigate()` (updater callback, `silent`
 * URL-only updates, client cookie writes) and an extended `reload()`
 * (in-place streaming refetch). Everything else passes straight
 * through to the browser.
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
    const silent = options?.silent === true
    const m = makeMilestoneDeferreds()

    if (silent) {
      // URL-only update — the page-level listener sees the branded
      // info and declines to intercept, so no refetch fires from its
      // side.
      const result = nav.navigate(url, {
        history: options?.history ?? "push",
        state: options?.state ?? null,
        info: makeSilentInfo("window"),
      })

      void (async () => {
        try {
          await awaitCommitted(result)
          m.committed.resolve(nav.currentEntry!)
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

  const windowReload = (options?: FrameworkReloadOptions): NavigationMilestones => {
    const m = makeMilestoneDeferreds()

    // Streaming opt-in (`reload({streaming: true})`) reaches the
    // in-place refetch path (no browser reload): the client commits
    // the response progressively — a render-mode switch stated on the
    // channel, not a browser reload.
    //
    // Only a bare `reload()` (no streaming) falls through to
    // `nav.reload()` — that's the user-facing "reload this URL"
    // command and IS supposed to do a real browser reload.
    if (options?.streaming === true) {
      m.committed.resolve(nav.currentEntry!)
      void (async () => {
        try {
          // Supersede ordering is the channel's — a newer statement's
          // covering segment resolves older fires too. Only the
          // caller's own `options.signal` cancels a fire.
          const refetch = enqueueRefetch({
            ids: [],
            streaming: true,
            signal: options?.signal,
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

    // The frames-tree read-modify-write runs under the write
    // serialiser (see `runFrameTreeWrite`): the entry state is read,
    // patched and committed as one exclusive cycle, so concurrent
    // frame navs can't clone the same snapshot and drop each other's
    // updates. A push/replace nav holds the serialiser until its
    // browser entry commits (the snapshot is baked into
    // `nav.navigate`); the auto path applies synchronously.
    runFrameTreeWrite(() => {
      const priorState = (nav.currentEntry?.getState() as Record<string, unknown> | null) ?? {}
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
          const refetch = _dispatchFrameRefetch(path, url, options)
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

  const frameReload = (options?: FrameworkReloadOptions): NavigationMilestones => {
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
      const priorState = (nav.currentEntry?.getState() as Record<string, unknown> | null) ?? {}
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
