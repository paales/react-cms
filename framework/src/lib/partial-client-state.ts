/**
 * Module-level client state for the partial merge layer.
 *
 * Every mutable map the client partial machinery relies on lives here,
 * behind accessor functions — one owner module, so the state's
 * lifecycle (what survives which kind of commit, what gets pruned
 * when) is auditable in one place. The state lives outside the React
 * tree so it survives the two-phase void→payload remount in
 * entry.browser.tsx. Without this, each refetch would wipe the cache
 * and force every partial to re-render.
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
 * void→payload remount in entry.browser.tsx so cache-mode refetches
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
	// with different vary outputs share a slot by design — the
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

export function registerClientPartial(
	id: string,
	matchKey: string,
	fingerprint: string,
): void {
	let inner = _currentPageFingerprints.get(id);
	if (!inner) {
		inner = new Map();
		_currentPageFingerprints.set(id, inner);
	}
	let set = inner.get(matchKey);
	if (!set) {
		set = new Set();
		inner.set(matchKey, set);
	}
	if (set.has(fingerprint)) return;
	set.add(fingerprint);
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
	for (const [id, byMatchKey] of _currentPageFingerprints) {
		for (const [matchKey, fps] of byMatchKey) {
			for (const fp of fps) {
				out.push(`${id}:${matchKey}:${fp}`);
			}
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
