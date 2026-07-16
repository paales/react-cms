/**
 * /pokemon/:id — Pokemon detail page.
 *
 * Hero / Stats / Species partons each read a gqlCell (see
 * pokemon-cells.ts) bound to the placement's `id`. The outer wrapper
 * constructs `cell.with({id})` once per child and passes the bound
 * cell as a JSX prop — the framework auto-resolves into a
 * ResolvedCell before Render. Storage caches per id; revisiting the
 * same pokemon skips the upstream call.
 */

import { parton, notFound, tag, type RenderArgs, type ResolvedCell } from "@parton/framework"
import type { ResultOf } from "../pokeapi.ts"
import { Frame } from "@parton/framework"
import { Card, CardContent } from "@parton/copies/components/ui/card"
import { Badge } from "@parton/copies/components/ui/badge"
import { cn } from "@parton/copies/lib/utils"
import { WhenVisible } from "../components/when-visible.tsx"
import { HeaderPartial, SearchAreaPage, SearchAreaFrame, extractSprite } from "./pokemon.tsx"
import { pokemonHeroCell, pokemonStatsCell, pokemonSpeciesCell } from "./pokemon-cells.ts"

// Derive each result type from the cell's value type. A cell's `load`
// is optional on `CellInterface<T>` (localCell / fragmentCell have none), so
// `ReturnType<typeof cell.load>` can't be used — `load` widens to
// `… | undefined`, which fails `ReturnType`'s callable constraint.
// `cell.defaultValue` is `TResult | null`; strip the null.
type HeroResult = NonNullable<typeof pokemonHeroCell.defaultValue>
type StatsResult = NonNullable<typeof pokemonStatsCell.defaultValue>
type SpeciesResult = NonNullable<typeof pokemonSpeciesCell.defaultValue>

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

// ─── Inner specs ────────────────────────────────────────────────────────
// Each receives a bound gqlCell as a JSX prop. The framework resolves
// it before Render (running the GraphQL query on cold-start, hitting
// storage on warm reads).

const Hero = parton(function PokemonHeroRender({
  hero,
}: { hero: ResolvedCell<HeroResult | null> } & RenderArgs) {
  // Event-shaped refresh: the demo controls bump "hero" and this
  // parton re-renders (see PartialControls).
  tag("hero")
  const pokemon = hero.value?.pokemon_v2_pokemon[0]
  if (!pokemon) notFound()
  const { name, height, weight } = pokemon
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
            #{pokemon.id} {name}
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
})

const Stats = parton(function StatsRender({
  stats,
}: { stats: ResolvedCell<StatsResult | null> } & RenderArgs) {
  tag("stats")
  const pokemon = stats.value?.pokemon_v2_pokemon[0]
  if (!pokemon) return null
  const list = pokemon.pokemon_v2_pokemonstats.map((s) => ({
    name: s.pokemon_v2_stat?.name ?? "",
    value: s.base_stat,
  }))
  const maxStat = 255
  return (
    <Card className="mb-4 p-5">
      <CardContent className="flex flex-col gap-2 px-0">
        <h2 className="text-lg font-semibold">Base Stats</h2>
        {list.map((stat) => {
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
                  style={{ width: `${(stat.value / maxStat) * 100}%` }}
                />
              </div>
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
})

const Species = parton(function SpeciesRender({
  species,
}: { species: ResolvedCell<SpeciesResult | null> } & RenderArgs) {
  tag("species")
  const speciesData = species.value?.pokemon_v2_pokemon[0]?.pokemon_v2_pokemonspecy
  if (!speciesData) return null
  const englishEntry = speciesData.pokemon_v2_pokemonspeciesflavortexts[0]
  return (
    <Card className="mb-4 p-5">
      <CardContent className="px-0">
        <h2 className="text-lg font-semibold capitalize">Species: {speciesData.name}</h2>
        {englishEntry && (
          <p className="mt-3 leading-relaxed text-foreground/80">
            {englishEntry.flavor_text.replace(/\f|\n/g, " ")}
          </p>
        )}
        <div className="mt-4 text-sm text-muted-foreground">
          Generation:{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 text-[0.85em] font-mono">
            {speciesData.pokemon_v2_generation?.name}
          </code>{" "}
          · Base Happiness:{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 text-[0.85em] font-mono">
            {speciesData.base_happiness}
          </code>{" "}
          · Capture Rate:{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 text-[0.85em] font-mono">
            {speciesData.capture_rate}
          </code>
        </div>
      </CardContent>
    </Card>
  )
})

const LazySpacer = parton(function LazySpacerRender() {
  return <div className="h-[80vh]" data-testid="lazy-spacer" />
})

const Trivia = parton(
  async function TriviaRender({ id }: { id: string } & RenderArgs) {
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
            <code className="rounded bg-muted px-1.5 py-0.5 text-[0.85em] font-mono">{id}</code>.
          </div>
        </CardContent>
      </Card>
    )
  },
  {
    defer: <WhenVisible />,
    fallback: (
      <Card data-testid="trivia-fallback" className="mb-4 p-5">
        <CardContent className="px-0 italic text-muted-foreground">Loading trivia…</CardContent>
      </Card>
    ),
  },
)

// ─── Outer wrapper — matches /pokemon/:id, threads bound cells to children ─

export const PokemonDetailPage = parton(
  function PokemonDetailRender({ id }: { id: string } & RenderArgs) {
    const pokemonId = Number(id)
    return (
      <>
        <HeaderPartial showControls={true} />
        <SearchAreaPage />
        <Frame name="search" initialUrl="/">
          <SearchAreaFrame />
        </Frame>
        <Hero hero={pokemonHeroCell.with({ id: pokemonId })} />
        <Stats stats={pokemonStatsCell.with({ id: pokemonId })} />
        <Species species={pokemonSpeciesCell.with({ id: pokemonId })} />
        <LazySpacer />
        <Trivia id={id} />
      </>
    )
  },
  { match: "/pokemon/:id" },
)
