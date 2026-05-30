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

import {
  parton,
  type RenderArgs,
  type ResolvedCell,
  type BoundCell,
  type CellValue,
  type PartialCtx,
} from "@parton/framework"
import { Frame } from "@parton/framework/lib/frame.tsx"
import { Badge } from "@parton/copies/components/ui/badge"
import { cn } from "@parton/copies/lib/utils"
import { LoadMore as LoadMoreClient, PageSentinel } from "../components/load-more.tsx"
import { PartialControls } from "../components/partial-controls.tsx"
import { SearchToggle, SearchInput, SearchDialog } from "../components/search.tsx"
import { pokemonCardCell, pokemonListCell, pokemonSearchCell } from "./pokemon-cells.ts"

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

// List/search cell values have their `pokemon_v2_pokemon` spread sites
// rewritten to per-card BoundCells (result → cells); the value types come
// straight off the cells inline (CellValue<typeof …>), no aliases.
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

// One per-card parton, fed a forwarded BoundCell. `compact` switches the
// search-dialog sizing; list cards are the larger default.
const PokemonCard = parton(function PokemonCardRender({
  item,
  compact,
}: { item: ResolvedCell<CellValue<typeof pokemonCardCell>>; compact?: boolean } & RenderArgs) {
  const p = item.value
  if (!p) return null
  const types = p.pokemon_v2_pokemontypes.map((t) => t.pokemon_v2_type?.name ?? "")
  const spriteUrl = extractSprite(p.pokemon_v2_pokemonsprites[0]?.sprites)
  return (
    <a
      href={`/pokemon/${p.id}`}
      className="block rounded-xl bg-card p-5 ring-1 ring-border/50 transition-colors hover:bg-muted"
    >
      {spriteUrl && (
        <img
          src={spriteUrl}
          alt={p.name}
          loading="lazy"
          className={compact ? "h-16 w-16" : "h-24 w-24"}
        />
      )}
      <h2 className={cn("capitalize", compact ? "mt-1 text-base" : "mt-2 text-lg")}>
        #{p.id} {p.name}
      </h2>
      <div className="mt-1 flex flex-wrap gap-1">
        {types.map((t) => (
          <TypeBadge key={t} type={t || "default"} />
        ))}
      </div>
    </a>
  )
})

// Forward a list of per-card BoundCells to PokemonCard partons.
function PokemonCardGrid({
  items,
  parent,
  compact,
  testId,
}: {
  items: ReadonlyArray<BoundCell<CellValue<typeof pokemonCardCell>>>
  parent: PartialCtx
  compact?: boolean
  testId?: string
}) {
  if (items.length === 0) return null
  const grid = (
    <div className={POKEMON_GRID}>
      {items.map((item) => (
        <PokemonCard key={String(item.args.id)} parent={parent} item={item} compact={compact} />
      ))}
    </div>
  )
  return testId ? <div data-testid={testId}>{grid}</div> : grid
}

function makeSearchArea(scope: "page" | "frame") {
  const Stage1 = parton(
    function Stage1Render({
      results,
      parent,
    }: { results: ResolvedCell<CellValue<typeof pokemonSearchCell>> } & RenderArgs) {
      const list = results.value?.pokemon_v2_pokemon ?? []
      if (list.length === 0) {
        return <p className="mt-4 text-sm text-muted-foreground">Start typing to search...</p>
      }
      return (
        <>
          <h3 className="mt-4 text-xs text-muted-foreground">Stage 1 — instant</h3>
          <PokemonCardGrid items={list} parent={parent} compact testId="stage-1-content" />
        </>
      )
    },
    { selector: `#${scope}-stage-1`, cache: {} },
  )

  const Stage2 = parton(
    async function Stage2Render({
      results,
      q,
      parent,
    }: { results: ResolvedCell<CellValue<typeof pokemonSearchCell>>; q: string } & RenderArgs) {
      if (!q) return null
      // Artificial delay — preserves the streaming-UX demo. Real
      // loads run instantly when storage is warm.
      await delay(1000)
      const list = results.value?.pokemon_v2_pokemon ?? []
      return (
        <div>
          <h3 className="text-xs text-muted-foreground">Stage 2 — 1s delay</h3>
          <PokemonCardGrid items={list} parent={parent} compact testId="stage-2-content" />
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
      parent,
    }: { results: ResolvedCell<CellValue<typeof pokemonSearchCell>>; q: string } & RenderArgs) {
      if (!q) return null
      await delay(2000)
      const list = results.value?.pokemon_v2_pokemon ?? []
      return (
        <div>
          <h3 className="text-xs text-muted-foreground">Stage 3 — 2s delay</h3>
          <PokemonCardGrid items={list} parent={parent} compact testId="stage-3-content" />
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
      parent,
    }: {
      page: number
      isFirst: boolean
      results: ResolvedCell<CellValue<typeof pokemonListCell>>
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
          <PokemonCardGrid items={list} parent={parent} />
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
          const offset = (page - 1) * 24
          return (
            <P
              key={`list-page-${page}`}
              parent={parent}
              results={pokemonListCell.with({ limit: 24, offset })}
            />
          )
        })}
        <LoadMorePartial parent={parent} />
      </>
    )
  },
  { match: "/" },
)
