/**
 * Deferred cell writes — the action-commit accounting that lets a
 * `deferred` cell's write skip the action-response re-render and
 * propagate over the open streaming connection instead.
 *
 * These cover the FRAMEWORK half: `writeOneCell` records each write,
 * `_actionSuppressesCommit()` reads the tally, and a deferred write
 * still bumps the invalidation registry (so a heartbeat re-render picks
 * it up). The wire half — the app entry emitting `root: null` and the
 * client skipping that commit — is exercised by
 * `e2e-testing/e2e/deferred-demo.spec.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { localCell } from "../cell.ts"
import { _actionSuppressesCommit, runWithRequestAsync } from "../../runtime/context.ts"
import { MemoryCellStorage, setCellStorage, _resetCellStorage } from "../../runtime/cell-storage.ts"
import { _clearInvalidationRegistry, _currentTs } from "../../runtime/invalidation-registry.ts"

beforeEach(() => {
  setCellStorage(new MemoryCellStorage())
  _clearInvalidationRegistry()
})

afterEach(() => {
  _resetCellStorage()
  _clearInvalidationRegistry()
})

describe("deferred cell writes — action-commit accounting", () => {
  it("a deferred write suppresses the action commit but still bumps the registry", async () => {
    const ping = localCell({
      id: "test.deferred-ping",
      shape: "number",
      vary: () => ({}),
      initial: 0,
      deferred: true,
    })
    await runWithRequestAsync(new Request("http://t/x"), async () => {
      expect(_actionSuppressesCommit()).toBe(false) // no writes yet
      const before = _currentTs()
      await ping.set(1)
      // Every write this request was to a deferred cell → the action
      // response omits its re-render (`root: null`).
      expect(_actionSuppressesCommit()).toBe(true)
      // …but the invalidation bump still landed, so the already-open
      // streaming connection re-renders and carries the new value.
      expect(_currentTs()).toBeGreaterThan(before)
    })
  })

  it("a non-deferred write does not suppress the commit", async () => {
    const bump = localCell({
      id: "test.plain-bump",
      shape: "number",
      vary: () => ({}),
      initial: 0,
    })
    await runWithRequestAsync(new Request("http://t/x"), async () => {
      await bump.set(1)
      expect(_actionSuppressesCommit()).toBe(false)
    })
  })

  it("a mixed batch does not suppress — the non-deferred write still needs the render", async () => {
    const ping = localCell({
      id: "test.mix-ping",
      shape: "number",
      vary: () => ({}),
      initial: 0,
      deferred: true,
    })
    const bump = localCell({
      id: "test.mix-bump",
      shape: "number",
      vary: () => ({}),
      initial: 0,
    })
    await runWithRequestAsync(new Request("http://t/x"), async () => {
      await ping.set(1)
      await bump.set(1)
      expect(_actionSuppressesCommit()).toBe(false)
    })
  })

  it("the accounting is per-request — a fresh request starts unsuppressed", async () => {
    const ping = localCell({
      id: "test.fresh-ping",
      shape: "number",
      vary: () => ({}),
      initial: 0,
      deferred: true,
    })
    await runWithRequestAsync(new Request("http://t/x"), async () => {
      await ping.set(1)
      expect(_actionSuppressesCommit()).toBe(true)
    })
    // A new request gets a fresh store — no writes recorded yet.
    await runWithRequestAsync(new Request("http://t/x"), async () => {
      expect(_actionSuppressesCommit()).toBe(false)
    })
  })
})
