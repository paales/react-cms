import { Partial } from "../../lib/partial.tsx"
import { ROOT, capturePartialContext } from "../../lib/partial-context.ts"
import { WhenVisible } from "../components/when-visible.tsx"
import { PartialControls } from "../components/partial-controls.tsx"
import { SearchToggle, SearchInput, SearchDialog } from "../components/search.tsx"
import { LoadMore, PageSentinel } from "../components/load-more.tsx"
import { client } from "../data.ts"
import { graphql, readFragment, type FragmentOf } from "../pokeapi-graphql.ts"
import { getPathname, getSearchParam } from "../../framework/context.ts"
import { notFound } from "../../framework/errors.ts"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

const PAGE_SIZE = 24

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
`)

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
)

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
          pokemon_v2_language {
            name
          }
        }
      }
    }
  }
`)

type SpriteJson = {
  front_default?: string | null
  other?: {
    "official-artwork"?: { front_default?: string | null } | null
  } | null
} | null

function extractSprite(sprites: unknown): string | null {
  const s = sprites as SpriteJson
  return s?.other?.["official-artwork"]?.front_default ?? s?.front_default ?? null
}

/**
 * Pokemon types → semantic tailwind background/text colors. Not a
 * shadcn Badge variant because the pool is open-ended — we use Badge's
 * base reset and layer a per-type className on top.
 */
const TYPE_COLORS: Record<string, string> = {
  grass: "bg-emerald-900/60 text-emerald-200",
  fire: "bg-red-900/60 text-red-200",
  water: "bg-blue-900/60 text-blue-200",
  electric: "bg-amber-900/60 text-amber-100",
  normal: "bg-slate-800 text-slate-200",
  poison: "bg-purple-900/60 text-purple-200",
  bug: "bg-lime-900/60 text-lime-200",
  flying: "bg-indigo-900/60 text-indigo-200",
}

function TypeBadge({ type, className }: { type: string; className?: string }) {
  const color = TYPE_COLORS[type] ?? "bg-slate-800 text-slate-200"
  return (
    <Badge
      variant="secondary"
      className={cn("rounded-full px-2.5 py-0.5 text-[0.7rem] font-semibold", color, className)}
    >
      {type}
    </Badge>
  )
}

const POKEMON_GRID = "grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4"

export function PokemonPage() {
  // `/pokemon/:id` extracted via the framework's tracked accessor.
  // Only consume the result if the id is numeric — the pattern matches
  // any non-slash segment, so `/pokemon/nav` would otherwise leak
  // through as a "non-numeric id".
  const routeIdStr = getPathname("/pokemon/:id")?.id
  const pokemonId = routeIdStr && /^\d+$/.test(routeIdStr) ? Number(routeIdStr) : undefined
  const urlSearchOpen = getSearchParam("search") != null
  const pages = Math.max(1, Number(getSearchParam("pages")) || 1)

  return (
    <>
      <Partial parent={ROOT} selector="#header">
        <header className="mb-4">
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">{new Date().toLocaleString()}</span>
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
        FRAME URL. Its open/close is driven by `useNavigation("search")
        .navigate(...)`. The wrapping `<Partial frame="search">` swaps
        the ambient request before descendants read accessors.

        The inner `<SearchArea/>` is identical in both places — the
        scope around it decides which URL it sees.
      */}
      <Partial parent={ROOT} selector="#search-page .search-results">
        <SearchArea scope="page" />
      </Partial>
      <Partial parent={ROOT} selector="#search .search-results" frame="search" frameUrl="/">
        <SearchArea scope="frame" />
      </Partial>

      {pokemonId != null ? (
        <>
          <Partial parent={ROOT} selector="#hero">
            <HeroPartial pokemonId={pokemonId} />
          </Partial>
          <Partial parent={ROOT} selector="#stats">
            <StatsPartial pokemonId={pokemonId} />
          </Partial>
          <Partial parent={ROOT} selector="#species">
            <SpeciesPartial pokemonId={pokemonId} />
          </Partial>
          <div className="h-[80vh]" data-testid="lazy-spacer" />
          <Partial
            parent={ROOT}
            selector="#trivia"
            defer={<WhenVisible />}
            fallback={
              <Card data-testid="trivia-fallback" className="mb-4 p-5">
                <CardContent className="px-0 italic text-muted-foreground">
                  Loading trivia…
                </CardContent>
              </Card>
            }
          >
            <TriviaPartial pokemonId={pokemonId} />
          </Partial>
        </>
      ) : (
        <>
          {Array.from({ length: pages }, (_, i) => (
            <Partial key={`page-${i + 1}`} parent={ROOT} selector={`#page-${i + 1}`}>
              <PokemonListPage offset={i * PAGE_SIZE} isFirst={i === 0} />
            </Partial>
          ))}
          <Partial parent={ROOT} selector="#load-more">
            <LoadMore nextPage={pages + 1} />
          </Partial>
        </>
      )}
    </>
  )
}

