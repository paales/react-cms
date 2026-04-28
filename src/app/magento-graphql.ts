import { initGraphQLTada } from "gql.tada"
import type { introspection } from "./magento-env.d.ts"

export const graphql = initGraphQLTada<{
  introspection: introspection
  scalars: {
    DateTime: string
    Date: string
  }
}>()

export { readFragment } from "gql.tada"
export type { FragmentOf, ResultOf, VariablesOf } from "gql.tada"
