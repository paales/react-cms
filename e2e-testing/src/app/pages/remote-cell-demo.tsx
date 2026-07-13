/**
 * /remote-cell-demo — remoteCell: the outward state contract.
 *
 * `magento.bid` lives in the e2e-magento process (published there via
 * `publish: true`). This host holds a read-only `remoteCell` handle:
 * the first resolve attaches to the remote's committed-bump stream
 * (server-to-server wake subscription), each doorbell drops the
 * host-side cached value and re-emits through the invalidation bridge
 * (`deliverInvalidationBumps`), and the re-render's resolve re-reads
 * the value over the remote's `/__remote/cells/value` endpoint — the
 * store is the truth; the bump is a doorbell.
 *
 * End to end: a bid placed in the REMOTE process (the interactive
 * demo's button, or a direct write POST) re-renders this parton on
 * its held live connection with the fresh amount — no reload, no
 * polling.
 */

import { parton, remoteCell, type RenderArgs } from "@parton/framework"
import { MAGENTO_ORIGIN } from "../../remote/magento"

const magentoBid = remoteCell<number>({
  origin: MAGENTO_ORIGIN,
  id: "magento.bid",
  initial: 0,
})

export const RemoteCellDemoPage = parton(
  async function RemoteCellDemoRender(_: RenderArgs) {
    const bid = await magentoBid.resolve()
    return (
      <main className="py-4 space-y-4">
        <title>remoteCell demo</title>
        <header>
          <h1 className="text-2xl font-semibold">remoteCell demo</h1>
          <p className="text-sm text-muted-foreground">
            <code>magento.bid</code> is a cell of the e2e-magento PROCESS (port 5181), published
            across the boundary. Bids placed over there land here live — doorbell in, value re-read,
            parton re-rendered on the held stream.
          </p>
        </header>
        <div className="text-3xl font-mono" data-testid="remote-cell-bid">
          EUR {bid.value}
        </div>
      </main>
    )
  },
  { match: "/remote-cell-demo", selector: "#remote-cell-demo" },
)
