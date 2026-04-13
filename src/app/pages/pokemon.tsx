import { gql } from "graphql-request";
import { Partials } from "../../lib/partial.tsx";
import { PartialControls } from "../components/partial-controls.tsx";
import {
  SearchToggle,
  SearchInput,
  SearchDialog,
} from "../components/search.tsx";
import { LoadMore, PageSentinel } from "../components/load-more.tsx";
import { client } from "../data.ts";
import { getRequest } from "../../framework/context.ts";

const PAGE_SIZE = 12;

export function PokemonPage() {
  const url = new URL(getRequest().url);
  const pokemonMatch = url.pathname.match(/^\/pokemon\/(\d+)$/);
  const pokemonId = pokemonMatch ? Number(pokemonMatch[1]) : undefined;
  const searchMode = url.searchParams.get("search") as "url" | "partial" | null;
  const searchOpen = searchMode != null;
  const searchQuery = url.searchParams.get("q") ?? "";
  const pages = Math.max(1, Number(url.searchParams.get("pages")) || 1);
  const pagePartials =
    pokemonId == null
      ? Array.from({ length: pages }, (_, i) => (
          <PokemonListPage
            key={`page-${i + 1}`}
            offset={i * PAGE_SIZE}
            isFirst={i === 0}
          />
        ))
      : [];

  return (
    <Partials namespace="pokemon">
      <header key="header">
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span style={{ color: "#888", fontSize: "0.85rem" }}>
            {new Date().toLocaleString()}
          </span>
          <SearchToggle isOpen={searchOpen} mode={searchMode ?? undefined} />
        </div>
        {pokemonId != null && <PartialControls />}
      </header>
      {searchOpen && (
        <SearchOverlay key="search" query={searchQuery} mode={searchMode!} />
      )}
      {pokemonId != null
        ? [
            <HeroPartial key="hero" pokemonId={pokemonId} />,
            <StatsPartial key="stats" pokemonId={pokemonId} />,
            <SpeciesPartial key="species" pokemonId={pokemonId} />,
          ]
        : [...pagePartials, <LoadMore key="load-more" nextPage={pages + 1} />]}
    </Partials>
  );
}

const POKEMON_LIST_FRAGMENT = gql`
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
`;

async function SearchOverlay({
  query: searchQuery,
  mode,
}: {
  query: string;
  mode: "url" | "partial";
}) {
  if (!searchQuery) {
    return (
      <SearchDialog open>
        <SearchInput query="" mode={mode} />
        <p style={{ color: "#666", marginTop: "1rem", fontSize: "0.85rem" }}>
          Start typing to search...
        </p>
      </SearchDialog>
    );
  }

  const data = await client.request<{
    pokemon_v2_pokemon: Array<{
      id: number;
      name: string;
      pokemon_v2_pokemonsprites: Array<{ sprites: any }>;
      pokemon_v2_pokemontypes: Array<{
        pokemon_v2_type: { name: string };
      }>;
    }>;
  }>(
    gql`
      query SearchPokemon($pattern: String!) {
        pokemon_v2_pokemon(
          where: { name: { _ilike: $pattern } }
          limit: 20
          order_by: { id: asc }
        ) {
          ...PokemonListFields
        }
      }
      ${POKEMON_LIST_FRAGMENT}
    `,
    { pattern: `%${searchQuery}%` },
  );

  const results = data.pokemon_v2_pokemon.map((pokemon) => {
    const spriteUrl =
      pokemon.pokemon_v2_pokemonsprites[0]?.sprites?.other?.[
        "official-artwork"
      ]?.front_default ??
      pokemon.pokemon_v2_pokemonsprites[0]?.sprites?.front_default ??
      null;
    const types = pokemon.pokemon_v2_pokemontypes.map(
      (t) => t.pokemon_v2_type.name,
    );
    return { id: pokemon.id, name: pokemon.name, spriteUrl, types };
  });

  return (
    <SearchDialog open>
      <SearchInput query={searchQuery} mode={mode} />
      {results.length > 0 ? (
        <div className="grid" style={{ marginTop: "1rem" }}>
          {results.map((r) => (
            <a
              key={r.id}
              href={`/pokemon/${r.id}`}
              className="card"
              style={{ display: "block" }}
            >
              {r.spriteUrl && (
                <img
                  src={r.spriteUrl}
                  alt={r.name}
                  style={{
                    width: 64,
                    height: 64,
                    imageRendering: "auto" as const,
                  }}
                />
              )}
              <h2
                style={{
                  textTransform: "capitalize" as const,
                  fontSize: "1rem",
                }}
              >
                #{r.id} {r.name}
              </h2>
              <div style={{ marginTop: "0.25rem" }}>
                {r.types.map((t) => (
                  <span
                    key={t}
                    className={`badge badge-${t || "default"}`}
                    style={{ fontSize: "0.7rem" }}
                  >
                    {t}
                  </span>
                ))}
              </div>
            </a>
          ))}
        </div>
      ) : (
        <p style={{ color: "#888", marginTop: "1rem" }}>
          No pokemon found matching "{searchQuery}"
        </p>
      )}
    </SearchDialog>
  );
}

