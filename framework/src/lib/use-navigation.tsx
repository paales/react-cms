/**
 * Hook layer over the imperative navigation handles.
 *
 * `useNavigation()` resolves the ambient frame path, memoizes an
 * imperative handle (see `frame-client.tsx`) and wraps its `reload` /
 * `navigate` methods into hooks returning `[fire, progress]` tuples.
 * Also home to the client contexts the hooks read — the Flight-borne
 * page URL (`PageUrlContext`) and the enclosing partial id
 * (`PartialIdContext`, the framework-internal self-refetch handle) —
 * plus the activator (`useActivate`) and scroll-restore
 * (`useScrollRestore`) building blocks.
 */

import React, {
  createContext,
  useContext,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useState,
  useRef,
  type ReactNode,
  type RefObject,
} from "react"
import {
  getNavigation,
  type FrameworkNavigateOptions,
  type FrameworkNavigation,
  type FrameworkReloadOptions,
  type ImperativeNavigation,
  type Navigate,
  type NavigateStatus,
  type NavigateTarget,
  type NavigationMilestones,
  type NavigationProgress,
  type Reload,
  type ReloadStatus,
} from "../runtime/navigation-api.ts"
import { NavigationError, toNavigationError } from "../runtime/navigation-error.ts"
import { _channelIsDegraded, _channelWarm } from "./channel-client.ts"
import { enqueueRefetch } from "./refetch.ts"
import {
  buildFrameHandle,
  buildWindowNavigationHandle,
  resolveWindowTarget,
  _frame,
} from "./frame-client.tsx"
import {
  FrameNameContext,
  FrameUrlContext,
  joinFramePath,
  splitFramePath,
} from "./frame-context.tsx"

// ─── Client contexts ──────────────────────────────────────────────

/**
 * Enclosing partial instance id. Set by every spec's render via the
 * `<PartialIdContext.Provider>` wrapper around its body.
 * Framework-internal: the interactive-embed bridge reads it to
 * address its post-write echo at the enclosing parton
 * (`lib/embed-interactive.tsx`). Not an author surface — author
 * refresh signals are cells and `tag()`.
 */
export const PartialIdContext = createContext<string | null>(null)

/**
 * The current page URL, threaded from the server render through Flight
 * so client components resolve it on the initial (SSR) paint — before
 * the browser Navigation API exists. `PartialRoot` seeds it at the root;
 * after hydration `useNavigation()` reads the live browser URL instead,
 * so this value is consulted only while `window.navigation` is absent
 * (SSR / pre-hydration). This is what makes `useNavigation()` isomorphic:
 * server-correct on first paint, browser-driven after.
 *
 * Because it's never read on a client-driven `.rsc` refetch (the live
 * Navigation API is present there), `PartialRoot` seeds it as `null` on
 * those — serializing the URL into every refetch payload would be dead
 * weight the live Navigation API supersedes. It carries a real
 * (framework-param-stripped) string only on the SSR document render.
 */
export const PageUrlContext = createContext<string | null>(null)

/**
 * Provide the page URL to descendant client components. Rendered by a
 * server component at the app root with the request URL, so the value
 * crosses Flight and is present during SSR. Pairs with the SSR branch
 * of `buildWindowNavigationHandle`.
 */
export function PageUrlProvider({
  url,
  children,
}: {
  /** `null` on a client-driven `.rsc` refetch — the live Navigation API
   *  supersedes this seed there, so the server omits it (see
   *  `PartialRoot`). A string only on the SSR document paint. */
  url: string | null
  children: ReactNode
}) {
  return <PageUrlContext value={url}>{children}</PageUrlContext>
}

// ─── Hook wrappers around the imperative handle ───────────────────

/**
 * Internal state backing the milestone tuple. The three `committed` /
 * `streaming` / `finished` booleans are what the consumer sees through
 * `NavigationProgress`. `error` is kept here too so that a fire's
 * rejection can be thrown from render (the nearest
 * `<NavigationErrorBubbler>` / error boundary catches), but it's
 * intentionally NOT surfaced through the tuple — the bubbler is the
 * one and only consumer-facing error channel.
 *
 * `fireId` is a monotonic counter that lets per-milestone watchers
 * skip updates from a fire that's already been superseded by the next
 * one. Without it, two rapid keystrokes would race: fire-1's commit
 * watcher could land after fire-2's reset, polluting fire-2's state.
 */
