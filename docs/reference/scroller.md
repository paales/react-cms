# scroller() — windowed collections

`scroller(options)` renders a collection (catalog, listing, feed) as
**one CSS grid with a placed span of leaf partons around the anchor,
and two reservation shells covering everything else**. It is a
constructor composed around `parton()` + the `cull` gate: everything
it emits is ordinary partons, so fingerprints, fp-skip, refetch,
keepalive, and the live channel apply unchanged.

The model's premise: **uniform rows make structure arithmetic.** No
recursive tree, no size estimation, no measurement loop — position
anywhere in a million-item collection is one rect read plus row math,
client-side, zero round trips. Pinned by `scroller-scale.spec.ts`
against a synthetic 1,000,000-item source.

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
- **ONE writer, measure-first.** The anchor sync derives
  item-under-center from LAYOUT where content exists (the hit cell,
  walked back to the nearest boundary anchor id — correct under any
  item heights or breakpoints) and from row arithmetic only inside
  reservations (nothing exists there to measure). It states the
  landing silently in-span (bookmarkability only — culling follows
  the viewport on its own), as an in-place navigation
  (`scroll: "manual"`) when the span must move. Occlusion-guarded —
  an overlay covering the collection silences it.
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
3. **Data is one statement.** When the scroll settles (250ms), the
   anchor sync states the landing through the anchor param — an
   in-place `history: "replace"` navigation (`scroll: "manual"`, so
   the browser's deferred default scroll can never fire against a
   live gesture). The root re-renders with the span moved there; the
   seeded neighborhood's content replaces the skeletons in place.
   Document height and scroll position are untouched throughout
   (pinned).

A recursive interval tree (the demo world's quadtree, this design's
predecessor) answers "what structure is here?" with one round trip
per level. Uniform rows make the question client-computable, so the
tree earns nothing for 1D collections. The world keeps its quadtree —
its plane is 2D px space with procedural content, a different animal.

## Options

| Option       | Default    | Meaning                                                                                                                           |
| ------------ | ---------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `name`       | (required) | Identity: catalog ids (`<name>`, `<name>-leaf`), the public DOM anchors (`id=<name>`, `id=<name>-p<N>`). Explicit — there is no Render name to derive it from. |
| `load`       | (required) | `({offset, limit}) → {items, total}`. Called in `leaf`-aligned slices. Tracked reads (cells, `searchParam`) record as deps.       |
| `render`     | (required) | `({item, index, id}) → ReactNode` — one grid cell, props-bag style. Apply `id` to the cell (boundary anchor). `Item` infers from `load`. |
| `leaf`       | `24`       | Items per leaf parton = fetch slice = default anchor step. **Must be divisible by every `--scroller-cols` value** (row alignment). |
| `ring`       | `6`        | Leaves placed each side of the anchor leaf. Placement ≠ materialization — the ring is the park/restore zone.                      |
| `className`  | —          | The wrapper class carrying the three CSS variables.                                                                                |
| `rootMargin` | `600`      | Leaf materialization runway, px.                                                                                                   |
| `anchor`     | `page`     | `{param?, pageSize?}` — rename the param (two collections on one page) or change the step (a multiple of `leaf`).                 |

## The CSS contract

The app declares three custom properties on the collection's class
(the framework builds the grid template from them and never learns a
pixel):

- `--scroller-cols` — integer column count. Responsive via
  media/container queries. Every value must divide `leaf`.
- `--scroller-row` — the row pitch. The `sizes`-like declaration:
  state the truth once, responsively if needed.
- `--scroller-gap` — column gap. Row-gap is always 0: the pitch IS
  the vertical rhythm; vertical spacing lives inside cells
  (margin/padding), so reservation arithmetic stays exact.

`.parton-skel` is the generic skeleton cell (leaf shells and
reservation bands both render it) — style it per collection.

Cells must fit the row pitch. Uniform rows are the contract — they
are what make reservation exact, scroll-up jump-free by
construction, and the scrollbar jump computable. Variable-height
items are a different primitive (scroll-anchoring machinery), not a
mode of this one.

## Limits (current, deliberate)

- **Browser height cap.** Native scroll tops out around ~33M px in
  Chromium. At `--scroller-row: 40px` × 8 cols that's ~6.6M items;
  denser grids reach further. The cap is the documented outer wall —
  the design goal is that everything *below* it just works.
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
