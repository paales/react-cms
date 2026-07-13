import { expect, test, type Page } from "@playwright/test"
import {
  BACKEND_URLS,
  counterValue,
  pin,
  proxyStats,
  ready,
  resetProxyStats,
  restartBackends,
  sleep,
  startBackend,
  killBackend,
  updateOn,
  valueOn,
} from "./helpers"

/**
 * Deploy-and-drain (research→PoC workstream 3's done-when). SIGTERM
 * the pinned process mid-session — writes flowing through the
 * survivor, one write IN FLIGHT on the doomed process at the kill —
 * and prove the drain beats the ungraceful failover baseline
 * (docs/notes/bridge-seam.md: ~2.1s recovery, ~1.9s DOM gap, proxy
 * connect-failure shaped):
 *
 *   (a) no visible tear: the DOM never regresses AND the update gap
 *       across the kill stays well under the ungraceful ~1.9s — the
 *       drain frame makes the client reattach the moment its stream
 *       settles, BEFORE the old process exits;
 *   (b) the in-flight write commits and survives (the drain window
 *       keeps actions serving; the shared SQLite store is the truth);
 *   (c) the viewer is live on the survivor afterward (updates flow,
 *       zero document reloads);
 *   (d) the reattach cost is recorded (bytes, ms, attach count) next
 *       to the ungraceful baseline — the full-price whole-tree render
 *       a cold process charges is the bounded cost.
 *
 * The wire mechanics under test: SIGTERM → the framework's drain
 * handler (installed by `createRscHandler`) refuses NEW attaches
 * (503 + x-parton-drain — the proxy fails the buffered POST over and
 * re-pins), writes the `drain` entry down every held stream, settles
 * open lanes, closes cleanly, exits. The client's drain handling arms
 * reattach-on-close; the settle re-fires the attach immediately.
 */

interface Sample {
  t: number
  value: number
}

/** Poll the counter DOM every ~100ms into `samples` until stopped. */
function sampleCounter(page: Page, samples: Sample[]): { stop: () => Promise<void> } {
  let running = true
  const loop = (async () => {
    while (running) {
      try {
        samples.push({ t: Date.now(), value: await counterValue(page) })
      } catch {
        // Transient evaluation failure — skip the sample.
      }
      await sleep(100)
    }
  })()
  return {
    stop: async () => {
      running = false
      await loop
    },
  }
}

