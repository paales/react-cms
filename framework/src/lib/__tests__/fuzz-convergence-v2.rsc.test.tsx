/**
 * Convergence fuzzing v2 — seeded random walks that drive the REAL
 * client merge layer (`cacheFromStreamingChildren`, `substituteNested`
 * via `renderTemplate`, `_commitPartonLane` + the settlement re-walks,
 * `pruneToLive`, `_applyFpUpdates`, the advertise-honesty gate) against
 * real server renders and real Flight encode → decode round trips.
 * Harness: `framework/src/test/fuzz-harness-v2.ts`; fixture:
 * `fuzz-fixture-v2.tsx`; design note:
 * `docs/notes/convergence-fuzzing.md` (§v2 + findings ledger).
 *
 * Two oracles per trial: convergence (client template render ≡ cold
 * render) and advertise honesty (every advertised fp restorable; a
 * render presented the full manifest never ghost/stale-confirms; the
 * connection flavor's warm candidate stays among the advertised fps
 * for every current-content leaf).
 *
 * CI runs a fixed, deterministic budget: 25 trials × 15 actions from
 * seed 1 — every trial must converge; any failure shrinks to a
 * locally-minimal repro in the assertion message.
 *
 * Long local runs:
 *
 *   FUZZ_V2_BUDGET=500 FUZZ_V2_LEN=20 yarn test:rsc fuzz-convergence-v2
 *
 * Knobs: FUZZ_V2_BUDGET (trials), FUZZ_V2_LEN (actions per trial),
 * FUZZ_V2_SEED (first seed; trial i uses seed FUZZ_V2_SEED + i).
 */

import { afterAll, describe, expect, it } from "vitest"
import { _resetCellStorage } from "../../runtime/cell-storage.ts"
import {
  generateSequenceV2,
  runSequenceV2,
  shrinkSequenceV2,
  formatResultV2,
  type FuzzActionV2,
} from "../../test/fuzz-harness-v2.ts"
import { renderWithRequest } from "../../test/rsc-server.ts"
import { fixtureV2, isolateV2 } from "./fuzz-fixture-v2.tsx"

// ─── Budget ──────────────────────────────────────────────────────────

const BUDGET = Number(process.env.FUZZ_V2_BUDGET ?? 25)
const LEN = Number(process.env.FUZZ_V2_LEN ?? 15)
const SEED0 = Number(process.env.FUZZ_V2_SEED ?? 1)
const TIMEOUT_MS = Math.max(180_000, BUDGET * 2_000)

afterAll(() => {
  isolateV2()
  _resetCellStorage()
})

// ─── The wire-form pin ───────────────────────────────────────────────
//
// The fixture's async bodies must cross the wire as OUTLINED PROMISE
// rows — the `$@` geometry F8 lives in (pinned the same way
// `async-parent-nested-heal.rsc.test.tsx` pins it). If this moves, the
// merge layer's thenable arm is what to re-verify, and the v2 fuzzer's
// held-delivery dimension loses its target.
describe("v2 fixture geometry", () => {
  it("async parton bodies serialize as outlined $@ promise rows", async () => {
    isolateV2()
    const { stream } = await renderWithRequest("http://localhost/alpha?q=x", fixtureV2.page())
    const text = await new Response(stream).text()
    expect(text).toMatch(/"children":"\$@[0-9a-f]+"/)
    // The nested addressable child rides INSIDE the async parent's
    // promise row on a cold render.
    expect(text).toContain('"partialId":"fz-async-inner"')
  })
})

// ─── The budgeted walk ───────────────────────────────────────────────

describe("convergence fuzzing v2 — the real merge layer", () => {
  it(
    `${BUDGET} random walks × ${LEN} actions from seed ${SEED0} converge`,
    async () => {
      const findings: string[] = []
      let clean = 0
      for (let i = 0; i < BUDGET; i++) {
        const seed = SEED0 + i
        const actions = generateSequenceV2(seed, LEN, fixtureV2)
        const r = await runSequenceV2(fixtureV2, seed, actions, isolateV2)
        if (r.mismatches.length === 0 && r.failure === null) {
          clean++
          continue
        }
        const shrunk = await shrinkSequenceV2(fixtureV2, seed, actions, isolateV2)
        findings.push(
          `${formatResultV2(shrunk.result)}\n(shrunk ${actions.length} → ` +
            `${shrunk.actions.length} actions in ${shrunk.runs} runs)`,
        )
      }
      if (BUDGET > 25) {
        console.log(`fuzz v2 summary: ${clean} clean, ${findings.length} findings`)
      }
      expect(findings, `\n${findings.join("\n\n")}\n`).toEqual([])
    },
    TIMEOUT_MS,
  )
})

