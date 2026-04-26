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
  resolveManifest,
  setCurrentFrameScope,
} from "../framework/context.ts";
import {
  cmsFingerprintContribution,
  createCmsScope,
} from "../framework/cms-runtime.ts";
import { getSessionFrameUrl } from "../framework/session.ts";
import {
  getPreviousRouteSnapshots,
  registerPartial,
  type PartialSnapshot,
} from "./partial-registry.ts";
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
  varyOn,
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
  /** Declared request-state dependencies, preserved so cache-mode
   *  replay reconstructs the Partial with the same vary set and
   *  re-resolves it against the current request. */
  varyOn?: readonly string[];
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
    varyOn,
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
  /**
   * Ancestor-contributed context values made available to descendants
   * via `getClosest<T>(key)`. Merged with the parent Partial's
   * provides (child entries override parent entries of the same key).
   *
   * Typical use: a product page's top-level Partial sets
   * `provides={{product: await fetchProduct(slug)}}` so every block
   * nested inside can pull the product without a prop drill or a
   * second fetch. CMS `getReference("product", "product")` with the
   * default `"closest"` fallback resolves through the same chain.
   *
   * Cache-mode refetch limitation: snapshots don't re-derive
   * ancestor `provides` values. If an inner Partial runs from its
   * snapshot in cache mode, its `getClosest(key)` reads return null
   * for keys that came from an ancestor. Blocks that need to survive
   * a cache-mode refetch should also have a concrete fallback
   * (e.g., `getReference("product", "product")` with a stored value)
   * rather than relying solely on `closest`.
   */
  provides?: Readonly<Record<string, unknown>>;
  /**
   * Declare which request-state inputs this Partial's content depends
   * on. Folded into the structural fingerprint so a same-route nav
   * that changes any declared key produces a distinct fp — the
   * fp-skip protocol then renders fresh instead of serving the
   * cached wrapper.
   *
   * Each entry is the same spec syntax tracked accessors use:
   *
   *   "url:<param>"            — URL search param (e.g. `"url:config"`).
   *   "cookie:<name>"          — cookie value (e.g. `"cookie:user_id"`).
   *   "header:<name>"          — request header (lowercased internally).
   *   "pathname:/p/:slug"      — pathname pattern; the EXTRACTED params
   *                              are hashed (so two routes matching the
   *                              same pattern still hash distinctly per
   *                              extracted slug).
   *
   * Resolved against:
   *   1. this Partial's own frame request, if `frame=` is set;
   *   2. else the closest ambient frame's request, if any (looked up
   *      from session via `parent.frameChain` — bypasses the per-
   *      request frame-scope cell, so it's safe across sibling-
   *      interleaving renders);
   *   3. else the page request.
   *
   * Use `varyOn` whenever the Partial's content depends on URL or
   * cookie state but you can't (or don't want to) rely on tracked
   * accessor reads inside the body to drive fingerprinting:
   *
   *   - The body reads request state via `getRequest()` (typically
   *     because the tracked accessors would hit the frame-scope-leak
   *     sharp edge — see `notes/FRAME_SCOPING.md`).
   *   - The body delegates rendering to a child component whose own
   *     reads the framework can't see at fingerprint time.
   *   - The Partial wraps a `<Cache>`-less subtree but still varies
   *     by URL.
   *
   * Not needed when the Partial's body itself reads via the tracked
   * accessor surface inside a `<Cache>` boundary — that path already
   * folds the manifest into the cache key.
   */
  varyOn?: readonly string[];
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
  provides,
  varyOn,
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
  _setCurrentPartialContext(_childContext(parent, id, frame, provides));

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
  //
  // Frame awareness: a Partial inside a `<Partial frame=…>` ancestor
  // resolves its CMS configs against the FRAME's request (the slug
  // pattern matchers use the frame URL — that's the whole point of
  // the editor's preview-frame setup, where /cms-demo/alpha vs
  // /cms-demo picks different per-slug configs). The fingerprint
  // contribution must use the same request — otherwise frame-URL
  // changes don't invalidate the fingerprint and the fp-skip protocol
  // serves stale cached bytes across preview navigations.
  const cmsRequest = ambientScope?.request ?? getRequest();
  const cmsKey =
    cmsId != null ? cmsFingerprintContribution(cmsId, cmsRequest) : "";
  // varyOn fingerprint contribution — declarative dependency on
  // request state (URL params, cookies, headers, pathname patterns)
  // the Partial's content varies by. Resolved against the Partial's
  // effective request:
  //   - own frame request when the Partial declares `frame=…`
  //     (frameRequest is already populated above);
  //   - else the closest ambient frame's request, looked up DIRECTLY
  //     from session via `parent.frameChain` — bypasses the leaky
  //     per-request frame-scope cell that `getCurrentFrameScope`
  //     reads, so the resolution is correct under sibling-interleaved
  //     renders too;
  //   - else the page request.
  // Folded into BOTH `structuralFp` (so `<Cache>` baseKey
  // differentiates per vary value — separate cache slots) and `fp`
  // (so the fp-skip handshake refuses to skip when the declared
  // input changed).
  const varyKey = computeVaryKey(
    varyOn,
    frame != null ? frameRequest : null,
    parent.frameChain,
    frameUrl,
  );
  // Transitive descendant `varyOn` — the fp must capture
  // dependencies declared by descendants too, because fp-skip at an
  // ancestor short-circuits descendant rendering. Without this fold
  // an ancestor whose own JSX is unchanged would emit a placeholder,
  // the client would reuse the cached subtree, and a descendant
  // whose `varyOn` value changed would never re-render.
  //
  // Two walks combine:
  //   1. Static JSX walk over `rawContent` — catches `<Partial>`
  //      elements that appear DIRECTLY in this Partial's children
  //      JSX (no opaque function component in between). No render is
  //      executed; we just inspect element shapes.
  //   2. Previous-render registry walk — catches Partials registered
  //      under this id via the `parent` prop discipline (covers
  //      dynamic Partials inside `.map()`s and Partials wrapped in
  //      function components that thread `parent`).
  // Contributions are deduped by effective id, so the two walks
  // finding the same Partial fold its varyOn exactly once.
  //
  // Limitation: a Partial wrapped in an opaque function component
  // (e.g. `<TreePanel />` containing `<Partial selector="…">`) that
  // doesn't thread `parent` is invisible to BOTH walks until it
  // first renders and registers a snapshot. After the first render
  // the registry knows about it, but only if its `parent` prop
  // matches; with `parent={ROOT}` the registry can't link it back.
  // For these Partials, declare `varyOn` on the wrapping ancestor
  // (or thread `parent={capturePartialContext()}` so the registry
  // can track the relationship).
  const descendantVaryKey = computeDescendantVaryKey(
    id,
    frame != null ? framePath : parent.frameChain,
    rawContent,
  );
  // Structural fingerprint — stable across "am I inside a frame?"
  // readings, which can differ between full renders and cache-mode
  // refetches because `getCurrentFrameScope` reads a per-request
  // shared cell that siblings may have mutated (see FrameWrapper
  // known-sharp-edge comment). Used for the server-side `<Cache>`
  // baseKey so a Partial inside a Cache wrapping keeps the same
  // cache key between full and refetch modes.
  const structuralFp = hashFingerprint(
    fingerprintElement(rawContent) +
      ownFrameKey +
      cmsKey +
      varyKey +
      descendantVaryKey,
  );
  // Full fingerprint — includes ambient frame URL so descendants of
  // a frame whose URL changed get a different fp on the next render
  // and skip the fingerprint-match path (see notes/FRAMES.md).
  const fp = hashFingerprint(
    fingerprintElement(rawContent) +
      ownFrameKey +
      ambientFrameKey +
      cmsKey +
      varyKey +
      descendantVaryKey,
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
      varyOn,
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
        varyOn={varyOn}
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
      varyOn={varyOn}
    >
      {rendered}
    </PartialBoundary>
  );
}

