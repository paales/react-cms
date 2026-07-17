// @vitest-environment jsdom
import React, { act, useRef } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  _channelEstablished,
  _channelNavPoint,
  _channelNavSegmentCommitted,
  _channelNavSegmentSettled,
  _resetChannelClient,
} from "../channel-client.ts"
import { PartialIdContext, useNavigation } from "../partial-client.tsx"
import type { NavigationProgress } from "../../runtime/navigation-api.ts"
// The navigate/reload executors live in the late-loaded `frame-client`;
// the eager handle dynamically imports them on fire. In the running app
// the live layer has loaded that module by the time a user fires, so
// the import resolves from cache within the fire's microtask chain.
// Pre-load it here so these synchronous-milestone assertions model that
// steady state rather than a first-ever cold module load. `refetch.ts`
// (the channel flush a streaming reload lazy-imports per batch) is
// pre-loaded for the same reason.
import "../frame-client.tsx"
import "../refetch.ts"

/**
 * Hook contract under test:
 *
 *   const [reload, progress] = useNavigation().reload()
 *
 *   - `reload(options?)` returns `NavigationMilestones` synchronously:
 *     `{ committed: Promise, streaming: Promise, finished: Promise }`.
 *     Each rejects with a NavigationError on failure or AbortError on
 *     supersede.
 *   - `progress` is `{ committed, streaming, finished }` booleans,
 *     monotonic-per-fire, reset on each new fire.
 *   - On rejection (non-Abort), the hook throws on the next render so
 *     the nearest enclosing React error boundary catches. AbortError
 *     never throws (lifecycle signal, not a failure).
 *
 * Tests wrap `Probe` in a `TestBoundary` to capture both the per-render
 * progress booleans (via `cap.states`) AND the thrown error (via
 * `cap.caughtByBoundary`). The transport is the channel: a streaming
 * reload (`reload({ streaming: true })`) is an in-place `?__force=` url
 * statement whose milestones resolve at the covering segment's
 * commit/settle — the tests drive those moments directly
 * (`_channelNavSegmentCommitted` / `Settled`).
 */

let container: HTMLElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  _resetChannelClient()
  _channelEstablished("tuple-test")
  // Envelope flushes (when the environment provides rAF) go nowhere.
  vi.stubGlobal("fetch", () => Promise.resolve({ status: 204 }))
})

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  root = null
  container.remove()
  _resetChannelClient()
  vi.unstubAllGlobals()
})

interface FireOpts {
  streaming?: boolean
  signal?: AbortSignal
}

interface Capture {
  /** Returns the `finished` milestone of the most recent fire. */
  fire: ((opts?: FireOpts) => Promise<unknown>) | null
  states: NavigationProgress[]
  caughtByBoundary: Error | null
}

function Probe({ capture }: { capture: Capture }) {
  const [reload, progress] = useNavigation().reload()
  const fireRef = useRef(reload)
  fireRef.current = reload
  capture.fire = (opts) => reload(opts).finished
  capture.states.push({
    committed: progress.committed,
    streaming: progress.streaming,
    finished: progress.finished,
  })
  return null
}

class TestBoundary extends React.Component<
  { capture: Capture; children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error) {
    this.props.capture.caughtByBoundary = error
  }
  render() {
    if (this.state.error) return null
    return this.props.children
  }
}

async function render(capture: Capture) {
  await act(async () => {
    root = createRoot(container)
    root.render(
      <TestBoundary capture={capture}>
        <PartialIdContext.Provider value={null}>
          <Probe capture={capture} />
        </PartialIdContext.Provider>
      </TestBoundary>,
    )
  })
}

function newCapture(): Capture {
  return { fire: null, states: [], caughtByBoundary: null }
}

const ALL_FALSE: NavigationProgress = {
  committed: false,
  streaming: false,
  finished: false,
}
const ALL_TRUE: NavigationProgress = {
  committed: true,
  streaming: true,
  finished: true,
}

describe("useNavigation().reload() progress tuple", () => {
  it("starts with all milestones false", async () => {
    const cap = newCapture()
    await render(cap)
    expect(cap.states[cap.states.length - 1]).toEqual(ALL_FALSE)
  })

  it("flips committed → streaming → finished as the covering segment lands", async () => {
    const cap = newCapture()
    await render(cap)
    cap.states = []

    let firePromise!: Promise<unknown>
    await act(async () => {
      firePromise = cap.fire!({ streaming: true })
    })
    // For an in-place streaming reload, committed resolves immediately
    // (no browser reload), but streaming + finished await the covering
    // segment.
    expect(cap.states[cap.states.length - 1]).toMatchObject({
      committed: true,
      streaming: false,
      finished: false,
    })
    const navPoint = _channelNavPoint()
    expect(navPoint).toBeGreaterThan(0)

    // The covering segment commits.
    await act(async () => {
      _channelNavSegmentCommitted(navPoint)
    })
    expect(cap.states[cap.states.length - 1]).toMatchObject({
      committed: true,
      streaming: true,
      finished: false,
    })

    // The covering segment settles.
    await act(async () => {
      _channelNavSegmentSettled(navPoint)
      await firePromise
    })
    expect(cap.states[cap.states.length - 1]).toEqual(ALL_TRUE)
  })

  it("flips finished → true on AbortError but stores no error", async () => {
    const cap = newCapture()
    await render(cap)
    cap.states = []

    const controller = new AbortController()
    await act(async () => {
      const p = cap.fire!({ streaming: true, signal: controller.signal })
      controller.abort()
      await p.catch(() => {})
    })

    const last = cap.states[cap.states.length - 1]
    // Abort still lands the lifecycle — finished flips true.
    // committed flips true because the reload is in-place (no browser
    // reload). streaming stays false because the abort came before the
    // covering segment.
    expect(last.finished).toBe(true)
    expect(last.committed).toBe(true)
    expect(last.streaming).toBe(false)
    // The bubbler never receives an abort.
    expect(cap.caughtByBoundary).toBeNull()
  })
})
