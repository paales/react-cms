import React, { type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, it } from "vitest"
import {
  PartialsClient,
  getCachedPartialIds,
  registerClientPartial,
  _applyFpUpdates,
} from "../partial-client.tsx"
import { PartialErrorBoundary } from "../partial-error-boundary.tsx"

/**
 * Deterministic reproduction of the search-result-ordering bug at the
 * client-merge layer — no network, no timing, no entry.browser guard.
 *
 * The framework caches a rendered partial under (id, matchKey) and
 * advertises a SET of fingerprints for that slot in `?cached=`. The fp
 * is a pure hash of the spec's INPUTS (id, matchKey, varyKey, props,
 * descendant-fold) — NOT its content — so two distinct queries against
 * a stable (id, matchKey) produce two distinct fps that share one cache
 * slot. If the advertised fp-set and the slot's node ever desync, a
 * server fp-skip (placeholder) restores the WRONG node.
 *
 * These tests drive the public client surface — `PartialsClient`,
 * `getCachedPartialIds`, `_applyFpUpdates` — through the exact commit
 * interleaving that a rapid type→backspace produces, and assert the
 * restored content matches the fp the server actually matched.
 */

// ─── Server-shaped node builders ────────────────────────────────────
//
// Mirror what `partial.tsx` emits. A fresh partial with no fallback is
// a keyed `<PartialErrorBoundary>` carrying id / fingerprint / matchKey;
// an fp-skip is a bare `<i data-partial …>` placeholder.

function fresh(id: string, mk: string, fp: string, q: string): ReactNode {
  return (
    <PartialErrorBoundary key={id} partialId={id} partialFingerprint={fp} partialMatchKey={mk}>
      <div data-testid={id} data-q={q} data-fp={fp} />
    </PartialErrorBoundary>
  )
}

function placeholder(id: string, mk: string): ReactNode {
  return <i key={`${id}|${mk}`} hidden data-partial data-partial-id={id} data-partial-match={mk} />
}

/** Render a tree through PartialsClient and return the HTML string. */
function commit(body: ReactNode): string {
  return renderToStaticMarkup(
    <PartialsClient>
      <main>{body}</main>
    </PartialsClient>,
  )
}

/**
 * Model the server's fp-skip decision: given what the client currently
 * advertises (`getCachedPartialIds()`), the server emits a placeholder
 * iff it computed an fp the client already has cached — otherwise it
 * renders fresh. This is exactly the gate in `partial.tsx`
 * (`fingerprintMatches`).
 */
function serverEmit(id: string, mk: string, fp: string, q: string): ReactNode {
  const advertised = new Set(getCachedPartialIds())
  const skip = advertised.has(`${id}:${mk}:${fp}`)
  return skip ? placeholder(id, mk) : fresh(id, mk, fp, q)
}

function dataQ(html: string): string | null {
  return html.match(/data-q="([^"]*)"/)?.[1] ?? null
}

// Distinct fps per query (the real fp folds varyKey, so each query gets
// its own). Cold vs warm differ by the descendant-fold term.
const fp = {
  poCold: "fp_po_cold",
  poWarm: "fp_po_warm",
  pokemCold: "fp_pokem_cold",
  pokemWarm: "fp_pokem_warm",
}

const ID = "stage-2"
const MK = "" // vary+cell stage: constant matchKey, one slot for all queries

beforeEach(() => {
  // Reset the module-level client maps via the public API: a streaming
  // render with no partials prunes every prior (id, matchKey) entry.
  commit(null)
})