interface InternalProgressState {
  fireId: number
  committed: boolean
  streaming: boolean
  finished: boolean
  error: NavigationError | null
}

const INITIAL_PROGRESS_STATE: InternalProgressState = {
  fireId: 0,
  committed: false,
  streaming: false,
  finished: false,
  error: null,
}

/**
 * Classify a milestone rejection into either a NavigationError (for
 * the bubbler) or null (AbortError — a normal lifecycle event when a
 * newer fire supersedes, NOT a failure).
 */
function classifyMilestoneError(err: unknown): NavigationError | null {
  if (err instanceof Error && err.name === "AbortError") return null
  if (err instanceof NavigationError) return err
  return toNavigationError(err, typeof window !== "undefined" ? window.location.href : "?")
}

/**
 * Wrap a synchronously-thrown error from the fire body into a
 * milestones object whose three promises are all immediately
 * rejected. The
 * watcher path then classifies and bubbles it the same way as a
 * mid-fetch rejection — sync and async failures share one channel.
 */
function rejectedMilestones(err: unknown): NavigationMilestones {
  const wrapped =
    err instanceof NavigationError
      ? err
      : toNavigationError(err, typeof window !== "undefined" ? window.location.href : "?")
  const m: NavigationMilestones = {
    committed: Promise.reject(wrapped),
    streaming: Promise.reject(wrapped),
    finished: Promise.reject(wrapped),
  }
  // Pre-attach no-op rejection handlers so un-listened branches
  // don't surface as unhandledrejection.
  m.committed.catch(() => {})
  m.streaming.catch(() => {})
  m.finished.catch(() => {})
  return m
}

/**
 * Inner hook backing `nav.reload()`. Owns the milestone-progress state
 * for one call site, attaches watchers to each fire's
 * `committed` / `streaming` / `finished` promises to flip the
 * corresponding boolean to `true`, and surfaces errors through the
 * render-throw bubbler path. The fire fn returns
 * `NavigationMilestones` synchronously so consumers can `.finished` /
 * `.streaming` independently.
 */
function useReloadHook(imperative: ImperativeNavigation): ReloadStatus {
  const [state, setState] = useState<InternalProgressState>(INITIAL_PROGRESS_STATE)
  // `fireIdRef` survives across renders without re-triggering useMemo
  // deps, so the fire callback's identity stays stable for callers
  // passing it into effect deps. Each invocation bumps to the next
  // monotonic id, captured into the milestone watchers' closure for
  // supersede-detection.
  const fireIdRef = useRef(0)
  // Lift the error to render so the nearest enclosing React error
  // boundary catches. The throw bubbles from THIS component; a
  // boundary reset re-mounts with a fresh useState (no error) so
  // there's no stale-error loop.
  if (state.error) throw state.error
  const fire = useMemo<Reload>(
    () => (options) => {
      fireIdRef.current += 1
      const myFireId = fireIdRef.current
      setState({
        fireId: myFireId,
        committed: false,
        streaming: false,
        finished: false,
        error: null,
      })
      let milestones: NavigationMilestones
      try {
        milestones = imperative.reload(options)
      } catch (err) {
        milestones = rejectedMilestones(err)
      }
      attachMilestoneWatchers(milestones, myFireId, setState)
      return milestones
    },
    [imperative],
  )
  return [
    fire,
    {
      committed: state.committed,
      streaming: state.streaming,
      finished: state.finished,
    } satisfies NavigationProgress,
  ] as const
}

/**
 * Inner hook backing `nav.navigate()`. Same shape as
 * {@link useReloadHook} — see its comment for the rationale.
 */
