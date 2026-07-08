// V6 — consolidated direction (revised: shadcn aesthetic)
// • Two floating panels, height = content (no taller than needed)
// • Normalized type scale: 14 base / 13 row label / 12 hint / 11 mono
// • Icons: 16px line-icons, all visually equal weight
// • No color tinting on selection in tree (just bold + dot indicator)
// • Removed "Remove section" footer

// Two sizes total: UI (sans serif) and mono. `label` is the small caption used
// for uppercase section heads, hints, and the ⌘K badge.
const T = {
  ui: 13,
  mono: 12,
  label: 11,
}
// Palette presets — driven by the Tweaks panel.
// Each preset returns: SEL/SEL_STRONG/SEL_FILL/SEL_FILL_STRONG (selection),
// C_TAG/C_ATTR/C_ATTR_VAL (JSX-style coloring), and a `dark` flag for surface.
const PALETTES = {
  inspector: {
    // Chrome devtools — purple/pink + brown attrs + blue values
    SEL: "#881280",
    SEL_STRONG: "#6e0e68",
    SEL_FILL: "rgba(136,18,128,0.08)",
    SEL_FILL_STRONG: "rgba(136,18,128,0.15)",
    C_TAG: "#881280",
    C_ATTR: "#994500",
    C_ATTR_VAL: "#1a1aa6",
    dark: false,
  },
  dark: {
    // Chrome devtools dark mode
    SEL: "#d3a4ff",
    SEL_STRONG: "#e6c2ff",
    SEL_FILL: "rgba(211,164,255,0.10)",
    SEL_FILL_STRONG: "rgba(211,164,255,0.18)",
    C_TAG: "#d3a4ff",
    C_ATTR: "#f4b66a",
    C_ATTR_VAL: "#9bb6ff",
    dark: true,
  },
}
function usePalette() {
  const tw = React.useContext(window.TweaksCtx || React.createContext({}))
  return PALETTES[tw.palette] || PALETTES.inspector
}

// Polaris-flavored slider row: thin track + thumb on the left, an inline
// number-stepper field on the right showing the current value. Replaces the
// older "thin track with a hint number underneath" pattern, which read as
// half-finished — value lived in a separate row from the control.
function SliderField({ value, suffix, pct = 35, dark }) {
  const fieldBg = dark ? "rgba(255,255,255,0.06)" : "#fff"
  const fieldBorder = dark ? "1px solid rgba(255,255,255,0.14)" : "1px solid rgba(0,0,0,0.12)"
  const ink = dark ? "#f1f1f4" : "var(--ink)"
  const ink3 = dark ? "rgba(241,241,244,0.5)" : "var(--ink-3)"
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div className="wf-slider" style={{ flex: 1, "--pct": `${pct}%` }} />
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          height: 22,
          padding: "0 5px 0 6px",
          background: fieldBg,
          border: fieldBorder,
          borderRadius: 5,
          fontFamily: "var(--ui)",
          fontSize: T.ui,
          color: ink,
          minWidth: 44,
        }}
      >
        <span style={{ flex: 1, textAlign: "right" }}>{value}</span>
        {suffix && <span style={{ color: ink3, fontSize: T.label }}>{suffix}</span>}
      </div>
    </div>
  )
}

// Convert "FeaturedCollection" → "Featured collection" for plain-tree-style rendering.
function camelToSpace(s) {
  if (!s) return s
  return s
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase())
    .toLowerCase()
    .replace(/^./, (c) => c.toUpperCase())
}

// Panel surface style — picks fill/border/blur based on palette darkness + surface mode.
function usePanelSurface() {
  const tw = React.useContext(window.TweaksCtx || React.createContext({}))
  const surface = tw.surface || "light"
  const pal = PALETTES[tw.palette] || PALETTES.inspector
  if (pal.dark) {
    if (surface === "translucent")
      return {
        background: "rgba(28,28,32,0.78)",
        border: "1px solid rgba(255,255,255,0.10)",
        boxShadow: "0 16px 40px rgba(0,0,0,0.50)",
        backdropFilter: "blur(14px) saturate(140%)",
        WebkitBackdropFilter: "blur(14px) saturate(140%)",
        color: "#e6e6ea",
      }
    if (surface === "solid")
      return {
        background: "#1c1c20",
        border: "1px solid rgba(255,255,255,0.12)",
        boxShadow: "none",
        color: "#e6e6ea",
      }
    return {
      background: "#1c1c20",
      border: "1px solid rgba(255,255,255,0.08)",
      boxShadow: "0 12px 30px rgba(0,0,0,0.45)",
      color: "#e6e6ea",
    }
  }
  if (surface === "translucent")
    return {
      background: "linear-gradient(135deg, rgba(255,255,255,0.78) 0%, rgba(248,243,232,0.55) 100%)",
      border: "1px solid rgba(255,255,255,0.95)",
      boxShadow:
        "0 1px 0 rgba(255,255,255,0.9) inset, 0 -1px 0 rgba(0,0,0,0.04) inset, 0 18px 50px rgba(60,50,30,0.18), 0 4px 12px rgba(60,50,30,0.08)",
      backdropFilter: "blur(24px) saturate(180%)",
      WebkitBackdropFilter: "blur(24px) saturate(180%)",
    }
  if (surface === "solid")
    return {
      background: "#fff",
      border: "1px solid rgba(0,0,0,0.18)",
      boxShadow: "none",
    }
  return {
    background: "#fff",
    border: "1px solid rgba(0,0,0,0.12)",
    boxShadow: "0 12px 30px rgba(0,0,0,0.12)",
  }
}

// Diagonal double-line resize grip — sits in the bottom-right corner of a panel.
// Two short ticks angled to follow the corner curve, devtools/macOS vocab.
function ResizeGrip() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      style={{
        position: "absolute",
        right: 3,
        bottom: 3,
        cursor: "nwse-resize",
        color: "rgba(0,0,0,0.32)",
        pointerEvents: "none",
      }}
    >
      <line
        x1="11"
        y1="5"
        x2="5"
        y2="11"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinecap="round"
      />
      <line
        x1="11"
        y1="9"
        x2="9"
        y2="11"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinecap="round"
      />
    </svg>
  )
}

