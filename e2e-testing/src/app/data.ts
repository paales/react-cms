/**
 * PokeAPI data source.
 */

import { GraphQLClient } from "graphql-request"

export const POKEAPI_ENDPOINT = "https://beta.pokeapi.co/graphql/v1beta"

export const client = new GraphQLClient(POKEAPI_ENDPOINT)
