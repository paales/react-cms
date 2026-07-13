/**
 * Convergence fuzzer — seeded random walks over the live-connection
 * action surface (navigate / write / flip / refetch / settle) with a
 * convergence ORACLE at quiescence: the client's committed tree —
 * reconstructed from the wire by a faithful client model — must equal
 * a fresh cold render of the same URL + scope + visibility set.
 * Incremental merge ≡ cold render is the framework's core claim; this
 * harness is its property test. Design note:
 * `docs/notes/convergence-fuzzing.md`.
 *
 * The harness drives the REAL segment driver through `withLiveDrive`
 * (statement bind, fp-trailer wrap, segment splitter, lane demux) and
 * plays the client's half of the channel protocol: envelope seqs,
 * the as-of commit guard, contiguous-watermark acks with `dropped`
 * reporting, visibility statements carrying actual holdings.
 *
 * Quiescence is detected from the driver's own signals, never timing:
 * a SENTINEL parton (a cell reader bumped with a unique tick per
 * round) is woken, and the window of wire events up to its lane is
 * inspected — a window containing ONLY the sentinel's lane proves the
 * wake found nothing else pending (every wake re-checks deferred
 * flips and drains the one pending set). Repeat until a clean window.
 */

import type { ReactNode } from "react"
import { _captureCommitHandle, runWithRequestAsync } from "../runtime/context.ts"
import { _setConnectionSession } from "../runtime/context.ts"
import {
  CHANNEL_ENDPOINT,
  type ChannelEnvelope,
  type ChannelFrame,
} from "../lib/channel-protocol.ts"
import { _peekConnectionSession, handleChannelPost } from "../lib/connection-session.ts"
import type { DemuxedLane, Segment } from "../lib/fp-trailer-split.ts"
import { splitAtFpTrailer, splitSegments } from "../lib/fp-trailer-split.ts"
import { wrapStreamWithFpTrailer } from "../lib/fp-trailer.ts"
import { withLiveDrive, freshLiveScope } from "./live-drive.tsx"
import { renderServerToFlight } from "./rsc-server.ts"
import { extractPartonView, type ExtractedPayload } from "./fuzz-wire.ts"

// ─── PRNG ────────────────────────────────────────────────────────────

/** mulberry32 — small, seedable, good-enough PRNG for action walks. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function pick<T>(rand: () => number, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)]
}

// ─── Fixture + action surface ────────────────────────────────────────

export interface FuzzFixture {
  /** The page the drive renders. */
  page: () => ReactNode
  /** Every parton id under oracle comparison (sentinel included). */
  universeIds: readonly string[]
  /** Ids that carry a `cull` gate — the flip-action candidates. */
  cullableIds: readonly string[]
  /** Cullable ids in view at attach time (the seed statement). */
  initialVisible: readonly string[]
  /** parton id → its enclosing PARTON id, for display cascading: a
   *  descendant of a culled/parked ancestor is not displayed, on the
   *  client (its DOM sits inside the parked content) exactly as in a
   *  cold render (the ancestor's body never runs). */
  parentOf: Readonly<Record<string, string | undefined>>
  /** Wrapper ids whose fp may legitimately drift on the client after
   *  lane-only descendant updates (ancestor fold drift is healed by
   *  the next whole-tree segment — over-fetch, never stale). Exempt
   *  from the fp-equality check; stamps still compare. */
  foldDriftAllowed: ReadonlySet<string>
  /** The quiescence sentinel: id + a bump that writes a unique tick
   *  through a real request (a cell write), and the stamp payload its
   *  body renders for that tick. */
  sentinelId: string
  bumpSentinel: (scope: string, url: string, tick: number) => Promise<void>
  sentinelStampFor: (tick: number) => string
  /** Navigation universe (paths + search variants, no transport
   *  params). Index 0 is the attach URL. */
  urls: readonly string[]
  /** Labels the refetch action may force. */
  refetchLabels: readonly string[]
  /** Cell writes: apply(scope, url, value) runs the write through a
   *  real request scope. */
  writes: ReadonlyArray<{
    name: string
    apply: (scope: string, url: string, value: number) => Promise<void>
  }>
}

export type FuzzAction =
  | { kind: "navigate"; url: string }
  | { kind: "write"; cell: number; value: number }
  | { kind: "flip"; ids: string[] }
  | { kind: "refetch"; label: string }
  | { kind: "settle" }

