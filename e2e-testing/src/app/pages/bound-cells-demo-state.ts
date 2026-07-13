/**
 * /bound-cells-demo host state — the cell the host BINDS into the
 * embedded remote page. Host-owned, host-partitioned; the remote only
 * ever sees projected values.
 */

import { localCell } from "@parton/framework"

export interface HostCart {
  total: number
  items: number
}

export const hostCart = localCell({
  id: "host.cart",
  shape: "opaque",
  initial: { total: 40, items: 2 } as HostCart,
})
