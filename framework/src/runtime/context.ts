/**
 * Request context for server components and server actions.
 *
 * Minimal ALS surface — just the incoming Request and the outgoing
 * Set-Cookie accumulator. No tracked accessors; no per-Partial
 * manifest, frame-scope, or CMS-scope cells. Specs declare their
 * dependencies via tracked reads (see `../lib/server-hooks.ts`); the
 * request rides the parton self-context, so hooks read it directly
 * for dependency tracking.
 */

import { AsyncLocalStorage } from "node:async_hooks"

interface FrameworkControl {
  notFound?: boolean
  redirect?: { url: string; status: number }
}

interface RequestStore {
  request: Request
  cookies: string[]
  /** Per-request scope token. Production: `"default"`. Dev: honour
   *  `x-test-scope` header (Playwright workers stamp a per-worker
   *  value so process-wide state buckets don't collide). */
  scope: string
  /** Connection-scoped ephemeral cell storage. Backs `gqlCell` +
   *  `fragmentCell` reads / writes for the lifetime of this ALS
   *  request context. In the framework, that context spans ONE HTTP
   *  connection — including all segments emitted by a streaming
   *  heartbeat's segment driver, because the driver loops inside the
   *  same `runWithRequestAsync` scope. Short POSTs and cold GETs each
   *  get their own short-lived storage; long heartbeats hold their
   *  storage for the connection's lifetime.
   *
   *  Lazily initialized — `null` until the first ephemeral-cell
   *  access opens it, so requests that never touch a gqlCell or
   *  fragmentCell pay nothing.
   *
   *  Strict isolation: no leakage between connections (different
   *  tabs, different users). Cross-connection caching (when we
   *  eventually want it) is a separate layer added on top. */
  ephemeralCellStorage?: import("./cell-storage.ts").CellStorage | null
  control?: FrameworkControl
  /** Hook the partial-registry layer registers when it opens its
   *  per-request context. Auto-fires on `runWithRequestAsync` exit
   *  unless `deferRegistryCommit` was set. */
  commitRegistry?: () => void
  deferRegistryCommit?: boolean
  /** Set by a server component during render (typically a Suspense
   *  sentinel that awaits a producer event — e.g. the chat's
   *  `ChunkSlot`) to signal that the segment driver should keep the
   *  response open after this segment closes and emit another
   *  segment when state changes. Without this — and without the
   *  client's `?streaming=1` URL opt-in — the driver closes after
   *  the first segment. */
  connectionLive?: boolean
  /** Sink the fp-trailer wrap registers for settle-time trailer
   *  emission: called with a parton id when that parton's subtree
   *  settles, so the wrap can emit the id's warm-fp entry mid-stream
   *  instead of waiting for the whole render. One sink per response
   *  stream — set by `wrapStreamWithFpTrailer`'s start, cleared at its
   *  flush. Lane renders never set one (a lane IS a single parton;
   *  its flush already fires at that parton's completion). */
  settleTrailerSink?: ((partonId: string) => void) | null
  /** Queued URL push from `getServerNavigation(scope).navigate(...)`.
   *  Consumed (and cleared) at trailer-flush time, emitted as a
   *  `url`-tagged trailer entry so the client can apply it to the
   *  browser URL / frame URL store. Multiple navigate calls within a
   *  segment merge into one update; the LAST `history` wins. */
  pendingUrlUpdate?: UrlUpdateEntry
  /** Carry the `?cached=…` parsed maps in-memory across segments of a
   *  single request so the driver doesn't have to rebuild the request
   *  URL between segments. Cold first segment: PartialRoot parses
   *  ?cached= and stores the parsed Maps here. Subsequent segments:
   *  the driver appends newly-emitted (id, matchKey, fp) tuples to the
   *  same Maps; PartialRoot's next render reads from these Maps
   *  directly instead of re-parsing the URL. Without this carrier, the
   *  driver was doing `new URL(...)` + `searchParams.set` +
   *  `url.toString()` + `new Request(...)` per segment — ~7% of CPU in
   *  the streaming case. */
  cachedOverride?: CachedOverride
  /** The ids being FORCE-refetched on the current render — a selector
   *  nav's `__force` targets, resolved to ids. The descendant fold
   *  excludes these (and their subtrees) so an ancestor can fp-skip
   *  while the forced target re-lanes independently (parent-valid,
   *  child-invalid). Set by the segment driver around a navigation's
   *  whole-tree segment render; absent on every other render (a full
   *  fold). */
  foldExclusionIds?: ReadonlySet<string> | null
  /** Per-request cell-write accounting for the deferred-commit
   *  decision. `total` counts every successful cell write made during
   *  this request; `deferred` counts those whose cell declared
   *  `deferred: true`. When an action's writes are ALL deferred
   *  (`total > 0 && total === deferred`) its response omits the
   *  re-render and the open streaming connection propagates the change.
   *  Lazily created on the first write. */
  cellWrites?: { total: number; deferred: number }
  /** The live connection's session state — opened by the segment
   *  driver for a `?live=1` request (under its server-minted id) and
   *  carried on the ALS store for the connection's lifetime (the
   *  driver loops inside one `runWithRequestAsync` scope). What the
   *  cull gate and the fingerprint fold's store-and-reread consult
   *  FIRST for the connection's current visible set; channel
   *  envelopes' `visible` frames update it between wakes (see
   *  `../lib/connection-session.ts`). One-shot requests never set it
   *  and fall back to the `?visible=` URL param. */
  connectionSession?: ConnectionSessionHandle | null
  /** The attach request's decoded body statement — the client's URL
   *  statement (`url`), full manifest (`cached`), catch-up anchor
   *  (`since`), viewport seed (`visible`), and pre-establishment frame
   *  intent (`frames`), stashed by the entry (or the live-drive
   *  harness) before any render runs and constant for the request's
   *  lifetime. Its presence IS the live-subscription signal: the
   *  segment driver opens a connection session iff a statement is
   *  bound. Absent on every other request (actions, SSR documents). */
  attachStatement?: AttachStatementHandle | null
}

