import {
  Suspense,
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
// `cloneElement` is still used for the defer-activator injection path
// below (cloning `<WhenVisible/>` with `{partialId}`). The Partial body
// itself never clones content with prop overrides — there is no
// `__inputs` mechanism on the client.
import {
  _setCurrentCmsScope,
  getCurrentFrameScope,
  getRequest,
  setCurrentFrameScope,
} from "../framework/context.ts";
import {
  cmsFingerprintContribution,
  createCmsScope,
} from "../framework/cms-runtime.ts";
import { getSessionFrameUrl } from "../framework/session.ts";
import { registerPartial } from "./partial-registry.ts";
import { PartialErrorBoundary } from "./partial-error-boundary.tsx";
import { FrameNameProvider } from "./partial-client.tsx";
import { requirePartialState } from "./partial-request-state.ts";
import { djb2 as hashFingerprint } from "./hash.ts";
import { Cache } from "./cache.tsx";
import type { CacheOptions } from "./cache-options.ts";
import {
  _childContext,
  _setCurrentPartialContext,
  type PartialCtx,
} from "./partial-context.ts";

const EMPTY_PATH: readonly string[] = Object.freeze([]) as readonly string[];

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
  parentPath,
  content,
  fallback,
  errorWith,
  uniqueTokens,
  sharedTokens,
  cache,
  framePath,
  frameUrl,
  cmsId,
  children,
}: {
  id: string;
  /** Outer-first chain of ancestor partial ids, from the `parent`
   *  prop. Recorded in the registry so the server knows the full
   *  hierarchy — see `src/lib/partial-context.ts`. */
  parentPath: readonly string[];
  /** Original children of the `<Partial>` — stored in the registry so
   *  a refetch can render it directly. */
  content: ReactNode;
  fallback: ReactNode;
  errorWith: ReactNode | undefined;
  uniqueTokens: string[];
  sharedTokens: string[];
  cache?: CacheOptions;
  /** Canonical dotted-path of every enclosing `<Partial frame>`
   *  ancestor plus this Partial's local `frame` name. Empty when
   *  this Partial doesn't open a frame. */
  framePath: readonly string[];
  frameUrl?: string;
  /** Stable CMS storage key, preserved so cache-mode refetches
   *  reconstruct the Partial with the same `cmsId` and descendant
   *  content accessors resolve against the same node. */
  cmsId?: string;
  children: ReactNode;
}): ReactNode {
  const route = new URL(getRequest().url).pathname;
  registerPartial(route, id, {
    content,
    fallback,
    errorWith,
    uniqueTokens,
    sharedTokens,
    cache,
    framePath,
    frameUrl,
    parentPath,
    cmsId,
  });
  return children;
}

