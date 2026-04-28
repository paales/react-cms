import { initGraphQLTada } from "gql.tada"
import type { introspection } from "./pokeapi-env.d.ts"

export const graphql = initGraphQLTada<{
  introspection: introspection
  scalars: {
    jsonb: unknown
  }
}>()

export { readFragment } from "gql.tada"
export type { FragmentOf, ResultOf, VariablesOf } from "gql.tada"
