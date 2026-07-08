import type { ReactNode } from "react"

/**
 * Chrome-style tab strip — curved top corners + outward-flaring
 * bottom shoulders so adjacent active tabs read as one continuous
 * chrome row. Active tab paints an SVG path; inactive tabs are flat
 * label rows. Close-X tabs render the close as a separate sibling
 * anchor (NOT nested) so the markup stays valid + server-renderable
 * (no event handlers).
 */

const TAB_H = 26
const R = 7

function activePath(width: number) {
  return `M 0 ${TAB_H}
  C ${R} ${TAB_H} ${R} ${TAB_H - R} ${R} ${TAB_H - R}
  L ${R} ${R}
  Q ${R} 0 ${R * 2} 0
  L ${width - R * 2} 0
  Q ${width - R} 0 ${width - R} ${R}
  L ${width - R} ${TAB_H - R}
  C ${width - R} ${TAB_H - R} ${width - R} ${TAB_H} ${width} ${TAB_H}
  Z`
}

function tabWidth(label: string, hasIcon: boolean, hasClose: boolean): number {
  const labelW = Math.max(label.length * 6.8, 36)
  const icon = hasIcon ? 14 + 6 : 0
  const right = hasClose ? 6 + 14 + R : R + 6
  return Math.round(R + 10 + icon + labelW + right)
}

export function ChromeTabStrip({
  children,
  align = "left",
}: {
  children: ReactNode
  align?: "left" | "right"
}) {
  return (
    <div
      className="cms-chrome-strip"
      style={{
        display: "flex",
        alignItems: "flex-end",
        paddingTop: 8,
        paddingLeft: 8,
        paddingRight: 8,
        height: TAB_H,
        gap: 0,
        justifyContent: align === "right" ? "flex-end" : "flex-start",
      }}
    >
      {children}
    </div>
  )
}

export function ChromeTab({
  label,
  icon,
  active,
  href,
  onCloseHref,
  testId,
  first = false,
}: {
  label: string
  icon?: ReactNode
  active?: boolean
  href?: string
  onCloseHref?: string
  testId?: string
  first?: boolean
}) {
  const w = tabWidth(label, !!icon, !!onCloseHref)
  return (
    <div
      style={{
        position: "relative",
        width: w,
        height: TAB_H,
        marginLeft: first ? 0 : -R,
        zIndex: active ? 2 : 1,
      }}
    >
      {active && (
        <svg
          width={w}
          height={TAB_H}
          viewBox={`0 0 ${w} ${TAB_H}`}
          style={{ position: "absolute", inset: 0, display: "block" }}
        >
          <path d={activePath(w)} fill="var(--cms-panel-bg)" />
        </svg>
      )}
      <a
        href={href}
        data-testid={testId}
        data-active={active || undefined}
        style={{
          position: "absolute",
          left: 0,
          right: onCloseHref ? 24 : 0,
          top: 0,
          bottom: 0,
          display: "flex",
          alignItems: "center",
          gap: 6,
          paddingLeft: R + 10,
          paddingRight: onCloseHref ? 4 : R + 6,
          textDecoration: "none",
          whiteSpace: "nowrap",
          color: active ? "var(--cms-ink)" : "var(--cms-ink-2)",
          fontSize: 13,
          overflow: "hidden",
        }}
      >
        {icon}
        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>{label}</span>
      </a>
      {onCloseHref && (
        <a
          href={onCloseHref}
          aria-label={`Close ${label}`}
          style={{
            position: "absolute",
            right: R,
            top: "50%",
            transform: "translateY(-50%)",
            width: 14,
            height: 14,
            borderRadius: 7,
            display: "grid",
            placeItems: "center",
            color: "var(--cms-ink-3)",
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
  )
}
