import { expect, test } from "@playwright/test"
import { restartBackends, updateOn, valueOn } from "./helpers"

/**
 * Contention scenario (the prototype's D, inverted): the prototype
 * DEMONSTRATED a lost update — two processes flushing whole-file
 * cells.json snapshots, last writer wins. Over the SQLite adapter the
 * same shape must lose NOTHING: `cell.update(fn)` runs as a
 * store-level CAS, per-key write ordering comes from the store itself,
 * and concurrent reducer-form writes from BOTH processes compose.
 * This closes the research→PoC workstream-2 cross-process claim.
 */

const PER_BACKEND = 50

test.beforeAll(async ({ request }) => {
  await restartBackends(request, [0, 1], { resetStore: true })
})

test(`${PER_BACKEND * 2} concurrent cross-process updates land exactly ${PER_BACKEND * 2}`, async ({
  request,
}) => {
  const v0 = await valueOn(request, 0)
  expect(v0).toBe(0) // boot-fresh store

  // Fire the full volley at once, interleaved across both processes —
  // every increment races every other through the shared store.
  const results = await Promise.all([
    ...Array.from({ length: PER_BACKEND }, () => updateOn(request, 0)),
    ...Array.from({ length: PER_BACKEND }, () => updateOn(request, 1)),
  ])

  // Distinct pids prove two real OS processes were writing.
  const pids = new Set(results.map((r) => r.pid))
  expect(pids.size).toBe(2)

  // Zero lost updates: both processes read the exact total through
  // their own handles.
  const total = v0 + PER_BACKEND * 2
  expect(await valueOn(request, 0)).toBe(total)
  expect(await valueOn(request, 1)).toBe(total)

  // Every committed value was unique — no two updates ever observed
  // the same base and clobbered (the CAS retry composes instead).
  const committedValues = new Set(results.map((r) => r.value))
  expect(committedValues.size).toBe(PER_BACKEND * 2)
  console.log(
    `[contention] ${PER_BACKEND * 2} updates across pids ${[...pids].join("/")} → ${total} (zero lost)`,
  )
})
