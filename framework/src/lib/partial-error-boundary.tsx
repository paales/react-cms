"use client"

import React, { createContext, useContext } from "react"
import { getNavigation } from "../runtime/navigation-api.ts"
import { PartialIdContext, registerClientPartial } from "./partial-client.tsx"

// ─── Stale-serve marker ────────────────────────────────────────────────

/**
 * The staleness a served last-known-good render carries. Present on
 * the context exactly when the enclosing parton's bytes were replayed
 * from the byte cache BECAUSE its fresh render threw (the
 * error-recovery path in cache.tsx) — never for an ordinary
 * stale-while-revalidate serve. See `docs/reference/errors.md`.
 */
export interface PartonStale {
  /** Epoch ms of the FIRST failure of the current outage. */
  readonly since: number
  /** Consecutive failed attempts so far (≥ 1). */
  readonly attempts: number
  /** Epoch ms of the next scheduled re-render attempt. */
  readonly retryAt: number
}

const PartonStaleContext = createContext<PartonStale | null>(null)

/**
 * Read the enclosing parton's error-staleness marker. `null` when the
 * content is authoritative (fresh render, byte-cache hit, ordinary
 * SWR serve); a `PartonStale` when the framework served
 * last-known-good bytes in place of a failed render. UI inside a
 * cached parton uses this to show an explicit staleness indicator —
 * the marker is the producer-written signal, per the no-heuristics
 * rule.
 */
export function usePartonStale(): PartonStale | null {
  return useContext(PartonStaleContext)
}

/**
 * Framework-internal: the wrapper cache.tsx puts around a
 * last-known-good replay. A plain context provider — zero DOM, so the
 * parton's markup is byte-identical to the stored render; only client
 * components inside it that call `usePartonStale()` observe the
 * difference.
 */
export function PartonStaleProvider({
  stale,
  children,
}: {
  stale: PartonStale
  children: React.ReactNode
}) {
  return <PartonStaleContext value={stale}>{children}</PartonStaleContext>
}

// ─── Per-partial error boundary ────────────────────────────────────────

interface Props {
  partialId: string
  /** Structural fingerprint of the partial's children. When present,
   *  gets registered into the client-side fingerprint map on render
   *  so subsequent action POSTs can send it back via `x-parton-cached`. */
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
 * An errored boundary CLEARS itself when a new emission arrives: the
 * server's retry machinery (see cache.tsx / docs/reference/errors.md)
 * re-renders an errored parton on a schedule, and the recovering
 * emission reaches this boundary as a new `children` element — a new
 * children identity IS the signal that a fresh outcome is here to
 * display, so the boundary re-renders it instead of pinning the card.
 *
 * Also doubles as the registration vehicle for the partial's
 * fingerprint on the client: during render we push
 * `(partialId, partialFingerprint)` into `_currentPageFingerprints` so the next
 * `getCachedPartialIds()` call picks it up. The registration is a
 * FALLBACK to the commit walk's (which stores content first) and is
 * gated on the content slot still holding the wrapper — a parked
 * fiber can outlive its cache slots inside an ancestor's cached
 * subtree, and its re-render must not resurrect an advertised fp the
 * eviction already purged (see `registerClientPartial`). While the
 * boundary holds an ERROR, it does not register: the fp advertises
 * the children's rendered content, and what this boundary is showing
 * is the card — advertising would let the server fp-skip to content
 * the client isn't displaying. Withholding is the safe direction
 * (over-fetch, never stale).
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

  componentDidUpdate(prevProps: Props) {
    // Recovery clears: a NEW children element means a new emission
    // (retry outcome, refetch, navigation) — display it. Same-element
    // re-renders of the parent keep the card; only a fresh emission
    // can carry a fresh outcome.
    if (this.state.error !== null && prevProps.children !== this.props.children) {
      this.setState({ error: null })
    }
  }

  retry = () => {
    React.startTransition(() => {
      this.setState({ error: null })
      // A hard recovery: reload the document (Navigation API `reload` —
      // navigationType "reload", which the page listener passes through
      // to a real cross-document load). No channel dependency, so the
      // error card stays in the initial chunk.
      getNavigation()?.reload()
    })
  }

  render() {
    if (this.props.partialFingerprint && this.state.error === null) {
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
 *
 * `data-partial-error` + the `partial-error` class are the card's
 * machine-readable surface — validators and specs count error cards by
 * them instead of matching copy.
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
  const retry = onRetry ?? (() => React.startTransition(() => void getNavigation()?.reload()))
  return (
    <div
      className="partial-error"
      data-partial-error={partialId}
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
