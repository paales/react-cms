import { act, useState } from "react"
import { createRoot } from "react-dom/client"
import { beforeEach, describe, expect, it } from "vitest"

/**
 * Smoke test for the browser-mode Vitest tier. Mounts a real React
 * tree into a real DOM, drives it with a click, and asserts the
 * post-interaction state. Kept tiny on purpose — this file is
 * load-bearing for the plumbing (plugin-react transform, chromium
 * launch, JSDom-free render). Richer browser tests should live
 * alongside the components they exercise.
 */
function Counter() {
  const [n, setN] = useState(0)
  return (
    <button type="button" data-testid="counter" onClick={() => setN((x) => x + 1)}>
      {`count=${n}`}
    </button>
  )
}

describe("browser-mode smoke", () => {
  let container: HTMLDivElement

  beforeEach(() => {
    container = document.createElement("div")
    container.id = `browser-test-root-${Math.random().toString(36).slice(2, 9)}`
    document.body.appendChild(container)
  })

  it("mounts a client component in a real browser and reacts to clicks", async () => {
    const root = createRoot(container)
    await act(async () => {
      root.render(<Counter />)
    })

    const btn = container.querySelector<HTMLButtonElement>('[data-testid="counter"]')
    expect(btn).not.toBeNull()
    expect(btn?.textContent).toBe("count=0")

    await act(async () => {
      btn?.click()
      btn?.click()
    })
    expect(btn?.textContent).toBe("count=2")

    await act(async () => {
      root.unmount()
    })
    container.remove()
  })
})