/** The slice of a connection session the request context carries —
 *  structural, so this module doesn't import the lib-side registry
 *  (`../lib/connection-session.ts` owns the full session shape). */
export interface ConnectionSessionHandle {
  visible: ReadonlySet<string> | null
  /** The mirror's ACKED layer — fps whose delivering emission the
   *  client has COMMITTED (cumulative delivery acks). A live map
   *  reference: entries appear as acks land, for the connection's
   *  whole lifetime. The fp-skip verdict consults it on an
   *  optimistic-layer miss (see `PartialRequestState.ackedFingerprints`). */
  ackedFps: ReadonlyMap<string, ReadonlySet<string>>
}

/** The attach statement as the request context carries it — structural
 *  for the same reason as `ConnectionSessionHandle`: the wire grammar
 *  (and its decoder) lives in `../lib/channel-protocol.ts`. */
export interface AttachStatementHandle {
  readonly url: string
  readonly cached: readonly string[]
  readonly since: { readonly epoch: string; readonly ts: number } | null
  readonly visible: readonly string[] | null
  readonly applied?: number
  readonly frames?: ReadonlyArray<{
    readonly url: string
    readonly frame?: readonly string[]
  }>
}

/** In-memory mirror of the client manifest. Same identity Maps shared
 *  across the first render's parse and every subsequent emission's
 *  mutate-and-read cycle. The driver mutates these directly between
 *  emissions; PartialRoot reads via identity so its
 *  `state.cachedFingerprints` IS the carrier.
 *
 *  `slots` is the truthfulness bookkeeping behind `fingerprints`: the
 *  client keeps ONE content per `(id, matchKey)` slot (`cacheStore`
 *  overwrites evict the slot's prior fps), so the mirror keys its fps
 *  the same way — a fresh fp promoted for a slot EVICTS that slot's
 *  other fps from both maps. Without the slot rule, an A→B→A content
 *  cycle would fp-skip against a slot the client overwrote at B,
 *  confirming phantom content (a blank parton). An fp folds its
 *  matchKey, so each fp belongs to exactly one slot and flat-set
 *  surgery is exact. */
export interface CachedOverride {
  fingerprints: Map<string, Set<string>>
  matchKeys: Map<string, Set<string>>
  slots: Map<string, Map<string, Set<string>>>
}

