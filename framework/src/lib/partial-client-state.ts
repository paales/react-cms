/**
 * Module-level client state for the partial merge layer.
 *
 * Every mutable map the client partial machinery relies on lives here,
 * behind accessor functions — one owner module, so the state's
 * lifecycle (what survives which kind of commit, what gets pruned
 * when) is auditable in one place. The state lives outside the React
 * tree so it survives the two-phase void→payload remount in the
 * browser bootstrap (`../entry/browser.tsx`). Without this, each
 * refetch would wipe the cache and force every partial to re-render.
 *
 * Consumers:
 *   - `partial-cache.ts` — the tree walks that fill the cache and
 *     fingerprint maps.
 *   - `partial-template.tsx` — the structural template render.
 *   - `partial-client.tsx` — the merge coordinator (`PartialsClient`).
 *   - `refetch.ts` / `frame-client.tsx` — the in-flight registry and
 *     frame-URL cache.
 */

import type { ReactNode } from "react";
import type { FpUpdatesPayload } from "./fp-trailer-marker.ts";

// ─── Partial cache + fingerprints ─────────────────────────────────

/**
 * Client cache of rendered partial subtrees, scoped to the CURRENT
 * page only. Pruned on every streaming-mode render against the
 * harvested `seen` set, so entries for partials that aren't on the
 * new page are dropped immediately. Survives the two-phase
 * void→payload remount in `../entry/browser.tsx` so cache-mode refetches
 * don't wipe everything between commits — but doesn't accumulate
 * across navigations. Steady-state size is bounded by the largest
 * single page the user visits, not by browsing history.
 *
 * Two-level keying:
 *   - Outer key: partial `id` (e.g. `"pokemon-page"`).
 *   - Inner key: `matchKey` (16-char hex hash of `stableStringify(
 *     matchParams)`) — identifies the rendered variant.
 *
 * Why nested: navigating `/pokemon/1` ↔ `/pokemon/2` produces two
 * different matchKeys for the same id. Both variants coexist in the
 * cache (rendered as hidden `<Activity>` siblings by the server when
 * the client advertises them via `?cached=`), so the prior variant's
 * fiber survives the round-trip. Specs without `match` resolve to a
 * constant matchKey — the inner map always has size 1.
 *
 * Eviction is purely per-page prune today: any (id, matchKey) not in
 * the new render's `seen` set is dropped on the next streaming-mode
 * commit. There is no time-based TTL or LRU; the steady-state bound
 * is the cartesian product of (live id) × (cached variants per id).
 * For a future LRU layer over the variant pool, see
 * `docs/notes/IDEAS.md` (Keepalive follow-ups).
 */
export type PartialCache = Map<string, Map<string, ReactNode>>;

const _currentPagePartials: PartialCache = new Map();
const _currentPageFingerprints = new Map<string, Map<string, Set<string>>>();

/** The one live `PartialCache` instance backing the current page. */
export function getCurrentPagePartials(): PartialCache {
	return _currentPagePartials;
}

export function cacheLookup(
	cache: PartialCache,
	id: string,
	matchKey: string,
): ReactNode | undefined {
	return cache.get(id)?.get(matchKey);
}

export function cacheStore(
	cache: PartialCache,
	id: string,
	matchKey: string,
	node: ReactNode,
): void {
	let inner = cache.get(id);
	if (!inner) {
		inner = new Map();
		cache.set(id, inner);
	}
	const replacing = inner.has(matchKey);
	inner.set(matchKey, node);
	// Overwriting a cache slot invalidates any fingerprint that
	// referred to the old content. Without this, fps from prior
	// navs accumulate in `_currentPageFingerprints[id][matchKey]`
	// and travel back to the server in `?cached=`; the next visit
	// can fp-skip against a stale entry while the cache slot points
	// at fresh content, and `substituteNested` lands the wrong
	// subtree (or the right one for the wrong URL). Same matchKey
	// with different request-read values share a slot by design — the
	// fingerprint set must shrink to "what the current slot
	// actually represents", which is exactly the fp that
	// `registerClientPartial` is about to write after this call.
	// Cold→warm trailer adds for the same render still land
	// additively after the walk completes.
	if (replacing) {
		_currentPageFingerprints.get(id)?.delete(matchKey);
	}
}

