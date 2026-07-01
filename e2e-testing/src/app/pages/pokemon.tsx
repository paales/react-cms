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
  searchParam,
  type RenderArgs,
  type ResolvedCell,
  type BoundCell,
  type CellValue,
  type PartialCtx,
  type PartonProps,
} from "@parton/framework"
import { Frame } from "@parton/framework/lib/frame.tsx"
import { Badge } from "@parton/copies/components/ui/badge"
import { cn } from "@parton/copies/lib/utils"
import { LoadMore as LoadMoreClient, PageSentinel } from "../components/load-more.tsx"
import { PartialControls } from "../components/partial-controls.tsx"
import { SearchToggle, SearchInput, SearchDialog } from "../components/search.tsx"
import { pokemonCardCell, pokemonListCell, pokemonSearchCell } from "./pokemon-cells.ts"

export function extractSprite(sprites: unknown): string | null {
  const s = sprites as {
    front_default?: string | null
    other?: { "official-artwork"?: { front_default?: string | null } | null } | null
  } | null
  return s?.other?.["official-artwork"]?.front_default ?? s?.front_default ?? null
}

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
          <Badge
            variant="secondary"
            className={cn(
              "rounded-full px-2.5 py-0.5 text-[0.7rem] font-semibold",
              {
                grass: "bg-emerald-900/60 text-emerald-200",
                fire: "bg-red-900/60 text-red-200",
                water: "bg-blue-900/60 text-blue-200",
                electric: "bg-amber-900/60 text-amber-100",
                normal: "bg-slate-800 text-slate-200",
                poison: "bg-purple-900/60 text-purple-200",
                bug: "bg-lime-900/60 text-lime-200",
                flying: "bg-indigo-900/60 text-indigo-200",
              }[t] ?? "bg-slate-800 text-slate-200",
            )}
          >
            {t}
          </Badge>
        ))}
      </div>
    </a>
  )
})

// Forward a list of per-card BoundCells to PokemonCard partons.
function PokemonCardGrid({
  items,
  compact,
  testId,
}: {
  items: ReadonlyArray<BoundCell<CellValue<typeof pokemonCardCell>>>
  compact?: boolean
  testId?: string
}) {
  if (items.length === 0) return null
  const grid = (
    <div className={"grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4"}>
      {items.map((item) => (
        <PokemonCard key={String(item.args.id)} item={item} compact={compact} />
      ))}
    </div>
  )
  return testId ? <div data-testid={testId}>{grid}</div> : grid
}

