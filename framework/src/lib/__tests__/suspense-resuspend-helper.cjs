/**
 * CJS helper for suspense-resuspend.test.tsx
 *
 * Tests React's Suspense re-suspend behavior in a real DOM (jsdom).
 * Runs in a Node subprocess to avoid vitest ESM/CJS dual-React issues.
 *
 * Validates:
 * 1. Stable Suspense key: React 19 hides old content + shows fallback (display:none trick)
 * 2. Changed Suspense key: React unmounts old boundary + shows fallback (clean remount)
 * 3. Multiple boundaries with changed keys: independent progressive reveal
 */

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const jsdom = require("jsdom")
const { JSDOM } = jsdom

const dom = new JSDOM("<!DOCTYPE html><html><body><div id='root'></div></body></html>")
global.document = dom.window.document
global.window = dom.window
global.navigator = dom.window.navigator
global.HTMLElement = dom.window.HTMLElement

const React = require("react")
const { createRoot } = require("react-dom/client")
const { act } = require("react")

function createResolvable() {
  let resolve
  const promise = new Promise((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function SuspendingChild({ promise }) {
  const value = React.use(promise)
  return React.createElement("span", { "data-testid": "content" }, value)
}

/** Get only the VISIBLE text (excludes elements with display:none) */
function getVisibleText(container) {
  const all = container.querySelectorAll("*")
  let text = ""
  for (const el of all) {
    if (el.style.display === "none") continue
    if (el.children.length > 0) continue // only leaf nodes
    text += el.textContent
  }
  return text || container.textContent
}

/** Check if old content is hidden with display:none */
function hasHiddenContent(container, content) {
  const all = container.querySelectorAll("*")
  for (const el of all) {
    if (el.textContent === content && el.style.display === "none") return true
  }
  return false
}

const tests = {
  /**
   * Stable key: React 19 hides old content (display:none) and shows fallback.
   * The old DOM nodes remain in the tree but are invisible to the user.
   * textContent includes both, but visually only the fallback is shown.
   */
  "stable-key-hides-old-shows-fallback": async () => {
    const container = document.getElementById("root")
    container.innerHTML = ""

    const p1 = createResolvable()
    let setPromise

    function App() {
      const [promise, setP] = React.useState(p1.promise)
      setPromise = setP
      return React.createElement(
        React.Suspense,
        { fallback: React.createElement("span", null, "FALLBACK") },
        React.createElement(SuspendingChild, { promise }),
      )
    }

    let root
    await act(async () => {
      root = createRoot(container)
      root.render(React.createElement(App))
    })

    const mountedText = container.textContent

    await act(async () => {
      p1.resolve("first")
    })
    const resolvedText = container.textContent

    // Re-suspend with SAME key
    const p2 = createResolvable()
    await act(async () => {
      setPromise(p2.promise)
    })
    const resuspendText = container.textContent
    const resuspendHTML = container.innerHTML
    const oldContentHidden = hasHiddenContent(container, "first")
    const fallbackVisible = resuspendHTML.includes(">FALLBACK<")

    await act(async () => {
      p2.resolve("second")
    })
    const finalText = container.textContent

    root.unmount()

    return {
      mountedText,
      resolvedText,
      resuspendText,
      resuspendHTML,
      oldContentHidden,
      fallbackVisible,
      finalText,
    }
  },

  /**
   * Changed key: React unmounts old boundary entirely and mounts a new one.
   * No hidden content — clean slate. Fallback shows, then content.
   */
  "changed-key-clean-remount": async () => {
    const container = document.getElementById("root")
    container.innerHTML = ""

    const p1 = createResolvable()
    let setPromise
    let setVersion

    function App() {
      const [promise, setP] = React.useState(p1.promise)
      const [version, setV] = React.useState(0)
      setPromise = setP
      setVersion = setV
      return React.createElement(
        React.Suspense,
        {
          key: `v${version}`,
          fallback: React.createElement("span", null, "FALLBACK"),
        },
        React.createElement(SuspendingChild, { promise }),
      )
    }

    let root
    await act(async () => {
      root = createRoot(container)
      root.render(React.createElement(App))
    })

    const mountedText = container.textContent

    await act(async () => {
      p1.resolve("first")
    })
    const resolvedText = container.textContent

    // Re-suspend with CHANGED key
    const p2 = createResolvable()
    await act(async () => {
      setPromise(p2.promise)
      setVersion(1)
    })
    const resuspendText = container.textContent
    const resuspendHTML = container.innerHTML
    const oldContentHidden = hasHiddenContent(container, "first")

    await act(async () => {
      p2.resolve("second")
    })
    const finalText = container.textContent

    root.unmount()

    return {
      mountedText,
      resolvedText,
      resuspendText,
      resuspendHTML,
      oldContentHidden,
      finalText,
    }
  },

  /**
   * Multiple boundaries with changed keys: each reveals independently.
   * A resolves → shows content while B and C still show fallback.
   */
  "progressive-reveal": async () => {
    const container = document.getElementById("root")
    container.innerHTML = ""

    const p1a = createResolvable()
    const p1b = createResolvable()
    const p1c = createResolvable()
    let setPromises
    let setVersion

    function App() {
      const [promises, setP] = React.useState([p1a.promise, p1b.promise, p1c.promise])
      const [version, setV] = React.useState(0)
      setPromises = setP
      setVersion = setV

      return React.createElement(
        "div",
        null,
        React.createElement(
          React.Suspense,
          {
            key: `a-v${version}`,
            fallback: React.createElement("span", null, "[A:loading]"),
          },
          React.createElement(SuspendingChild, { promise: promises[0] }),
        ),
        React.createElement(
          React.Suspense,
          {
            key: `b-v${version}`,
            fallback: React.createElement("span", null, "[B:loading]"),
          },
          React.createElement(SuspendingChild, { promise: promises[1] }),
        ),
        React.createElement(
          React.Suspense,
          {
            key: `c-v${version}`,
            fallback: React.createElement("span", null, "[C:loading]"),
          },
          React.createElement(SuspendingChild, { promise: promises[2] }),
        ),
      )
    }

    let root
    await act(async () => {
      root = createRoot(container)
      root.render(React.createElement(App))
    })
    const step0 = container.textContent

    await act(async () => {
      p1a.resolve("A1")
      p1b.resolve("B1")
      p1c.resolve("C1")
    })
    const step1 = container.textContent

    // Re-suspend all with changed keys
    const p2a = createResolvable()
    const p2b = createResolvable()
    const p2c = createResolvable()
    await act(async () => {
      setPromises([p2a.promise, p2b.promise, p2c.promise])
      setVersion(1)
    })
    const step2 = container.textContent

    // Resolve A only
    await act(async () => {
      p2a.resolve("A2")
    })
    const step3 = container.textContent

    // Resolve B
    await act(async () => {
      p2b.resolve("B2")
    })
    const step4 = container.textContent

    // Resolve C
    await act(async () => {
      p2c.resolve("C2")
    })
    const step5 = container.textContent

    root.unmount()

    return { step0, step1, step2, step3, step4, step5 }
  },

  /**
   * Multiple boundaries with STABLE keys: verify fallback behavior.
   * Even with stable keys, React 19 shows fallbacks when using use().
   * Old content is hidden with display:none.
   */
  "stable-keys-multi-resuspend": async () => {
    const container = document.getElementById("root")
    container.innerHTML = ""

    const p1a = createResolvable()
    const p1b = createResolvable()
    const p1c = createResolvable()
    let setPromises

    function App() {
      const [promises, setP] = React.useState([p1a.promise, p1b.promise, p1c.promise])
      setPromises = setP

      return React.createElement(
        "div",
        null,
        React.createElement(
          React.Suspense,
          {
            key: "a",
            fallback: React.createElement("span", null, "[A:loading]"),
          },
          React.createElement(SuspendingChild, { promise: promises[0] }),
        ),
        React.createElement(
          React.Suspense,
          {
            key: "b",
            fallback: React.createElement("span", null, "[B:loading]"),
          },
          React.createElement(SuspendingChild, { promise: promises[1] }),
        ),
        React.createElement(
          React.Suspense,
          {
            key: "c",
            fallback: React.createElement("span", null, "[C:loading]"),
          },
          React.createElement(SuspendingChild, { promise: promises[2] }),
        ),
      )
    }

    let root
    await act(async () => {
      root = createRoot(container)
      root.render(React.createElement(App))
    })
    const step0 = container.textContent

    await act(async () => {
      p1a.resolve("A1")
      p1b.resolve("B1")
      p1c.resolve("C1")
    })
    const step1 = container.textContent

    // Re-suspend with STABLE keys
    const p2a = createResolvable()
    const p2b = createResolvable()
    const p2c = createResolvable()
    await act(async () => {
      setPromises([p2a.promise, p2b.promise, p2c.promise])
    })
    const step2_text = container.textContent
    const step2_html = container.innerHTML

    // Resolve A only
    await act(async () => {
      p2a.resolve("A2")
    })
    const step3_text = container.textContent

    // Resolve B + C
    await act(async () => {
      p2b.resolve("B2")
      p2c.resolve("C2")
    })
    const step4_text = container.textContent

    root.unmount()

    return { step0, step1, step2_text, step2_html, step3_text, step4_text }
  },
}

const testName = process.argv[2]
if (!tests[testName]) {
  console.error(`Unknown test: ${testName}`)
  process.exit(1)
}

tests[testName]().then((result) => {
  console.log(JSON.stringify(result))
})
