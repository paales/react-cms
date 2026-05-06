import type { ReactNode } from "react"
import { ChromeTab, ChromeTabStrip } from "./chrome-tab.tsx"
import { SixDot } from "./icon.tsx"
import { SessionToggleLink } from "./session-toggle.tsx"

/**
 * Unified tab-bar for the editor panels. Picks markup per surface:
 *
 *   surface=light | solid → chrome-style overlap-shoulder tabs
 *   surface=translucent   → flat segmented pill (cms-wf-segment)
 *
 * The V6 design switches representations in translucent mode because
 * the chrome shoulders rely on a solid strip background for contrast;
 * over a glass surface they read as smudges. The segmented pill stays
 * legible.
 *
 * `tabs[*].closeHref` renders a close × on that tab. For chrome tabs
 * the close lives inside the tab; for segments it sits at the right
 * edge of each pill.
 */

export interface PanelTab {
  id: string
  label: string
  icon?: ReactNode
  /** URL-bound activation. Use when the tab represents a shareable
   *  view (e.g. the right panel's element tabs reflecting `?select=`). */
  href?: string
  /** Session-bound activation. Use when the tab toggles a transient
   *  editor view (e.g. the left panel's Layers / Settings switch). */
  sessionToggle?: { name: string; value: string | number | boolean }
  active?: boolean
  closeHref?: string
  testId?: string
}

export function PanelTabBar({
  tabs,
  surface,
  attachment,
  align = "left",
}: {
  tabs: ReadonlyArray<PanelTab>
  surface: "light" | "solid" | "translucent"
  attachment: "floating" | "docked"
  align?: "left" | "right"
}) {
  if (surface !== "translucent") {
    return (
      <ChromeTabStrip align={align}>
        {tabs.map((t, i) => (
          <ChromeTab
            key={t.id}
            label={t.label}
            icon={t.icon}
            active={t.active}
            href={t.href}
            onCloseHref={t.closeHref}
            testId={t.testId}
            first={i === 0}
          />
        ))}
      </ChromeTabStrip>
    )
  }
  // Translucent — flat segmented pill, optionally with a leading
  // drag handle (only when floating; docked has no draggable chrome).
  return (
    <div
      className="cms-segment-strip"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: attachment === "docked" ? "0 10px" : "8px 10px",
        height: attachment === "docked" ? 48 : undefined,
        justifyContent: align === "right" ? "flex-end" : "flex-start",
      }}
    >
      {attachment !== "docked" && align === "left" && (
        <span
          style={{
            color: "var(--cms-ink-3)",
            opacity: 0.55,
            marginRight: 2,
            cursor: "grab",
            display: "inline-flex",
          }}
          aria-hidden
        >
          <SixDot />
        </span>
      )}
      <div
        className="cms-wf-segment"
        style={{
          height: 26,
          alignSelf: "center",
          ...(align === "right" ? { marginLeft: "auto" } : null),
        }}
      >
        {tabs.map((t) => (
          <div
            key={t.id}
            data-active={t.active ? "true" : undefined}
            style={{
              display: "flex",
              alignItems: "center",
              flex: "0 0 auto",
              borderRadius: 4,
              position: "relative",
              ...(t.active
                ? {
                    background: "var(--cms-input-bg)",
                    boxShadow: "0 1px 2px rgba(0,0,0,0.06)",
                  }
                : null),
            }}
          >
            {t.sessionToggle ? (
              <SessionToggleLink
                name={t.sessionToggle.name}
                value={t.sessionToggle.value}
                testId={t.testId}
                active={t.active}
                className="cms-segment-link"
              >
                {t.icon}
                <span
                  style={{
                    flex: 1,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {t.label}
                </span>
              </SessionToggleLink>
            ) : (
              <a
                href={t.href}
                data-testid={t.testId}
                data-active={t.active ? "true" : undefined}
                style={{
                  flex: 1,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: t.closeHref ? "0 22px 0 8px" : "0 8px",
                  textDecoration: "none",
                  color: t.active ? "var(--cms-ink)" : "var(--cms-ink-2)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                }}
              >
                {t.icon}
                <span
                  style={{
                    flex: 1,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {t.label}
                </span>
              </a>
            )}
            {t.closeHref && (
              <a
                href={t.closeHref}
                aria-label={`Close ${t.label}`}
                style={{
                  position: "absolute",
                  right: 4,
                  top: "50%",
                  transform: "translateY(-50%)",
                  width: 14,
                  height: 14,
                  display: "grid",
                  placeItems: "center",
                  color: "var(--cms-ink-3)",
                  borderRadius: 7,
                  textDecoration: "none",
                }}
              >
                <svg
                  width="9"
                  height="9"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                >
                  <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
                </svg>
              </a>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
