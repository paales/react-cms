"use client"

import React from "react"
import { _windowNav, registerClientPartial } from "./partial-client.tsx"
import { registerDebugPartial } from "./partial-debug.tsx"

interface Props {
  partialId: string
  /** Structural fingerprint of the partial's children. When present,
   *  gets registered into the client-side fingerprint map on render
   *  so subsequent navigations can send it back via `?cached=`. */
  partialFingerprint?: string
  /** Parsed selector — populates the dev debugger's per-Partial pills. */
  debugUniqueTokens?: readonly string[]
  debugSharedTokens?: readonly string[]
  debugFramePath?: readonly string[]
  /** Ancestor Partial-id chain (outer-first) — drives indentation in
   *  the debug panel so nested Partials visually sit under their
   *  parents. */
  debugParentPath?: readonly string[]
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
 * `(partialId, partialFingerprint)` into `_fingerprints` so the next
 * `getCachedPartialIds()` call picks it up.
 */
export class PartialErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    // Framework control-flow sentinels (notFound, redirect) must
    // bubble past user-level error boundaries so the RSC entry can
    // translate them into HTTP status / Location / payload markers.
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
      registerClientPartial(this.props.partialId, this.props.partialFingerprint)
    }
    if (
      import.meta.env.DEV &&
      import.meta.env.MODE !== "test" &&
      (this.props.debugUniqueTokens || this.props.debugSharedTokens)
    ) {
      registerDebugPartial(this.props.partialId, {
        uniqueTokens: this.props.debugUniqueTokens ?? [],
        sharedTokens: this.props.debugSharedTokens ?? [],
        framePath: this.props.debugFramePath ?? [],
        parentPath: this.props.debugParentPath ?? [],
      })
    }
    if (this.state.error) {
      if (this.props.fallback !== undefined) {
        return this.props.fallback
      }
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
            Partial "{this.props.partialId}" failed to render
          </div>
          {import.meta.env.DEV && (
            <pre
              style={{
                fontSize: "0.75rem",
                color: "#e88",
                whiteSpace: "pre-wrap",
                marginBottom: "0.75rem",
              }}
            >
              {this.state.error.message}
            </pre>
          )}
          <button
            type="button"
            onClick={this.retry}
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
    return this.props.children
  }
}