// Tiny icon set — flat 16×16 SVG primitives with consistent stroke.
// All icons use the same viewBox + stroke so they read as one family.
function Icon({ name, size = 16, color = "currentColor", strokeWidth = 1.5 }) {
  const s = size
  const sw = strokeWidth
  const common = {
    width: s,
    height: s,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: color,
    strokeWidth: sw,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    style: { display: "inline-block", flexShrink: 0 },
  }
  const paths = {
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
    theme: (
      <>
        <circle cx="8" cy="8" r="6" />
        <path d="M8 2v12M2 8h12" />
      </>
    ),
    home: (
      <>
        <path d="M2.5 7L8 2.5 13.5 7v6.5h-3v-4h-5v4h-3V7z" />
      </>
    ),
    section: (
      <>
        <rect x="2" y="3" width="12" height="10" rx="1" />
        <path d="M2 7h12" />
      </>
    ),
    block: (
      <>
        <rect x="2" y="2" width="12" height="12" rx="1" />
      </>
    ),
    grid: (
      <>
        <rect x="2" y="2" width="5" height="5" />
        <rect x="9" y="2" width="5" height="5" />
        <rect x="2" y="9" width="5" height="5" />
        <rect x="9" y="9" width="5" height="5" />
      </>
    ),
    cols: (
      <>
        <rect x="2" y="2" width="3" height="12" />
        <rect x="6.5" y="2" width="3" height="12" />
        <rect x="11" y="2" width="3" height="12" />
      </>
    ),
    nav: (
      <>
        <path d="M2 4h12M2 8h12M2 12h12" />
      </>
    ),
    text: (
      <>
        <path d="M3 4h10M3 8h10M3 12h6" />
      </>
    ),
    heading: (
      <>
        <path d="M3 3v10M3 8h7M10 3v10" />
      </>
    ),
    image: (
      <>
        <rect x="2" y="2" width="12" height="12" rx="1" />
        <circle cx="6" cy="6" r="1.2" />
        <path d="M2 11l4-3 4 3 4-2" />
      </>
    ),
    button: (
      <>
        <rect x="2" y="5" width="12" height="6" rx="3" />
      </>
    ),
    star: (
      <>
        <path d="M8 2l1.8 4 4.2.4-3.2 2.9 1 4.2L8 11.3 4.2 13.5l1-4.2L2 6.4l4.2-.4L8 2z" />
      </>
    ),
    folder: (
      <>
        <path d="M2 4h4l1.5 2H14v6.5H2V4z" />
      </>
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
    plus: (
      <>
        <path d="M8 3v10M3 8h10" />
      </>
    ),
    minus: (
      <>
        <path d="M3 8h10" />
      </>
    ),
    chevDown: (
      <>
        <path d="M3.5 6L8 10.5 12.5 6" />
      </>
    ),
    chevRight: (
      <>
        <path d="M6 3.5L10.5 8 6 12.5" />
      </>
    ),
    close: (
      <>
        <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
      </>
    ),
    search: (
      <>
        <circle cx="7" cy="7" r="4.5" />
        <path d="M10.5 10.5L13.5 13.5" />
      </>
    ),
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
    play: (
      <>
        <path d="M5 3l8 5-8 5V3z" />
      </>
    ),
    cart: (
      <>
        <path d="M2 3h2l1.5 8h7L14 5H5" />
        <circle cx="6.5" cy="13.5" r="1" />
        <circle cx="11.5" cy="13.5" r="1" />
      </>
    ),
    tag: (
      <>
        <path d="M2 2h6l6 6-6 6-6-6V2z" />
        <circle cx="5" cy="5" r="1" />
      </>
    ),
    page: (
      <>
        <path d="M3 2h6l4 4v8H3V2z" />
        <path d="M9 2v4h4" />
      </>
    ),
    pen: (
      <>
        <path d="M11 2l3 3-9 9H2v-3l9-9z" />
      </>
    ),
    lock: (
      <>
        <rect x="3" y="7" width="10" height="7" rx="1" />
        <path d="M5 7V5a3 3 0 016 0v2" />
      </>
    ),
    gift: (
      <>
        <rect x="2" y="6" width="12" height="3" />
        <rect x="3" y="9" width="10" height="5" />
        <path d="M8 6v8M5 6S4 4 5.5 3.5 8 6 8 6 9 3 10.5 3.5 11 6 11 6" />
      </>
    ),
    gridList: (
      <>
        <rect x="2" y="2" width="4" height="4" />
        <rect x="2" y="9" width="4" height="4" />
        <path d="M8 4h6M8 11h6" />
      </>
    ),
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
    tablet: (
      <>
        <rect x="4" y="2" width="8" height="12" rx="1" />
      </>
    ),
    mobile: (
      <>
        <rect x="5" y="2" width="6" height="12" rx="1" />
      </>
    ),
    arrows: (
      <>
        <path d="M5 5L2 8l3 3M11 5l3 3-3 3" />
      </>
    ),
    coin: (
      <>
        <circle cx="8" cy="8" r="6" />
        <path d="M9.5 6.5h-2.5a1 1 0 100 2h2a1 1 0 110 2H6.5" />
        <path d="M8 4.5v1M8 10.5v1" />
      </>
    ),
    diamond: (
      <>
        <path d="M8 2L14 8 8 14 2 8 8 2z" />
      </>
    ),
    template: (
      <>
        <rect x="2" y="2" width="12" height="3" />
        <rect x="2" y="6" width="5" height="8" />
        <rect x="8" y="6" width="6" height="8" />
      </>
    ),
    trash: (
      <>
        <path d="M3 4.5h10M6.5 4.5V3a1 1 0 011-1h1a1 1 0 011 1v1.5M4.5 4.5v8.5a1 1 0 001 1h5a1 1 0 001-1V4.5" />
      </>
    ),
    duplicate: (
      <>
        <rect x="2" y="2" width="9" height="9" rx="1" />
        <path d="M5 14h8a1 1 0 001-1V6" />
      </>
    ),
    more: (
      <>
        <circle cx="3.5" cy="8" r="0.8" />
        <circle cx="8" cy="8" r="0.8" />
        <circle cx="12.5" cy="8" r="0.8" />
      </>
    ),
    sectionPolaris: (
      <>
        <rect x="2" y="3" width="12" height="10" rx="1.5" />
        <path d="M2 6h12M2 10h12" />
      </>
    ),
    headerPolaris: (
      <>
        <rect x="2" y="3" width="12" height="10" rx="1.5" />
        <path d="M2 6h12" />
        <circle cx="4.5" cy="4.5" r="0.4" />
        <circle cx="6" cy="4.5" r="0.4" />
        <circle cx="7.5" cy="4.5" r="0.4" />
      </>
    ),
    footerPolaris: (
      <>
        <rect x="2" y="3" width="12" height="10" rx="1.5" />
        <path d="M2 10h12" />
      </>
    ),
    columnsPolaris: (
      <>
        <rect x="2" y="3" width="5" height="10" rx="1" />
        <rect x="9" y="3" width="5" height="10" rx="1" />
      </>
    ),
    bannerPolaris: (
      <>
        <rect x="2" y="4" width="12" height="8" rx="1.5" />
        <path d="M2 9l3-2 2 1.5 3-2.5 4 3" />
      </>
    ),
    quotePolaris: (
      <>
        <path d="M3 6a2 2 0 012-2v2a1 1 0 00-1 1v3H3V6zM9 6a2 2 0 012-2v2a1 1 0 00-1 1v3H9V6z" />
      </>
    ),
    database: (
      <>
        <ellipse cx="8" cy="3.5" rx="5" ry="1.8" />
        <path d="M3 3.5v9c0 1 2.24 1.8 5 1.8s5-.8 5-1.8v-9" />
        <path d="M3 8c0 1 2.24 1.8 5 1.8s5-.8 5-1.8" />
      </>
    ),
    // Sun (light mode) — circle + 8 short rays.
    sun: (
      <>
        <circle cx="8" cy="8" r="2.5" />
        <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
      </>
    ),
    // Crescent moon (dark mode).
    moon: (
      <>
        <path d="M13 9.5A5.5 5.5 0 116.5 3a4.5 4.5 0 006.5 6.5z" />
      </>
    ),
    // Floating panels — small rectangle inside a larger frame, with margin.
    floatPanels: (
      <>
        <rect x="1.5" y="1.5" width="13" height="13" rx="1.5" />
        <rect x="3.5" y="3.5" width="4" height="9" rx="0.8" />
        <rect x="9.5" y="3.5" width="3" height="9" rx="0.8" />
      </>
    ),
    // Docked panels — full-height bars flush to the edges, no margin.
    dockPanels: (
      <>
        <rect x="1.5" y="1.5" width="13" height="13" rx="1.5" />
        <path d="M5 1.5v13M11 1.5v13" />
      </>
    ),
  }
  return <svg {...common}>{paths[name] || paths.block}</svg>
}

function V6Consolidated() {
  const { SEL, SEL_STRONG, SEL_FILL, SEL_FILL_STRONG, C_TAG, C_ATTR, C_ATTR_VAL, dark } =
    usePalette()
  const W = 1440,
    H = 900
  const [leftTab, setLeftTab] = React.useState("layers")
  const [pageOpen, setPageOpen] = React.useState(false)
  const tweaks = React.useContext(window.TweaksCtx || React.createContext({}))
  const attachment = tweaks.attachment || "floating"

  return (
    <div
      data-attachment={attachment}
      data-surface={tweaks.surface || "light"}
      data-dark={dark || undefined}
      style={{
        position: "relative",
        width: W,
        height: H,
        background: dark
          ? "radial-gradient(circle at 20% 10%, #1a1a24 0%, #0e0e12 60%), #0e0e12"
          : "radial-gradient(circle at 18% 12%, #f3eee2 0%, #e3dccb 55%, #d6cdb6 100%)",
        overflow: "hidden",
      }}
    >
      <SiteMock width={W} height={H} dim />

      <TopBar pageOpen={pageOpen} setPageOpen={setPageOpen} />
      {pageOpen && <PageNavigator onClose={() => setPageOpen(false)} />}

      {/* Selection chrome on featured-collection — Chrome-inspector style with attached label */}
      <div style={{ position: "absolute", left: 30, top: 490, pointerEvents: "none" }}>
        <div
          style={{
            width: W - 60,
            height: 200,
            outline: `1.5px dashed ${SEL}`,
            outlineOffset: -1,
            background: SEL_FILL,
          }}
        />
        <div
          className="stripes-margin"
          style={{ position: "absolute", left: 0, right: 0, top: -10, height: 10 }}
        />
        <div
          className="stripes-margin"
          style={{ position: "absolute", left: 0, right: 0, bottom: -10, height: 10 }}
        />
        {[
          { left: -4, top: -4 },
          { right: -4, top: -4 },
          { left: -4, bottom: -4 },
          { right: -4, bottom: -4 },
        ].map((p, i) => (
          <div
            key={i}
            style={{
              position: "absolute",
              width: 7,
              height: 7,
              background: "#fff",
              border: `1.5px solid ${SEL_STRONG}`,
              borderRadius: 1,
              ...p,
            }}
          />
        ))}

        {/* Attached browser-inspector label — sits flush to bottom-left of selection */}
        <div
          style={{
            position: "absolute",
            left: -1,
            top: "100%",
            marginTop: 10,
            background: dark ? "#1c1c20" : "#fff",
            border: `1px solid ${SEL}`,
            borderRadius: 3,
            padding: "3px 7px",
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontFamily: "var(--mono)",
            fontSize: T.label,
            boxShadow: "0 2px 6px rgba(0,0,0,0.12)",
            whiteSpace: "nowrap",
          }}
        >
          <span style={{ color: C_TAG }}>FeaturedCollection</span>
          <span style={{ color: "var(--ink-3)" }}>1380 × 200</span>
        </div>
      </div>

      {/* Add-block insertion line — sits just above the selection */}
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: 470,
          transform: "translateX(-50%)",
          zIndex: 6,
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <div style={{ width: 320, height: 1, background: "#2c7fd6", opacity: 0.35 }} />
        <div
          style={{
            width: 22,
            height: 22,
            borderRadius: "50%",
            background: "#2c7fd6",
            color: "#fff",
            display: "grid",
            placeItems: "center",
            boxShadow: "0 4px 10px rgba(44,127,214,0.4)",
          }}
        >
          <Icon name="plus" size={12} color="#fff" strokeWidth={2.2} />
        </div>
        <div style={{ width: 320, height: 1, background: "#2c7fd6", opacity: 0.35 }} />
      </div>

      <LeftPanel tab={leftTab} setTab={setLeftTab} />
      <RightPanel />
    </div>
  )
}

function TopBar({ pageOpen, setPageOpen }) {
  const ICON = 16
  const tw = React.useContext(window.TweaksCtx || React.createContext({}))
  const surface = usePanelSurface()
  const pal = usePalette()
  const mode = tw.toolbar || "floating"
  if (mode === "hidden") return null
  // Toolbar ink — flips for dark palettes since the toolbar fill is dark gray there.
  const ink2 = pal.dark ? "rgba(241,241,244,0.78)" : "var(--ink-2)"
  const ink3 = pal.dark ? "rgba(241,241,244,0.50)" : "var(--ink-3)"
  const ribbon = mode === "ribbon"
  const docked = tw.attachment === "docked"
  return (
    <div
      data-topbar
      style={{
        position: "absolute",
        display: "flex",
        alignItems: "center",
        gap: 4,
        zIndex: 10,
        fontFamily: "var(--ui)",
        fontSize: T.ui,
        color: pal.dark ? "#e6e6ea" : "var(--ink)",
        // When docked, the topbar stretches between the two side panels and reads
        // as a chrome row — center the controls in that bar so it feels balanced.
        ...(ribbon
          ? {
              left: 0,
              right: 0,
              top: 0,
              transform: "none",
              borderRadius: 0,
              height: 48,
              padding: "0 16px",
              background: pal.dark ? "#1c1c20" : "#fff",
              border: "none",
              borderBottom: pal.dark
                ? "1px solid rgba(255,255,255,0.10)"
                : "1px solid rgba(0,0,0,0.10)",
              boxShadow: "none",
              width: "100%",
              justifyContent: docked ? "center" : "flex-start",
            }
          : {
              left: "50%",
              top: 14,
              transform: "translateX(-50%)",
              borderRadius: 10,
              height: 44,
              padding: "0 6px",
              ...surface,
              ...(tw.surface === "translucent"
                ? {}
                : {
                    background: pal.dark ? "#1c1c20" : "#f3f3f3",
                  }),
              ...(docked ? { justifyContent: "center" } : {}),
            }),
      }}
    >
      {/* Drag handle — only meaningful when the toolbar can move. Hide in docked
          mode where the bar is pinned across the top. */}
      {!docked && (
        <div
          style={{
            width: 22,
            height: 28,
            display: "grid",
            placeItems: "center",
            color: ink3,
            cursor: "grab",
            opacity: 0.6,
          }}
          title="Drag toolbar"
        >
          <SixDot />
        </div>
      )}
      <div
        style={{
          width: 28,
          height: 28,
          borderRadius: 6,
          display: "grid",
          placeItems: "center",
          color: ink2,
          cursor: "pointer",
        }}
        title="Exit design mode"
      >
        <Icon name="exit" size={ICON} />
      </div>
      <Sep />
      <div
        onClick={() => setPageOpen(!pageOpen)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          height: 30,
          padding: "0 10px",
          borderRadius: 6,
          // White pill on the gray toolbar — flipped from the inverse layout the
          // panels use (gray header strip with a white active tab popping out).
          background: pal.dark ? "rgba(255,255,255,0.10)" : "#fff",
          boxShadow: pal.dark ? "none" : "0 1px 2px rgba(0,0,0,0.05)",
          cursor: "pointer",
        }}
      >
        <Icon name="home" size={ICON} color={pal.dark ? "#e6e6ea" : "var(--ink-2)"} />
        <span style={{ fontWeight: 400, color: pal.dark ? "#f1f1f4" : "var(--ink)" }}>
          Home page
        </span>
        <Icon
          name="chevDown"
          size={ICON}
          color={pal.dark ? "rgba(241,241,244,0.6)" : "var(--ink-3)"}
        />
      </div>
      <Sep />
      <div style={{ display: "flex", gap: 2 }}>
        {[{ i: "desktop", sel: true }, { i: "tablet" }, { i: "mobile" }].map((d, i) => (
          <div
            key={i}
            style={{
              width: 30,
              height: 30,
              borderRadius: 5,
              background: d.sel ? (pal.dark ? "rgba(255,255,255,0.14)" : "#fff") : "transparent",
              boxShadow: d.sel && !pal.dark ? "0 1px 2px rgba(0,0,0,0.05)" : "none",
              display: "grid",
              placeItems: "center",
              color: ink2,
            }}
          >
            <Icon name={d.i} size={ICON} />
          </div>
        ))}
      </div>
      <Sep />
      <div style={{ width: 30, height: 30, display: "grid", placeItems: "center", color: ink2 }}>
        <Icon name="undo" size={ICON} />
      </div>
      <div
        style={{
          width: 30,
          height: 30,
          display: "grid",
          placeItems: "center",
          color: ink3,
          opacity: 0.4,
        }}
      >
        <Icon name="redo" size={ICON} />
      </div>
      <Sep />
      {/* View toggles — quick-access shortcuts for tweaks that the user changes often:
          panel position (floating ↔ docked) and color mode (light ↔ dark).
          These mirror the Tweaks panel controls so users don't need to open the
          panel for these two everyday switches. */}
      <ViewToggleButton
        title={tw.attachment === "docked" ? "Floating panels" : "Dock panels"}
        icon={tw.attachment === "docked" ? "floatPanels" : "dockPanels"}
        active={tw.attachment === "docked"}
        onClick={() =>
          window.__setTweak &&
          window.__setTweak("attachment", tw.attachment === "docked" ? "floating" : "docked")
        }
        ink2={ink2}
        dark={pal.dark}
      />
      {/* 3-way surface/mode segmented control: White (opaque light) ·
          Blur (translucent over the site) · Dark. White & Blur both use the
          light palette and differ only on `surface`; Dark switches palette. */}
      <ModeSegment pal={pal} tw={tw} ink2={ink2} ink3={ink3} />
      <Sep />
      {/* Tree style — single </> toggle. Active = JSX (mono <Tag>); inactive = Plain. */}
      <TreeStyleToggle pal={pal} tw={tw} ink3={ink3} />
      <Sep />
      {/* Status badge — colored dot + label + dropdown chevron. Yellow for Draft,
          green for Preview/Published. Sits where a segmented toggle was; reads
          more like a Shopify-style status pill that can be clicked to switch. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          height: 30,
          padding: "0 8px 0 10px",
          borderRadius: 6,
          background: pal.dark ? "rgba(255,255,255,0.10)" : "#fff",
          boxShadow: pal.dark ? "none" : "0 1px 2px rgba(0,0,0,0.05)",
          cursor: "pointer",
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: "#e0a91b", // amber — Draft
            boxShadow: "0 0 0 2px rgba(224,169,27,0.18)",
          }}
        />
        <span style={{ fontWeight: 400, color: pal.dark ? "#f1f1f4" : "var(--ink)" }}>Draft</span>
        <Icon
          name="chevDown"
          size={ICON}
          color={pal.dark ? "rgba(241,241,244,0.6)" : "var(--ink-3)"}
        />
      </div>
      <Sep />
      <div
        style={{
          height: 30,
          padding: "0 12px",
          display: "flex",
          alignItems: "center",
          borderRadius: 5,
          background: pal.dark ? "#f1f1f4" : "var(--ink)",
          color: pal.dark ? "#1c1c20" : "var(--paper)",
          fontSize: T.ui,
          fontWeight: 400,
        }}
      >
        Save
      </div>
    </div>
  )
}

// Single icon toggle — flips between Blur (light palette + translucent) and Dark
// (dark palette + translucent). White-surface mode is kept on disk as a possible value
// but no longer reachable from this control; the icon shows the *destination* mode
// (moon while in blur, sun while in dark) so the affordance reads as "switch to X".
function ModeSegment({ pal, tw, ink2, ink3 }) {
  const isDark = !!pal.dark
  const next = isDark
    ? { palette: "inspector", surface: "translucent" }
    : { palette: "dark", surface: "translucent" }
  const icon = isDark ? "sun" : "moon"
  const title = isDark ? "Switch to light" : "Switch to dark"
  return (
    <div
      title={title}
      onClick={() => {
        if (window.__setTweak) window.__setTweak(next)
      }}
      style={{
        width: 30,
        height: 30,
        borderRadius: 6,
        display: "grid",
        placeItems: "center",
        color: pal.dark ? "#f1f1f4" : "var(--ink-2)",
        cursor: "pointer",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = pal.dark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.05)"
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent"
      }}
    >
      <Icon name={icon} size={14} />
    </div>
  )
}

function Sep() {
  return <div style={{ width: 1, height: 20, background: "currentColor", opacity: 0.18 }} />
}

// Tree-style toggle — single </> button. Active (filled pill) = JSX mono rendering;
// inactive = Plain human names. Same chrome as the ViewToggleButton family below.
function TreeStyleToggle({ pal, tw, ink3 }) {
  const isJsx = tw.treeStyle === "jsx"
  return (
    <div
      title={isJsx ? "JSX tags — click for plain names" : "Plain names — click for JSX tags"}
      onClick={() => {
        if (!window.__setTweak) return
        window.__setTweak({ treeStyle: isJsx ? "plain" : "jsx" })
      }}
      style={{
        width: 30,
        height: 30,
        borderRadius: 6,
        display: "grid",
        placeItems: "center",
        fontFamily: "var(--mono)",
        fontSize: T.mono,
        fontWeight: 600,
        letterSpacing: "-0.02em",
        color: isJsx ? (pal.dark ? "#f1f1f4" : "var(--ink)") : ink3,
        background: isJsx ? (pal.dark ? "rgba(255,255,255,0.10)" : "#fff") : "transparent",
        boxShadow: isJsx && !pal.dark ? "0 1px 2px rgba(0,0,0,0.05)" : "none",
        cursor: "pointer",
        userSelect: "none",
      }}
    >
      &lt;/&gt;
    </div>
  )
}

// Toolbar icon-button that reflects an active state (filled pill) when toggled on.
// Used for the panel-position and light/dark switches in the topbar.
function ViewToggleButton({ icon, title, active, onClick, ink2, dark }) {
  return (
    <div
      onClick={onClick}
      title={title}
      style={{
        width: 30,
        height: 30,
        borderRadius: 6,
        display: "grid",
        placeItems: "center",
        color: ink2,
        background: active ? (dark ? "rgba(255,255,255,0.14)" : "#fff") : "transparent",
        boxShadow: active && !dark ? "0 1px 2px rgba(0,0,0,0.05)" : "none",
        cursor: "pointer",
      }}
    >
      <Icon name={icon} size={16} />
    </div>
  )
}

function PageNavigator({ onClose }) {
  const { dark } = usePalette()
  const items = [
    { i: "home", l: "Home page", sel: true },
    { i: "tag", l: "Products", arrow: true },
    { i: "tag", l: "Collections", arrow: true },
    { i: "gridList", l: "Collections list" },
    { i: "gift", l: "Gift card" },
    { sep: true },
    { i: "cart", l: "Cart" },
    { i: "block", l: "Checkout & accounts" },
    { sep: true },
    { i: "page", l: "Pages", arrow: true },
    { i: "pen", l: "Blogs", arrow: true },
    { i: "pen", l: "Blog posts", arrow: true },
    { sep: true },
    { i: "search", l: "Search" },
    { i: "lock", l: "Password" },
  ]

  return (
    <>
      <div onClick={onClose} style={{ position: "absolute", inset: 0, zIndex: 11 }} />
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: 64,
          transform: "translateX(-50%)",
          width: 320,
          background: dark ? "#1c1c20" : "rgba(255,255,255,0.99)",
          border: dark ? "1px solid rgba(255,255,255,0.12)" : "1px solid rgba(0,0,0,0.12)",
          borderRadius: 10,
          boxShadow: dark ? "0 16px 40px rgba(0,0,0,0.55)" : "0 16px 40px rgba(0,0,0,0.18)",
          zIndex: 12,
          padding: 6,
          fontFamily: "var(--ui)",
          fontSize: T.ui,
          color: "var(--ink)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 10px",
            borderRadius: 6,
            background: dark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.04)",
            marginBottom: 4,
          }}
        >
          <Icon name="search" size={16} color="var(--ink-3)" />
          <span style={{ color: "var(--ink-3)" }}>Search online store</span>
        </div>
        {items.map((it, i) =>
          it.sep ? (
            <div
              key={i}
              style={{
                height: 1,
                background: dark ? "rgba(255,255,255,0.10)" : "rgba(0,0,0,0.08)",
                margin: "6px 6px",
              }}
            />
          ) : (
            <div
              key={i}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "8px 10px",
                borderRadius: 6,
                background: it.sel
                  ? dark
                    ? "rgba(255,255,255,0.10)"
                    : "rgba(0,0,0,0.05)"
                  : "transparent",
                fontWeight: 400,
              }}
            >
              <Icon name={it.i} size={16} color="var(--ink-2)" />
              <span style={{ flex: 1 }}>{it.l}</span>
              {it.arrow && <Icon name="chevRight" size={14} color="var(--ink-3)" />}
            </div>
          ),
        )}
      </div>
    </>
  )
}

function ChromeTabBar({ tab, setTab }) {
  const { SEL, SEL_STRONG, SEL_FILL, SEL_FILL_STRONG, C_TAG, C_ATTR, C_ATTR_VAL, dark } =
    usePalette()
  const tw = React.useContext(window.TweaksCtx || React.createContext({}))
  const surface = tw.surface || "light"
  const docked = tw.attachment === "docked"
  // When docked, the panel tab bar grows to match the toolbar's height so the
  // top of the workspace reads as a single chrome row across panel+canvas+panel.
  // Docked toolbar is forced to 48px by CSS regardless of toolbar mode — match that.
  const toolbarH = docked ? 48 : (tw.toolbar || "floating") === "ribbon" ? 48 : 44
  const tabs = [
    { id: "layers", l: "Layers", i: "layers" },
    { id: "settings", l: "Settings", i: "settings" },
  ]

  // Translucent / glass surface: drop the chrome tabs in favor of a clean segmented pill
  // (matches the "Type: Carousel | Grid" segment used elsewhere in the inspector).
  if (surface === "translucent") {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: docked ? `0 10px` : "8px 10px",
          height: docked ? toolbarH : undefined,
          // In docked mode the tab bar drops its bottom hairline so it visually
          // merges with the panel content below — the panel itself already paints
          // the inner-edge hairline that continues the chrome row's vertical seam.
          ...(docked
            ? {}
            : {
                borderBottom: dark
                  ? "1px solid rgba(255,255,255,0.10)"
                  : "1px solid rgba(0,0,0,0.08)",
              }),
        }}
      >
        {!docked && (
          <div
            style={{
              color: dark ? "rgba(241,241,244,0.45)" : "var(--ink-3)",
              opacity: 0.55,
              marginRight: 2,
              cursor: "grab",
            }}
          >
            <SixDot />
          </div>
        )}
        <div
          className="wf-segment"
          style={{
            height: 26,
            alignSelf: "center",
            fontSize: T.ui,
            background: dark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.05)",
          }}
        >
          {tabs.map((t) => (
            <div
              key={t.id}
              onClick={() => setTab(t.id)}
              className={tab === t.id ? "on" : ""}
              style={
                tab === t.id
                  ? {
                      background: dark ? "rgba(255,255,255,0.18)" : "#fff",
                      color: dark ? "#f1f1f4" : "var(--ink)",
                      boxShadow: dark ? "none" : "0 1px 2px rgba(0,0,0,0.06)",
                    }
                  : {
                      color: dark ? "rgba(241,241,244,0.6)" : "var(--ink-2)",
                    }
              }
            >
              {t.l}
            </div>
          ))}
        </div>
      </div>
    )
  }

  // Tab-strip backdrop + active-tab fill must adapt to dark / translucent surfaces.
  // Match the toolbar's tab-strip fill: light surface uses '#f3f3f3' / '#222227' (toolbar bg).
  // Translucent leaves the strip transparent so the glass shows through.
  const stripBg = surface === "translucent" ? "transparent" : dark ? "#1c1c20" : "#f3f3f3"
  const activeFill = dark
    ? surface === "translucent"
      ? "rgba(255,255,255,0.16)"
      : "#26262c"
    : surface === "translucent"
      ? "rgba(255,255,255,0.45)"
      : "#fff"
  const activeColor = dark ? "#f1f1f4" : "var(--ink)"
  const inactiveColor = dark ? "rgba(241,241,244,0.55)" : "var(--ink-2)"
  const dragColor = dark ? "rgba(241,241,244,0.45)" : "var(--ink-3)"

  // Chrome-style tab: curved top corners + outward-flaring bottom shoulders.
  // Tab height grows when docked so the strip matches the toolbar — the active
  // tab rises into the same row, keeping its chrome shape but at the new size.
  // When docked, leave 12px of breathing room at the top — tabs read shorter.
  // Total stays toolbarH (= 48 docked).
  const TAB_H = docked ? toolbarH - 12 : 26,
    R = 7
  const activePathFor = (W) => `
    M 0 ${TAB_H}
    C ${R} ${TAB_H} ${R} ${TAB_H - R} ${R} ${TAB_H - R}
    L ${R} ${R}
    Q ${R} 0 ${R * 2} 0
    L ${W - R * 2} 0
    Q ${W - R} 0 ${W - R} ${R}
    L ${W - R} ${TAB_H - R}
    C ${W - R} ${TAB_H - R} ${W - R} ${TAB_H} ${W} ${TAB_H}
    Z
  `
  return (
    <div
      style={{
        position: "relative",
        display: "flex",
        alignItems: "flex-end",
        paddingLeft: 8,
        paddingRight: 8,
        paddingTop: docked ? 12 : 8,
        gap: 0,
        background: stripBg,
        // content-box: total rendered height = height + paddingTop.
        // Docked: 36 + 12 = 48 (toolbar). Floating: 26 + 8 = 34.
        height: TAB_H,
      }}
    >
      {/* drag handle aligned with tab content baseline */}
      {!docked && (
        <div
          style={{
            height: TAB_H,
            display: "flex",
            alignItems: "center",
            paddingLeft: 2,
            paddingRight: 8,
            cursor: "grab",
            color: dragColor,
            opacity: 0.55,
          }}
        >
          <SixDot />
        </div>
      )}

      {tabs.map((t, idx) => {
        const active = tab === t.id
        const labelW = Math.max(t.l.length * 7.6, 40)
        const TAB_W = Math.round(R + 10 + labelW + 10 + R)
        return (
          <div
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              position: "relative",
              width: TAB_W,
              height: TAB_H,
              marginLeft: idx === 0 ? 0 : -R, // overlap shoulders
              cursor: "pointer",
              zIndex: active ? 2 : 1,
            }}
          >
            {/* active tab shape — color difference only, no border */}
            {active && (
              <svg
                width={TAB_W}
                height={TAB_H}
                viewBox={`0 0 ${TAB_W} ${TAB_H}`}
                style={{ position: "absolute", inset: 0, display: "block" }}
              >
                <path d={activePathFor(TAB_W)} fill={activeFill} />
              </svg>
            )}
            {/* tab content */}
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                paddingLeft: R + 10,
                paddingRight: R + 10,
                fontSize: T.ui,
                fontWeight: 400,
                color: active ? activeColor : inactiveColor,
              }}
            >
              <span style={{ whiteSpace: "nowrap" }}>{t.l}</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function LeftPanel({ tab, setTab }) {
  const { SEL, SEL_STRONG, SEL_FILL, SEL_FILL_STRONG, C_TAG, C_ATTR, C_ATTR_VAL, dark } =
    usePalette()
  const surface = usePanelSurface()
  return (
    <div
      data-panel="left"
      style={{
        position: "absolute",
        left: 18,
        top: 76,
        width: 320,
        ...surface,
        borderRadius: 10,
        fontFamily: "var(--ui)",
        fontSize: T.ui,
        color: dark ? "#e6e6ea" : "var(--ink)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        zIndex: 5,
      }}
    >
      <ChromeTabBar tab={tab} setTab={setTab} />
      {tab === "layers" && <LayersTreePane />}
      {tab === "settings" && <SettingsPane />}
      <ResizeGrip />
    </div>
  )
}

function LayersTreePane() {
  const { SEL, SEL_STRONG, SEL_FILL, SEL_FILL_STRONG, C_TAG, C_ATTR, C_ATTR_VAL, dark } =
    usePalette()
  // Unified list — sections AND blocks both use type:'item'.
  // 'add' rows are interspersed inline at every level.
  const tree = [
    { d: 0, t: "item", name: "SiteHeader", i: "headerPolaris", g: true, open: true },
    { d: 1, t: "item", name: "AnnouncementBar", i: "text" },
    { d: 1, t: "item", name: "Nav", i: "nav" },
    { d: 1, t: "add", l: "Add block" },
    { d: 0, t: "item", name: "Hero", i: "star", g: true, open: true, sel: true, rename: true },
    { d: 1, t: "item", name: "Heading", i: "heading" },
    { d: 1, t: "item", name: "Subhead", i: "text" },
    { d: 1, t: "item", name: "Button", i: "button" },
    { d: 1, t: "add", l: "Add block" },
    { d: 0, t: "item", name: "Features", i: "columnsPolaris", g: true, hidden: true },
    {
      d: 0,
      t: "item",
      name: "FeaturedCollection",
      props: "modified",
      i: "sectionPolaris",
      g: true,
      open: true,
    },
    { d: 1, t: "item", name: "ProductCard", i: "block", g: true, open: true },
    { d: 2, t: "item", name: "Image", i: "image" },
    { d: 2, t: "item", name: "Title", i: "text" },
    { d: 2, t: "item", name: "Price", i: "coin" },
    { d: 2, t: "item", name: "AddToCart", i: "cart" },
    { d: 2, t: "add", l: "Add block" },
    { d: 1, t: "item", name: "CarouselNav", props: "modified", i: "arrows" },
    { d: 1, t: "add", l: "Add block" },
    { d: 0, t: "item", name: "BannerProducer", i: "bannerPolaris", g: true },
    { d: 0, t: "item", name: "SiteFooter", i: "footerPolaris", g: true },
    { d: 0, t: "add", l: "Add block" },
  ]

  const tw = React.useContext(window.TweaksCtx || React.createContext({}))
  const treeStyle = tw.treeStyle || "plain"
  // In path mode, render only top-level groups + the selected item + its direct children.
  // This shows the active "path" rather than the whole nested tree.
  const visible =
    treeStyle === "path"
      ? tree.filter(
          (r) =>
            r.t === "item" &&
            (r.d === 0 ||
              r.sel ||
              (r.d === 1 && tree.some((x) => x.sel && x.name === "Hero" && x.d === 0))),
        )
      : tree

  return (
    <div style={{ padding: 6, fontFamily: "var(--ui)", fontSize: T.ui }}>
      {visible.map((r, i) =>
        r.t === "add" ? <AddRow key={i} d={r.d} l={r.l} /> : <TreeRow key={i} r={r} />,
      )}
    </div>
  )
}

function AddRow({ d, l }) {
  const { SEL, SEL_STRONG, SEL_FILL, SEL_FILL_STRONG, C_TAG, C_ATTR, C_ATTR_VAL, dark } =
    usePalette()
  const indent = 6 + d * 16
  const [open, setOpen] = React.useState(false)
  const ref = React.useRef(null)
  React.useEffect(() => {
    if (!open) return
    const onDoc = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener("mousedown", onDoc)
    return () => document.removeEventListener("mousedown", onDoc)
  }, [open])

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <div
        onClick={() => setOpen((o) => !o)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          paddingLeft: indent,
          paddingRight: 6,
          height: 28,
          color: "#2c7fd6",
          background: open ? (dark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.05)") : "transparent",
          borderRadius: 4,
          fontFamily: "var(--ui)",
          fontSize: T.ui,
          fontWeight: 400,
          cursor: "pointer",
        }}
      >
        <div style={{ width: 14 }} />
        <div style={{ width: 14, display: "grid", placeItems: "center" }}>
          <Icon name="plus" size={12} color="#2c7fd6" strokeWidth={2.2} />
        </div>
        <span>{l}</span>
      </div>
      {open && <BlockPicker indent={indent} />}
    </div>
  )
}

