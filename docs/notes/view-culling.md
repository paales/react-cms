# View culling — a bidirectional, addressable scroller

**Status:** prototyped, app-side, at `/magento/browse`
(`e2e-testing/src/app/pages/magento/product-browse.tsx` +
`components/browse-scroller.tsx`). This note captures the design and
the framework-level findings the prototype surfaced, as the substrate
for a future framework `<Scroller>` primitive.

This is the shipped form of the "Activate ⇄ deactivate symmetry"
backlog item in [`IDEAS.md`](./IDEAS.md): a list that culls in **both**
directions, not the old grow-only `?end=` model.

## The model — a camera over an ordered set of page-partons

Infinite scroll, pagination, and virtualization are one thing: a
windowed camera over an ordered collection. The collection is a fixed
pool of **page-partons** (`#browse-page-N`), each bound to one
`currentPage` slice of a cell. The camera has two axes — *where*
(scroll position → which partons) and, eventually, *how close*
(zoom/viewport → which fidelity); the prototype implements *where*.

Each page renders in one of three **zones**, decided server-side from
the reported visible span (`vis`), `lo = min(vis)`, `hi = max(vis)`:

| Zone | Range | Renders | Fetches |
|---|---|---|---|
| **ring** | `[lo-1, hi+1]` | products | yes (binds the cell) |
| **reserved** | `[lo-3, hi+3]` minus ring | a fixed-height skeleton (the runway) | no |
| **absent** | beyond | nothing (`vary → null`) | no |

The reserved band is the game-engine "load distance > render distance":
skeletons give the observer a runway to see a page coming before it's
fetched, and reserve closed-form space (the grid is uniform, so a
culled page reserves exact rows with no measurement). As the camera
moves, pages slide reserved→ring→reserved→absent; the document grows
and shrinks with the runway. The scrollbar is approximate and
self-corrects as real pages stream in — and that's fine.

Culling is parton-native: `vary → null` drops an out-of-band page; the
ring boundary is just `vary` reading `visible` and returning a zone.
Fetch-skip falls out of `schema` only binding the cell in the ring.

## The protocol — driver vs effect, each in its own scope

A render is a pure function of the request, so whatever drives the
render must be in the request. Two distinct things, two scopes:

- **Visible set → the FRAME url** (`useNavigation("browse")`). The
  driver. The client reports the intersecting page ids (ordered by
  prominence; first = anchor) as `?visible=`; a frame refetch
  re-renders the band, fp-skipping pages whose zone didn't change.
  Because it rides the frame url (`?__frameUrl=`), it is **never on the
  sharable page url** — exactly the scope `<Frame>` already provides.
- **Anchor → the PAGE url** (`?page=N`). The effect. A sharable
  bookmark shadow the client writes via `replaceState` as the camera
  moves. It drives only once — at cold-start — and is a passive
  reflection thereafter.

**Cold-start.** The wrapper (outside the frame) reads `?page=N` and
seeds the frame `initialUrl` to `?visible=N`, so the deep-linked band
renders on first paint with no client round-trip. The client then
**scrolls page N into view** before observing (see finding 4).
(Caveat: `initialUrl` is a cold-session default, so a *returning* user
whose `browse` frame session still holds an old `visible=` sees that
position instead of `?page=N` — the documented "frame url shared per
session" edge. Honouring the anchor over stale frame state would need
the wrapper to reset the frame on a fresh document load.)

## Findings (the load-bearing part for a framework `<Scroller>`)

The prototype is small; getting it to work surfaced four framework
interactions that any extracted primitive must respect:

1. **`observeUsing` can't watch framework partials.** The natural
   "FragmentRef over the children + one IntersectionObserver"
   (`<WhenVisible>`'s mechanism) observes *zero* nodes here: the
   framework substitutes partials outside the fragment's React-child
   range, so `observeUsing`'s fiber traversal finds no host nodes. The
   working form is a plain block container (layout-neutral for stacked
   sections) scoping a DOM query, with a **MutationObserver** keeping
   the IntersectionObserver's target set in sync as pages mount/unmount.

2. **`keepalive: false` on the page-partons.** With the default
   (`keepalive: true`), an out-of-band page emits a *parked* variant —
   kept in the tree but `display: none`. Driving that from a scroll
   meant the whole frame collapsed to hidden parked siblings (document
   height → viewport height). `keepalive: false` culls cleanly: the
   page leaves the tree. (Trade-off: scroll-back refetches instead of
   restoring warm — acceptable; warm-cache cull-back is future work.)

3. **The anchor must be a raw `replaceState`, not a framework
   navigate.** Even a `silent` window `navigate` re-commits the page,
   which parks the frame's content and collapses the layout. The
   `?page=` anchor is cosmetic (read only server-side on cold load), so
   a bare `window.history.replaceState` is correct — it updates the url
   with no re-commit.

4. **Cold-start must scroll to the anchor.** A deep-linked `?page=5`
   renders the band centered on 5, but the viewport is at the top
   (showing page 2). Without an explicit scroll, the camera reports
   "I see page 2," the ring shifts up, and page 5 is demoted ring→
   reserved (a brief duplicate). Scrolling N into view on mount, before
   the observer starts, makes the deep-link stick.

## Toward a framework `<Scroller>`

The app currently owns: the page-pool + zones (`vary`/`schema`), the
reservation skeleton, the anchor projection (`?page=` ↔ page number),
and the `BrowseScroller` reporter. A framework `<Scroller name layout>`
would absorb the cross-cutting half — the container+MO+IO reporter, the
`visible`→frame-url / anchor→page-url wiring, and the cold-start
seed+scroll — leaving the app to supply only the ordered partons, the
zone policy, the reservation, and the anchor projection. The four
findings above are its hard requirements. Extraction waits for a second
call site (the AI-thread / streaming case), per YAGNI.
