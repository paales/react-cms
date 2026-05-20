"use server"

/**
 * Server actions for the /streaming-demo page. The bump button used
 * to live here as a server action; with the cell migration, bump
 * mutation goes through the framework's `__cellWrite` action (bound
 * to the `demo.bumps` cell). What remains is `pushSeq` — an example
 * of `getServerNavigation().navigate(...)` for server-pushed URL
 * updates, unrelated to cells.
 */

import { getServerNavigation } from "@parton/framework"

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