/**
 * Defer specification for `<Partial defer=…>`.
 *
 * - `true` — server emits fallback only; Partial is dormant until
 *   something in the app calls `useNavigation().reload({selector: "#id"})`
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

export type SelectorToken = `${"#" | "."}${string}`;

export interface PartialProps {
  /**
   * Parent context token identifying where this Partial sits in the
   * server-side render tree. **Required.**
   *
   * Top-level Partials (not nested inside any other Partial) pass
   * `ROOT`. Nested Partials pass either the `parent` threaded down as
   * a prop from an ancestor component, or the result of
   * `capturePartialContext()` called in a synchronous code path.
   *
   * Why required: RSC renders async components in a different
   * traversal order than the JSX tree suggests (React moves to
   * siblings when a parent awaits), so a single React.cache-backed
   * "current parent" cell drifts unpredictably. Explicit threading is
   * the only way to track the full hierarchy server-side today;
   * `AsyncContext` (TC39 proposal) will eventually eliminate this
   * requirement.
   *
   * See `src/lib/partial-context.ts` for the full pattern and the
   * async-hoisting discipline.
   */
  parent: PartialCtx;
  /**
   * CSS-style selector identifying this Partial. A space-separated list
   * (or array) of tokens, each prefixed:
   *
   *   - `#foo` — unique token; must appear on exactly one Partial per
   *     page. Second occurrence throws synchronously during render.
   *   - `.foo` — shared label; any number of Partials may carry it.
   *
   * Examples:
   *   <Partial selector="#cart">                   // unique
   *   <Partial selector=".price .product">         // shared labels only
   *   <Partial selector="#page-3 .pagination">     // both
   *   <Partial selector=".ad-slot">                // anonymous (addressable only via .ad-slot)
   *
   * Addressable via `useNavigation().reload({selector: "#cart"})` for a
   * single Partial (`#`-token lookup), or `.price` for a union across
   * every Partial carrying the label.
   *
   * A Partial without any `#`-token is internally keyed on its sorted
   * `.class` tokens (`__anon:.class1,.class2`) so it still has a stable
   * registry id; two id-less Partials with the same sorted classes
   * collide and throw — give them a distinguishing class or a `#`-token.
   */
  selector: SelectorToken | SelectorToken[];
  children?: ReactNode;
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
   * side navigation (`useNavigation("cart").navigate(…)` — see task 4). The
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
  /**
   * Stable storage key for this Partial's CMS-authored content. When
   * set, opens a **CMS scope** for descendant server components so
   * calls to `getText` / `getEnum` / `getNumber` / … resolve against
   * this Partial's entry in the content store.
   *
   * Independent of `selector`: the selector is a mutable presentation
   * token authors can rename at any time; the `cmsId` is the
   * permanent storage anchor — rename-safe by construction. See
   * `notes/CMS_MANIFEST.md` § cmsId.
   *
   * When absent (the common case for today's Partials), the Partial
   * is NOT CMS-aware: any content accessor called inside returns its
   * empty / default value, and no scope is opened.
   *
   * A Partial without `cmsId` explicitly clears any ancestor CMS
   * scope — content accessors inside an inner non-CMS Partial never
   * leak to its cmsId-bearing ancestor's node.
   */
  cmsId?: string;
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
 * Parsed form of a `selector` prop.
 *
 *   uniqueTokens — `#`-token names, without the `#` prefix
 *   sharedTokens — `.`-token names, without the `.` prefix
 *
 * Both arrays are de-duplicated and preserve first-seen order.
 */
export interface ParsedSelector {
  uniqueTokens: string[];
  sharedTokens: string[];
}

/**
 * Parse a `selector` prop value into unique (`#`) and shared (`.`)
 * token lists. Accepts a space-separated string OR an array (items
 * are space-joined internally, matching the `clsx` pattern).
 *
 * Every token MUST start with `#` or `.` — bare words throw. Empty /
 * all-whitespace input throws.
 */
export function parseSelector(input: string | string[]): ParsedSelector {
  if (input == null) {
    throw new Error(
      "<Partial> requires a `selector` prop with at least one `#` or `.` token.",
    );
  }
  // String form splits on whitespace (className-style).
  // Array form treats each element as one token (values with spaces
  // survive — useful for SKUs, slugs, etc.). Individual elements are
  // still trimmed of leading/trailing whitespace.
  const tokens = Array.isArray(input)
    ? input.map((t) => (typeof t === "string" ? t.trim() : "")).filter(Boolean)
    : input
        .split(/\s+/)
        .map((t) => t.trim())
        .filter(Boolean);
  if (tokens.length === 0) {
    throw new Error(
      "<Partial selector> is empty. Provide at least one `#foo` or `.foo` token.",
    );
  }
  const uniqueTokens: string[] = [];
  const sharedTokens: string[] = [];
  for (const tok of tokens) {
    if (tok.startsWith("#")) {
      const name = tok.slice(1);
      if (!name) {
        throw new Error(
          `Empty "#" token in <Partial selector>. Tokens must name something after the prefix.`,
        );
      }
      if (!uniqueTokens.includes(name)) uniqueTokens.push(name);
    } else if (tok.startsWith(".")) {
      const name = tok.slice(1);
      if (!name) {
        throw new Error(
          `Empty "." token in <Partial selector>. Tokens must name something after the prefix.`,
        );
      }
      if (!sharedTokens.includes(name)) sharedTokens.push(name);
    } else {
      throw new Error(
        `Unprefixed token "${tok}" in <Partial selector>. Tokens must start ` +
          `with "#" (unique) or "." (shared). Did you mean "#${tok}" or ".${tok}"?`,
      );
    }
  }
  return { uniqueTokens, sharedTokens };
}