describe("fp-set / slot desync on a stable (id, matchKey)", () => {
  it("a late out-of-order warm-fp trailer must not advertise a superseded query", () => {
    // 1. Full load: stage renders `po` fresh (cold fp).
    commit(serverEmit(ID, MK, fp.poCold, "po"))
    // Its warm-fp trailer lands in-order (cold→warm for the SAME node).
    _applyFpUpdates({ [ID]: { from: fp.poCold, to: fp.poWarm } })

    // 2. Refetch `pokem` — not advertised, so the server renders fresh.
    //    The slot now holds the `pokem` node.
    commit(serverEmit(ID, MK, fp.pokemCold, "pokem"))
    _applyFpUpdates({ [ID]: { from: fp.pokemCold, to: fp.pokemWarm } })

    // 3. The earlier `po` fire's warm trailer arrives LATE (out of
    //    order) — its response drained after `pokem` already committed.
    _applyFpUpdates({ [ID]: { from: fp.poCold, to: fp.poWarm } })

    // INVARIANT: the client must only advertise fps it can correctly
    // restore. The slot holds `pokem`, so it must NOT advertise any
    // `po` fp — otherwise the server fp-skips a `po` query and the
    // client restores the stale `pokem` node.
    const advertised = getCachedPartialIds()
    expect(
      advertised,
      "client advertises a superseded-query fp it can no longer restore",
    ).not.toContain(`${ID}:${MK}:${fp.poWarm}`)
  })

  it("re-typing a superseded query restores its own content, not the slot's last write", () => {
    // Full sequence of a rapid type→backspace where the final query
    // equals an earlier one (po → pokem → po). Each step models the
    // server round-trip honestly via `serverEmit`.

    // po (fresh) + its in-order warm trailer.
    commit(serverEmit(ID, MK, fp.poCold, "po"))
    _applyFpUpdates({ [ID]: { from: fp.poCold, to: fp.poWarm } })

    // pokem (fresh) + its warm trailer.
    commit(serverEmit(ID, MK, fp.pokemCold, "pokem"))
    _applyFpUpdates({ [ID]: { from: fp.pokemCold, to: fp.pokemWarm } })

    // The earlier po fire's warm trailer lands late.
    _applyFpUpdates({ [ID]: { from: fp.poCold, to: fp.poWarm } })

    // Final keystroke: back to `po`. The server consults what the
    // client advertises and decides skip-vs-fresh. Whatever it decides,
    // the committed content MUST read `po`.
    const finalHtml = commit(serverEmit(ID, MK, fp.poWarm, "po"))
    expect(
      dataQ(finalHtml),
      "final `po` keystroke committed stale content from the slot's last write",
    ).toBe("po")
  })

  it("aliases the warm fp onto the slot holding the cold fp, not the latest matchKey", () => {
    // Two variants of one id coexist (e.g. /pokemon/1 parked while
    // /pokemon/2 is active). A trailer reporting variant A's cold→warm
    // drift must alias onto A's slot — the one holding `from` — even
    // though variant B was registered more recently. The old "attach to
    // the latest matchKey" heuristic would have mis-pinned A's warm fp
    // onto B.
    const id = "multi-variant"
    registerClientPartial(id, "mkA", "a_cold")
    registerClientPartial(id, "mkB", "b_cold") // B is the latest

    _applyFpUpdates({ [id]: { from: "a_cold", to: "a_warm" } })

    const advertised = getCachedPartialIds()
    expect(advertised).toContain(`${id}:mkA:a_warm`)
    expect(advertised, "warm fp leaked onto the latest matchKey").not.toContain(`${id}:mkB:a_warm`)
  })

  it("an in-order warm-fp trailer still aliases (cold→warm fp-skip preserved)", () => {
    // The fix must not break the legitimate cold→warm case the trailer
    // exists for: a single node whose fp drifts once descendants
    // register. The client should advertise BOTH fps so the next visit
    // fp-skips whichever the server computes.
    commit(serverEmit(ID, MK, fp.poCold, "po"))
    _applyFpUpdates({ [ID]: { from: fp.poCold, to: fp.poWarm } })

    const advertised = getCachedPartialIds()
    expect(advertised).toContain(`${ID}:${MK}:${fp.poCold}`)
    expect(advertised).toContain(`${ID}:${MK}:${fp.poWarm}`)
  })
})