/** Wire shape for the `url`-tagged trailer entry. Client applies
 *  window-scoped URL via the Navigation API; frame URLs land in the
 *  frame URL store. */
export interface UrlUpdateEntry {
  window?: string
  frames?: Record<string, string>
  history?: "push" | "replace"
}

const requestContext = new AsyncLocalStorage<RequestStore>()

const DEFAULT_SCOPE = "default"

function deriveScope(request: Request): string {
  if (import.meta.env?.DEV) {
    const h = request.headers.get("x-test-scope")
    if (h) return h
  }
  return DEFAULT_SCOPE
}

export function isTestMode(): boolean {
  return getStore().scope !== DEFAULT_SCOPE
}

// ─── Deferred-task scope capture ────────────────────────────────────────

/** Per-scope dedup keys for currently-scheduled tasks. The key shape
 *  is `<scope>:<dedupKey>`; the scope comes from the request the
 *  task was scheduled in, the dedupKey is caller-supplied. */
const _scheduledTaskKeys = new Set<string>()

/**
 * Schedule `fn` to run after `delayMs`, with the active request's
 * full ALS context (request, scope, cookie accumulator, framework
 * control flags) re-entered inside the callback. Background producers
 * (a setInterval-style tick, a debounced cell write) can call
 * `getScope()` / `getRequest()` / `cell.set` / `cell.peek` from the
 * deferred callback as if they were still inside the originating
 * request — without userspace having to thread scope through their
 * own closures.
 *
 * Per-scope dedup: at most one task per `(scope, dedupKey)` is
 * outstanding. A second call with the same dedupKey while the first
 * is still scheduled is a no-op. The dedup flag clears just before
 * `fn` runs, so the callback can re-schedule itself for a chained
 * timer pattern.
 *
 * Caller must be inside a request context (schema callback, render
 * body, action body). Throws otherwise.
 */
export function scheduleInScope(
  fn: () => void | Promise<void>,
  delayMs: number,
  dedupKey: string,
): void {
  const captured = requestContext.getStore()
  if (!captured) {
    throw new Error(
      "scheduleInScope: must be called inside a request context (schema / render / action body)",
    )
  }
  const key = `${captured.scope}:${dedupKey}`
  if (_scheduledTaskKeys.has(key)) return
  _scheduledTaskKeys.add(key)
  setTimeout(() => {
    _scheduledTaskKeys.delete(key)
    requestContext.run(captured, () => {
      void fn()
    })
  }, delayMs)
}

/** Test-only — abort outstanding scheduled tasks. The setTimeouts
 *  still fire (we don't track their ids) but the dedup flags clear
 *  so subsequent schedules go through. */
export function _clearScheduledTasks(scope?: string | "all"): void {
  if (scope === undefined || scope === "all") {
    _scheduledTaskKeys.clear()
    return
  }
  for (const key of [..._scheduledTaskKeys]) {
    if (key.startsWith(`${scope}:`)) _scheduledTaskKeys.delete(key)
  }
}

export function runWithRequest<T>(request: Request, fn: () => T): { result: T; cookies: string[] } {
  const store: RequestStore = { request, cookies: [], scope: deriveScope(request) }
  const result = requestContext.run(store, fn)
  return { result, cookies: store.cookies }
}

export async function runWithRequestAsync<T>(
  request: Request,
  fn: () => Promise<T>,
): Promise<{ result: T; cookies: string[] }> {
  const store: RequestStore = { request, cookies: [], scope: deriveScope(request) }
  const result = await requestContext.run(store, fn)
  if (store.commitRegistry && !store.deferRegistryCommit) {
    store.commitRegistry()
  }
  return { result, cookies: store.cookies }
}

/** Register (or clear) the settle-time trailer sink for the active
 *  request's response stream. See `RequestStore.settleTrailerSink`. */
export function _setSettleTrailerSink(sink: ((partonId: string) => void) | null): void {
  const store = requestContext.getStore()
  if (store) store.settleTrailerSink = sink
}

/** The active settle-time trailer sink, if a wrap registered one. */
export function _getSettleTrailerSink(): ((partonId: string) => void) | null {
  return requestContext.getStore()?.settleTrailerSink ?? null
}

export function _setRegistryCommit(commit: () => void): void {
  getStore().commitRegistry = commit
}

