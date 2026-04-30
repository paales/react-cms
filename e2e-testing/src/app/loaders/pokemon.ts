/**
 * Example entity loader — `getPokemon(ref)`.
 *
 * Demonstrates the `Reference<T>` + loader pattern: a block declares
 * a typed reference via `getReference("featured", "pokemon")` and
 * the loader resolves it to a concrete Pokemon entity. The loader
 * owns:
 *   - Fetching from the underlying data source (PokeAPI via graphql).
 *   - Falling back to `getClosest<Pokemon>("pokemon")` when the
 *     reference has no explicit value.
 *   - Request-scoped dedup (skipped here — trivial for this demo;
 *     real loaders should memoize concurrent calls for the same id).
 *
 * Lives in userspace (`src/app/loaders/`) intentionally. The
 * framework ships `getReference` + `getClosest`; each app wires its
 * own entity types. Commerce apps add `getProduct`, CMS-heavy apps
 * add `getPage`, etc.
 */
import type { Reference } from "@react-cms/framework/framework/cms-runtime.ts"
import { client } from "../data.ts"
import { graphql } from "../pokeapi-graphql.ts"

export interface Pokemon {
  readonly id: number
  readonly name: string
  readonly spriteUrl: string | null
}

const PokemonByIdQuery = graphql(`
  query PokemonById($id: Int!) {
    pokemon_v2_pokemon(where: { id: { _eq: $id } }, limit: 1) {
      id
      name
      pokemon_v2_pokemonsprites {
        sprites
      }
    }
  }
`)

type SpriteJson = {
  front_default?: string | null
  other?: {
    "official-artwork"?: { front_default?: string | null } | null
  } | null
} | null

function extractSprite(sprites: unknown): string | null {
  const s = sprites as SpriteJson
  return s?.other?.["official-artwork"]?.front_default ?? s?.front_default ?? null
}

export async function getPokemon(ref: Reference<"pokemon">): Promise<Pokemon | null> {
  if (ref.value != null) {
    const id = Number(ref.value)
    if (!Number.isFinite(id)) return null
    const data = await client.request(PokemonByIdQuery, { id })
    const p = data.pokemon_v2_pokemon[0]
    if (!p) return null
    return {
      id: p.id,
      name: p.name,
      spriteUrl: extractSprite(p.pokemon_v2_pokemonsprites[0]?.sprites),
    }
  }
  // ancestor-`closest` fallback is deferred; the constructor API
  // currently passes per-instance data via render props rather than
  // through an ALS-backed provides chain. Loaders that need it should
  // accept the entity as a prop until the successor design lands.
  return null
}