/**
 * Register a partial's fingerprint from the client side.
 *
 * Called by `<PartialErrorBoundary>` during its render, which is how
 * each `<Partial>`'s fingerprint gets into `_currentPageFingerprints`
 * without a server prop round-trip. Later `getCachedPartialIds()` reads
 * from here to tell the server what's already cached.
 *
 * Fingerprints are scoped to (id, matchKey) — cold/warm fp drift
 * accumulates within a single variant; cross-variant navigation
 * (`/pokemon/1` ↔ `/pokemon/2`) populates distinct matchKey slots.
 */
/** Soft cap on fps tracked per (id, matchKey). The cold→warm
 *  transition emits two fps per render cycle (one at boundary
 *  mount, one from the trailer post-resolution); live partials
 *  emit a fresh pair per segment. Keeping the LATEST few is
 *  enough for the cold/warm fp-skip on the next nav; older fps
 *  for the same variant are stale and only bloat `?cached=`. */
export const FP_CAP_PER_VARIANT = 4;

/** Cap on `?cached=` manifest ENTRIES advertised to the server —
 *  the URL form only. The client's local fp cache is unbounded within
 *  a page (pruned to the live tree), but the URL manifest travels in
 *  the request line — a page with hundreds of partons (the website's
 *  chunk world) would otherwise blow the server's request-line limit
 *  (HTTP 431). Only the most recently REGISTERED variants are
 *  advertised; anything older re-renders server-side on its next
 *  appearance (over-fetch, never stale) and re-enters the manifest by
 *  registering again. The attach BODY manifest
 *  (`getAllCachedPartialTokens`) has no request line to protect and
 *  carries everything. */
export const CACHED_MANIFEST_CAP = 96;

/** Cap on distinct ids retained in the client maps. A long journey
 *  across a cullable field accumulates entries for every parton ever
 *  visited; past the cap the LEAST-RECENTLY-SIGHTED ids are destroyed
 *  (cache + fps) — they re-render cold on a return visit. Bounds
 *  memory the same way the manifest cap bounds the URL.
 *
 *  Ids the LIVE TREE still references are exempt (see `_liveTreeIds`):
 *  the template re-substitutes their placeholders from the cache on
 *  every re-render, so destroying one blanks that subtree permanently —
 *  nothing refetches it (the fp-skip placeholder is the server saying
 *  "you have this"). The page shell is the canonical victim: its
 *  element identity is stable, so React bails out of re-rendering its
 *  boundary and it never re-registers for recency — under heavy
 *  registration churn (a scroll across a cullable field) it becomes
 *  the oldest entry while still being the subtree everything hangs
 *  off. A page whose live tree alone exceeds the cap keeps every live
 *  entry — correctness bounds memory there, the cap bounds the rest.
 *  The HEAVY budget — parked subtree DOM and fibers — is
 *  `CULL_PARK_CAP` in `cull-park.ts`, whose content eviction is what
 *  makes a parked id leave the live tree and become evictable here. */
export const CLIENT_POOL_CAP = 512;

/**
 * Listener for ids leaving the client maps entirely — fired by
 * `pruneToLive` and the pool-cap eviction. This is THE page-membership
 * signal: an id is on the page for exactly as long as some commit
 * still references it (rendered, fp-skipped, or parked); when the
 * maps drop it, dependent client state must go too. The cull-park
 * module registers here to tear down its per-id state — observer
 * lifecycles can't stand in for this signal, because an Activity flip
 * can unmount one slot's observer in a different pass than it mounts
 * the other's.
 */
let _onIdPruned: ((id: string) => void) | null = null;

export function _setIdPrunedListener(fn: (id: string) => void): void {
	_onIdPruned = fn;
}

/** Ids referenced by the current template's rendered tree — the
 *  prune set from the most recent payload commit. The template's
 *  placeholder-reference structure only changes on payload commits,
 *  so between commits this is exactly the set of ids whose cache
 *  entries a template re-render may need to substitute. */
let _liveTreeIds: ReadonlySet<string> = new Set();

function evictOldest(): void {
	if (_currentPageFingerprints.size <= CLIENT_POOL_CAP) return;
	for (const id of [..._currentPageFingerprints.keys()]) {
		if (_liveTreeIds.has(id)) continue;
		_currentPageFingerprints.delete(id);
		_currentPagePartials.delete(id);
		_onIdPruned?.(id);
		if (_currentPageFingerprints.size <= CLIENT_POOL_CAP) return;
	}
}

