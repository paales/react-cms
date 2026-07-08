// Reusable inspector-language pieces: selection rectangles with stripes,
// tags, marching-ants outlines.

function InspectorTag({ tag = "div", cls = "hero", dim = "420 × 300", style }) {
  return (
    <div className="insp-tag" style={style}>
      <span className="t-tag">{tag}</span>
      <span className="t-class">.{cls}</span>
      <span className="t-dim">{dim}</span>
    </div>
  )
}

// A "selected element" rectangle that paints content/padding/margin like Chrome devtools.
// Children render in the content well.
function SelectionRect({
  width,
  height,
  margin = 8,
  padding = 14,
  showMargin = true,
  showPadding = true,
  label,
  dim,
  variant = "blue", // 'blue' | 'amber' | 'pink'
  style,
  children,
}) {
  const stroke =
    variant === "amber" ? "#d99a2c" : variant === "pink" ? "#c75a7a" : "var(--insp-blue-strong)"
  return (
    <div style={{ position: "relative", width, height, ...style }}>
      {/* margin (outermost stripes) */}
      {showMargin && (
        <div
          className="stripes-margin"
          style={{ position: "absolute", inset: 0, borderRadius: 0 }}
        />
      )}
      {/* padding (inset) */}
      {showPadding && (
        <div
          className="stripes-padding"
          style={{ position: "absolute", inset: margin, borderRadius: 0 }}
        />
      )}
      {/* content well */}
      <div
        style={{
          position: "absolute",
          inset: margin + padding,
          outline: `1.5px dashed ${stroke}`,
          outlineOffset: -1,
          background: "rgba(108,177,240,0.08)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {children}
      </div>
      {/* corners */}
      {[
        { left: margin - 3, top: margin - 3 },
        { right: margin - 3, top: margin - 3 },
        { left: margin - 3, bottom: margin - 3 },
        { right: margin - 3, bottom: margin - 3 },
      ].map((p, i) => (
        <div key={i} className="corner" style={{ ...p, borderColor: stroke }} />
      ))}
      {/* tag */}
      {label && (
        <div style={{ position: "absolute", left: margin, top: -22 }}>
          <InspectorTag tag={label.tag} cls={label.cls} dim={dim} />
        </div>
      )}
    </div>
  )
}

// Just the diagonal-stripe block, useful as a standalone "drop zone here"
function StripeZone({ children, kind = "margin", style, label }) {
  const cls =
    kind === "padding"
      ? "stripes-padding"
      : kind === "content"
        ? "stripes-content"
        : kind === "gray"
          ? "stripes-gray"
          : "stripes-margin"
  return (
    <div
      className={cls}
      style={{
        border: "1px dashed var(--line-soft)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        ...style,
      }}
    >
      {label && (
        <div
          className="mono"
          style={{
            fontSize: 10,
            color: "var(--ink-2)",
            background: "#fff",
            padding: "2px 6px",
            borderRadius: 3,
          }}
        >
          {label}
        </div>
      )}
      {children}
    </div>
  )
}

// Floating panel chrome shared across variations
function FloatingPanel({ title, sub, width, height, x, y, children, accent, footer, onClose }) {
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        width,
        height,
        background: "rgba(255,255,255,0.96)",
        backdropFilter: "blur(8px)",
        border: "1px solid rgba(0,0,0,0.12)",
        borderRadius: 10,
        boxShadow: "0 12px 30px rgba(0,0,0,0.12), 0 2px 6px rgba(0,0,0,0.06)",
        fontFamily: "var(--ui)",
        fontSize: 12,
        color: "var(--ink)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {/* drag handle */}
      <div
        style={{
          height: 32,
          padding: "0 10px",
          display: "flex",
          alignItems: "center",
          gap: 8,
          borderBottom: "1px solid rgba(0,0,0,0.08)",
          background: accent || "transparent",
        }}
      >
        <div style={{ display: "flex", gap: 4 }}>
          <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#d4d0c4" }} />
          <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#d4d0c4" }} />
          <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#d4d0c4" }} />
        </div>
        <div style={{ fontWeight: 600, fontSize: 12, marginLeft: 4 }}>{title}</div>
        {sub && (
          <div className="mono" style={{ fontSize: 10, color: "var(--ink-3)" }}>
            {sub}
          </div>
        )}
        <div style={{ flex: 1 }} />
        {onClose !== false && (
          <div
            style={{
              width: 18,
              height: 18,
              display: "grid",
              placeItems: "center",
              borderRadius: 4,
              color: "var(--ink-2)",
              cursor: "pointer",
            }}
          >
            ×
          </div>
        )}
      </div>
      <div style={{ flex: 1, overflow: "hidden", position: "relative" }}>{children}</div>
      {footer && (
        <div
          style={{
            height: 30,
            padding: "0 10px",
            borderTop: "1px solid rgba(0,0,0,0.08)",
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 11,
            color: "var(--ink-2)",
            background: "rgba(0,0,0,0.02)",
          }}
        >
          {footer}
        </div>
      )}
    </div>
  )
}

// shadcn-ish form row primitives
function Row({ label, children, hint }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "88px 1fr",
        gap: 10,
        alignItems: "center",
        marginBottom: 10,
      }}
    >
      <div
        style={{ fontSize: 12, color: "var(--ink-2)", fontFamily: "var(--ui)", fontWeight: 400 }}
      >
        {label}
      </div>
      <div>
        {children}
        {hint && (
          <div className="mono" style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 3 }}>
            {hint}
          </div>
        )}
      </div>
    </div>
  )
}

function SectionHead({ children }) {
  return (
    <div
      style={{
        fontSize: 11,
        color: "var(--ink-3)",
        fontFamily: "var(--ui)",
        fontWeight: 500,
        textTransform: "uppercase",
        letterSpacing: 0.6,
        margin: "14px 0 8px",
      }}
    >
      {children}
    </div>
  )
}

// Chevron / icon placeholders drawn as simple shapes (no SVG complexity)
function Glyph({ kind = "block", size = 12, color = "var(--ink-2)" }) {
  const s = size
  if (kind === "plus")
    return (
      <div style={{ width: s, height: s, position: "relative" }}>
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: "50%",
            height: 1.5,
            background: color,
            transform: "translateY(-50%)",
          }}
        />
        <div
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: "50%",
            width: 1.5,
            background: color,
            transform: "translateX(-50%)",
          }}
        />
      </div>
    )
  if (kind === "chev")
    return (
      <div
        style={{
          width: s * 0.5,
          height: s * 0.5,
          borderRight: `1.5px solid ${color}`,
          borderBottom: `1.5px solid ${color}`,
          transform: "rotate(-45deg)",
        }}
      />
    )
  if (kind === "caret")
    return (
      <div
        style={{
          width: 0,
          height: 0,
          borderTop: `${s * 0.45}px solid ${color}`,
          borderLeft: `${s * 0.45}px solid transparent`,
          borderRight: `${s * 0.45}px solid transparent`,
        }}
      />
    )
  if (kind === "grip")
    return (
      <div
        style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1.5, width: s, height: s }}
      >
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} style={{ width: 2, height: 2, background: color, borderRadius: "50%" }} />
        ))}
      </div>
    )
  return <div style={{ width: s, height: s, border: `1.5px solid ${color}`, borderRadius: 2 }} />
}

window.InspectorTag = InspectorTag
window.SelectionRect = SelectionRect
window.StripeZone = StripeZone
window.FloatingPanel = FloatingPanel
window.Row = Row
window.SectionHead = SectionHead
window.Glyph = Glyph
