/**
 * F7 — rival same-drain renders must not strand a mis-tagged fp
 * (docs/notes/convergence-fuzzing.md, findings ledger). One drain can
 * render one parton TWICE: a cullable wrapper's flip-in lane covers
 * its addressable child while the child's parked-era bump lanes it
 * directly. Each render commits a rival registration, and the
 * canonical store keeps the LAST-registered — but the client commits
 * lane bodies in WIRE order, which can differ. A heal or promote read
 * off the canonical merge then describes the RIVAL's emission: the
 * child lane's trailer heal names a `from` its own body never emitted,
 * the client's last-committed copy strands under a stale tag (defeating
 * its fp-skip forever), and the delivery record credits fps this body
 * never carried — which a later drop report would then revoke from the
 * WRONG delivery.
 *
 * The discipline under test: a lane's flush heals and drain promote
 * walk the RENDER'S OWN registrations (`_activeRenderRegistrations` —
 * the lane probe's per-iteration capture), so each lane's heal `from`
 * is the fp its own body emitted and whichever rival the client
 * commits last has a matching heal to the shared warm fp.
 *
 * The repros are the ledger's shrunk F7 sequences (seeds 2153 / 5722),
 * driven through the convergence harness: the real segment driver, the
 * faithful client model, and the cold-render oracle. Both sequences
 * mis-tag `fz-inner`'s fp on every pre-fix run (the drain interleaving
 * is deterministic for a fixed schedule); with the fix they converge.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { _resetCellStorage } from "../../runtime/cell-storage.ts"
import { formatResult, runSequence, type FuzzAction } from "../../test/fuzz-harness.ts"
import { _setFirstAckDeadlineMs, _setReconcileIntervalMs } from "../segmented-response.ts"
import { fixture, isolate } from "./fuzz-fixture.tsx"

beforeAll(() => {
  // Same determinism guards as the fuzz budget: the model acks
  // promptly (the never-acked degrade must not arm under load) and the
  // scheduled whole-tree reconcile must not heal the lane path
  // mid-sequence — the assertion is that the LANE path converges.
  _setFirstAckDeadlineMs(300_000)
  _setReconcileIntervalMs(3_600_000)
})

afterAll(() => {
  _setFirstAckDeadlineMs(undefined)
  _setReconcileIntervalMs(undefined)
  isolate()
  _resetCellStorage()
})

/** Seed 2153's shrunk sequence. The rival drain is actions 6–7: the
 *  wrapper's flip-in (its lane re-renders `fz-inner` inside its body)
 *  races `fz-inner`'s own lane for the parked-era `cellB` bump, and
 *  the second write lands mid-drain so the rivals' fps diverge. */
const SEQ_2153: FuzzAction[] = [
  { kind: "flip", ids: ["fz-wrap"] },
  { kind: "flip", ids: ["fz-cull-a", "fz-wrap"] },
  { kind: "settle" },
  { kind: "flip", ids: ["fz-wrap"] },
  { kind: "write", cell: 1, value: 7 },
  { kind: "flip", ids: ["fz-cull-b", "fz-wrap"] },
  { kind: "write", cell: 1, value: 8 },
]

/** Seed 5722's shrunk sequence — the same rival geometry: the
 *  wrapper's flip-in lane races the child's parked-era bump lane,
 *  with the second write landing mid-drain. */
const SEQ_5722: FuzzAction[] = [
  { kind: "flip", ids: ["fz-cull-a"] },
  { kind: "flip", ids: ["fz-cull-a", "fz-cull-b"] },
  { kind: "flip", ids: ["fz-wrap", "fz-cull-a"] },
  { kind: "write", cell: 1, value: 17 },
  { kind: "flip", ids: ["fz-wrap"] },
  { kind: "write", cell: 1, value: 18 },
]

async function expectConvergence(seed: number, actions: FuzzAction[]): Promise<void> {
  const result = await runSequence(fixture, seed, actions, isolate)
  expect(result.failure, formatResult(result)).toBeNull()
  expect(result.mismatches, formatResult(result)).toEqual([])
}

describe("F7 — a lane's heal and promote describe its own render, not the canonical rival", () => {
  it("seed 2153: the flip-in wrapper's rival render does not strand the child's fp", async () => {
    await expectConvergence(2153, SEQ_2153)
  }, 30_000)

  it("seed 5722: the same rival geometry from a distinct seed range converges", async () => {
    await expectConvergence(5722, SEQ_5722)
  }, 30_000)
})
