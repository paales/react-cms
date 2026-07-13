"use server"

import { counter } from "./counter-state.ts"

/** Reducer-form increment — on the SQLite adapter this runs as the
 *  store-level CAS, so concurrent bumps from BOTH processes compose. */
export async function bumpCounter(): Promise<void> {
  await counter.update((n) => n + 1)
}
