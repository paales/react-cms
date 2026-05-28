# parton

An RSC-native framework for commerce-shaped UIs: **server-owned
state — `useState` on the server — with Flight as the communication
layer**, and independently re-renderable, addressable, cacheable
subtrees as the unit of composition.

Research project. The bet is **dynamic range** — one primitive that
stretches from the leanest, mobile-snappy storefront (mostly static,
fingerprint-skip everything, a few bytes on the wire) to a realtime
streaming dashboard (segmented Flight, live server state) — so a
stack never has to bifurcate the way commerce frameworks force
today: Shopify Liquid plus a React checkout, Magento Luma or Hyvä
plus yet another React app. The base framework should stretch the
whole range instead of being abandoned where the page gets dynamic.

The primitive is `parton(Render, options)` — a define-step
constructor that returns a placeable React component. Pages are JSX
trees of those components; each one self-registers at render time,
computes a structural fingerprint, and is independently refetchable.
Targeted refetches re-run only the requested spec's body — without
re-executing any ancestor — by replaying registry snapshots. State
that varies between refetches flows through URLs (page or frame),
read server-side via a sync `vary` callback whose return value is
also the cache-key surface, or through **cells** — typed,
identity-keyed slots of server-authoritative state that cross Flight
to client components and fan writes back out by selector. GraphQL
and disk / local storage are pluggable tiers under the cell.
Slot-placeable, CMS-driven units use `block`; per-name URL scopes
are opened with `<Frame>`; cross-process composition uses
`<RemoteFrame>`.

For the full mental model, start with [`docs/reference/intro.md`](./docs/reference/intro.md).

## Layout

This repo is a yarn workspace monorepo. Each top-level folder is a
package.

| Folder | For |
|---|---|
| [`docs/reference/`](./docs/reference/) | Framework reference. `intro` · `partial` · `block` · `cells` · `frames-navigation` · `remote-frame` · `cache` · `cms` · `prior-art`. |
| [`docs/internals/`](./docs/internals/) | Framework internals. `testing` · `render-pipeline` · `streaming` · `cache-internals` · `cell-internals` · `registry-internals` · `frame-scope` · `server-isolation` · `flight-gotchas`. |
| [`docs/notes/`](./docs/notes/) | Active research and forward-looking design (`IDEAS.md`). |
| [`docs/adr/`](./docs/adr/) | Architecture Decision Records. |
| [`docs/archive/`](./docs/archive/) | Superseded designs and debugging logs. Reference only. |
| [`CLAUDE.md`](./CLAUDE.md) | Project structure, tooling, dev workflow. |
| `framework/` | The partials library + RSC plumbing + in-process test harness. |
| `cms/` | CMS editor UI (three-pane shell) and committed content store. |
| `copies/` | Local copies of shadcn UI primitives + AI-elements + shared hooks. |
| `e2e-testing/` | Example testing app (PokeAPI + GraphCommerce Magento backends) and Playwright specs. |
| `e2e-magento/` | Empty showcase scaffold for a future Magento integration. |

## Quickstart

```bash
yarn install
yarn dev
```

Open `http://localhost:5173`. The example app exposes:

| Path | Demo |
|---|---|
| `/` | PokeAPI — search, infinite scroll, frame-scoped quick view. |
| `/magento` | GraphCommerce — product list, live cart, server-action invalidation. |
| `/cms-demo` | CMS-resolved page with cascading per-slug configs. |
| `/?editor=1` | The CMS editor — three-pane shell, save → preview refetch. |
| `/cache-demo` | `parton`'s `cache` semantics: maxAge, SWR, vary-derived keys. |
| `/defer-demo` | `defer={<WhenVisible/>}` and `<WhenStored>` activators. |
| `/frames-demo` | Per-frame URLs, two history axes, drawer navigation. |
| `/chat-notes` | Bounded `<Piece>` + compaction streaming pattern. |
| `/selector-demo` | Selector-targeted refetch — `#unique` vs `.shared`. |
| `/sentinels-demo` | `notFound()` and `redirect()` from deep async server components. |

## Test

```bash
yarn test       # Vitest — node + rsc projects (fast)
yarn test:e2e   # Playwright — full-stack
```

Both suites cover disjoint surfaces; both must pass before a change
is done. See [`docs/internals/testing.md`](./docs/internals/testing.md)
for tier picking and the in-process Flight harness.