/**
 * Refresh an id's recency in the fingerprint map without changing its
 * entries. The payload walk calls this for every wrapper and
 * placeholder it sights, so map order means "recency of appearing in
 * a commit" — the server still emits the id — rather than "recency of
 * a fresh registration". Structural ancestors (a page shell that
 * fp-skips forever, appearing only as placeholders) stay at the tail;
 * the `CLIENT_POOL_CAP` FIFO then ages out exactly the ids commits
 * stopped mentioning — content parked deep inside another id's cached
 * subtree. No-op for unknown ids.
 */
export function touchClientPartial(id: string): void {
	const inner = _currentPageFingerprints.get(id);
	if (!inner) return;
	_currentPageFingerprints.delete(id);
	_currentPageFingerprints.set(id, inner);
}

export function registerClientPartial(
	id: string,
	matchKey: string,
	fingerprint: string,
): void {
	let inner = _currentPageFingerprints.get(id);
	if (!inner) {
		inner = new Map();
		_currentPageFingerprints.set(id, inner);
	} else {
		// Re-insert at the tail so map order tracks registration
		// recency — `getCachedPartialIds` walks newest-first when
		// capping the manifest.
		_currentPageFingerprints.delete(id);
		_currentPageFingerprints.set(id, inner);
	}
	let set = inner.get(matchKey);
	if (!set) {
		set = new Set();
		inner.set(matchKey, set);
	}
	if (set.has(fingerprint)) return;
	set.add(fingerprint);
	evictOldest();
	// Evict the oldest entries (insertion order) once the cap is
	// reached. Without this, a live partial that re-renders every
	// segment would inflate `?cached=` unboundedly.
	while (set.size > FP_CAP_PER_VARIANT) {
		const oldest = set.values().next().value;
		if (oldest === undefined) break;
		set.delete(oldest);
	}
}

/**
 * Apply an fp-updates trailer (parsed JSON from the wire) to the
 * client's fingerprint map. Each entry is a `{from, to}` cold→warm
 * pair (see {@link FpUpdate}); `to` is aliased onto whichever
 * `(id, matchKey)` slot still holds `from`.
 *
 * See `lib/fp-trailer.ts` for the server-side emission, and
 * `lib/fp-trailer-marker.ts` for the wire sentinel + payload shape.
 */
export function _applyFpUpdates(updates: FpUpdatesPayload): void {
	for (const [id, { from, to }] of Object.entries(updates)) {
		const inner = _currentPageFingerprints.get(id);
		if (!inner) continue;
		// Alias the warm fp `to` onto the variant slot whose set still
		// holds the cold fp `from` — matched by CONTENT. The trailer is
		// async: it lands after its response's body committed, by which
		// point a concurrent refetch for a DIFFERENT query against the same
		// stable `(id, matchKey)` may have overwritten the slot — and
		// cleared its fp-set (see `cacheStore`). Anchoring on `from` means
		// such a superseded trailer finds no slot and is dropped, so the
		// advertised fp-set stays in lockstep with the node the slot
		// actually holds — the invariant that makes every server fp-skip
		// restore the content the server matched it against. `from` folds in
		// matchKey, so it pins exactly one slot. registerClientPartial
		// enforces the per-variant fp cap.
		for (const [mk, set] of inner) {
			if (set.has(from)) {
				registerClientPartial(id, mk, to);
				break;
			}
		}
	}
}

/**
 * Ids whose manifest tokens are advertised FIRST, ahead of the
 * newest-registration walk — the cull-park module registers its
 * parked-by-culling LRU here (see `cull-park.ts`). A parked id's
 * client state survives only as long as the server can CONFIRM its
 * fingerprints; on a busy live page the manifest's recency window
 * churns with every lane registration, and without priority a parked
 * subtree silently loses its `?cached=` slots — its next cull-in then
 * re-renders and drops the parked copy. Bounded by the parked pool's
 * own cap, so the priority block can never starve the recency walk
 * entirely.
 */
let _manifestPriorityIds: (() => readonly string[]) | null = null;

export function _setManifestPriorityIds(fn: () => readonly string[]): void {
	_manifestPriorityIds = fn;
}