function BlockPicker({ indent }) {
  const { SEL, SEL_STRONG, SEL_FILL, SEL_FILL_STRONG, C_TAG, C_ATTR, C_ATTR_VAL, dark } =
    usePalette()
  const [q, setQ] = React.useState("")
  const sections = [
    {
      h: "Layout",
      items: [
        { i: "sectionPolaris", n: "Section", desc: "Full-width container" },
        { i: "columnsPolaris", n: "Multicolumn", desc: "2–6 columns" },
        { i: "bannerPolaris", n: "Banner", desc: "Image + text overlay" },
      ],
    },
    {
      h: "Content",
      items: [
        { i: "heading", n: "Heading", desc: "H1–H6 text" },
        { i: "text", n: "Text", desc: "Rich text block" },
        { i: "image", n: "Image", desc: "Single image with caption" },
        { i: "button", n: "Button", desc: "Call to action" },
        { i: "quotePolaris", n: "Quote", desc: "Pull-quote" },
      ],
    },
    {
      h: "Commerce",
      items: [
        { i: "grid", n: "Featured collection", desc: "Product grid or carousel" },
        { i: "block", n: "Product card", desc: "Single product" },
        { i: "cart", n: "Cart drawer", desc: "Mini-cart trigger" },
      ],
    },
  ]

  const filter = (t) => (q ? t.toLowerCase().includes(q.toLowerCase()) : true)

  return (
    <div
      style={{
        position: "absolute",
        left: indent + 26,
        top: 30,
        zIndex: 20,
        width: 260,
        background: dark ? "#1c1c20" : "#fff",
        border: dark ? "1px solid rgba(255,255,255,0.12)" : "1px solid rgba(0,0,0,0.12)",
        borderRadius: 8,
        boxShadow: dark
          ? "0 12px 30px rgba(0,0,0,0.50), 0 0 0 1px rgba(255,255,255,0.04)"
          : "0 12px 30px rgba(0,0,0,0.18), 0 0 0 1px rgba(0,0,0,0.04)",
        fontFamily: "var(--ui)",
        fontSize: T.ui,
        color: "var(--ink)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 10px",
          borderBottom: dark ? "1px solid rgba(255,255,255,0.08)" : "1px solid rgba(0,0,0,0.06)",
        }}
      >
        <Icon name="search" size={13} color="var(--ink-3)" />
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Find a block…"
          style={{
            flex: 1,
            border: "none",
            outline: "none",
            fontFamily: "var(--ui)",
            fontSize: T.ui,
            color: "var(--ink)",
            background: "transparent",
          }}
        />

        <span
          style={{
            fontSize: T.label,
            fontFamily: "var(--mono)",
            color: "var(--ink-3)",
            padding: "1px 5px",
            border: dark ? "1px solid rgba(255,255,255,0.18)" : "1px solid rgba(0,0,0,0.1)",
            borderRadius: 3,
          }}
        >
          ⌘K
        </span>
      </div>
      <div style={{ maxHeight: 300, overflowY: "auto", padding: 4 }}>
        {sections.map((sec) => {
          const items = sec.items.filter((it) => filter(it.n) || filter(it.desc))
          if (!items.length) return null
          return (
            <div key={sec.h}>
              <div
                style={{
                  fontSize: T.label,
                  color: "var(--ink-3)",
                  textTransform: "uppercase",
                  letterSpacing: 0.6,
                  padding: "8px 8px 4px",
                  fontWeight: 500,
                }}
              >
                {sec.h}
              </div>
              {items.map((it, k) => (
                <div
                  key={k}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "7px 8px",
                    borderRadius: 5,
                    cursor: "pointer",
                  }}
                  onMouseEnter={(e) =>
                    (e.currentTarget.style.background = dark
                      ? "rgba(255,255,255,0.06)"
                      : "rgba(0,0,0,0.04)")
                  }
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                >
                  <div
                    style={{
                      width: 26,
                      height: 26,
                      borderRadius: 4,
                      background: dark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.04)",
                      display: "grid",
                      placeItems: "center",
                      color: "var(--ink-2)",
                    }}
                  >
                    <Icon name={it.i} size={14} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 400, color: "var(--ink)" }}>{it.n}</div>
                    <div style={{ fontSize: T.label, color: "var(--ink-3)" }}>{it.desc}</div>
                  </div>
                </div>
              ))}
            </div>
          )
        })}
      </div>
      <div
        style={{
          padding: "6px 10px",
          borderTop: dark ? "1px solid rgba(255,255,255,0.08)" : "1px solid rgba(0,0,0,0.06)",
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: T.label,
          color: "var(--ink-3)",
        }}
      >
        <span>↑↓ navigate</span>
        <span>·</span>
        <span>↵ insert</span>
        <span>·</span>
        <span>esc close</span>
      </div>
    </div>
  )
}

