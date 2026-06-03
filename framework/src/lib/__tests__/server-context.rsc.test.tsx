/**
 * Verifies the server-context patch threads a value parent→child through
 * NESTED ASYNC components in a SINGLE Flight document — the capability the
 * `parent` prop replaces. Exercises the patched vendor via the public shim.
 *
 * The patch rides React's own task graph (`createTask` inherits, `retryTask`
 * save/restores the rendering task), so it survives `await` and isolates
 * siblings — neither of which an `AsyncLocalStorage` can do (see
 * [[partial-context]]).
 */

import { describe, expect, it } from "vitest"
import type { ReactNode } from "react"
import { renderServerToFlight, flightToString } from "../../test/rsc-server.ts"
import { captureCurrentTask, getAmbientParent, setTaskChildContext } from "../server-context.ts"
import { _childContext } from "../partial-context.ts"

const seen: Array<{ tag: string; parentPath: string }> = []

async function Node({ tag, children }: { tag: string; children?: ReactNode }) {
  // --- synchronous top: capture task, read parent, scope children ---
  const task = captureCurrentTask()
  const parent = getAmbientParent()
  seen.push({ tag, parentPath: parent.path.join("/") })
  setTaskChildContext(task, _childContext(parent, tag))
  // --- async work, like a parton awaiting vary/schema/cells ---
  await new Promise((r) => setTimeout(r, 1))
  return <div data-tag={tag}>{children}</div>
}

describe("server-context patch: threads through nested async (single document)", () => {
  it("accumulates parent.path O → O/M → O/M/I", async () => {
    seen.length = 0
    await flightToString(
      renderServerToFlight(
        <Node tag="O">
          <Node tag="M">
            <Node tag="I" />
          </Node>
        </Node>,
      ),
    )
    const byTag = Object.fromEntries(seen.map((s) => [s.tag, s.parentPath]))
    expect(byTag.O).toBe("") // root sees ROOT
    expect(byTag.M).toBe("O") // M's parent is O — threaded across O's await
    expect(byTag.I).toBe("O/M") // I's parent is O→M
  })

  it("isolates siblings — B sees P, not A (the enterWith failure)", async () => {
    seen.length = 0
    await flightToString(
      renderServerToFlight(
        <Node tag="P">
          <Node tag="A" />
          <Node tag="B" />
        </Node>,
      ),
    )
    const byTag = Object.fromEntries(seen.map((s) => [s.tag, s.parentPath]))
    expect(byTag.A).toBe("P")
    expect(byTag.B).toBe("P") // NOT "P/A" — retryTask save/restore isolates siblings
  })
})
