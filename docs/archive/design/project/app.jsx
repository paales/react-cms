// App entry — lays the 5 wireframe variations out on a DesignCanvas.

const { useState } = React

// Tweaks context — V6 reads palette/treeStyle/surface/toolbar/attachment to repaint the editor.
window.TweaksCtx = React.createContext({
  palette: "inspector",
  treeStyle: "plain",
  surface: "light",
  toolbar: "floating",
  attachment: "floating",
})

function App() {
  const [t, setTweak] = useTweaks(window.TWEAK_DEFAULTS)
  // Expose setTweak globally so the V6 toolbar's view-toggle buttons (light/dark,
  // panel position) can mutate tweaks without threading the setter through every
  // component. The Tweaks panel still owns these controls; the toolbar buttons
  // are just shortcuts to the same state.
  window.__setTweak = setTweak
  return (
    <window.TweaksCtx.Provider value={t}>
      <DesignCanvas>
        <DCSection
          id="consolidated"
          title="Consolidated direction — based on your feedback"
          subtitle="Two panels · JSX-style component tree · page navigator · tabs · breadcrumb · refined stripes"
        >
          <DCArtboard
            id="v6"
            label="F · Consolidated — JSX tree, tabs, page navigator, breadcrumb, exit"
            width={1440}
            height={900}
          >
            <V6Consolidated />
          </DCArtboard>
        </DCSection>

        <DCSection
          id="floating-block-editor"
          title="Earlier explorations — 5 directions"
          subtitle="Chrome-inspector visual language · shadcn-flavored panels · floating over a real site"
        >
          <DCArtboard
            id="v1"
            label="A · Floating Island — both panels float, fully glassy"
            width={1100}
            height={720}
          >
            <V1FloatingIsland />
          </DCArtboard>
          <DCArtboard
            id="v2"
            label="B · Edge Rails — collapsed left rail, fly-out layers, persistent right drawer"
            width={1100}
            height={720}
          >
            <V2EdgeRails />
          </DCArtboard>
          <DCArtboard
            id="v3"
            label="C · Radial / Contextual — no chrome, action wheel orbits selection"
            width={1100}
            height={720}
          >
            <V3Radial />
          </DCArtboard>
          <DCArtboard
            id="v4"
            label="D · Command-bar first — ⌘K is primary, spec card hovers near selection"
            width={1100}
            height={720}
          >
            <V4CommandBar />
          </DCArtboard>
          <DCArtboard
            id="v5"
            label="E · Inspector Overlay — devtools-DNA at full strength: tabs, DOM tree, box model"
            width={1100}
            height={720}
          >
            <V5OverlayCanvas />
          </DCArtboard>
        </DCSection>

        <DCSection
          id="legend"
          title="Visual language used across all 5"
          subtitle="The shared vocabulary that ties the editor to Chrome devtools"
        >
          <DCArtboard
            id="vocab"
            label="Vocabulary — same in every variation"
            width={900}
            height={360}
          >
            <Vocabulary />
          </DCArtboard>
        </DCSection>
      </DesignCanvas>

      <TweaksPanel title="Tweaks">
        <TweakSection label="Palette" />
        <TweakRadio
          label="Color system"
          value={t.palette}
          options={[
            { value: "inspector", label: "Light" },
            { value: "dark", label: "Dark" },
          ]}
          onChange={(v) => setTweak("palette", v)}
        />
        <div style={{ fontSize: 10.5, color: "rgba(41,38,27,.5)", marginTop: -4 }}>
          {t.palette === "inspector" && "Chrome devtools — purple tags, brown attrs, blue values."}
          {t.palette === "dark" && "Devtools dark mode — light tags on dark panels."}
        </div>

        <TweakSection label="Layers tree" />
        <TweakRadio
          label="Tree style"
          value={t.treeStyle}
          options={[
            { value: "jsx", label: "JSX" },
            { value: "plain", label: "Plain" },
            { value: "path", label: "Path" },
          ]}
          onChange={(v) => setTweak("treeStyle", v)}
        />
        <div style={{ fontSize: 10.5, color: "rgba(41,38,27,.5)", marginTop: -4 }}>
          {t.treeStyle === "jsx" && "Mono-font <Tag> rendering — leans into the devtools metaphor."}
          {t.treeStyle === "plain" && "Human names in the UI font. Reads like a CMS."}
          {t.treeStyle === "path" && "Flat list — only the active branch + top-level groups."}
        </div>

        <TweakSection label="Panel surface" />
        <TweakRadio
          label="Material"
          value={t.surface}
          options={[
            { value: "light", label: "Light" },
            { value: "translucent", label: "Blur" },
            { value: "solid", label: "Solid" },
          ]}
          onChange={(v) => setTweak("surface", v)}
        />
        <div style={{ fontSize: 10.5, color: "rgba(41,38,27,.5)", marginTop: -4 }}>
          {t.surface === "light" && "Near-opaque white card with soft shadow."}
          {t.surface === "translucent" && "Frosted glass — site shows through, blurred behind."}
          {t.surface === "solid" && "Flat fill, hard 1px border, no shadow."}
        </div>

        <TweakSection label="Toolbar" />
        <TweakRadio
          label="Mode"
          value={t.toolbar}
          options={[
            { value: "floating", label: "Floating" },
            { value: "ribbon", label: "Ribbon" },
            { value: "hidden", label: "Hidden" },
          ]}
          onChange={(v) => setTweak("toolbar", v)}
        />
        <div style={{ fontSize: 10.5, color: "rgba(41,38,27,.5)", marginTop: -4 }}>
          {t.toolbar === "floating" && "Pill above the canvas — the current default."}
          {t.toolbar === "ribbon" && "Full-width strip pinned to the top of the viewport."}
          {t.toolbar === "hidden" && "No global toolbar — actions live in the panels only."}
        </div>

        <TweakSection label="Panel attachment" />
        <TweakRadio
          label="Position"
          value={t.attachment}
          options={[
            { value: "floating", label: "Floating" },
            { value: "docked", label: "Docked" },
          ]}
          onChange={(v) => setTweak("attachment", v)}
        />
        <div style={{ fontSize: 10.5, color: "rgba(41,38,27,.5)", marginTop: -4 }}>
          {t.attachment === "floating" &&
            "Drift above the canvas with shadows and rounded corners."}
          {t.attachment === "docked" &&
            "Snap flush to the edges, full height; topbar pins top-right."}
        </div>
      </TweaksPanel>
    </window.TweaksCtx.Provider>
  )
}