export function generateSequence(seed: number, length: number, fixture: FuzzFixture): FuzzAction[] {
  const rand = mulberry32(seed)
  const actions: FuzzAction[] = []
  let writeCounter = 0
  for (let i = 0; i < length; i++) {
    const r = rand()
    if (r < 0.18) {
      actions.push({ kind: "navigate", url: pick(rand, fixture.urls) })
    } else if (r < 0.45) {
      actions.push({
        kind: "write",
        cell: Math.floor(rand() * fixture.writes.length),
        value: ++writeCounter,
      })
    } else if (r < 0.7) {
      const count = rand() < 0.7 ? 1 : 2
      const ids = new Set<string>()
      for (let k = 0; k < count; k++) ids.add(pick(rand, fixture.cullableIds))
      actions.push({ kind: "flip", ids: [...ids] })
    } else if (r < 0.85) {
      actions.push({ kind: "refetch", label: pick(rand, fixture.refetchLabels) })
    } else {
      actions.push({ kind: "settle" })
    }
  }
  return actions
}

// ─── Client model ────────────────────────────────────────────────────

interface ModelEntry {
  /** Present in the CURRENT route tree (a whole-tree segment that
   *  omits or parks the id clears this; retained content stays as
   *  parked memory). */
  live: boolean
  fp: string | null
  matchKey: string | null
  stamp: string | null
}

type OracleState =
  | { state: "content"; stamp: string | null; fp: string | null; matchKey: string | null }
  | { state: "culled" }
  | { state: "absent" }

export interface Mismatch {
  id: string
  field: "state" | "stamp" | "fp" | "matchKey"
  expected: string
  actual: string
}

export interface SequenceResult {
  seed: number
  actions: FuzzAction[]
  mismatches: Mismatch[]
  /** A driver/harness failure (crash, watchdog, settle divergence) —
   *  also a finding, classified separately from oracle mismatches. */
  failure: string | null
  finalUrl: string
  visible: string[]
  /** Times a settle round RE-STATED its sentinel bump because a
   *  covering whole-tree segment arrived without the bump's stamp —
   *  the bump landed mid-render, after the lazily-rendered segment
   *  already read the sentinel's row. The driver's coverage cursor
   *  anchors BEFORE the covering render begins, so such a bump stays
   *  pending and its lane follows the segment; the re-bump just keeps
   *  the settle terminator simple (one current tick to watch for).
   *  Diagnostic: a segment swallowing a bump WITHOUT a follow-up lane
   *  would surface as an oracle mismatch, not here. */
  sentinelRebumps: number
}

/** Pure failure detection (a hang is a finding, not a wait). The env
 *  override exists for long local runs: shrinking a watchdog-class
 *  failure re-runs the sequence up to 200 times, each paying the full
 *  deadline — `FUZZ_WATCHDOG_MS=4000` keeps such shrinks tractable
 *  without loosening CI (where the default's headroom absorbs load). */
const WATCHDOG_MS = Number(process.env.FUZZ_WATCHDOG_MS ?? 20_000)
const MAX_SETTLE_ROUNDS = 60
const ACK_EVERY = 16

interface WireEventLane {
  kind: "lane"
  id: string
  ex: ExtractedPayload
  fpUpdates: Array<[string, { from: string; to: string }]>
  seq: number | null
  asof: number | null
}
interface WireEventSegment {
  kind: "segment"
  ex: ExtractedPayload
  fpUpdates: Array<[string, { from: string; to: string }]>
  seq: number | null
  asof: number | null
}
type WireEvent = WireEventLane | WireEventSegment

// ─── The runner ──────────────────────────────────────────────────────

