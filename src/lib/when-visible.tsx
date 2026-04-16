import type { ReactNode } from "react";
import { getRequest } from "../framework/context.ts";
import { WhenVisibleClient } from "./when-visible-client.tsx";

interface WhenVisibleProps {
  /** Partial id this activator belongs to and activates on visibility. */
  partialId: string;
  /** Content rendered once the block is activated. */
  children: ReactNode;
  /** Placeholder rendered until activation. */
  fallback: ReactNode;
  /** `IntersectionObserver.rootMargin`. Default `"0px"`. */
  rootMargin?: string;
  /** `IntersectionObserver.threshold`. */
  threshold?: number;
}

/**
 * Activator: render `fallback` with an IntersectionObserver that
 * activates a partial on first visibility. Once the partial has
 * been explicitly rendered (client called
 * `usePartial(id).refetch()`), this component renders `children`
 * directly instead.
 *
 * `partialId` must match the enclosing `<Partial id=…>` — the
 * activator reads the current request's `?partials=` / `__inputs`
 * to decide which branch to take. The framework doesn't inject
 * ambient partial context (RSC has no cheap story for server-to-
 * server context propagation), so the id is declared explicitly.
 */
export function WhenVisible({
  partialId,
  children,
  fallback,
  rootMargin,
  threshold,
}: WhenVisibleProps): ReactNode {
  const url = new URL(getRequest().url);
  const partials = (url.searchParams.get("partials") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  let inputs: Record<string, unknown> = {};
  const inputsRaw = url.searchParams.get("__inputs");
  if (inputsRaw) {
    try {
      inputs = JSON.parse(inputsRaw);
    } catch {
      /* malformed — treat as no inputs */
    }
  }
  const isExplicit = partials.includes(partialId) || inputs[partialId] != null;
  if (isExplicit) return children;
  return (
    <WhenVisibleClient
      partialId={partialId}
      rootMargin={rootMargin}
      threshold={threshold}
    >
      {fallback}
    </WhenVisibleClient>
  );
}
