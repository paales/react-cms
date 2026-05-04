/**
 * /inspect — stacked-drawer demo.
 *
 * Drills into a pokemon → its moves → a single move's detail through
 * three URL-stacked drawers. Each level is its own Partial; each
 * pushes a real browser history entry on open so:
 *
 *   - Browser back walks the stack (level 3 → 2 → 1 → base).
 *   - Refresh on any deep URL (`/inspect/p/25/moves/85`) re-renders
 *     every matching level server-side; the stack reconstructs.
 *   - Each URL is shareable + indexable; the page `<title>` reflects
 *     the deepest open drawer.
 *
 * Drawer chrome (vaul) stays mounted while we're on any `/inspect…`
 * path so the open/close animation actually plays — only the `open`
 * prop flips. See `components/stacked-drawer.tsx` for the smart-close
 * traverseTo-or-replace logic.
 */

import { ViewTransition } from "react"
import { ReactCms, type RenderArgs } from "@react-cms/framework"
import { client } from "../data.ts"
import { graphql, readFragment, type FragmentOf } from "../pokeapi-graphql.ts"
import { Card, CardContent } from "@react-cms/copies/components/ui/card"
import { Badge } from "@react-cms/copies/components/ui/badge"
import { buttonVariants } from "@react-cms/copies/components/ui/button"
import { cn } from "@react-cms/copies/lib/utils"
import {
  DrawerBackLink,
  DrawerScrollArea,
  StackedDrawer,
} from "../components/stacked-drawer.tsx"
import { extractSprite } from "./pokemon.tsx"

const GRID_LIMIT = 24