async function PokemonListPage({
  offset,
  isFirst,
}: {
  offset: number;
  isFirst: boolean;
}) {
  const page = offset / PAGE_SIZE + 1;

  const data = await client.request<{
    pokemon_v2_pokemon: Array<{
      id: number;
      name: string;
      pokemon_v2_pokemonsprites: Array<{ sprites: any }>;
      pokemon_v2_pokemontypes: Array<{
        pokemon_v2_type: { name: string };
      }>;
    }>;
  }>(
    gql`
      query PokemonList($limit: Int!, $offset: Int!) {
        pokemon_v2_pokemon(limit: $limit, offset: $offset, order_by: { id: asc }) {
          ...PokemonListFields
        }
      }
      ${POKEMON_LIST_FRAGMENT}
    `,
    { limit: PAGE_SIZE, offset },
  );

  return (
    <div>
      <PageSentinel page={page} />
      {isFirst && (
        <>
          <h1>Pokedex</h1>
          <title>Pokedex</title>
          <p style={{ color: "#888", marginBottom: "1.5rem" }}>
            Browse pokemon from the PokeAPI GraphQL endpoint.
          </p>
        </>
      )}
      <div className="grid">
        {data.pokemon_v2_pokemon.map((pokemon) => (
          <PokemonCard key={pokemon.id} pokemon={pokemon} />
        ))}
      </div>
    </div>
  );
}

function PokemonCard({
  pokemon,
}: {
  pokemon: {
    id: number;
    name: string;
    pokemon_v2_pokemonsprites: Array<{ sprites: any }>;
    pokemon_v2_pokemontypes: Array<{ pokemon_v2_type: { name: string } }>;
  };
}) {
  const { id, name } = pokemon;
  const types = pokemon.pokemon_v2_pokemontypes.map(
    (t) => t.pokemon_v2_type.name,
  );
  const spriteUrl =
    pokemon.pokemon_v2_pokemonsprites[0]?.sprites?.other?.[
      "official-artwork"
    ]?.front_default ??
    pokemon.pokemon_v2_pokemonsprites[0]?.sprites?.front_default ??
    null;

  return (
    <a href={`/pokemon/${id}`} className="card" style={{ display: "block" }}>
      {spriteUrl && (
        <img
          src={spriteUrl}
          alt={name}
          style={{ width: 96, height: 96, imageRendering: "auto" as const }}
        />
      )}
      <h2 style={{ textTransform: "capitalize" as const }}>
        #{id} {name}
      </h2>
      <div style={{ marginTop: "0.5rem" }}>
        {types.map((t) => (
          <span key={t} className={`badge badge-${t || "default"}`}>
            {t}
          </span>
        ))}
      </div>
    </a>
  );
}