export async function runSequence(
  fixture: FuzzFixture,
  seed: number,
  actions: FuzzAction[],
  isolate: () => void,
  debug?: (msg: string) => void,
): Promise<SequenceResult> {
  isolate()
  const scope = freshLiveScope("fuzz")
  const model = new Map<string, ModelEntry>()
  const entry = (id: string): ModelEntry => {
    let e = model.get(id)
    if (e === undefined) {
      e = { live: false, fp: null, matchKey: null, stamp: null }
      model.set(id, e)
    }
    return e
  }

  let currentUrl = fixture.urls[0]
  let envelopeSeq = 0
  let navPoint = 0
  let sentinelTick = 0
  const statedVisible = new Set(fixture.initialVisible)

  // Delivery bookkeeping — the client's half of the evidence protocol.
  const seenSeqs = new Set<number>()
  let watermark = 0
  let lastAcked = 0
  const pendingDropped: number[] = []
  const advanceWatermark = (): void => {
    while (seenSeqs.has(watermark + 1)) watermark++
  }

  const result: SequenceResult = {
    seed,
    actions,
    mismatches: [],
    failure: null,
    finalUrl: currentUrl,
    visible: [],
    sentinelRebumps: 0,
  }

  const attachUrl = new URL(currentUrl, "http://localhost")
  let capturedVisible: string[] | null = null

  try {
    await withLiveDrive(
      `http://localhost${currentUrl}`,
      fixture.page,
      scope,
      async (h) => {
        // ── entry-stream demux (read-ahead safe: association is by
        // content — per-parton seq queues, segment-record anchoring —
        // never by position relative to the consumer).
        let entryPtr = 0
        const laneSeqs = new Map<string, Array<{ seq: number; asof: number }>>()
        interface SegRecord {
          seq: number | null
          asof: number | null
          fps: Array<[string, { from: string; to: string }]>
        }
        const segRecords: SegRecord[] = []
        let segConsumed = 0
        const drainEntries = (): void => {
          for (; entryPtr < h.entries.length; entryPtr++) {
            const e = h.entries[entryPtr]
            if (e.tag === "seq") {
              const nl = e.body.indexOf("\n")
              if (nl >= 0) {
                const id = e.body.slice(0, nl)
                const [s, a] = e.body.slice(nl + 1).split(" ")
                let q = laneSeqs.get(id)
                if (q === undefined) laneSeqs.set(id, (q = []))
                q.push({ seq: Number(s), asof: Number(a) })
              } else {
                const [s, a] = e.body.split(" ")
                segRecords.push({ seq: Number(s), asof: Number(a), fps: [] })
              }
            } else if (e.tag === "fp") {
              const map = JSON.parse(e.body) as Record<string, { from: string; to: string }>
              // fp entries anchor to the payload segment whose seq entry
              // most recently preceded them (lanes carry their heals
              // inside their own bodies, never through this hook).
              if (segRecords.length === 0) segRecords.push({ seq: null, asof: null, fps: [] })
              const rec = segRecords[segRecords.length - 1]
              for (const [id, pair] of Object.entries(map)) rec.fps.push([id, pair])
            } else if (e.tag === "seqvoid") {
              for (const tok of e.body.split(" ")) {
                const n = Number(tok)
                if (Number.isFinite(n) && n > 0) seenSeqs.add(n)
              }
              advanceWatermark()
            }
            // conn / applied / muxlive — not needed by the model.
          }
        }

        const watchdog = async <T>(p: Promise<T>, label: string): Promise<T> => {
          let timer: ReturnType<typeof setTimeout> | undefined
          const guard = new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error(
                    `fuzz watchdog: ${label} produced no wire progress in ${WATCHDOG_MS}ms ` +
                      `(url=${currentUrl} navPoint=${navPoint} watermark=${watermark})`,
                  ),
                ),
              WATCHDOG_MS,
            )
          })
          try {
            return await Promise.race([p, guard])
          } finally {
            clearTimeout(timer)
          }
        }

        let laneIter: AsyncIterator<DemuxedLane> | null = null

        const nextEvent = async (): Promise<WireEvent> => {
          while (true) {
            if (laneIter !== null) {
              let step: IteratorResult<DemuxedLane>
              try {
                step = await watchdog(laneIter.next(), "lane iterator")
              } catch (err) {
                if (err instanceof Error && err.message.includes("fuzz watchdog")) throw err
                // Region torn (navigation) — the open bodies rejected;
                // fall through to the next segment.
                laneIter = null
                continue
              }
              if (step.done) {
                laneIter = null
                continue
              }
              const lane = step.value
              let bodyText: string
              let fpMap: Record<string, { from: string; to: string }> | null = null
              try {
                const { mainStream, trailer } = splitAtFpTrailer(lane.body)
                // "A torn decode always settles": a lane body that errors
                // at ANY point — even before a byte classifies (a
                // navigation tear racing the lane's first frame) — errors
                // `mainStream` alongside rejecting the trailer, so a bare
                // body read is safe; a hang here is a finding (the
                // watchdog is pure failure detection).
                bodyText = await watchdog(new Response(mainStream).text(), "lane body")
                fpMap = (await trailer) as Record<string, { from: string; to: string }> | null
              } catch (err) {
                if (err instanceof Error && err.message.includes("fuzz watchdog")) throw err
                // Torn lane (navigation tear, cancelled render) — the
                // client's decode rejects and nothing commits. An
                // ANNOUNCED torn body (its `seq` entry preceded the
                // tear — an early-announcing forced lane, a producer)
                // consumes PROCESSED with a drop report, exactly the
                // client's `_laneDeliveryDroppedStale`: a permanent seq
                // gap would wedge the contiguous watermark forever.
                drainEntries()
                const tq = laneSeqs.get(lane.partonId)
                if (tq !== undefined && tq.length > 0) {
                  const torn = tq.shift()!
                  seenSeqs.add(torn.seq)
                  pendingDropped.push(torn.seq)
                  advanceWatermark()
                }
                continue
              }
              drainEntries()
              const q = laneSeqs.get(lane.partonId)
              const announced = q !== undefined && q.length > 0 ? q.shift()! : null
              return {
                kind: "lane",
                id: lane.partonId,
                ex: extractPartonView(bodyText),
                fpUpdates: fpMap !== null ? Object.entries(fpMap) : [],
                seq: announced?.seq ?? null,
                asof: announced?.asof ?? null,
              }
            }
            const seg = await watchdog(h.segments.next(), "segment iterator")
            if (seg.done) {
              throw new Error("live stream ended mid-sequence (driver exited or degraded)")
            }
            const s: Segment = seg.value
            if (s.kind === "lanes") {
              laneIter = s.lanes[Symbol.asyncIterator]()
              continue
            }
            const text = await watchdog(new Response(s.body).text(), "payload segment body")
            await watchdog(s.trailers, "payload segment trailers")
            drainEntries()
            const rec = segConsumed < segRecords.length ? segRecords[segConsumed++] : null
            return {
              kind: "segment",
              ex: extractPartonView(text),
              fpUpdates: rec?.fps ?? [],
              seq: rec?.seq ?? null,
              asof: rec?.asof ?? null,
            }
          }
        }

        // ── commit rules — the client's merge, at model granularity.
        const applyExtraction = (ex: ExtractedPayload, wholeTree: boolean): void => {
          const present = new Set<string>()
          for (const obs of ex.observations) {
            if (obs.parked) continue
            present.add(obs.id)
            const e = entry(obs.id)
            e.live = true
            if (obs.kind === "fresh") {
              e.fp = obs.fp
              e.matchKey = obs.matchKey
            }
            // hole / confirm: the client's cached copy stands.
          }
          for (const [id] of ex.pairs) {
            entry(id).live = true
            present.add(id)
          }
          if (wholeTree) {
            // An id absent from a whole-tree segment leaves the current
            // tree (match-miss park) — UNLESS an ancestor is present as
            // a culled pair or a placeholder: the descendant's fiber is
            // retained INSIDE that ancestor's content slot (a fresh
            // ancestor body re-states its descendants explicitly, so
            // they are in `present` themselves).
            for (const id of fixture.universeIds) {
              if (present.has(id)) continue
              let retained = false
              for (let p = fixture.parentOf[id]; p !== undefined; p = fixture.parentOf[p]) {
                if (present.has(p)) {
                  retained = true
                  break
                }
              }
              if (!retained) entry(id).live = false
            }
          }
          for (const [id, stamp] of ex.stamps) {
            entry(id).stamp = stamp
          }
        }
        const applyFpUpdates = (ups: Array<[string, { from: string; to: string }]>): void => {
          for (const [id, { from, to }] of ups) {
            const e = entry(id)
            if (e.fp === from) e.fp = to
          }
        }

        const maybeAck = async (force: boolean): Promise<void> => {
          advanceWatermark()
          if (watermark <= lastAcked) return
          // An as-of drop report flushes PROMPTLY — the client's
          // `_reportAsOfDrop` schedules a channel flush rather than
          // waiting for the next passenger, because the server's
          // optimistic mirror holds the dropped delivery's promotions
          // until the report evicts them.
          const dropPending = pendingDropped.some((s) => s <= watermark)
          if (!force && !dropPending && watermark - lastAcked < ACK_EVERY) return
          const dropped = pendingDropped.filter((s) => s <= watermark)
          const kept = pendingDropped.filter((s) => s > watermark)
          pendingDropped.length = 0
          pendingDropped.push(...kept)
          const frames: ChannelFrame[] = [
            { kind: "ack", delivered: watermark, ...(dropped.length > 0 ? { dropped } : {}) },
          ]
          lastAcked = watermark
          debug?.(`ack delivered=${watermark} dropped=[${dropped.join(",")}]`)
          await postEnvelope(frames)
        }

        /** Apply one wire event; returns true when it committed with
         *  the sentinel's `tick` stamp. Only a LANE carrying it
         *  terminates a settle window — see `settle`. */
        const applyEvent = async (ev: WireEvent, tick: number | null): Promise<boolean> => {
          debug?.(
            `event ${ev.kind}${ev.kind === "lane" ? `:${ev.id}` : ""} seq=${ev.seq} asof=${ev.asof} ` +
              `stamps=${JSON.stringify([...ev.ex.stamps])} pairs=${JSON.stringify([...ev.ex.pairs])} ` +
              `fpUpdates=${JSON.stringify(ev.fpUpdates)} obs=${JSON.stringify(ev.ex.observations)}`,
          )
          let committable = true
          if (ev.seq !== null) {
            seenSeqs.add(ev.seq)
            committable = ev.asof === null || ev.asof >= navPoint
            if (!committable) pendingDropped.push(ev.seq)
          } else if (ev.kind === "lane") {
            // Unannounced lane body — a cancelled/superseded render;
            // never commits.
            committable = false
          }
          if (committable) {
            applyExtraction(ev.ex, ev.kind === "segment")
            applyFpUpdates(ev.fpUpdates)
          }
          await maybeAck(false)
          return (
            committable &&
            tick !== null &&
            ev.ex.stamps.get(fixture.sentinelId) === fixture.sentinelStampFor(tick)
          )
        }

        const postEnvelope = async (frames: ChannelFrame[]): Promise<number> => {
          const conn = h.connectionId()
          if (conn === null) throw new Error("no connection id yet")
          const envelope: ChannelEnvelope = { connection: conn, seq: ++envelopeSeq, frames }
          const request = new Request(`http://localhost${CHANNEL_ENDPOINT}`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-test-scope": scope },
            body: JSON.stringify(envelope),
          })
          const { result: res } = await runWithRequestAsync(request, () =>
            handleChannelPost(request),
          )
          if (res.status !== 204) {
            throw new Error(`channel envelope answered ${res.status} (seq ${envelopeSeq})`)
          }
          return envelopeSeq
        }

        const settle = async (): Promise<void> => {
          for (let round = 0; round < MAX_SETTLE_ROUNDS; round++) {
            let tick = ++sentinelTick
            debug?.(`settle round ${round} tick=${tick}`)
            await fixture.bumpSentinel(scope, currentUrl, tick)
            let sawOther = false
            // The round's terminator: the sentinel LANE carrying the
            // current tick (the wake that lanes it drained the one
            // pending set) — but only once the contiguous watermark
            // covers its delivery seq. Lane OPENINGS can reorder
            // relative to delivery seqs: two adjacent wakes' pumps race
            // their FIRST chunks onto the wire, so the sentinel's lane
            // can surface ahead of an earlier-seq lane still in the
            // pipe — terminating on it would leave that delivery
            // unconsumed and mis-report the server as stale (a model
            // artifact; the real client decodes lanes concurrently and
            // commits every arrival). The seq gap is the real signal:
            // every minted seq reaches the wire (a body's seq entry, a
            // torn-consume, or a `seqvoid`), so draining to coverage is
            // bounded — a genuinely-lost seq is a wedged watermark,
            // which the watchdog surfaces as a finding.
            let terminatorSeq: number | null = null
            let sawTerminator = false
            while (true) {
              const ev = await nextEvent()
              const hasCurrentStamp = await applyEvent(ev, tick)
              if (hasCurrentStamp && ev.kind === "lane") {
                sawTerminator = true
                terminatorSeq = ev.seq
              } else {
                sawOther = true
                // A whole-tree SEGMENT never terminates — even one
                // carrying the current stamp. It is a covering render (a
                // navigation/refetch consume), and scheduled work can
                // TRAIL it: the statement's forced lanes start only after
                // the region reopens, and a bump landing mid-render stays
                // pending (the coverage cursor anchors before the render
                // begins) with its lane following. Re-state the bump with
                // a fresh tick (deterministic — triggered by the
                // segment's own arrival, never a timer) so the loop
                // watches exactly one current tick; counted as a
                // diagnostic. A stale terminator (an older tick's lane)
                // no longer terminates: `hasCurrentStamp` compares the
                // fresh tick.
                if (ev.kind === "segment") {
                  tick = ++sentinelTick
                  result.sentinelRebumps++
                  debug?.(`settle re-bump tick=${tick} (covering segment)`)
                  await fixture.bumpSentinel(scope, currentUrl, tick)
                  sawTerminator = false
                  terminatorSeq = null
                }
              }
              if (sawTerminator) {
                advanceWatermark()
                if (terminatorSeq === null || watermark >= terminatorSeq) break
                debug?.(
                  `settle terminator seq=${terminatorSeq} gapped (watermark=${watermark}) — draining`,
                )
              }
            }
            await maybeAck(true)
            if (!sawOther) return
          }
          throw new Error(`settle did not quiesce within ${MAX_SETTLE_ROUNDS} sentinel rounds`)
        }

        // ── The walk. Errors are contained here (recorded as the
        // sequence's failure) so the drive is ALWAYS shut down — an
        // abandoned parked driver would outlive the run, holding its
        // wake subscription against the module-global registries the
        // next sequence's isolate() clears, and poison every later
        // run in the process.
        try {
          // Segment 0 (the attach's whole-tree render).
          await applyEvent(await nextEvent(), null)
          await maybeAck(true)

          await runWalk()
        } catch (err) {
          result.failure = err instanceof Error ? (err.stack ?? err.message) : String(err)
        } finally {
          const conn = h.connectionId()
          const session = conn !== null ? _peekConnectionSession(conn) : undefined
          capturedVisible = session?.visible != null ? [...session.visible].sort() : null
          try {
            await h.shutdown(fixture.sentinelId)
          } catch {
            /* the drive is already torn — nothing to release */
          }
        }

        async function runWalk(): Promise<void> {
          for (const action of actions) {
            debug?.(`action ${JSON.stringify(action)}`)
            switch (action.kind) {
              case "navigate": {
                navPoint = await postEnvelope([{ kind: "url", url: action.url, intent: "push" }])
                currentUrl = action.url
                break
              }
              case "write": {
                const w = fixture.writes[action.cell % fixture.writes.length]
                await w.apply(scope, currentUrl, action.value)
                break
              }
              case "flip": {
                const changed: string[] = []
                const cached: string[] = []
                for (const id of action.ids) {
                  const goingIn = !statedVisible.has(id)
                  if (goingIn) statedVisible.add(id)
                  else statedVisible.delete(id)
                  changed.push(id)
                  // The client's pair swaps DISPLAY locally (the stated
                  // set drives `displayedState`): a cull-out shows the
                  // skeleton with zero server bytes; a cull-in redisplays
                  // the retained content (possibly stale) until the
                  // flip's lane confirms or replaces it.
                  const e = model.get(id)
                  if (e?.fp != null && e.matchKey != null) {
                    cached.push(`${id}:${e.matchKey}:${e.fp}`)
                  }
                }
                await postEnvelope([
                  { kind: "visible", changed, visible: [...statedVisible], cached },
                ])
                break
              }
              case "refetch": {
                const sep = currentUrl.includes("?") ? "&" : "?"
                navPoint = await postEnvelope([
                  {
                    kind: "url",
                    url: `${currentUrl}${sep}__force=${action.label}`,
                    intent: "silent",
                  },
                ])
                break
              }
              case "settle": {
                await settle()
                break
              }
            }
          }
          await settle()
        }
      },
      {
        attach: {
          cached: [],
          since: null,
          visible: [...fixture.initialVisible],
          url: attachUrl.pathname + attachUrl.search,
        },
      },
    )

    // ── The oracle: cold render of the final request state. A walk
    // that FAILED has a partial model — the failure is the finding;
    // comparing would only add noise.
    result.finalUrl = currentUrl
    result.visible = capturedVisible ?? []
    if (result.failure !== null) return result
    const oracle = await oracleColdRender(
      fixture,
      `http://localhost${currentUrl}`,
      scope,
      capturedVisible,
    )
    result.mismatches = compare(fixture, model, statedVisible, oracle)
  } catch (err) {
    result.failure = err instanceof Error ? (err.stack ?? err.message) : String(err)
  }
  return result
}

