/**
 * Navigation API types — framework refinements on top of `lib.dom.d.ts`.
 *
 * lib.dom.d.ts already ships: `Navigation`, `NavigationResult`,
 * `NavigationNavigateOptions`, `NavigationReloadOptions`,
 * `NavigationHistoryEntry`, `NavigationType`, `NavigateEvent`, etc.
 * This module adds the framework-specific layer: the targeted-refetch
 * options, the URL-updater callback form, the per-frame state shape,
 * and two views of the navigation handle:
 *
 *   - `FrameworkNavigation` — the public, React-hook-shaped handle
 *     `useNavigation()` returns. Its `navigate()` / `reload()` are
 *     **hooks** (call during render) that return a
 *     `[fire, progress]` tuple, where `progress` is a
 *     `{ committed, streaming, finished }` triple of booleans tracking
 *     the most recent fire. Errors bubble through
 *     `<NavigationErrorBubbler>` to the nearest React error boundary.
 *   - `ImperativeNavigation` — the internal handle returned by
 *     `_windowNav()` / `_frame()` for non-render call sites (class
 *     components, module-scope code, `useActivate` subscribers). Its
 *     `navigate(target, options)` / `reload(options)` are sync methods
 *     returning `NavigationMilestones` — a synchronous object of three
 *     promises (`committed`, `streaming`, `finished`) mirroring the
 *     browser's `NavigationResult` plus a framework-native `streaming`
 *     milestone for the first refetch segment.
 *
 * Access the browser's `navigation` global via `getNavigation()`.
 */

// ─── Framework state shapes ───────────────────────────────────────

/**
 * State shape the framework persists on each navigation entry.
 *
 *   __frames        — per-frame URL snapshot (for browser back/forward
 *                     diffing and cold-load rehydration)
 *   __frameHistory  — per-frame back/forward stack LOCAL TO THIS ENTRY.
 *                     `past[last]` is the most recent URL you'd return
 *                     to via `frame.back()`; `future[0]` is where
 *                     `frame.forward()` advances to. Kept per-entry so
 *                     browser-level navigation doesn't pollute frame
 *                     history and vice versa — see `docs/frames-navigation.md`
 *                     §"Two history axes".
 *   __frameState    — per-frame user-provided state bag (namespaced so
 *                     multiple frames on one entry can't collide)
 *
 * User state from `useNavigation().navigate()[0](url, { state })` merges
 * onto the top level alongside these framework fields.
 */
export interface FrameEntryState {
  readonly __frames?: Record<string, { url: string }>
  readonly __frameHistory?: Record<string, { past: string[]; future: string[] }>
  readonly __frameState?: Record<string, Record<string, unknown>>
  readonly [userKey: string]: unknown
}

/**
 * Framework-scoped history entry — the standard
 * `NavigationHistoryEntry` with a narrower `getState()` return type.
 * Lets consumers read frame snapshots without `as` casts.
 */
export interface FrameNavigationHistoryEntry extends Omit<NavigationHistoryEntry, "getState"> {
  getState(): FrameEntryState | null
}

// ─── Framework navigate/reload extensions ─────────────────────────

/**
 * Input accepted by the navigate fire function.
 *
 *   navigate("/products")                       // string
 *   navigate(new URL(...))                      // URL instance
 *   navigate(url => { url.searchParams.set("q", q); return url })  // updater
 *
 * The updater receives an absolute `URL` — `new URL(window.location.href)`
 * for the window handle, or the frame URL synthesized against
 * `window.location.origin` for a frame handle. Mutate in place and
 * return the same instance, construct a new one, or return a string
 * (resolved against the same base). Returning a cross-origin URL
 * from a frame handle throws; from the window handle it goes through
 * the browser's normal cross-origin navigation behavior.
 */
export type NavigateTarget = string | URL | ((current: URL) => URL | string)

