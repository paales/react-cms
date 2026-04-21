import { Suspense, cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
// `cloneElement` is still used for the defer-activator injection path
// below (cloning `<WhenVisible/>` with `{partialId}`). The Partial body
// itself never clones content with prop overrides — there is no
// `__inputs` mechanism on the client.
import {
  getCurrentFrameScope,
  getRequest,
  setCurrentFrameScope,
} from "../framework/context.ts";
import { getSessionFrameUrl } from "../framework/session.ts";
import { registerPartial } from "./partial-registry.ts";
import { PartialErrorBoundary } from "./partial-error-boundary.tsx";
import { FrameNameProvider } from "./partial-client.tsx";
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
  frame,
  frameUrl,
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
  frame?: string;
  frameUrl?: string;
  children: ReactNode;
}): ReactNode {
  const route = new URL(getRequest().url).pathname;
  registerPartial(route, id, {
    content,
    fallback,
    errorWith,
    tags,
    cache,
    frame,
    frameUrl,
  });
  return children;
}

/**
 * Defer specification for `<Partial defer=…>`.
 *
 * - `true` — server emits fallback only; Partial is dormant until
 *   something in the app calls `useNavigation().reload({ids: [id]})`
 *   (or uses `useActivate` with a custom subscriber). The framework
 *   does not install any trigger; the caller owns wiring.
 * - `ReactElement` — an activator component. The framework clones it
 *   with `{partialId: id}` and passes the Partial's fallback as
 *   children. The activator is responsible for triggering a targeted
 *   reload when its condition fires — `useActivate(partialId, …)` is
 *   the primitive. Authors write their own activators — see
 *   `src/app/components/when-visible.tsx` / `when-stored.tsx` in the
 *   demo app for reference implementations.
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
  /**
   * Unique-per-page identifier. Addressable via
   * `useNavigation().reload({ids: ["id"]})`. Optional when `tags` is
   * provided — an id-less Partial synthesizes `__anon:<sorted-tags>`
   * internally and can only be refetched via a tag refresh
   * (`useNavigation().reload({tags: ["…"]})`).
   */
  id?: string;
  children?: ReactNode;
  /**
   * Non-unique labels. Accepts an array or a whitespace-separated
   * string (`"price product"` ≡ `["price", "product"]`), same shape as
   * DOM `className`. Used for family-wide refetch/invalidation:
   * `useNavigation().reload({tags: ["price"]})` refetches every
   * Partial with the `price` tag; passing multiple tags refetches
   * their union.
   */
  tags?: string | string[];
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
  /**
   * Open a new **frame** scope for this Partial's descendants. Frames
   * are "server iframes": everything inside the Partial resolves
   * tracked accessors (`getSearchParam`, `getPathname`, `getCookie`,
   * `getHeader`) against the FRAME's URL instead of the page URL.
   *
   * The `frame` value names the frame for session lookup and client-
   * side navigation (`frame("cart").navigate(…)` — see task 4). The
   * URL the accessors resolve against is picked in this order:
   *
   *   1. The server session's entry for this frame name (task 3).
   *   2. `frameUrl` prop (author-provided initial URL).
   *   3. The page URL (identity — the frame and page agree).
   *
   * See `notes/FRAME_SCOPING.md` for why this is a React Context and
   * not an ALS scope. The hoisting rule (read accessors before any
   * `await`) applies the same way it does for the cache manifest.
   */
  frame?: string;
  /**
   * Initial URL for the frame. Used as the fallback when the session
   * has no entry for this frame. Ignored when `frame` is not set.
   *
   * Accepts a full URL, a pathname, or a search string. Normalized
   * against the page's origin.
   */
  frameUrl?: string;
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
 * Normalize a `tags` prop (array OR whitespace-separated string) into a
 * deduplicated string array. Empty / all-whitespace input yields `[]`.
 */