// ─── The oracle ──────────────────────────────────────────────────────

async function oracleColdRender(
  fixture: FuzzFixture,
  url: string,
  scope: string,
  visible: string[] | null,
): Promise<Map<string, OracleState>> {
  const request = new Request(url, { headers: { "x-test-scope": scope } })
  const { result } = await runWithRequestAsync(request, async () => {
    if (visible !== null) {
      _setConnectionSession({ visible: new Set(visible), ackedFps: new Map() })
    }
    const stream = wrapStreamWithFpTrailer(
      renderServerToFlight(fixture.page()),
      _captureCommitHandle(),
    )
    const fpHeals: Array<[string, { from: string; to: string }]> = []
    const iter = splitSegments(stream, undefined, (tag, body) => {
      if (tag === "fp") {
        const map = JSON.parse(new TextDecoder().decode(body)) as Record<
          string,
          { from: string; to: string }
        >
        for (const [id, pair] of Object.entries(map)) fpHeals.push([id, pair])
      }
    })[Symbol.asyncIterator]()
    const seg = await iter.next()
    if (seg.done || seg.value.kind !== "payload") throw new Error("oracle render: no payload")
    const text = await new Response(seg.value.body).text()
    await seg.value.trailers
    await iter.return?.()
    const ex = extractPartonView(text)
    // Heal cold fps to warm — the same trailer discipline the client
    // applies (`from` must match to move).
    const warm = new Map<string, string>()
    for (const obs of ex.observations) {
      if (!obs.parked && obs.kind === "fresh" && obs.fp !== null) warm.set(obs.id, obs.fp)
    }
    for (const [id, { from, to }] of fpHeals) {
      if (warm.get(id) === from) warm.set(id, to)
    }
    const states = new Map<string, OracleState>()
    for (const id of fixture.universeIds) {
      if (ex.pairs.get(id) === true) {
        states.set(id, { state: "culled" })
        continue
      }
      const fresh = ex.observations.find((o) => !o.parked && o.id === id && o.kind === "fresh")
      if (fresh !== undefined) {
        states.set(id, {
          state: "content",
          stamp: ex.stamps.get(id) ?? null,
          fp: warm.get(id) ?? fresh.fp,
          matchKey: fresh.matchKey,
        })
        continue
      }
      const holed = ex.observations.find((o) => !o.parked && o.id === id)
      if (holed !== undefined) {
        // A cold render presents no manifest, so a non-parked hole is
        // an oracle anomaly — surface it as content-with-nothing so the
        // comparison flags it.
        states.set(id, { state: "content", stamp: null, fp: null, matchKey: holed.matchKey })
        continue
      }
      states.set(id, { state: "absent" })
    }
    return states
  })
  return result
}

