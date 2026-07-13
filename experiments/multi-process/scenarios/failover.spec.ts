import { expect, test, type Page } from "@playwright/test"
import {
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
 * Failover MEASUREMENT (the prototype's E, extended per research→PoC
 * workstream 3: "measure before designing"). Kill the pinned process
 * UNGRACEFULLY mid-session while writes keep flowing through the
 * survivor, and record what is lost:
 *
 *   - whether committed writes survive (they must — the shared SQLite
 *     store is the truth; this is the hard assertion),
 *   - whether the viewer's held connection recovers by itself, and how
 *     long the update gap is (doorbell → DOM latency across the kill),
 *   - what the recovery costs on the wire (the re-attach's streamed
 *     bytes vs the original attach's, same write cadence, same
 *     window),
 *   - what visibly tears (DOM regression, document reloads).
 *
 * The numbers land in docs/notes/bridge-seam.md. The kill signal is
 * SIGKILL: since deploy-and-drain landed, SIGTERM is the GRACEFUL path
 * (the framework's drain handler settles lanes and signals reattach —
 * measured by drain.spec.ts); this scenario stays the ungraceful
 * crash-class baseline the drain is compared against.
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
        // Transient evaluation failure (e.g. mid-navigation) — skip.
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

test("SIGKILL the pinned backend mid-session: measure the ungraceful tear", async ({
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
  // viewer on backend 0 receives them via the bridge doorbell. The
  // driver runs for the whole scenario so the update gap is directly
  // readable from the DOM samples.
  const samples: Sample[] = []
  const sampler = sampleCounter(page, samples)
  let driving = true
  let lastCommitted = 0
  const driver = (async () => {
    while (driving) {
      try {
        lastCommitted = (await updateOn(request, 1)).value
      } catch {
        // The survivor never dies in this scenario; a transient refusal
        // (port churn) just skips a beat.
      }
      await sleep(250)
    }
  })()

  // Pre-kill: updates flow (cross-process doorbell working).
  await expect(page.getByTestId("counter")).not.toHaveText("Count: 0", { timeout: 10_000 })
  await sleep(3_000)
  const preKillDomValue = await counterValue(page)
  expect(preKillDomValue).toBeGreaterThan(0)

  // One write committed ON the doomed process right before the kill —
  // its survival through the shared store is the hard durability claim.
  const { value: committedOnDoomed } = await updateOn(request, 0)

  // ── The kill ─────────────────────────────────────────────────────────
  const attachCountBeforeKill = attachStarts.length
  const tKill = Date.now()
  await killBackend(request, 0, "SIGKILL")
  console.log(`[failover] backend 0 SIGKILLed at t=0 (dom=${preKillDomValue})`)

  // Committed writes survive: the survivor reads the doomed process's
  // last committed value (and everything before it) from the store.
  expect(await valueOn(request, 1)).toBeGreaterThanOrEqual(committedOnDoomed)

  // Wait for the viewer to converge again: the DOM advancing past the
  // driver's current committed value proves the held connection was
  // re-established end-to-end (attach → doorbell → lane).
  let recoveredAt: number | null = null
  const RECOVERY_DEADLINE_MS = 25_000
  while (Date.now() - tKill < RECOVERY_DEADLINE_MS) {
    const target = lastCommitted
    const dom = await counterValue(page)
    if (dom >= target && target > committedOnDoomed) {
      recoveredAt = Date.now()
      break
    }
    await sleep(200)
  }
  let recoveryMode = "auto"
  if (recoveredAt === null) {
    // No self-recovery inside the window — record that honestly and
    // measure the manual-reload price instead.
    recoveryMode = "manual-reload"
    await page.reload()
    await ready(page)
    recoveredAt = Date.now()
  }
  const recoveryMs = recoveredAt - tKill
  const reattaches = attachStarts.length - attachCountBeforeKill

  // Let the re-attached stream carry a few more updates, then stop the
  // driver and compare end state.
  await sleep(3_000)
  await sampler.stop()
  driving = false
  await driver
  await expect(page.getByTestId("counter")).toHaveText(`Count: ${lastCommitted}`, {
    timeout: 10_000,
  })

  // ── What visibly tore ────────────────────────────────────────────────
  // The DOM never regressed: no sample after the kill ever showed less
  // than the pre-kill value (committed state can go quiet, never
  // backward — the store is the truth).
  const postKill = samples.filter((s) => s.t >= tKill)
  const regressed = postKill.filter((s) => s.value < preKillDomValue)
  expect(regressed).toEqual([])
  // The longest silent stretch in the DOM samples across the kill —
  // the user-visible update gap.
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

  // ── What the recovery cost ───────────────────────────────────────────
  const stats = await proxyStats(request)
  const attaches = stats.filter((r) => r.path === "/__parton/live" && r.method === "POST")
  const initialAttach = attaches.find((r) => r.backend === 0)
  const reattach = attaches.filter((r) => r.backend === 1).at(-1)

  console.log(
    `[failover] recovery: ${recoveryMode} in ${recoveryMs}ms (longest DOM update gap ${gapMs}ms); ` +
      `${reattaches} attach POST(s) after the kill; document loads after kill: ${documentLoads - initialLoads}`,
  )
  console.log(
    `[failover] committed writes survived: doomed process committed ${committedOnDoomed}, ` +
      `survivor read >= that immediately; final converged value ${lastCommitted}`,
  )
  const now = Date.now()
  const life = (r: typeof initialAttach): string =>
    r ? `${r.bytes}B over ${((r.endMs ?? now) - r.startMs) / 1000}s` : "?"
  console.log(
    `[failover] wire cost (held-stream lifetime bytes, same 4 writes/s cadence): ` +
      `initial attach (backend 0) ${life(initialAttach)}; re-attach (backend 1) ${life(reattach)} — ` +
      `the re-attach's catch-up is a cold-process whole-tree render (per-process registry + fps died with the process; ` +
      `the shared store only saves the VALUES)`,
  )

  // Leave the harness whole for whatever runs next.
  await startBackend(request, 0)
  await ctx.close()
})