/**
 * Module-level accessor for cached partial tokens.
 * Returns "id:matchKey:fingerprint" triples so the server can:
 *   - decide fp-skip per (id, fingerprint), unchanged from before;
 *   - emit hidden `<Activity>` siblings for cached matchKeys other
 *     than the current variant, so cross-variant navigation parks
 *     the prior variant rather than dropping its fiber.
 *
 * Used by the browser entry to build `?cached=` during navigation.
 *
 * Source of truth is `_currentPageFingerprints`, not
 * `_currentPagePartials`. Every rendered Partial — top-level OR deep
 * (`.map()`-generated, nested inside an ancestor's subtree) —
 * registers its (matchKey, fingerprint) client-side as its wrapper
 * mounts via `PartialErrorBoundary`. Reporting from
 * `_currentPageFingerprints` means the skip-on-unchanged optimization
 * applies uniformly across the entire tree.
 */
export function getCachedPartialIds(): string[] {
	const out: string[] = [];
	const emitted = new Set<string>();
	const emitId = (id: string): boolean => {
		const byMatchKey = _currentPageFingerprints.get(id);
		if (!byMatchKey) return true;
		for (const [matchKey, fps] of byMatchKey) {
			for (const fp of fps) {
				out.push(`${id}:${matchKey}:${fp}`);
				if (out.length >= CACHED_MANIFEST_CAP) return false;
			}
		}
		return true;
	};
	// Priority block first: parked-by-culling ids (see
	// `_setManifestPriorityIds`) must keep advertising their variants
	// or their parked state is unrestorable.
	for (const id of _manifestPriorityIds?.() ?? []) {
		if (emitted.has(id)) continue;
		emitted.add(id);
		if (!emitId(id)) return out;
	}
	// Insertion order tracks registration recency (re-registration
	// re-inserts) — walk newest-first and stop at the manifest cap.
	const ids = [...(_currentPageFingerprints.keys())].reverse();
	for (const id of ids) {
		if (emitted.has(id)) continue;
		emitted.add(id);
		if (!emitId(id)) return out;
	}
	return out;
}

/**
 * The FULL client manifest — every advertised `id:matchKey:fp` token,
 * uncapped: the attach statement's `cached` (see `channel-protocol.ts`).
 * The attach travels as a POST body, so the request-line limit behind
 * `CACHED_MANIFEST_CAP` doesn't apply, and the priority walk is moot —
 * nothing is left out. The size is structurally bounded by the client
 * pool itself: at most `CLIENT_POOL_CAP` ids, each variant capped at
 * `FP_CAP_PER_VARIANT` fps (variants per id are pruned to the live
 * tree's references) — the manifest can never exceed what the maps
 * hold.
 */
export function getAllCachedPartialTokens(): string[] {
	const out: string[] = [];
	for (const [id, byMatchKey] of _currentPageFingerprints) {
		for (const [matchKey, fps] of byMatchKey) {
			for (const fp of fps) out.push(`${id}:${matchKey}:${fp}`);
		}
	}
	return out;
}

/**
 * The client's current cached tokens (`id:matchKey:fp`) for a specific
 * id set — the `visible` frame's holdings declaration (see
 * `channel-protocol.ts`): a culling flip tells the server exactly
 * what it holds for the flipped partons, so the lane's fp-skip verdict
 * can't confirm content the client already dropped.
 */
export function cachedTokensFor(ids: readonly string[]): string[] {
	const out: string[] = [];
	for (const id of ids) {
		const byMatchKey = _currentPageFingerprints.get(id);
		if (!byMatchKey) continue;
		for (const [matchKey, fps] of byMatchKey) {
			for (const fp of fps) out.push(`${id}:${matchKey}:${fp}`);
		}
	}
	return out;
}

/**
 * Prune both client maps down to the given live `(id, matchKey)` set.
 * Anything in the maps but not in `live` was superseded — a
 * churned-away instance id, an evicted variant, a partial from a
 * prior route — and the client can no longer restore it, so it must
 * stop being advertised in `?cached=`. Pruning is at (id, matchKey)
 * granularity — a parked variant whose hidden Activity sibling is
 * still referenced stays alive, while a variant no longer referenced
 * anywhere drops.
 */