// ─── Comparison ──────────────────────────────────────────────────────

function displayedState(
  fixture: FuzzFixture,
  model: Map<string, ModelEntry>,
  stated: ReadonlySet<string>,
  id: string,
): "content" | "culled" | "absent" {
  const e = model.get(id)
  if (e === undefined || !e.live) return "absent"
  // A culled or non-live ancestor parks this subtree client-side —
  // the displayed tree does not contain it, matching the cold render
  // where the ancestor's body never runs.
  const culls = (x: string): boolean => fixture.cullableIds.includes(x) && !stated.has(x)
  for (let p = fixture.parentOf[id]; p !== undefined; p = fixture.parentOf[p]) {
    const pe = model.get(p)
    if (pe === undefined || !pe.live || culls(p)) return "absent"
  }
  // The pair's displayed cull state is `reported ?? emission` — the
  // client's own statement (the stated set) has precedence over any
  // emission prop, so display follows the stated set directly.
  return culls(id) ? "culled" : "content"
}

function compare(
  fixture: FuzzFixture,
  model: Map<string, ModelEntry>,
  stated: ReadonlySet<string>,
  oracle: Map<string, OracleState>,
): Mismatch[] {
  const mismatches: Mismatch[] = []
  for (const id of fixture.universeIds) {
    const want = oracle.get(id) ?? { state: "absent" as const }
    const gotState = displayedState(fixture, model, stated, id)
    if (want.state !== gotState) {
      mismatches.push({ id, field: "state", expected: want.state, actual: gotState })
      continue
    }
    if (want.state !== "content" || gotState !== "content") continue
    const e = model.get(id)!
    if ((want.stamp ?? "") !== (e.stamp ?? "")) {
      mismatches.push({
        id,
        field: "stamp",
        expected: want.stamp ?? "<none>",
        actual: e.stamp ?? "<none>",
      })
    }
    if (want.matchKey !== null && e.matchKey !== null && want.matchKey !== e.matchKey) {
      mismatches.push({ id, field: "matchKey", expected: want.matchKey, actual: e.matchKey })
    }
    // The sentinel is exempt from fp equality: the drive's shutdown
    // wake is a refreshSelector bump on its label, which moves its inv
    // fold AFTER the model's capture — a harness artifact, not client
    // state. Its stamp still compares.
    if (
      !fixture.foldDriftAllowed.has(id) &&
      id !== fixture.sentinelId &&
      want.fp !== null &&
      e.fp !== null &&
      want.fp !== e.fp
    ) {
      mismatches.push({ id, field: "fp", expected: want.fp, actual: e.fp })
    }
  }
  return mismatches
}

