/**
 * GraphCommerce Magento 2 API data source.
 */

import { GraphQLClient } from "graphql-request"

export const MAGENTO_ENDPOINT = "https://graphcommerce.vercel.app/api/graphql"

export const client = new GraphQLClient(MAGENTO_ENDPOINT)