function useNavigateHook(imperative: ImperativeNavigation): NavigateStatus {
  const [state, setState] = useState<InternalProgressState>(INITIAL_PROGRESS_STATE)
  const fireIdRef = useRef(0)
  if (state.error) throw state.error
  const fire = useMemo<Navigate>(
    () => (target, options) => {
      fireIdRef.current += 1
      const myFireId = fireIdRef.current
      setState({
        fireId: myFireId,
        committed: false,
        streaming: false,
        finished: false,
        error: null,
      })
      let milestones: NavigationMilestones
      try {
        milestones = imperative.navigate(target, options)
      } catch (err) {
        milestones = rejectedMilestones(err)
      }
      attachMilestoneWatchers(milestones, myFireId, setState)
      return milestones
    },
    [imperative],
  )
  return [
    fire,
    {
      committed: state.committed,
      streaming: state.streaming,
      finished: state.finished,
    } satisfies NavigationProgress,
  ] as const
}

/**
 * Wire up the three milestone promises to a setState dispatcher.
 * Each watcher checks `myFireId` against the latest state's
 * `fireId` before applying its update, so an older fire that
 * resolves AFTER a newer one started can't pollute the newer fire's
 * progress booleans.
 *
 * `error` is set from any milestone's rejection (except AbortError);
 * `finished` flips true on settle (success OR error/abort), so the
 * `!finished` predicate cleanly reads as "in flight."
 */
function attachMilestoneWatchers(
  milestones: NavigationMilestones,
  myFireId: number,
  setState: React.Dispatch<React.SetStateAction<InternalProgressState>>,
): void {
  const onSuccess = (key: "committed" | "streaming" | "finished") => () => {
    setState((s) => (s.fireId !== myFireId ? s : { ...s, [key]: true }))
  }
  const onRejection = (err: unknown) => {
    const navErr = classifyMilestoneError(err)
    setState((s) =>
      s.fireId !== myFireId ? s : { ...s, finished: true, error: s.error ?? navErr },
    )
  }
  milestones.committed.then(onSuccess("committed"), onRejection)
  milestones.streaming.then(onSuccess("streaming"), onRejection)
  milestones.finished.then(onSuccess("finished"), onRejection)
}

// ─── Preload (warm intent) ────────────────────────────────────────
//
// `useNavigation().preload(target)` states a route the user is about
// to visit — a WARM intent, advisory by nature. Two carriers, matched
// to the page's transport:
//
//   - Attached: a `warm` frame on the channel (`_channelWarm` — the
//     lossy class, newest-wins). The server's driver runs one
//     byte-silent whole-tree render of the target at its park point,
//     so the navigation statement that follows renders against warm
//     caches. Nothing reaches the client until the navigation itself.
//   - Degraded (document-nav mode): a Speculation Rules prefetch on
//     the document — the browser warms the target DOCUMENT's HTTP
//     cache entry, which is exactly what a degraded navigation loads.
//   - Pre-establishment: dropped. A preload must never trigger an
//     attach (the navigation itself will), and a stale hint is worth
//     less than none.

/** Targets already speculated on this document — one rule per URL. */
const _speculated = new Set<string>()

/** Append a `<script type="speculationrules">` prefetch rule for
 *  `url` — the degraded page's preload carrier. The browser dedupes
 *  and schedules; one rule per target keeps the head bounded. */
function speculateDocumentPrefetch(url: string): void {
  if (typeof document === "undefined" || _speculated.has(url)) return
  _speculated.add(url)
  const script = document.createElement("script")
  script.type = "speculationrules"
  script.textContent = JSON.stringify({
    prefetch: [{ source: "list", urls: [url] }],
  })
  document.head.appendChild(script)
}

function doPreload(target: NavigateTarget, frameName: string | null): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve()
  // Window-scoped only today: a frame handle's preload is a no-op.
  // A frame's content is session-scoped subtree state with no
  // standalone route to warm; preload is a best-effort hint, so an
  // unsupported scope degrades silently rather than throwing into an
  // event handler.
  if (frameName !== null) return Promise.resolve()
  let url: string
  try {
    url = resolveWindowTarget(target)
  } catch {
    return Promise.resolve()
  }
  const parsed = new URL(url, window.location.origin)
  if (parsed.origin !== window.location.origin) return Promise.resolve()
  // Warming the page you're on states nothing new.
  if (parsed.pathname + parsed.search === window.location.pathname + window.location.search) {
    return Promise.resolve()
  }
  if (_channelIsDegraded()) {
    speculateDocumentPrefetch(parsed.href)
    return Promise.resolve()
  }
  _channelWarm(parsed.pathname + parsed.search)
  return Promise.resolve()
}

