/**
 * Client partial cache walks: recognizing partial wrappers and
 * placeholders in a streamed tree, harvesting the `(id, matchKey)`
 * pairs they carry, filling the client cache from a streamed payload,
 * and substituting cached subtrees back into a rendered tree.
 *
 * The mutable maps these walks fill live in
 * `partial-client-state.ts`; every function here either takes the
 * cache as a parameter or goes through that module's accessors.
 */

import {
	cloneElement,
	isValidElement,
	type ReactElement,
	type ReactNode,
	Suspense,
} from "react";
import type { FpUpdatesPayload } from "./fp-trailer-marker.ts";
import {
	_applyFpUpdates,
	cacheLookup,
	cacheStore,
	getCurrentPagePartials,
	notifyLaneCommit,
	type PartialCache,
	registerClientPartial,
} from "./partial-client-state.ts";

/**
 * Return true if the node looks like the outermost wrapper a
 * `<Partial>` renders — a keyed `<Suspense>` (partial with fallback)
 * or a keyed `<PartialErrorBoundary>` (partial without fallback).
 *
 * We can't reliably compare `node.type` against the PartialErrorBoundary
 * class identity — in SSR the class reference can differ from the
 * one this module imports (different module graphs across the RSC /
 * SSR boundary). Instead we detect by the `partialId` prop the Partial
 * component always sets on its wrapper. For the Suspense branch, the
 * key is the partial id and Suspense wraps a PartialErrorBoundary that
 * also carries `partialId` — we detect via `type === Suspense`.
 */
export function isPartialWrapper(node: ReactElement): boolean {
	if (node.key == null) return false;
	if (node.type === Suspense) return true;
	const props = node.props as { partialId?: unknown };
	return typeof props?.partialId === "string";
}

/**
 * Extract the partial id from a wrapper node.
 *
 * Prefer the `partialId` prop over `node.key`. Flight combines the
 * outer `.map()` key with a client-component's own `key` into a
 * composite string like "page-1,page-1" when a `<Partial>` is
 * produced inside a `.map()`. The `partialId` prop stays clean and
 * is always the source of truth.
 *
 * Suspense (a React built-in) doesn't get double-keyed and doesn't
 * carry `partialId` itself — but its child is the PartialErrorBoundary
 * that does. Fall back to the Suspense `key` (which stays clean) or
 * peek at the direct child's `partialId`.
 */
export function getPartialId(node: ReactElement): string | null {
	const props = node.props as { partialId?: unknown; children?: unknown };
	if (typeof props.partialId === "string") return props.partialId;
	if (node.type === Suspense) {
		const child = props.children;
		if (isValidElement(child)) {
			const cp = (child as ReactElement).props as { partialId?: unknown };
			if (typeof cp.partialId === "string") return cp.partialId;
		}
		if (node.key != null) return String(node.key);
	}
	return null;
}

/**
 * Extract the structural fingerprint off a partial wrapper. Mirrors
 * `getPartialId` — direct `partialFingerprint` prop, or peek through a
 * Suspense wrapper to the PartialErrorBoundary child. Returns `null`
 * for wrappers that don't carry one (shouldn't happen in practice but
 * we bail rather than register a bogus value).
 */
export function getPartialFingerprint(node: ReactElement): string | null {
	const props = node.props as {
		partialFingerprint?: unknown;
		children?: unknown;
	};
	if (typeof props.partialFingerprint === "string")
		return props.partialFingerprint;
	if (node.type === Suspense) {
		const child = props.children;
		if (isValidElement(child)) {
			const cp = (child as ReactElement).props as {
				partialFingerprint?: unknown;
			};
			if (typeof cp.partialFingerprint === "string")
				return cp.partialFingerprint;
		}
	}
	return null;
}

/**
 * A placeholder is the `<i data-partial hidden>` marker the server
 * emits for a partial it fp-skipped — the client keeps its cached
 * entry for that region.
 *
 * IMPORTANT: cached partials are pushed as-is with NO traversal of their
 * own children. The Suspense boundaries inside cached partials have lazy
 * refs (from the RSC Flight stream) as `props.children`; any `React.Children.*`
 * helper on those thenables causes React to resolve them during reconcile
 * instead of showing a fallback on remount, which breaks progressive
 * streaming on refetch. See notes/archive/STREAMING_DEBUG_NOTES.md §7-8.
 */