const TYPE_COLORS: Record<string, string> = {
  grass: "bg-emerald-900/60 text-emerald-200",
  fire: "bg-red-900/60 text-red-200",
  water: "bg-blue-900/60 text-blue-200",
  electric: "bg-amber-900/60 text-amber-100",
  normal: "bg-slate-800 text-slate-200",
  poison: "bg-purple-900/60 text-purple-200",
  bug: "bg-lime-900/60 text-lime-200",
  flying: "bg-indigo-900/60 text-indigo-200",
  ground: "bg-yellow-900/60 text-yellow-200",
  fairy: "bg-pink-900/60 text-pink-200",
  fighting: "bg-orange-900/60 text-orange-200",
  psychic: "bg-fuchsia-900/60 text-fuchsia-200",
  rock: "bg-stone-800 text-stone-200",
  ice: "bg-cyan-900/60 text-cyan-100",
  ghost: "bg-violet-900/60 text-violet-200",
  dragon: "bg-indigo-950 text-indigo-100",
  dark: "bg-zinc-900 text-zinc-200",
  steel: "bg-slate-700 text-slate-100",
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

// ─── GraphQL ────────────────────────────────────────────────────────────

const InspectListFields = graphql(`
  fragment InspectListFields on pokemon_v2_pokemon {
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

const InspectListQuery = graphql(
  `
    query InspectList($limit: Int!) {
      pokemon_v2_pokemon(limit: $limit, order_by: { id: asc }) {
        ...InspectListFields
      }
    }
  `,
  [InspectListFields],
)

const InspectPokemonQuery = graphql(`
  query InspectPokemon($id: Int!) {
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

const InspectMovesQuery = graphql(`
  query InspectMoves($id: Int!) {
    pokemon_v2_pokemonmove(
      where: { pokemon_id: { _eq: $id } }
      distinct_on: move_id
      limit: 30
      order_by: { move_id: asc }
    ) {
      pokemon_v2_move {
        id
        name
        power
        pp
        pokemon_v2_type {
          name
        }
        pokemon_v2_movedamageclass {
          name
        }
      }
    }
  }
`)

const InspectMoveDetailQuery = graphql(`
  query InspectMoveDetail($moveId: Int!) {
    pokemon_v2_move(where: { id: { _eq: $moveId } }, limit: 1) {
      id
      name
      power
      accuracy
      pp
      priority
      pokemon_v2_type {
        name
      }
      pokemon_v2_movedamageclass {
        name
      }
      pokemon_v2_moveeffect {
        pokemon_v2_moveeffecteffecttexts(
          where: { pokemon_v2_language: { name: { _eq: "en" } } }
          limit: 1
        ) {
          short_effect
          effect
        }
      }
    }
  }
`)

// ─── URL parsing helpers ────────────────────────────────────────────────

const INSPECT_PREFIX = "/inspect"

function parsePokemonId(pathname: string): string | null {
  const m = pathname.match(/^\/inspect\/p\/([^/]+)/)
  return m ? m[1] : null
}

function parseMovesOpen(pathname: string): string | null {
  const m = pathname.match(/^\/inspect\/p\/([^/]+)\/moves(?:$|\/)/)
  return m ? m[1] : null
}

function parseMoveId(pathname: string): { id: string; moveId: string } | null {
  const m = pathname.match(/^\/inspect\/p\/([^/]+)\/moves\/([^/]+)/)
  return m ? { id: m[1], moveId: m[2] } : null
}

// ─── Base page (always under the drawers) ───────────────────────────────

export const InspectBasePage = ReactCms.partial(
  async function InspectBasePageRender(_: RenderArgs) {
    const data = await client.request(InspectListQuery, { limit: GRID_LIMIT })
    return (
      <main className="py-4">
        <h1 className="mb-1 text-2xl font-semibold">Inspect Pokémon</h1>
        <p className="mb-4 max-w-prose text-sm text-muted-foreground">
          Click <strong>Inspect</strong> on any card. Drawer 1 (Pokémon) slides in from the{" "}
          <strong>left</strong>. Inside it, "View Moves" opens drawer 2 from the{" "}
          <strong>right</strong>. Inside drawer 2, clicking a move navigates <em>within the same
          drawer</em> to the move's detail page — no third drawer chrome. Each step pushes a real
          URL. Try{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 text-[0.85em]">/inspect/p/25/moves</code>{" "}
          or{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 text-[0.85em]">
            /inspect/p/25/moves/85
          </code>{" "}
          straight from the address bar to deep-link.
        </p>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
          {data.pokemon_v2_pokemon.map((raw) => (
            <PokemonGridCard key={readFragment(InspectListFields, raw).id} raw={raw} />
          ))}
        </div>
      </main>
    )
  },
  {
    selector: "#inspect-base",
    match: "/inspect/*",
  },
)

function PokemonGridCard({ raw }: { raw: FragmentOf<typeof InspectListFields> }) {
  const p = readFragment(InspectListFields, raw)
  const sprite = extractSprite(p.pokemon_v2_pokemonsprites[0]?.sprites)
  const types = p.pokemon_v2_pokemontypes.map((t) => t.pokemon_v2_type?.name ?? "")
  return (
    <Card className="p-4">
      <CardContent className="flex flex-col items-center gap-2 px-0 text-center">
        {sprite ? <img src={sprite} alt={p.name} loading="lazy" className="h-20 w-20" /> : null}
        <div>
          <div className="text-xs text-muted-foreground">#{p.id}</div>
          <div className="text-base capitalize">{p.name}</div>
        </div>
        <div className="flex flex-wrap justify-center gap-1">
          {types.map((t) => (
            <TypeBadge key={t} type={t || "default"} />
          ))}
        </div>
        <a
          href={`/inspect/p/${p.id}`}
          data-testid={`inspect-open-${p.id}`}
          className={cn(buttonVariants({ variant: "outline", size: "sm" }), "mt-1")}
        >
          🔍 Inspect
        </a>
      </CardContent>
    </Card>
  )
}

// ─── Drawer 1 — pokemon overview ────────────────────────────────────────

const PokemonOverviewContent = ReactCms.partial(
  async function PokemonOverviewContentRender({ id }: { id: string } & RenderArgs) {
    const pokemonId = Number(id)
    if (!Number.isFinite(pokemonId)) return <p>Invalid pokemon id.</p>
    const data = await client.request(InspectPokemonQuery, { id: pokemonId })
    const p = data.pokemon_v2_pokemon[0]
    if (!p) return <p>Pokemon not found.</p>
    const sprite = extractSprite(p.pokemon_v2_pokemonsprites[0]?.sprites)
    const types = p.pokemon_v2_pokemontypes.map((t) => ({
      slot: t.slot,
      name: t.pokemon_v2_type?.name ?? "",
    }))
    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          {sprite ? <img src={sprite} alt={p.name} className="h-32 w-32" /> : null}
          <div className="space-y-1">
            <div className="text-sm text-muted-foreground">#{p.id}</div>
            <div className="text-2xl font-semibold capitalize">{p.name}</div>
            <div className="flex flex-wrap gap-1">
              {types.map((t) => (
                <TypeBadge key={t.slot} type={t.name || "default"} />
              ))}
            </div>
          </div>
        </div>
        <dl className="grid grid-cols-2 gap-2 rounded-md border bg-muted/30 p-3 text-sm">
          <div>
            <dt className="text-xs uppercase text-muted-foreground">Height</dt>
            <dd>{(p.height ?? 0) / 10} m</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-muted-foreground">Weight</dt>
            <dd>{(p.weight ?? 0) / 10} kg</dd>
          </div>
        </dl>
        <a
          href={`/inspect/p/${id}/moves`}
          data-testid="drawer-1-view-moves"
          className={cn(buttonVariants({ variant: "default" }))}
        >
          View Moves →
        </a>
        <p className="text-xs text-muted-foreground">
          This drawer's URL is <code>/inspect/p/{id}</code>. The full-page version lives at{" "}
          <a href={`/pokemon/${id}`} className="underline hover:text-foreground">
            /pokemon/{id}
          </a>{" "}
          — same data, different chrome.
        </p>
      </div>
    )
  },
  {
    selector: "#drawer-1-content",
  },
)

export const InspectDrawer1 = ReactCms.partial(
  function InspectDrawer1Render({
    id,
    parent,
  }: { id: string | null } & RenderArgs) {
    return (
      <StackedDrawer
        level={1}
        direction="left"
        open={id != null}
        closeUrl={INSPECT_PREFIX}
        title={id ? `Pokémon #${id}` : "Pokémon"}
        description="Drawer 1 · slides from left · /inspect/p/:id"
      >
        {id != null ? (
          <div className="flex-1 overflow-y-auto px-4 py-3">
            <PokemonOverviewContent parent={parent} id={id} />
          </div>
        ) : null}
        {id != null ? <title>Inspect — Pokémon #{id}</title> : null}
      </StackedDrawer>
    )
  },
  {
    selector: "#drawer-1",
    vary: ({ pathname }) => {
      if (!pathname.startsWith(INSPECT_PREFIX)) return null
      return { id: parsePokemonId(pathname) }
    },
  },
)

// ─── Drawer 2 — moves list AND move detail (in-drawer navigation) ──────
//
// Drawer 2 stays open whenever the URL is `/inspect/p/:id/moves` OR
// `/inspect/p/:id/moves/:moveId`. The drawer's BODY swaps between the
// list view and the detail view based on whether `:moveId` is present.
// No second drawer chrome — clicking a move navigates "deeper" inside
// the same drawer; the back link returns to the list. Each step
// pushes a real URL so browser back/forward + refresh still work.

const PokemonMovesContent = ReactCms.partial(
  async function PokemonMovesContentRender({ id }: { id: string } & RenderArgs) {
    const pokemonId = Number(id)
    if (!Number.isFinite(pokemonId)) return <p>Invalid pokemon id.</p>
    const data = await client.request(InspectMovesQuery, { id: pokemonId })
    if (data.pokemon_v2_pokemonmove.length === 0) {
      return <p>No moves found for this pokemon.</p>
    }
    return (
      <ul className="space-y-2">
        {data.pokemon_v2_pokemonmove.map((entry) => {
          const m = entry.pokemon_v2_move
          if (!m) return null
          return (
            <li key={m.id}>
              <a
                href={`/inspect/p/${id}/moves/${m.id}`}
                data-testid={`drawer-2-move-${m.id}`}
                className="flex items-center justify-between rounded-md border bg-card p-3 transition-colors hover:bg-muted"
              >
                <div className="flex flex-col">
                  <span className="capitalize">{m.name.replace(/-/g, " ")}</span>
                  <span className="text-xs text-muted-foreground">
                    {m.pokemon_v2_movedamageclass?.name ?? "—"} · power {m.power ?? "—"} · pp{" "}
                    {m.pp ?? "—"}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <TypeBadge type={m.pokemon_v2_type?.name || "default"} />
                  <span className="text-muted-foreground">→</span>
                </div>
              </a>
            </li>
          )
        })}
      </ul>
    )
  },
  {
    selector: "#drawer-2-list",
  },
)

const MoveDetailContent = ReactCms.partial(
  async function MoveDetailContentRender({
    id,
    moveId,
  }: { id: string; moveId: string } & RenderArgs) {
    const numId = Number(moveId)
    if (!Number.isFinite(numId)) return <p>Invalid move id.</p>
    const data = await client.request(InspectMoveDetailQuery, { moveId: numId })
    const move = data.pokemon_v2_move[0]
    if (!move) return <p>Move not found.</p>
    const effect = move.pokemon_v2_moveeffect?.pokemon_v2_moveeffecteffecttexts[0]
    return (
      <div className="space-y-4">
        <DrawerBackLink
          href={`/inspect/p/${id}/moves`}
          label="Back to moves"
          testId="drawer-2-back"
        />
        <header>
          <div className="text-xs text-muted-foreground">Move #{move.id}</div>
          <div className="text-2xl font-semibold capitalize">
            {move.name.replace(/-/g, " ")}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <TypeBadge type={move.pokemon_v2_type?.name || "default"} />
            {move.pokemon_v2_movedamageclass?.name ? (
              <Badge variant="outline" className="text-[0.7rem]">
                {move.pokemon_v2_movedamageclass.name}
              </Badge>
            ) : null}
          </div>
        </header>
        <dl className="grid grid-cols-2 gap-2 rounded-md border bg-muted/30 p-3 text-sm">
          <Stat label="Power" value={move.power} />
          <Stat label="Accuracy" value={move.accuracy} suffix="%" />
          <Stat label="PP" value={move.pp} />
          <Stat label="Priority" value={move.priority} />
        </dl>
        {effect ? (
          <section className="space-y-1.5">
            <h3 className="text-sm font-semibold">Effect</h3>
            <p className="text-sm text-muted-foreground">{effect.short_effect}</p>
            {effect.effect && effect.effect !== effect.short_effect ? (
              <p className="text-xs italic text-muted-foreground/80">
                {effect.effect.replace(/\$effect_chance/g, "X")}
              </p>
            ) : null}
          </section>
        ) : null}
      </div>
    )
  },
  {
    selector: "#drawer-2-detail",
  },
)

export const InspectDrawer2 = ReactCms.partial(
  function InspectDrawer2Render({
    id,
    moveId,
    parent,
  }: { id: string | null; moveId: string | null } & RenderArgs) {
    const open = id != null
    const closeUrl = id ? `/inspect/p/${id}` : INSPECT_PREFIX
    const title = !open
      ? "Moves"
      : moveId
        ? `Move #${moveId}`
        : `Moves of #${id}`
    const description = moveId
      ? "Drawer 2 · move detail · /inspect/p/:id/moves/:moveId"
      : "Drawer 2 · slides from right · /inspect/p/:id/moves"
    return (
      <StackedDrawer
        level={2}
        direction="right"
        open={open}
        closeUrl={closeUrl}
        title={title}
        description={description}
      >
        {open ? (
          <ViewTransition name="drawer-2-page">
            {/* Two responsibilities on this wrapper:
             *   1. `flex-1 min-h-0 overflow-hidden` so the snapshot is
             *      bounded to the drawer body's visible height — without
             *      it, the view-transition pseudo captures all overflow
             *      content (full moves list at 2000+ px) and bleeds past
             *      the drawer's bottom during the slide.
             *   2. `bg-popover` so the snapshot is opaque. Vaul's
             *      drawer body sets the popover bg, but the wrapper is
             *      transparent by default; combined with the default
             *      `mix-blend-mode: plus-lighter` on `::view-transition-old/new`,
             *      a transparent shorter snapshot lets the taller
             *      sibling bleed through. Solid bg blocks that. */}
            <div
              className="flex-1 min-h-0 overflow-hidden bg-popover"
              data-drawer-page={moveId ? "detail" : "list"}
            >
              {/* Distinct scroll keys per page so the moves list and
               * the move detail keep independent scroll positions on
               * back/forward. The framework reads/writes the position
               * onto the Navigation entry state. */}
              <DrawerScrollArea
                scrollKey={moveId ? `drawer-2-detail-${moveId}` : "drawer-2-list"}
              >
                {moveId ? (
                  <MoveDetailContent parent={parent} id={id!} moveId={moveId} />
                ) : (
                  <PokemonMovesContent parent={parent} id={id!} />
                )}
              </DrawerScrollArea>
            </div>
          </ViewTransition>
        ) : null}
        {open && moveId ? <title>Inspect — Move #{moveId}</title> : null}
        {open && !moveId ? <title>Inspect — Moves of #{id}</title> : null}
      </StackedDrawer>
    )
  },
  {
    selector: "#drawer-2",
    vary: ({ pathname }) => {
      if (!pathname.startsWith(INSPECT_PREFIX)) return null
      const m = parseMoveId(pathname)
      if (m) return { id: m.id, moveId: m.moveId }
      return { id: parseMovesOpen(pathname), moveId: null }
    },
  },
)

function Stat({
  label,
  value,
  suffix,
}: {
  label: string
  value: number | null | undefined
  suffix?: string
}) {
  return (
    <div>
      <dt className="text-xs uppercase text-muted-foreground">{label}</dt>
      <dd>
        {value == null ? "—" : value}
        {value != null && suffix ? suffix : ""}
      </dd>
    </div>
  )
}
