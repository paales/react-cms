"use server"

/**
 * Server actions for the /streaming-demo page. The button components
 * in `streaming-demo-buttons.tsx` (a "use client" file) import these
 * via the Flight server-reference channel; the function bodies run
 * server-side.
 */

import { getScope, getServerNavigation } from "@parton/framework"
import { bumpDemoCounter as bumpState } from "./streaming-demo-state.ts"

/**
 * Bump the demo counter in scope state, then call
 * `getServerNavigation().reload({selector})` so the bump-counter
 * partial's fingerprint shifts and the action's response render
 * emits fresh content.
 */
export async function bumpDemoCounter() {
  bumpState(getScope())
  getServerNavigation().reload({ selector: "bump-counter" })
}

/**
 * Push a `?seq=N` value into the window URL via the server-side
 * navigate primitive. Each call advances N so the URL bar changes
 * visibly on every click.
 */
let seq = 0
export async function pushSeq() {
  seq++
  getServerNavigation().navigate(`?seq=${seq}`)
}