export function isPlaceholder(child: ReactElement): boolean {
	return child.type === "i" && (child.props as any)["data-partial"] === true;
}

/**
 * Id for a placeholder `<i>`. Prefer the `data-partial-id` prop, which
 * is stable, over `node.key`, which Flight can composite with an outer
 * `.map()` key into `"outer,inner"` for dynamic Partials.
 */
export function getPlaceholderId(node: ReactElement): string | null {
	const props = node.props as { ["data-partial-id"]?: unknown };
	if (typeof props["data-partial-id"] === "string") {
		return props["data-partial-id"];
	}
	return node.key != null ? String(node.key) : null;
}

/**
 * MatchKey of a placeholder `<i>`. matchKey identifies the rendered
 * variant (cache slot under id) — read from `data-partial-match`. The
 * value is a 16-char hex hash of stableStringify(matchParams); specs
 * without `match` resolve to a constant matchKey.
 */
export function getPlaceholderMatchKey(node: ReactElement): string | null {
	const props = node.props as { ["data-partial-match"]?: unknown };
	if (typeof props["data-partial-match"] === "string") {
		return props["data-partial-match"];
	}
	return null;
}

/**
 * MatchKey off a partial wrapper. Mirrors `getPartialFingerprint`:
 * read `partialMatchKey` directly, or peek through a Suspense wrapper
 * to its PartialErrorBoundary child.
 */
export function getPartialMatchKey(node: ReactElement): string | null {
	const props = node.props as {
		partialMatchKey?: unknown;
		children?: unknown;
	};
	if (typeof props.partialMatchKey === "string") return props.partialMatchKey;
	if (node.type === Suspense) {
		const child = props.children;
		if (isValidElement(child)) {
			const cp = (child as ReactElement).props as {
				partialMatchKey?: unknown;
			};
			if (typeof cp.partialMatchKey === "string") return cp.partialMatchKey;
		}
	}
	return null;
}

export function addSeen(
	out: Map<string, Set<string>>,
	id: string,
	matchKey: string,
): void {
	let inner = out.get(id);
	if (!inner) {
		inner = new Set();
		out.set(id, inner);
	}
	inner.add(matchKey);
}

/**
 * Collect every (id, matchKey) pair reachable inside a node — wrapper
 * OR placeholder. Read-only walk: doesn't mutate the client maps.
 * Used by the streaming-mode prune to expand `seen` with nested
 * variants that live inside cached wrappers — when the server
 * fp-skips an outer partial, the new tree carries only its top-level
 * placeholder, so the nested (id, matchKey) pairs backing the
 * rendered region need to be harvested from the cache itself or the
 * prune deletes them out from under the next render.
 *
 * Wrappers without a `partialMatchKey` prop (legacy fixtures, missing
 * server-side wire) fall back to the empty string so they're still
 * tracked as a single-variant cache entry under `(id, "")`.
 */
export function harvestPartialIds(
	node: ReactNode,
	out: Map<string, Set<string>>,
): void {
	if (node == null || typeof node === "boolean") return;
	if (typeof node === "string" || typeof node === "number") return;
	if (Array.isArray(node)) {
		for (let i = 0; i < node.length; i++) {
			harvestPartialIds(node[i] as ReactNode, out);
		}
		return;
	}
	const unwrapped = unwrapLazy(node);
	if (unwrapped !== node) {
		// Errored OR pending lazy — can't descend; skip.
		if (unwrapped == null || unwrapped === LAZY_PENDING) return;
		harvestPartialIds(unwrapped as ReactNode, out);
		return;
	}
	if (!isValidElement(node)) return;

	if (isPartialWrapper(node)) {
		const id = getPartialId(node);
		if (id) addSeen(out, id, getPartialMatchKey(node) ?? "");
		const inner = (node.props as { children?: ReactNode })?.children;
		if (inner != null) harvestPartialIds(inner, out);
		return;
	}
	if (isPlaceholder(node)) {
		const id = getPlaceholderId(node);
		if (id) addSeen(out, id, getPlaceholderMatchKey(node) ?? "");
		return;
	}
	const inner = (node.props as { children?: ReactNode })?.children;
	if (inner != null) harvestPartialIds(inner, out);
}

