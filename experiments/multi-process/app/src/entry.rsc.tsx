import { createRscHandler } from "@parton/framework/entry/rsc.tsx"
import { setCellStorage } from "@parton/framework/runtime/cell-storage.ts"
import { SqliteCellStorage } from "@parton/framework/runtime/cell-storage-sqlite.ts"
import { runWithRequestAsync } from "@parton/framework/runtime/context.ts"
import { connectBusTransport } from "./bus.ts"
import { counter } from "./app/counter-state.ts"
import { Root } from "./app/root.tsx"

// The multi-process wiring, both halves of the consistency contract:
// the shared per-key store (values) and the bump bus (doorbells). The
// harness supervisor sets both env vars on every backend it spawns.
if (process.env.MP_SQLITE) {
  setCellStorage(new SqliteCellStorage(process.env.MP_SQLITE))
}
if (process.env.MP_BUS) {
  connectBusTransport(process.env.MP_BUS)
}

/**
 * Plain-HTTP write/read endpoints so scenarios can drive writes at a
 * SPECIFIC backend (bypassing the sticky proxy) without hand-crafting
 * Flight action payloads:
 *
 *   POST /__mp/update  → counter.update(n => n + 1); returns the
 *                        committed value (CAS-final — a retry's
 *                        recompute is what lands in `value`).
 *                        `?delay=<ms>` (≤ 2000) sleeps BEFORE the
 *                        write — the drain scenario's in-flight
 *                        window: a request the process has SEEN but
 *                        not yet committed when the deploy signal
 *                        lands must still commit and answer.
 *   GET  /__mp/value   → the current stored value (a peek at the
 *                        shared store through THIS process's handle).
 */
async function harnessEndpoints(request: Request): Promise<Response | null> {
  const url = new URL(request.url)
  if (!url.pathname.startsWith("/__mp/")) return null
  const { result } = await runWithRequestAsync(request, async () => {
    if (url.pathname === "/__mp/update" && request.method === "POST") {
      const delay = Math.min(Number(url.searchParams.get("delay") ?? 0) || 0, 2000)
      if (delay > 0) await new Promise((r) => setTimeout(r, delay))
      let committed = 0
      await counter.update((n) => {
        committed = n + 1
        return committed
      })
      return Response.json({ value: committed, pid: process.pid })
    }
    if (url.pathname === "/__mp/value") {
      return Response.json({ value: counter.peek(), pid: process.pid })
    }
    return new Response("unknown harness endpoint", { status: 404 })
  })
  return result
}

export default createRscHandler({
  Root,
  fetch: harnessEndpoints,
})
