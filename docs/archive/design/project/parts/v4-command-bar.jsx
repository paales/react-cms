// V4 — "Command-bar first"
// Minimum chrome. A persistent command bar at the top is the only visible
// editor. Selecting a block reveals an inline floating spec card with the
// inspector visualization.

function V4CommandBar() {
  const W = 1100,
    H = 720
  return (
    <div style={{ position: "relative", width: W, height: H, background: "#e9e4d8" }}>
      <SiteMock width={W} height={H} />

      {/* Command bar — top, centered, like raycast/vercel */}
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: 14,
          transform: "translateX(-50%)",
          width: 540,
          height: 42,
          background: "rgba(26,26,31,0.95)",
          backdropFilter: "blur(8px)",
          color: "var(--paper)",
          borderRadius: 10,
          boxShadow: "0 12px 30px rgba(0,0,0,0.25)",
          display: "flex",
          alignItems: "center",
          padding: "0 14px",
          gap: 12,
          fontFamily: "var(--ui)",
          fontSize: 12,
          zIndex: 8,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <div
            style={{ width: 14, height: 14, borderRadius: 3, border: "1.5px solid var(--paper)" }}
          />
          <span style={{ opacity: 0.6 }}>home</span>
          <span style={{ opacity: 0.4 }}>›</span>
          <span>hero</span>
        </div>
        <div
          style={{
            flex: 1,
            height: 26,
            borderRadius: 6,
            background: "rgba(255,255,255,0.08)",
            padding: "0 10px",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <span style={{ opacity: 0.5 }}>⌘K</span>
          <span style={{ opacity: 0.7 }}>add block, change color, swap layout…</span>
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          {["↶", "↷", "◐", "▷"].map((c, i) => (
            <div
              key={i}
              style={{
                width: 26,
                height: 26,
                borderRadius: 5,
                background: "rgba(255,255,255,0.08)",
                display: "grid",
                placeItems: "center",
                fontSize: 12,
              }}
            >
              {c}
            </div>
          ))}
        </div>
      </div>

      {/* Selection on the featured-collection block */}
      <div style={{ position: "absolute", left: 30, top: 480, pointerEvents: "none" }}>
        <div
          style={{
            width: W - 60,
            height: 200,
            outline: "2px solid var(--insp-blue-strong)",
            outlineOffset: -1,
            background: "rgba(108,177,240,0.05)",
          }}
        />
      </div>

      {/* Floating spec card — appears next to the selection (right of it, hovering) */}
      <div
        style={{
          position: "absolute",
          right: 60,
          top: 200,
          width: 300,
          background: "rgba(255,255,255,0.97)",
          border: "1px solid rgba(0,0,0,0.12)",
          borderRadius: 10,
          boxShadow: "0 14px 36px rgba(0,0,0,0.16)",
          padding: 14,
          fontFamily: "var(--ui)",
          fontSize: 12,
          zIndex: 6,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <InspectorTag tag="section" cls="featured" dim="1040 × 200" />
          <div style={{ flex: 1 }} />
          <div style={{ fontSize: 14, color: "var(--ink-2)" }}>×</div>
        </div>

        {/* mini visual model (replaces a wall of inputs) */}
        <div
          style={{
            position: "relative",
            height: 130,
            marginBottom: 14,
            background: "#fff",
            border: "1px solid rgba(0,0,0,0.1)",
            borderRadius: 6,
          }}
        >
          <div
            className="stripes-margin"
            style={{ position: "absolute", inset: 8, borderRadius: 4 }}
          />
          <div
            className="stripes-padding"
            style={{ position: "absolute", inset: 22, borderRadius: 4 }}
          />
          <div
            style={{
              position: "absolute",
              inset: 38,
              outline: "1.5px dashed var(--insp-blue-strong)",
              background: "rgba(108,177,240,0.18)",
              display: "grid",
              gridTemplateColumns: "repeat(4,1fr)",
              gap: 4,
              padding: 4,
            }}
          >
            {[0, 1, 2, 3].map((i) => (
              <div key={i} style={{ background: "rgba(0,0,0,0.08)", borderRadius: 2 }} />
            ))}
          </div>
          {/* spacing labels */}
          {[
            { t: "m 0", left: "50%", top: 1, transform: "translateX(-50%)" },
            { t: "m 80", left: "50%", bottom: 1, transform: "translateX(-50%)" },
            { t: "p 24", left: 1, top: "50%", transform: "translateY(-50%)" },
            { t: "p 24", right: 1, top: "50%", transform: "translateY(-50%)" },
          ].map((p, i) => (
            <div
              key={i}
              className="mono"
              style={{
                position: "absolute",
                ...p,
                fontSize: 9.5,
                color: "var(--ink-2)",
                background: "#fff",
                padding: "1px 3px",
                borderRadius: 2,
              }}
            >
              {p.t}
            </div>
          ))}
        </div>

        {/* quick actions row */}
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {["cols 4", "gap 16", "full", "center", "color", "m 0/80"].map((c, i) => (
            <div
              key={i}
              className="mono"
              style={{
                fontSize: 11,
                padding: "4px 8px",
                border: "1px solid rgba(0,0,0,0.18)",
                borderRadius: 5,
                background: "#fff",
              }}
            >
              {c}
            </div>
          ))}
        </div>

        <div
          style={{ marginTop: 10, fontFamily: "var(--mono)", fontSize: 10, color: "var(--ink-3)" }}
        >
          tab to focus · ⌘k for everything else
        </div>
      </div>

      {/* Floating add-block hint between sections */}
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: 460,
          transform: "translateX(-50%)",
          zIndex: 5,
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <div
          style={{
            height: 1,
            width: 380,
            background: "var(--insp-blue-strong)",
            opacity: 0.4,
          }}
        />
        <div
          style={{
            width: 22,
            height: 22,
            borderRadius: "50%",
            background: "var(--insp-blue-strong)",
            color: "#fff",
            display: "grid",
            placeItems: "center",
            fontSize: 12,
          }}
        >
          +
        </div>
        <div
          style={{ height: 1, width: 380, background: "var(--insp-blue-strong)", opacity: 0.4 }}
        />
      </div>

      <Annotation
        x={30}
        y={H - 50}
        w={400}
        text="command bar = primary surface · spec card hovers near selection · ⌘K does the rest"
      />
    </div>
  )
}

window.V4CommandBar = V4CommandBar
