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
  type FrameNavigationHistoryEntry,
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
import { enqueueRefetch } from "./refetch-dispatch.ts"
import {
  deferred,
  FrameNameContext,
  FrameUrlContext,
  joinFramePath,
  makeMilestoneDeferreds,
  milestonesOf,
  type MilestoneDeferreds,
  type NavExecutor,
  _navExecutor,
  nullImperativeNavigation,
  projectEntryForFrame,
  _readFrameNode,
  rejectMilestones,
  splitFramePath,
} from "./frame-context.tsx"

// ─── Late-loaded executor bridge ──────────────────────────────────
//
// The navigate/reload/preload/back/forward EXECUTORS touch the channel
// transport, so they live in the late-loaded `frame-client.tsx`, which
// binds its surface into `frame-context`'s `_navExecutor` seam on load.
// The eager handles below build getters that read `window.navigation` /
// the frames tree at render, and dispatch a FIRE through the bound
// executor.
//
// The dispatch is SYNCHRONOUS whenever the executor has bound — the
// normal case, since the live layer loads `frame-client` once
// post-commit, before any user interaction. Synchronicity matters: a
// `nav.reload()` / `nav.navigate()` deferred a task lands outside the
// caller's gesture and races the browser navigation it triggers (a
// deferred reload double-fires). Only a fire made BEFORE the executor
// bound (pre-live-boot — rare) takes the async-import fallback, which
// returns milestone deferreds synchronously and pipes the real
// milestones once the import resolves; a load failure rejects them (the
// page stays functional, document navigations, never a broken paint).

let _frameClientPromise: Promise<typeof import("./frame-client.tsx")> | null = null
function loadFrameClient(): Promise<typeof import("./frame-client.tsx")> {
  return (_frameClientPromise ??= import("./frame-client.tsx"))
}

/** Pipe a real handle's milestones (produced by the late-loaded
 *  executor) into the eager deferreds the fire already returned. */
function pipeMilestones(real: NavigationMilestones, m: MilestoneDeferreds): void {
  real.committed.then(
    (e) => m.committed.resolve(e),
    (err) => m.committed.reject(err),
  )
  real.streaming.then(
    () => m.streaming.resolve(),
    (err) => m.streaming.reject(err),
  )
  real.finished.then(
    (e) => m.finished.resolve(e),
    (err) => m.finished.reject(err),
  )
}

/** Run a milestone-returning executor fire: synchronously through the
 *  bound executor when present, else async through the import (deferred,
 *  piped). */
function dispatchMilestones(
  run: (exec: NavExecutor) => NavigationMilestones,
): NavigationMilestones {
  const exec = _navExecutor()
  if (exec !== null) return run(exec)
  const m = makeMilestoneDeferreds()
  loadFrameClient()
    .then((mod) => pipeMilestones(run(mod), m))
    .catch((err) => rejectMilestones(m, err))
  return milestonesOf(m)
}

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

// ─── Eager imperative handles ─────────────────────────────────────
//
// `useNavigation()` builds one of these during render. The getters
// (`name`, `currentEntry`, `canGoBack`, `entries`, the passthroughs to
// `window.navigation`) are EAGER — pure reads of the browser Navigation
// API and the frames tree. The fires (`navigate` / `reload` / `back` /
// `forward` / `updateCurrentEntry`) DISPATCH into the late-loaded
// executor: they return their milestone deferreds synchronously and
// pipe the real handle's milestones in once `frame-client.tsx` has
// loaded (imported once post-commit by the browser bootstrap — resolved
// from the module cache by fire time in the steady state).

/**
 * Window-scoped eager handle — a Proxy over `window.navigation` with
 * `name: null`, whose `navigate` / `reload` dispatch into the executor.
 * Everything else passes straight through to the browser.
 */
function buildEagerWindowHandle(ssrUrl?: string | null): ImperativeNavigation {
  const nav = getNavigation()
  // No browser Navigation API → SSR or pre-hydration. Fall back to the
  // Flight-borne page URL so `currentEntry.url` is correct on first
  // paint; the live handle takes over once `window.navigation` exists.
  if (!nav) return nullImperativeNavigation(null, ssrUrl ?? null)

  const navigate = (
    target: NavigateTarget,
    options?: FrameworkNavigateOptions,
  ): NavigationMilestones =>
    dispatchMilestones((exec) => exec.buildWindowNavigationHandle().navigate(target, options))

  const reload = (options?: FrameworkReloadOptions): NavigationMilestones =>
    dispatchMilestones((exec) => exec.buildWindowNavigationHandle().reload(options))

  return new Proxy(nav, {
    get(_target, prop, _receiver) {
      if (prop === "name") return null
      if (prop === "navigate") return navigate
      if (prop === "reload") return reload
      // Native Navigation getters (currentEntry, canGoBack,
      // canGoForward, transition, activation) throw "Illegal
      // invocation" when invoked with a non-Navigation `this`, so we
      // bypass the Proxy receiver and read directly off
      // `window.navigation`.
      const value = (nav as unknown as Record<string | symbol, unknown>)[prop]
      return typeof value === "function" ? value.bind(nav) : value
    },
  }) as unknown as ImperativeNavigation
}