/**
 * Walk a cached element tree and substitute any nested partial wrappers
 * with the current cache entry for that (id, matchKey) variant.
 *
 * `skipKey` is `${id}|${matchKey}` so the recursion can't loop on a
 * wrapper that contains a placeholder pointing to itself (any
 * fp-skipped partial caches a wrapper that contains its own
 * placeholder). The outer id alone isn't enough — two siblings under
 * the same PartialBoundary can share an id but differ on matchKey
 * (hidden Activity sibling for a parked variant), and the inner one
 * must still resolve when the outer references the same id.
 */
export function substituteNested(
	node: ReactNode,
	cache: PartialCache,
	skipKey: string,
): ReactNode {
	if (node == null || typeof node === "boolean") return node;
	if (typeof node === "string" || typeof node === "number") return node;
	if (Array.isArray(node)) {
		let changed = false;
		const mapped = node.map((c) => {
			const s = substituteNested(c, cache, skipKey);
			if (s !== c) changed = true;
			return s;
		});
		return changed ? mapped : node;
	}

	// Flight lazy refs appear as children of cached client-component
	// boundaries (e.g. `<PartialErrorBoundary>{lazyRef}</PartialErrorBoundary>`
	// where the server was still streaming when the cache was
	// populated). By the time a refetch lands they've been resolved —
	// unwrap so we can descend into the nested tree and find keyed
	// partials to swap. Pending / errored lazies leave the original
	// node in place so React's native Suspense resolves them later.
	const unwrapped = unwrapLazy(node);
	if (unwrapped !== node) {
		if (unwrapped == null || unwrapped === LAZY_PENDING) return node;
		return substituteNested(unwrapped as ReactNode, cache, skipKey);
	}

	if (!isValidElement(node)) return node;

	// Placeholder: substitute from cache. Id + matchKey come from the
	// `data-partial-id` + `data-partial-match` props (stable), not the
	// key (Flight composites).
	//
	// Recurse into the cached wrapper. A wrapper produced by a
	// cache-mode refetch can carry INTERNAL placeholders for partials
	// whose fp matched (no fresh content emitted server-side). Those
	// inner placeholders need to be substituted with the next cache
	// entries — without the recursion the inner placeholders survive
	// into the rendered tree as `<i hidden>` markers and the partial's
	// descendant content is empty in the DOM. This was the
	// "consecutive moves blank the preview" bug (issue #1, 2026-04-25):
	// move 2's cms-demo-root wrapper held 6 Fragments-with-placeholder
	// children, and the substitution stopped at the wrapper without
	// unfolding those nested placeholders against the cache entries
	// populated by move 1.
	if (isPlaceholder(node)) {
		const id = getPlaceholderId(node);
		const mk = getPlaceholderMatchKey(node) ?? "";
		const key = `${id ?? ""}|${mk}`;
		if (id && key !== skipKey) {
			const fresh = cacheLookup(cache, id, mk);
			return fresh ? substituteNested(fresh, cache, key) : node;
		}
	}

	// Partial-shape wrapper: if there's a fresh cache entry for the
	// same (id, matchKey) variant, use it. If the cache entry is the
	// same wrapper we're looking at (i.e. the wrapper itself wasn't
	// replaced this round), descend INTO its children so any descendant
	// Partial that DID get a fresh cache entry still gets swapped.
	// Without this descent, a refetch targeting a deeply-nested partial
	// lands a fresh entry but the surrounding ancestor wrappers keep
	// their old children references — so the new content never reaches
	// the rendered tree.
	if (isPartialWrapper(node)) {
		const id = getPartialId(node);
		const mk = getPartialMatchKey(node) ?? "";
		const key = `${id ?? ""}|${mk}`;
		if (id && key !== skipKey) {
			const fresh = cacheLookup(cache, id, mk);
			if (fresh && fresh !== node) {
				return substituteNested(fresh, cache, key);
			}
			// Wrapper unchanged — keep descending so nested partials whose
			// cache entries DID change still get substituted.
		}
	}

	const children = (node.props as any).children;
	if (children == null) return node;
	const newChildren = substituteNested(children, cache, skipKey);
	if (newChildren === children) return node;
	// Spread arrays as variadic — see the matching comment in
	// cache.tsx#resolveLazies. Flight-decoded children are arrays
	// even for static JSX siblings, and a bare `cloneElement(node,
	// {}, arr)` triggers React's "unique key" warning.
	return Array.isArray(newChildren)
		? cloneElement(node, {}, ...newChildren)
		: cloneElement(node, {}, newChildren);
}

