"use client"

import React from "react"
import { _windowNav, PartialIdContext, registerClientPartial } from "./partial-client.tsx"

interface Props {
  partialId: string
  /** Structural fingerprint of the partial's children. When present,
   *  gets registered into the client-side fingerprint map on render
   *  so subsequent navigations can send it back via `?cached=`. */
  partialFingerprint?: string
  /** Stable variant key for this rendered instance. Derived from
   *  `stableStringify(matchParams)`, so /pokemon/1 and /pokemon/2 get
   *  distinct matchKeys but a same-route vary refresh keeps the same
   *  matchKey. The client uses it to slot cached subtrees under
   *  `Map<id, Map<matchKey, ReactNode>>` so multiple variants of the
   *  same spec coexist as hidden Activity siblings. */
  partialMatchKey?: string
  children: React.ReactNode
  /**
   * Optional error fallback. Rendered when a descendant throws.
   * If omitted, the built-in red card with a retry button is used.
   */
  fallback?: React.ReactNode
}

interface State {
  error: Error | null
}

/**
 * Per-partial error boundary.
 *
 * Wraps each partial so a render failure in one partial doesn't
 * crash the entire page. When a descendant throws:
 *   - If `fallback` is provided, renders it verbatim.
 *   - Otherwise, shows the default inline error card + retry button.
 *
 * Also doubles as the registration vehicle for the partial's
 * fingerprint on the client: during render we push
 * `(partialId, partialFingerprint)` into `_currentPageFingerprints` so the next
 * `getCachedPartialIds()` call picks it up.
 */
export class PartialErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    // Framework-branded errors must bubble past this per-partial
    // boundary so the right consumer catches:
    //   - notFound / redirect    — surface to the RSC entry so it
    //     can translate into HTTP status / Location / payload markers.
    //   - NavigationError        — surface to the host's enclosing
    //     React error boundary (default `<GlobalErrorBoundary>`)
    //     rather than turning a click-driven refetch failure into
    //     an inline red card on the affected partial.
    // Detect by the `__framework` brand on the class — avoids an
    // `instanceof` that would force a cross-bundle import.
    if ((error as { __framework?: string }).__framework) {
      throw error
    }
    return { error }
  }

  retry = () => {
    React.startTransition(() => {
      this.setState({ error: null })
      void _windowNav().reload()
    })
  }

  render() {
    if (this.props.partialFingerprint) {
      registerClientPartial(
        this.props.partialId,
        this.props.partialMatchKey ?? "",
        this.props.partialFingerprint,
      )
    }
    if (this.state.error) {
      if (this.props.fallback !== undefined) {
        return this.props.fallback
      }
      return (
        <PartialErrorCard
          partialId={this.props.partialId}
          message={import.meta.env.DEV ? this.state.error.message : undefined}
          onRetry={this.retry}
        />
      )
    }
    // Provide the enclosing-partial id to client descendants.
    // `useNavigation().reload()` reads this context to resolve the
    // `@self` token — e.g. an in-block `<RefreshButton>` that fires
    // `reload({ selector: "@self" })` regardless of how the instance
    // is externally addressable.
    //
    // Viewport observation for cullable partons lives in `CullPair`
    // (both slots wrap their child in a `<VisibilityObserver>`), not
    // here — the boundary is registration + error containment only.
    return (
      <PartialIdContext.Provider value={this.props.partialId}>
        {this.props.children}
      </PartialIdContext.Provider>
    )
  }
}

/**
 * The inline "failed to render" card.
 *
 * Shared by two failure modes so both surface identically:
 *   - {@link PartialErrorBoundary} renders it when a descendant throws
 *     while rendering the resolved body.
 *   - The spec wrapper in `partial.tsx` renders it when schema/props
 *     resolution or the synchronous `Render` call throws — failures that
 *     happen above the boundary and would otherwise crash the whole app.
 *
 * `message` is supplied only in dev builds (callers gate on
 * `import.meta.env.DEV`); production omits it to avoid leaking internals.
 * `onRetry` defaults to a full window reload — enough to re-run a failed
 * resolution from scratch when there's no boundary state to clear.
 */
export function PartialErrorCard({
  partialId,
  message,
  onRetry,
}: {
  partialId: string
  message?: string
  onRetry?: () => void
}) {
  const retry = onRetry ?? (() => React.startTransition(() => void _windowNav().reload()))
  return (
    <div
      style={{
        background: "#2a1a1a",
        border: "1px solid #5a2a2a",
        borderRadius: 12,
        padding: "1.25rem",
        marginBottom: "1rem",
      }}
    >
      <div
        style={{
          color: "#f56565",
          fontWeight: 600,
          marginBottom: "0.5rem",
        }}
      >
        Partial "{partialId}" failed to render
      </div>
      {message != null && (
        <pre
          style={{
            fontSize: "0.75rem",
            color: "#e88",
            whiteSpace: "pre-wrap",
            marginBottom: "0.75rem",
          }}
        >
          {message}
        </pre>
      )}
      <button
        type="button"
        onClick={retry}
        style={{
          background: "#5a2a2a",
          color: "#ededed",
          border: "1px solid #7a3a3a",
          padding: "0.4rem 0.8rem",
          borderRadius: 6,
          cursor: "pointer",
          fontSize: "0.8rem",
        }}
      >
        Retry
      </button>
    </div>
  )
}
