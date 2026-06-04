/**
 * /bare — infinite-scroll demo. Pre-creates a fixed pool of page
 * specs; each one's `vary` returns null when its page index exceeds
 * the current `?end=` value, so only the active range renders.
 */

import { parton, searchParam } from "@parton/framework"
import { NextObserver } from "../components/next-observer.tsx"
import { ScrollRestore } from "../components/scroll-restore.tsx"

const ITEMS_PER_PAGE = 10
const MAX_PAGES = 50

function makeBarePage(page: number) {
  return parton(
    function BarePageRender() {
      // Inline-tracked `?end`: records the dep so this page re-renders when
      // the loaded range grows. Beyond the range → render nothing. The
      // range only grows (infinite scroll), so there's no parked variant to
      // preserve — a plain null replaces the old `vary`→null park.
      const end = Math.max(1, Number(searchParam("end")) || 1)
      if (page > end) return null
      const offset = (page - 1) * ITEMS_PER_PAGE
      return (
        <section data-testid={`page-${page}`} data-page={page} className="mb-4">
          <h2 className="py-2 text-sm text-muted-foreground">Page {page}</h2>
          {Array.from({ length: ITEMS_PER_PAGE }, (_, i) => {
            const itemId = offset + i + 1
            return (
              <div
                key={itemId}
                data-testid={`item-${itemId}`}
                className="mb-2 flex h-20 items-center rounded-lg bg-card p-4"
              >
                Item #{itemId}
              </div>
            )
          })}
        </section>
      )
    },
    {
      // Selector namespaced so the bare page-N specs don't collide
      // with the Pokemon homepage's `#page-N` list-page specs.
      selector: `#bare-page-${page}`,
    },
  )
}

const BarePagePartials = Array.from({ length: MAX_PAGES }, (_, i) => makeBarePage(i + 1))

const BareNext = parton(
  function BareNextRender() {
    const end = Math.max(1, Number(searchParam("end")) || 1)
    return <NextObserver currentEnd={end} />
  },
  {
    selector: "#bare-next",
  },
)

export const BarePage = parton(
  function BareRender() {
    const end = Math.max(1, Number(searchParam("end")) || 1)
    return (
      <>
        <title>Infinite Scroll Test</title>
        <ScrollRestore />
        <h1 className="mb-4 text-2xl font-semibold">Infinite Scroll</h1>
        <p className="mb-4 text-muted-foreground">
          <a href="/" data-testid="link-home" className="text-primary hover:underline">
            ← Home
          </a>
          {" · "}
          <span data-testid="end-readout">end={end}</span>
        </p>
        {BarePagePartials.map((P, i) => (
          <P key={`bare-page-${i + 1}`} />
        ))}
        <BareNext />
      </>
    )
  },
  {
    match: "/bare",
    vary: ({ search: { end } }) => ({
      end: Math.max(1, Number(end) || 1),
    }),
  },
)
