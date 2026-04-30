/**
 * Pokemon overview page — `/`.
 *
 * Outer wrapper spec gates the route once. Inner specs (header, search,
 * pokedex pages, load more) take their data via JSX props and `vary`,
 * with no per-spec `match` repetition.
 *
 * Detail page lives in `./pokemon-detail.tsx`; this file exports the
 * pieces it shares (header, search areas, sprite helper).
 */

import { ReactCms, type RenderArgs } from "@react-cms/framework"
import { client } from "../data.ts"
import { graphql, readFragment, type FragmentOf } from "../pokeapi-graphql.ts"
import { Badge } from "@react-cms/copies/components/ui/badge"
import { cn } from "@react-cms/copies/lib/utils"
import { LoadMore as LoadMoreClient, PageSentinel } from "../components/load-more.tsx"
import { PartialControls } from "../components/partial-controls.tsx"
import { SearchToggle, SearchInput, SearchDialog } from "../components/search.tsx"

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

type SpriteJson = {
  front_default?: string | null
  other?: { "official-artwork"?: { front_default?: string | null } | null } | null
} | null

export function extractSprite(sprites: unknown): string | null {
  const s = sprites as SpriteJson
  return s?.other?.["official-artwork"]?.front_default ?? s?.front_default ?? null
}

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

// ─── Header ─────────────────────────────────────────────────────────────
//
// `showControls` arrives as a JSX prop from whichever wrapper renders
// the header — overview passes false, detail passes true. The cache key
// folds it in automatically (call-site props are part of the
// fingerprint).

export const HeaderPartial = ReactCms.partial(
  function HeaderRender({
    showControls,
    search,
  }: { showControls: boolean; search: string | undefined } & RenderArgs) {
    return (
      <header className="mb-4">
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">{new Date().toLocaleString()}</span>
          <SearchToggle urlOpen={search != null} />
        </div>
        {showControls && <PartialControls />}
      </header>
    )
  },
  {
    vary: ({ search: { search } }) => ({ search }),
  },
)

// ─── Search areas (page + frame scopes) ────────────────────────────────

function makeSearchArea(scope: "page" | "frame") {
  const Stage1 = ReactCms.partial(SearchStage1Render, {
    selector: `#${scope}-stage-1`,
    cache: {},
    vary: ({ search: { q = "" } }) => ({ q }),
  })
  const Stage2 = ReactCms.partial(SearchStage2Render, {
    selector: `#${scope}-stage-2`,
    cache: {},
    vary: ({ search: { q = "" } }) => ({ q }),
    fallback: (
      <div data-testid="stage-2-fallback" className="p-2 text-muted-foreground">
        Loading stage 2...
      </div>
    ),
  })
  const Stage3 = ReactCms.partial(SearchStage3Render, {
    selector: `#${scope}-stage-3`,
    cache: {},
    vary: ({ search: { q = "" } }) => ({ q }),
    fallback: (
      <div data-testid="stage-3-fallback" className="p-2 text-muted-foreground">
        Loading stage 3...
      </div>
    ),
  })

  const Body = ReactCms.partial(SearchBodyRender, {
    selector: scope === "page" ? "#search-page .search-results" : "#search .search-results",
    frame: scope === "frame" ? "search" : undefined,
    frameUrl: scope === "frame" ? "/" : undefined,
    vary: ({ search: { search, q = "" } }) => ({ search, q }),
  })

  function SearchBodyRender({
    search,
    q,
    parent,
  }: { search: string | undefined; q: string } & RenderArgs) {
    if (search == null) return null
    return (
      <SearchDialog open>
        <SearchInput query={q} />
        <Stage1 parent={parent} />
        <Stage2 parent={parent} />
        <Stage3 parent={parent} />
      </SearchDialog>
    )
  }
  return Body
}

export const SearchAreaPage = makeSearchArea("page")
export const SearchAreaFrame = makeSearchArea("frame")

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

type SearchResult = { id: number; name: string; spriteUrl: string | null; types: string[] }

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

async function SearchStage1Render({ q }: { q: string } & RenderArgs) {
  if (!q) return <p className="mt-4 text-sm text-muted-foreground">Start typing to search...</p>
  const results = await fetchSearchResults(q, 0, 6)
  return (
    <>
      <h3 className="mt-4 text-xs text-muted-foreground">Stage 1 — instant</h3>
      <SearchResultGrid results={results} testId="stage-1-content" />
    </>
  )
}

async function SearchStage2Render({ q }: { q: string } & RenderArgs) {
  if (!q) return null
  await delay(1000)
  const results = await fetchSearchResults(q, 6, 6)
  return (
    <div>
      <h3 className="text-xs text-muted-foreground">Stage 2 — 1s delay</h3>
      <SearchResultGrid results={results} testId="stage-2-content" />
    </div>
  )
}

async function SearchStage3Render({ q }: { q: string } & RenderArgs) {
  if (!q) return null
  await delay(2000)
  const results = await fetchSearchResults(q, 12, 8)
  return (
    <div>
      <h3 className="text-xs text-muted-foreground">Stage 3 — 2s delay</h3>
      <SearchResultGrid results={results} testId="stage-3-content" />
    </div>
  )
}

// ─── Pokedex list pages ─────────────────────────────────────────────────
//
// `#page-N` selectors stay explicit — the same Render is reused for
// every page, so auto-deriving from the function name would collide.

function makeListPagePartial(page: number) {
  return ReactCms.partial(PokemonListPageRender, {
    selector: `#page-${page}` as const,
    vary: ({ search: { pages: pagesRaw } }) => {
      const pages = Math.max(1, Number(pagesRaw) || 1)
      if (page > pages) return null
      return { page, isFirst: page === 1 }
    },
  })
}

async function PokemonListPageRender({
  page,
  isFirst,
}: { page: number; isFirst: boolean } & RenderArgs) {
  const offset = (page - 1) * PAGE_SIZE
  const data = await client.request(PokemonListQuery, { limit: PAGE_SIZE, offset })
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

const MAX_LIST_PAGES = 10
const ListPagePartials = Array.from({ length: MAX_LIST_PAGES }, (_, i) =>
  makeListPagePartial(i + 1),
)

const LoadMorePartial = ReactCms.partial(
  function LoadMoreRender({ nextPage }: { nextPage: number } & RenderArgs) {
    return <LoadMoreClient nextPage={nextPage} />
  },
  {
    vary: ({ search: { pages } }) => ({
      nextPage: Math.max(1, Number(pages) || 1) + 1,
    }),
  },
)

// ─── Outer wrapper — matches /, composes the overview ─────────────────

export const PokemonOverviewPage = ReactCms.partial(
  function PokemonOverviewRender({ parent }: RenderArgs) {
    return (
      <>
        <HeaderPartial parent={parent} showControls={false} />
        <SearchAreaPage parent={parent} />
        <SearchAreaFrame parent={parent} />
        {ListPagePartials.map((P, i) => (
          <P key={`list-page-${i + 1}`} parent={parent} />
        ))}
        <LoadMorePartial parent={parent} />
      </>
    )
  },
  { match: "/" },
)