export function _deferRegistryCommit(): void {
  const store = requestContext.getStore()
  if (store) store.deferRegistryCommit = true
}

export function _captureCommitHandle(): () => void {
  const store = requestContext.getStore()
  if (!store) return () => {}
  return () => {
    if (store.commitRegistry) store.commitRegistry()
  }
}

/**
 * Signal that this render's connection should stay open for the
 * framework's keepalive window after the current segment closes —
 * the segment driver will wait for the next `refreshSelector` event
 * and re-render. Used by producer-await sentinels (e.g. the chat's
 * `ChunkSlot`) to keep a long-poll connection alive across multiple
 * Flight documents on the same TCP socket. The client's
 * `?streaming=1` URL opt-in does the same thing for cell-driven
 * live updates; this is the server-side equivalent for cases where
 * the partial's render itself is what's holding state.
 *
 * Idempotent — multiple calls within one render are a no-op. The
 * flag resets between segments, so each render must call this if
 * it wants the next one to follow.
 */
export function markConnectionLive(): void {
  const store = requestContext.getStore()
  if (!store) return
  store.connectionLive = true
}

/** Read the live flag set by the current segment's render. Used by
 *  the segment driver after the segment's Flight stream closes. */
export function _isConnectionLive(): boolean {
  const store = requestContext.getStore()
  return store?.connectionLive === true
}

/** Reset the live flag between segments so the next render starts
 *  cold and must re-declare its liveness. */
export function _clearConnectionLive(): void {
  const store = requestContext.getStore()
  if (store) store.connectionLive = false
}

/**
 * Per-lane probe for `markConnectionLive()` — the lane driver's
 * producer attribution. Lane renders run CONCURRENTLY inside one
 * request scope, so the store-level `connectionLive` flag can't say
 * WHICH lane's render declared itself a producer. The probe runs one
 * lane iteration inside a nested store whose prototype is the live
 * request store — every read falls through (request, scope, cached
 * override, connection session, ephemeral storage), while
 * `markConnectionLive()`'s write lands on the probe's OWN
 * `connectionLive` field. `live()` reads exactly that own field, so a
 * stale flag on the parent store (the whole-tree segment that handed
 * off to the lane loop may have marked live) never bleeds in.
 */
export interface ConnectionLiveProbe {
  /** Run one lane render iteration inside the probe's scope. */
  run<T>(fn: () => Promise<T>): Promise<T>
  /** True once the iteration's render called `markConnectionLive()`. */
  live(): boolean
}

export function _createConnectionLiveProbe(): ConnectionLiveProbe {
  const parent = getStore()
  const probe: RequestStore = Object.create(parent) as RequestStore
  probe.connectionLive = false
  return {
    run: (fn) => requestContext.run(probe, fn),
    live: () =>
      Object.prototype.hasOwnProperty.call(probe, "connectionLive") &&
      probe.connectionLive === true,
  }
}

// ─── Deferred-commit accounting ─────────────────────────────────────

/** Record one successful cell write for the active request's
 *  deferred-commit decision. `deferred` reflects whether the written
 *  cell declared `deferred: true`. Called from the cell write path
 *  (`writeOneCell`) after the value lands in storage. No-op outside a
 *  request context. */
export function _recordCellWrite(deferred: boolean): void {
  const store = requestContext.getStore()
  if (!store) return
  const w = store.cellWrites ?? { total: 0, deferred: 0 }
  w.total += 1
  if (deferred) w.deferred += 1
  store.cellWrites = w
}

/** True when this request performed at least one cell write and EVERY
 *  write was to a `deferred` cell — so the action response should omit
 *  its re-render (`root`) and let the open streaming connection carry
 *  the change. A mixed batch (any non-deferred write) returns false:
 *  the non-deferred cells still rely on the action-response render.
 *  Consulted by the app's RSC entry when building the action payload. */
export function _actionSuppressesCommit(): boolean {
  const w = requestContext.getStore()?.cellWrites
  return !!w && w.total > 0 && w.total === w.deferred
}

/** Merge a URL update fragment into the request's pending URL update.
 *  Called from `getServerNavigation(scope).navigate(...)`. Multiple
 *  calls within one segment compose: `window` is overwritten,
 *  `frames` keys merge, `history` is last-write-wins. */
