/**
 * /streaming-demo — exercises the framework's live-update primitives.
 *
 * Four live demonstrations:
 *
 *  1. `<LiveTick>` — pure time-driven partial. Its body reads the
 *     render clock, buckets it by second, and declares
 *     `expires(time().nextSecond)`. The framework's `<LivePageHeartbeat>`
 *     holds a streaming connection open; the segment driver wakes
 *     at each second boundary and ships a fresh lane. No cell, no
 *     setInterval, no autostart.
 *
 *  2. `<BumpCounter>` — `bumps` cell resolved in the Render body. The
 *     Bump button (rendered inside the same parton) calls
 *     `bumps.set(bumps.value + 1)` via the cell's Flight-serialized
 *     server-action ref. The action's response refetches
 *     `cell:demo.bumps`, which the cell layer auto-stamps onto this
 *     parton's labels.
 *
 *  3. `<PushUrlButton>` — fires a server action that calls
 *     `getServerNavigation().navigate("?seq=N")`. URL pushed via
 *     trailer; unrelated to cells.
 *
 *  4. `<CardFormPartial>` — controlled-form demo. Three cells
 *     (name / number / cvc) resolved in the Render body, bound to a client
 *     `<CardForm>` whose single-inflight + replace-coalesce
 *     discipline guarantees in-order writes despite random
 *     per-action server delay (0–1500 ms). All three cells are
 *     written by one batched action inside a nested
 *     `runInvalidationTransaction` so the segment driver wakes once
 *     per keystroke and one segment ships with all updates.
 */

import { expires, parton, time, type RenderArgs } from "@parton/framework"
import { Card, CardContent, CardHeader, CardTitle } from "@parton/copies/components/ui/card"
import { BumpButton, PushUrlButton } from "../components/streaming-demo-buttons.tsx"
import { CardForm } from "../components/streaming-demo-card-form.tsx"
import {
  applyLocalTransform as applyLocalTransformCell,
  bumps as bumpsCell,
  cardCvc as cardCvcCell,
  cardName as cardNameCell,
  cardNumber as cardNumberCell,
  serverDelay as serverDelayCell,
} from "./streaming-demo-state.ts"

// ── Live tick partial — time-driven, no cell ────────────────────────

const LiveTick = parton(
  function LiveTickRender(_: RenderArgs) {
    // Wake boundary: fresh render every second — the live driver arms
    // on it, and fp-skip declines a snapshot past it (TTL gate).
    const clock = time()
    expires(clock.nextSecond)
    const tick = Math.floor(clock.now / 1000)
    return (
      <div className="font-mono text-sm" data-testid="streaming-demo-tick">
        Tick #{tick} · server time {new Date().toLocaleTimeString()}
      </div>
    )
  },
  { selector: "streaming-demo-tick" },
)

// ── Bump counter + button — cell-backed, button inline ──────────────

const BumpCounter = parton(
  async function BumpCounterRender(_: RenderArgs) {
    const bumps = await bumpsCell.resolve()
    return (
      <div className="flex flex-col gap-3">
        <div className="font-mono text-sm" data-testid="streaming-demo-bumps">
          Bumps: {bumps.value}
        </div>
        <BumpButton bumps={bumps} />
      </div>
    )
  },
  { selector: "bump-counter" },
)

// ── Card form — three cells, atomic batch, single-inflight client ───

const CardFormPartial = parton(
  async function CardFormPartialRender(_: RenderArgs) {
    const [cardName, cardNumber, cardCvc, serverDelay, applyLocalTransform] = await Promise.all([
      cardNameCell.resolve(),
      cardNumberCell.resolve(),
      cardCvcCell.resolve(),
      serverDelayCell.resolve(),
      applyLocalTransformCell.resolve(),
    ])
    return (
      <CardForm
        cardName={cardName}
        cardNumber={cardNumber}
        cardCvc={cardCvc}
        serverDelay={serverDelay}
        applyLocalTransform={applyLocalTransform}
      />
    )
  },
  { selector: "card-form" },
)

// ── Page ──────────────────────────────────────────────────────────────

export const StreamingDemoPage = parton(
  function StreamingDemoRender() {
    return (
      <main className="py-4 space-y-4">
        <title>Streaming primitives demo</title>
        <h1 className="text-2xl font-semibold">Streaming primitives</h1>
        <p className="text-sm text-muted-foreground">
          Three live demonstrations of the segmented-Flight server primitives. Open the network
          panel to watch chunks land in one rolling HTTP response.
        </p>

        <Card className="p-5">
          <CardHeader className="px-0">
            <CardTitle className="text-base">
              1. live tick (time-driven, framework heartbeat)
            </CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            <p className="mb-2 text-xs text-muted-foreground">
              The body declares <code>expires(time().nextSecond)</code>. The framework's heartbeat
              holds the page's RSC connection open; the segment driver wakes at each second boundary
              and re-renders, shipping the next tick as a new lane.
            </p>
            <LiveTick />
          </CardContent>
        </Card>

        <Card className="p-5">
          <CardHeader className="px-0">
            <CardTitle className="text-base">
              2. <code>cell.set()</code> — client-mutated counter
            </CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            <p className="mb-2 text-xs text-muted-foreground">
              Bump button calls <code>bumps.set(bumps.value + 1)</code> through the cell's
              Flight-serialized server-action ref. The action's response refetches{" "}
              <code>cell:demo.bumps</code>, which the cell layer auto-stamps onto this parton's
              labels.
            </p>
            <BumpCounter />
          </CardContent>
        </Card>

        <Card className="p-5">
          <CardHeader className="px-0">
            <CardTitle className="text-base">
              3. <code>getServerNavigation().navigate(url)</code> — server-pushed URL
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 px-0">
            <p className="text-xs text-muted-foreground">
              The Push URL button fires a server action that calls{" "}
              <code>{"getServerNavigation().navigate(`?seq=${N}`)"}</code>. The response trailer
              carries a <code>url</code> entry that the client applies via{" "}
              <code>{"_windowNav().navigate(url, { silent: true })"}</code> — same URL bar update,
              no redundant page-level refetch.
            </p>
            <PushUrlButton />
          </CardContent>
        </Card>

        <Card className="p-5">
          <CardHeader className="px-0">
            <CardTitle className="text-base">
              4. controlled form — three cells, atomic batch, random server delay
            </CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            <p className="mb-3 text-xs text-muted-foreground">
              Five cells: three form values (<code>cardName</code>, <code>cardNumber</code>,{" "}
              <code>cardCvc</code>) and two demo toggles (<code>serverDelay</code>,{" "}
              <code>applyLocalTransform</code>). The client binds inputs via{" "}
              <code>useCell(cell).input(...)</code> — the hook owns refs, caret restoration, and the
              per-keystroke transform + <code>set</code> pipeline. Each keystroke fires{" "}
              <code>set</code> on name/number AND a coin-flipped CVC: 50% in the same microtask
              batch (one <code>__cellWriteBatch</code> POST, all three cells commit together), 50%
              via a 50 ms setTimeout (two POSTs). Per-batch latency is a trimodal simulator (0–30 ms
              / 100–200 ms / 400–500 ms), gated by the <code>serverDelay</code> cell so the toggle
              broadcasts the choice across tabs. Open in a second tab to watch the authoritative
              panel update from the other tab's typing — every cell is global (
              <code>partition: () =&gt; ({"{}"})</code>), broadcast rides the open heartbeat stream.
            </p>
            <CardFormPartial />
          </CardContent>
        </Card>
      </main>
    )
  },
  { match: "/streaming-demo" },
)
