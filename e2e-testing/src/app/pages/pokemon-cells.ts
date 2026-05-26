/**
 * Pokemon cells — every PokeAPI read flows through a gqlCell.
 * Storage caches per args; effectively-immutable data so no TTL.
 *
 * `pokemonHero / Stats / Species` — placement-bound per id from
 * the detail page.
 *
 * `pokemonList` — placement-bound per page (limit/offset). One
 * cell instance, 10 partitions for the 10 list pages.
 *
 * `pokemonSearch` — placement-bound per (pattern, offset, limit).
 * Each search Stage binds different offsets.
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

// ─── List + search cells (shared with pokemon.tsx) ─────────────────────

export const PokemonListFields = graphql(`
  fragment PokemonListFields on pokemon_v2_pokemon {
    id
    name
    pokemon_v2_pokemonsprites {
      sprites
    }
    pokemon_v2_pokemontypes {
      pokemon_v2_type {
        name
      }
    }
  }
`)

const PokemonListQuery = graphql(
  `
    query PokemonList($limit: Int!, $offset: Int!) {
      pokemon_v2_pokemon(limit: $limit, offset: $offset, order_by: { id: asc }) {
        ...PokemonListFields
      }
    }
  `,
  [PokemonListFields],
)

const PokemonSearchQuery = graphql(
  `
    query SearchPokemon($pattern: String!, $offset: Int!, $limit: Int!) {
      pokemon_v2_pokemon(
        where: { name: { _ilike: $pattern } }
        limit: $limit
        offset: $offset
        order_by: { id: asc }
      ) {
        ...PokemonListFields
      }
    }
  `,
  [PokemonListFields],
)

export const pokemonListCell = gqlCell({
  id: "pokemon-list",
  client,
  doc: PokemonListQuery,
})

export const pokemonSearchCell = gqlCell({
  id: "pokemon-search",
  client,
  doc: PokemonSearchQuery,
})
