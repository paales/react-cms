"use client"

/**
 * The chunk's network light — a REAL wire-activity indicator. A chunk
 * that receives fresh bytes commits a new element tree, so this
 * component mounts again; the mount effect is therefore exactly "an
 * update arrived over the wire" (an fp-skip serves from cache, commits
 * nothing, and stays dark). Flash frequency picks the color — the
 * per-chunk arrival history survives remounts at module scope:
 * green (occasional) → blue (busy) → white (hot).
 */

import { useEffect, useState } from "react"

const WINDOW_MS = 10_000
const history = new Map<string, number[]>()

function recordArrival(ck: string): number {
  const now = performance.now()
  const arr = history.get(ck) ?? []
  const recent = arr.filter((t) => now - t < WINDOW_MS)
  recent.push(now)
  history.set(ck, recent)
  return recent.length
}

export function ActivityLight({ ck }: { ck: string }) {
  const [tone, setTone] = useState<"idle" | "green" | "blue" | "white">("idle")
  useEffect(() => {
    const n = recordArrival(ck)
    setTone(n >= 5 ? "white" : n >= 2 ? "blue" : "green")
  }, [ck])
  return <span className={`chunk__light chunk__light--${tone}`} data-testid={`light-${ck}`} aria-hidden />
}