export function _mergeUrlUpdate(partial: UrlUpdateEntry): void {
  const store = requestContext.getStore()
  if (!store) return
  const cur = store.pendingUrlUpdate ?? {}
  const next: UrlUpdateEntry = { ...cur }
  if (partial.window !== undefined) next.window = partial.window
  if (partial.frames) {
    next.frames = { ...(cur.frames ?? {}), ...partial.frames }
  }
  if (partial.history !== undefined) next.history = partial.history
  store.pendingUrlUpdate = next
}

/** Install a cached-override carrier into the current request store.
 *  Called by PartialRoot on the cold render after parsing `?cached=`,
 *  so the segment driver can mutate it between segments without
 *  rewriting the request URL. */
export function _setCachedOverride(override: CachedOverride): void {
  const store = requestContext.getStore()
  if (store) store.cachedOverride = override
}

/** Read the cached-override carrier — used by segmented-response to
 *  promote newly-emitted fps into the carrier so the next segment's
 *  PartialRoot sees them. Returns null when there's no request context
 *  or PartialRoot hasn't installed one yet (single-segment cold path). */
export function _getCachedOverride(): CachedOverride | null {
  return requestContext.getStore()?.cachedOverride ?? null
}

/** Set the ids being force-refetched on the current render (a selector
 *  nav's targets) — the descendant fold excludes them and their
 *  subtrees. `null` clears it (a full fold). Called by the segment
 *  driver around a navigation's whole-tree segment render. */
export function _setFoldExclusionIds(ids: ReadonlySet<string> | null): void {
  const store = requestContext.getStore()
  if (store) store.foldExclusionIds = ids
}

/** The ids the descendant fold excludes on the current render, or
 *  `null` when nothing is force-refetched (the common case — a full
 *  fold). */
export function _getFoldExclusionIds(): ReadonlySet<string> | null {
  return requestContext.getStore()?.foldExclusionIds ?? null
}

/** Attach (or detach) the live connection's session to the request
 *  store. Called by the segment driver when it opens/closes the
 *  session for a `?live=1` connection. */
export function _setConnectionSession(session: ConnectionSessionHandle | null): void {
  const store = requestContext.getStore()
  if (store) store.connectionSession = session
}

/** Stash the attach request's decoded body statement on the request
 *  store. Called once per attach, before any render runs — by the
 *  entry (`applyAttachStatement` in `../lib/connection-session.ts`). */
export function _setAttachStatement(statement: AttachStatementHandle): void {
  const store = requestContext.getStore()
  if (store) store.attachStatement = statement
}

/** The attach request's body statement, or `null` on every non-attach
 *  request (discrete GETs, actions, SSR documents) — the callers'
 *  signal to read the URL-param carriers instead. */
export function _getAttachStatement(): AttachStatementHandle | null {
  return requestContext.getStore()?.attachStatement ?? null
}

/**
 * Run `fn` inside a NESTED request scope that presents `visible` as
 * the connection's visible set — the segment driver's warm-render
 * scope. A warm render must evaluate a parked parton's cull gate as
 * in-view so its body runs into the byte cache, but the connection's
 * REAL session is the flip machinery's truth and must not be touched;
 * the nested ALS store confines the overlay to the warm render's own
 * async execution, so concurrently-pumping lanes never see it. The
 * clone carries the request identity (request, scope, ephemeral cell
 * storage) and NONE of the response-coupled state — no cached
 * override (warm renders must not touch the client mirror), no
 * settle-trailer sink, no attach statement, no commit hook — and its
 * synthetic session handle exposes an empty acked layer for the same
 * reason. The driver's continuation resumes with its own store.
 */
export async function _runWithWarmRenderScope<T>(
  visible: ReadonlySet<string>,
  fn: () => Promise<T>,
): Promise<T> {
  const store = getStore()
  const warmStore: RequestStore = {
    request: store.request,
    cookies: [],
    scope: store.scope,
    ephemeralCellStorage: store.ephemeralCellStorage,
    connectionSession: { visible, ackedFps: new Map() },
  }
  return requestContext.run(warmStore, fn)
}