export function pruneToLive(live: Map<string, Set<string>>): void {
	// Record the live id set for the pool-cap eviction guard: these are
	// the ids the committed template can re-substitute at any re-render,
	// so `evictOldest` must not destroy them.
	_liveTreeIds = new Set(live.keys());
	const before = new Set<string>([
		..._currentPagePartials.keys(),
		..._currentPageFingerprints.keys(),
	]);
	for (const map of [_currentPagePartials, _currentPageFingerprints]) {
		for (const [id, byMatchKey] of map) {
			const liveMks = live.get(id);
			if (!liveMks) {
				map.delete(id);
				continue;
			}
			for (const mk of [...byMatchKey.keys()]) {
				if (!liveMks.has(mk)) byMatchKey.delete(mk);
			}
			if (byMatchKey.size === 0) map.delete(id);
		}
	}
	// Page-membership teardown: an id that left BOTH maps is off the
	// page — no commit references it rendered, skipped, or parked.
	if (_onIdPruned) {
		for (const id of before) {
			if (!_currentPageFingerprints.has(id) && !_currentPagePartials.has(id)) {
				_onIdPruned(id);
			}
		}
	}
}

/**
 * Destroy a parton's parked CONTENT — the cull-park LRU's eviction
 * (see `cull-park.ts`). Deletes the id's cache slots and advertised
 * fingerprints (the skeleton isn't among them — it renders from the
 * pair's inline element, never the cache, so it keeps holding the
 * parton's space). The mounted parked fiber unmounts on the next
 * commit's template render (its placeholder no longer resolves), and
 * with no advertised fp the next cull-in renders cold — the
 * pre-parking behavior.
 */
export function evictCulledContent(id: string): void {
	_currentPagePartials.delete(id);
	_currentPageFingerprints.delete(id);
}

// ─── Lane commits ─────────────────────────────────────────────────

/**
 * Subscription for per-parton lane commits. A lane commit writes a
 * freshly-decoded parton subtree into the partial cache OUTSIDE any
 * payload render — nothing re-renders on a cache write by itself, so
 * `PartialsClient` subscribes here and schedules a transition
 * re-render of the template on every notify; `renderTemplate` /
 * `substituteNested` then swap the fresh subtree in place. See
 * `_commitPartonLane` in `partial-cache.ts`.
 */
const _laneCommitSubscribers = new Set<() => void>();

export function subscribeLaneCommits(cb: () => void): () => void {
	_laneCommitSubscribers.add(cb);
	return () => {
		_laneCommitSubscribers.delete(cb);
	};
}

export function notifyLaneCommit(): void {
	for (const cb of [..._laneCommitSubscribers]) cb();
}

// ─── Live catch-up anchor ─────────────────────────────────────────

/**
 * The document's registry anchor (`<!--live-anchor:{epoch,ts}-->`,
 * parsed by `_applyFpTrailerFromDocument`'s scan): the point on the
 * server's invalidation timeline this page's bytes represent. The
 * heartbeat TAKES it (once) for its first `?live=1` fire — the server
 * then skips the whole-route initial segment and opens straight into
 * lanes for everything that bumped after the document rendered.
 * Take-once: a reopened connection (keepalive elapsed) has consumed
 * lanes past the anchor with no client-side timeline to re-anchor on,
 * so it falls back to the full initial segment.
 */
let _liveCatchupAnchor: { epoch: string; ts: number } | null = null;

export function _setLiveCatchupAnchor(anchor: { epoch: string; ts: number }): void {
	_liveCatchupAnchor = anchor;
}

export function _takeLiveCatchupAnchor(): { epoch: string; ts: number } | null {
	const anchor = _liveCatchupAnchor;
	_liveCatchupAnchor = null;
	return anchor;
}

// ─── Live connection id ───────────────────────────────────────────

/**
 * The connection id of the currently-established live stream, or
 * `null` when none is open. SERVER-minted: the segment driver creates
 * it at session open and ships it down as the stream's `conn` entry;
 * the channel transport (`channel-client.ts`) publishes it here on
 * receipt and clears it when the connection settles or an envelope's
 * delivery fails. Producers read it to decide the statement
 * transport: id in hand → frames on channel envelopes addressed to
 * the open connection; `null` → their discrete fallback.
 */
let _liveConnectionId: string | null = null;

export function _setLiveConnectionId(id: string | null): void {
	_liveConnectionId = id;
}

export function _getLiveConnectionId(): string | null {
	return _liveConnectionId;
}

// ─── Structural template ──────────────────────────────────────────

/**
 * Structural layout skeleton, derived from the most recent full-payload
 * render via `deriveTemplate`. Persisted across refetches so the server
 * doesn't need to ship the template bytes on every partial refetch.
 * Re-derived whenever a full payload arrives (covers layout changes
 * across route navigations).
 *
 * Keyed by route (pathname + search). Same-URL refetches reuse the
 * cached template; different-URL navigations re-derive.
 */