function TreeRow({ r }) {
  const { SEL, SEL_STRONG, SEL_FILL, SEL_FILL_STRONG, C_TAG, C_ATTR, C_ATTR_VAL, dark } =
    usePalette()
  const tw = React.useContext(window.TweaksCtx || React.createContext({}))
  const treeStyle = tw.treeStyle || "plain"
  // Path mode flattens — drop indent, render only items that are interesting (sel + ancestors).
  const isPath = treeStyle === "path"
  const indent = isPath ? 6 : 6 + r.d * 16
  const [hover, setHover] = React.useState(false)
  const showEye = r.hidden || hover
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        paddingLeft: indent,
        paddingRight: 4,
        height: 28,
        borderRadius: 4,
        background: r.sel
          ? dark
            ? "rgba(255,255,255,0.10)"
            : "rgba(0,0,0,0.06)"
          : hover
            ? dark
              ? "rgba(255,255,255,0.05)"
              : "rgba(0,0,0,0.03)"
            : "transparent",
        opacity: r.hidden ? 0.5 : 1,
      }}
    >
      {/* leading slot: chevron OR (on hover) drag grip */}
      <div style={{ width: 14, display: "grid", placeItems: "center", color: "var(--ink-3)" }}>
        {hover ? (
          <SixDot />
        ) : r.g ? (
          <Icon name={r.open ? "chevDown" : "chevRight"} size={11} color="var(--ink-2)" />
        ) : null}
      </div>
      {/* type icon */}
      <Icon name={r.i} size={14} color={"var(--ink-2)"} />
      {/* name */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          flex: 1,
          overflow: "hidden",
          minWidth: 0,
          whiteSpace: "nowrap",
        }}
      >
        {r.rename ? (
          <span
            style={{
              background: dark ? "#26262c" : "#fff",
              border: dark ? `1px solid rgba(255,255,255,0.25)` : `1px solid rgba(0,0,0,0.2)`,
              padding: "1px 5px",
              borderRadius: 3,
              color: "var(--ink)",
              fontWeight: 500,
            }}
          >
            {r.name}
            <span
              style={{
                background: "var(--ink-2)",
                display: "inline-block",
                width: 1,
                height: 11,
                marginLeft: 1,
                verticalAlign: "middle",
              }}
            />
          </span>
        ) : treeStyle === "jsx" ? (
          <>
            <span style={{ color: C_TAG, fontFamily: "var(--mono)", fontSize: T.mono }}>
              &lt;{r.name}
            </span>
            {r.props && (
              <span style={{ marginLeft: 4, fontFamily: "var(--mono)", fontSize: T.mono }}>
                <span style={{ color: C_ATTR }}> {r.props}</span>
              </span>
            )}
            <span
              style={{ color: C_TAG, fontFamily: "var(--mono)", fontSize: T.mono, marginLeft: 1 }}
            >
              &gt;
            </span>
          </>
        ) : (
          <>
            <span style={{ color: "var(--ink)", fontWeight: 400, fontFamily: "system-ui" }}>
              {camelToSpace(r.name)}
            </span>
            {r.props && (
              <span style={{ color: "var(--ink-3)", marginLeft: 6, fontSize: T.label }}>
                {r.props}
              </span>
            )}
          </>
        )}
      </div>
      {/* trailing tools — on hover: trash + eye; off-hover: only eye if hidden */}
      <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
        {hover && (
          <div
            style={{
              width: 20,
              height: 20,
              display: "grid",
              placeItems: "center",
              color: "var(--ink-2)",
              borderRadius: 3,
              cursor: "pointer",
            }}
          >
            <Icon name="trash" size={13} />
          </div>
        )}
        {showEye && (
          <div
            style={{
              width: 20,
              height: 20,
              display: "grid",
              placeItems: "center",
              color: r.hidden ? "var(--ink-2)" : "var(--ink-2)",
              borderRadius: 3,
              cursor: "pointer",
            }}
          >
            <Icon name={r.hidden ? "eyeOff" : "eye"} size={13} />
          </div>
        )}
      </div>
    </div>
  )
}