/**
 * Scope-agnostic search UI. Reads `?search=` and `?q=` from the
 * AMBIENT request (page URL or frame URL depending on what wraps us).
 */
function SearchArea({ scope }: { scope: "page" | "frame" }) {
  const parent = capturePartialContext()
  const isOpen = getSearchParam("search") != null
  if (!isOpen) return null
  const q = getSearchParam("q") ?? ""
  return (
    <SearchDialog open>
      <SearchInput query={q} />
      <Partial parent={parent} selector={`#${scope}-stage-1`} cache={{}}>
        <SearchStage1 query={q} />
      </Partial>
      <Partial
        parent={parent}
        selector={`#${scope}-stage-2`}
        cache={{}}
        fallback={
          <div data-testid="stage-2-fallback" className="p-2 text-muted-foreground">
            Loading stage 2...
          </div>
        }
      >
        <SearchStage2 query={q} />
      </Partial>
      <Partial
        parent={parent}
        selector={`#${scope}-stage-3`}
        cache={{}}
        fallback={
          <div data-testid="stage-3-fallback" className="p-2 text-muted-foreground">
            Loading stage 3...
          </div>
        }
      >
        <SearchStage3 query={q} />
      </Partial>
    </SearchDialog>
  )
}

/**
 * Three search stages that resolve with staggered delays (0ms, 1s, 2s).
 */

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

type SearchResult = {
  id: number
  name: string
  spriteUrl: string | null
  types: string[]
}

async function fetchSearchResults(
  query: string,
  offset: number,
  limit: number,
): Promise<SearchResult[]> {
  const data = await client.request(SearchPokemonQuery, {
    pattern: `%${query}%`,
    offset,
    limit,
  })

  return data.pokemon_v2_pokemon.map(toSearchResult)
}

function toSearchResult(raw: FragmentOf<typeof PokemonListFields>): SearchResult {
  const pokemon = readFragment(PokemonListFields, raw)
  const spriteUrl = extractSprite(pokemon.pokemon_v2_pokemonsprites[0]?.sprites)
  const types = pokemon.pokemon_v2_pokemontypes.map((t) => t.pokemon_v2_type?.name ?? "")
  return { id: pokemon.id, name: pokemon.name, spriteUrl, types }
}

function SearchResultGrid({ results, testId }: { results: SearchResult[]; testId: string }) {
  if (results.length === 0) return null
  return (
    <div data-testid={testId}>
      <div className={POKEMON_GRID}>
        {results.map((r) => (
          <a
            key={r.id}
            href={`/pokemon/${r.id}`}
            className="block rounded-xl bg-card p-5 ring-1 ring-border/50 transition-colors hover:bg-muted"
          >
            {r.spriteUrl && (
              <img src={r.spriteUrl} alt={r.name} loading="lazy" className="h-16 w-16" />
            )}
            <h2 className="mt-1 text-base capitalize">
              #{r.id} {r.name}
            </h2>
            <div className="mt-1 flex flex-wrap gap-1">
              {r.types.map((t) => (
                <TypeBadge key={t} type={t || "default"} />
              ))}
            </div>
          </a>
        ))}
      </div>
    </div>
  )
}

