// Final Design entry — only V6, no DesignCanvas, no Tweaks panel.
// In-toolbar toggles (light/dark, dock/float, JSX/plain, status, etc.) still work
// because we keep useTweaks + window.__setTweak alive.

const { useState, useEffect, useRef } = React

window.TweaksCtx = React.createContext({
  palette: "inspector",
  treeStyle: "plain",
  surface: "light",
  toolbar: "floating",
  attachment: "docked",
})

function FinalApp() {
  const [t, setTweak] = useTweaks(window.TWEAK_DEFAULTS)
  window.__setTweak = setTweak

  // Scale 1440×900 V6 to fit the viewport — letterboxed on the page background.
  const W = 1440,
    H = 900
  const wrapRef = useRef(null)
  const [scale, setScale] = useState(1)
  useEffect(() => {
    const fit = () => {
      const vw = window.innerWidth
      const vh = window.innerHeight
      setScale(Math.min(vw / W, vh / H))
    }
    fit()
    window.addEventListener("resize", fit)
    return () => window.removeEventListener("resize", fit)
  }, [])

  const dark = t.palette === "dark"

  return (
    <window.TweaksCtx.Provider value={t}>
      <div
        style={{
          position: "fixed",
          inset: 0,
          background: dark ? "#0e0e12" : "#e9e4d8",
          display: "grid",
          placeItems: "center",
          overflow: "hidden",
        }}
      >
        {/* Outer box takes the scaled size so flex/grid centers correctly;
            inner box stays at native 1440×900 and scales from top-left. */}
        <div style={{ width: W * scale, height: H * scale, position: "relative" }}>
          <div
            ref={wrapRef}
            style={{
              width: W,
              height: H,
              transform: `scale(${scale})`,
              transformOrigin: "top left",
              position: "absolute",
              top: 0,
              left: 0,
            }}
          >
            <V6Consolidated />
          </div>
        </div>
      </div>
    </window.TweaksCtx.Provider>
  )
}

ReactDOM.createRoot(document.getElementById("root")).render(<FinalApp />)
