import { Partial } from "../../lib/partial.tsx";
import { WhenVisible } from "../components/when-visible.tsx";
import { PartialControls } from "../components/partial-controls.tsx";
import {
  SearchToggle,
  SearchInput,
  SearchDialog,
} from "../components/search.tsx";
import { LoadMore, PageSentinel } from "../components/load-more.tsx";
import { client } from "../data.ts";
import { graphql, readFragment, type FragmentOf } from "../pokeapi-graphql.ts";
import { getPathname, getSearchParam } from "../../framework/context.ts";
import { notFound } from "../../framework/errors.ts";

const PAGE_SIZE = 24;

const PokemonListFields = graphql(`
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
`);

const SearchPokemonQuery = graphql(
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
);

const PokemonListQuery = graphql(
  `
    query PokemonList($limit: Int!, $offset: Int!) {
      pokemon_v2_pokemon(
        limit: $limit
        offset: $offset
        order_by: { id: asc }
      ) {
        ...PokemonListFields
      }
    }
  `,
  [PokemonListFields],
);

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
`);

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
`);

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
          pokemon_v2_language {
            name
          }
        }
      }
    }
  }
`);

type SpriteJson = {
  front_default?: string | null;
  other?: {
    "official-artwork"?: { front_default?: string | null } | null;
  } | null;
} | null;

function extractSprite(sprites: unknown): string | null {
  const s = sprites as SpriteJson;
  return (
    s?.other?.["official-artwork"]?.front_default ?? s?.front_default ?? null
  );
}

export function PokemonPage() {
  // `/pokemon/:id` extracted via the framework's tracked accessor.
  // Only consume the result if the id is numeric — the pattern matches
  // any non-slash segment, so `/pokemon/nav` would otherwise leak
  // through as a "non-numeric id".
  const routeIdStr = getPathname("/pokemon/:id")?.id;
  const pokemonId =
    routeIdStr && /^\d+$/.test(routeIdStr) ? Number(routeIdStr) : undefined;
  const urlSearchOpen = getSearchParam("search") != null;
  const pages = Math.max(1, Number(getSearchParam("pages")) || 1);
  const pagePartials =
    pokemonId == null
      ? Array.from({ length: pages }, (_, i) => (
          <Partial key={`page-${i + 1}`} id={`page-${i + 1}`}>
            <PokemonListPage offset={i * PAGE_SIZE} isFirst={i === 0} />
          </Partial>
        ))
      : [];

  return (
    <>
      <Partial id="header">
        <header>
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
            {/* URL-mode open state comes from the page URL;
                frame-mode open state is read client-side inside the
                toggle via `useNavigation("search").currentUrl`. */}
            <SearchToggle urlOpen={urlSearchOpen} />
          </div>
          {pokemonId != null && <PartialControls />}
        </header>
      </Partial>

      {/*
        Two symmetric instances of the same component.

        URL mode (page-scoped): reads `?search=` / `?q=` from the PAGE
        URL. Its open/close is driven by `useNavigation().navigate(...)`.

        Frame mode (frame-scoped): reads `?search=` / `?q=` from the
        FRAME URL. Its open/close is driven by `frame("search")
        .navigate(...)`. The wrapping `<Partial frame="search">` swaps
        the ambient request before descendants read accessors.

        The inner `<SearchArea/>` is identical in both places — the
        scope around it decides which URL it sees.
      */}
      {/* The container Partials are what the typing input refetches
          via `tags: ["search-results"]`. Page scope: tag resolves to
          `search-page` and its body re-runs — `<SearchArea/>` reads a
          fresh `?q=` from the page URL and builds fresh stage
          elements with the new prop. Frame scope: tag filter is
          ignored by frame navigation (frame nav always refetches its
          own subtree), so the behavior is symmetric either way. */}
      <Partial id="search-page" tags="search-results">
        <SearchArea scope="page" />
      </Partial>
      <Partial id="search" tags="search-results" frame="search" frameUrl="/">
        <SearchArea scope="frame" />
      </Partial>

      {pokemonId != null ? (
        <>
          <Partial id="hero">
            <HeroPartial pokemonId={pokemonId} />
          </Partial>
          <Partial id="stats">
            <StatsPartial pokemonId={pokemonId} />
          </Partial>
          <Partial id="species">
            <SpeciesPartial pokemonId={pokemonId} />
          </Partial>
          <div style={{ height: "80vh" }} data-testid="lazy-spacer" />
          <Partial
            id="trivia"
            defer={<WhenVisible />}
            fallback={
              <div
                className="card"
                data-testid="trivia-fallback"
                style={{ color: "#888", fontStyle: "italic" }}
              >
                Loading trivia…
              </div>
            }
          >
            <TriviaPartial pokemonId={pokemonId} />
          </Partial>
        </>
      ) : (
        <>
          {pagePartials}
          <Partial id="load-more">
            <LoadMore nextPage={pages + 1} />
          </Partial>
        </>
      )}
    </>
  );
}

/**
 * Scope-agnostic search UI. Reads `?search=` and `?q=` from the
 * AMBIENT request (page URL or frame URL depending on what wraps us).
 *
 * Rendered twice in the pokemon page:
 *   - page-scoped:  <Partial id="search-page"><SearchArea scope="page"/></Partial>
 *   - frame-scoped: <Partial frame="search"><SearchArea scope="frame"/></Partial>
 *
 * The `scope` prop is purely a namespace for the stage Partial ids
 * (to avoid colliding when both instances happen to render at the
 * same time) — it does NOT change behavior.
 *
 * Every stage carries `tags="search-results"` so `useNavigation()
 * .navigate(url, {tags: ["search-results"]})` from inside the input
 * refetches them together. Tag → id resolution runs server-side
 * against the route-scoped registry; dynamic / conditional Partials
 * resolve as long as they've rendered on a prior pass.
 */
function SearchArea({ scope }: { scope: "page" | "frame" }) {
  const isOpen = getSearchParam("search") != null;
  if (!isOpen) return null;
  const q = getSearchParam("q") ?? "";
  return (
    <SearchDialog open>
      <SearchInput query={q} />
      {/*
        Stage 1 has no `fallback` — the framework therefore does
        not wrap it in a Suspense boundary. SearchStage1 still
        awaits a GraphQL query, but that suspend resolves in the
        outer RSC stream before the enclosing partial's chunk
        emits, so the client commits stage-1's content inline
        with the rest of the response. No loading flash, no
        per-chunk streaming — appropriate for a fast "always-on"
        slice that sits at the top of the dialog.
      */}
      <Partial id={`${scope}-stage-1`} cache={{}}>
        <SearchStage1 query={q} />
      </Partial>
      <Partial
        id={`${scope}-stage-2`}
        cache={{}}
        fallback={
          <div
            data-testid="stage-2-fallback"
            style={{ color: "#666", padding: "0.5rem" }}
          >
            Loading stage 2...
          </div>
        }
      >
        <SearchStage2 query={q} />
      </Partial>
      <Partial
        id={`${scope}-stage-3`}
        cache={{}}
        fallback={
          <div
            data-testid="stage-3-fallback"
            style={{ color: "#666", padding: "0.5rem" }}
          >
            Loading stage 3...
          </div>
        }
      >
        <SearchStage3 query={q} />
      </Partial>
    </SearchDialog>
  );
}

/**
 * Three search stages that resolve with staggered delays (0ms, 1s, 2s).
 * Each queries a different slice of results. This tests whether RSC
 * streaming delivers partials progressively on AJAX refetch.
 */

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

type SearchResult = {
  id: number;
  name: string;
  spriteUrl: string | null;
  types: string[];
};

async function fetchSearchResults(
  query: string,
  offset: number,
  limit: number,
): Promise<SearchResult[]> {
  const data = await client.request(SearchPokemonQuery, {
    pattern: `%${query}%`,
    offset,
    limit,
  });

  return data.pokemon_v2_pokemon.map(toSearchResult);
}

function toSearchResult(
  raw: FragmentOf<typeof PokemonListFields>,
): SearchResult {
  const pokemon = readFragment(PokemonListFields, raw);
  const spriteUrl = extractSprite(
    pokemon.pokemon_v2_pokemonsprites[0]?.sprites,
  );
  const types = pokemon.pokemon_v2_pokemontypes.map(
    (t) => t.pokemon_v2_type?.name ?? "",
  );
  return { id: pokemon.id, name: pokemon.name, spriteUrl, types };
}

function SearchResultGrid({
  results,
  testId,
}: {
  results: SearchResult[];
  testId: string;
}) {
  if (results.length === 0) return null;
  return (
    <div data-testid={testId}>
      <div className="grid">
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
                loading="lazy"
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
    </div>
  );
}

/**
 * Stages take `query` as a scalar prop.
 *
 * `SearchArea` reads `getSearchParam("q")` from the ambient scope
 * (page URL or frame URL) and passes the value to each stage. Reading
 * the accessor *inside* each stage would sound simpler, but the
 * stages are wrapped in `<Partial cache>` and `<Cache>`'s inner
 * render (`renderToReadableStream`) opens a fresh React internal
 * render context that doesn't inherit the frame-scope cell — so a
 * frame-scoped stage would read the page URL and miss `?q=`.
 * Lifting the read out of Cache keeps the accessor inside the
 * correct scope and also folds `query` into the stage's structural
 * fingerprint, so different `q` values produce different cache keys
 * (instead of relying solely on the Cache manifest's URL capture).
 */

/** Stage 1: first 6 results, no delay */
async function SearchStage1({ query }: { query: string }) {
  if (!query) {
    return (
      <p style={{ color: "#666", marginTop: "1rem", fontSize: "0.85rem" }}>
        Start typing to search...
      </p>
    );
  }

  const results = await fetchSearchResults(query, 0, 6);

  return (
    <>
      <h3 style={{ color: "#888", marginTop: "1rem", fontSize: "0.8rem" }}>
        Stage 1 — instant
      </h3>
      <SearchResultGrid results={results} testId="stage-1-content" />
    </>
  );
}

/** Stage 2: next 6 results, 1 second delay. No-ops when q is empty. */
async function SearchStage2({ query }: { query: string }) {
  if (!query) return null;
  await delay(1000);
  const results = await fetchSearchResults(query, 6, 6);

  return (
    <div>
      <h3 style={{ color: "#888", fontSize: "0.8rem" }}>Stage 2 — 1s delay</h3>
      <SearchResultGrid results={results} testId="stage-2-content" />
    </div>
  );
}

/** Stage 3: next 8 results, 2 second delay. No-ops when q is empty. */
async function SearchStage3({ query }: { query: string }) {
  if (!query) return null;
  await delay(2000);
  const results = await fetchSearchResults(query, 12, 8);

  return (
    <div>
      <h3 style={{ color: "#888", fontSize: "0.8rem" }}>Stage 3 — 2s delay</h3>
      <SearchResultGrid results={results} testId="stage-3-content" />
    </div>
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

  const data = await client.request(PokemonListQuery, {
    limit: PAGE_SIZE,
    offset,
  });

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
        {data.pokemon_v2_pokemon.map((raw) => {
          const pokemon = readFragment(PokemonListFields, raw);
          return <PokemonCard key={pokemon.id} raw={raw} />;
        })}
      </div>
    </div>
  );
}

function PokemonCard({ raw }: { raw: FragmentOf<typeof PokemonListFields> }) {
  const pokemon = readFragment(PokemonListFields, raw);
  const { id, name } = pokemon;
  const types = pokemon.pokemon_v2_pokemontypes.map(
    (t) => t.pokemon_v2_type?.name ?? "",
  );
  const spriteUrl = extractSprite(
    pokemon.pokemon_v2_pokemonsprites[0]?.sprites,
  );

  return (
    <a href={`/pokemon/${id}`} className="card" style={{ display: "block" }}>
      {spriteUrl && (
        <img
          src={spriteUrl}
          alt={name}
          loading="lazy"
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
  const data = await client.request(PokemonHeroQuery, { id: pokemonId });

  const pokemon = data.pokemon_v2_pokemon[0];
  // Async 404: the PokeAPI returns an empty array for ids outside its
  // range (there are ~1025 pokemon; /pokemon/9999999 produces this).
  // Calling `notFound()` here sets the framework control channel and
  // throws — the RSC entry picks up the flag after `renderHTML`
  // awaits and returns HTTP 404.
  if (!pokemon) notFound();
  const { id, name, height, weight } = pokemon;
  const types = pokemon.pokemon_v2_pokemontypes.map((t) => ({
    slot: t.slot,
    name: t.pokemon_v2_type?.name ?? "",
  }));
  const spriteUrl = extractSprite(
    pokemon.pokemon_v2_pokemonsprites[0]?.sprites,
  );

  return (
    <div
      className="card"
      style={{ display: "flex", gap: "2rem", alignItems: "center" }}
    >
      {spriteUrl && (
        <img
          src={spriteUrl}
          alt={name}
          loading="lazy"
          style={{ width: 200, height: 200 }}
        />
      )}
      <div>
        <h1 style={{ textTransform: "capitalize" as const, fontSize: "2rem" }}>
          #{id} {name}
        </h1>
        <div style={{ marginTop: "0.75rem" }}>
          {types.map((t) => (
            <span key={t.slot} className={`badge badge-${t.name || "default"}`}>
              {t.name}
            </span>
          ))}
        </div>
        <div className="meta" style={{ marginTop: "1rem" }}>
          Height: {(height ?? 0) / 10}m · Weight: {(weight ?? 0) / 10}kg
        </div>
      </div>
    </div>
  );
}

async function StatsPartial({ pokemonId }: { pokemonId: number }) {
  const data = await client.request(PokemonStatsQuery, { id: pokemonId });

  const pokemon = data.pokemon_v2_pokemon[0];
  if (!pokemon) return null;
  const stats = pokemon.pokemon_v2_pokemonstats.map((s) => ({
    name: s.pokemon_v2_stat?.name ?? "",
    value: s.base_stat,
  }));
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

async function TriviaPartial({ pokemonId }: { pokemonId: number }) {
  // Short delay to make streaming visible after the IntersectionObserver
  // fires — mirrors a slow enrichment API.
  await new Promise((r) => setTimeout(r, 500));
  return (
    <div className="card" data-testid="trivia-content">
      <h2>Trivia</h2>
      <div className="meta" style={{ marginTop: "0.5rem" }}>
        Loaded on demand via <code>renderOn="visible"</code> — pokemon id{" "}
        <code>{pokemonId}</code>.
      </div>
    </div>
  );
}

async function SpeciesPartial({ pokemonId }: { pokemonId: number }) {
  const data = await client.request(PokemonSpeciesQuery, { id: pokemonId });

  const species = data.pokemon_v2_pokemon[0]?.pokemon_v2_pokemonspecy;
  if (!species) return null;
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
        Generation: <code>{species.pokemon_v2_generation?.name}</code> · Base
        Happiness: <code>{species.base_happiness}</code> · Capture Rate:{" "}
        <code>{species.capture_rate}</code>
      </div>
    </div>
  );
}
