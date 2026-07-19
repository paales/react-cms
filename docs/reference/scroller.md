# scroller() — windowed collections

`scroller(options)` renders a collection (catalog, listing, feed) as
**one CSS grid with a placed span of leaf partons around the anchor,
and two reservation shells covering everything else**. It is a
constructor composed around `parton()` + the `cull` gate: everything
it emits is ordinary partons, so fingerprints, fp-skip, refetch,
keepalive, and the live channel apply unchanged.

The model's premise: **a row ESTIMATE makes unmaterialized structure
arithmetic** — position anywhere in a million-item collection is one
rect read plus row math, client-side, zero round trips (pinned by
`scroller-scale.spec.ts` against a synthetic 1,000,000-item source) —
while MATERIALIZED content owns its real height, measured by layout,
with the viewport pinned through every change (native scroll
anchoring + the framework's id-referenced backstop).

```tsx
const BrowseGrid = scroller({
  name: "browse-grid",
  load: async ({ offset, limit }) => {
    const q = searchParam("q") // a FILTER is a tracked read in the loader
    const res = await browseProductsCell.resolve({
      pageSize: limit,
      currentPage: offset / limit + 1,
      ...(q ? { search: q } : {}),
    })
    return { items: itemsOf(res), total: totalOf(res) }
  },
  render: ({ item, id }) => <BrowseCard key={String(item.args.uid)} item={item} anchorId={id} />,
  leaf: 12,
  className: "browse-grid",
})
// placement: <BrowseGrid />
```

```css
/* The app's entire geometry contract — three variables: */
.browse-grid {
  --scroller-cols: 4; /* integer; responsive via media queries   */
  --scroller-row: 252px; /* the row pitch — like `sizes` on an img */
  --scroller-gap: 12px; /* column gap (row-gap is always 0)       */
}
@media (max-width: 640px) {
  .browse-grid {
    --scroller-cols: 2;
  }
}
```

Worked demos: `/magento/browse` (per-item entity cells),
the pokedex on `/` (fragment-cell forwarding), `/scale` (the million).

## The division of labor

- **The span** — `2·ring + 1` leaf partons placed around the anchor
  leaf. Each covers `leaf` consecutive items and is cull-gated: in
  view it resolves its slice (`load({offset, limit})`) and renders
  items as grid cells; out of view it emits generic skeleton cells
  (`.parton-skel`, styled by app CSS) and its slice is **never
  fetched**. Leaves keep interval identity (`{o, n}` props), so
  scrolling back within the span parks/restores with zero fetch.
- **The reservations** — two plain block spacers (deliberately not
  grid items) holding the rest of the collection's space with pure
  CSS arithmetic:
  `round(up, count / var(--scroller-cols)) · var(--scroller-row)`.
  Exact at every breakpoint, before hydration, zero JS.
- **Items own content.** Make each cell its own parton bound to a
  per-entity cell (compose a fragment cell into the slice query) —
  order lives on the slice, content on the entity: a re-sorted slice
  moves placements without re-shipping card bytes, and one product's
  invalidation re-lanes one card wherever it appears.
- **Pagination is a projection.** `?page=N` (the `anchor`) is the
  cold seed a deep link paints at server-side in ONE pass, the
  bookmarkable shadow scrolling mirrors into, and the statement
  window movement rides. A page is never a render unit.
- **The seed folds a VERDICT, not a raw read.** A leaf's cold-state
  seed consumes the anchor through the `scroller-seed:` reduced dep —
  the anchor-window intersection, serializable in the key and re-run
  at every fold (the `match:` dep-kind family). An anchor move
  re-renders the root and the verdict-flipped leaves ONLY; every
  other leaf holds its fp, so scroll-back is a zero-byte confirm
  (pinned by test).
- **ONE writer, measure-first, following along.** The anchor sync
  runs THROTTLED while scrolling (250ms) plus once at settle — a
  sustained scroll never stops emitting events, so a pure debounce
  would freeze the param mid-gesture and let the user outrun the ring
  into skeletons; following along means `?page=` advances
  consecutively (94 → 95 → 96) and the span moves ahead of the
  scroll. It derives item-under-center from LAYOUT where content
  exists (the hit cell — or, since the center routinely lands in a
  gap or margin band, the laid-out cell at center height — walked
  back to the nearest boundary anchor id, correct under any item
  heights or breakpoints) and from row arithmetic only inside
  reservations (nothing exists there to measure). It states the
  landing silently in-span (bookmarkability only — culling follows
  the viewport on its own), as an in-place navigation
  (`scroll: "manual"`) when the span must move. Occlusion-guarded —
  an overlay covering the collection silences it.
- **Window moves are geometry-atomic — they commit as transitions.**
  The in-place window statement carries the `FrameworkInPlaceInfo`
  brand, and the page-level intercept states it on the channel as an
  ATOMIC-SWAP commit (`streaming: false`): React holds the current
  tree until the move's payload fully resolves, then swaps once.
  Without that, the move's raw progressive commit lands the root
  chunk (reservations resized, departing leaves gone) before the new
  leaves' rows arrive — an up-move's new top span vanishes for a
  frame, the browser anchors on displaced content, the writer reads a
  smaller page, states another move, and cascades to the top
  (measured); and a same-span re-render re-suspends mounted leaves,
  blinking the visible cards to nothing at every page transition
  (measured, the user report). The commit-mode wish survives the
  statement's supersede (the next throttled write aborts the
  in-flight nav record; the segment still lands atomic — see
  `internals/channel.md`). And because a move keeps every ITEM
  at its document offset while the grid container's own edge shifts,
  the sync suppresses native scroll anchoring for exactly the move
  commit's layout flush — anchoring must not "compensate" an
  arithmetic no-op. Pinned by the prod-tier
  `e2e/preview/scroller-no-blink.spec.ts` (the blink and shift
  mechanisms only reproduce against the production bundle's streaming
  timing).