async function HeroPartial({ pokemonId }: { pokemonId: number }) {
  const data = await client.request<{
    pokemon_v2_pokemon: Array<{
      id: number;
      name: string;
      height: number;
      weight: number;
      pokemon_v2_pokemonsprites: Array<{ sprites: any }>;
      pokemon_v2_pokemontypes: Array<{
        slot: number;
        pokemon_v2_type: { name: string };
      }>;
    }>;
  }>(
    gql`
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
    `,
    { id: pokemonId },
  );

  const pokemon = data.pokemon_v2_pokemon[0];
  const { id, name, height, weight } = pokemon;
  const types = pokemon.pokemon_v2_pokemontypes.map((t) => ({
    slot: t.slot,
    name: t.pokemon_v2_type.name,
  }));
  const spriteUrl =
    pokemon.pokemon_v2_pokemonsprites[0]?.sprites?.other?.[
      "official-artwork"
    ]?.front_default ??
    pokemon.pokemon_v2_pokemonsprites[0]?.sprites?.front_default;

  return (
    <div
      className="card"
      style={{ display: "flex", gap: "2rem", alignItems: "center" }}
    >
      {spriteUrl && (
        <img src={spriteUrl} alt={name} style={{ width: 200, height: 200 }} />
      )}
      <div>
        <h1
          style={{ textTransform: "capitalize" as const, fontSize: "2rem" }}
        >
          #{id} {name}
        </h1>
        <div style={{ marginTop: "0.75rem" }}>
          {types.map((t) => (
            <span
              key={t.slot}
              className={`badge badge-${t.name || "default"}`}
            >
              {t.name}
            </span>
          ))}
        </div>
        <div className="meta" style={{ marginTop: "1rem" }}>
          Height: {height / 10}m · Weight: {weight / 10}kg
        </div>
      </div>
    </div>
  );
}

async function StatsPartial({ pokemonId }: { pokemonId: number }) {
  const data = await client.request<{
    pokemon_v2_pokemon: Array<{
      pokemon_v2_pokemonstats: Array<{
        base_stat: number;
        pokemon_v2_stat: { name: string };
      }>;
    }>;
  }>(
    gql`
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
    `,
    { id: pokemonId },
  );

  const stats = data.pokemon_v2_pokemon[0].pokemon_v2_pokemonstats.map(
    (s) => ({
      name: s.pokemon_v2_stat.name,
      value: s.base_stat,
    }),
  );
  const maxStat = 255;

  return (
    <div className="card">
      <h2>Base Stats</h2>
      <div style={{ marginTop: "0.75rem" }}>
        {stats.map((stat) => (
          <div
            key={stat.name}
            style={{
              display: "flex",
              alignItems: "center",
              marginBottom: "0.5rem",
              gap: "0.75rem",
            }}
          >
            <span
              style={{
                width: 120,
                fontSize: "0.85rem",
                textTransform: "capitalize" as const,
                color: "#aaa",
              }}
            >
              {stat.name.replace("-", " ")}
            </span>
            <span
              style={{
                width: 35,
                fontSize: "0.85rem",
                textAlign: "right" as const,
              }}
            >
              {stat.value}
            </span>
            <div
              style={{
                flex: 1,
                height: 8,
                background: "#2d3748",
                borderRadius: 4,
                overflow: "hidden" as const,
              }}
            >
              <div
                style={{
                  width: `${(stat.value / maxStat) * 100}%`,
                  height: "100%",
                  background:
                    stat.value >= 100
                      ? "#48bb78"
                      : stat.value >= 60
                        ? "#ecc94b"
                        : "#f56565",
                  borderRadius: 4,
                }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

async function SpeciesPartial({ pokemonId }: { pokemonId: number }) {
  const data = await client.request<{
    pokemon_v2_pokemon: Array<{
      pokemon_v2_pokemonspecy: {
        name: string;
        base_happiness: number;
        capture_rate: number;
        pokemon_v2_generation: { name: string };
        pokemon_v2_pokemonspeciesflavortexts: Array<{
          flavor_text: string;
          pokemon_v2_language: { name: string };
        }>;
      };
    }>;
  }>(
    gql`
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
              pokemon_v2_language {
                name
              }
            }
          }
        }
      }
    `,
    { id: pokemonId },
  );

  const species = data.pokemon_v2_pokemon[0].pokemon_v2_pokemonspecy;
  const englishEntry = species.pokemon_v2_pokemonspeciesflavortexts[0];

  return (
    <div className="card">
      <h2 style={{ textTransform: "capitalize" as const }}>
        Species: {species.name}
      </h2>
      {englishEntry && (
        <p style={{ marginTop: "0.75rem", lineHeight: 1.6, color: "#ccc" }}>
          {englishEntry.flavor_text.replace(/\f|\n/g, " ")}
        </p>
      )}
      <div className="meta" style={{ marginTop: "1rem" }}>
        Generation: <code>{species.pokemon_v2_generation.name}</code> · Base
        Happiness: <code>{species.base_happiness}</code> · Capture Rate:{" "}
        <code>{species.capture_rate}</code>
      </div>
    </div>
  );
}
