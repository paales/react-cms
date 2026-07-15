/**
 * Dev-only code-version fingerprint term.
 *
 * Code identity is not otherwise part of a parton's fingerprint — the
 * fp folds request dimensions, invalidation timestamps, and descendant
 * deps, and an HMR edit moves none of them. Without this term, the
 * fps the client advertises (`?cached=` / the attach manifest) keep
 * matching after a server-code edit, the server honestly fp-skips,
 * and the browser keeps displaying the old code's output.
 *
 * The signal is explicit, not heuristic: the rsc environment's module
 * runner receives `vite:beforeUpdate` with typed updates whenever vite
 * invalidates modules in the rsc graph. Any `js-update` in that batch
 * IS the "server code changed" signal, so the version bumps and every
 * fp computed by the NEW module graph carries a new `|code=N` term —
 * every previously advertised fp honestly mismatches, so the silent
 * re-navigation `entry/browser.tsx` issues on `rsc:update` renders
 * fresh bodies and ships fresh bytes. The byte cache (`cache.tsx`)
 * keys entries on the fp too, so cached bytes miss as well.
 *
 * The version a render folds is its GRAPH's version, not the global
 * counter: `createRscHandler` / `createChannelServer` capture the
 * counter at entry evaluation (the graph's birth) and pin it into
 * every request scope they open (`_pinCodeVersion`). A held drive
 * whose graph an edit just orphaned therefore keeps emitting fps at
 * ITS version — never the new one — so it cannot retag the client's
 * stale bytes with current fps (the fp-trailer heal recomputes through
 * the same pinned term). Folding the global here instead would let the
 * old drive's post-bump trailer "heal" stale content to fresh fps, and
 * the fresh graph's render would then fp-skip forever.
 *
 * The counter lives on `globalThis` so it survives re-evaluation of
 * this module itself (a framework-file edit re-runs the rsc graph
 * including this file); a module-level counter would reset to 0 and
 * resurrect pre-edit fps.
 *
 * Prod is byte-identical to a world without this term: the fold is
 * DEV-gated, and `import.meta.hot` is absent from production builds so
 * the counter never bumps anyway. Test tiers see no term either —
 * vitest provides no `import.meta.hot`, so the counter stays 0 and the
 * term is the empty string.
 */

import { _pinnedCodeVersion } from "../runtime/context.ts"

declare global {
  var __partonCodeVersion: number | undefined
}

/** The process-wide code version — bumped on every rsc-graph js
 *  update. 0 in prod and tests (nothing ever bumps it there). */
export function currentCodeVersion(): number {
  return globalThis.__partonCodeVersion ?? 0
}

/**
 * The `|code=N` fp term for the active render's server-code version —
 * the version PINNED on the request scope (the serving graph's birth
 * version) when one is pinned, else the process-wide counter. Empty
 * until the first HMR bump (and always empty in prod / tests), so fps
 * are byte-identical to a world without this term until an edit lands.
 */
export function codeVersionKey(): string {
  if (!import.meta.env.DEV) return ""
  const n = _pinnedCodeVersion() ?? currentCodeVersion()
  return n > 0 ? `|code=${n}` : ""
}

if (import.meta.hot) {
  // `vite:beforeUpdate` — BEFORE the runner applies the update. The
  // ordering is load-bearing for the birth certificate: the rsc entry
  // self-accepts, so the runner RE-EVALUATES it while applying the
  // update (between beforeUpdate and afterUpdate) — and that fresh
  // evaluation's `currentCodeVersion()` capture must see the NEW
  // version, or the new graph pins one generation behind and the
  // born-stale session gate (`connection-session.ts`) would retire
  // every connection the fresh graph serves. Renders never read this
  // counter directly (they fold the scope's PINNED version), so
  // bumping before the module swap cannot mis-tag an old-graph render.
  import.meta.hot.on("vite:beforeUpdate", (payload: { updates?: { type?: string }[] }) => {
    if (!payload?.updates?.some((u) => u.type === "js-update")) return
    globalThis.__partonCodeVersion = (globalThis.__partonCodeVersion ?? 0) + 1
  })
}
