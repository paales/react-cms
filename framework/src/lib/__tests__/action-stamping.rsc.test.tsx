/**
 * Action-dispatch parton stamping — `__partonAction` runs under a
 * synthetic `CurrentParton` (id = the bound parton, request = the
 * action's OWN request, params = the baked match-param record), so:
 *
 *   - tracked hooks inside a schema callback read the CALLER's current
 *     cookies/session at dispatch time, not a replay of render-time
 *     values;
 *   - `param()` resolves the variant identity the ref baked;
 *   - a schema that `park()`s at dispatch time is a dispatch error
 *     (a parked parton has no boundary and isn't action-reachable).
 */

import { describe, expect, it, beforeEach } from "vitest"
import { parton, type RenderArgs } from "../partial.tsx"
import { __partonAction } from "../../runtime/parton-actions.ts"
import { runWithRequestAsync } from "../../runtime/context.ts"
import { _clearInvalidationRegistry } from "../../runtime/invalidation-registry.ts"
import { clearRegistry } from "../partial-registry.ts"
import { cookie, park, param } from "../server-hooks.ts"

// Schema reads the request via tracked hooks; the handler echoes what
// the schema resolved, so the assertion sees exactly what dispatch-time
// hooks returned.
const _EchoSpec = parton(
  function EchoRender(_: RenderArgs) {
    return <span>echo</span>
  },
  {
    selector: "#stamp-echo",
    schema: () => ({ who: cookie("who") ?? "anon", pid: param("id") ?? "" }),
    actions: {
      echo: async (scope: { who?: string; pid?: string }) => `${scope.who}:${scope.pid}`,
    },
  },
)

const _ParkedSpec = parton(
  function ParkedRender(_: RenderArgs) {
    return <span>parked</span>
  },
  {
    selector: "#stamp-parked",
    schema: () => {
      if (cookie("open") !== "1") park()
      return {}
    },
    actions: {
      save: async () => "saved",
    },
  },
)

beforeEach(() => {
  clearRegistry("all")
  _clearInvalidationRegistry()
})

describe("action dispatch — stamped CurrentParton", () => {
  it("schema hooks read the ACTION's request (caller's cookies), params come from the ref", async () => {
    const { result } = await runWithRequestAsync(
      new Request("http://t/__action", { headers: { cookie: "who=paul" } }),
      async () => await __partonAction("stamp-echo/echo", { id: "42" }, {}),
    )
    expect(result).toBe("paul:42")
  })

  it("two dispatches see their own request's values — nothing is replayed across calls", async () => {
    const dispatch = async (who: string) => {
      const { result } = await runWithRequestAsync(
        new Request("http://t/__action", { headers: { cookie: `who=${who}` } }),
        async () => await __partonAction("stamp-echo/echo", {}, {}),
      )
      return result
    }
    expect(await dispatch("alice")).toBe("alice:")
    expect(await dispatch("bob")).toBe("bob:")
  })

  it("a schema that parks at dispatch time rejects the action", async () => {
    await expect(
      runWithRequestAsync(new Request("http://t/__action"), async () =>
        __partonAction("stamp-parked/save", {}, {}),
      ),
    ).rejects.toThrow(/parked parton cannot handle actions/)
    // Same action with the gate open dispatches fine.
    const { result } = await runWithRequestAsync(
      new Request("http://t/__action", { headers: { cookie: "open=1" } }),
      async () => await __partonAction("stamp-parked/save", {}, {}),
    )
    expect(result).toBe("saved")
  })
})