/**
 * Superset of the browser's `NavigationNavigateOptions` with the
 * framework's targeted-refetch + commit knobs.
 *
 * ── `history` default differs between handles ─────────────────────
 * `"auto"` (the inherited default when `history` is omitted) resolves
 * differently for the window handle vs. a frame handle:
 *
 *   - Window handle: browser default (push for a URL change, replace
 *     when pathname+search are identical). Unchanged.
 *   - Frame handle: patch the current window entry via
 *     `updateCurrentEntry` (no new browser entry) and push onto the
 *     frame's per-entry `__frameHistory[name].past` array. Browser
 *     back/forward stays attached to real page navigations; frame
 *     back/forward lives on its own axis via `frame.back()`.
 *
 * Explicit `"push"` / `"replace"` on either handle use the browser's
 * `nav.navigate()` path — for a frame, this means a new/replaced
 * browser entry AND a push on the per-frame stack. See the decision
 * matrix in `docs/frames-navigation.md` §"Two history axes".
 */
export interface FrameworkNavigateOptions extends NavigationNavigateOptions {
  /**
   * Render mode for the response commit.
   *
   * Default (`false`): atomic swap. The client wraps the response
   * commit in `startTransition`, so React keeps the current UI visible
   * until the new content is fully ready. No Suspense fallback flash,
   * no per-chunk streaming — the whole refetch appears as one swap.
   * Good for "just swap values" UX (cart badge, prices).
   *
   * `true`: progressive reveal. Commit without a transition. React
   * shows Suspense fallbacks for pending children and commits Flight
   * chunks as they arrive, giving per-row streaming. Good for search /
   * filter results where per-row reveal improves perceived latency.
   *
   * Not to be confused with the `streaming` boolean in the fire's
   * progress / milestone — that one is a milestone marker (first
   * segment has arrived), this is a behavior switch.
   */
  streaming?: boolean
  /**
   * CSS-style selector naming the Partials to refetch. Space-separated
   * (or array) list of tokens; each token starts with `#` (unique) or
   * `.` (shared). Union semantics across all tokens:
   *
   *   selector: "#cart"            — just #cart
   *   selector: ".price"           — every Partial with .price
   *   selector: "#cart .price"     — #cart AND every .price
   *   selector: ["#cart", ".price"] — array form, same meaning
   *
   * When set alongside a navigate, the URL is updated but only the
   * matching Partials are re-rendered — the page-level intercept is
   * skipped. Ignored on frame handles (frame navigation always
   * refetches the whole frame subtree).
   */
  selector?: string | string[]
  /**
   * Update the URL without triggering ANY refetch. Useful for
   * bookmarkability-only URL sync (infinite scroll's `?pages=`) where
   * no server work needs to happen. If `selector` is also set,
   * `silent` wins and the refetch is skipped. Ignored on frame
   * handles (frame navigation always refetches the frame).
   */
  silent?: boolean
  /**
   * Cookies to write client-side BEFORE the refetch fetch is issued.
   * Each key is set via `document.cookie = "name=value; path=/; …"`,
   * so the new value travels with the upcoming request and any
   * subsequent navigation. Use this for sticky preferences (theme,
   * editor on/off) where the cookie is the source of truth and a
   * server action would just round-trip the same string.
   *
   * Pass an empty string to delete a cookie (max-age=0). Defaults
   * applied per cookie: `path=/`, `samesite=lax`, `max-age=31536000`
   * (one year) — pass a `; max-age=0` suffix in the value to override.
   *
   * `cookies` lives on `navigate` only — not on `reload`. With
   * `history: "auto"` (the default), `navigate(currentUrl, {cookies})`
   * resolves to `replace` because the URL is unchanged, so it's the
   * canonical "refetch with new cookies" call; `navigate(newUrl,
   * {cookies})` resolves to `push` and carries the cookie into the
   * navigation. Frame handles also write to `document.cookie` (a
   * global write — there's no per-frame cookie scoping today).
   */
  cookies?: Record<string, string>
}

/**
 * Superset of the browser's `NavigationReloadOptions` with the
 * framework's targeted-refetch knobs. `reload({ selector: "#cart" })`
 * refetches a single Partial; `reload({ selector: ".price" })` refetches
 * every Partial carrying the `.price` label.
 *
 * No `cookies` here — cookie writes live on `navigate` only (see
 * `FrameworkNavigateOptions.cookies`). To refetch with new cookies,
 * call `navigate(currentUrl, {cookies, selector?})`; with
 * `history: "auto"` the URL-unchanged case resolves to a replace,
 * which is functionally the same refetch as `reload()` plus the
 * cookie write.
 */
