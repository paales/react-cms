/**
 * `scroller(options)` — the windowed-collection constructor.
 *
 * A collection (catalog, listing, feed) rendered as ONE CSS grid:
 * a contiguous PLACED SPAN of leaf partons around the anchor, and
 * two RESERVATION shells covering everything before and after it.
 * Composed entirely from `parton()` + the cull gate — everything it
 * emits is ordinary partons, so fingerprints, fp-skip, refetch,
 * keepalive, and the live channel apply unchanged.
 *
 * The model (uniform rows make structure ARITHMETIC, so no recursive
 * tree is needed — position anywhere in the collection is one rect
 * read plus row math, client-side, zero round trips):
 *
 *  - LEAVES cover `leaf` consecutive items and are cull-gated: in
 *    view (within the observer runway) a leaf's body resolves its
 *    slice (`range({offset, limit})`) and renders items — each item
 *    a grid cell, ideally its own parton; out of view it's a shell
 *    of generic skeleton cells (`.parton-skel`, styled by app CSS)
 *    and its slice is never fetched. Leaves keep interval identity
 *    (`{o, n}` props), so scroll-back within the span restores
 *    parked content with zero fetch.
 *  - The RESERVATION shells are client components holding the rest
 *    of the collection's space with pure CSS arithmetic
 *    (`round(up, count / var(--scroller-cols)) * var(--scroller-row)`).
 *    When the viewport lands inside one (scrollbar jump, fast
 *    scroll past the span) it SELF-MATERIALIZES a local skeleton
 *    band the same frame — no server round trip to paint — and,
 *    once the scroll settles, states the landing through the anchor
 *    param (an ordinary replace navigation): the root re-renders
 *    with the span moved there. Window movement IS navigation, so
 *    the URL stays honest and back/forward replay it.
 *
 * GEOMETRY IS CSS. The app's stylesheet declares three variables on
 * the collection's class (the `className` option — applied to the
 * wrapper, inherited by the grid and the reservations alike):
 *
 *     .browse-grid {
 *       --scroller-cols: 4;      /· responsive via media queries ·/
 *       --scroller-row: 252px;   /· the row pitch — like `sizes` ·/
 *       --scroller-gap: 12px;    /· column gap; row-gap is always 0 —
 *                                   the pitch IS the vertical rhythm,
 *                                   spacing lives inside cells ·/
 *     }
 *
 * The framework builds the grid template from these and never learns
 * a pixel number; all three may be media-/container-query responsive,
 * and the reservations stay exact at every breakpoint because they
 * compute from the same variables. One alignment contract: `leaf`
 * must be divisible by every `--scroller-cols` value, so the span's
 * edges are row-aligned.
 *
 * Pagination is a PROJECTION: `?page=N` (the anchor) is the cold
 * seed a deep link paints at, the bookmarkable shadow scrolling
 * mirrors into, and the channel window movement rides. A page is
 * never a render unit.
 *
 * See `docs/reference/scroller.md`.
 */

import React, { type ReactNode } from "react"
import { _buildPartial, type PartialOptions, type RenderArgs } from "./partial.tsx"
import { searchParam } from "./server-hooks.ts"
import { ScrollerAnchorSync, ScrollerLeafShell, ScrollerReservation } from "./scroller-client.tsx"

// ─── Source contract ───────────────────────────────────────────────────

/** One resolved window of the collection. `total` is the size of the
 *  WHOLE collection as of this resolve — every slice restates it, and
 *  the root's read of it re-shapes the span/reservations when the
 *  collection grows. */
export interface ScrollerWindow<Item> {
  items: readonly Item[]
  total: number
}

/**
 * The source: one async function from a window request to items +
 * total. The scroller always asks in `leaf`-aligned slices
 * (`offset % leaf === 0`, `limit === leaf`), so a page-shaped backend
 * maps cleanly (`currentPage: offset / limit + 1`).
 *
 * Resolve your data through tracked reads (cells) inside — the read
 * IS the dependency: the leaf re-renders when its slice's cell
 * invalidates, the root when the collection's shape does. The
 * tracking invariant applies: no untracked nondeterminism.
 */
export type ScrollerRange<Item> = (window: {
  offset: number
  limit: number
}) => Promise<ScrollerWindow<Item>>