function Vocabulary() {
  return (
    <div style={{ padding: 30, background: "#f4f1ea", height: "100%", fontFamily: "var(--ui)" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 18 }}>
        <Swatch title="Margin" sub="diagonal pink stripes">
          <div className="stripes-margin" style={{ width: "100%", height: 80, borderRadius: 6 }} />
        </Swatch>
        <Swatch title="Padding" sub="diagonal green stripes">
          <div className="stripes-padding" style={{ width: "100%", height: 80, borderRadius: 6 }} />
        </Swatch>
        <Swatch title="Content / selection" sub="dashed blue, light blue fill">
          <div
            style={{
              width: "100%",
              height: 80,
              outline: "1.5px dashed var(--insp-blue-strong)",
              outlineOffset: -1,
              background: "rgba(108,177,240,0.18)",
              borderRadius: 0,
            }}
          />
        </Swatch>
        <Swatch title="Inspector tag" sub="floats outside the selection">
          <div
            style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 80 }}
          >
            <InspectorTag tag="section" cls="hero" dim="1100 × 300" />
          </div>
        </Swatch>
      </div>

      <div
        style={{
          marginTop: 24,
          fontFamily: "var(--hand)",
          fontSize: 18,
          color: "var(--ink-2)",
          lineHeight: 1.3,
        }}
      >
        every variation reuses these four primitives — the editor never feels like a separate UI
        sitting on top,
        <br />
        it feels like the inspector you already know, dressed up enough to design with.
      </div>
    </div>
  )
}

function Swatch({ title, sub, children }) {
  return (
    <div>
      <div
        style={{
          background: "#fff",
          border: "1px solid rgba(0,0,0,0.12)",
          borderRadius: 8,
          padding: 12,
        }}
      >
        {children}
      </div>
      <div style={{ marginTop: 8, fontWeight: 600, fontSize: 13 }}>{title}</div>
      <div className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>
        {sub}
      </div>
    </div>
  )
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />)
