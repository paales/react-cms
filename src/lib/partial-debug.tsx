"use client"

import { useEffect, useState, useSyncExternalStore, type CSSProperties } from "react"
import { useNavigation } from "./partial-client.tsx"

/**
 * Partial+Frame debugger.
 *
 * A single top-level `<PartialsDebug/>` component rendered at the end
 * of the `<body>` in dev mode. Each active `<Partial>` registers its
 * metadata (id + parsed selector tokens + frame path) from inside
 * its `<PartialErrorBoundary>`'s render — no new DOM is injected
 * around the Partial content. The panel renders one row per
 * registered Partial with reload pills, frame back/forward, the
 * Partial's frame-or-page URL, and the current frame-entry state.
 *
 * Design note: an earlier revision tried to wrap each Partial's
 * rendered output in a `<div style="display:contents">` (or
 * Fragment-with-markers) so the debugger could draw a per-Partial
 * rect overlay on top of each Partial. Both approaches broke
 * refetch reconciliation — any injected element around the Partial
 * subtree interferes with `cacheFromStreamingChildren` /
 * `renderTemplate` and cache-mode cache hits lose client state.
 * The registry-only approach here is the workable shape; the rect
 * overlay is dropped (see notes/IDEAS.md).
 *
 * Self-contained: raw HTML + inline styles, no UI-lib components,
 * only `useNavigation` as an outside dependency.
 */

interface DebugInfo {
  uniqueTokens: readonly string[]
  sharedTokens: readonly string[]
  framePath: readonly string[]
  /** Outer-first chain of ancestor Partial ids. Drives row indent. */
  parentPath: readonly string[]
}

interface DebugEntry extends DebugInfo {
  id: string
}

// ─── Module-level registry populated by PartialErrorBoundary ───────────

const entries = new Map<string, DebugInfo>()
const listeners = new Set<() => void>()
let cachedSnapshot: DebugEntry[] = []

function rebuildSnapshot(): void {
  cachedSnapshot = Array.from(entries.entries())
    .map(([id, info]) => ({ id, ...info }))
    .sort((a, b) => a.id.localeCompare(b.id))
}

let publishScheduled = false
function schedulePublish(): void {
  if (publishScheduled) return
  publishScheduled = true
  queueMicrotask(() => {
    publishScheduled = false
    rebuildSnapshot()
    for (const l of listeners) l()
  })
}

