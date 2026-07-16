/**
 * /embed-cell-demo — a resolved cell spliced through an ungoverned
 * `<RemoteFrame>` embed.
 *
 * `/embed-cell-target` is an ordinary page whose parton resolves a cell
 * at an explicit partition and hands the whole `ResolvedCell` to a
 * `"use client"` component (`EmbedCellCounter`) whose button calls
 * `.set` directly. Standalone it is an ordinary interactive page.
 * Embedded, the host decodes the page payload and re-encodes it into
 * its own document render — the hop a bound server-action ref cannot
 * survive (a decoded ref bound to a partition object stalls the host
 * stream). The cell's `set` crosses as a CLIENT reference instead (its
 * id + partition ride as data), so the embed splices cleanly AND the
 * embedded write still commits + fans out (the write's `cell:` selector
 * wakes the embedded snapshot, laning a focused re-embed with the fresh
 * value).
 */

import { localCell, parton, RemoteFrame, type RenderArgs } from "@parton/framework"
import { Suspense } from "react"
import { EmbedCellCounter } from "../components/embed-cell-counter.tsx"

const embedCounter = localCell({
  id: "embed-cell-counter",
  shape: "number",
  initial: 0,
})

/** The embeddable page: resolves the counter cell at an explicit
 *  partition (so the resolved view's `set` binds a partition OBJECT —
 *  the arg shape that stalls the host re-encode without the fix) and
 *  passes the whole resolved view to a client component. Browsable
 *  standalone at `/embed-cell-target`. */
export const EmbedCellTargetPage = parton(
  async function EmbedCellTargetRender(_: RenderArgs) {
    const counter = await embedCounter.resolve({ slot: "a" })
    return (
      <section data-testid="embed-cell-target">
        <EmbedCellCounter cell={counter} />
      </section>
    )
  },
  { match: "/embed-cell-target" },
)

/** The host: embeds `/embed-cell-target` with no grant (full trust). */
export const EmbedCellDemoPage = parton(
  function EmbedCellDemoRender(_: RenderArgs) {
    return (
      <>
        <header className="mb-4" data-testid="embed-cell-header">
          <h2 className="text-xl font-semibold">Resolved cell across an embed</h2>
          <p className="text-sm text-muted-foreground">
            The frame embeds <code>/embed-cell-target</code>, whose counter passes its resolved cell
            to a client component. The button writes the cell directly across the embed boundary.
          </p>
        </header>
        <section
          className="rounded-lg border border-dashed border-teal-500/50 p-4"
          data-testid="embed-cell-frame"
        >
          <Suspense
            fallback={
              <div className="italic text-muted-foreground" data-testid="embed-cell-fallback">
                Loading embedded counter…
              </div>
            }
          >
            <RemoteFrame url="/embed-cell-target" />
          </Suspense>
        </section>
      </>
    )
  },
  { match: "/embed-cell-demo" },
)
