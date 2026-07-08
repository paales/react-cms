// V3 — "Radial / Contextual"
// No persistent chrome. The selected element is the panel: a radial action
// menu pops next to the selection, and properties slide out from the
// element itself like a context-attached drawer.

function V3Radial() {
  const W = 1100,
    H = 720
  return (
    <div style={{ position: "relative", width: W, height: H, background: "#e9e4d8" }}>
      <SiteMock width={W} height={H} />

      {/* selection highlight on hero */}
      <div style={{ position: "absolute", left: 0, top: 70, pointerEvents: "none" }}>
        <SelectionRect
          width={W}
          height={300}
          margin={0}
          padding={20}
          showMargin={false}
          label={{ tag: "section", cls: "hero" }}
          dim={`${W} × 300`}
        />
      </div>

      {/* Radial action wheel anchored to the selection corner */}
      <div style={{ position: "absolute", left: W - 110, top: 60, zIndex: 6 }}>
        <RadialWheel />
      </div>

      {/* Context-attached property drawer — looks like it grew out of the selection */}
      <div
        style={{
          position: "absolute",
          left: 30,
          top: 380,
          width: 540,
          padding: 12,
          background: "rgba(255,255,255,0.97)",
          border: "1px solid rgba(0,0,0,0.12)",
          borderRadius: 10,
          boxShadow: "0 12px 30px rgba(0,0,0,0.12)",
          fontFamily: "var(--ui)",
          fontSize: 12,
          zIndex: 6,
        }}
      >
        {/* connector "tail" linking back up to selection */}
        <div
          style={{
            position: "absolute",
            left: 80,
            top: -10,
            width: 2,
            height: 10,
            background: "var(--insp-blue-strong)",
          }}
        />
        <div
          style={{
            position: "absolute",
            left: 76,
            top: -12,
            width: 10,
            height: 10,
            borderRadius: "50%",
            border: "2px solid var(--insp-blue-strong)",
            background: "#fff",
          }}
        />

        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <InspectorTag tag="section" cls="hero" dim="1100 × 300" />
          <div style={{ flex: 1 }} />
          <div className="mono" style={{ fontSize: 10, color: "var(--ink-3)" }}>
            esc to dismiss
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          <div>
            <SectionHead>Content</SectionHead>
            <Row label="Heading">
              <div className="wf-field">Passion for…</div>
            </Row>
            <Row label="CTA">
              <div className="wf-field">Shop now</div>
            </Row>
          </div>
          <div>
            <SectionHead>Layout</SectionHead>
            <Row label="Width">
              <div className="wf-segment">
                <div>Page</div>
                <div className="on">Full</div>
              </div>
            </Row>
            <Row label="Pad" hint="80">
              <div className="wf-slider" />
            </Row>
          </div>
          <div>
            <SectionHead>Background</SectionHead>
            <Row label="Type">
              <div className="wf-segment">
                <div className="on">Color</div>
                <div>Img</div>
              </div>
            </Row>
            <Row label="Color">
              <div style={{ display: "flex", gap: 6 }}>
                <div
                  style={{
                    width: 18,
                    height: 18,
                    background: "#d9d4c5",
                    borderRadius: 4,
                    border: "1px solid var(--line)",
                  }}
                />
                <div className="mono" style={{ fontSize: 11 }}>
                  #d9d4c5
                </div>
              </div>
            </Row>
          </div>
        </div>
      </div>

      {/* tiny bottom tray with breadcrumb path of the current selection */}
      <div
        style={{
          position: "absolute",
          left: "50%",
          bottom: 14,
          transform: "translateX(-50%)",
          background: "var(--ink)",
          color: "var(--paper)",
          borderRadius: 8,
          height: 30,
          padding: "0 4px",
          display: "flex",
          alignItems: "center",
          gap: 0,
          fontFamily: "var(--mono)",
          fontSize: 11,
          boxShadow: "0 8px 20px rgba(0,0,0,0.2)",
          zIndex: 7,
        }}
      >
        {["body", "main", "section.hero", "div.container", "h1"].map((c, i, arr) => (
          <React.Fragment key={i}>
            <div
              style={{
                padding: "0 8px",
                height: 22,
                display: "flex",
                alignItems: "center",
                borderRadius: 4,
                background: i === arr.length - 1 ? "rgba(108,177,240,0.25)" : "transparent",
                color: i === arr.length - 1 ? "#6cb1f0" : "var(--paper)",
              }}
            >
              {c}
            </div>
            {i < arr.length - 1 && <div style={{ color: "rgba(255,255,255,0.3)" }}>›</div>}
          </React.Fragment>
        ))}
        <div
          style={{ width: 1, height: 14, background: "rgba(255,255,255,0.2)", margin: "0 6px" }}
        />
        <div style={{ padding: "0 8px" }}>⌘K</div>
      </div>

      <Annotation
        x={30}
        y={H - 64}
        w={400}
        text="zero persistent chrome — actions orbit the selection, props attach to it, breadcrumbs at base"
      />
    </div>
  )
}

function RadialWheel() {
  const items = [
    { a: -90, l: "edit", i: "✎" },
    { a: -30, l: "style", i: "◐" },
    { a: 30, l: "dup", i: "⎘" },
    { a: 90, l: "move", i: "↕" },
    { a: 150, l: "del", i: "⌫" },
    { a: 210, l: "add", i: "+" },
  ]
  const r = 44
  return (
    <div style={{ position: "relative", width: 130, height: 130 }}>
      {/* center */}
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: "50%",
          transform: "translate(-50%,-50%)",
          width: 30,
          height: 30,
          borderRadius: "50%",
          background: "var(--ink)",
          color: "var(--paper)",
          display: "grid",
          placeItems: "center",
          fontSize: 13,
          boxShadow: "0 4px 12px rgba(0,0,0,0.25)",
        }}
      >
        ⌖
      </div>
      {/* arc dashed guide */}
      <div
        style={{
          position: "absolute",
          inset: 18,
          border: "1px dashed rgba(0,0,0,0.2)",
          borderRadius: "50%",
        }}
      />
      {items.map((it, i) => {
        const x = 65 + Math.cos((it.a * Math.PI) / 180) * r
        const y = 65 + Math.sin((it.a * Math.PI) / 180) * r
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: x - 14,
              top: y - 14,
              width: 28,
              height: 28,
              borderRadius: "50%",
              background: "#fff",
              border: "1.5px solid var(--ink)",
              display: "grid",
              placeItems: "center",
              fontSize: 12,
              boxShadow: "0 3px 8px rgba(0,0,0,0.15)",
            }}
          >
            {it.i}
          </div>
        )
      })}
    </div>
  )
}

window.V3Radial = V3Radial
