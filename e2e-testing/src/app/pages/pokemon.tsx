/**
 * Pokemon overview page — `/`.
 *
 * Outer wrapper spec gates the route once. Inner specs (header, search,
 * pokedex pages, load more) take their data via JSX-prop-bound
 * gqlCells (see pokemon-cells.ts). The outer wrapper constructs the
 * bound cells per page/stage; child Renders receive ResolvedCells.
 *
 * Detail page lives in `./pokemon-detail.tsx`; this file exports the
 * pieces it shares (header, search areas, sprite helper).
 */

import { parton, type RenderArgs, type ResolvedCell } from "@parton/framework"
import { Frame } from "@parton/framework/lib/frame.tsx"
import { readFragment, type FragmentOf } from "../pokeapi-graphql.ts"
import { Badge } from "@parton/copies/components/ui/badge"
import { cn } from "@parton/copies/lib/utils"
import { LoadMore as LoadMoreClient, PageSentinel } from "../components/load-more.tsx"
import { PartialControls } from "../components/partial-controls.tsx"
import { SearchToggle, SearchInput, SearchDialog } from "../components/search.tsx"
import {
  PokemonListFields,
  pokemonListCell,
  pokemonSearchCell,
} from "./pokemon-cells.ts"

const PAGE_SIZE = 24

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

export const HeaderPartial = parton(
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

type PokemonListResult = {
  pokemon_v2_pokemon: ReadonlyArray<FragmentOf<typeof PokemonListFields>>
}
type SearchCellValue = PokemonListResult | null

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

type SearchResult = { id: number; name: string; spriteUrl: string | null; types: string[] }

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

function makeSearchArea(scope: "page" | "frame") {
  const Stage1 = parton(
    function Stage1Render({
      results,
    }: { results: ResolvedCell<SearchCellValue> } & RenderArgs) {
      const list = results.value?.pokemon_v2_pokemon ?? []
      if (list.length === 0) {
        return <p className="mt-4 text-sm text-muted-foreground">Start typing to search...</p>
      }
      return (
        <>
          <h3 className="mt-4 text-xs text-muted-foreground">Stage 1 — instant</h3>
          <SearchResultGrid results={list.map(toSearchResult)} testId="stage-1-content" />
        </>
      )
    },
    { selector: `#${scope}-stage-1`, cache: {} },
  )

  const Stage2 = parton(
    async function Stage2Render({
      results,
      q,
    }: { results: ResolvedCell<SearchCellValue>; q: string } & RenderArgs) {
      if (!q) return null
      // Artificial delay — preserves the streaming-UX demo. Real
      // loads run instantly when storage is warm.
      await delay(1000)
      const list = results.value?.pokemon_v2_pokemon ?? []
      return (
        <div>
          <h3 className="text-xs text-muted-foreground">Stage 2 — 1s delay</h3>
          <SearchResultGrid results={list.map(toSearchResult)} testId="stage-2-content" />
        </div>
      )
    },
    {
      selector: `#${scope}-stage-2`,
      cache: {},
      fallback: (
        <div data-testid="stage-2-fallback" className="p-2 text-muted-foreground">
          Loading stage 2...
        </div>
      ),
    },
  )

  const Stage3 = parton(
    async function Stage3Render({
      results,
      q,
    }: { results: ResolvedCell<SearchCellValue>; q: string } & RenderArgs) {
      if (!q) return null
      await delay(2000)
      const list = results.value?.pokemon_v2_pokemon ?? []
      return (
        <div>
          <h3 className="text-xs text-muted-foreground">Stage 3 — 2s delay</h3>
          <SearchResultGrid results={list.map(toSearchResult)} testId="stage-3-content" />
        </div>
      )
    },
    {
      selector: `#${scope}-stage-3`,
      cache: {},
      fallback: (
        <div data-testid="stage-3-fallback" className="p-2 text-muted-foreground">
          Loading stage 3...
        </div>
      ),
    },
  )

  function SearchBodyRender({
    search,
    q,
    parent,
  }: { search: string | undefined; q: string } & RenderArgs) {
    if (search == null) return null
    const pattern = `%${q}%`
    return (
      <SearchDialog open>
        <SearchInput query={q} />
        <Stage1
          parent={parent}
          results={pokemonSearchCell.with({ pattern, offset: 0, limit: 6 })}
        />
        <Stage2
          parent={parent}
          q={q}
          results={pokemonSearchCell.with({ pattern, offset: 6, limit: 6 })}
        />
        <Stage3
          parent={parent}
          q={q}
          results={pokemonSearchCell.with({ pattern, offset: 12, limit: 8 })}
        />
      </SearchDialog>
    )
  }

  return parton(SearchBodyRender, {
    selector: scope === "page" ? "#search-page .search-results" : "#search .search-results",
    vary: ({ search: { search, q = "" } }) => ({ search, q }),
  })
}

export const SearchAreaPage = makeSearchArea("page")
export const SearchAreaFrame = makeSearchArea("frame")

// ─── Pokedex list pages ─────────────────────────────────────────────────

function makeListPagePartial(page: number) {
  return parton(
    function PokemonListPageRender({
      page,
      isFirst,
      results,
    }: {
      page: number
      isFirst: boolean
      results: ResolvedCell<PokemonListResult | null>
    } & RenderArgs) {
      const list = results.value?.pokemon_v2_pokemon ?? []
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
            {list.map((raw) => {
              const pokemon = readFragment(PokemonListFields, raw)
              return <PokemonCard key={pokemon.id} raw={raw} />
            })}
          </div>
        </div>
      )
    },
    {
      selector: `#page-${page}` as const,
      vary: ({ search: { pages: pagesRaw } }) => {
        const pages = Math.max(1, Number(pagesRaw) || 1)
        if (page > pages) return null
        return { page, isFirst: page === 1 }
      },
    },
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

const LoadMorePartial = parton(
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

export const PokemonOverviewPage = parton(
  function PokemonOverviewRender({ parent }: RenderArgs) {
    return (
      <>
        <HeaderPartial parent={parent} showControls={false} />
        <SearchAreaPage parent={parent} />
        <Frame name="search" initialUrl="/" parent={parent}>
          {(p) => <SearchAreaFrame parent={p} />}
        </Frame>
        {ListPagePartials.map((P, i) => {
          const page = i + 1
          const offset = (page - 1) * PAGE_SIZE
          return (
            <P
              key={`list-page-${page}`}
              parent={parent}
              results={pokemonListCell.with({ limit: PAGE_SIZE, offset })}
            />
          )
        })}
        <LoadMorePartial parent={parent} />
      </>
    )
  },
  { match: "/" },
)