/**
 * Wrap an imperative handle so its `reload` / `navigate` properties
 * are hooks returning the `[fire, progress]` tuple, and `preload` is a
 * plain imperative method. Every other property passes straight through
 * to the imperative handle (which itself is a Proxy over
 * `window.navigation` — see `buildWindowNavigationHandle`).
 *
 * The returned wrapper is itself a Proxy; `useNavigation()` memoizes
 * one of these per resolved frame path so effects with the handle in
 * their deps don't re-run on every navigation commit.
 */
function wrapWithHooks(imperative: ImperativeNavigation): FrameworkNavigation {
  return new Proxy(imperative, {
    get(target, prop, receiver) {
      if (prop === "reload") {
        // Named `useReload` (not `reload`): these Proxy methods ARE hooks —
        // they return the [fire, progress] tuple and are invoked as hooks
        // during render. The `use` name makes that contract legible to React
        // and the linter; the property key the caller sees stays `reload`.
        return function useReload(): ReloadStatus {
          return useReloadHook(target as ImperativeNavigation)
        }
      }
      if (prop === "navigate") {
        return function useNavigate(): NavigateStatus {
          return useNavigateHook(target as ImperativeNavigation)
        }
      }
      if (prop === "preload") {
        // `preload` is NOT a hook — it returns the imperative warm fn
        // directly, callable from an event handler. Scope (window vs
        // frame) comes off the underlying handle's `name`.
        const frameName = (target as ImperativeNavigation).name
        return function preload(navTarget: NavigateTarget): Promise<void> {
          return doPreload(navTarget, frameName)
        }
      }
      return Reflect.get(target, prop, receiver)
    },
  }) as unknown as FrameworkNavigation
}

/**
 * React hook returning a {@link FrameworkNavigation} handle.
 *
 *   useNavigation()                  // no name + inside <Partial frame=X> → X
 *   useNavigation()                  // no name + outside any frame → window
 *   useNavigation("cart")            // explicit absolute name → top-level cart frame
 *   useNavigation("products.list")   // nested frame via dotted path
 *
 * `name` is an ABSOLUTE dotted path from the page root, not a local
 * name relative to the enclosing frame. To get the ambient (innermost)
 * frame, omit the argument.
 *
 * The handle's live getters (`currentEntry`, `canGoBack`,
 * `canGoForward`) subscribe to `navigation` events, so they stay
 * reactive across any navigation on the page.
 *
 * `handle.reload()` and `handle.navigate()` are **hooks** — call
 * them during render to get back `[fire, progress]`. Calling the
 * fire fn from an event handler triggers the navigation:
 *
 *   const [navigate, { committed, finished }] = useNavigation().navigate()
 *   <Button
 *     onClick={() => navigate("/cart")}
 *     disabled={committed && !finished}
 *   />
 *
 * The fire returns `NavigationMilestones` synchronously, so callers
 * can also await individual milestones:
 *
 *   navigate("/cart").finished
 *
 * Always returns a handle — never throws.
 */
