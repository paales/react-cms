import type { RenderArgs } from "@parton/framework"
import { expires, parton, time } from "@parton/framework"
import { ActivityLight } from "./activity-light.tsx"
import { ChunkShell } from "./chunk-shell.tsx"
import {
  CHUNK_FLIP_MARGIN_PX,
  FLAKY_DISTRICT,
  inAuctionDistrict,
  inFlakyDistrict,
  seedIntersects,
  type WorldGeometry,
} from "./constants.ts"
import { flakyOutage } from "./flaky.ts"
import { definePulse } from "./pulse.ts"
import { StaleBadge } from "./stale-badge.tsx"

/** A chunk placement — signed chunk coordinates. */
export type ChunkPos = { cx: number; cy: number }
export type ChunkComponent = (props: ChunkPos) => React.ReactNode | Promise<React.ReactNode>

/**
 * One world chunk — the content parton, the quadtree's leaf cell,
 * cullable at its own grain via the spec-level `cull` gate. One spec
 * PER GEOMETRY (`defineWorldChunk`, catalog id `geo.chunkSpecId` —
 * `world-chunk` for the 512 default, `world-chunk-128` etc. for the
 * density geometries), all registered at module scope. The quad tiles
 * above it window STRUCTURE (does this region exist in the DOM); the
 * chunk windows CONTENT: out of view the framework skips this body
 * entirely and the client renders `ChunkShell` (a tight 100px runway,
 * so you can watch chunks pop in as you scroll). The pulse derives
 * HERE — the body reads the write-once anchor cell plus the render
 * clock, computes ms-alive, and declares its next beat with
 * `expires()`; the live connection's expiry arm re-lanes the chunk on
 * that boundary and the light flashes when ITS bytes arrive. A culled
 * chunk's body never runs, so it declares no beat and costs nothing
 * until it flips back in — re-entry derives the caught-up value by
 * construction. The chunk fills its owning leaf cell box, so it
 * carries no position of its own.
 *
 * Cold seed: the same box-intersection test as every quad level — the
 * origin viewport estimate renders with content at first paint, and
 * nothing more.
 *
 * The FLAKY DISTRICT (constants.ts) rides this same body: inside the
 * district's plane box, a deterministic (coords × 12s-bucket) outage
 * throws BEFORE anything loads or declares — the loader-failure shape
 * the error-recovery contract is built against. The framework then
 * serves the chunk's last-known-good bytes with the stale marker
 * (`<StaleBadge>` reads it) and re-attempts on the capped backoff; a
 * chunk that has never rendered good bytes shows the bounded error
 * card until a retry lands. See `docs/reference/errors.md`.
 *
 * The AUCTION DISTRICT only TINTS here: district chunks carry the
 * `chunk--auction` class so the region reads as a place, but the lot
 * cards themselves live on the page parton's overlay layer
 * (`<AuctionDistrict>` in ./auction-lot.tsx) — a lot's bid lane must
 * ride its own viewer-independent parton, decoupled from this chunk's
 * per-viewer cull gate and beat-cadence lanes.
 */
export function defineWorldChunk(geo: WorldGeometry): ChunkComponent {
  const pulse = definePulse(geo)
  return parton(
    async function WorldChunkRender({ cx, cy }: ChunkPos & RenderArgs) {
      const clock = time()
      const gx = geo.chunkOrigin(cx)
      const gy = geo.chunkOrigin(cy)
      const flaky = inFlakyDistrict(gx, gy)
      if (flaky) {
        const outage = flakyOutage(cx, cy, clock.now)
        if (outage.failing) {
          throw new Error(
            `flaky district: chunk ${cx},${cy} loader failed (bucket ${outage.bucket})`,
          )
        }
      }
      const anchor = await pulse.cell.resolve({ cx, cy })
      // Milliseconds alive, derived — anchor row + render clock, no
      // producer. The beat declaration is the whole cadence machinery.
      const alive = Math.max(0, clock.now - anchor.value)
      expires(pulse.nextBeat(cx, cy, clock.now))
      const isDistrictCorner = flaky && gx === FLAKY_DISTRICT.x0 && gy === FLAKY_DISTRICT.y0
      const auction = inAuctionDistrict(gx, gy)
      const modifier = flaky ? " chunk--flaky" : auction ? " chunk--auction" : ""
      return (
        <div className={`chunk${modifier}`} data-testid={`chunk-${cx},${cy}`} data-loaded>
          <span className="chunk__coord">
            {cx},{cy}
          </span>
          <ActivityLight ck={`${cx},${cy}`} stamp={alive} />
          <span className="chunk__pulse">{alive}ms</span>
          {flaky ? <StaleBadge /> : null}
          {cx === 0 && cy === 0 ? <OriginCard /> : null}
          {isDistrictCorner ? <FlakyDistrictCard /> : null}
        </div>
      )
    },
    {
      selector: `#${geo.chunkSpecId}`,
      // The byte-cache predictive warming fills (see ./warm.ts): the
      // scroller's telemetry projects which parked chunks the viewport
      // will reach, the warm pass renders them in here, and the real
      // flip-in lane replays the stored bytes instead of re-encoding
      // the subtree. Staleness is impossible — the entry's freshness
      // clamps to the body's declared `expires()` beat, so no replay
      // outlives the derived value's own window; maxAge only bounds
      // how long an untouched entry lingers.
      cache: { maxAge: 30 },
      cull: {
        rootMargin: `${CHUNK_FLIP_MARGIN_PX}px`,
        seed: ({ cx, cy }: ChunkPos) =>
          seedIntersects(geo.chunkOrigin(cx), geo.chunkOrigin(cy), geo.chunkPx),
        skeleton: ChunkShell,
      },
    },
  )
}

/** The story's first card — the world starts here. */
function OriginCard() {
  return (
    <div className="card">
      <h1 className="card__title">PARTON</h1>
      <p>An RSC-native framework.</p>
      <p>A parton is an enhanced component: one part on the client, one part on the server.</p>
      <p>
        Every chunk of this world is one. Scroll — chunks load as they enter view, and each light
        flashes when its chunk's bytes arrive.
      </p>
      <p className="card__hint">WASD / drag / scroll</p>
      <p className="card__hint">flaky district: south-west ↙</p>
      <p className="card__hint">auction district: east →</p>
    </div>
  )
}

/** The district's signpost — sits on its corner chunk (so on a first
 *  visit during that chunk's outage, the card itself demonstrates the
 *  bounded error state). */
function FlakyDistrictCard() {
  return (
    <div className="card">
      <h1 className="card__title">FLAKY DISTRICT</h1>
      <p>Every loader here fails on purpose — deterministically, per chunk, per 12s bucket.</p>
      <p>
        A chunk that has rendered once keeps serving its last good bytes through failures — frozen
        pulse, STALE badge — while the server retries on a capped backoff. Recovery clears it.
      </p>
      <p>A chunk that has never succeeded shows a bounded error card until a retry lands.</p>
      <p className="card__hint">watch a badge appear, sit, and clear</p>
    </div>
  )
}