async function SearchStage1({ query }: { query: string }) {
  if (!query) {
    return <p className="mt-4 text-sm text-muted-foreground">Start typing to search...</p>
  }

  const results = await fetchSearchResults(query, 0, 6)

  return (
    <>
      <h3 className="mt-4 text-xs text-muted-foreground">Stage 1 — instant</h3>
      <SearchResultGrid results={results} testId="stage-1-content" />
    </>
  )
}

async function SearchStage2({ query }: { query: string }) {
  if (!query) return null
  await delay(1000)
  const results = await fetchSearchResults(query, 6, 6)

  return (
    <div>
      <h3 className="text-xs text-muted-foreground">Stage 2 — 1s delay</h3>
      <SearchResultGrid results={results} testId="stage-2-content" />
    </div>
  )
}

async function SearchStage3({ query }: { query: string }) {
  if (!query) return null
  await delay(2000)
  const results = await fetchSearchResults(query, 12, 8)

  return (
    <div>
      <h3 className="text-xs text-muted-foreground">Stage 3 — 2s delay</h3>
      <SearchResultGrid results={results} testId="stage-3-content" />
    </div>
  )
}

async function PokemonListPage({ offset, isFirst }: { offset: number; isFirst: boolean }) {
  const page = offset / PAGE_SIZE + 1

  const data = await client.request(PokemonListQuery, {
    limit: PAGE_SIZE,
    offset,
  })

  return (
    <div>
      <PageSentinel page={page} />
      {isFirst && (
        <>
          <h1 className="mb-4 text-2xl font-semibold">Pokedex</h1>
          <title>Pokedex</title>
          <p className="mb-6 text-muted-foreground">
            Browse pokemon from the PokeAPI GraphQL endpoint.
          </p>
        </>
      )}
      <div className={POKEMON_GRID}>
        {data.pokemon_v2_pokemon.map((raw) => {
          const pokemon = readFragment(PokemonListFields, raw)
          return <PokemonCard key={pokemon.id} raw={raw} />
        })}
      </div>
    </div>
  )
}

function PokemonCard({ raw }: { raw: FragmentOf<typeof PokemonListFields> }) {
  const pokemon = readFragment(PokemonListFields, raw)
  const { id, name } = pokemon
  const types = pokemon.pokemon_v2_pokemontypes.map((t) => t.pokemon_v2_type?.name ?? "")
  const spriteUrl = extractSprite(pokemon.pokemon_v2_pokemonsprites[0]?.sprites)

  return (
    <a
      href={`/pokemon/${id}`}
      className="block rounded-xl bg-card p-5 ring-1 ring-border/50 transition-colors hover:bg-muted"
    >
      {spriteUrl && <img src={spriteUrl} alt={name} loading="lazy" className="h-24 w-24" />}
      <h2 className="mt-2 text-lg capitalize">
        #{id} {name}
      </h2>
      <div className="mt-2 flex flex-wrap gap-1">
        {types.map((t) => (
          <TypeBadge key={t} type={t || "default"} />
        ))}
      </div>
    </a>
  )
}

