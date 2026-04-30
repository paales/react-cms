/**
 * /pokemon/:id — Pokemon detail page.
 *
 * One outer wrapper spec matches the URL once; inner specs (Hero,
 * Stats, …) take `id` as a JSX prop and cast it to a number
 * themselves. No per-spec `match` repetition, no per-spec `vary`
 * for id-validation.
 */

import { ReactCms, type RenderArgs } from "@react-cms/framework"
import { client } from "../data.ts"
import { graphql } from "../pokeapi-graphql.ts"
import { notFound } from "@react-cms/framework/framework/errors.ts"
import { Card, CardContent } from "@react-cms/copies/components/ui/card"
import { Badge } from "@react-cms/copies/components/ui/badge"
import { cn } from "@react-cms/copies/lib/utils"
import { WhenVisible } from "../components/when-visible.tsx"
import { HeaderPartial, SearchAreaPage, SearchAreaFrame, extractSprite } from "./pokemon.tsx"

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
        }
      }
    }
  }
`)

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
// All take `id: string` from the wrapper and cast to a number themselves.
// No `match` (wrapper gates), no `vary` (id is supplied by the call site).

const Hero = ReactCms.partial(async function HeroRender({ id }: { id: string } & RenderArgs) {
  const pokemonId = Number(id)
  const data = await client.request(PokemonHeroQuery, { id: pokemonId })
  const pokemon = data.pokemon_v2_pokemon[0]
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

const Stats = ReactCms.partial(async function StatsRender({ id }: { id: string } & RenderArgs) {
  const pokemonId = Number(id)
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

const Species = ReactCms.partial(async function SpeciesRender({
  id,
}: { id: string } & RenderArgs) {
  const pokemonId = Number(id)
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
})

const LazySpacer = ReactCms.partial(function LazySpacerRender() {
  return <div className="h-[80vh]" data-testid="lazy-spacer" />
})

const Trivia = ReactCms.partial(
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

// ─── Outer wrapper — matches /pokemon/:id, threads id to children ─────

export const PokemonDetailPage = ReactCms.partial(
  function PokemonDetailRender({ id, parent }: { id: string } & RenderArgs) {
    return (
      <>
        <HeaderPartial parent={parent} showControls={true} />
        <SearchAreaPage parent={parent} />
        <SearchAreaFrame parent={parent} />
        <Hero parent={parent} id={id} />
        <Stats parent={parent} id={id} />
        <Species parent={parent} id={id} />
        <LazySpacer parent={parent} />
        <Trivia parent={parent} id={id} />
      </>
    )
  },
  { match: "/pokemon/:id" },
)
