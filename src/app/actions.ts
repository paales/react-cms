"use server"

/**
 * Demo server actions for partial invalidation.
 *
 * Each action returns `{ invalidate: { selector: "..." } }`. The
 * framework parses the selector, populates `?partials=` + `?tags=`
 * on the refetch URL, and renders only the matching Partials.
 * PartialsClient on the client merges them with its cache.
 */

export async function refreshHero() {
  return { invalidate: { selector: "#hero" } }
}

export async function refreshStats() {
  return { invalidate: { selector: "#stats" } }
}

export async function refreshAll() {
  return { invalidate: { selector: "#hero #stats #species" } }
}