/**
 * Resolve the effective id for a Partial given its parsed selector.
 *
 *   - exactly one `#`-token → that token's name (canonical case)
 *   - multiple `#`-tokens    → sorted names joined with "," (multi-# keying)
 *   - zero `#`-tokens        → `__anon:<sorted-.class-tokens>`
 *
 * The effective id is what indexes the registry, the client cache,
 * and the cache-key prefix. `#`-token lookup at refetch time is a
 * scan over snapshot `uniqueTokens`, not a direct lookup on this id.
 */
function resolveEffectiveId(parsed: ParsedSelector): string {
  const { uniqueTokens, sharedTokens } = parsed;
  if (uniqueTokens.length === 1) return uniqueTokens[0];
  if (uniqueTokens.length > 1) return [...uniqueTokens].sort().join(",");
  return `__anon:${[...sharedTokens].sort().join(",")}`;
}

/**
 * Resolve a frame's Request object. Lookup order:
 *   1. Server session entry for this frame path (source of truth).
 *   2. `frameUrl` prop (author-provided initial URL).
 *   3. Page request (frame and page agree — no-op frame).
 *
 * Request headers are copied from the page so cookie reads inside
 * the frame still work (cookies live on the response, not per-frame).
 */
function resolveFrameRequest(
  framePath: readonly string[],
  initialUrl: string | undefined,
): Request {
  const pageRequest = getRequest();
  const sessionUrl = getSessionFrameUrl(framePath);
  const effective = sessionUrl ?? initialUrl;
  if (effective == null) return pageRequest;
  const resolved = new URL(effective, pageRequest.url).toString();
  return new Request(resolved, {
    headers: pageRequest.headers,
    method: "GET",
  });
}

/**
 * Server component that opens a frame scope before rendering
 * children. Mutates the per-request React.cache-backed cell so
 * descendants see the frame via `getCurrentFrameScope()`.
 *
 * Known sharp edge: the cell is a per-request singleton, so the
 * mutation persists until another FrameWrapper (or an explicit
 * caller) overwrites it. React 19 renders sibling async server
 * components concurrently, so a sibling subtree that runs after
 * this mutation may observe this frame's scope even though it's not
 * actually nested inside.
 *
 * The fingerprint consequence of that leak is addressed in two
 * layers (see `notes/FRAME_SCOPING.md` §Sharp edge): `<Partial
 * cache>`'s cache key uses `structuralFp` which excludes ambient,
 * and a Partial that opens its own frame skips `ambientFrameKey`
 * entirely — the sibling leak can't corrupt its own fp.
 *
 * What remains: descendant server components that read tracked
 * accessors AFTER an `await` may observe a sibling-mutated scope.
 * The "read before await" discipline (same rule as cache manifest
 * hoisting) handles it. Full containment via a Flight-round-trip
 * FrameWrapper (save scope → render children inside the await →
 * restore scope) has its own regressions in the current RSC bundle
 * — punted.
 */
