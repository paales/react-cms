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
 * tree is needed — position anywhere in the collection is row math,
 * client-side, zero round trips):
 *
 *  - LEAVES cover `leaf` consecutive items and are cull-gated: in
 *    view (within the observer runway) a leaf's body resolves its
 *    slice (`load({offset, limit})`) and renders items — each item
 *    a grid cell, ideally its own parton; out of view it's a shell
 *    of generic skeleton cells (`.parton-skel`, styled by app CSS)
 *    and its slice is never fetched. Leaves keep interval identity
 *    (`{o, n}` props), so scroll-back within the span restores
 *    parked content with zero fetch.
 *  - A leaf's cull SEED folds as a VERDICT, not a raw read: the
 *    anchor param is consumed through a re-evaluable reduced dep
 *    (`scroller-seed:` — the anchor-window intersection re-run at
 *    every fold, the same family as the `match:` dep kind), so an
 *    anchor move re-renders ONLY the leaves whose verdict flipped;
 *    every other leaf fp-skips and a scroll-back is a zero-byte
 *    confirm.
 *  - The RESERVATION shells are plain block spacers holding the rest
 *    of the collection's space with pure CSS arithmetic
 *    (`round(up, count / var(--scroller-cols)) * var(--scroller-row)`).
 *    When the viewport lands inside one it SELF-MATERIALIZES a local
 *    skeleton band the same frame — no server round trip to paint.
 *  - ONE writer moves the window: the anchor sync computes the item
 *    under the viewport center — throttled while scrolling (the
 *    anchor FOLLOWS the gesture; the span moves ahead of a sustained
 *    scroll) plus once at settle — and states it through the anchor
 *    param — silently when the landing
 *    is inside the placed span (culling handles materialization), as
 *    an IN-PLACE navigation (`scroll: "manual"`) when it is inside a
 *    reservation (the span must move). Window movement IS
 *    navigation: the URL stays honest, back/forward replay it.
 *
 * GEOMETRY IS CSS. The app's stylesheet declares three variables on
 * the collection's class (the `className` option — applied to the
 * wrapper, inherited by the grid and the reservations alike):
 *
 *     .browse-grid {
 *       --scroller-cols: 4;      /· responsive via media queries ·/
 *       --scroller-row: 252px;   /· the row ESTIMATE — like `sizes`:
 *                                   ideally exact, at least
 *                                   indication-grade ·/
 *       --scroller-gap: 12px;    /· column gap; row-gap stays 0 ·/
 *     }
 *
 * Rows are `minmax(--scroller-row, auto)` — ITEMS OWN THEIR HEIGHT;
 * the estimate is the floor and what reservations (and the scrollbar)
 * are sized from. Real heights come from layout, and the anchor sync
 * keeps the viewport pinned through every above-viewport change by
 * RE-ANCHORING on the public anchor ids (which survive span swaps
 * even when DOM nodes don't — same index, same id). The framework
 * never learns a pixel number; all three variables may be
 * media-/container-query responsive. Two alignment contracts: `leaf`
 * must be divisible by every `--scroller-cols` value (row-aligned
 * span edges), and `anchor.pageSize` must be a multiple of `leaf`
 * when overridden (page-aligned leaf boundaries).
 *
 * Pagination is a PROJECTION: `?page=N` (the anchor) is the cold
 * seed a deep link paints at, the shadow scrolling mirrors into, and
 * the window statement rides. A page is never a render unit. The
 * public anchor surface in the DOM: the wrapper carries `id=<name>`,
 * and each anchor-step boundary ITEM carries `id=<name>-p<N>` (flowed
 * through `render(...)`'s `id` prop — on the shell's first cell
 * while culled). The id sits on REAL content, so the browser resolves
 * its position from layout — correct under any heights — and the
 * deep-link script (streamed right after the anchored leaf, so it
 * runs the moment that markup parses) plus any external tooling
 * navigate by it; nothing else about the markup is contract.
 *
 * See `docs/reference/scroller.md`.
 */

import React, { Fragment, type ReactNode } from "react"
import { _buildPartial, type PartialOptions, type RenderArgs } from "./partial.tsx"
import { registerDepKind, searchParam } from "./server-hooks.ts"
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
 * The loader: one async function from a window request to items +
 * total — a collection's `load` the way a cell has `load`. Called in
 * `leaf`-aligned slices (`offset % leaf === 0`, `limit === leaf`), so
 * a page-shaped backend maps cleanly
 * (`currentPage: offset / limit + 1`).
 *
 * It runs inside parton bodies (the root's shape read, each leaf's
 * slice), so TRACKED READS WORK: resolve cells, read
 * `searchParam("q")` for a filter — the read records as the calling
 * parton's dep and the collection re-renders when it moves. The
 * tracking invariant applies: no untracked nondeterminism.
 */
export type ScrollerLoad<Item> = (window: {
  offset: number
  limit: number
}) => Promise<ScrollerWindow<Item>>

export interface ScrollerAnchor {
  /** URL search param carrying the anchored position. Default
   *  `"page"` — configure when two anchored collections share a
   *  page. */
  param?: string
  /** Items per anchor step (the derived page size). Defaults to
   *  `leaf`; when overridden, must be a multiple of `leaf`. */
  pageSize?: number
}

export interface ScrollerOptions<Item> {
  /** The collection's identity — catalog id stem, wire ids
   *  (`<name>`, `<name>-leaf`), the DOM anchor surface (`id=<name>`,
   *  `id=<name>-p<N>`). Explicit because there is no Render function
   *  to derive it from. */
  name: string
  load: ScrollerLoad<Item>
  /** The item renderer — one grid cell per item, props-bag style
   *  like a parton Render. Give each cell a stable key (the entity
   *  key), and make the cell its own parton when its content should
   *  invalidate per entity. `id` is the public anchor id on
   *  anchor-step boundary items (`<name>-p<N>`, absent otherwise) —
   *  put it on the cell (`id={id}`) so deep links target REAL
   *  content: the browser resolves the position from layout, correct
   *  under any heights or breakpoints. */
  render: (props: { item: Item; index: number; id?: string }) => ReactNode
  /** Items per leaf parton — also the `load` slice size and the
   *  default anchor step. Default 24. */
  leaf?: number
  /** Leaves PLACED on each side of the anchor leaf. Placement ≠
   *  materialization: placed leaves are cull-gated (skeleton cells
   *  until the viewport nears), but stay addressable so scroll-back
   *  parks/restores instead of refetching. Beyond the ring, the
   *  reservation shells take over. Default 6. */
  ring?: number
  /** Class for the wrapper — where the app's CSS declares
   *  `--scroller-cols`, `--scroller-row`, `--scroller-gap` (see the
   *  module header for the contract). */
  className?: string
  /** Observer runway for leaf materialization — how far beyond the
   *  viewport a leaf starts resolving. A number is px; a string is
   *  any IntersectionObserver margin length, where `%` is relative to
   *  the VIEWPORT height (so the runway scales with the screen).
   *  Default `"100%"` — one viewport ahead and behind. */
  rootMargin?: number | string
  /** Anchor wiring. Always on (window movement rides it); pass to
   *  rename the param or change the step. */
  anchor?: ScrollerAnchor
}

// ─── The seed verdict dep ──────────────────────────────────────────────
//
// A leaf's cold-state seed is "does my interval intersect the anchor
// window (padded one leaf)". Reading the anchor param RAW would make
// every leaf's fp move on every anchor write (a scroll-back would
// re-render instead of confirming); instead the seed consumes the
// param through this REDUCED dep — the encoded intersection re-runs
// against the current request at every fold, and only a flipped
// verdict moves a leaf's fp. Same family as the `match:` dep kind:
// the reduction rides the key, serializable and re-evaluable.
const seedVerdict = registerDepKind("scroller-seed", (name, request) => {
  const q = JSON.parse(name) as { p: string; s: number; pad: number; o: number; n: number }
  const url = new URL(request.url)
  const page = Math.max(1, Number(url.searchParams.get(q.p)) || 1)
  const a = (page - 1) * q.s
  return q.o < a + q.s + q.pad && q.o + q.n > Math.max(0, a - q.pad) ? "1" : "0"
})

// ─── The constructor ───────────────────────────────────────────────────

interface LeafProps {
  o: number
  n: number
  /** The public anchor id this leaf's FIRST item carries (boundary
   *  leaves only) — flowed to `item(...)` as `extra.anchorId`, and to
   *  the culled shell's first cell, so the target exists in both
   *  states. */
  aid?: string
}

export function scroller<Item>(opts: ScrollerOptions<Item>): React.ComponentType {
  const name = opts.name
  const leaf = opts.leaf ?? 24
  const ring = opts.ring ?? 6
  const rootMargin = opts.rootMargin ?? "100%"
  const anchorParam = opts.anchor?.param ?? "page"
  const anchorStep = opts.anchor?.pageSize ?? leaf

  if (!name) throw new Error("scroller: `name` is required — it is the collection's identity")
  if (leaf < 1 || ring < 1) throw new Error(`scroller "${name}": leaf and ring must be ≥ 1`)
  if (anchorStep % leaf !== 0) {
    throw new Error(`scroller "${name}": anchor.pageSize must be a multiple of leaf`)
  }

  /** Seed verdict for a leaf [o, o+n) — the reduced dep above. */
  function seedFor(o: number, n: number): boolean {
    return seedVerdict(JSON.stringify({ p: anchorParam, s: anchorStep, pad: leaf, o, n })) === "1"
  }

  // ── Leaf spec — resolves the slice, renders items as grid cells ──
  const LeafSpec = _buildPartial(
    Object.assign(
      async function LeafRender({ o, n, aid }: LeafProps & RenderArgs) {
        const { items } = await opts.load({ offset: o, limit: leaf })
        return (
          <>
            {items
              .slice(0, n)
              .map((it, i) =>
                opts.render({ item: it, index: o + i, ...(i === 0 && aid ? { id: aid } : {}) }),
              )}
          </>
        )
      } as (props: LeafProps & RenderArgs) => ReactNode,
      { displayName: `${name}-leaf` },
    ) as never,
    {
      cull: {
        rootMargin: `${typeof rootMargin === "number" ? `${rootMargin}px` : rootMargin} 0px`,
        seed: ({ o, n }: LeafProps) => seedFor(o, n),
        skeleton: ScrollerLeafShell,
      },
    } as PartialOptions<object>,
  ) as unknown as React.ComponentType<LeafProps>

  /** Place one leaf — bare; no wrapper participates in the markup. */
  /** Place one leaf — bare. A boundary leaf's placement carries the
   *  anchor id as a prop; the id lands on REAL content (the first
   *  item via `extra.anchorId`, or the shell's first cell while
   *  culled), so the browser resolves its position from layout —
   *  correct under any item heights or breakpoints. */
  function placeLeaf(o: number, n: number): ReactNode {
    const aid = o % anchorStep === 0 ? `${name}-p${o / anchorStep + 1}` : undefined
    // GEOMETRY-ATOMIC commits. A window move's fresh payload streams:
    // the root chunk commits (reservations resized, departing leaves
    // gone) before the NEW leaves' rows arrive — without a local
    // fallback each pending leaf commits as NOTHING, and an up-move's
    // whole new top span vanishes for a frame. The browser anchors on
    // the displaced kept content, the viewport teleports, the writer
    // reads a smaller page and states another move — a cascade to the
    // top (measured). The placement-level Suspense holds every pending
    // leaf's exact cells (n, and the boundary aid so the landing
    // script finds its target even mid-stream), so a torn commit never
    // changes geometry.
    // The Fragment carries the list key; the Suspense stays UNKEYED —
    // the client merge layer detects partial wrappers as KEYED
    // Suspense nodes, and a keyed placement Suspense would be adopted
    // as one (measured: parked pairs stopped restoring).
    return (
      <Fragment key={o}>
        <LeafSpec o={o} n={n} {...(aid !== undefined ? { aid } : {})} />
      </Fragment>
    )
  }

  // ── Root — reads anchor + shape, places span + reservations ──
  const RootSpec = _buildPartial(
    Object.assign(
      async function RootRender(_: RenderArgs) {
        const { total } = await opts.load({ offset: 0, limit: leaf })
        // The root's OWN anchor read is deliberately raw: the span's
        // placement depends on the exact value, so the root re-renders
        // per anchor move — one parton, plus the verdict-flipped
        // leaves; everything else fp-skips.
        const page = Math.max(1, Number(searchParam(anchorParam)) || 1)
        const anchorIdx = (page - 1) * anchorStep
        const anchorLeaf = Math.floor(anchorIdx / leaf) * leaf
        const start = Math.max(0, anchorLeaf - ring * leaf)
        const end = Math.min(Math.max(total, 0), anchorLeaf + (ring + 1) * leaf)

        // Deep-link landing for document loads: streamed IMMEDIATELY
        // AFTER the anchored leaf, so it runs the moment that markup
        // parses — a slow CPU paints at the anchor, not at the head
        // and then jumps. Inert on client navs (React never executes
        // dangerouslySetInnerHTML scripts); the client path is the
        // anchor sync's layout effect.
        const landingScript = (
          <script
            key="landing"
            dangerouslySetInnerHTML={{
              __html:
                `(function(){try{var p=+(new URLSearchParams(location.search).get(${JSON.stringify(anchorParam)})||1);` +
                `if(p>1){var e=document.getElementById(${JSON.stringify(name)}+"-p"+p);` +
                `if(e&&e.scrollIntoView)e.scrollIntoView({block:"start"})}}catch(_){}})()`,
            }}
          />
        )

        const cells: ReactNode[] = []
        for (let o = start; o < end; o += leaf) {
          cells.push(placeLeaf(o, Math.min(leaf, end - o)))
          if (o <= anchorIdx && anchorIdx < o + leaf) cells.push(landingScript)
        }

        return (
          <>
            {/* Native scroll anchoring stays ON for grid content —
                scrolling up through materializing leaves is the
                spec's designed case (content loading above pins the
                viewport). Only the RESERVATIONS opt out (below):
                anchoring onto a transient band skeleton was the
                measured teleport bug. The one case no browser can
                track — a span swap destroying and recreating the
                visible cells — is re-anchored by the framework via
                the index-derived ids. */}
            <div id={name} className={opts.className}>
              {start > 0 ? <ScrollerReservation key="res-before" count={start} /> : null}
              {/* The span's grid — template derived from the app's
                  variables (declared on the wrapper's class, so the
                  reservations inherit the same numbers). */}
              <div
                className="parton-scroller-grid"
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(var(--scroller-cols, 4), minmax(0, 1fr))",
                  gridAutoRows: "minmax(var(--scroller-row, 240px), auto)",
                  columnGap: "var(--scroller-gap, 0px)",
                }}
              >
                {cells}
              </div>
              {end < total ? <ScrollerReservation key="res-after" count={total - end} /> : null}
            </div>
            <ScrollerAnchorSync
              name={name}
              param={anchorParam}
              step={anchorStep}
              start={start}
              end={end}
              total={Math.max(total, 0)}
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