function makeSearchArea(scope: "page" | "frame") {
  // The three stages deliberately demonstrate the THREE ways a parton
  // can receive its query-dependent data — and that none of them grows
  // `?cached=` unbounded (the client commit prunes both client maps to
  // the live/parked tree on every refetch, so superseded entries the
  // client can no longer restore stop being advertised):
  //
  //   Stage 1 — CALL-SITE PROPS. The wrapper passes `results`/`q` as
  //     JSX props. Props hash into the effective React id
  //     (`*-stage-1:<hash>`), so each query is a fresh instance id; the
  //     prior id unmounts and is pruned. (Per-query remount — fine for
  //     ephemeral results.)
  //   Stage 2 — TRACKED SCHEMA READ + cell. `schema` reads `q` via
  //     `searchParam()` (a tracked read, folded into the fp) and binds
  //     the cell in one place. Stable id; `q` moves the fingerprint
  //     within one identity (fp-cap bounds it).
  //   Stage 3 — MATCH on the query. `match` names `?q=` so each query is
  //     a distinct matchKey of a stable id. `keepalive: false` so a
  //     superseded query's variant is NOT parked (an ephemeral search
  //     result isn't worth restoring) — it leaves the tree and is
  //     pruned, keeping matchKeys bounded.
  const offsets = { 1: 0, 2: 6, 3: 12 } as const
  const limits = { 1: 6, 2: 6, 3: 8 } as const
  const stageCell = (n: 1 | 2 | 3, q: string) =>
    pokemonSearchCell.with({ pattern: `%${q}%`, offset: offsets[n], limit: limits[n] })

  // Stage 1 — call-site props.
  const Stage1 = parton(
    function Stage1Render({
      results,
      q,
    }: { results: ResolvedCell<CellValue<typeof pokemonSearchCell>>; q: string } & RenderArgs) {
      const list = results.value?.pokemon_v2_pokemon ?? []
      // `data-q` records the query this committed tree was rendered
      // against; `data-count` the row count. A test reads them to prove
      // the committed stage matches the latest keystroke (a stale fire
      // clobbering a fresh one shows up as a `data-q` mismatch).
      if (list.length === 0) {
        // Empty box → prompt; a typed query that matched nothing → "No
        // results" (an empty list with a non-empty `q` is a real
        // zero-match, not the initial state).
        return (
          <p
            data-testid="stage-1"
            data-q={q}
            data-count={0}
            className="mt-4 text-sm text-muted-foreground"
          >
            {q ? "No results" : "Start typing to search..."}
          </p>
        )
      }
      return (
        <div data-testid="stage-1" data-q={q} data-count={list.length}>
          <h3 className="mt-4 text-xs text-muted-foreground">Stage 1 — instant (props)</h3>
          <PokemonCardGrid items={list} compact testId="stage-1-content" />
        </div>
      )
    },
    { selector: `#${scope}-stage-1`, cache: {} },
  )

  const Stage2 = parton(
    async function Stage2Render({
      results,
      q,
    }: PartonProps<{ results: ResolvedCell<CellValue<typeof pokemonSearchCell>>; q: string }>) {
      if (!q) return null
      // Artificial delay — preserves the streaming-UX demo. Real
      // loads run instantly when storage is warm.
      await delay(1000)
      const list = results.value?.pokemon_v2_pokemon ?? []
      return (
        <div data-testid="stage-2" data-q={q} data-count={list.length}>
          <h3 className="text-xs text-muted-foreground">Stage 2 — 1s delay (tracked schema read)</h3>
          <PokemonCardGrid items={list} compact testId="stage-2-content" />
        </div>
      )
    },
    {
      selector: `#${scope}-stage-2`,
      cache: {},
      // Tracked read in `schema` (pre-fp): `q` folds into the fp — and
      // the byte-cache key — from render 1, and binds the cell in the
      // same breath. The frame-scope placement reads the FRAME's url
      // (tracked hooks see the frame-resolved request, as `vary` did).
      schema: () => {
        const q = searchParam("q") ?? ""
        return { q, results: stageCell(2, q) }
      },
      fallback: (
        <div data-testid="stage-2-fallback" className="p-2 text-muted-foreground">
          Loading stage 2...
        </div>
      ),
    },
  )

  // Stage 3 — match on the query for VARIANT IDENTITY. `match` names
  // `?q=` so each query is a distinct matchKey of the stable
  // `*-stage-3` id; `keepalive: false` means a superseded query's
  // variant leaves the tree (not parked) and is pruned, keeping
  // matchKeys bounded. A tracked `searchParam("q")` in `schema` binds
  // the cell (the matched param drives identity, the read drives data).
  const Stage3 = parton(
    async function Stage3Render({
      results,
      q,
    }: PartonProps<{ results: ResolvedCell<CellValue<typeof pokemonSearchCell>>; q: string }>) {
      if (!q) return null
      await delay(2000)
      const list = results.value?.pokemon_v2_pokemon ?? []
      return (
        <div data-testid="stage-3" data-q={q} data-count={list.length}>
          <h3 className="text-xs text-muted-foreground">Stage 3 — 2s delay (match)</h3>
          <PokemonCardGrid items={list} compact testId="stage-3-content" />
        </div>
      )
    },
    {
      selector: `#${scope}-stage-3`,
      cache: {},
      keepalive: false,
      // `match` runs against the PAGE url only. At page scope, name `q`
      // for a per-query matchKey (URLPattern search matching is
      // positional over the whole query string, so the leading `*`
      // tolerates `?search=…&q=…`; `q` is last so greedy `:query`
      // captures it; absent `q` → no match → parks out). In a FRAME the
      // query lives on the frame url, which `match` can't see, so the
      // page-search `match` is omitted there and identity falls back to
      // the stable id (data still flows via the schema read below).
      ...(scope === "page" ? { match: { search: "*q=:query" } } : {}),
      // Same tracked-schema pattern as Stage 2 — the matched `:query`
      // drives IDENTITY (matchKey); the tracked read drives DATA.
      schema: () => {
        const q = searchParam("q") ?? ""
        return { q, results: stageCell(3, q) }
      },
      fallback: (
        <div data-testid="stage-3-fallback" className="p-2 text-muted-foreground">
          Loading stage 3...
        </div>
      ),
    },
  )

  function SearchBodyRender(_: RenderArgs) {
    // Tracked reads — the wrapper's own dependency surface is exactly
    // what its body reads: `?search` gates the dialog, `?q` feeds the
    // input + stage 1's props. Its DESCENDANTS' `?q` dependence rides
    // the descendant fold (their recorded deps re-read per request),
    // not this wrapper's reads.
    const search = searchParam("search")
    const q = searchParam("q") ?? ""
    if (search == null) return null
    // Three data-passing methods, one per stage (see definitions above):
    //   Stage 1 — call-site props: pass `results`/`q` here.
    //   Stage 2 — tracked schema read: self-sources `q`, no query props.
    //   Stage 3 — match: self-sources `q`, no query props.
    return (
      <SearchDialog open>
        <div data-testid="search-body" data-search-q={q} hidden />
        <SearchInput query={q} />
        <Stage1 q={q} results={stageCell(1, q)} />
        <Stage2 />
        <Stage3 />
      </SearchDialog>
    )
  }

  return parton(SearchBodyRender, {
    selector: scope === "page" ? "#search-page .search-results" : "#search .search-results",
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
          <PokemonCardGrid items={list} />
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
  function PokemonOverviewRender() {
    return (
      <>
        <HeaderPartial showControls={false} />
        <SearchAreaPage />
        <Frame name="search" initialUrl="/">
          <SearchAreaFrame />
        </Frame>
        {ListPagePartials.map((P, i) => {
          const page = i + 1
          const offset = (page - 1) * 24
          return (
            <P
              key={`list-page-${page}`}
              results={pokemonListCell.with({ limit: 24, offset })}
            />
          )
        })}
        <LoadMorePartial />
      </>
    )
  },
  { match: "/" },
)