function SettingsPane() {
  return (
    <div style={{ padding: "4px 14px 14px" }}>
      <SectionHead>Page</SectionHead>
      <Row label="Title">
        <div className="wf-field" style={{ height: 28, fontSize: T.ui, fontFamily: "var(--ui)" }}>
          Home page
        </div>
      </Row>
      <Row label="Handle">
        <div className="wf-field" style={{ height: 28, fontSize: T.ui, fontFamily: "var(--ui)" }}>
          /
        </div>
      </Row>
      <Row label="Visible">
        <div className="wf-toggle" />
      </Row>
      <SectionHead>SEO</SectionHead>
      <Row label="Meta">
        <div className="wf-field" style={{ height: 28, fontSize: T.ui, fontFamily: "var(--ui)" }}>
          Wines & gifts
        </div>
      </Row>
      <Row label="Indexable">
        <div className="wf-toggle" />
      </Row>
    </div>
  )
}

function RightChromeTabBar() {
  const { SEL, SEL_STRONG, SEL_FILL, SEL_FILL_STRONG, C_TAG, C_ATTR, C_ATTR_VAL, dark } =
    usePalette()
  const tw = React.useContext(window.TweaksCtx || React.createContext({}))
  const surface = tw.surface || "light"
  const docked = tw.attachment === "docked"
  // Docked toolbar is forced to 48px by CSS regardless of toolbar mode — match that.
  const toolbarH = docked ? 48 : (tw.toolbar || "floating") === "ribbon" ? 48 : 44
  // Two element-tabs on the inspector panel — like Chrome devtools' tab strip on the right.
  // Active tab matches the tree-selection (FeaturedCollection); not purple, just white.
  const tabs = [
    { id: "hero", l: "Hero", i: "star" },
    { id: "fc", l: "FeaturedCollection", i: "sectionPolaris", active: true },
  ]

  // Translucent / glass surface: switch to the segmented pill style — clean over glass.
  if (surface === "translucent") {
    const closeColor = dark ? "rgba(241,241,244,0.55)" : "var(--ink-3)"
    const closeHoverBg = dark ? "rgba(255,255,255,0.18)" : "rgba(0,0,0,0.08)"
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: docked ? "0 10px" : "8px 10px",
          height: docked ? toolbarH : undefined,
          // Mirror of the left panel — drop bottom hairline when docked.
          ...(docked
            ? {}
            : {
                borderBottom: dark
                  ? "1px solid rgba(255,255,255,0.10)"
                  : "1px solid rgba(0,0,0,0.08)",
              }),
        }}
      >
        {!docked && (
          <div
            style={{
              color: dark ? "rgba(241,241,244,0.45)" : "var(--ink-3)",
              opacity: 0.55,
              marginRight: 2,
              cursor: "grab",
            }}
          >
            <SixDot />
          </div>
        )}
        <div
          className="wf-segment"
          style={{
            height: 26,
            alignSelf: "center",
            marginLeft: "auto",
            background: dark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.05)",
          }}
        >
          {tabs.map((t) => {
            const active = !!t.active
            return (
              <div
                key={t.id}
                className={active ? "on" : ""}
                style={{
                  ...(active
                    ? {
                        background: dark ? "rgba(255,255,255,0.18)" : "#fff",
                        color: dark ? "#f1f1f4" : "var(--ink)",
                        boxShadow: dark ? "none" : "0 1px 2px rgba(0,0,0,0.06)",
                      }
                    : {
                        color: dark ? "rgba(241,241,244,0.6)" : "var(--ink-2)",
                      }),
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "0 8px",
                }}
              >
                <span
                  style={{
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    fontSize: T.ui,
                  }}
                >
                  {t.l}
                </span>
                <div
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    width: 14,
                    height: 14,
                    borderRadius: 7,
                    marginLeft: "auto",
                    display: "grid",
                    placeItems: "center",
                    flexShrink: 0,
                    color: closeColor,
                    cursor: "pointer",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = closeHoverBg
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "transparent"
                  }}
                >
                  <Icon name="close" size={9} />
                </div>
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  // Match the toolbar's tab-strip fill: light surface uses '#f3f3f3' / '#222227' (toolbar bg).
  // Translucent leaves the strip transparent so the glass shows through.
  const stripBg = surface === "translucent" ? "transparent" : dark ? "#1c1c20" : "#f3f3f3"
  const activeFill = dark
    ? surface === "translucent"
      ? "rgba(255,255,255,0.16)"
      : "#26262c"
    : surface === "translucent"
      ? "rgba(255,255,255,0.45)"
      : "#fff"
  const activeColor = dark ? "#f1f1f4" : "var(--ink)"
  const dragColor = dark ? "rgba(241,241,244,0.45)" : "var(--ink-3)"
  const closeColor = dark ? "rgba(241,241,244,0.5)" : "var(--ink-3)"
  const closeHoverBg = dark ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.08)"

  // When docked, leave 12px of breathing room at the top — tabs read shorter.
  // Total stays toolbarH (= 48 docked).
  const TAB_H = docked ? toolbarH - 12 : 26,
    R = 7
  const activePathFor = (W) => `
    M 0 ${TAB_H}
    C ${R} ${TAB_H} ${R} ${TAB_H - R} ${R} ${TAB_H - R}
    L ${R} ${R}
    Q ${R} 0 ${R * 2} 0
    L ${W - R * 2} 0
    Q ${W - R} 0 ${W - R} ${R}
    L ${W - R} ${TAB_H - R}
    C ${W - R} ${TAB_H - R} ${W - R} ${TAB_H} ${W} ${TAB_H}
    Z
  `
  return (
    <div
      style={{
        position: "relative",
        display: "flex",
        alignItems: "flex-end",
        paddingLeft: 8,
        paddingRight: 8,
        paddingTop: docked ? 12 : 8,
        gap: 0,
        background: stripBg,
        // content-box: total rendered height = height + paddingTop.
        // Docked: 36 + 12 = 48 (toolbar). Floating: 26 + 8 = 34.
        height: TAB_H,
      }}
    >
      {!docked && (
        <div
          style={{
            height: TAB_H,
            display: "flex",
            alignItems: "center",
            paddingLeft: 2,
            paddingRight: 8,
            cursor: "grab",
            color: dragColor,
            opacity: 0.55,
          }}
        >
          <SixDot />
        </div>
      )}

      {tabs.map((t, idx) => {
        const active = !!t.active
        // Tabs hug their content. Width = left shoulder + label + gap + close + right shoulder.
        // labelW uses ~6.8px/char for 13px UI font (was 7.6, which left visible slack on
        // the right of long labels like "FeaturedCollection").
        const labelW = Math.max(t.l.length * 6.8, 36)
        // R + 10 left + label + 6 gap + 14 close + R right.
        const TAB_W = Math.round(R + 10 + labelW + 6 + 14 + R)
        return (
          <div
            key={t.id}
            style={{
              position: "relative",
              width: TAB_W,
              height: TAB_H,
              // First tab gets marginLeft:auto so the whole right-panel tab group
              // pushes flush to the right edge of the strip; subsequent tabs overlap
              // their previous neighbor's shoulder for the chrome-tab effect.
              marginLeft: idx === 0 ? "auto" : -R,
              cursor: "pointer",
              zIndex: active ? 2 : 1,
            }}
          >
            {active && (
              <svg
                width={TAB_W}
                height={TAB_H}
                viewBox={`0 0 ${TAB_W} ${TAB_H}`}
                style={{ position: "absolute", inset: 0, display: "block" }}
              >
                <path d={activePathFor(TAB_W)} fill={activeFill} />
              </svg>
            )}
            <div
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                top: -2,
                bottom: 0,
                display: "flex",
                alignItems: "center",
                gap: 6,
                // Label paddingLeft matches the left panel (R + 10) for visual consistency;
                // paddingRight is just R so the close glyph sits closer to the right shoulder.
                paddingLeft: R + 10,
                paddingRight: R,
                fontFamily: "var(--ui)",
                fontSize: T.ui,
                fontWeight: 400,
                color: activeColor,
              }}
            >
              <span
                style={{
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  fontSize: T.ui,
                }}
              >
                {t.l}
              </span>
              <div
                onClick={(e) => e.stopPropagation()}
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: 7,
                  display: "grid",
                  placeItems: "center",
                  color: closeColor,
                  cursor: "pointer",
                  flexShrink: 0,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = closeHoverBg
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "transparent"
                }}
              >
                <Icon name="close" size={9} />
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function RightPanel() {
  const { SEL, SEL_STRONG, SEL_FILL, SEL_FILL_STRONG, C_TAG, C_ATTR, C_ATTR_VAL, dark } =
    usePalette()
  const surface = usePanelSurface()
  return (
    <div
      data-panel="right"
      style={{
        position: "absolute",
        right: 18,
        top: 76,
        width: 320,
        ...surface,
        borderRadius: 10,
        fontFamily: "var(--ui)",
        fontSize: T.ui,
        color: dark ? "#e6e6ea" : "var(--ink)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        zIndex: 5,
      }}
    >
      <RightChromeTabBar />

      <div style={{ padding: "4px 14px 14px" }}>
        <SectionHead>Collection</SectionHead>
        <Row label="Source">
          <div
            className="wf-field"
            style={{
              height: 28,
              fontSize: T.ui,
              fontFamily: "var(--ui)",
              overflow: "hidden",
              whiteSpace: "nowrap",
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <span
              style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", color: "var(--ink)" }}
            >
              Koop nu:&nbsp;
              <span
                style={{
                  color: "#2c7fd6",
                  background: "rgba(44,127,214,0.1)",
                  padding: "1px 5px",
                  borderRadius: 3,
                  fontFamily: "var(--mono)",
                  fontSize: T.label,
                }}
              >
                product.name
              </span>
            </span>
            <span
              title="Dynamic source"
              style={{ display: "grid", placeItems: "center", color: "#2c7fd6", flexShrink: 0 }}
            >
              <Icon name="database" size={13} color="#2c7fd6" />
            </span>
          </div>
        </Row>
        <Row label="Type">
          <div className="wf-segment" style={{ height: 26, fontSize: T.ui }}>
            <div className="on">Carousel</div>
            <div>Grid</div>
          </div>
        </Row>

        <SectionHead>Layout</SectionHead>
        <Row label="Products">
          <SliderField value="8" pct={35} dark={dark} />
        </Row>
        <Row label="Columns">
          <SliderField value="4" pct={50} dark={dark} />
        </Row>
        <Row label="Gap">
          <SliderField value="16" suffix="px" pct={20} dark={dark} />
        </Row>

        <SectionHead>Spacing</SectionHead>
        <div
          style={{
            position: "relative",
            height: 120,
            background: dark ? "#0e0e12" : "#fff",
            overflow: "hidden",
          }}
        >
          {/* margin frame — outer ring only */}
          <div
            className="stripes-margin"
            style={{
              position: "absolute",
              inset: 0,
              clipPath:
                "polygon(0 0, 100% 0, 100% 100%, 0 100%, 0 0, 16px 16px, 16px calc(100% - 16px), calc(100% - 16px) calc(100% - 16px), calc(100% - 16px) 16px, 16px 16px)",
            }}
          />
          {/* padding frame — middle ring only */}
          <div
            className="stripes-padding"
            style={{
              position: "absolute",
              inset: 16,
              clipPath:
                "polygon(0 0, 100% 0, 100% 100%, 0 100%, 0 0, 16px 16px, 16px calc(100% - 16px), calc(100% - 16px) calc(100% - 16px), calc(100% - 16px) 16px, 16px 16px)",
            }}
          />
          {/* content */}
          <div
            style={{
              position: "absolute",
              inset: 32,
              background: SEL_FILL_STRONG,
              outline: `1px dashed ${SEL}`,
            }}
          />
          {[
            { t: "80", left: "50%", top: 2, transform: "translateX(-50%)" },
            { t: "80", left: "50%", bottom: 2, transform: "translateX(-50%)" },
            { t: "24", left: 2, top: "50%", transform: "translateY(-50%)" },
            { t: "24", right: 2, top: "50%", transform: "translateY(-50%)" },
          ].map((p, i) => (
            <div
              key={i}
              className="mono"
              style={{
                position: "absolute",
                ...p,
                fontSize: T.ui,
                color: "var(--ink)",
                background: dark ? "#26262c" : "#fff",
                padding: "1px 5px",
                borderRadius: 2,
                border: dark ? "1px solid rgba(255,255,255,0.12)" : "1px solid rgba(0,0,0,0.08)",
              }}
            >
              {p.t}
            </div>
          ))}
        </div>
      </div>
      <ResizeGrip />
    </div>
  )
}

function SixDot({ small }) {
  const sz = small ? 1.8 : 2.5
  const gap = small ? 1.5 : 2.5
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(2, ${sz}px)`,
        gridTemplateRows: `repeat(3, ${sz}px)`,
        gap,
      }}
    >
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          style={{ width: sz, height: sz, background: "var(--ink-2)", borderRadius: "50%" }}
        />
      ))}
    </div>
  )
}

window.V6Consolidated = V6Consolidated