function FrameWrapper({
  path,
  request,
  children,
}: {
  path: readonly string[];
  request: Request;
  children: ReactNode;
}): ReactNode {
  setCurrentFrameScope({ path, request });
  const url = new URL(request.url);
  const initialUrl = url.pathname + url.search;
  return (
    <FrameNameProvider path={path} initialUrl={initialUrl}>
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
  return <i key={id} hidden data-partial data-partial-id={id} />;
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
  parent,
  selector,
  children,
  fallback,
  errorWith,
  defer,
  cache,
  frame,
  frameUrl,
  cmsId,
}: PartialProps): ReactNode {
  if (parent == null || !Array.isArray(parent.path)) {
    throw new Error(
      `<Partial> requires a \`parent\` prop. Pass \`ROOT\` at the top of ` +
        `the tree or \`capturePartialContext()\` (in a sync code path) / ` +
        `the \`parent\` received from an ancestor (across any \`await\`). ` +
        `See src/lib/partial-context.ts.`,
    );
  }
  const state = requirePartialState();

  const parsed = parseSelector(selector);
  const { uniqueTokens, sharedTokens } = parsed;
  const id = resolveEffectiveId(parsed);

  // Cross-Partial `#`-token uniqueness. A `#cart` on two Partials is an
  // error even if their full selectors differ — the whole point of `#`
  // is opt-in uniqueness, and a repeat is a naming collision regardless
  // of which Partial's effective id wins.
  for (const tok of uniqueTokens) {
    if (state.seenUniqueTokens.has(tok)) {
      throw new Error(
        `Duplicate "#${tok}" selector. Tokens starting with "#" must be unique per page.`,
      );
    }
    state.seenUniqueTokens.add(tok);
  }

  // Effective-id duplicate — only reachable for anonymous Partials
  // whose `__anon:<sorted-classes>` collides. Two explicit `#`-token
  // sets can't collide here without the per-token check above firing
  // first.
  if (state.seenIds.has(id)) {
    throw new Error(
      uniqueTokens.length > 0
        ? `Duplicate partial effective id "${id}". This should be unreachable — please file a bug.`
        : `Duplicate anonymous <Partial> with selector ".${sharedTokens.join(" .")}". ` +
            `Two id-less Partials synthesized the same internal id — add a distinguishing ` +
            `class token or a "#" token to at least one.`,
    );
  }
  state.seenIds.add(id);

  // Push our own context onto the per-request cell BEFORE rendering
  // children. Descendants in sync code paths can read it via
  // `capturePartialContext()`; descendants across an await must have
  // captured earlier and threaded `parent` explicitly (the cell is
  // unreliable post-await due to RSC sibling interleaving).
  _setCurrentPartialContext(_childContext(parent, id, frame));

  // CMS scope: mutate the per-request cell so descendant server
  // components' content accessors (`getText` et al.) resolve against
  // this Partial's store entry. If `cmsId` is absent, explicitly
  // clear the cell — otherwise a CMS-aware ancestor's scope would
  // leak into this Partial's non-CMS descendants. Same
  // sibling-interleaving caveat as the partial-context and
  // frame-scope cells: descendants must read before any `await`.
  _setCurrentCmsScope(cmsId != null ? createCmsScope(cmsId, id) : null);

  const isExplicit = state.explicitIds.has(id);
  const effectiveFallback = fallback ?? null;

  const rawContent = children;

  // Frame scope: if `frame` is set, wrap the children in a
  // `<FrameWrapper>` component. The full frame path is
  // `[...parent.frameChain, frame]` — so two `<Partial frame="list">`
  // under different ancestor frames get distinct paths
  // (`"products.list"` vs `"blog.list"`) for session, navigation
  // state, and `?__frame=` wire lookups.
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
  const framePath: readonly string[] =
    frame != null ? [...parent.frameChain, frame] : EMPTY_PATH;
  const frameRequest =
    frame != null ? resolveFrameRequest(framePath, frameUrl) : null;
  const content: ReactNode =
    frame != null && frameRequest != null ? (
      <FrameWrapper path={framePath} request={frameRequest}>
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
      ? `|frame=${framePath.join(".")}:${frameRequest.url}`
      : "";
  // Only fold the ambient frame into the fp when this Partial does NOT
  // open its own frame. A framed Partial's content runs under its own
  // scope (via FrameWrapper); a sibling that mutated the per-request
  // frame-scope cell earlier in the render would otherwise leak into
  // our fingerprint even though it's semantically irrelevant —
  // breaking cross-page fingerprint-skip when the set of sibling
  // frames differs between routes (e.g. `<ChatOverlay>` on `/`, which
  // follows pokemon's `<Partial frame="search">`, vs on `/magento`
  // where there is no sibling frame). Ambient fold remains load-
  // bearing for NESTED Partials inside a framed ancestor — those DO
  // inherit the ambient frame and need its URL in their fp so a
  // frame-URL change invalidates them.
  const ambientScope = getCurrentFrameScope();
  const ambientFrameKey =
    frame == null && ambientScope
      ? `|inFrame=${ambientScope.path.join(".")}:${ambientScope.request.url}`
      : "";
  // CMS fingerprint contribution — if this Partial is CMS-aware
  // (`cmsId` set), fold the resolved content fields into the fp so a
  // content change (config match flipping, author edit) produces a
  // distinct fingerprint. Without this fold, two different CMS
  // configs that share structural JSX would hash identically and the
  // fingerprint-skip protocol would serve stale cached bytes across
  // nav between them. Also folded into `structuralFp` so `<Cache>`
  // baseKey differentiates per-config — otherwise a cached Partial
  // whose content came from CMS would return stale bytes on a config
  // flip.
  const cmsKey =
    cmsId != null ? cmsFingerprintContribution(cmsId, getRequest()) : "";
  // Structural fingerprint — stable across "am I inside a frame?"
  // readings, which can differ between full renders and cache-mode
  // refetches because `getCurrentFrameScope` reads a per-request
  // shared cell that siblings may have mutated (see FrameWrapper
  // known-sharp-edge comment). Used for the server-side `<Cache>`
  // baseKey so a Partial inside a Cache wrapping keeps the same
  // cache key between full and refetch modes.
  const structuralFp = hashFingerprint(
    fingerprintElement(rawContent) + ownFrameKey + cmsKey,
  );
  // Full fingerprint — includes ambient frame URL so descendants of
  // a frame whose URL changed get a different fp on the next render
  // and skip the fingerprint-match path (see notes/FRAMES.md).
  const fp = hashFingerprint(
    fingerprintElement(rawContent) + ownFrameKey + ambientFrameKey + cmsKey,
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
  // navigation trips this: `useNavigation("search").navigate("/search/open?q=pika")`
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
      uniqueTokens,
      sharedTokens,
      cache,
      framePath,
      frameUrl,
      parentPath: parent.path,
      cmsId,
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
        parentPath={parent.path}
        content={rawContent}
        fallback={effectiveFallback}
        errorWith={errorWith}
        uniqueTokens={uniqueTokens}
        sharedTokens={sharedTokens}
        cache={cache}
        framePath={framePath}
        frameUrl={frameUrl}
        cmsId={cmsId}
      >
        <PartialErrorBoundary
          key={id}
          partialId={id}
          partialFingerprint={fp}
          debugUniqueTokens={uniqueTokens}
          debugSharedTokens={sharedTokens}
          debugFramePath={framePath}
          debugParentPath={parent.path}
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
      <Cache id={id} fingerprint={structuralFp} options={cache}>
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
          debugUniqueTokens={uniqueTokens}
          debugSharedTokens={sharedTokens}
          debugFramePath={framePath}
          debugParentPath={parent.path}
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
        debugUniqueTokens={uniqueTokens}
        debugSharedTokens={sharedTokens}
        debugFramePath={framePath}
        fallback={errorWith}
      >
        {cachedContent}
      </PartialErrorBoundary>
    );

  return (
    <PartialBoundary
      id={id}
      parentPath={parent.path}
      content={rawContent}
      fallback={effectiveFallback}
      errorWith={errorWith}
      uniqueTokens={uniqueTokens}
      sharedTokens={sharedTokens}
      cache={cache}
      framePath={framePath}
      frameUrl={frameUrl}
      cmsId={cmsId}
    >
      {rendered}
    </PartialBoundary>
  );
}
