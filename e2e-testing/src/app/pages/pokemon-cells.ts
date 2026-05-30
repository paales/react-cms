/**
 * Pokemon cells — every PokeAPI read flows through the per-backend
 * `pokemon` constructor (`gqlCellBuilder`). The raw `graphql()` call is
 * hidden: cells are built straight from query strings. Each cell's wire
 * id auto-derives from its operation name (`query PokemonHero` →
 * `pokemon-hero`). Storage caches per args; immutable data, no TTL.
 *
 * `pokemonHero / Stats / Species` — placement-bound per id.
 * `pokemonList` — placement-bound per page (limit/offset).
 * `pokemonSearch` — placement-bound per (pattern, offset, limit).
 */

import { gqlCellBuilder } from "@parton/framework"
import { client } from "../data.ts"
import { graphql } from "../pokeapi-graphql.ts"

const pokemon = gqlCellBuilder({ client, graphql })

export const pokemonHeroCell = pokemon.query(`#graphql
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

export const pokemonStatsCell = pokemon.query(`#graphql
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

export const pokemonSpeciesCell = pokemon.query(`#graphql
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

// ─── List + search cells (shared with pokemon.tsx) ─────────────────────

// A composition-only fragment (read via `readFragment` in pokemon.tsx),
// not an entity cell — so it stays a plain `graphql()` doc and is passed
// to the queries that spread it.
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

export const pokemonListCell = pokemon.query(
  `
    query PokemonList($limit: Int!, $offset: Int!) {
      pokemon_v2_pokemon(limit: $limit, offset: $offset, order_by: { id: asc }) {
        ...PokemonListFields
      }
    }
  `,
  [PokemonListFields],
)

export const pokemonSearchCell = pokemon.query(
  `
    query PokemonSearch($pattern: String!, $offset: Int!, $limit: Int!) {
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
