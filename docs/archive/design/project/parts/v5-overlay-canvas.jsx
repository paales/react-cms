// V5 — "Inspector overlay canvas"
// Most ambitious — leans HARDEST into the Chrome devtools metaphor.
// The whole site is overlaid with margin/padding stripes when in edit
// mode, and the right panel is literally a structured devtools-style
// inspector with computed-style tabs.

function V5OverlayCanvas() {
  const W = 1100,
    H = 720
  return (
    <div style={{ position: "relative", width: W, height: H, background: "#e9e4d8" }}>
      <SiteMock width={W} height={H} dim />

      {/* Big inspector overlay covering the page — lots of stripes */}
      <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
        {/* hero outline */}
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 70,
            width: W,
            height: 300,
            outline: "1.5px dashed var(--insp-blue-strong)",
            outlineOffset: -1,
          }}
        />
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 370,
            width: W,
            height: 0,
            borderTop: "2px dashed var(--insp-blue-strong)",
          }}
        />
        {/* features padding stripes */}
        <div
          className="stripes-padding"
          style={{ position: "absolute", left: 0, top: 370, width: W, height: 12 }}
        />
        <div
          className="stripes-padding"
          style={{ position: "absolute", left: 0, top: 460 - 12, width: W, height: 12 }}
        />
        {/* margin stripes between features and carousel */}
        <div
          className="stripes-margin"
          style={{ position: "absolute", left: 0, top: 460, width: W, height: 20 }}
        />
        {/* selected carousel — heavy chrome */}
        <div
          style={{
            position: "absolute",
            left: 30,
            top: 480,
            width: W - 60,
            height: 200,
            outline: "2px solid var(--insp-blue-strong)",
            outlineOffset: -1,
            background: "rgba(108,177,240,0.07)",
          }}
        />
        {/* inner padding stripes inside carousel */}
        <div
          className="stripes-padding"
          style={{ position: "absolute", left: 30, top: 480, width: W - 60, height: 16 }}
        />
        <div
          className="stripes-padding"
          style={{ position: "absolute", left: 30, bottom: 720 - 680, width: W - 60, height: 16 }}
        />
        {/* dim labels */}
        <div style={{ position: "absolute", left: 30, top: 480 - 22 }}>
          <InspectorTag tag="section" cls="featured-collection" dim="1040 × 200" />
        </div>
        {/* horiz dim ruler (Chrome-style number floating between bounds) */}
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: 470,
            transform: "translateX(-50%)",
            background: "#fff",
            border: "1px solid var(--line)",
            borderRadius: 3,
            padding: "1px 5px",
            fontFamily: "var(--mono)",
            fontSize: 10,
            color: "var(--ink-2)",
          }}
        >
          1040
        </div>
        <div
          style={{
            position: "absolute",
            left: 36,
            top: 580,
            transform: "rotate(-90deg)",
            transformOrigin: "left top",
            background: "#fff",
            border: "1px solid var(--line)",
            borderRadius: 3,
            padding: "1px 5px",
            fontFamily: "var(--mono)",
            fontSize: 10,
            color: "var(--ink-2)",
          }}
        >
          200
        </div>
        {/* corners */}
        {[
          { left: 30 - 4, top: 480 - 4 },
          { left: W - 30 - 3, top: 480 - 4 },
          { left: 30 - 4, top: 680 - 3 },
          { left: W - 30 - 3, top: 680 - 3 },
        ].map((p, i) => (
          <div key={i} className="corner" style={{ position: "absolute", ...p }} />
        ))}
      </div>

      {/* Devtools-flavored right panel with tabs */}
      <div
        style={{
          position: "absolute",
          right: 12,
          top: 12,
          bottom: 12,
          width: 340,
          background: "rgba(252,250,246,0.98)",
          border: "1px solid rgba(0,0,0,0.18)",
          borderRadius: 10,
          boxShadow: "0 12px 30px rgba(0,0,0,0.18)",
          fontFamily: "var(--ui)",
          fontSize: 12,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          zIndex: 6,
        }}
      >
        {/* tab bar */}
        <div
          style={{
            display: "flex",
            borderBottom: "1px solid rgba(0,0,0,0.12)",
            background: "#f4f1ea",
          }}
        >
          {[{ l: "Elements", sel: true }, { l: "Styles" }, { l: "Layout" }, { l: "Data" }].map(
            (t, i) => (
              <div
                key={i}
                style={{
                  padding: "8px 12px",
                  fontSize: 11,
                  fontWeight: t.sel ? 600 : 400,
                  borderBottom: t.sel
                    ? "2px solid var(--insp-blue-strong)"
                    : "2px solid transparent",
                  color: t.sel ? "var(--ink)" : "var(--ink-2)",
                }}
              >
                {t.l}
              </div>
            ),
          )}
          <div style={{ flex: 1 }} />
          <div style={{ padding: "8px 10px", fontSize: 13, color: "var(--ink-2)" }}>×</div>
        </div>

        {/* DOM tree-like layer panel */}
        <div
          style={{
            padding: 8,
            fontFamily: "var(--mono)",
            fontSize: 11,
            lineHeight: 1.7,
            borderBottom: "1px solid rgba(0,0,0,0.08)",
            maxHeight: 180,
            overflow: "hidden",
          }}
          className="no-scrollbar"
        >
          {[
            { d: 0, t: "<body>", cls: "home" },
            { d: 1, t: "<header>", cls: "site-header" },
            { d: 1, t: "<section>", cls: "hero" },
            { d: 1, t: "<section>", cls: "features" },
            { d: 1, t: "<section>", cls: "featured-collection", sel: true },
            { d: 2, t: "<header>" },
            { d: 2, t: "<div>", cls: "carousel" },
            { d: 3, t: "<article>", cls: "product-card", x4: true },
            { d: 1, t: "<footer>" },
          ].map((r, i) => (
            <div
              key={i}
              style={{
                paddingLeft: r.d * 12,
                background: r.sel ? "rgba(108,177,240,0.22)" : "transparent",
                outline: r.sel ? "1px dashed var(--insp-blue-strong)" : "none",
                outlineOffset: -1,
                borderRadius: 2,
                padding: "0 4px",
              }}
            >
              <span style={{ color: "#b347a3" }}>{r.t}</span>
              {r.cls && <span style={{ color: "#2c7fd6" }}>.{r.cls}</span>}
              {r.x4 && <span style={{ color: "var(--ink-3)" }}> ×4</span>}
            </div>
          ))}
        </div>

        {/* Computed-styles diagram (Chrome's iconic margin/border/padding/content boxes) */}
        <div style={{ padding: 12, borderBottom: "1px solid rgba(0,0,0,0.08)" }}>
          <div
            style={{
              fontSize: 10,
              textTransform: "uppercase",
              letterSpacing: 1,
              color: "var(--ink-3)",
              marginBottom: 8,
              fontWeight: 600,
            }}
          >
            Computed
          </div>
          <ComputedBoxModel />
        </div>

        {/* Live property edits */}
        <div style={{ padding: 12, flex: 1, overflow: "hidden" }} className="no-scrollbar">
          <div style={{ fontFamily: "var(--mono)", fontSize: 11, marginBottom: 8 }}>
            <div>
              <span style={{ color: "#2c7fd6" }}>section.featured-collection</span> {"{"}
            </div>
            <div style={{ paddingLeft: 14 }}>
              <div>
                <span style={{ color: "var(--ink-2)" }}>columns</span>:{" "}
                <span style={{ color: "#b347a3" }}>4</span>;
              </div>
              <div>
                <span style={{ color: "var(--ink-2)" }}>gap</span>:{" "}
                <span style={{ color: "#b347a3" }}>16px</span>;
              </div>
              <div>
                <span style={{ color: "var(--ink-2)" }}>width</span>:{" "}
                <span style={{ color: "#b347a3" }}>full</span>;
              </div>
              <div>
                <span style={{ color: "var(--ink-2)" }}>align</span>:{" "}
                <span style={{ color: "#b347a3" }}>center</span>;
              </div>
              <div>
                <span style={{ color: "var(--ink-2)" }}>theme</span>:{" "}
                <span style={{ color: "#b347a3" }}>scheme-1</span>;
              </div>
            </div>
            <div>{"}"}</div>
          </div>
          <div className="wf-field" style={{ width: "100%" }}>
            add property…
          </div>
        </div>
      </div>

      <Annotation
        x={20}
        y={H - 56}
        w={500}
        text="full inspector overlay · DOM tree, computed box model and CSS-style edits — the most explicit option"
      />
    </div>
  )
}