export interface FrameworkReloadOptions extends NavigationReloadOptions {
  selector?: string | string[]
  /** See `FrameworkNavigateOptions.streaming`. */
  streaming?: boolean
  /** Caller-supplied abort signal. Aborting before the reload
   *  completes cancels the in-flight fetch on the client and the
   *  long-poll stream on the server. Components that fire a
   *  `streaming: true` reload from a `useEffect` should pass a
   *  signal whose controller aborts in the effect's cleanup —
   *  otherwise navigating away leaves the server-side segment
   *  driver running until its next render finishes without
   *  `markConnectionLive`. */
  signal?: AbortSignal
}

// ─── Fire functions + progress tuple ──────────────────────────────

/**
 * Three-promise object returned synchronously by the fire fn, mirroring
 * the browser's `NavigationResult` plus a framework-native `streaming`
 * milestone for the first refetch segment.
 *
 *   - `committed` — resolves when the browser entry has been created
 *     (history change committed). For frame nav in `history: "auto"`
 *     mode there's no new entry; this resolves immediately after the
 *     in-place state patch.
 *   - `streaming` — resolves when the first response segment has been
 *     decoded and committed to React (i.e. the new tree has begun
 *     rendering). For full-page nav this resolves at the same time as
 *     `finished` (the page-level intercept doesn't expose a per-segment
 *     hook today).
 *   - `finished` — resolves when the entire response body has drained
 *     and every segment has been committed. Equivalent to the prior
 *     `await navigate()` semantics.
 *
 * All three reject with `NavigationError` (network / http / decode) or
 * `AbortError` (newer navigation superseded the in-flight fetch).
 * Rejections after a milestone resolved are lost — the milestone
 * already happened.
 */
export interface NavigationMilestones {
  committed: Promise<NavigationHistoryEntry>
  streaming: Promise<void>
  finished: Promise<NavigationHistoryEntry>
}

/** Reload fire function — returned in the first slot of the tuple. */
export type Reload = (
  options?: FrameworkReloadOptions,
) => NavigationMilestones

/** Navigate fire function — returned in the first slot of the tuple. */
export type Navigate = (
  target: NavigateTarget,
  options?: FrameworkNavigateOptions,
) => NavigationMilestones

/**
 * Renderable progress for the most recent fire. Each boolean is a
 * "milestone has passed" marker, monotonic within a single fire and
 * reset to `false` when the next fire starts.
 *
 *   t0  fire called          { committed: false, streaming: false, finished: false }
 *   t1  entry created        { committed: true,  streaming: false, finished: false }
 *   t2  first segment in     { committed: true,  streaming: true,  finished: false }
 *   t3  body drained         { committed: true,  streaming: true,  finished: true  }
 *
 * Aborted or errored fires flip `finished: true` without `streaming`
 * or `committed` necessarily ever becoming true — the lifecycle ended,
 * but the work didn't complete. Errors are also published to the
 * nearest React error boundary via the bundled
 * `<NavigationErrorBubbler>`; the progress booleans themselves carry
 * no error signal.
 *
 * Initial state (before any fire) is all `false` — observationally
 * identical to "fire just called, no milestone yet." Consumers that
 * need to distinguish idle from in-flight should track their own
 * has-fired flag from the click handler.
 */
export interface NavigationProgress {
  committed: boolean
  streaming: boolean
  finished: boolean
}

/**
 * Tuple returned by `useNavigation().reload()` (and the equivalent
 * `.navigate()` shape with `Navigate` in the first slot).
 *
 *   const [reload, { committed, streaming, finished }] = useNavigation().reload()
 *
 * Common spinner predicates:
 *
 *   committed && !finished   "in flight, post-commit"
 *   committed && !streaming  "asked, no rows yet"
 *   streaming && !finished   "rows arriving"
 */
export type ReloadStatus = readonly [Reload, NavigationProgress]
export type NavigateStatus = readonly [Navigate, NavigationProgress]

// ─── FrameworkNavigation (public, React-hook-shaped) ──────────────

