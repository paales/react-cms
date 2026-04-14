import type { ReactNode } from "react";

export interface PartialProps {
  id: string;
  children: ReactNode;
  tags?: string[];
  cache?: number;
  fallback?: ReactNode;
}

/**
 * Marker wrapper for a re-renderable fragment of a page.
 *
 * `<PartialRoot>` statically walks the element tree, detects `<Partial>`
 * elements, fingerprints their contents, applies request filters, and
 * wraps them in Suspense/ErrorBoundary. This component is a pass-through
 * so that `<Partial>` rendered outside a `<PartialRoot>` still produces
 * its children.
 */
export function Partial({ children }: PartialProps): ReactNode {
  return children;
}
