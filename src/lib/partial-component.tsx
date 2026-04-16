import { Suspense, type ReactNode } from "react";
import { getRequest } from "../framework/context.ts";
import { registerPartial } from "./partial-registry.ts";
import { PartialErrorBoundary } from "./partial-error-boundary.tsx";

/**
 * Recognizable wrapper around a transformed Partial.
 *
 * Two server-side roles, both as side-effects while React renders it:
 *   1. Gives `<Cache>` a stable type to identify partial-bearing
 *      subtrees so they can be stripped to placeholders before the
 *      cache entry is serialized.
 *   2. Self-registers its content descriptor into the route-scoped
 *      registry (`partial-registry.ts`), so a later refetch for this
 *      id can render the snapshot directly without re-executing
 *      ancestors.
 *
 * The registration happens during the outer render (or after Cache's
 * reinject step), so dynamically-produced Partials — those invisible
 * to `collectPartials`'s static walk because they're generated inside
 * a function component — still get captured the first time they
 * render as part of a full page render.
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
  /** Original (untransformed) content of the `<Partial>` — stored in
   *  the registry so a refetch can render it directly. */
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
   * Suspense fallback. Shown while async children resolve. The
   * framework auto-wraps the partial's children in `<Suspense>` when
   * this is set.
   */
  fallback?: ReactNode;
  /**
   * Error boundary fallback. Shown if the partial's rendering
   * throws. If omitted, a built-in red card with a retry button is
   * used.
   */
  errorWith?: ReactNode;
}

/**
 * Marker wrapper for a re-renderable fragment of a page.
 *
 * Two render paths coexist:
 *
 *   1. **Static**: `<PartialRoot>`'s `transformForStreaming` walks the
 *      JSX `children` chain, finds `<Partial>` elements, and REPLACES
 *      them with a PartialBoundary+Suspense+ErrorBoundary chain
 *      (applying `__inputs` overrides and version-stamping keys for
 *      progressive streaming on refetch). The `<Partial>` element
 *      itself is never rendered by React in this path.
 *
 *   2. **Dynamic** (this component body): a `<Partial>` produced inside
 *      an opaque function component — `ProductList.map(p => <Partial
 *      id={`price-${p.sku}`}>…</Partial>)` — is invisible to the static
 *      walk. React ends up calling `Partial` directly, which self-wraps
 *      here with PartialBoundary (for server-side registration +
 *      `<Cache>` stripping) and a keyed Suspense boundary (so the
 *      client's `cacheFromStreamingChildren` can find it by id — key
 *      preservation survives Flight because Suspense is a React
 *      built-in, unlike server components which dissolve).
 *
 * Dynamic Partials reconcile in place on refetch (bare `id` key, no
 * version stamp) — no progressive-streaming fresh-mount trick. That's
 * the right default for live refresh of small leaves like prices.
 */
export function Partial({
  id,
  children,
  fallback,
  errorWith,
  tags,
}: PartialProps): ReactNode {
  const inner = (
    <PartialErrorBoundary partialId={id} fallback={errorWith}>
      {children}
    </PartialErrorBoundary>
  );
  return (
    <PartialBoundary
      id={id}
      content={children}
      fallback={fallback ?? null}
      errorWith={errorWith}
      tags={tags ?? []}
    >
      {fallback != null ? (
        <Suspense
          key={id}
          fallback={
            <PartialErrorBoundary partialId={id} fallback={errorWith}>
              {fallback}
            </PartialErrorBoundary>
          }
        >
          {inner}
        </Suspense>
      ) : (
        <Suspense key={id}>{inner}</Suspense>
      )}
    </PartialBoundary>
  );
}
