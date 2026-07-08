/**
 * The culled-variant key grammar — REGISTRY-INTERNAL (partial-registry.ts).
 *
 * A cullable parton keeps TWO snapshot states per match variant in the
 * server registry: the content state (body ran; deps are its reads)
 * and the culled state (the gate short-circuited; deps are the gate's
 * reads). The culled state's registry variant key is the base key
 * plus this suffix, so both states store side by side and each folds
 * its own fingerprint. The suffix never crosses the wire: the client
 * has no culled cache variant — a culled parton's skeleton is a
 * client-rendered element carried inline by its `<CullPair>`.
 *
 * Base matchKeys are 16-char hex hashes (or the constant root key) —
 * `~` cannot occur in one, so the suffix is unambiguous.
 */
export const CULLED_KEY_SUFFIX = "~cull"

/** The culled-state twin of a base matchKey / variant key. */
export function culledKey(base: string): string {
  return `${base}${CULLED_KEY_SUFFIX}`
}

export function isCulledKey(key: string): boolean {
  return key.endsWith(CULLED_KEY_SUFFIX)
}

/** Strip the culled suffix — identity for base keys. */
export function baseKey(key: string): string {
  return isCulledKey(key) ? key.slice(0, -CULLED_KEY_SUFFIX.length) : key
}