/**
 * Resolve a Partial's `varyOn` array against the appropriate request
 * and return a stable key string suitable for hashing into the
 * fingerprint. Returns `""` when no deps are declared (so unchanged
 * Partials hash exactly as before).
 *
 * Request selection avoids the leaky `getCurrentFrameScope()` cell:
 *   - own frame request when set;
 *   - else `resolveFrameRequest(ambientChain, undefined)` — looks
 *     the URL up directly from session via the explicitly-threaded
 *     `parent.frameChain`, so the resolution is correct under
 *     sibling-interleaved renders too;
 *   - else the page request from `getRequest()`.
 *
 * Serialization sorts the spec list so two Partials that declared
 * the same set in different order hash identically.
 */
function computeVaryKey(
  varyOn: readonly string[] | undefined,
  ownFrameRequest: Request | null,
  ambientFrameChain: readonly string[],
  ownFrameUrl: string | undefined,
): string {
  if (varyOn == null || varyOn.length === 0) return "";
  const request: Request =
    ownFrameRequest != null
      ? ownFrameRequest
      : ambientFrameChain.length > 0
        ? resolveFrameRequest(ambientFrameChain, ownFrameUrl)
        : getRequest();
  const values = resolveManifest(new Set(varyOn), request);
  const sorted = [...varyOn].sort();
  const parts: string[] = [];
  for (const k of sorted) parts.push(`${k}=${values[k]}`);
  return `|vary=${parts.join("&")}`;
}