let _template: ReactNode = null;

/**
 * The page `_template` was derived for — the pathname only. The
 * structural skeleton is decided by which specs `match` (a path
 * concern), so a same-page change — a query/state param like
 * `?chat=open` or `?q=…`, a refetch's `?cached=`/`?streaming=`, a frame
 * URL — keeps the same structure and reuses the template, while a
 * different page re-derives. Gates the streaming-mode pending-lazy
 * fallback (see `PartialsClient`): without it, a cross-page nav whose
 * new page still has a Flight chunk in flight would re-render this STALE
 * prior-page template — the page sticks on the one you just left.
 */
let _templateRoute: string | null = null;

/** Page key for `_template`: the pathname. Same-page query/state changes
 *  reuse the template (the `match`-driven structure is unchanged); only a
 *  pathname change re-derives. Client-only (reads `window.location`);
 *  callers are past the SSR `typeof document` guard. */
export function templateRouteKey(): string {
	return new URL(window.location.href).pathname;
}

export function getTemplate(): ReactNode {
	return _template;
}

export function getTemplateRoute(): string | null {
	return _templateRoute;
}

export function setTemplate(template: ReactNode, route: string): void {
	_template = template;
	_templateRoute = route;
}

// ─── In-flight queue + deferred abort (frame long-polls only) ─────
//
// SCOPE: this machinery serves ONLY frame navigation, whose
// segment-loop fetch can be an unbounded long-poll (the chat overlay
// streams tick updates for the lifetime of `?chat=open`). A newer
// frame nav must cancel the older infinite stream or it streams
// forever and races the newer commit — so here, deferred abort is
// correct and necessary.
//
// Window-scoped targeted refetches (`navigate({selector})` /
// `reload({selector})`) do NOT use this. They are finite documents;
// aborting one mid-decode rejects the whole Flight document and
// crashes the page through the nearest error boundary. They drain and
// commit on supersede, ordered by the monotonic commit guard
// (`refetch-ordering.ts`): each fire carries a per-selector issue seq,
// and a late-arriving OLDER fire's commit is dropped rather than
// clobbering a newer one — last ISSUED wins, not last to arrive. That
// real signal is what keeps a `reload({selector})` of live server state
// correct when responses race (the URL is identical, so it can't
// arbitrate). They are cancelled only by the caller's own
// `options.signal`.
//
// Abort is DEFERRED: the older fire keeps streaming into its Suspense
// boundaries until the newer fire's first segment lands, then
// `abortPredecessors` cancels the older fetches. Selector identity is
// the sorted, comma-joined label set.

export interface InFlightEntry {
	controller: AbortController;
}

const _inFlight = new Map<string, InFlightEntry[]>();

export function inFlightKey(labels: string[]): string | null {
	if (labels.length === 0) return null;
	return labels.slice().sort().join(",");
}

export function registerInFlight(key: string, entry: InFlightEntry): void {
	const stack = _inFlight.get(key);
	if (stack) stack.push(entry);
	else _inFlight.set(key, [entry]);
}

export function unregisterInFlight(key: string, entry: InFlightEntry): void {
	const stack = _inFlight.get(key);
	if (!stack) return;
	const idx = stack.indexOf(entry);
	if (idx >= 0) stack.splice(idx, 1);
	if (stack.length === 0) _inFlight.delete(key);
}

/** Abort every entry older than `entry` in this selector's stack. */
export function abortPredecessors(key: string, entry: InFlightEntry): void {
	const stack = _inFlight.get(key);
	if (!stack) return;
	const idx = stack.indexOf(entry);
	if (idx <= 0) return;
	for (let i = 0; i < idx; i++) stack[i].controller.abort();
	stack.splice(0, idx);
}

// ─── Frame URLs ───────────────────────────────────────────────────

/**
 * Cached frame URLs on the client, keyed by the frame's dotted path
 * (`"cart"` or `"products.list"`). Updated on every
 * `useNavigation(path).navigate(url)` call so `currentEntry.url` can
 * return a synchronous value without a server round-trip. The server
 * session is authoritative — this is a UX cache.
 */
const _frameUrls = new Map<string, string>();

export function getFrameUrl(key: string): string | undefined {
	return _frameUrls.get(key);
}

export function setFrameUrl(key: string, url: string): void {
	_frameUrls.set(key, url);
}

export function hasFrameUrl(key: string): boolean {
	return _frameUrls.has(key);
}
