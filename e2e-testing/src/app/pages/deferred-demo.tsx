/**
 * /deferred-demo — the `deferred` cell write.
 *
 * A normal cell write commits on the action POST: the server re-renders,
 * the bytes come back on the POST response, the client reconciles. A
 * `deferred` cell skips that — its write's POST returns no root, and the
 * new value reaches the page ONLY through the already-open streaming
 * connection (the heartbeat's `?streaming=1` segment).
 *
 * This is the shape a cursor / scroll / presence firehose wants: fire
 * the write up as fast as you like, let the down-stream carry it to
 * every viewer, and never pay (or commit) a per-write render on the
 * POST. The writer paints locally; everyone — writer included — catches
 * up on the stream.
 *
 * The page shows it directly. `Pings:` is the server value; the Ping
 * button writes `pings + 1`. The `sent:` readout (client state) ticks
 * the instant the write round-trips, but `Pings:` only moves when the
 * next stream segment lands. Disable the heartbeat and `Pings:` freezes
 * while `sent:` keeps climbing — proof the value never rode the POST.
 */

import { localCell, parton, type RenderArgs, type ResolvedCell } from "@parton/framework"
import { Card, CardContent, CardHeader, CardTitle } from "@parton/copies/components/ui/card"
import { DeferredDemoReady, PingButton } from "../components/deferred-demo-ping.tsx"

// Global, deferred broadcast counter. `vary: () => ({})` → one shared
// partition across all viewers; `deferred: true` → writes ride the
// stream, not the POST. Default `localCell` storage is process-global
// (scope-bucketed, in-memory for test scopes), so a write on one
// connection is visible to every other connection's heartbeat render.
const pings = localCell({
  id: "demo.pings",
  shape: "number",
  vary: () => ({}),
  initial: 0,
  deferred: true,
})

const DeferredBroadcast = parton(
  function DeferredBroadcastRender({ pings }: { pings: ResolvedCell<number> } & RenderArgs) {
    return (
      <div className="flex flex-col gap-3">
        <div className="font-mono text-sm" data-testid="deferred-pings">
          Pings: {pings.value}
        </div>
        <PingButton pings={pings} />
      </div>
    )
  },
  {
    selector: "deferred-broadcast",
    schema: () => ({ pings }),
  },
)

export const DeferredDemoPage = parton(
  function DeferredDemoRender({ parent }: RenderArgs) {
    return (
      <main className="py-4 space-y-4">
        <title>Deferred cell writes</title>
        <h1 className="text-2xl font-semibold">Deferred (stream-only) writes</h1>
        <p className="text-sm text-muted-foreground">
          A <code>deferred</code> cell's write returns no re-render on the
          action POST — the new value reaches the page only through the
          open streaming connection. Open the network panel: the Ping POST
          comes back with an empty root, and <code>Pings:</code> updates on
          the next rolling segment of the heartbeat stream instead.
        </p>

        <Card className="p-5">
          <CardHeader className="px-0">
            <CardTitle className="text-base">deferred broadcast counter</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 px-0">
            <p className="text-xs text-muted-foreground">
              <code>Pings:</code> is the server value; <code>sent:</code> is
              client state that ticks the instant the write round-trips. They
              move a beat apart — the write completes, then the stream carries
              the value back. With the heartbeat off, <code>Pings:</code>{" "}
              freezes while <code>sent:</code> keeps climbing.
            </p>
            <DeferredBroadcast parent={parent} />
          </CardContent>
        </Card>

        <DeferredDemoReady />
      </main>
    )
  },
  { match: "/deferred-demo" },
)