export function useNavigation(name?: string): FrameworkNavigation {
  const ambient = useContext(FrameNameContext)
  // Flight-borne page URL — the SSR / pre-hydration fallback for the
  // window scope, so `currentEntry.url` is correct on first paint
  // before `window.navigation` exists. Ignored once the live browser
  // handle is available.
  const ssrPageUrl = useContext(PageUrlContext)
  const ssrFrameUrls = useContext(FrameUrlContext)
  const resolvedPath: readonly string[] = name != null ? splitFramePath(name) : ambient
  // Stable key for memoization — names may be dotted, ambients may be
  // distinct arrays that encode the same path across renders.
  const resolvedKey = joinFramePath(resolvedPath)
  // Bump on any navigation so computed getters (`currentUrl`,
  // `canGoBack`, `entryState`) re-read after a commit. Runs for all
  // navigation types — framework-silent window navs and frame navs
  // alike — because both surface new client-side state that reactive
  // consumers (e.g. a header button reading `frameNav.currentUrl`)
  // need to pick up.
  const [, tick] = useState(0)
  useEffect(() => {
    const nav = getNavigation()
    if (!nav) return
    const bump = () => tick((n) => n + 1)
    nav.addEventListener("currententrychange", bump)
    nav.addEventListener("navigate", bump)
    return () => {
      nav.removeEventListener("currententrychange", bump)
      nav.removeEventListener("navigate", bump)
    }
  }, [])
  // Memoize both the imperative handle AND its hook wrapper so a
  // consumer effect that depends on the handle doesn't re-run on
  // every render. The wrapper's reload/navigate proxies still create
  // fresh hooks per render (that's the point), but the wrapper's
  // identity stays stable until the bound name changes.
  const imperative = useMemo(
    () => {
      if (resolvedPath.length === 0) return buildWindowNavigationHandle(ssrPageUrl)
      // Resolve the frame's SSR URL against the page origin so its
      // pathname matches the client (which absolutizes via
      // `projectEntryForFrame`), avoiding a hydration mismatch. An empty
      // frame URL → no SSR entry; the live handle fills it in.
      const frameUrl = ssrFrameUrls.get(resolvedKey)
      const ssrFrameUrl =
        frameUrl != null && frameUrl !== ""
          ? new URL(frameUrl, ssrPageUrl ?? "http://_").href
          : null
      return buildFrameHandle(resolvedPath, ssrFrameUrl)
    },
    // resolvedKey captures any change to the path — resolvedPath is a
    // fresh array each render, so we can't use it as a dep directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [resolvedKey, ssrPageUrl, ssrFrameUrls],
  )
  return useMemo(() => wrapWithHooks(imperative), [imperative])
}

// ─── Activators ───────────────────────────────────────────────────

/**
 * Activator building block. Subscribe a client-side trigger to a
 * Partial's activation refetch.
 *
 * Typical use inside an activator component:
 *
 *   useActivate(partialId, (fire) => {
 *     const obs = new IntersectionObserver(
 *       (e) => e.some(x => x.isIntersecting) && fire(),
 *       { rootMargin },
 *     );
 *     obs.observe(node);
 *     return () => obs.disconnect();
 *   });
 *
 * `fire()` triggers a targeted refetch of the Partial's effective id
 * — the framework-internal id-forcing protocol (`?__force=<id>` on a
 * channel statement; a framed activator refetches its frame). Calling
 * `fire` more than once is a no-op by default (one-shot activation).
 * Pass `{once: false}` if you need an activator that can fire repeatedly.
 *
 * `subscribe` is registered once per mount; `useEffectEvent` keeps the
 * latest `subscribe` + fire closure, so the subscription always calls the
 * freshest version without re-running. To genuinely re-subscribe on prop
 * changes, remount the activator by setting a `key` that changes with
 * those props.
 *
 * Note: activators are triggers. If the activated content needs
 * dynamic data, the activator writes that data to a scope the spec
 * reads via tracked hooks — the page URL via `useNavigation().navigate`, a
 * frame URL via `useNavigation("name").navigate`, or a cookie — so the
 * server re-resolves it on the refetch.
 */
/** Fire signature: an activation trigger. Request-dependent inputs
 *  reach the activated spec through tracked reads / `match` / cells, which
 *  re-resolve on the refetch. */
export type ActivatorFire = () => void

export function useActivate(
  partialId: string,
  subscribe: (fire: ActivatorFire) => (() => void) | void,
  opts?: { once?: boolean },
): void {
  const once = opts?.once ?? true
  const firedRef = useRef(false)
  // Activator fires happen in event-callback land — outside render — so the
  // imperative handle is the right shape. The ambient frame path comes from
  // context; the handle is resolved per-fire to pick up frame changes between
  // mount and trigger.
  const framePath = useContext(FrameNameContext)

  // useEffectEvent keeps the latest `subscribe` and fire behavior without
  // re-running the mount-scoped subscription — the modern replacement for
  // smuggling them through `ref.current = latest` during render.
  const onSubscribe = useEffectEvent((fire: ActivatorFire) => subscribe(fire))
  const fireReload = useEffectEvent(() => {
    if (once && firedRef.current) return
    firedRef.current = true
    // A framed activator refetches its frame (the frame statement's
    // whole-frame segment covers the target); a window-scoped one
    // forces the parton's effective id through the batched dispatcher
    // (one `?__force=` statement per microtask). Fire-and-forget —
    // errors surface through the channel layer.
    if (framePath.length > 0) {
      void _frame(framePath).reload()
    } else {
      enqueueRefetch({ ids: [partialId], streaming: false })
    }
  })

  useEffect(() => {
    const cleanup = onSubscribe(() => fireReload())
    return () => {
      if (typeof cleanup === "function") cleanup()
    }
  }, [])
}

