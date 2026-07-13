/**
 * Embed actions — named server functions a producer exposes to
 * INTERACTIVE embeds of its pages (`docs/reference/remote-frame.md`
 * § The Interactive grant).
 *
 * The vocabulary's `Button` names one of these by its bare name; the
 * host's interaction bridge namespaces the ref to the remote ORIGIN
 * structurally (it only ever posts to the origin the placement was
 * spliced from) and invokes it via `POST /__remote/actions/invoke`
 * (`createRemoteHandler`). No Flight action id crosses the boundary —
 * below the Client tier the tier rewriter strips module/action refs,
 * so the invocable surface is exactly this explicit, name-keyed
 * registry: nothing is reachable that the producer didn't register.
 *
 * Authorization is the capability: the endpoint decodes the
 * placement's capability header into `getCapability()` scope before
 * the handler runs, and an action's optional `guard` receives the bag
 * directly — `false` refuses the invoke (403) before the handler
 * runs. Cell writes inside the handler additionally pass their cells'
 * own `writeGuard`s (the write choke point is on the cell, not the
 * transport). The handler runs inside an invalidation transaction, so
 * its cell writes commit as one bump batch — a throw discards them.
 */

import type { Capability } from "./capability.ts"

export interface EmbedActionOptions {
  /** Capability authorization — `false` refuses the invoke with 403
   *  before the handler runs. Absent ⇒ any capability (including the
   *  empty bag) may invoke; guard cells with `writeGuard` as usual. */
  guard?: (capability: Capability, payload: unknown) => boolean
}

interface EmbedActionEntry {
  handler: (payload: unknown) => Promise<void> | void
  guard?: EmbedActionOptions["guard"]
}

const embedActions = new Map<string, EmbedActionEntry>()

/** Action names must survive an audited attribute round-trip and read
 *  unambiguously in logs — the selector-label character class. */
const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i

/**
 * Register a named action interactive embeds of this app may invoke.
 * Module-init side effect (HMR overwrites in place), like a cell:
 *
 *     export const placeBid = embedAction("place-bid", async (payload) => {
 *       await lotBidCell.update((v) => v + BID_STEP)
 *     }, { guard: (cap) => cap.bidder === true })
 *
 * The handler owns payload validation — the wire payload is opaque
 * JSON the producer must treat as untrusted input.
 */
export function embedAction(
  name: string,
  handler: (payload: unknown) => Promise<void> | void,
  options?: EmbedActionOptions,
): void {
  if (!NAME_RE.test(name)) {
    throw new Error(`embedAction: invalid action name ${JSON.stringify(name)}`)
  }
  embedActions.set(name, { handler, guard: options?.guard })
}

/** Endpoint-internal lookup. */
export function _getEmbedAction(name: string): EmbedActionEntry | undefined {
  return embedActions.get(name)
}

/** Test-only — reset between tests. */
export function _clearEmbedActions(): void {
  embedActions.clear()
}
