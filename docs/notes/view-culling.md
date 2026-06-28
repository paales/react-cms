# View culling — read-tracked, per-parton

**Status:** working, at `/magento/browse`
(`e2e-testing/src/app/pages/magento/product-browse.tsx`, framework in
`framework/src/lib/visibility.tsx` + `server-hooks.ts` `visible()`, specs in
`e2e/product-browse-culling.spec.ts` + `__tests__/visible-fp.rsc.test.tsx`).
This note is the design and the framework-level findings — the substrate for
a future framework `<Scroller>`.

This is the shipped form of the "Activate ⇄ deactivate symmetry" backlog
item in [`IDEAS.md`](./IDEAS.md), and it supersedes the earlier
windowed-anchor sketch (a client camera reloading a list partial with an
`?visible=N` anchor): culling is now a per-parton read-tracked signal, not a
list-level camera.

## The model — culling is a tracked read

A parton calls **`visible()`** ([[server-hooks]]). That single read makes it
**cullable**: the read folds the parton's viewport state into its
fingerprint, through the *same* dep-record path as `cookie()` / a cell read
(store-and-reread). So when the parton enters or leaves the viewport its fp
moves and it **self-refetches** — full content in view, a skeleton out of
view. A parton that never calls `visible()` is invariant to scrolling. The
read IS the dependency; there is no separate registration.

`visible()` is **tri-state**:

- `true` — the client reported this parton within the viewport (expanded by
  the observer's runway margin).
- `false` — the client reported and it's outside that margin.
- `undefined` — no client report yet: the pre-measurement state (cold render
  / SSR / no-JS). **Global**, not per-parton — it means the request carries
  no `?visible=` at all. The app seeds the cull off its own anchor here
  (`visible() ?? nearAnchor(searchParam("page"))`), so the first paint fills
  the right neighborhood; the live set refines it.

Reservation is the parton's own contract: a culled parton must render a
placeholder that holds its space, or the document collapses. For the uniform
grid that's a **fixed-height section** (owned by the parent, always present),
so a page's content swaps skeleton ⇄ products without shifting layout — the
document height is constant and the whole catalog is reachable.

## Observation — a Fragment ref inside the boundary

The server marks a boundary `cullable` when the parton recorded a `visible:`
dep. On the client, `PartialErrorBoundary` then wraps the parton's children
in a React 19.3 **`<Fragment ref>`** and observes them with an
IntersectionObserver via **`FragmentInstance.observeUsing`** — *no wrapper
element, no `data-*` id stamping*. The boundary already knows its own id, so
it reports `{ id, inView }` straight from its closure. The parton tunes its
own runway at the read site — `visible({ rootMargin: "900px 0px" })` — and
the options thread server→client on the `cullable` prop.

Reports funnel into a module-level controller (`visibility.tsx`, mirroring
the refetch batch / partial cache — client state lives at module scope). It
coalesces a frame's worth of reports (rAF) and **self-refetches the changed
partons by id**, carrying the full visible set as `?visible=` so each
re-render's `visible()` reads its own bit. fp-skip prunes the rest. Refetches
serialize: one in flight, re-firing with the latest set when it changes.

So one scroll produces one coalesced request — `?partials=<entered ∪ left>`
+ `?visible=<full current set>` — and the ids that left view appear in
`partials` but not `visible` (they re-render to skeleton).

## Cold start & the URL

`?page=N` is the cold seed and the shareable URL. On the cold render
`visible()` is `undefined`, so the app paints the `?page=` neighborhood full;
a tiny client `<ScrollToPage>` lands the viewport there on mount. That's the
one bit of app-side glue — translating the app's own `?page=` URL semantics
into a scroll target. `?page=` is NOT rewritten as you scroll; the live
position lives only in the ephemeral `?visible=` refetch param.

## Findings (the load-bearing part for a framework `<Scroller>`)

1. **`visible()` is a synthetic tracked read.** It needed no new fp
   machinery — a `visible:<id>` dep folded through `evalDepKeys` exactly like
   `cookie:`/`search:`. Reading is the dependency; not reading is the opt-out.
   The cold/in/out tri-state maps to three distinct fold tokens (`u`/`1`/`0`)
   so the first client report moves the fp too.
2. **FragmentRef reaches partons only from INSIDE the boundary.** The
   substituted partial content is real React children of a `Fragment`
   (`renderChildren`), so `observeUsing` can see it — but only when the ref
   is the boundary's own wrapper. Observing from an *outer* app-level Fragment
   fails: it has to reach across the shared, deliberately non-keyed
   `renderChildren` Fragment. Putting the ref in `PartialErrorBoundary` keeps
   the id in the closure and out of the DOM.
3. **The cullable flag rides the parton's deps.** Derived server-side from
   `selfDeps` (or `priorSnap.deps` on a skip/defer) and threaded to the client
   boundary — non-cullable partons render their children bare, zero cost.
4. **Self-refetch by raw id needs no selector** — `reload({ selector:
   ['#'+id] })`, the same path `useActivate` uses. A cullable parton is
   addressable by its own id.
5. **Serialize + coalesce.** Rapid same-target reloads supersede; one in
   flight, rAF-coalesced, re-fire on change.
6. **Client components import framework hooks from the client subpath**
   (`@parton/framework/lib/partial-client.tsx`), never the `@parton/framework`
   barrel — the barrel pulls server/node modules into the client bundle
   (`require is not defined`).

## Known refinements (follow-ups)

- **Cold-ring stranding.** A page rendered full by the cold seed but never
  scrolled into view never gets a *change* to cull, so it stays full. Bounded
  by the cold ring, and it's valid cached content — but a reconciliation pass
  (cull cold-full pages once the client has measured) would tighten it.
- **Reservation for variable height.** The uniform grid uses a fixed
  `PAGE_H`. The same `FragmentInstance` exposes `getClientRects()`, so the
  general path is measure-once-and-pin; the only thing an app must declare is
  a size estimate for the never-yet-measured cold state.
- **Windowing for huge catalogs.** Every page renders a (cheap, skeleton)
  section, so a bounded catalog is reachable at constant height. A catalog of
  thousands of pages wants true windowing (don't render every skeleton),
  which re-introduces a list-level refetch alongside the per-parton one.

## Toward a framework `<Scroller>`

The framework already owns observation (`visible()` + the boundary's Fragment
ref + the controller). The app owns: reading `visible()` to branch
skeleton/full, the fixed-height section, the cold-anchor seed, and
`<ScrollToPage>`. A `<Scroller>` would absorb the cold-anchor + scroll glue
and the reservation bookkeeping. Findings 1–6 are its hard requirements.
Extraction waits for a second call site (the AI-thread streaming case), per
YAGNI.