// ─── Scroll restoration for non-window scroll containers ───────────────

interface ScrollPositionsState {
  __scrollPositions?: Record<string, number>
}

/**
 * Restore scroll position of a custom scroll container across browser
 * back / forward / refresh, persisted on the Navigation API entry
 * state. Browser-native scroll restoration only covers `window` —
 * nested scrollable elements (drawer bodies, modal contents, virtual
 * lists) need explicit save/restore.
 *
 * Returns a `RefObject` to attach to the scroll container. Restore
 * happens in a layout effect so the scroll position is in place before
 * the next paint — this matters for view transitions, where the
 * snapshot is captured pre-paint and would otherwise show the list
 * scrolled to the top during the slide-in.
 *
 * Save policy: a `scrollend` listener (with a debounced `scroll`
 * fallback for browsers without `scrollend`) writes the current
 * `scrollTop` onto the entry's state under `__scrollPositions[key]`.
 * A `navigate`-event handler also flushes the latest position before
 * the navigation commits, so a click that pushes a new entry doesn't
 * lose the in-flight scroll position.
 *
 *   const ref = useScrollRestore<HTMLDivElement>("drawer-2-list")
 *   <div ref={ref} className="overflow-y-auto h-full">…</div>
 *
 * `key` should be stable per logical scroll context. Different
 * containers on the same entry must use distinct keys.
 */
export function useScrollRestore<T extends HTMLElement = HTMLElement>(
  key: string,
): RefObject<T | null> {
  const ref = useRef<T | null>(null)

  // Restore synchronously after commit, before paint — so the
  // view-transition snapshot taken on the next frame already shows
  // the restored scroll.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const nav = getNavigation()
    if (!nav) return
    const state = nav.currentEntry?.getState() as ScrollPositionsState | null
    const saved = state?.__scrollPositions?.[key]
    if (typeof saved === "number") el.scrollTop = saved
  }, [key])

  // Persist scroll on the current entry. Two writers:
  //
  //  1. `scrollend` (or debounced `scroll` fallback) catches the user
  //     pausing — keeps the entry state warm for refresh.
  //  2. The `navigate` event fires before a commit. We capture the
  //     latest scrollTop synchronously so a click that pushes a new
  //     entry saves the position onto the entry we're leaving (not
  //     the new one).
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const nav = getNavigation()
    if (!nav) return

    const writePosition = () => {
      const current = (nav.currentEntry?.getState() as ScrollPositionsState | null) ?? {}
      const positions = { ...(current.__scrollPositions ?? {}) }
      const next = el.scrollTop
      if (positions[key] === next) return
      positions[key] = next
      try {
        nav.updateCurrentEntry({ state: { ...current, __scrollPositions: positions } })
      } catch {
        // updateCurrentEntry can throw on detached entries — ignore.
      }
    }

    // Prefer scrollend (Chrome 114+, Firefox 109+). Fall back to a
    // 120 ms debounced scroll handler for older engines.
    const supportsScrollend = "onscrollend" in el
    let scrollTimer: ReturnType<typeof setTimeout> | null = null
    const onScroll = () => {
      if (supportsScrollend) return
      if (scrollTimer) clearTimeout(scrollTimer)
      scrollTimer = setTimeout(writePosition, 120)
    }
    const onScrollend = () => writePosition()

    el.addEventListener("scroll", onScroll, { passive: true })
    if (supportsScrollend) {
      el.addEventListener("scrollend", onScrollend, { passive: true })
    }
    nav.addEventListener("navigate", writePosition)

    return () => {
      el.removeEventListener("scroll", onScroll)
      if (supportsScrollend) el.removeEventListener("scrollend", onScrollend)
      nav.removeEventListener("navigate", writePosition)
      if (scrollTimer) clearTimeout(scrollTimer)
    }
  }, [key])

  return ref
}
