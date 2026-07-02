/**
 * Order-independent canonical stringify for hash inputs.
 *
 * The output is the canonical form fed to `hash()` for cache keys,
 * fingerprints, and registry variant keys. Two semantically-equivalent
 * inputs MUST produce byte-identical output; two semantically-different
 * inputs MUST produce different output (within the value space the fold
 * results actually use). Hash collision properties are the hash
 * function's job — this layer is responsible for canonicalization
 * only.
 *
 * What's handled beyond plain JSON:
 *
 * | Input                  | Encoding                              |
 * |------------------------|---------------------------------------|
 * | `undefined`            | `<undef>`                             |
 * | `NaN`                  | `<nan>`                               |
 * | `+Infinity`            | `<+inf>`                              |
 * | `-Infinity`            | `<-inf>`                              |
 * | `-0`                   | `-0` (distinct from `0`)              |
 * | `BigInt`               | `<bigint:N>`                          |
 * | `Date`                 | `<date:ms>`                           |
 * | `Set`                  | `<set:[…sorted serialized entries…]>` |
 * | `Map`                  | `<map:[…sorted by serialized key…]>`  |
 * | circular reference     | `<circular>`                          |
 * | `function` / `symbol`  | `<unsupported>` (do not pass these)   |
 *
 * Strings, finite numbers, booleans, `null`, plain arrays, and plain
 * objects round-trip through `JSON.stringify` semantics, with object
 * keys sorted at every level.
 *
 * This canonicalization is a HASH-INPUT format, not a serializer —
 * the output is not meant to be parsed back. Sentinel tokens use `<…>`
 * which JSON.stringify never emits, keeping the format unambiguous.
 */

export function stableStringify(value: unknown): string {
  return _walk(value, new WeakSet<object>())
}

function _walk(value: unknown, seen: WeakSet<object>): string {
  if (value === undefined) return "<undef>"
  if (value === null) return "null"

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false"
    case "string":
      return JSON.stringify(value)
    case "number":
      if (Number.isNaN(value)) return "<nan>"
      if (value === Infinity) return "<+inf>"
      if (value === -Infinity) return "<-inf>"
      if (Object.is(value, -0)) return "-0"
      return String(value)
    case "bigint":
      return `<bigint:${value.toString()}>`
    case "function":
    case "symbol":
      return "<unsupported>"
  }

  // From here on, value is a non-null object.
  const obj = value as object
  if (seen.has(obj)) return "<circular>"
  seen.add(obj)

  if (Array.isArray(value)) {
    return "[" + value.map((v) => _walk(v, seen)).join(",") + "]"
  }
  if (value instanceof Date) {
    return `<date:${value.getTime()}>`
  }
  if (value instanceof Set) {
    const items = Array.from(value as Set<unknown>, (v) => _walk(v, seen)).sort()
    return "<set:[" + items.join(",") + "]>"
  }
  if (value instanceof Map) {
    const entries = Array.from((value as Map<unknown, unknown>).entries(), ([k, v]) => {
      return [_walk(k, seen), _walk(v, seen)] as const
    })
    entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    return "<map:[" + entries.map(([k, v]) => `${k}:${v}`).join(",") + "]>"
  }

  const keys = Object.keys(obj as Record<string, unknown>).sort()
  const parts = keys.map(
    (k) => `${JSON.stringify(k)}:${_walk((obj as Record<string, unknown>)[k], seen)}`,
  )
  return "{" + parts.join(",") + "}"
}
