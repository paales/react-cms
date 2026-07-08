// V1 — "Floating Island"
// Both panels float as detached glassy cards. The site is fully visible behind.
// Selected element gets the full Chrome-inspector treatment: blue dashed
// outline, padding stripes, margin stripes, dimension tag.

function V1FloatingIsland() {
  const W = 1100,
    H = 720
  return (
    <div style={{ position: "relative", width: W, height: H, background: "#e9e4d8" }}>
      <SiteMock width={W} height={H} dim />

      {/* Inspector overlay on the hero block */}
      <div style={{ position: "absolute", left: 0, top: 70, pointerEvents: "none" }}>
        <SelectionRect
          width={W}
          height={300}
          margin={0}
          padding={36}
          showMargin={false}
          label={{ tag: "section", cls: "hero" }}
          dim={`${W} × 300`}
        />
      </div>

      {/* Margin stripes between hero and features (the iconic pink band) */}
      <div
        className="stripes-margin"
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 370,
          height: 0,
          borderTop: "1px dashed var(--insp-blue-strong)",
        }}
      />

      {/* ─── Layers panel (left float) ─── */}
      <div style={{ position: "absolute", left: 18, top: 92, width: 232, zIndex: 5 }}>
        <FloatingPanel title="Layers" sub="home / template" width={232} height={460}>
          <div
            style={{ padding: "8px 6px", overflow: "hidden", height: "100%" }}
            className="no-scrollbar"
          >
            {[
              { d: 0, label: "Header", kind: "group", open: true },
              { d: 1, label: "Announcement bar" },
              { d: 1, label: "Nav" },
              { d: 0, label: "Hero", kind: "group", open: true, sel: true },
              { d: 1, label: "Heading" },
              { d: 1, label: "Subhead" },
              { d: 1, label: "CTA button" },
              { d: 0, label: "Features", kind: "group" },
              { d: 0, label: "Featured collection", kind: "group", open: true },
              { d: 1, label: "Product card", kind: "group", open: true },
              { d: 2, label: "Image" },
              { d: 2, label: "Title" },
              { d: 2, label: "Price" },
              { d: 1, label: "+ Add block", add: true },
              { d: 0, label: "Footer", kind: "group" },
            ].map((r, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "4px 6px",
                  paddingLeft: 6 + r.d * 14,
                  borderRadius: 4,
                  background: r.sel ? "rgba(108,177,240,0.18)" : "transparent",
                  outline: r.sel ? "1px dashed var(--insp-blue-strong)" : "none",
                  outlineOffset: -1,
                  fontSize: 11.5,
                  color: r.add ? "var(--insp-blue-strong)" : "var(--ink)",
                  fontFamily: "var(--ui)",
                }}
              >
                {r.kind === "group" && <Glyph kind="caret" size={10} />}
                {!r.kind && !r.add && <div style={{ width: 10 }} />}
                {r.add && <Glyph kind="plus" size={10} color="var(--insp-blue-strong)" />}
                <div
                  style={{
                    width: 12,
                    height: 12,
                    border: "1px solid var(--ink-3)",
                    borderRadius: 2,
                    background: r.sel ? "var(--insp-blue-strong)" : "transparent",
                    display: r.add ? "none" : "block",
                  }}
                />
                <span style={{ fontWeight: r.sel ? 600 : 400 }}>{r.label}</span>
              </div>
            ))}
          </div>
        </FloatingPanel>
      </div>

      {/* ─── Properties panel (right float) ─── */}
      <div style={{ position: "absolute", right: 18, top: 92, width: 280, zIndex: 5 }}>
        <FloatingPanel
          title="Hero"
          sub="section.hero"
          width={280}
          height={500}
          footer={
            <>
              <Glyph kind="grip" size={10} />
              <span>drag · cmd+. to dismiss</span>
            </>
          }
        >
          <div style={{ padding: 12, overflow: "hidden", height: "100%" }} className="no-scrollbar">
            <SectionHead>Content</SectionHead>
            <Row label="Heading">
              <div className="wf-field">Passion for…</div>
            </Row>
            <Row label="Subhead">
              <div className="wf-field">tagline copy</div>
            </Row>
            <Row label="CTA">
              <div className="wf-field">Shop now</div>
            </Row>

            <SectionHead>Layout</SectionHead>
            <Row label="Width">
              <div className="wf-segment">
                <div>Page</div>
                <div className="on">Full</div>
              </div>
            </Row>
            <Row label="Align">
              <div className="wf-segment">
                <div>Left</div>
                <div className="on">Center</div>
                <div>Right</div>
              </div>
            </Row>
            <Row label="Padding Y" hint="80 px">
              <div className="wf-slider" />
            </Row>
            <Row label="Min height" hint="300 px">
              <div className="wf-slider" />
            </Row>

            <SectionHead>Background</SectionHead>
            <Row label="Type">
              <div className="wf-segment">
                <div className="on">Color</div>
                <div>Image</div>
                <div>Video</div>
              </div>
            </Row>
            <Row label="Color">
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <div
                  style={{
                    width: 18,
                    height: 18,
                    borderRadius: 4,
                    background: "#d9d4c5",
                    border: "1px solid var(--line)",
                  }}
                />
                <div className="mono" style={{ fontSize: 11 }}>
                  #d9d4c5
                </div>
              </div>
            </Row>
          </div>
        </FloatingPanel>
      </div>

      {/* ─── In-canvas "Add block" floating button — positioned at insertion point ─── */}
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: 460,
          transform: "translateX(-50%)",
          zIndex: 6,
        }}
      >
        <div
          style={{
            width: 26,
            height: 26,
            borderRadius: "50%",
            background: "var(--insp-blue-strong)",
            color: "#fff",
            display: "grid",
            placeItems: "center",
            boxShadow: "0 4px 12px rgba(44,127,214,0.45)",
          }}
        >
          <Glyph kind="plus" size={12} color="#fff" />
        </div>
      </div>

      {/* ─── Mini toolbar attached to selection (the inspector tag, but interactive) ─── */}
      <div style={{ position: "absolute", left: 36, top: 70 + 300 - 28, zIndex: 6 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 0,
            background: "var(--ink)",
            color: "var(--paper)",
            borderRadius: 6,
            fontFamily: "var(--mono)",
            fontSize: 11,
            boxShadow: "0 4px 12px rgba(0,0,0,0.25)",
            height: 26,
            paddingRight: 4,
          }}
        >
          <div
            style={{
              padding: "0 8px",
              borderRight: "1px solid rgba(255,255,255,0.15)",
              height: "100%",
              display: "flex",
              alignItems: "center",
            }}
          >
            <span style={{ color: "#f5b9b9" }}>section</span>
            <span style={{ color: "#6cb1f0" }}>.hero</span>
          </div>
          {["↑", "↓", "⎘", "⌫"].map((c, i) => (
            <div key={i} style={{ width: 22, height: 22, display: "grid", placeItems: "center" }}>
              {c}
            </div>
          ))}
        </div>
      </div>

      {/* annotation */}
      <Annotation
        x={W / 2 - 100}
        y={H - 56}
        text="floating panels — site is fully visible, panels can be dismissed with ⌘."
      ></Annotation>
    </div>
  )
}

function Annotation({ x, y, text, w = 240, dir = "down" }) {
  return (
    <div style={{ position: "absolute", left: x, top: y, width: w, zIndex: 10 }}>
      <div
        style={{ fontFamily: "var(--hand)", fontSize: 17, color: "var(--ink-2)", lineHeight: 1.15 }}
      >
        {text}
      </div>
    </div>
  )
}

window.V1FloatingIsland = V1FloatingIsland
window.Annotation = Annotation