/**
 * Frame-scoped eager handle — a Proxy over `window.navigation` with
 * frame-scoped getters (URL projection, `canGoBack`/`canGoForward` off
 * the in-state history stack) computed eagerly, and fires dispatched
 * into the executor.
 */
function buildEagerFrameHandle(
  path: readonly string[],
  ssrUrl?: string | null,
): ImperativeNavigation {
  const nav = getNavigation()
  const key = joinFramePath(path)
  // No browser Navigation API → SSR / pre-hydration. Resolve
  // `currentEntry.url` from the Flight-borne frame URL so a framed
  // `useNavigation()` is correct on first paint.
  if (!nav) return nullImperativeNavigation(key, ssrUrl ?? null)
  if (path.length === 0) {
    throw new Error("buildEagerFrameHandle: path must be non-empty")
  }

  const navigate = (
    target: NavigateTarget,
    options?: FrameworkNavigateOptions,
  ): NavigationMilestones =>
    dispatchMilestones((exec) => exec.buildFrameHandle(path).navigate(target, options))

  const reload = (options?: FrameworkReloadOptions): NavigationMilestones =>
    dispatchMilestones((exec) => exec.buildFrameHandle(path).reload(options))

  const traverse = (direction: "back" | "forward"): NavigationResult => {
    const run = (exec: NavExecutor): NavigationResult => {
      const handle = exec.buildFrameHandle(path)
      return direction === "back" ? handle.back() : handle.forward()
    }
    const exec = _navExecutor()
    if (exec !== null) return run(exec)
    const committed = deferred<NavigationHistoryEntry>()
    const finished = deferred<NavigationHistoryEntry>()
    committed.promise.catch(() => {})
    finished.promise.catch(() => {})
    loadFrameClient()
      .then((mod) => {
        const real = run(mod)
        real.committed?.then(
          (e) => committed.resolve(e as NavigationHistoryEntry),
          (err) => committed.reject(err),
        )
        real.finished?.then(
          (e) => finished.resolve(e as NavigationHistoryEntry),
          (err) => finished.reject(err),
        )
      })
      .catch((err) => {
        committed.reject(err)
        finished.reject(err)
      })
    return { committed: committed.promise, finished: finished.promise }
  }

  const updateCurrentEntry = (options: NavigationUpdateCurrentEntryOptions): void => {
    const exec = _navExecutor()
    if (exec !== null) {
      exec.buildFrameHandle(path).updateCurrentEntry(options)
      return
    }
    void loadFrameClient().then((mod) => mod.buildFrameHandle(path).updateCurrentEntry(options))
  }

  return new Proxy(nav, {
    get(target, prop) {
      if (prop === "name") return key
      if (prop === "navigate") return navigate
      if (prop === "reload") return reload
      if (prop === "back") return () => traverse("back")
      if (prop === "forward") return () => traverse("forward")
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
      if (prop === "updateCurrentEntry") return updateCurrentEntry
      // See window-handle Proxy — native Navigation getters throw
      // "Illegal invocation" when reached via the Proxy receiver, so we
      // read directly off `target` (window.navigation).
      const value = (target as unknown as Record<string | symbol, unknown>)[prop]
      return typeof value === "function" ? value.bind(target) : value
    },
  }) as unknown as ImperativeNavigation
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
          // The warm executor lives in the late-loaded layer — dispatch
          // synchronously once it has bound (the normal case), else async
          // through the import.
          const exec = _navExecutor()
          if (exec !== null) return exec.executePreload(navTarget, frameName)
          return loadFrameClient().then((mod) => mod.executePreload(navTarget, frameName))
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
      if (resolvedPath.length === 0) return buildEagerWindowHandle(ssrPageUrl)
      // Resolve the frame's SSR URL against the page origin so its
      // pathname matches the client (which absolutizes via
      // `projectEntryForFrame`), avoiding a hydration mismatch. An empty
      // frame URL → no SSR entry; the live handle fills it in.
      const frameUrl = ssrFrameUrls.get(resolvedKey)
      const ssrFrameUrl =
        frameUrl != null && frameUrl !== ""
          ? new URL(frameUrl, ssrPageUrl ?? "http://_").href
          : null
      return buildEagerFrameHandle(resolvedPath, ssrFrameUrl)
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
    // (one `?__force=` statement per microtask). Both reach the channel
    // through the late-loaded live layer — dispatch on fire (an
    // event-time trigger, well after hydration). Fire-and-forget —
    // errors surface through the channel layer.
    if (framePath.length > 0) {
      const exec = _navExecutor()
      if (exec !== null) void exec._frame(framePath).reload()
      else void loadFrameClient().then((m) => m._frame(framePath).reload())
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