// ─── Shrinking ───────────────────────────────────────────────────────

/**
 * Delta-debug the failing action sequence to a locally-minimal repro:
 * chunk removal (halves, quarters, …) then single-action removal,
 * re-running each candidate in fresh isolation. The predicate is "the
 * run still fails" (any mismatch or failure) — each candidate re-run
 * is independently oracle-checked.
 */
export async function shrinkSequence(
  fixture: FuzzFixture,
  seed: number,
  actions: FuzzAction[],
  isolate: () => void,
  maxRuns = 200,
): Promise<{ actions: FuzzAction[]; result: SequenceResult; runs: number }> {
  let current = actions
  let best = await runSequence(fixture, seed, current, isolate)
  let runs = 1

  // Shrink against the ORIGINAL failure's signature — a candidate that
  // fails differently (another parton, a harness watchdog) is a
  // different finding and must not steer this shrink (adopting it
  // would also let slow watchdog candidates dominate the budget).
  const signatureOf = (r: SequenceResult): Set<string> => {
    const sig = new Set<string>()
    if (r.failure !== null) sig.add("failure")
    for (const m of r.mismatches) sig.add(`${m.id}.${m.field}`)
    return sig
  }
  const wanted = signatureOf(best)
  const fails = (r: SequenceResult): boolean => {
    const sig = signatureOf(r)
    for (const k of sig) if (wanted.has(k)) return true
    return false
  }

  if (wanted.size === 0) return { actions: current, result: best, runs }

  let chunk = Math.max(1, Math.floor(current.length / 2))
  while (runs < maxRuns) {
    let removedAny = false
    for (let start = 0; start + chunk <= current.length && runs < maxRuns; ) {
      const candidate = [...current.slice(0, start), ...current.slice(start + chunk)]
      if (candidate.length === 0) {
        start += chunk
        continue
      }
      const r = await runSequence(fixture, seed, candidate, isolate)
      runs++
      if (fails(r)) {
        current = candidate
        best = r
        removedAny = true
        // same start — the window now holds fresh actions to try
      } else {
        start += chunk
      }
    }
    if (!removedAny) {
      if (chunk === 1) break
      chunk = Math.max(1, Math.floor(chunk / 2))
    }
  }
  return { actions: current, result: best, runs }
}

export function formatResult(r: SequenceResult): string {
  const lines: string[] = []
  lines.push(`seed=${r.seed} actions=${JSON.stringify(r.actions)}`)
  lines.push(
    `finalUrl=${r.finalUrl} visible=[${r.visible.join(",")}] sentinelRebumps=${r.sentinelRebumps}`,
  )
  if (r.failure !== null) lines.push(`FAILURE: ${r.failure}`)
  for (const m of r.mismatches) {
    lines.push(`MISMATCH ${m.id}.${m.field}: expected ${m.expected}, got ${m.actual}`)
  }
  return lines.join("\n")
}
