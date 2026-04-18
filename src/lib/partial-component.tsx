import { Suspense, cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { getRequest } from "../framework/context.ts";
import { registerPartial } from "./partial-registry.ts";
import { PartialErrorBoundary } from "./partial-error-boundary.tsx";
import { requirePartialState } from "./partial-request-state.ts";
import { djb2 as hashFingerprint } from "./hash.ts";

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
  children,
}: {
  id: string;
  /** Original children of the `<Partial>` — stored in the registry so
   *  a refetch can render it directly. */
  content: ReactNode;
  fallback: ReactNode;
  errorWith: ReactNode | undefined;
  tags: string[];
  children: ReactNode;
}): ReactNode {
  const route = new URL(getRequest().url).pathname;
  registerPartial(route, id, { content, fallback, errorWith, tags });
  return children;
}

export interface PartialProps {
  id: string;
  children: ReactNode;
  tags?: string[];
  cache?: number;
  /**
   * Suspense fallback. Shown while async children resolve. When set,
   * the framework auto-wraps the partial's children in `<Suspense>`.
   */
  fallback?: ReactNode;
  /**
   * Error boundary fallback. Shown if the partial's rendering throws.
   * If omitted, a built-in red card with a retry button is used.
   */
  errorWith?: ReactNode;
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
  return (
    <i key={id} hidden data-partial />
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
 *
 * Responsibilities of this body:
 *   1. Read the request-scoped state set up by `<PartialRoot>`.
 *   2. Detect duplicate ids in the same request (throws).
 *   3. Register content + metadata in the route-scoped registry
 *      (via `<PartialBoundary>`).
 *   4. Compute a structural fingerprint of the children tree.
 *   5. Decide whether to render fresh or emit a placeholder:
 *        - Cache mode + id not requested + no __inputs → placeholder
 *        - Streaming mode + fingerprint matches client's cached fp →
 *          placeholder
 *        - Otherwise → render
 *   6. Apply any `__inputs` override to the children.
 *   7. Wrap in `<Suspense key={id}>` (for Flight key preservation) and
 *      `<PartialErrorBoundary>` (with fingerprint so the client can
 *      register it into `_fingerprints`).
 */
export function Partial({
  id,
  children,
  fallback,
  errorWith,
  tags,
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
  //
  // In cache mode (`?partials=` or `?tags=` was set), we only render
  // partials that were explicitly requested. Everything else emits a
  // placeholder; the client fills it from its existing `_cache` entry.
  //
  // In streaming mode, we render everything except partials whose
  // fingerprint matches what the client already has cached. Those
  // emit a placeholder too — no work done, no GraphQL call, no bytes
  // streamed for the content.
  const cachedFp = state.cachedFingerprints.get(id);
  const fingerprintMatches = cachedFp != null && cachedFp === fp;

  const shouldSkip = isExplicit
    ? false
    : state.isPartialRefetch
      ? true
      : fingerprintMatches;

  if (shouldSkip) {
    // Register so tag refetches / subsequent lookups still find the
    // partial, even though we didn't render it this pass. Content is
    // the (input-overridden) tree.
    const route = new URL(getRequest().url).pathname;
    registerPartial(route, id, {
      content,
      fallback: effectiveFallback,
      errorWith,
      tags: effectiveTags,
    });
    return placeholderFor(id);
  }

  // ── Render ─────────────────────────────────────────────────────────
  //
  // Wrap in Suspense ONLY when the caller provided a fallback.
  //
  // Why: the client's `substituteNested` walker deliberately does not
  // descend into Suspense elements (children may be unresolved Flight
  // lazies). If every Partial were unconditionally wrapped in
  // Suspense, nested Partials inside a cached ancestor's subtree
  // would never be substituted with fresh cache entries on a
  // cache-mode refetch — the "refresh one nested partial" flow would
  // keep rendering stale content. Wrapping only on opt-in preserves
  // the walker's ability to find and swap nested Partials.
  //
  // The key (for Flight preservation) goes on the outermost
  // client-visible element: Suspense if there's a fallback,
  // PartialErrorBoundary otherwise. Both preserve their key through
  // Flight — PartialErrorBoundary is a `"use client"` class component.
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
          {content}
        </PartialErrorBoundary>
      </Suspense>
    ) : (
      <PartialErrorBoundary
        key={id}
        partialId={id}
        partialFingerprint={fp}
        fallback={errorWith}
      >
        {content}
      </PartialErrorBoundary>
    );

  return (
    <PartialBoundary
      id={id}
      content={content}
      fallback={effectiveFallback}
      errorWith={errorWith}
      tags={effectiveTags}
    >
      {rendered}
    </PartialBoundary>
  );
}