export interface ScrollerAnchor {
  /** URL search param carrying the anchored position. Default
   *  `"page"` — configure when two anchored collections share a
   *  page. */
  param?: string
  /** Items per anchor step (the derived page size). Defaults to
   *  `leaf`. */
  pageSize?: number
}

export interface ScrollerOptions<Item> {
  /** The collection's identity — catalog id stem, wire ids
   *  (`<name>`, `<name>-leaf`), the DOM marker (`data-s`). Explicit
   *  because there is no Render function to derive it from. */
  name: string
  range: ScrollerRange<Item>
  /** The item renderer — one grid cell per item. Give each cell a
   *  stable key (the entity key), and make the cell its own parton
   *  when its content should invalidate per entity. */
  item: (item: Item, index: number) => ReactNode
  /** Items per leaf parton — also the `range` fetch size and the
   *  default anchor step. Default 24. */
  leaf?: number
  /** Leaves PLACED on each side of the anchor leaf. Placement ≠
   *  materialization: placed leaves are cull-gated (skeleton cells
   *  until the viewport nears), but stay addressable so scroll-back
   *  parks/restores instead of refetching. Beyond the ring, the
   *  reservation shells take over. Default 6. */
  ring?: number
  /** Class for the grid container — where the app's CSS declares
   *  `display: grid`, `--scroller-cols`, `--scroller-row`, and the
   *  column template (see the module header for the contract). */
  className?: string
  /** Observer runway in px for leaf materialization. Default 600. */
  rootMargin?: number
  /** Anchor wiring. Always on (window movement rides it); pass to
   *  rename the param or change the step. */
  anchor?: ScrollerAnchor
}

// ─── The constructor ───────────────────────────────────────────────────

interface LeafProps {
  o: number
  n: number
}