const LAZY_SYMBOL_STR = "Symbol(react.lazy)";

/** Sentinel returned by `unwrapLazy` when the lazy is pending — distinct
 *  from `null` (which signaled "unwrap failed, drop the node"). Callers
 *  who recognise this keep the original lazy in place so React's native
 *  Suspense machinery resolves it; callers who don't recognise it fall
 *  back to the legacy "drop" behaviour. */
export const LAZY_PENDING = Symbol("partial-client.lazyPending");

/**
 * Unwrap a raw lazy reference at the tree level.
 *
 * Returns the resolved value when the lazy is fulfilled; `LAZY_PENDING`
 * when the underlying chunk is still in flight; `null` when the lazy
 * errored (treated as opaque).
 *
 * The pending sentinel matters for streaming hydration: the cache-walk
 * (`cacheFromStreamingChildren`) and the template-derive
 * (`deriveTemplate`) both encounter Flight lazies while early chunks
 * are still arriving. Treating pending the same as "drop" silently
 * loses the partial wrapper inside the lazy — the cache never gets
 * an entry, the template emits a bare placeholder, and `renderTemplate`
 * leaves an empty `<i hidden>` in the DOM. Returning a distinct
 * sentinel lets each caller decide: skip caching this round (the
 * lazy will be cached on a re-render when it resolves) but keep the
 * lazy in the rendered output so React resolves it natively.
 */
export function unwrapLazy(node: unknown): unknown {
	if (node == null || typeof node !== "object") return node;
	const n = node as any;
	if (typeof n.$$typeof !== "symbol") return node;
	if (n.$$typeof.toString() !== LAZY_SYMBOL_STR) return node;
	const payload = n._payload;
	if (payload && payload._status === 1) return payload._result;
	try {
		const init = n._init;
		if (typeof init === "function") {
			const result = init(payload);
			// init returned synchronously — fulfilled.
			return result;
		}
	} catch (e) {
		// A thenable throw is React's "pending" signal for lazy refs.
		// Anything else is an error we treat as opaque.
		if (
			e &&
			typeof e === "object" &&
			typeof (e as PromiseLike<unknown>).then === "function"
		) {
			return LAZY_PENDING;
		}
	}
	return null;
}

/**
 * Sentinel mutable used by `cacheFromStreamingChildren` to report
 * whether the walk encountered any pending Flight lazies. PartialsClient's
 * streaming-mode path uses this to decide: if any lazy is still in flight,
 * skip the template/derive/substitute machinery and return `children`
 * directly so the rendered tree matches the SSR HTML exactly. The cache
 * walk that DID complete is still safe to keep (any wrappers that were
 * walked are cached); a later PartialsClient render with the lazies
 * resolved will fill in the gaps.
 */
export interface LazyWalkStats {
	pending: number;
}

/**
 * Walk the streamed children tree and cache partial contents by id.
 *
 * Partials are recognized by their outermost wrapper shape (see
 * `isPartialWrapper`): a keyed `<Suspense>` or keyed
 * `<PartialErrorBoundary>`. The key is the partial id.
 *
 * We cache the wrapper AND descend into its children looking for
 * NESTED partial wrappers. Nested partials need their own top-level
 * entries so that after a parent-only refetch (which emits a
 * placeholder for the nested partial inside the parent's new
 * content), the client can still find the nested partial's content
 * by id — otherwise `substituteNested` produces an empty hole.
 *
 * Why we can descend safely: during streaming, inner async chunks
 * arrive as Flight lazies. Walking past a lazy forces React's
 * lazy-init — which is fine because the lazy will resolve
 * eventually, and our walk of the lazy's contents just searches for
 * more partial wrappers (no side effects). `unwrapLazy` returns
 * null for pending lazies, so we stop cleanly if a lazy hasn't
 * resolved yet.
 *
 * Placeholders (`<i data-partial hidden>`) are skipped — the
 * existing cache entry from a prior render is the thing we want.
 */
