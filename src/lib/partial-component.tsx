import { Suspense, cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { getRequest } from "../framework/context.ts";
import { registerPartial } from "./partial-registry.ts";
import { PartialErrorBoundary } from "./partial-error-boundary.tsx";
import { requirePartialState } from "./partial-request-state.ts";
import { djb2 as hashFingerprint } from "./hash.ts";
import { Cache } from "./cache.tsx";
import type { CacheOptions } from "./cache-options.ts";

/**
 * Recognizable wrapper around a rendered Partial.
 *
 * Two server-side side-effects:
 *   1. Gives `<Cache>` a stable element type to identify
 *      partial-bearing subtrees so they can be stripped to placeholders
 *      before the cache entry is serialized.
 *   2. Self-registers its content descriptor into the route-scoped
 *      registry so a later refetch for this id can render the snapshot
 *      directly without re-executing ancestors.
 */
export function PartialBoundary({
  id,
  content,
  fallback,
  errorWith,
  tags,
  cache,
  children,
}: {
  id: string;
  /** Original children of the `<Partial>` — stored in the registry so
   *  a refetch can render it directly. */
  content: ReactNode;
  fallback: ReactNode;
  errorWith: ReactNode | undefined;
  tags: string[];
  cache?: CacheOptions;
  children: ReactNode;
}): ReactNode {
  const route = new URL(getRequest().url).pathname;
  registerPartial(route, id, {
    content,
    fallback,
    errorWith,
    tags,
    cache,
  });
  return children;
}

/**
 * Defer specification for `<Partial defer=…>`.
 *
 * - `true` — server emits fallback only; Partial is dormant until
 *   something in the app calls `usePartial(id).refetch()`. The
 *   framework does not install any trigger; the caller owns wiring.
 * - `ReactElement` — an activator component. The framework clones it
 *   with `{partialId: id}` and passes the Partial's fallback as
 *   children. The activator is responsible for calling
 *   `usePartial(partialId)[0]()` when its condition fires. See
 *   `WhenVisible` / `WhenStored` for canonical implementations.
 */
export type DeferSpec = true | ReactElement<ActivatorProps>;

/**
 * Contract every `defer={<Activator/>}` component must meet. Both props
 * are INJECTED by `<Partial>` via `cloneElement` — custom activators
 * should type them as optional on the public API (author doesn't set
 * them) but treat them as required at runtime.
 */
export interface ActivatorProps {
  /** The id of the enclosing `<Partial>`. Injected. */
  partialId?: string;
  /** The Partial's fallback, to render while dormant. Injected. */
  children?: ReactNode;
}

export interface PartialProps {
  id: string;
  children?: ReactNode;
  tags?: string[];
  /**
   * Server-side render-output caching. Shape follows HTTP
   * `Cache-Control`: `{maxAge, staleWhileRevalidate, vary?, bypass?}`.
   *
   * Presence of the prop opts into caching. The cache key is derived
   * automatically from request state the Partial body reads through
   * the tracked accessor surface (`getCookie`, `getHeader`,
   * `getSearchParam`, `getPathname`) plus any scalar values passed as
   * `cache.vary`. See `notes/AUTO_TRACKED_CACHE_KEYS.md`.
   */
  cache?: CacheOptions;
  /**
   * Framework-provided display when the Partial isn't showing its
   * real content. Two activation paths:
   *   1. Async content: shown as Suspense fallback while children
   *      resolve (auto-wraps in `<Suspense>`).
   *   2. Deferred content (`defer` prop): shown in place of children
   *      until the activator fires a refetch.
   */
  fallback?: ReactNode;
  /**
   * Error boundary fallback. Shown if the partial's rendering throws.
   * If omitted, a built-in red card with a retry button is used.
   */
  errorWith?: ReactNode;
  /**
   * Opt into deferred rendering. See `DeferSpec` for the two forms.
   * When set AND this id wasn't explicitly requested on the current
   * refetch, the Partial emits the fallback (optionally wrapped by
   * the activator) instead of executing its children.
   */
  defer?: DeferSpec;
}

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Lightweight structural fingerprint of the Partial's children tree.
 * Walks as plain data — no component functions are called. Captures
 * component names and scalar props so a nav where nothing in the tree
 * changed hashes to the same value.
 */
function fingerprintElement(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(fingerprintElement).join(",");
  if (!isValidElement(node)) return "";

  const type =
    typeof node.type === "string"
      ? node.type
      : (node.type as { displayName?: string; name?: string }).displayName ||
        (node.type as { name?: string }).name ||
        "Anonymous";

  const props = node.props as Record<string, unknown>;
  const parts: string[] = [type];

  if (node.key != null) parts.push(`k=${node.key}`);

  for (const [k, v] of Object.entries(props)) {
    if (k === "children") continue;
    if (typeof v === "function") continue;
    if (typeof v === "object" && v !== null) continue;
    parts.push(`${k}=${v}`);
  }

  if (props.children != null) {
    parts.push(`(${fingerprintElement(props.children as ReactNode)})`);
  }

  return parts.join("|");
}

/**
 * Apply `__inputs` overrides to a Partial's content. If content is a
 * single element, clone it with the overrides as new props. Otherwise
 * returns content unchanged — overrides require a single root child.
 */
function applyInputs(
  content: ReactNode,
  overrides: Record<string, unknown>,
): ReactNode {
  if (isValidElement(content)) {
    return cloneElement(content as ReactElement, overrides);
  }
  return content;
}

function placeholderFor(id: string): ReactElement {
  // `data-partial-id` is the authoritative source for the id on the
  // client walks. Flight sometimes composites the outer .map() key
  // with the element's own key into `"outer,inner"`, which would
  // break id-lookup by `String(node.key)` for placeholders emitted
  // inside a `.map()`-produced Partial.
  return (
    <i key={id} hidden data-partial data-partial-id={id} />
  );
}

// ─── The Partial component ──────────────────────────────────────────────

/**
 * Marker wrapper for a re-renderable fragment of a page.
 *
 * Every call to `<Partial>` runs this body — whether the Partial is
 * declared statically at the top of a route or generated dynamically
 * inside a `.map()`. That means "deep Partials" inside opaque
 * function components are first-class; there's no static walker to
 * miss them.
 */
export function Partial({
  id,
  children,
  fallback,
  errorWith,
  tags,
  defer,
  cache,
}: PartialProps): ReactNode {
  const state = requirePartialState();

  if (state.seenIds.has(id)) {
    throw new Error(
      `Duplicate partial id "${id}". Partial ids must be unique per page.`,
    );
  }
  state.seenIds.add(id);

  const override = state.partialInputs[id];
  const isExplicit = state.explicitIds.has(id);
  const effectiveTags = tags ?? [];
  const effectiveFallback = fallback ?? null;

  // Fingerprint captures the structural shape of the children tree —
  // used both for the client→server "did this change?" handshake and
  // for registering the snapshot so nav-time skip decisions are stable.
  const fp = hashFingerprint(fingerprintElement(children));

  // Apply __inputs override (if any) for both the rendered content
  // and the registered snapshot, so a later refetch replays with the
  // already-applied props.
  const content = override ? applyInputs(children, override) : children;

  // ── Skip decisions ─────────────────────────────────────────────────
  const cachedFp = state.cachedFingerprints.get(id);
  const fingerprintMatches = cachedFp != null && cachedFp === fp;

  const shouldSkip = isExplicit
    ? false
    : state.isPartialRefetch
      ? true
      : fingerprintMatches;

  if (shouldSkip) {
    // Register so tag refetches / subsequent lookups still find the
    // partial, even though we didn't render it this pass.
    const route = new URL(getRequest().url).pathname;
    registerPartial(route, id, {
      content,
      fallback: effectiveFallback,
      errorWith,
      tags: effectiveTags,
      cache,
    });
    return placeholderFor(id);
  }

  // ── Defer branch ───────────────────────────────────────────────────
  if (defer && !isExplicit) {
    const dormant =
      defer === true
        ? effectiveFallback
        : isValidElement(defer)
          ? cloneElement(
              defer as ReactElement<ActivatorProps>,
              { partialId: id },
              effectiveFallback,
            )
          : effectiveFallback;

    return (
      <PartialBoundary
        id={id}
        content={content}
        fallback={effectiveFallback}
        errorWith={errorWith}
        tags={effectiveTags}
        cache={cache}
      >
        <PartialErrorBoundary
          key={id}
          partialId={id}
          partialFingerprint={fp}
          fallback={errorWith}
        >
          {dormant}
        </PartialErrorBoundary>
      </PartialBoundary>
    );
  }

  // ── Cache (server-side render-output caching) ─────────────────────
  //
  // When `cache` is set, wrap the content in a `<Cache>` element so
  // the Suspense boundary below treats the (async) Cache render the
  // same way it treats any other async server component. Cache opens
  // its own manifest ALS scope so tracked accessor reads inside the
  // content populate an access manifest; that manifest is what keys
  // the cached bytes. The Partial id + structural fingerprint form
  // the stable "which Partial is this?" half of the key; manifest
  // values + `cache.vary` form the "which snapshot?" half.
  const cachedContent: ReactNode =
    cache !== undefined ? (
      <Cache id={id} fingerprint={fp} options={cache}>
        {content}
      </Cache>
    ) : (
      content
    );

  // ── Render ─────────────────────────────────────────────────────────
  //
  // Wrap in Suspense ONLY when the caller provided a fallback.
  const rendered =
    effectiveFallback != null ? (
      <Suspense
        key={id}
        fallback={
          <PartialErrorBoundary
            partialId={id}
            partialFingerprint={fp}
            fallback={errorWith}
          >
            {effectiveFallback}
          </PartialErrorBoundary>
        }
      >
        <PartialErrorBoundary
          partialId={id}
          partialFingerprint={fp}
          fallback={errorWith}
        >
          {cachedContent}
        </PartialErrorBoundary>
      </Suspense>
    ) : (
      <PartialErrorBoundary
        key={id}
        partialId={id}
        partialFingerprint={fp}
        fallback={errorWith}
      >
        {cachedContent}
      </PartialErrorBoundary>
    );

  return (
    <PartialBoundary
      id={id}
      content={content}
      fallback={effectiveFallback}
      errorWith={errorWith}
      tags={effectiveTags}
      cache={cache}
    >
      {rendered}
    </PartialBoundary>
  );
}