/**
 * Typed view of the `Navigation` global with the framework's
 * extensions — what `useNavigation()` returns.
 *
 *   - `currentEntry` / `entries()` return `FrameNavigationHistoryEntry`
 *     so callers can read `__frames` / user state without casts.
 *   - `name` identifies the handle's scope (`null` for the window
 *     handle, the frame name for a frame handle). Framework-only —
 *     not on the browser `Navigation` interface.
 *   - `navigate()` is a **React hook** (call during render). Returns
 *     `[navigate, progress]`. The `navigate` fn accepts a string /
 *     URL / URL-updater and the same options bag as the imperative
 *     form (selector, silent, streaming, …). `progress` is a
 *     `NavigationProgress` triple of booleans tracking the most
 *     recent fire.
 *   - `reload()` is the same shape: `[reload, progress]`.
 *     `reload()` with no args reloads the whole page; with
 *     `{ selector }` it's a targeted refetch.
 *
 * The handle returned by `useNavigation()` is memoized — calling
 * `.reload()` / `.navigate()` repeatedly across renders runs the
 * inner hooks consistently. Each call site is one hook invocation;
 * multiple buttons in the same component each need their own
 * `.reload()` call.
 */
export interface FrameworkNavigation extends Omit<
  Navigation,
  "currentEntry" | "entries" | "navigate" | "reload"
> {
  readonly currentEntry: FrameNavigationHistoryEntry | null
  entries(): FrameNavigationHistoryEntry[]
  /**
   * Frame name this handle is bound to, or `null` for the
   * window-scoped handle. Framework-only — not on `Navigation`.
   */
  readonly name: string | null
  navigate(): NavigateStatus
  reload(): ReloadStatus
  /**
   * Warm a destination's partials into the client cache without
   * navigating — the forward-looking counterpart to keepalive
   * (keepalive parks what you left; preload parks what you're about to
   * reach). Unlike `navigate` / `reload`, `preload` is a plain
   * imperative method, not a hook: call it from an event handler —
   * typically pointer-enter on a link. It fetches `target` as a
   * read-only render and walks the response into the client cache; it
   * does NOT commit (no visible swap, no URL / history change, nothing
   * mounts, no effects run). A later navigation to `target` then
   * fp-skips the warmed partials and substitutes them from cache on the
   * first commit while the fresh render revalidates — the
   * always-revalidate-on-click path is unchanged, it just starts warm.
   *
   * At most one preload is in flight per page: a newer `preload()`
   * aborts the prior one, so sweeping the pointer across a nav bar
   * doesn't pile up live fetches. Window-scoped only today — a frame
   * handle's `preload` is a no-op. Returns a promise that settles when
   * warming finishes; failures are swallowed (preload is a hint), so
   * callers fire-and-forget.
   */
  preload(target: NavigateTarget): Promise<void>
}

// ─── ImperativeNavigation (internal, non-React call sites) ────────

/**
 * Plain-function navigation handle for framework-internal code that
 * runs outside React render — class component methods, module
 * initialization, callbacks subscribed via `useActivate`. Returned
 * by `_windowNav()` and `_frame()`.
 *
 * `navigate(target, options)` / `reload(options)` return
 * `NavigationMilestones` synchronously — three promises (`committed`,
 * `streaming`, `finished`) tracking the navigation lifecycle. Each
 * rejects with `NavigationError` on failure or `AbortError` on
 * supersede (per-selector in-flight queue aborts predecessors when a
 * newer fire's `streaming` lands).
 *
 * App code should always reach navigation through `useNavigation()`.
 * This shape is `@internal` and not re-exported through the public
 * barrel.
 */
export interface ImperativeNavigation extends Omit<
  Navigation,
  "currentEntry" | "entries" | "navigate" | "reload"
> {
  readonly currentEntry: FrameNavigationHistoryEntry | null
  entries(): FrameNavigationHistoryEntry[]
  readonly name: string | null
  navigate(
    target: NavigateTarget,
    options?: FrameworkNavigateOptions,
  ): NavigationMilestones
  reload(options?: FrameworkReloadOptions): NavigationMilestones
}

/**
 * Typed accessor for the browser's `navigation` global. Returns
 * `null` during SSR module evaluation or in test runtimes that
 * haven't shimmed the Navigation API.
 *
 *   const nav = getNavigation();
 *   if (!nav) return;
 *   nav.navigate("/foo", { info: { reason: "prefetch" } });
 */
export function getNavigation(): Navigation | null {
  const nav = (globalThis as { navigation?: Navigation }).navigation
  return nav ?? null
}
