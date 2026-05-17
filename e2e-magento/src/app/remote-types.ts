/**
 * Capability schemas this remote app exposes.
 *
 * The file is served verbatim at `/__remote/types.d.ts` (see
 * `entry.rsc.tsx`) so the host app's `parton add` CLI can copy it
 * into its repo and bind typed `remote<TypeName>(...)` wrappers.
 *
 * The names referenced here must match the `capabilityType: "..."`
 * field on each `parton()` spec — the manifest endpoint cross-
 * references them at generation time.
 */

/** Payment summary scope — what the host gives the remote so it
 *  can render cart totals without re-querying. */
export type PaymentCap = {
  cart_id: string
  currency: string
  total: number
}
