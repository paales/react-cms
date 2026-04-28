import { execSync } from "node:child_process"
import path from "node:path"
import { describe, expect, it } from "vitest"

/**
 * Test React 19's Suspense re-suspend behavior with controlled promises.
 *
 * These tests prove how Suspense boundaries behave when children re-suspend
 * (go from resolved back to pending), which is the core mechanism behind
 * progressive streaming during AJAX partial refetches.
 *
 * Key findings:
 *
 * 1. React 19 DOES show the fallback on re-suspend, even with a stable key.
 *    BUT it keeps the old content in the DOM with `display: none !important`.
 *    textContent includes both old (hidden) and fallback text.
 *
 * 2. With a CHANGED key, React unmounts the old boundary entirely.
 *    Only the fallback exists in the DOM. Clean state.
 *
 * 3. Both approaches allow progressive reveal — each boundary resolves
 *    independently when its promise fulfills.
 *
 * We use changed keys (versioned Suspense) for a cleaner DOM, but the
 * core streaming fix is splitting search into three separate partials
 * so each gets its own lazy ref on the RSC Flight stream.
 *
 * Uses a CJS subprocess with jsdom to avoid vitest ESM/CJS dual-React issues.
 */

const helper = path.resolve(__dirname, "suspense-resuspend-helper.cjs")

function run(testName: string): any {
  const output = execSync(`node ${helper} ${testName}`, {
    encoding: "utf-8",
    timeout: 10000,
    cwd: path.resolve(__dirname, "../../.."),
  })
  // Last non-empty line is the JSON result (stderr has React warnings)
  const lines = output.trim().split("\n")
  return JSON.parse(lines[lines.length - 1])
}

describe("Suspense re-suspend behavior", () => {
  it("stable key: shows fallback on re-suspend but keeps old content hidden in DOM", () => {
    const r = run("stable-key-hides-old-shows-fallback")

    // Initial mount: fallback shown
    expect(r.mountedText).toBe("FALLBACK")

    // After resolving: content shown
    expect(r.resolvedText).toBe("first")

    // After re-suspending (same key): React 19 shows fallback AND hides old content.
    // Old content gets display:none, fallback is visible. textContent has both.
    expect(r.oldContentHidden).toBe(true)
    expect(r.fallbackVisible).toBe(true)
    expect(r.resuspendHTML).toContain("display: none !important")
    expect(r.resuspendHTML).toContain(">FALLBACK<")

    // After resolving second promise: new content shown
    expect(r.finalText).toBe("second")
  })

  it("changed key: shows fallback with clean DOM (no hidden remnants)", () => {
    const r = run("changed-key-clean-remount")

    expect(r.mountedText).toBe("FALLBACK")
    expect(r.resolvedText).toBe("first")

    // After re-suspending (changed key): boundary remounted cleanly.
    // Only fallback in DOM — no hidden old content.
    expect(r.resuspendText).toBe("FALLBACK")
    expect(r.resuspendHTML).not.toContain("display: none")
    expect(r.oldContentHidden).toBe(false)

    expect(r.finalText).toBe("second")
  })

  it("changed keys: multiple boundaries reveal independently (progressive streaming)", () => {
    const r = run("progressive-reveal")

    // All start with fallbacks
    expect(r.step0).toBe("[A:loading][B:loading][C:loading]")

    // All resolve → content shown
    expect(r.step1).toBe("A1B1C1")

    // Re-suspend with changed keys → all show clean fallbacks
    expect(r.step2).toBe("[A:loading][B:loading][C:loading]")

    // Resolve A only → A shows content, B and C still loading
    expect(r.step3).toBe("A2[B:loading][C:loading]")

    // Resolve B → A and B show content, C still loading
    expect(r.step4).toBe("A2B2[C:loading]")

    // Resolve C → all show new content
    expect(r.step5).toBe("A2B2C2")
  })

  it("stable keys: progressive reveal also works but DOM has hidden old content", () => {
    const r = run("stable-keys-multi-resuspend")

    expect(r.step0).toBe("[A:loading][B:loading][C:loading]")
    expect(r.step1).toBe("A1B1C1")

    // Re-suspend with stable keys: fallbacks shown, but old content hidden in DOM.
    // textContent has BOTH old (hidden) and fallback text for each boundary.
    expect(r.step2_html).toContain("display: none !important")
    expect(r.step2_text).toContain("[A:loading]")
    expect(r.step2_text).toContain("[B:loading]")
    expect(r.step2_text).toContain("[C:loading]")

    // After A resolves: A shows new content, B/C still have fallbacks + hidden old
    expect(r.step3_text).toContain("A2")
    expect(r.step3_text).toContain("[B:loading]")
    expect(r.step3_text).toContain("[C:loading]")

    // All resolved
    expect(r.step4_text).toBe("A2B2C2")
  })
})
