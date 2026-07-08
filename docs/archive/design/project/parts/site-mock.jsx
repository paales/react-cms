// A simple, low-fi mock of "the site behind the editor". Same in every variation
// so the focus stays on the editing UI on top.

function SiteMock({ width = 1100, height = 720, scrollY = 0, dim = false }) {
  return (
    <div
      className="site-bg no-scrollbar"
      style={{
        width,
        height,
        overflow: "hidden",
        position: "relative",
        filter: dim ? "grayscale(0.4) brightness(0.96)" : "none",
      }}
    >
      {/* fake top nav bar */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 70,
          background: "#faf7f0",
          borderBottom: "1px solid rgba(0,0,0,0.06)",
          display: "flex",
          alignItems: "center",
          padding: "0 36px",
          gap: 24,
          zIndex: 1,
          fontFamily: "var(--ui)",
        }}
      >
        <div
          style={{
            width: 110,
            height: 14,
            background: "#1a1a1f",
            borderRadius: 2,
          }}
        />
        <div style={{ flex: 1, display: "flex", gap: 22 }}>
          {["Shop", "Categories", "Sale", "About", "Contact"].map((x) => (
            <div
              key={x}
              style={{
                height: 10,
                width: 50 + x.length * 3,
                background: "rgba(0,0,0,0.18)",
                borderRadius: 2,
              }}
            />
          ))}
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              style={{ width: 18, height: 18, borderRadius: "50%", background: "rgba(0,0,0,0.12)" }}
            />
          ))}
        </div>
      </div>

      {/* hero block */}
      <div
        style={{
          position: "absolute",
          top: 70,
          left: 0,
          right: 0,
          height: 300,
          background: "#d9d4c5",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 14,
        }}
      >
        <div style={{ width: 180, height: 9, background: "rgba(0,0,0,0.25)", borderRadius: 2 }} />
        <div style={{ width: 420, height: 28, background: "rgba(0,0,0,0.55)", borderRadius: 3 }} />
        <div style={{ width: 360, height: 28, background: "rgba(0,0,0,0.55)", borderRadius: 3 }} />
        <div
          style={{
            marginTop: 16,
            width: 130,
            height: 38,
            background: "#1a1a1f",
            color: "#fff",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: "var(--ui)",
            fontSize: 13,
          }}
        >
          Shop now
        </div>
      </div>

      {/* features strip */}
      <div
        style={{
          position: "absolute",
          top: 370,
          left: 0,
          right: 0,
          height: 90,
          background: "#efeae0",
          display: "grid",
          gridTemplateColumns: "repeat(3,1fr)",
          alignItems: "center",
          padding: "0 60px",
        }}
      >
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}
          >
            <div
              style={{
                width: 36,
                height: 36,
                border: "1.5px dashed rgba(0,0,0,0.45)",
                borderRadius: 6,
                display: "grid",
                placeItems: "center",
                fontFamily: "var(--mono)",
                fontSize: 10,
                color: "rgba(0,0,0,0.55)",
                background: "rgba(0,0,0,0.03)",
              }}
            >
              icon
            </div>
            <div style={{ width: 100, height: 9, background: "#1a1a1f", borderRadius: 2 }} />
            <div
              style={{ width: 160, height: 7, background: "rgba(0,0,0,0.3)", borderRadius: 2 }}
            />
          </div>
        ))}
      </div>

      {/* product carousel slot */}
      <div
        style={{
          position: "absolute",
          top: 490,
          left: 30,
          right: 30,
          height: 200,
          boxSizing: "border-box",
          background: "#fff",
          border: "1px solid rgba(0,0,0,0.07)",
          display: "grid",
          gridTemplateColumns: "repeat(4,1fr)",
          gap: 16,
          padding: 16,
        }}
      >
        {[0, 1, 2, 3].map((i) => (
          <div key={i} style={{ background: "#efeae0", borderRadius: 4, position: "relative" }}>
            <div
              style={{
                position: "absolute",
                bottom: 12,
                left: 12,
                right: 12,
                height: 8,
                background: "rgba(0,0,0,0.45)",
                borderRadius: 2,
              }}
            />
            <div
              style={{
                position: "absolute",
                bottom: 28,
                left: 12,
                width: 60,
                height: 6,
                background: "rgba(0,0,0,0.25)",
                borderRadius: 2,
              }}
            />
          </div>
        ))}
      </div>
    </div>
  )
}

window.SiteMock = SiteMock