/**
 * Walk the previous render's snapshots for descendants of `ownId`
 * and fold each one's resolved `varyOn` into a single key string.
 * The result captures the union of all transitive descendant
 * dependencies, so an ancestor's fp differs whenever ANY descendant's
 * varyOn value differs — which is the prerequisite for fp-skip at the
 * ancestor to be safe.
 *
 * Resolution detail: each descendant's varyOn must be resolved
 * against the descendant's OWN effective request (which may be a
 * frame request distinct from the ancestor's). The descendant's
 * snapshot carries `framePath` — we use it to look the frame URL
 * up directly from session, bypassing the per-request frame-scope
 * cell (and its sibling-interleaving leak).
 *
 * Empty key (`""`) on:
 *   - First-render-of-a-route (no previous snapshots).
 *   - Ancestors with no descendants that declare varyOn.
 *
 * Over-folding bias: a descendant that USED to live under this
 * ancestor but no longer does still contributes its varyOn until
 * the next render swaps in a fresh "previous" map. That makes the
 * ancestor's fp differ more often than strictly necessary — extra
 * re-renders, never stale subtrees. Acceptable trade.
 */
function computeDescendantVaryKey(
  ownId: string,
  ownFrameChain: readonly string[],
  rawContent: ReactNode,
): string {
  // Map<descendantEffectiveId, contributionString>. Dedupes when
  // the static walk and the registry walk both find the same
  // Partial (e.g. a directly-nested Partial that also registered
  // a snapshot in the previous render).
  const contributions = new Map<string, string>();

  walkJsxForDescendantVary(rawContent, ownFrameChain, contributions);
  walkRegistryForDescendantVary(ownId, ownFrameChain, contributions);

  if (contributions.size === 0) return "";
  const sorted = [...contributions.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const parts = sorted.map(([id, sub]) => `${id}{${sub}}`);
  return `|descVary=${parts.join(",")}`;
}

/**
 * Static JSX walk — descend into `node` and collect contributions
 * from every `<Partial>` element with a non-empty `varyOn` we can
 * reach without executing any function component. Tracks the frame
 * chain so each descendant's varyOn resolves against the right
 * request (the descendant's own frame if it opens one, else the
 * ancestor's chain).
 *
 * Stops at non-Partial function components (TreePanel, FieldPanel,
 * any user component) — we can't see what they'll render without
 * calling them, and calling them defeats the streaming + sync-fp
 * model. For Partials hidden behind such components, fall back to
 * the registry walk + `parent` threading.
 */
function walkJsxForDescendantVary(
  node: ReactNode,
  ancestorFrameChain: readonly string[],
  out: Map<string, string>,
): void {
  if (node == null || typeof node === "boolean") return;
  if (typeof node === "string" || typeof node === "number") return;
  if (Array.isArray(node)) {
    for (const child of node) {
      walkJsxForDescendantVary(child, ancestorFrameChain, out);
    }
    return;
  }
  if (!isValidElement(node)) return;

  if (node.type === Partial) {
    const props = node.props as PartialProps;
    const localFrame = props.frame;
    const childFrameChain =
      localFrame != null
        ? [...ancestorFrameChain, localFrame]
        : ancestorFrameChain;
    if (props.varyOn && props.varyOn.length > 0) {
      const parsed = parseSelector(props.selector);
      const id = resolveEffectiveId(parsed);
      const request: Request =
        childFrameChain.length > 0
          ? resolveFrameRequest(childFrameChain, props.frameUrl)
          : getRequest();
      const values = resolveManifest(new Set(props.varyOn), request);
      const sorted = [...props.varyOn].sort();
      const sub: string[] = [];
      for (const k of sorted) sub.push(`${k}=${values[k]}`);
      out.set(id, sub.join("&"));
    }
    // Recurse INTO this Partial's children — its descendants
    // contribute to the OUTER ancestor's fp too. (A varyOn on a
    // grand-descendant should propagate up through every wrapper.)
    walkJsxForDescendantVary(
      props.children as ReactNode,
      childFrameChain,
      out,
    );
    return;
  }

  // Non-Partial JSX: walk through children. Function components
  // appear as elements with `type` set to the function — we can't
  // see what they'll render, so any inner Partial is opaque. Host
  // elements (`div`, etc.) and Fragments expose their children
  // directly; we descend.
  const inner = (node.props as { children?: ReactNode })?.children;
  if (inner != null) {
    walkJsxForDescendantVary(inner, ancestorFrameChain, out);
  }
}

/**
 * Registry walk — pull Partials from the PREVIOUS render's snapshots
 * whose `parentPath` includes `ownId`. Catches dynamic Partials
 * (`.map()`-generated, function-component-wrapped) when the author
 * passed `parent={capturePartialContext()}` (or threaded the parent
 * down explicitly), so the registry knows the parent edge.
 *
 * Adds to `out` only if the static walk hasn't already registered
 * the same effective id (the static walk's contribution is fresher
 * — a deleted Partial that lingers in the previous-render registry
 * shouldn't override a current-tree contribution).
 */
function walkRegistryForDescendantVary(
  ownId: string,
  ownFrameChain: readonly string[],
  out: Map<string, string>,
): void {
  const route = new URL(getRequest().url).pathname;
  const prev = getPreviousRouteSnapshots(route);
  if (!prev || prev.size === 0) return;

  for (const [descId, snap] of prev) {
    if (descId === ownId) continue;
    if (out.has(descId)) continue;
    if (!isDescendantSnapshot(snap, ownId)) continue;
    if (!snap.varyOn || snap.varyOn.length === 0) continue;
    const descRequest = descendantSnapshotRequest(snap, ownFrameChain);
    const values = resolveManifest(new Set(snap.varyOn), descRequest);
    const sorted = [...snap.varyOn].sort();
    const sub: string[] = [];
    for (const k of sorted) sub.push(`${k}=${values[k]}`);
    out.set(descId, sub.join("&"));
  }
}

function isDescendantSnapshot(
  snap: PartialSnapshot,
  ancestorId: string,
): boolean {
  // `parentPath` is outer-first, so a Partial nested inside `ancestorId`
  // has `ancestorId` somewhere in its path. Direct equality scan is
  // sufficient — the path is short (depth of nesting).
  for (const id of snap.parentPath) {
    if (id === ancestorId) return true;
  }
  return false;
}

/**
 * Resolve the effective Request for a descendant snapshot's varyOn
 * resolution. Picks:
 *   - the descendant's own frame request, if its `framePath` is set
 *     (and differs from the ancestor's chain — i.e. the descendant
 *     opened a new frame);
 *   - otherwise the ancestor's ambient frame, if any;
 *   - otherwise the page request.
 */
function descendantSnapshotRequest(
  snap: PartialSnapshot,
  ancestorFrameChain: readonly string[],
): Request {
  if (snap.framePath.length > 0) {
    return resolveFrameRequest(snap.framePath, snap.frameUrl);
  }
  if (ancestorFrameChain.length > 0) {
    return resolveFrameRequest(ancestorFrameChain, undefined);
  }
  return getRequest();
}