/**
 * Run `fn` inside a NESTED request scope whose request is `url` — the
 * segment driver's preload-warm scope (a `warm` frame's target). Same
 * discipline as `_runWithWarmRenderScope`: the clone carries the
 * request identity (headers/cookies, scope, ephemeral cell storage)
 * and NONE of the response-coupled state — no cached override (the
 * warm render never fp-skips and never touches the client mirror), no
 * connection session (the target route's cull gates evaluate their
 * cold seeds — exactly a fresh navigation's first paint), no attach
 * statement, no commit hook. The driver's continuation resumes with
 * its own store.
 */
export async function _runWithWarmRequestScope<T>(
  url: string,
  fn: () => Promise<T>,
): Promise<T> {
  const store = getStore()
  const warmStore: RequestStore = {
    request: new Request(new URL(url, store.request.url), {
      headers: store.request.headers,
    }),
    cookies: [],
    scope: store.scope,
    ephemeralCellStorage: store.ephemeralCellStorage,
  }
  return requestContext.run(warmStore, fn)
}

/** The connection's current visible set, or `null` when this request
 *  has no live connection session (one-shot renders, SSR) or the
 *  session has no report/seed yet. Consumers fall back to the
 *  request's `?visible=` URL param on `null` — see `readVisible` in
 *  `../lib/server-hooks.ts`. */
export function _getConnectionVisibleSet(): ReadonlySet<string> | null {
  return requestContext.getStore()?.connectionSession?.visible ?? null
}

/** The live connection's ACKED mirror layer, or `null` when this
 *  request has no connection session. A live reference — the session
 *  folds acked holdings in as `ack` frames land, and every render on
 *  the connection (whole-tree segments and lanes alike) consults the
 *  same map. */
export function _getConnectionAckedFps(): ReadonlyMap<
  string,
  ReadonlySet<string>
> | null {
  return requestContext.getStore()?.connectionSession?.ackedFps ?? null
}

/** Consume and clear the pending URL update. Called at trailer-flush
 *  time; the returned entry (if any) is JSON-encoded into a `url`
 *  trailer for the client to apply. */
export function _consumePendingUrlUpdate(): UrlUpdateEntry | null {
  const store = requestContext.getStore()
  if (!store) return null
  const update = store.pendingUrlUpdate
  if (!update) return null
  store.pendingUrlUpdate = undefined
  return update
}

function getStore(): RequestStore {
  const store = requestContext.getStore()
  if (!store) throw new Error("No request context — are you inside a server component or action?")
  return store
}

export function getRequest(): Request {
  return getStore().request
}

export function setRequest(request: Request): void {
  getStore().request = request
}

export function getScope(): string {
  return requestContext.getStore()?.scope ?? DEFAULT_SCOPE
}

/**
 * Look up the active ALS context's ephemeral cell storage, creating
 * it lazily on first access. Returns `null` outside a request
 * context — callers fall back to a process-wide instance or throw,
 * depending on whether they're in user code (throw) or framework
 * plumbing (fallback).
 *
 * Connection-scoped: one storage per `runWithRequestAsync` scope,
 * which in this framework is one HTTP connection (including all
 * streaming segments). Discarded when the scope exits.
 */
export function _getRequestEphemeralStorage(
  factory: () => import("./cell-storage.ts").CellStorage,
): import("./cell-storage.ts").CellStorage | null {
  const store = requestContext.getStore()
  if (!store) return null
  if (!store.ephemeralCellStorage) {
    store.ephemeralCellStorage = factory()
  }
  return store.ephemeralCellStorage
}

/**
 * Drop the current request's ephemeral cell storage so the next
 * access opens a fresh one. Used by the streaming-segment driver
 * between segments — after an invalidation signal wakes the driver,
 * the heartbeat's next render must NOT serve stale ephemeral-cell
 * values that another scope (e.g. an action POST) wrote past. Wiping
 * forces loaders to re-run on the next reads.
 *
 * No-op outside a request context, or when no ephemeral storage was
 * opened yet for this request.
 */
export function _clearRequestEphemeralStorage(): void {
  const store = requestContext.getStore()
  if (!store) return
  store.ephemeralCellStorage = null
}

export function getDefaultScope(): string {
  return DEFAULT_SCOPE
}

