/**
 * 64-bit pure-JS hash for cache keys, fingerprints, and registry
 * variant keys.
 *
 * Implementation: two independent 32-bit mixers (djb2 + FNV-1a),
 * concatenated into 16 hex chars. Pure JS keeps the module graph
 * portable across every runtime React Server Components might land
 * on (Node, Bun, browsers, edge workers) — `node:crypto` trips
 * Vite's browser-externalization warning whenever the hash module
 * reaches the client bundle, even indirectly.
 *
 * Collision space: ~50% probability at 2^32 distinct values, which
 * is comfortable for the cache + registry sizes we expect (hundreds
 * to low thousands of entries). If a stronger hash is needed later,
 * swap to a pure-JS SHA-256 behind the same signature.
 */

const FNV_OFFSET_BASIS_32 = 0x811c9dc5
const FNV_PRIME_32 = 0x01000193

export function hash(input: string): string {
  // Mixer 1: djb2 with xor.
  let h1 = 5381 >>> 0
  // Mixer 2: FNV-1a 32-bit.
  let h2 = FNV_OFFSET_BASIS_32 >>> 0
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i)
    h1 = ((h1 << 5) + h1) >>> 0
    h1 = (h1 ^ c) >>> 0
    h2 = (h2 ^ c) >>> 0
    h2 = Math.imul(h2, FNV_PRIME_32) >>> 0
  }
  // MurmurHash3 fmix32 finalizer on each lane — spreads
  // single-character changes across all 64 output bits so
  // `hash("…:a")` and `hash("…:b")` differ by ~half their bits.
  return fmix32(h1).toString(16).padStart(8, "0") + fmix32(h2).toString(16).padStart(8, "0")
}

function fmix32(h: number): number {
  h = (h ^ (h >>> 16)) >>> 0
  h = Math.imul(h, 0x85ebca6b) >>> 0
  h = (h ^ (h >>> 13)) >>> 0
  h = Math.imul(h, 0xc2b2ae35) >>> 0
  h = (h ^ (h >>> 16)) >>> 0
  return h
}
