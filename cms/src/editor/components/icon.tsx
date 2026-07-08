import type { ReactNode } from "react"

/**
 * Editor chrome icon set — flat 16x16 line icons sharing one viewBox
 * + stroke so they read as a family. Subset of the design's icons,
 * scoped to the surfaces this editor renders.
 */
const PATHS: Record<string, ReactNode> = {
  layers: (
    <>
      <path d="M8 1.5L1.5 5 8 8.5 14.5 5 8 1.5z" />
      <path d="M1.5 8L8 11.5 14.5 8" />
      <path d="M1.5 11L8 14.5 14.5 11" />
    </>
  ),
  settings: (
    <>
      <circle cx="8" cy="8" r="2" />
      <path d="M13.4 9.4l1.1.6-1 1.7-1.2-.4a4.5 4.5 0 01-1.4.8l-.2 1.3H8.3l-.2-1.3a4.5 4.5 0 01-1.4-.8l-1.2.4-1-1.7 1.1-.6a4.5 4.5 0 010-1.6l-1.1-.6 1-1.7 1.2.4a4.5 4.5 0 011.4-.8l.2-1.3h2.4l.2 1.3a4.5 4.5 0 011.4.8l1.2-.4 1 1.7-1.1.6a4.5 4.5 0 010 1.6z" />
    </>
  ),
  home: <path d="M2.5 7L8 2.5 13.5 7v6.5h-3v-4h-5v4h-3V7z" />,
  block: <rect x="2" y="2" width="12" height="12" rx="1" />,
  section: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M2 6h12M2 10h12" />
    </>
  ),
  cols: (
    <>
      <rect x="2" y="3" width="5" height="10" rx="1" />
      <rect x="9" y="3" width="5" height="10" rx="1" />
    </>
  ),
  text: <path d="M3 4h10M3 8h10M3 12h6" />,
  heading: <path d="M3 3v10M3 8h7M10 3v10" />,
  image: (
    <>
      <rect x="2" y="2" width="12" height="12" rx="1" />
      <circle cx="6" cy="6" r="1.2" />
      <path d="M2 11l4-3 4 3 4-2" />
    </>
  ),
  button: <rect x="2" y="5" width="12" height="6" rx="3" />,
  star: <path d="M8 2l1.8 4 4.2.4-3.2 2.9 1 4.2L8 11.3 4.2 13.5l1-4.2L2 6.4l4.2-.4L8 2z" />,
  nav: <path d="M2 4h12M2 8h12M2 12h12" />,
  cart: (
    <>
      <path d="M2 3h2l1.5 8h7L14 5H5" />
      <circle cx="6.5" cy="13.5" r="1" />
      <circle cx="11.5" cy="13.5" r="1" />
    </>
  ),
  page: (
    <>
      <path d="M3 2h6l4 4v8H3V2z" />
      <path d="M9 2v4h4" />
    </>
  ),
  pen: <path d="M11 2l3 3-9 9H2v-3l9-9z" />,
  exit: (
    <>
      <path d="M7 3h6v10H7" />
      <path d="M9 8H2M5 5L2 8l3 3" />
    </>
  ),
  desktop: (
    <>
      <rect x="2" y="3" width="12" height="8" rx="1" />
      <path d="M5 14h6" />
    </>
  ),
  tablet: <rect x="4" y="2" width="8" height="12" rx="1" />,
  mobile: <rect x="5" y="2" width="6" height="12" rx="1" />,
  undo: (
    <>
      <path d="M3 5l-2 2 2 2" />
      <path d="M1 7h8a4 4 0 014 4v1" />
    </>
  ),
  redo: (
    <>
      <path d="M13 5l2 2-2 2" />
      <path d="M15 7H7a4 4 0 00-4 4v1" />
    </>
  ),
  search: (
    <>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5L13.5 13.5" />
    </>
  ),
  plus: <path d="M8 3v10M3 8h10" />,
  chevDown: <path d="M3.5 6L8 10.5 12.5 6" />,
  chevRight: <path d="M6 3.5L10.5 8 6 12.5" />,
  close: <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />,
  trash: (
    <path d="M3 4.5h10M6.5 4.5V3a1 1 0 011-1h1a1 1 0 011 1v1.5M4.5 4.5v8.5a1 1 0 001 1h5a1 1 0 001-1V4.5" />
  ),
  eye: (
    <>
      <path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="1.8" />
    </>
  ),
  eyeOff: (
    <>
      <path d="M2 8s2.5-4.5 6-4.5c1.2 0 2.3.4 3.2 1M14 8s-2.5 4.5-6 4.5c-1.2 0-2.3-.4-3.2-1" />
      <path d="M1.5 1.5l13 13" />
    </>
  ),
  database: (
    <>
      <ellipse cx="8" cy="3.5" rx="5" ry="1.8" />
      <path d="M3 3.5v9c0 1 2.24 1.8 5 1.8s5-.8 5-1.8v-9" />
      <path d="M3 8c0 1 2.24 1.8 5 1.8s5-.8 5-1.8" />
    </>
  ),
  sun: (
    <>
      <circle cx="8" cy="8" r="2.5" />
      <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
    </>
  ),
  moon: <path d="M13 9.5A5.5 5.5 0 116.5 3a4.5 4.5 0 006.5 6.5z" />,
  floatPanels: (
    <>
      <rect x="1.5" y="1.5" width="13" height="13" rx="1.5" />
      <rect x="3.5" y="3.5" width="4" height="9" rx="0.8" />
      <rect x="9.5" y="3.5" width="3" height="9" rx="0.8" />
    </>
  ),
  dockPanels: (
    <>
      <rect x="1.5" y="1.5" width="13" height="13" rx="1.5" />
      <path d="M5 1.5v13M11 1.5v13" />
    </>
  ),
  surface: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 2v12" />
    </>
  ),
}

export type IconName = keyof typeof PATHS

export function Icon({
  name,
  size = 16,
  className,
  strokeWidth = 1.5,
}: {
  name: string
  size?: number
  className?: string
  strokeWidth?: number
}) {
  const path = PATHS[name as IconName] ?? PATHS.block
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={{ display: "inline-block", flexShrink: 0 }}
      aria-hidden
    >
      {path}
    </svg>
  )
}

export function SixDot({ className }: { className?: string }) {
  return (
    <span
      className={className}
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(2, 2.5px)",
        gridTemplateRows: "repeat(3, 2.5px)",
        gap: 2.5,
      }}
      aria-hidden
    >
      {Array.from({ length: 6 }).map((_, i) => (
        <span
          key={i}
          style={{ width: 2.5, height: 2.5, background: "currentColor", borderRadius: "50%" }}
        />
      ))}
    </span>
  )
}