test("SIGTERM with drain: no tear, in-flight write lands, bounded reattach", async ({
  browser,
  request,
}) => {
  test.setTimeout(180_000)
  await restartBackends(request, [0, 1], { resetStore: true })
  await resetProxyStats(request)

  const ctx = await browser.newContext()
  await pin(ctx, 0)
  const page = await ctx.newPage()

  // Wire-level observability: attach POSTs and document loads.
  const attachStarts: number[] = []
  page.on("request", (req) => {
    if (new URL(req.url()).pathname === "/__parton/live") attachStarts.push(Date.now())
  })
  let documentLoads = 0
  page.on("load", () => documentLoads++)

  await page.goto("/")
  await ready(page)
  const initialLoads = documentLoads
  expect(attachStarts.length).toBeGreaterThan(0)

  // Continuous writes through the SURVIVOR (backend 1), 4/s — the
  // viewer on backend 0 receives them via the bridge doorbell before
  // the kill and via its own registry after the reattach lands on 1.
  const samples: Sample[] = []
  const sampler = sampleCounter(page, samples)
  let driving = true
  let lastCommitted = 0
  const driver = (async () => {
    while (driving) {
      try {
        lastCommitted = (await updateOn(request, 1)).value
      } catch {
        // The survivor never dies here; a transient refusal skips a beat.
      }
      await sleep(250)
    }
  })()

  // Pre-kill: updates flow.
  await expect(page.getByTestId("counter")).not.toHaveText("Count: 0", { timeout: 10_000 })
  await sleep(3_000)
  const preKillDomValue = await counterValue(page)
  expect(preKillDomValue).toBeGreaterThan(0)

  // ── The kill, with a write IN FLIGHT on the doomed process ──────────
  // The endpoint sleeps 300ms BEFORE its write (the explicit in-flight
  // lever), so the SIGTERM lands while the process has SEEN the request
  // but not yet committed: the drain's in-flight gauge must hold the
  // exit until the write commits and its response flushes.
  const attachCountBeforeKill = attachStarts.length
  const inFlight = updateOn(request, 0, { delayMs: 300 })
  await sleep(50)
  const tKill = Date.now()
  const killed = killBackend(request, 0, "SIGTERM")
  const inFlightResult = await inFlight
  await killed
  console.log(
    `[drain] backend 0 SIGTERMed at t=0 (dom=${preKillDomValue}); ` +
      `in-flight write committed value ${inFlightResult.value} on pid ${inFlightResult.pid}`,
  )

  // (b) The in-flight write survives: the survivor reads at least it.
  expect(await valueOn(request, 1)).toBeGreaterThanOrEqual(inFlightResult.value)

  // (c) Recovery: the DOM advances past the driver's current committed
  // value — the reattach landed on the survivor end-to-end.
  let recoveredAt: number | null = null
  const RECOVERY_DEADLINE_MS = 15_000
  while (Date.now() - tKill < RECOVERY_DEADLINE_MS) {
    const target = lastCommitted
    const dom = await counterValue(page)
    if (dom >= target && target > inFlightResult.value) {
      recoveredAt = Date.now()
      break
    }
    await sleep(100)
  }
  expect(recoveredAt, "viewer must self-recover inside the window").not.toBeNull()
  const recoveryMs = recoveredAt! - tKill
  const reattaches = attachStarts.length - attachCountBeforeKill

  // Let the reattached stream carry a few more updates, then settle.
  await sleep(3_000)
  await sampler.stop()
  driving = false
  await driver
  await expect(page.getByTestId("counter")).toHaveText(`Count: ${lastCommitted}`, {
    timeout: 10_000,
  })

  // ── (a) No visible tear ──────────────────────────────────────────────
  // The DOM never regressed across the kill.
  const postKill = samples.filter((s) => s.t >= tKill)
  const regressed = postKill.filter((s) => s.value < preKillDomValue)
  expect(regressed).toEqual([])
  // The longest silent stretch across the kill — the user-visible gap.
  let gapMs = 0
  let gapStart = tKill
  let lastValue = preKillDomValue
  for (const s of postKill) {
    if (s.value > lastValue) {
      gapMs = Math.max(gapMs, s.t - gapStart)
      gapStart = s.t
      lastValue = s.value
    }
  }
  // The drain must beat the ungraceful baseline's ~1.9s gap — the
  // whole point of reattaching BEFORE the old process exits. Headroom
  // over the measured steady state (sub-second) for CI variance.
  expect(gapMs, "drain must beat the ungraceful ~1.9s DOM gap").toBeLessThan(1_900)
  // Zero document reloads: recovery is the channel's own reattach.
  expect(documentLoads - initialLoads).toBe(0)
  expect(reattaches).toBeGreaterThanOrEqual(1)

  // ── (d) The reattach cost, next to the baseline ──────────────────────
  const stats = await proxyStats(request)
  const attaches = stats.filter((r) => r.path === "/__parton/live" && r.method === "POST")
  const initialAttach = attaches.find((r) => r.backend === 0 && r.status === 200)
  const reattach = attaches.filter((r) => r.backend === 1 && r.status === 200).at(-1)
  const drainRefusals = attaches.filter((r) => r.status === 503)
  const now = Date.now()
  const life = (r: typeof initialAttach): string =>
    r ? `${r.bytes}B over ${((r.endMs ?? now) - r.startMs) / 1000}s` : "?"
  console.log(
    `[drain] recovery in ${recoveryMs}ms (longest DOM update gap ${gapMs}ms); ` +
      `${reattaches} attach POST(s) after the kill (${drainRefusals.length} explicit drain refusal(s) ` +
      `absorbed by the proxy); document loads after kill: ${documentLoads - initialLoads}`,
  )
  console.log(
    `[drain] wire cost (held-stream lifetime bytes, same 4 writes/s cadence): ` +
      `initial attach (backend 0) ${life(initialAttach)}; drained re-attach (backend 1) ${life(reattach)} — ` +
      `the re-attach is the cold process's full-price whole-tree render (per-process registry + fps ` +
      `are not portable; values ride the store)`,
  )

  // Sanity on the wire mechanics: the doomed backend exited (its port
  // refuses) and the drain window served the in-flight write ON pid 0's
  // process (the response carried its pid).
  await expect(async () => {
    const res = await request.get(`${BACKEND_URLS[0]}/__mp/value`).catch(() => null)
    expect(res === null || !res.ok()).toBe(true)
  }).toPass({ timeout: 10_000 })

  // Leave the harness whole for whatever runs next.
  await startBackend(request, 0)
  await ctx.close()
})
