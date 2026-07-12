/**
 * Convergence fuzzing — seeded random walks over navigate / write /
 * flip / refetch / settle against a purpose-built fixture app, with
 * the convergence oracle at quiescence: the client model's committed
 * tree must equal a fresh cold render of the final URL + scope +
 * visibility set. Harness: `framework/src/test/fuzz-harness.ts`;
 * fixture: `fuzz-fixture.tsx`; design note:
 * `docs/notes/convergence-fuzzing.md` (including the two REAL
 * framework findings the first runs produced).
 *
 * CI runs a fixed, deterministic budget: 25 sequences × 20 actions
 * from seed 1. Three seeds reproduce the known findings and are
 * pinned as EXPECTED failures (exact signature asserted) — the test
 * goes red if they stop reproducing (the fix landed: delete the
 * entry and the note's finding) or if any OTHER seed fails.
 *
 * Long local runs:
 *
 *   PARTON_WAKE_PARITY=1 FUZZ_BUDGET=500 yarn test:rsc fuzz-convergence
 *
 * Knobs: FUZZ_BUDGET (sequences), FUZZ_LEN (actions per sequence),
 * FUZZ_SEED (first seed; sequence i uses seed FUZZ_SEED + i). With
 * overridden knobs the xfail pins don't apply; instead failures
 * matching the KNOWN finding classes are tallied and printed, and
 * only NEW classes (state/matchKey mismatches, harness failures)
 * fail the run — delete the class filter along with the bug fixes.
 *
 * On any unexpected failure the harness delta-debugs the action
 * sequence to a locally-minimal repro; the assertion message carries
 * seed + minimal sequence + expected/actual — paste the sequence back
 * through `runSequence` to reproduce.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { _resetCellStorage } from "../../runtime/cell-storage.ts"
import {
  generateSequence,
  runSequence,
  shrinkSequence,
  formatResult,
  type SequenceResult,
} from "../../test/fuzz-harness.ts"
import { _setFirstAckDeadlineMs, _setReconcileIntervalMs } from "../segmented-response.ts"
import { fixture, isolate } from "./fuzz-fixture.tsx"

// ─── Budget ──────────────────────────────────────────────────────────

const CI_MODE =
  process.env.FUZZ_BUDGET === undefined &&
  process.env.FUZZ_LEN === undefined &&
  process.env.FUZZ_SEED === undefined
const BUDGET = Number(process.env.FUZZ_BUDGET ?? 25)
const LEN = Number(process.env.FUZZ_LEN ?? 20)
const SEED0 = Number(process.env.FUZZ_SEED ?? 1)
const TIMEOUT_MS = Math.max(180_000, BUDGET * 2_000)

/** The known findings (docs/notes/convergence-fuzzing.md §Findings),
 *  pinned as expected failures at the CI budget. Signature = sorted
 *  `id.field` list of the UNSHRUNK run. When a seed here stops
 *  failing, the underlying fix landed — delete its entry (and the
 *  class filter below + the note's finding). */
const XFAIL: Record<number, string> = {
  // F1 — the covering-segment missed-update window (a write racing a
  // navigate/refetch consume is cleared as covered but carried
  // nowhere).
  9: "fz-cull-a.stamp",
  18: "fz-inner.fp,fz-inner.stamp",
  // F2 — parked-variant fp retag (the flush recompute heals a
  // match-missed snapshot under the request state that parked it).
  10: "fz-gated.fp",
}

/** Long-run classifier for the SAME two finding classes: stamp (and
 *  its co-occurring same-id fp) mismatches = F1; fp-only = F2. State /
 *  matchKey mismatches and harness failures are always NEW. */
function knownClass(r: SequenceResult): "F1" | "F2" | null {
  if (r.failure !== null || r.mismatches.length === 0) return null
  if (r.mismatches.some((m) => m.field === "state" || m.field === "matchKey")) return null
  return r.mismatches.some((m) => m.field === "stamp") ? "F1" : "F2"
}

function signature(r: SequenceResult): string {
  const parts = r.mismatches.map((m) => `${m.id}.${m.field}`)
  if (r.failure !== null) parts.push("failure")
  return [...new Set(parts)].sort().join(",")
}

beforeAll(() => {
  // Long deadlines keep the run deterministic under load: the model
  // acks promptly anyway (so the never-acked degrade never arms in a
  // healthy run), and the scheduled whole-tree reconcile would
  // otherwise inject healing segments on slow machines — the oracle
  // wants the LANE path to be correct without the healer.
  _setFirstAckDeadlineMs(300_000)
  _setReconcileIntervalMs(3_600_000)
})

afterAll(() => {
  _setFirstAckDeadlineMs(undefined)
  _setReconcileIntervalMs(undefined)
  isolate()
  _resetCellStorage()
})

describe("convergence fuzzing — incremental merge ≡ cold render", () => {
  it(
    `${BUDGET} random walks × ${LEN} actions from seed ${SEED0} converge`,
    async () => {
      const findings: string[] = []
      const tally = { ok: 0, F1: 0, F2: 0 }
      for (let i = 0; i < BUDGET; i++) {
        const seed = SEED0 + i
        const actions = generateSequence(seed, LEN, fixture)
        const r = await runSequence(fixture, seed, actions, isolate)
        const failed = r.mismatches.length > 0 || r.failure !== null

        if (CI_MODE && XFAIL[seed] !== undefined) {
          if (!failed) {
            findings.push(
              `seed ${seed}: expected the known finding (${XFAIL[seed]}) but the run PASSED — ` +
                `if the fix landed, delete this XFAIL entry and update the design note.`,
            )
          } else if (signature(r) !== XFAIL[seed]) {
            findings.push(
              `seed ${seed}: known-finding signature moved — expected ${XFAIL[seed]}, ` +
                `got ${signature(r)}\n${formatResult(r)}`,
            )
          }
          continue
        }
        if (!failed) {
          tally.ok++
          continue
        }
        const klass = CI_MODE ? null : knownClass(r)
        if (klass !== null) {
          tally[klass]++
          console.log(`seed ${seed}: known ${klass} (${signature(r)})`)
          continue
        }
        const shrunk = await shrinkSequence(fixture, seed, actions, isolate)
        findings.push(
          `${formatResult(shrunk.result)}\n(shrunk ${actions.length} → ` +
            `${shrunk.actions.length} actions in ${shrunk.runs} runs)`,
        )
      }
      if (!CI_MODE) {
        console.log(
          `fuzz summary: ${tally.ok} clean, ${tally.F1} × F1 (missed-update window), ` +
            `${tally.F2} × F2 (parked fp retag), ${findings.length} NEW`,
        )
      }
      expect(findings, `\n${findings.join("\n\n")}\n`).toEqual([])
    },
    TIMEOUT_MS,
  )
})