export function scroller<Item>(opts: ScrollerOptions<Item>): React.ComponentType {
  const name = opts.name
  const leaf = opts.leaf ?? 24
  const ring = opts.ring ?? 6
  const rootMargin = opts.rootMargin ?? 600
  const anchorParam = opts.anchor?.param ?? "page"
  const anchorStep = opts.anchor?.pageSize ?? leaf

  if (!name) throw new Error("scroller: `name` is required — it is the collection's identity")
  if (leaf < 1 || ring < 1) throw new Error(`scroller "${name}": leaf and ring must be ≥ 1`)

  /** The anchored item index for the current request. Tracked read —
   *  runs inside the reading parton's context (root body, leaf
   *  seeds), recording the anchor as its dep. */
  function anchorIndex(): number {
    const page = Math.max(1, Number(searchParam(anchorParam)) || 1)
    return (page - 1) * anchorStep
  }

  /** Cold-seed verdict for a leaf [o, o+n): materialize before any
   *  measurement iff it intersects the anchor window padded by one
   *  leaf — the deep-link neighborhood paints server-side in one
   *  pass; the rest of the placed span stays skeleton cells until
   *  the client's observers flip it in. */
  function seedFor(o: number, n: number): boolean {
    const a = anchorIndex()
    return o < a + anchorStep + leaf && o + n > Math.max(0, a - leaf)
  }

  // ── Leaf spec — resolves the slice, renders items as grid cells ──
  //
  // The `display: contents` wrapper carries the interval marker
  // (`data-so`/`data-sn`) without participating in grid layout — the
  // items land as cells of the ONE outer grid. Marker geometry is
  // read off its children (a contents element has no box of its own).
  const LeafSpec = _buildPartial(
    Object.assign(
      async function LeafRender({ o, n }: LeafProps & RenderArgs) {
        const { items } = await opts.range({ offset: o, limit: leaf })
        return <>{items.slice(0, n).map((it, i) => opts.item(it, o + i))}</>
      } as (props: LeafProps & RenderArgs) => ReactNode,
      { displayName: `${name}-leaf` },
    ) as never,
    {
      cull: {
        rootMargin: `${rootMargin}px 0px`,
        seed: ({ o, n }: LeafProps) => seedFor(o, n),
        skeleton: ScrollerLeafShell,
      },
    } as PartialOptions<object>,
  ) as unknown as React.ComponentType<LeafProps>

  function placeLeaf(o: number, n: number): ReactNode {
    return (
      <div key={o} style={{ display: "contents" }} data-s={name} data-so={o} data-sn={n}>
        <LeafSpec o={o} n={n} />
      </div>
    )
  }

  // ── Root — reads anchor + shape, places span + reservations ──
  const RootSpec = _buildPartial(
    Object.assign(
      async function RootRender(_: RenderArgs) {
        const { total } = await opts.range({ offset: 0, limit: leaf })
        const anchorLeaf = Math.floor(anchorIndex() / leaf) * leaf
        const start = Math.max(0, anchorLeaf - ring * leaf)
        const end = Math.min(Math.max(total, 0), anchorLeaf + (ring + 1) * leaf)

        const leaves: ReactNode[] = []
        for (let o = start; o < end; o += leaf) {
          leaves.push(placeLeaf(o, Math.min(leaf, end - o)))
        }

        // Structure: block wrapper → [before spacer] → THE GRID
        // (span cells only) → [after spacer]. The reservations are
        // plain blocks OUTSIDE the grid — as grid items they'd sit
        // in one fixed `grid-auto-rows` track and overflow it (or
        // cost tens of thousands of implicit tracks as row spans).
        // Block spacers keep geometry exact with two elements, at
        // the price of one contract: `leaf % cols === 0`, so the
        // span's edges are row-aligned and the spacer heights are
        // exact.
        return (
          <>
            {/* overflow-anchor OFF for the whole collection: a span
                move swaps reservation-space for leaves at IDENTICAL
                height, but native scroll anchoring sees its anchor
                node destroyed and "compensates" — teleporting the
                viewport by the swapped height. Geometry here is exact
                by construction; anchoring can only misfire. */}
            <div
              className={opts.className}
              data-s={name}
              data-so={0}
              data-sn={total}
              data-sroot=""
              style={{ overflowAnchor: "none" }}
            >
              {start > 0 ? (
                <ScrollerReservation
                  key="res-before"
                  name={name}
                  base={0}
                  count={start}
                  param={anchorParam}
                  step={anchorStep}
                />
              ) : null}
              {/* The span's grid — template derived from the app's
                  variables (declared on the wrapper's class, so the
                  reservations inherit the same two numbers). */}
              <div
                data-sgrid=""
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(var(--scroller-cols, 4), minmax(0, 1fr))",
                  gridAutoRows: "var(--scroller-row, 240px)",
                  columnGap: "var(--scroller-gap, 0px)",
                }}
              >
                {leaves}
              </div>
              {end < total ? (
                <ScrollerReservation
                  key="res-after"
                  name={name}
                  base={end}
                  count={total - end}
                  param={anchorParam}
                  step={anchorStep}
                />
              ) : null}
            </div>
            <ScrollerAnchorSync name={name} param={anchorParam} step={anchorStep} />
            {/* Pre-hydration deep link: a fresh document load of
                ?page=N must paint AT the anchor, not at the head and
                then jump. Runs during HTML parse (the markers render
                above); inert on client navs (React never executes
                dangerouslySetInnerHTML scripts). Leaf markers are
                `display: contents`, so the scroll target is the
                marker's first child. */}
            <script
              dangerouslySetInnerHTML={{
                __html:
                  `(function(){try{var p=+(new URLSearchParams(location.search).get(${JSON.stringify(anchorParam)})||1);` +
                  `if(p>1){var t=(p-1)*${anchorStep},b=null;` +
                  `document.querySelectorAll('[data-s=${JSON.stringify(name)}][data-so]').forEach(function(e){` +
                  `var o=+e.dataset.so,n=+e.dataset.sn;` +
                  `if(t>=o&&t<o+n&&(b===null||n<+b.dataset.sn))b=e});` +
                  `var el=b&&(b.firstElementChild||b);if(el&&el.scrollIntoView)el.scrollIntoView({block:"start"})}}catch(_){}})()`,
              }}
            />
          </>
        )
      } as (props: RenderArgs) => ReactNode,
      { displayName: name },
    ) as never,
    {} as PartialOptions<object>,
  )

  return RootSpec as unknown as React.ComponentType
}