/**
 * Match a URL pathname against a pattern with `:name` segments and
 * optional tail catch-all `*`. Returns extracted params or `null`.
 *
 *   matchRoutePattern("/p/x", "/p/:slug") → { slug: "x" }
 *   matchRoutePattern("/x/y", "/*")        → { "*": "x/y" }
 */
export function matchRoutePattern(
  pathname: string,
  pattern: string,
): Record<string, string> | null {
  const pathSegs = pathname.split("/").filter(Boolean)
  const patSegs = pattern.split("/").filter(Boolean)
  const params: Record<string, string> = {}
  for (let i = 0; i < patSegs.length; i++) {
    const pat = patSegs[i]
    if (pat === "*") {
      params["*"] = pathSegs.slice(i).map(decodeURIComponent).join("/")
      return params
    }
    if (i >= pathSegs.length) return null
    const seg = pathSegs[i]
    if (pat.startsWith(":")) {
      params[pat.slice(1)] = decodeURIComponent(seg)
    } else if (pat !== seg) {
      return null
    }
  }
  if (pathSegs.length !== patSegs.length) return null
  return params
}

// ─── Framework control channel (notFound / redirect sentinels) ─────────

export function setFrameworkControl(patch: FrameworkControl): void {
  const store = getStore()
  store.control = { ...store.control, ...patch }
}

export function getFrameworkControl(): FrameworkControl | undefined {
  return getStore().control
}

// ─── Cookies ─────────────────────────────────────────────────────────

/**
 * Read a cookie from the current request, considering any Set-Cookies
 * added during this request's ALS scope.
 *
 * @internal Avoid in spec schema/render bodies — the `cookie()` hook is
 * pre-parsed `cookies` map in its scope, which is the supported
 * surface. This function stays available for server actions and
 * framework internals (session lookup, CMS runtime) that legitimately
 * the read surface there; this is for runtime plumbing.
 */
export function readCookie(name: string): string | undefined {
  const store = getStore()
  for (let i = store.cookies.length - 1; i >= 0; i--) {
    const match = store.cookies[i].match(new RegExp(`^${name}=([^;]*)`))
    if (match) return match[1]
  }
  const header = store.request.headers.get("cookie") ?? ""
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`))
  return match?.[1]
}

/**
 * Parse the request's `Cookie` header into a record, overlaying any
 * `setCookie()` writes made earlier in the active request scope.
 *
 * The `cookie()` hook feeds off this. The overlay keeps reads
 * consistent with `readCookie`: a partial re-rendered immediately
 * after a server action calls `setCookie("cart_id", X) +
 * getServerNavigation().reload({selector: "cart"})` sees the new
 * value, so its fingerprint moves and the reload's selector produces
 * fresh content on the same request rather than stale content that
 * catches up on the next nav.
 *
 * Max-Age=0 follows browser deletion semantics — the cookie disappears
 * from the overlay. A non-zero Max-Age with an empty value is a set,
 * not a delete, and shows up as the empty string.
 */
export function parseCookies(request: Request): Record<string, string> {
  const out: Record<string, string> = {}
  const header = request.headers.get("cookie") ?? ""
  if (header) {
    for (const pair of header.split(";")) {
      const trimmed = pair.trim()
      if (!trimmed) continue
      const eq = trimmed.indexOf("=")
      if (eq <= 0) continue
      const name = trimmed.slice(0, eq).trim()
      const value = trimmed.slice(eq + 1).trim()
      out[name] = value
    }
  }
  const store = requestContext.getStore()
  if (store) {
    for (const cookie of store.cookies) {
      const eq = cookie.indexOf("=")
      if (eq <= 0) continue
      const name = cookie.slice(0, eq).trim()
      const sc = cookie.indexOf(";")
      const value = cookie.slice(eq + 1, sc > 0 ? sc : cookie.length).trim()
      const maxAge = cookie.match(/(?:^|;\s*)Max-Age=([^;]+)/i)
      if (maxAge && Number(maxAge[1].trim()) <= 0) {
        delete out[name]
      } else {
        out[name] = value
      }
    }
  }
  return out
}

export function setCookie(name: string, value: string, maxAge = 60 * 60 * 24 * 30): void {
  const store = getStore()
  store.cookies.push(`${name}=${value}; Path=/; Max-Age=${maxAge}; SameSite=Lax`)
}
