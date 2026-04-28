import type { IGraphQLConfig } from "graphql-config"

const config: IGraphQLConfig = {
  projects: {
    pokeapi: {
      schema: "https://beta.pokeapi.co/graphql/v1beta",
      documents: ["src/app/pages/pokemon.tsx", "src/app/pokeapi-graphql.ts"],
      extensions: {
        tada: {
          outputLocation: "src/app/pokeapi-env.d.ts",
        },
      },
    },
    magento: {
      schema: "https://graphcommerce.vercel.app/api/graphql",
      documents: ["src/app/pages/magento/**/*.{ts,tsx}", "src/app/magento-graphql.ts"],
      extensions: {
        tada: {
          outputLocation: "src/app/magento-env.d.ts",
        },
      },
    },
  },
}

export default config