export function registerDebugPartial(id: string, info: DebugInfo): void {
  const prev = entries.get(id)
  if (
    prev &&
    sameStrings(prev.uniqueTokens, info.uniqueTokens) &&
    sameStrings(prev.sharedTokens, info.sharedTokens) &&
    sameStrings(prev.framePath, info.framePath) &&
    sameStrings(prev.parentPath, info.parentPath)
  ) {
    return
  }
  entries.set(id, info)
  schedulePublish()
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

function getSnapshot(): DebugEntry[] {
  return cachedSnapshot
}

const EMPTY_ENTRIES: DebugEntry[] = []
function getServerSnapshot(): DebugEntry[] {
  return EMPTY_ENTRIES
}

// ─── Top-level panel ───────────────────────────────────────────────────

export function PartialsDebug() {
  // Gate subscription + rendering behind a post-hydration mount so the
  // initial client render matches SSR's empty output.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  if (!mounted) return null
  return <PartialsDebugMounted />
}

function PartialsDebugMounted() {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  const [collapsed, setCollapsed] = useState(true)

  if (snap.length === 0) return null

  return (
    <div
      data-testid="partials-debug"
      style={{
        position: "fixed",
        left: 0,
        bottom: 0,
        zIndex: 2147483000,
        background: "#111",
        border: "1px solid #333",
        borderRightWidth: 0,
        borderBottomWidth: 0,
        color: "#eee",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 12,
        lineHeight: "16px",
        maxHeight: "40vh",
        maxWidth: "min(100vw, 640px)",
        overflow: "auto",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "2px 8px",
          borderBottom: "1px solid #222",
          background: "#000",
        }}
      >
        <button
          type="button"
          data-testid="partials-debug-toggle"
          onClick={() => setCollapsed((c) => !c)}
          style={{
            background: "transparent",
            color: "#888",
            border: 0,
            padding: "0 4px",
            cursor: "pointer",
            fontFamily: "inherit",
            fontSize: 12,
          }}
        >
          {collapsed ? "▸" : "▾"} partials · {snap.length}
        </button>
      </div>
      {/* Rows are always present in the DOM (for test lookup) but
          visually hidden when collapsed to avoid intercepting clicks
          on nearby interactive content. */}
      <div style={{ display: collapsed ? "none" : "block" }}>
        <RootDebugRow />
        {snap.map((entry) => (
          <PartialDebugRow key={entry.id} entry={entry} />
        ))}
      </div>
    </div>
  )
}

// ─── Synthetic root row (represents the window scope) ─────────────────

function RootDebugRow() {
  const nav = useNavigation()
  const url = formatUrl(nav.currentEntry?.url)
  const rawState = nav.currentEntry?.getState()
  const displayState = stripFramesKey(rawState)
  const stateText = displayState == null ? "{}" : safeStringify(displayState)

  return (
    <div
      data-testid="partial-debug-root"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 0,
        padding: 0,
        borderBottom: "1px solid #1a1a1a",
        whiteSpace: "nowrap",
      }}
    >
      <span style={{ ...pillStyle(tokenColor("#root"), false), cursor: "default" }}>#root</span>
      <span style={sepStyle}>|</span>
      <span data-testid="partial-debug-root-url" style={infoStyle}>
        {url}
      </span>
      <span style={sepStyle}>|</span>
      <span
        data-testid="partial-debug-root-state"
        style={{
          ...infoStyle,
          flex: 1,
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {stateText}
      </span>
    </div>
  )
}

// ─── Per-Partial row ───────────────────────────────────────────────────

function PartialDebugRow({ entry }: { entry: DebugEntry }) {
  const [loadingToken, setLoadingToken] = useState<string | null>(null)

  const frameName = entry.framePath.length > 0 ? entry.framePath.join(".") : undefined
  // Frame handle for URL / back / forward / state. Falls back to the
  // window handle for non-frame Partials.
  const nav = useNavigation(frameName)
  // Selector-based reloads must dispatch on the page handle — frame
  // handles ignore `selector` and always refetch their whole subtree.
  const pageNav = useNavigation()

  async function reload(token: string) {
    setLoadingToken(token)
    try {
      await pageNav.reload({ selector: token }).finished
    } catch {
      // swallow
    } finally {
      setLoadingToken((cur) => (cur === token ? null : cur))
    }
  }

  const isWindowHandle = nav.name == null
  const url = formatUrl(nav.currentEntry?.url)
  const rawState = nav.currentEntry?.getState()
  const displayState = stripFramesKey(rawState)
  const stateText = displayState == null ? "{}" : safeStringify(displayState)
  // URL + state are only per-Partial on a frame handle — for a window-
  // scoped Partial they'd duplicate the synthetic #root row, which is
  // both redundant and (for state like window-level `scrollY`)
  // misleading ("looks like this Partial has state, but it's the page's").
  const showUrlState = !isWindowHandle
  const indent = entry.parentPath.length * 16

  return (
    <div
      data-testid={`partial-debug-${entry.id}`}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 0,
        borderBottom: "1px solid #1a1a1a",
        whiteSpace: "nowrap",
      }}
    >
      {indent > 0 && (
        <span
          aria-hidden
          style={{
            width: indent,
            minWidth: indent,
            alignSelf: "stretch",
            // Faint vertical tick that makes the nesting tree visible
            // even when the row's content is long and horizontally
            // scrolled.
            borderRight: "1px solid #333",
          }}
        />
      )}
      {entry.uniqueTokens.map((tok) => {
        const sel = `#${tok}`
        const dim = loadingToken === sel
        return (
          <button
            key={`u-${tok}`}
            type="button"
            data-testid={`partial-debug-${entry.id}-hash-${tok}`}
            onClick={() => void reload(sel)}
            disabled={dim}
            style={pillStyle(tokenColor(sel), dim)}
          >
            #{tok}
          </button>
        )
      })}
      {entry.sharedTokens.map((tok) => {
        const sel = `.${tok}`
        const dim = loadingToken === sel
        return (
          <button
            key={`s-${tok}`}
            type="button"
            data-testid={`partial-debug-${entry.id}-dot-${tok}`}
            onClick={() => void reload(sel)}
            disabled={dim}
            style={pillStyle(tokenColor(sel), dim)}
          >
            .{tok}
          </button>
        )
      })}
      {!isWindowHandle && (
        <>
          <span style={sepStyle}>|</span>
          <button
            type="button"
            data-testid={`partial-debug-${entry.id}-back`}
            onClick={() => void nav.back()}
            disabled={!nav.canGoBack}
            style={navBtnStyle(!nav.canGoBack)}
          >
            {"<"}
          </button>
          <button
            type="button"
            data-testid={`partial-debug-${entry.id}-forward`}
            onClick={() => void nav.forward()}
            disabled={!nav.canGoForward}
            style={navBtnStyle(!nav.canGoForward)}
          >
            {">"}
          </button>
        </>
      )}
      {showUrlState && (
        <>
          <span style={sepStyle}>|</span>
          <span data-testid={`partial-debug-${entry.id}-url`} style={infoStyle}>
            {url}
          </span>
          <span style={sepStyle}>|</span>
          <span
            data-testid={`partial-debug-${entry.id}-state`}
            style={{
              ...infoStyle,
              flex: 1,
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {stateText}
          </span>
        </>
      )}
    </div>
  )
}

// ─── Styles ────────────────────────────────────────────────────────────

function pillStyle(color: string, dim: boolean): CSSProperties {
  return {
    background: color,
    color: "#000",
    padding: "0 4px",
    border: 0,
    borderRight: "1px solid rgba(0,0,0,0.3)",
    fontFamily: "inherit",
    fontSize: 12,
    lineHeight: "16px",
    cursor: dim ? "default" : "pointer",
    opacity: dim ? 0.35 : 1,
    transition: "opacity 0.1s",
  }
}

function navBtnStyle(disabled: boolean): CSSProperties {
  return {
    background: "#333",
    color: "#fff",
    padding: "0 6px",
    border: 0,
    borderRight: "1px solid #000",
    fontFamily: "inherit",
    fontSize: 12,
    lineHeight: "16px",
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.35 : 1,
  }
}

const infoStyle: CSSProperties = {
  background: "#111",
  color: "#eee",
  padding: "0 4px",
  borderRight: "1px solid #000",
}

const sepStyle: CSSProperties = {
  background: "#000",
  color: "#000",
  width: 1,
}

// ─── Formatting ────────────────────────────────────────────────────────

function formatUrl(u: string | undefined | null): string {
  if (!u) return "—"
  try {
    const parsed = new URL(u)
    return parsed.pathname + parsed.search
  } catch {
    return u
  }
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v)
  } catch {
    return "{}"
  }
}

// The frame handle's `getState()` returns a projection that includes
// the framework's internal `__frames` bucket. Strip it for display so
// the debug panel only shows user-written state.
function stripFramesKey(state: unknown): unknown {
  if (state == null || typeof state !== "object" || Array.isArray(state)) {
    return state
  }
  const copy: Record<string, unknown> = {}
  let any = false
  for (const [k, v] of Object.entries(state as Record<string, unknown>)) {
    if (k === "__frames" || k === "__frameHistory") continue
    copy[k] = v
    any = true
  }
  return any ? copy : null
}

// Hash a string to an HSL color. Same input → same color.
function tokenColor(token: string): string {
  let h = 0
  for (let i = 0; i < token.length; i++) {
    h = (Math.imul(h, 31) + token.charCodeAt(i)) | 0
  }
  const hue = Math.abs(h) % 360
  return `hsl(${hue} 75% 65%)`
}