export function cacheFromStreamingChildren(
	node: ReactNode,
	cache: PartialCache,
	seen?: Map<string, Set<string>>,
	stats?: LazyWalkStats,
): void {
	if (node == null || typeof node === "boolean") return;
	if (typeof node === "string" || typeof node === "number") return;
	if (Array.isArray(node)) {
		for (let i = 0; i < node.length; i++) {
			cacheFromStreamingChildren(node[i] as ReactNode, cache, seen, stats);
		}
		return;
	}
	const unwrapped = unwrapLazy(node);
	if (unwrapped !== node) {
		if (unwrapped === LAZY_PENDING && stats) stats.pending++;
		// Errored OR pending lazy — can't descend to find wrappers. The
		// template-derive keeps the lazy in place so React resolves it
		// through native Suspense; a re-render after resolution will
		// populate the cache for whatever wrappers are inside.
		if (unwrapped == null || unwrapped === LAZY_PENDING) return;
		cacheFromStreamingChildren(unwrapped as ReactNode, cache, seen, stats);
		return;
	}
	if (!isValidElement(node)) return;

	if (isPartialWrapper(node)) {
		const id = getPartialId(node);
		if (id) {
			const mk = getPartialMatchKey(node) ?? "";
			if (seen) addSeen(seen, id, mk);
			cacheStore(cache, id, mk, node);
			// Populate the fingerprint map synchronously from the tree walk
			// rather than waiting for each `<PartialErrorBoundary>` to
			// commit on the client. The commit order is non-deterministic
			// across transitions (React may defer subtrees such as the
			// `<head>` wrapper), so a targeted refetch fired right after a
			// client nav could otherwise send a `?cached=` that's missing
			// late-committing ids. The wrapper already carries the
			// fingerprint — just lift it off.
			const fp = getPartialFingerprint(node);
			if (fp) registerClientPartial(id, mk, fp);
		}
		// Descend: nested partial wrappers need their own top-level cache
		// entries so subsequent parent-only refetches with inner
		// placeholders can fill the holes.
		const inner = (node.props as any)?.children;
		if (inner != null) cacheFromStreamingChildren(inner, cache, seen, stats);
		return;
	}
	if (isPlaceholder(node)) {
		// Placeholder means "server skipped this partial; client keeps
		// its existing cache entry." Don't overwrite — but DO mark the
		// (id, matchKey) pair as seen so the streaming-mode prune step
		// keeps the cache / fingerprint entries that back this placeholder.
		// Without this, a nested partial whose server confirmed an fp
		// match would be pruned out of the cache and the next
		// render's `substituteNested` call would leave the `<i hidden>`
		// placeholder in the DOM — blanking the partial's region until a
		// hard reload.
		const id = getPlaceholderId(node);
		if (id && seen) addSeen(seen, id, getPlaceholderMatchKey(node) ?? "");
		return;
	}

	const inner = (node.props as any)?.children;
	if (inner != null) {
		cacheFromStreamingChildren(inner, cache, seen, stats);
	}
}

/**
 * True if any node in the tree is a still-pending Flight lazy — i.e. the
 * render is incomplete because a chunk is in flight. Used to defer the
 * cache-mode prune past a mid-stream render so live partials hidden
 * behind an unresolved lazy aren't evicted. Mirrors the lazy-stop rule
 * in `cacheFromStreamingChildren` / `substituteNested`.
 */
export function treeHasPendingLazy(node: ReactNode): boolean {
	if (node == null || typeof node === "boolean") return false;
	if (typeof node === "string" || typeof node === "number") return false;
	if (Array.isArray(node)) {
		return node.some((c) => treeHasPendingLazy(c as ReactNode));
	}
	const unwrapped = unwrapLazy(node);
	if (unwrapped !== node) {
		if (unwrapped === LAZY_PENDING) return true;
		if (unwrapped == null) return false;
		return treeHasPendingLazy(unwrapped as ReactNode);
	}
	if (!isValidElement(node)) return false;
	return treeHasPendingLazy((node.props as { children?: ReactNode }).children);
}

