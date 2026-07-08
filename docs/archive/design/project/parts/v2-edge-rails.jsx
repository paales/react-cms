// V2 — "Edge Rails"
// Panels dock as thin rails to left/right edges. Site goes nearly full-bleed.
// Inspector vibe lives in the selection chrome itself.

function V2EdgeRails() {
  const W = 1100,
    H = 720
  return (
    <div style={{ position: "relative", width: W, height: H, background: "#e9e4d8" }}>
      <SiteMock width={W} height={H} />

      {/* selection on featured-collection */}
      <div style={{ position: "absolute", left: 30, top: 480, pointerEvents: "none" }}>
        <div
          style={{
            width: W - 60,
            height: 200,
            outline: "2px solid var(--insp-blue-strong)",
            outlineOffset: -1,
            background: "rgba(108,177,240,0.06)",
          }}
        />
        {/* tag */}
        <div style={{ position: "absolute", left: 0, top: -22 }}>
          <InspectorTag tag="section" cls="featured-collection" dim={`${W - 60} × 200`} />
        </div>
        {/* margin stripes top + bottom */}
        <div
          className="stripes-margin"
          style={{ position: "absolute", left: 0, right: 0, top: -8, height: 8 }}
        />
        <div
          className="stripes-margin"
          style={{ position: "absolute", left: 0, right: 0, bottom: -8, height: 8 }}
        />
        {/* corners */}
        {[
          { left: -4, top: -4 },
          { right: -4, top: -4 },
          { left: -4, bottom: -4 },
          { right: -4, bottom: -4 },
        ].map((p, i) => (
          <div key={i} className="corner" style={p} />
        ))}
      </div>

      {/* ─── Left rail (collapsed layers) ─── */}
      <div
        style={{
          position: "absolute",
          left: 8,
          top: 86,
          bottom: 12,
          width: 44,
          background: "rgba(255,255,255,0.96)",
          border: "1px solid rgba(0,0,0,0.12)",
          borderRadius: 10,
          boxShadow: "0 8px 24px rgba(0,0,0,0.1)",
          padding: "8px 0",
          display: "flex",
          flexDirection: "column",
          gap: 4,
          alignItems: "center",
        }}
      >
        {[
          { i: "≡", sel: true, label: "Layers" },
          { i: "☰", label: "Pages" },
          { i: "⚙", label: "Settings" },
          { i: "◐", label: "Theme" },
          { i: "⌖", label: "Inspect" },
        ].map((r, i) => (
          <div
            key={i}
            style={{
              width: 28,
              height: 28,
              display: "grid",
              placeItems: "center",
              borderRadius: 6,
              background: r.sel ? "var(--ink)" : "transparent",
              color: r.sel ? "var(--paper)" : "var(--ink-2)",
              fontSize: 13,
            }}
          >
            {r.i}
          </div>
        ))}
      </div>

      {/* ─── Layers fly-out (attached to rail) ─── */}
      <div
        style={{
          position: "absolute",
          left: 60,
          top: 86,
          width: 220,
          height: 360,
          background: "rgba(255,255,255,0.96)",
          border: "1px solid rgba(0,0,0,0.12)",
          borderRadius: 10,
          boxShadow: "0 12px 30px rgba(0,0,0,0.12)",
          padding: 10,
          fontFamily: "var(--ui)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
          <Glyph kind="caret" />
          <div style={{ fontSize: 12, fontWeight: 600 }}>Home page</div>
        </div>
        <div className="wf-field" style={{ marginBottom: 8 }}>
          Search blocks…
        </div>
        {[
          { d: 0, l: "Header", g: true },
          { d: 0, l: "Hero", g: true },
          { d: 0, l: "Features", g: true },
          { d: 0, l: "Featured collection", g: true, sel: true, open: true },
          { d: 1, l: "Product card", g: true },
          { d: 1, l: "Carousel nav" },
          { d: 1, l: "+ Add block", add: true },
          { d: 0, l: "Footer", g: true },
        ].map((r, i) => (
          <div
            key={i}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "5px 6px",
              paddingLeft: 6 + r.d * 14,
              borderRadius: 4,
              fontSize: 11.5,
              background: r.sel ? "rgba(108,177,240,0.2)" : "transparent",
              color: r.add ? "var(--insp-blue-strong)" : "var(--ink)",
              outline: r.sel ? "1px dashed var(--insp-blue-strong)" : "none",
              outlineOffset: -1,
              fontWeight: r.sel ? 600 : 400,
            }}
          >
            {r.g && <Glyph kind="caret" size={9} />}
            {r.add && <Glyph kind="plus" size={10} color="var(--insp-blue-strong)" />}
            {!r.g && !r.add && <div style={{ width: 9 }} />}
            <span>{r.l}</span>
          </div>
        ))}
      </div>

      {/* ─── Right rail (properties drawer, full height) ─── */}
      <div
        style={{
          position: "absolute",
          right: 8,
          top: 86,
          bottom: 12,
          width: 280,
          background: "rgba(255,255,255,0.96)",
          border: "1px solid rgba(0,0,0,0.12)",
          borderRadius: 10,
          boxShadow: "0 12px 30px rgba(0,0,0,0.12)",
          padding: 12,
          fontFamily: "var(--ui)",
          fontSize: 12,
          overflow: "hidden",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
          <InspectorTag tag="section" cls="featured-collection" dim="" />
        </div>
        <div style={{ marginTop: 10 }}>
          <SectionHead>Collection</SectionHead>
          <Row label="Source">
            <div className="wf-field">Red wines</div>
          </Row>
          <Row label="Type">
            <div className="wf-segment">
              <div className="on">Carousel</div>
              <div>Grid</div>
            </div>
          </Row>

          <SectionHead>Layout</SectionHead>
          <Row label="Products" hint="8">
            <div className="wf-slider" />
          </Row>
          <Row label="Columns" hint="4">
            <div className="wf-slider" />
          </Row>
          <Row label="Gap" hint="16 px">
            <div className="wf-slider" />
          </Row>
          <Row label="Width">
            <div className="wf-segment">
              <div>Page</div>
              <div className="on">Full</div>
            </div>
          </Row>
          <Row label="Align">
            <div className="wf-segment">
              <div>L</div>
              <div className="on">C</div>
              <div>R</div>
            </div>
          </Row>

          <SectionHead>Spacing</SectionHead>
          {/* spacing visualizer with stripe vocabulary */}
          <div
            style={{
              position: "relative",
              height: 90,
              background: "#fff",
              border: "1px solid rgba(0,0,0,0.1)",
              borderRadius: 6,
            }}
          >
            <div
              className="stripes-margin"
              style={{ position: "absolute", inset: 6, borderRadius: 4 }}
            />
            <div
              className="stripes-padding"
              style={{ position: "absolute", inset: 18, borderRadius: 4 }}
            />
            <div
              style={{
                position: "absolute",
                inset: 30,
                background: "rgba(108,177,240,0.18)",
                outline: "1px dashed var(--insp-blue-strong)",
              }}
            />
            {/* mini number labels around */}
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
                  fontSize: 10,
                  color: "var(--ink-2)",
                }}
              >
                {p.t}
              </div>
            ))}
          </div>
        </div>
      </div>

      <Annotation
        x={70}
        y={H - 50}
        text="rails: collapsed by default · layers fly out · property drawer is the only persistent panel"
        w={520}
      />
    </div>
  )
}

window.V2EdgeRails = V2EdgeRails