// ─── Pinned regression seeds ─────────────────────────────────────────
//
// Deterministic repros distilled from the v2 findings ledger (design
// note §v2). Each ran RED against the bug it pins — either a local
// revert of a pre-v2 fix (the two regression demonstrations) or the
// pre-fix state of a bug v2 itself found — and is an ordinary clean
// case on HEAD.
describe("v2 pinned regression seeds", () => {
  const cases: Array<{ name: string; seed: number; actions: FuzzActionV2[] }> = [
    {
      // Red with `unwrapLazy`'s thenable arm blinded (the 34e1b9a
      // revert): the child's own lane fills its slot, the async
      // parent's next lane fp-skips the child to a hole INSIDE the
      // outlined promise row, and blind walks never heal it.
      name: "F8 — child lane then async-parent lane (hole behind the promise row)",
      seed: 90001,
      actions: [
        { kind: "write", cell: 1, value: 1, delivery: { hold: 0, order: "settle-first" } },
        { kind: "write", cell: 0, value: 2, delivery: { hold: 0, order: "settle-first" } },
        { kind: "settle" },
      ],
    },
    {
      // Red with cacheStore's identity check removed (the e728964
      // revert): the settlement re-walk's re-store wipes the variant's
      // fp-set including the cold→warm alias the trailer applied
      // between the walks — the warm-parity oracle flags every held
      // async leaf.
      name: "e728964 — held async-leaf delivery, trailer between the walks",
      seed: 90002,
      actions: [
        { kind: "write", cell: 1, value: 1, delivery: { hold: 2, order: "trailer-first" } },
        { kind: "settle" },
      ],
    },
    {
      // F9 — a superseded payload's late settlement re-walk must not
      // clobber a newer commit's slot (the out-of-order store guard).
      // Shrunk from seed 11 of the first v2 runs.
      name: "F9 — held write lanes' re-walks vs a covering navigation",
      seed: 90011,
      actions: [
        { kind: "write", cell: 1, value: 2, delivery: { hold: 3, order: "trailer-first" } },
        {
          kind: "write",
          cell: 0,
          value: 3,
          delivery: { hold: 3, order: "trailer-first", reverse: true },
        },
        {
          kind: "navigate",
          url: "/beta",
          delivery: { hold: 0, order: "settle-first", reverse: true },
        },
        { kind: "settle" },
      ],
    },
    {
      // F10 — a cold→warm alias whose anchor registers only at the
      // settlement re-walk (trailer applied between the walks) must
      // survive to that registration (the pending-alias ledger).
      // Shrunk from seed 17 of the first v2 runs.
      name: "F10 — held navigation, trailer before the re-walk's registrations",
      seed: 90017,
      actions: [
        { kind: "write", cell: 0, value: 5, delivery: { hold: 0, order: "settle-first" } },
        { kind: "navigate", url: "/beta", delivery: { hold: 1, order: "trailer-first" } },
        { kind: "settle" },
      ],
    },
    {
      // F11 — a pending-blocked frontier harvest defers the prune
      // (nested variants behind a mid-stream ancestor commit must not
      // be pruned out from under the displayed tree). Shrunk from
      // seed 72 of the v2 long runs.
      name: "F11 — prune while an ancestor's lane content is mid-stream",
      seed: 90072,
      actions: [
        { kind: "navigate", url: "/alpha", delivery: { hold: 0, order: "trailer-first" } },
        { kind: "navigate", url: "/alpha", delivery: { hold: 1, order: "trailer-first" } },
        { kind: "write", cell: 0, value: 7, delivery: { hold: 3, order: "trailer-first" } },
        { kind: "settle" },
      ],
    },
    {
      // F12 — a torn progressive delivery evicts what it owns and
      // de-advertises every cached wrapper whose composition
      // referenced it (ghost-confirm + shadowing + unbacked-hole
      // discipline). Shrunk from seed 305 of the v2 long runs.
      name: "F12 — torn write lanes, then a confirming navigation",
      seed: 90305,
      actions: [
        {
          kind: "write",
          cell: 1,
          value: 2,
          delivery: { hold: 3, order: "trailer-first", reverse: true },
        },
        {
          kind: "write",
          cell: 0,
          value: 3,
          delivery: { hold: 0, order: "settle-first", reverse: true },
        },
        {
          kind: "navigate",
          url: "/alpha?q=x",
          delivery: { hold: 1, order: "settle-first", reverse: true },
        },
        { kind: "settle" },
      ],
    },
  ]
  for (const c of cases) {
    it(c.name, async () => {
      const r = await runSequenceV2(fixtureV2, c.seed, c.actions, isolateV2)
      expect(r.failure, r.failure ?? "").toBeNull()
      expect(r.mismatches, `\n${formatResultV2(r)}\n`).toEqual([])
    })
  }

  // Pinned regression (seed 77, F13): the fp-trailer flush recompute
  // (`computeWarmFps`) healed a snapshot whose ANCESTOR was culled on
  // the response — the body never ran, yet the descendant's fp was
  // retagged with the new request state, so the parked copy advertised
  // a state it did not carry and the next flip-in CONFIRMED stale
  // content. Fixed by the culled-ancestor sibling of the F2 gate
  // discipline in computeWarmFps.
  it("seed 77 — a culled-ancestor descendant gets no heal from the flush recompute", async () => {
    const actions: FuzzActionV2[] = [
      { kind: "flip", ids: ["fz-wrap"], delivery: { hold: 0, order: "trailer-first" } },
      {
        kind: "navigate",
        url: "/alpha",
        delivery: { hold: 0, order: "trailer-first", reverse: true },
      },
      {
        kind: "flip",
        ids: ["fz-wrap"],
        delivery: { hold: 0, order: "settle-first", reverse: true },
      },
      { kind: "settle" },
    ]
    const r = await runSequenceV2(fixtureV2, 77, actions, isolateV2)
    expect(r.mismatches, `\n${formatResultV2(r)}\n`).toEqual([])
  })
})