- **The anchor surface is real content.** Anchor-step boundary items
  receive `id` (`<name>-p<N>`) through `render(...)` — the app puts
  it on the cell; the culled shell carries it on its first cell, so
  the target exists in both states. Deep links resolve their
  position from layout, never from computation.

## The scrollbar jump (why there is no tree)

Landing anywhere — a scrollbar drag to 50% of a million items —
resolves in three steps, none of which asks the server about
structure:

1. **Position is arithmetic.** The client reads the reservation's
   rect once; rows × columns give the exact item index under the
   viewport. The URL mirror stays honest even in unrendered
   territory.
2. **Paint is local.** The reservation self-materializes: it renders
   a viewport-sized band of skeleton cells inside itself (absolute,
   column-aligned with the real grid via its resolved template) the
   same frame the scroll lands. Scrubbing the scrollbar just moves
   the band.
3. **Data is one statement.** The anchor sync states the landing
   through the anchor param — at the next throttle tick (at most
   250ms, even mid-gesture), and once more at settle — an in-place
   `history: "replace"` navigation (`scroll: "manual"`, so the
   browser's deferred default scroll can never fire against a live
   gesture). The root re-renders with the span moved there; the
   seeded neighborhood's content replaces the skeletons in place.
   Document height and scroll position are untouched throughout
   (pinned).

A recursive interval tree (the demo world's quadtree, this design's
predecessor) answers "what structure is here?" with one round trip
per level. Uniform rows make the question client-computable, so the
tree earns nothing for 1D collections. The world keeps its quadtree —
its plane is 2D px space with procedural content, a different animal.

## Options

| Option       | Default    | Meaning                                                                                                                                                                                 |
| ------------ | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`       | (required) | Identity: catalog ids (`<name>`, `<name>-leaf`), the public DOM anchors (`id=<name>`, `id=<name>-p<N>`). Explicit — there is no Render name to derive it from.                          |
| `load`       | (required) | `({offset, limit}) → {items, total}`. Called in `leaf`-aligned slices. Tracked reads (cells, `searchParam`) record as deps.                                                             |
| `render`     | (required) | `({item, index, id}) → ReactNode` — one grid cell, props-bag style. Apply `id` to the cell (boundary anchor). `Item` infers from `load`.                                                |
| `leaf`       | `24`       | Items per leaf parton = fetch slice = default anchor step. **Must be divisible by every `--scroller-cols` value** (row alignment).                                                      |
| `ring`       | `6`        | Leaves placed each side of the anchor leaf. Placement ≠ materialization — the ring is the park/restore zone.                                                                            |
| `className`  | —          | The wrapper class carrying the three CSS variables.                                                                                                                                     |
| `rootMargin` | `"100%"`   | Leaf materialization runway. Number = px; string = any observer margin, `%` relative to VIEWPORT height — the default is one viewport ahead/behind, so prefetch scales with the screen. |
| `anchor`     | `page`     | `{param?, pageSize?}` — rename the param (two collections on one page) or change the step (a multiple of `leaf`).                                                                       |

## The CSS contract

The app declares three custom properties on the collection's class
(the framework builds the grid template from them and never learns a
pixel):

- `--scroller-cols` — integer column count. Responsive via
  media/container queries. Every value must divide `leaf`.
- `--scroller-row` — the row ESTIMATE, and the floor
  (`minmax(estimate, auto)`): the `sizes`-like declaration — ideally
  exact, at least indication-grade. Reservations, the scrollbar, and
  unmaterialized space are sized from it.
- `--scroller-gap` — column gap. Row-gap is always 0: the estimate IS
  the vertical rhythm baseline; vertical spacing lives inside cells.

**Items own their height.** Real heights come from layout, and the
viewport stays pinned through every above-viewport change by three
mechanisms: native CSS scroll anchoring handles content growing
inside kept nodes (reservations opt out — anchoring onto a transient
band skeleton was a measured teleport bug; and the sync suppresses
anchoring for exactly a window-move commit's layout flush, where the
grid container's edge moves while every item stays put); the
framework's id-referenced backstop handles NODE REPLACEMENT (span
swaps, skeleton→content), which no browser can track: the boundary
ids are index-derived, so they survive replacements; the backstop
corrects by the recorded id's measured delta on any wrapper resize —
an absolute measurement, zero whenever native anchoring already
compensated. When the viewport sits inside a reservation (no ids
above the top — reservations carry none), the backstop's reference
falls back to the nearest boundary id BELOW the viewport top, which
is what breaks the up-scroll cascade-to-the-top. Pinned by the
variable-heights and cascade gauntlets in
`product-browse-culling.spec.ts`.

`.parton-skel` is the generic skeleton cell (leaf shells and
reservation bands both render it) — style it per collection.

## Limits (current, deliberate)

- **Browser height cap.** Native scroll tops out around ~33M px in
  Chromium. At `--scroller-row: 40px` × 8 cols that's ~6.6M items;
  denser grids reach further. The cap is the documented outer wall —
  the design goal is that everything _below_ it just works.
- **Append-shaped growth.** Interval identity assumes an item's
  index is stable per (source, sort, filter) modulo appends. Sorted
  catalogs re-slice cleanly (leaves re-render, item partons fp-skip
  by entity). Prepend feeds want a signed extension — not built.
- **`range` is offset/limit.** Cursor sources adapt by mapping;
  streaming/async-iterator sources are a backlog adapter.
- **No-JS lands on pages, not physics.** The anchored cold render
  (and real `<a href="?page=N">` links) are the no-JS projection;
  the reservation's self-materialization requires the client
  runtime.
