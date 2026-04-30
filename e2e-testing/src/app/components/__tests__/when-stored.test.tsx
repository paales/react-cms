// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { WhenStored } from "../when-stored.tsx"

// ──────────────────────────────────────────────────────────────
// Harness: render <WhenStored>, spy on the server-refetch handler.
//
// `useActivate` routes `fire()` through `enqueueRefetch` → the window-
// scoped `__rsc_partial_refetch` handler (installed by
// `entry.browser.tsx` at runtime). Stubbing it here lets the tests
// assert activation without booting the real RSC machinery, and the
// microtask-batched dispatcher means a single `Promise.resolve()`
// flush is enough to observe whether it fired.
// ──────────────────────────────────────────────────────────────

let container: HTMLElement
let root: Root | null = null
let refetchSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  container = document.createElement("div")
  document.body.appendChild(container)
  refetchSpy = vi.fn(() => Promise.resolve())
  ;(window as Window & { __rsc_partial_refetch?: unknown }).__rsc_partial_refetch = refetchSpy
})

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  root = null
  container.remove()
  delete (window as Window & { __rsc_partial_refetch?: unknown }).__rsc_partial_refetch
})

async function render(props: {
  partialId: string
  storageKey: string
  store?: "local" | "session"
  as?: string
}) {
  await act(async () => {
    root = createRoot(container)
    root.render(
      <WhenStored {...props}>
        <span>child</span>
      </WhenStored>,
    )
  })
  // Flush the microtask-batched refetch dispatcher.
  await Promise.resolve()
}

async function unmount() {
  await act(async () => {
    root?.unmount()
    root = null
  })
}

describe("<WhenStored>", () => {
  it("throws when partialId is missing", () => {
    expect(() => WhenStored({ storageKey: "greeting" } as never)).toThrowError(/partialId/)
  })

  it("fires immediately when the key is already present on mount and sends the value as a prop", async () => {
    localStorage.setItem("greeting", "hi")
    history.replaceState(null, "", "/defer-demo")

    await render({ partialId: "t", storageKey: "greeting" })

    expect(refetchSpy).toHaveBeenCalled()
    const refetchUrl = new URL(refetchSpy.mock.calls[0]?.[0] as string)
    const partialProps = JSON.parse(refetchUrl.searchParams.get("partialProps") ?? "{}")
    expect(partialProps).toEqual({ t: { stored: "hi" } })
  })

  it("does not fire when the key is absent on mount", async () => {
    await render({ partialId: "t", storageKey: "greeting" })
    expect(refetchSpy).not.toHaveBeenCalled()
  })

  it("fires when a matching storage event arrives and sends the value as a prop", async () => {
    history.replaceState(null, "", "/defer-demo")
    await render({ partialId: "t", storageKey: "greeting" })
    expect(refetchSpy).not.toHaveBeenCalled()

    await act(async () => {
      localStorage.setItem("greeting", "hello")
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "greeting",
          newValue: "hello",
          storageArea: localStorage,
        }),
      )
    })
    await Promise.resolve()

    expect(refetchSpy).toHaveBeenCalled()
    const refetchUrl = new URL(refetchSpy.mock.calls[0]?.[0] as string)
    const partialProps = JSON.parse(refetchUrl.searchParams.get("partialProps") ?? "{}")
    expect(partialProps).toEqual({ t: { stored: "hello" } })
  })

  it("ignores storage events for other keys", async () => {
    await render({ partialId: "t", storageKey: "greeting" })
    refetchSpy.mockClear()

    await act(async () => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "OTHER",
          newValue: "val",
          storageArea: localStorage,
        }),
      )
    })
    await Promise.resolve()

    expect(refetchSpy).not.toHaveBeenCalled()
  })

  it("ignores storage events from a different storage area", async () => {
    await render({ partialId: "t", storageKey: "greeting" })
    refetchSpy.mockClear()

    await act(async () => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "greeting",
          newValue: "hi",
          storageArea: sessionStorage,
        }),
      )
    })
    await Promise.resolve()

    expect(refetchSpy).not.toHaveBeenCalled()
  })

  it("uses the `as` prop as the prop key name", async () => {
    localStorage.setItem("greeting", "hi")
    history.replaceState(null, "", "/defer-demo")

    await render({ partialId: "t", storageKey: "greeting", as: "draftId" })

    expect(refetchSpy).toHaveBeenCalled()
    const refetchUrl = new URL(refetchSpy.mock.calls[0]?.[0] as string)
    const partialProps = JSON.parse(refetchUrl.searchParams.get("partialProps") ?? "{}")
    expect(partialProps).toEqual({ t: { draftId: "hi" } })
  })

  it("reads sessionStorage when store='session'", async () => {
    sessionStorage.setItem("greeting", "hi")
    history.replaceState(null, "", "/defer-demo")

    await render({ partialId: "t", storageKey: "greeting", store: "session" })

    expect(refetchSpy).toHaveBeenCalled()
    const refetchUrl = new URL(refetchSpy.mock.calls[0]?.[0] as string)
    const partialProps = JSON.parse(refetchUrl.searchParams.get("partialProps") ?? "{}")
    expect(partialProps).toEqual({ t: { stored: "hi" } })
  })

  it("cleanup removes the storage listener", async () => {
    await render({ partialId: "t", storageKey: "greeting" })
    refetchSpy.mockClear()
    await unmount()

    await act(async () => {
      localStorage.setItem("greeting", "hi")
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "greeting",
          newValue: "hi",
          storageArea: localStorage,
        }),
      )
    })
    await Promise.resolve()

    expect(refetchSpy).not.toHaveBeenCalled()
  })
})