/**
 * Warm the client partial cache from a decoded preload payload WITHOUT
 * committing it to the React root. Walks the tree exactly like the
 * streaming-mode commit's cache step (`cacheFromStreamingChildren`):
 * each partial wrapper's subtree lands in the partial cache and
 * its fingerprint in the fingerprint map, while placeholders
 * (the server's fp-skips for partials the client already holds) are
 * left untouched. The destination's partials are now cached, so a later
 * navigation to it fp-skips them and `renderTemplate` substitutes them
 * from cache on the first commit. Nothing mounts and the template is
 * untouched — the current page keeps rendering until the user actually
 * navigates.
 *
 * Called by the browser entry's preload transport
 * (`window.__rsc_partial_preload`), once per decoded segment. Pairs
 * with `useNavigation().preload(target)`.
 */
export function _warmCacheFromPayload(node: ReactNode): void {
	cacheFromStreamingChildren(node, getCurrentPagePartials());
}

/**
 * Commit one per-parton lane payload from a live connection: walk the
 * decoded subtree into the partial cache (the wrapper, its nested
 * partials, and their fingerprints), apply the lane's fp-trailer
 * updates, then notify subscribers so `PartialsClient` re-renders the
 * template and `substituteNested` swaps the fresh content in place.
 *
 * The walk is synchronous, so the cache write set (outer wrapper +
 * every nested entry) lands atomically before the notify — a template
 * re-render never observes a half-written commit. Callers pass a
 * fully-delivered payload (the lane body closed at its `muxend`), so
 * the walk sees resolved content; a placeholder root (the lane's
 * parton fp-skipped server-side) walks to a no-op.
 */
export function _commitPartonLane(
	node: ReactNode,
	fpUpdates: FpUpdatesPayload | null,
): void {
	cacheFromStreamingChildren(node, getCurrentPagePartials());
	if (fpUpdates) _applyFpUpdates(fpUpdates);
	notifyLaneCommit();
}

/**
 * Apply the `<!--fp-trailer:JSON-->` comment the server appends after
 * `</html>` (see `wrapSsrStreamWithFpTrailer` in `lib/fp-trailer.ts`).
 *
 * The HTML parser places the comment as a `Document` child (alongside
 * `documentElement`) or, in some browsers, as a `documentElement`
 * child. We scan both lists and apply any update map we find.
 *
 * The hydration entry calls this at startup, but on a streaming HTML
 * response the parser may not have reached the trailing comment yet —
 * `document.readyState` is `"interactive"` (DOMContentLoaded fired)
 * but the after-html comments are still in flight. In that case we
 * defer to the `load` event, which only fires once the parser has
 * fully consumed the response body (including the trailing comment).
 *
 * Calling once on startup AND again on `load` is safe: registration
 * is set-additive, so re-applying the same map is a no-op. Calling
 * on startup catches the common case (non-streaming response that
 * arrives complete); the `load` listener covers the streaming case
 * where the comment lands late.
 */
function tryApplyTrailerNow(): boolean {
	const tag = "fp-trailer:";
	const candidates: Node[] = [];
	for (const c of document.childNodes) candidates.push(c);
	if (document.documentElement) {
		for (const c of document.documentElement.childNodes) candidates.push(c);
	}
	for (const node of candidates) {
		if (node.nodeType !== 8 /* COMMENT_NODE */) continue;
		const text = (node as Comment).data;
		if (!text.startsWith(tag)) continue;
		try {
			const json = text.slice(tag.length).replace(/-\\-/g, "--");
			const updates = JSON.parse(json) as FpUpdatesPayload;
			_applyFpUpdates(updates);
			return true;
		} catch {
			return false;
		}
	}
	return false;
}

export function _applyFpTrailerFromDocument(): void {
	if (tryApplyTrailerNow()) return;
	if (typeof window === "undefined") return;
	// Streaming HTML: the trailing comment may not have been parsed
	// into the DOM yet. The parser is fully done at the `load` event,
	// so retry there. DOMContentLoaded fires earlier — for some browsers
	// BEFORE post-`</html>` comments are committed — so we wait for
	// `load`, which is guaranteed to fire after the entire response has
	// been consumed.
	//
	// If `load` already fired (this code runs late on a slow-hydration
	// path), one more synchronous attempt picks up the comment that
	// landed between our two scans.
	if (document.readyState === "complete") {
		tryApplyTrailerNow();
		return;
	}
	window.addEventListener("load", () => tryApplyTrailerNow(), { once: true });
}