export function normalizeTags(input: string | string[] | undefined): string[] {
  if (input == null) return [];
  const raw = Array.isArray(input) ? input : input.split(/\s+/);
  const out: string[] = [];
  for (const t of raw) {
    const trimmed = t.trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

/**
 * Resolve the effective id for a Partial. If the author passed an `id`
 * prop, use it. Otherwise synthesize one from sorted tags — lets
 * anonymous Partials still register / skip / cache under a stable key.
 * Throws if neither id nor tags is usable (there's no way to address
 * the Partial at all).
 */
function resolveEffectiveId(
  rawId: string | undefined,
  tags: string[],
): string {
  if (rawId) return rawId;
  if (tags.length === 0) {
    throw new Error(
      "<Partial> requires either `id` or `tags`. An id-less Partial needs " +
        "at least one tag so it can be addressed via " +
        "`useNavigation().reload({tags: [\"...\"]})`.",
    );
  }
  return `__anon:${[...tags].sort().join(",")}`;
}

/**
 * Resolve a frame's Request object. Lookup order:
 *   1. Server session entry for this frame (source of truth).
 *   2. `frameUrl` prop (author-provided initial URL).
 *   3. Page request (frame and page agree — no-op frame).
 *
 * Request headers are copied from the page so cookie reads inside
 * the frame still work (cookies live on the response, not per-frame).
 */
function resolveFrameRequest(
  frameName: string,
  initialUrl: string | undefined,
): Request {
  const pageRequest = getRequest();
  const sessionUrl = getSessionFrameUrl(frameName);
  const effective = sessionUrl ?? initialUrl;
  if (effective == null) return pageRequest;
  const resolved = new URL(effective, pageRequest.url).toString();
  return new Request(resolved, {
    headers: pageRequest.headers,
    method: "GET",
  });
}

/**
 * Async server component that opens a frame ALS scope and renders
 * children through a Flight round-trip so descendant async renders
 * execute inside the scope. Defers the framing from the Partial's
 * synchronous body to a proper render-time step, so the snapshot
 * captures the wrapper (re-renderable) instead of the bake.
 */
function FrameWrapper({
  name,
  request,
  children,
}: {
  name: string;
  request: Request;
  children: ReactNode;
}): ReactNode {
  // Mutate the per-request frame-scope cell BEFORE React walks our
  // children, so descendants that read tracked accessors (at the
  // top of their body, before any `await`) see this frame's URL.
  //
  // React.cache-backed mutation — the library pattern at
  // https://github.com/zhangyu1818/react-server-only-context. Cheap,
  // streams naturally (no Flight round-trip), subject to the same
  // "read before await" discipline as the cache manifest
  // accessors (which this extends).
  setCurrentFrameScope({ name, request });
  const url = new URL(request.url);
  const initialUrl = url.pathname + url.search;
  return (
    <FrameNameProvider name={name} initialUrl={initialUrl}>
      {children}
    </FrameNameProvider>
  );
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
  id: rawId,
  children,
  fallback,
  errorWith,
  tags,
  defer,
  cache,
  frame,
  frameUrl,
}: PartialProps): ReactNode {
  const state = requirePartialState();

  const effectiveTags = normalizeTags(tags);
  const id = resolveEffectiveId(rawId, effectiveTags);

  if (state.seenIds.has(id)) {
    throw new Error(
      rawId
        ? `Duplicate partial id "${id}". Partial ids must be unique per page.`
        : `Duplicate anonymous <Partial> with tags [${effectiveTags.join(", ")}]. ` +
          `Two id-less Partials synthesized the same internal id — add an explicit ` +
          `id to at least one, or give them distinguishing tags.`,
    );
  }
  state.seenIds.add(id);

  const isExplicit = state.explicitIds.has(id);
  const effectiveFallback = fallback ?? null;

  const rawContent = children;

  // Frame scope: if `frame` is set, wrap the children in a
  // `<FrameWrapper>` component that does the Flight round-trip when
  // it renders. That way:
  //
  //   1. The registry snapshot carries the UNFRAMED children (the
  //      wrapper JSX) — cache-mode refetches can replay them through
  //      a fresh frame scope with the current session URL, instead
  //      of reusing the baked content from the original render.
  //   2. The frame's Request is passed as a prop to FrameWrapper, so
  //      it's computed per-render against (session → frameUrl prop
  //      → page URL).
  //
  // See `notes/FRAME_SCOPING.md` — RSC rules out React Context (no
  // `createContext` in the react-server build), so the nested scope
  // has to be ALS-with-containment (Flight round-trip keeps the
  // scope from leaking to siblings).
  const frameRequest =
    frame != null ? resolveFrameRequest(frame, frameUrl) : null;
  const content: ReactNode =
    frame != null && frameRequest != null ? (
      <FrameWrapper name={frame} request={frameRequest}>
        {rawContent}
      </FrameWrapper>
    ) : (
      rawContent
    );

  // Fingerprint captures the structural shape of the content tree —
  // used both for the client→server "did this change?" handshake and
  // for registering the snapshot so nav-time skip decisions are stable.
  //
  // Frame URL folding:
  //   - Own frame (this Partial declares `frame=…`): fold the frame's
  //     URL so a frame-URL change produces a distinct fp and the
  //     fingerprint-match skip path re-renders the frame contents.
  //   - Ambient frame (this Partial sits INSIDE a `<Partial frame=…>`
  //     ancestor): fold the enclosing frame's URL for the same reason —
  //     nested Partials' structural fp doesn't capture URL-derived
  //     state read via `getSearchParam` / `getPathname` inside their
  //     body, so without this fold a stage Partial inside a frame
  //     whose URL changed would match its prior fp and skip, leaving
  //     the client with stale cached bytes.
  const ownFrameKey =
    frame != null && frameRequest != null
      ? `|frame=${frame}:${frameRequest.url}`
      : "";
  const ambientScope = getCurrentFrameScope();
  const ambientFrameKey =
    ambientScope && ambientScope.name !== frame
      ? `|inFrame=${ambientScope.name}:${ambientScope.request.url}`
      : "";
  const fp = hashFingerprint(
    fingerprintElement(rawContent) + ownFrameKey + ambientFrameKey,
  );

  // ── Skip decisions ─────────────────────────────────────────────────
  //
  // Skip when the client already has content the server would
  // re-produce. That's determined per-Partial by the fingerprint
  // handshake: `?cached=id:fp,…` lists what the client has; we skip
  // (emit a placeholder) when fp matches.
  //
  // History: earlier revisions tried `isPartialRefetch ? true` and
  // then `isPartialRefetch ? clientHasCache`. Both are too aggressive
  // when a refetch re-renders a parent whose new content carries
  // DIFFERENT nested-partial props — the nested partial's new
  // fingerprint differs from the cached one, but the old logic
  // skipped anyway and the client held the stale body. Frame
  // navigation trips this: `frame("search").navigate("/search/open?q=pika")`
  // refetches id="search" and inside that the `frame-stage-1` body
  // goes from `<SearchStage1 query="">` (A) to `<SearchStage1
  // query="pika">` (B) — fingerprint changes, content must not skip.
  // Skip only on an actual fingerprint match.
  const cachedFp = state.cachedFingerprints.get(id);
  const fingerprintMatches = cachedFp != null && cachedFp === fp;

  const shouldSkip = isExplicit ? false : fingerprintMatches;

  if (shouldSkip) {
    // Register so tag refetches / subsequent lookups still find the
    // partial, even though we didn't render it this pass. Store the
    // unframed children (`rawContent`), not the wrapped content — on
    // refetch the wrapper re-renders fresh with the current frame
    // URL from session.
    const route = new URL(getRequest().url).pathname;
    registerPartial(route, id, {
      content: rawContent,
      fallback: effectiveFallback,
      errorWith,
      tags: effectiveTags,
      cache,
      frame,
      frameUrl,
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
        content={rawContent}
        fallback={effectiveFallback}
        errorWith={errorWith}
        tags={effectiveTags}
        cache={cache}
        frame={frame}
        frameUrl={frameUrl}
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
      content={rawContent}
      fallback={effectiveFallback}
      errorWith={errorWith}
      tags={effectiveTags}
      cache={cache}
      frame={frame}
      frameUrl={frameUrl}
    >
      {rendered}
    </PartialBoundary>
  );
}
