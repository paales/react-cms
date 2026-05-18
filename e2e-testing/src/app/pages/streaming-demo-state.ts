/**
 * Per-scope server state for the /streaming-demo page. Shared between
 * the page render (`streaming-demo.tsx`, server) and the action body
 * (`streaming-demo-actions.ts`, "use server" — the actions are
 * client-callable RPCs but their bodies run server-side).
 *
 * Why a dedicated module: the "use server" file's exports all become
 * server-action RPCs on the client side. State functions live here
 * so they stay plain server-side imports rather than being mis-cast
 * as RPCs.
 */

import { refreshSelector } from "@parton/framework"

export interface DemoScopeState {
  bumps: number
  tick: number
  tickerScheduled: boolean
}

const scopes = new Map<string, DemoScopeState>()

export function getScopeState(scope: string): DemoScopeState {
  let s = scopes.get(scope)
  if (!s) {
    s = { bumps: 0, tick: 0, tickerScheduled: false }
    scopes.set(scope, s)
  }
  return s
}

/** Schedule the next clock tick for this scope, if one isn't already
 *  in flight. Concurrent connections de-dupe through `tickerScheduled`. */
export function ensureTicker(scope: string): void {
  const s = getScopeState(scope)
  if (s.tickerScheduled) return
  s.tickerScheduled = true
  setTimeout(() => {
    s.tickerScheduled = false
    s.tick++
    refreshSelector("streaming-demo-tick")
  }, 1000)
}

export function bumpDemoCounter(scope: string): number {
  const s = getScopeState(scope)
  s.bumps++
  return s.bumps
}

export function readDemoBumps(scope: string): number {
  return getScopeState(scope).bumps
}

export function clearStreamingDemoState(scope?: string | "all"): void {
  if (!scope || scope === "all") {
    scopes.clear()
    return
  }
  scopes.delete(scope)
}
