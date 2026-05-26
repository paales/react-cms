/**
 * Pokemon detail cells — `Hero` / `Stats` / `Species` move off inline
 * `client.request` into gqlCell. Per-id partitions are placement-
 * bound via `.with({id})` from the parent. Storage caches per id
 * (Pokemon data is effectively immutable), so repeated nav to the
 * same id skips the upstream call.
 */

import { gqlCell } from "@parton/framework"
import { client } from "../data.ts"
import { graphql } from "../pokeapi-graphql.ts"

const PokemonHeroQuery = graphql(`
  query PokemonHero($id: Int!) {
    pokemon_v2_pokemon(where: { id: { _eq: $id } }, limit: 1) {
      id
      name
      height
      weight
      pokemon_v2_pokemonsprites {
        sprites
      }
      pokemon_v2_pokemontypes {
        slot
        pokemon_v2_type {
          name
        }
      }
    }
  }
`)

const PokemonStatsQuery = graphql(`
  query PokemonStats($id: Int!) {
    pokemon_v2_pokemon(where: { id: { _eq: $id } }, limit: 1) {
      pokemon_v2_pokemonstats {
        base_stat
        pokemon_v2_stat {
          name
        }
      }
    }
  }
`)

const PokemonSpeciesQuery = graphql(`
  query PokemonSpecies($id: Int!) {
    pokemon_v2_pokemon(where: { id: { _eq: $id } }, limit: 1) {
      pokemon_v2_pokemonspecy {
        name
        base_happiness
        capture_rate
        pokemon_v2_generation {
          name
        }
        pokemon_v2_pokemonspeciesflavortexts(
          where: { pokemon_v2_language: { name: { _eq: "en" } } }
          limit: 1
        ) {
          flavor_text
        }
      }
    }
  }
`)

export const pokemonHeroCell = gqlCell({
  id: "pokemon-hero",
  client,
  doc: PokemonHeroQuery,
})

export const pokemonStatsCell = gqlCell({
  id: "pokemon-stats",
  client,
  doc: PokemonStatsQuery,
})

export const pokemonSpeciesCell = gqlCell({
  id: "pokemon-species",
  client,
  doc: PokemonSpeciesQuery,
})