async function HeroPartial({ pokemonId }: { pokemonId: number }) {
  const data = await client.request(PokemonHeroQuery, { id: pokemonId })

  const pokemon = data.pokemon_v2_pokemon[0]
  // Async 404: the PokeAPI returns an empty array for ids outside its range.
  if (!pokemon) notFound()
  const { id, name, height, weight } = pokemon
  const types = pokemon.pokemon_v2_pokemontypes.map((t) => ({
    slot: t.slot,
    name: t.pokemon_v2_type?.name ?? "",
  }))
  const spriteUrl = extractSprite(pokemon.pokemon_v2_pokemonsprites[0]?.sprites)

  return (
    <Card className="mb-4 p-5">
      <CardContent className="flex flex-wrap items-center gap-8 px-0">
        {spriteUrl && <img src={spriteUrl} alt={name} loading="lazy" className="h-50 w-50" />}
        <div>
          <h1 className="text-3xl capitalize">
            #{id} {name}
          </h1>
          <div className="mt-3 flex flex-wrap gap-1">
            {types.map((t) => (
              <TypeBadge key={t.slot} type={t.name || "default"} />
            ))}
          </div>
          <div className="mt-4 text-sm text-muted-foreground">
            Height: {(height ?? 0) / 10}m · Weight: {(weight ?? 0) / 10}kg
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

async function StatsPartial({ pokemonId }: { pokemonId: number }) {
  const data = await client.request(PokemonStatsQuery, { id: pokemonId })

  const pokemon = data.pokemon_v2_pokemon[0]
  if (!pokemon) return null
  const stats = pokemon.pokemon_v2_pokemonstats.map((s) => ({
    name: s.pokemon_v2_stat?.name ?? "",
    value: s.base_stat,
  }))
  const maxStat = 255

  return (
    <Card className="mb-4 p-5">
      <CardContent className="flex flex-col gap-2 px-0">
        <h2 className="text-lg font-semibold">Base Stats</h2>
        {stats.map((stat) => {
          const color =
            stat.value >= 100 ? "bg-emerald-500" : stat.value >= 60 ? "bg-amber-400" : "bg-red-500"
          return (
            <div key={stat.name} className="flex items-center gap-3">
              <span className="w-32 text-sm capitalize text-muted-foreground">
                {stat.name.replace("-", " ")}
              </span>
              <span className="w-8 text-right text-sm">{stat.value}</span>
              <div className="h-2 flex-1 overflow-hidden rounded bg-muted">
                <div
                  className={cn("h-full rounded", color)}
                  style={{
                    width: `${(stat.value / maxStat) * 100}%`,
                  }}
                />
              </div>
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}

async function TriviaPartial({ pokemonId }: { pokemonId: number }) {
  // Short delay to make streaming visible after the IntersectionObserver fires.
  await new Promise((r) => setTimeout(r, 500))
  return (
    <Card data-testid="trivia-content" className="mb-4 p-5">
      <CardContent className="px-0">
        <h2 className="text-lg font-semibold">Trivia</h2>
        <div className="mt-2 text-sm text-muted-foreground">
          Loaded on demand via{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 text-[0.85em] font-mono">
            renderOn="visible"
          </code>{" "}
          — pokemon id{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 text-[0.85em] font-mono">
            {pokemonId}
          </code>
          .
        </div>
      </CardContent>
    </Card>
  )
}

async function SpeciesPartial({ pokemonId }: { pokemonId: number }) {
  const data = await client.request(PokemonSpeciesQuery, { id: pokemonId })

  const species = data.pokemon_v2_pokemon[0]?.pokemon_v2_pokemonspecy
  if (!species) return null
  const englishEntry = species.pokemon_v2_pokemonspeciesflavortexts[0]

  return (
    <Card className="mb-4 p-5">
      <CardContent className="px-0">
        <h2 className="text-lg font-semibold capitalize">Species: {species.name}</h2>
        {englishEntry && (
          <p className="mt-3 leading-relaxed text-foreground/80">
            {englishEntry.flavor_text.replace(/\f|\n/g, " ")}
          </p>
        )}
        <div className="mt-4 text-sm text-muted-foreground">
          Generation:{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 text-[0.85em] font-mono">
            {species.pokemon_v2_generation?.name}
          </code>{" "}
          · Base Happiness:{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 text-[0.85em] font-mono">
            {species.base_happiness}
          </code>{" "}
          · Capture Rate:{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 text-[0.85em] font-mono">
            {species.capture_rate}
          </code>
        </div>
      </CardContent>
    </Card>
  )
}