function ComputedBoxModel() {
  // The classic 4-nested-box devtools layout: margin / border / padding / content
  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        maxWidth: 280,
        height: 130,
        fontFamily: "var(--mono)",
        fontSize: 9.5,
        margin: "0 auto",
      }}
    >
      {/* margin (outermost, pink stripes) */}
      <div className="stripes-margin" style={{ position: "absolute", inset: 0, borderRadius: 3 }} />
      <div style={{ position: "absolute", left: 6, top: 1, color: "#c75a7a", fontWeight: 600 }}>
        margin
      </div>
      {[
        { t: "0", left: "50%", top: 2, tx: "translateX(-50%)" },
        { t: "80", left: "50%", bottom: 2, tx: "translateX(-50%)" },
        { t: "24", left: 4, top: "50%", tx: "translateY(-50%)" },
        { t: "24", right: 4, top: "50%", tx: "translateY(-50%)" },
      ].map((p, i) => (
        <div key={i} style={{ position: "absolute", ...p, transform: p.tx, color: "var(--ink-2)" }}>
          {p.t}
        </div>
      ))}
      {/* border */}
      <div
        style={{
          position: "absolute",
          inset: 18,
          background: "#f3e5b1",
          border: "1px solid rgba(0,0,0,0.2)",
        }}
      />
      <div style={{ position: "absolute", left: 22, top: 19, color: "#a07a1f", fontWeight: 600 }}>
        border
      </div>
      {/* padding (green stripes) */}
      <div
        className="stripes-padding"
        style={{ position: "absolute", inset: 30, borderRadius: 2 }}
      />
      <div style={{ position: "absolute", left: 34, top: 31, color: "#3a7a1f", fontWeight: 600 }}>
        padding
      </div>
      {[
        { t: "16", left: "50%", top: 32, tx: "translateX(-50%)" },
        { t: "16", left: "50%", bottom: 32, tx: "translateX(-50%)" },
      ].map((p, i) => (
        <div key={i} style={{ position: "absolute", ...p, transform: p.tx, color: "var(--ink-2)" }}>
          {p.t}
        </div>
      ))}
      {/* content */}
      <div
        style={{
          position: "absolute",
          inset: 46,
          background: "rgba(108,177,240,0.25)",
          outline: "1px dashed var(--insp-blue-strong)",
          display: "grid",
          placeItems: "center",
          color: "var(--insp-blue-strong)",
          fontWeight: 600,
        }}
      >
        1040 × 168
      </div>
    </div>
  )
}

window.V5OverlayCanvas = V5OverlayCanvas
