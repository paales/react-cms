/**
 * Interactive-tier embeddable page + published cells — this app's
 * half of the Interactive grant and the remoteCell contract.
 *
 *   /remote/interactive-panel — vocabulary page whose interactive
 *     members bind to CELLS AND ACTIONS THIS APP HOSTS: a quantity
 *     TextField writing `magento.qty` through the capability-scoped
 *     `/__remote/cells/write` endpoint, and a bid Button invoking the
 *     `place-bid` embedAction (a server-side `update` — increments
 *     compose, so a lost write would be arithmetically visible).
 *     Under `grant="interactive"` the host's bridge wires them; under
 *     a plain Paint grant the same rows degrade in place.
 *
 * `magento.bid` is PUBLISHED (`publish: true`): a host process may
 * attach to its bumps and read its value across the boundary
 * (remoteCell). `magento.qty` is deliberately NOT published — the
 * outward surface is opt-in per cell.
 */

import { embedAction, localCell, parton, type RenderArgs } from "@parton/framework"
import {
  Box,
  Button,
  Heading,
  Row,
  Stack,
  Text,
  TextField,
} from "@parton/framework/lib/vocabulary.tsx"

export const BID_STEP = 50

export const magentoQty = localCell({
  id: "magento.qty",
  shape: "string",
  initial: "1",
  // Server-side canonicalisation: digits only, bounded length.
  write: (raw) => raw.replace(/[^0-9]/g, "").slice(0, 4) || "1",
})

export const magentoBid = localCell({
  id: "magento.bid",
  shape: "number",
  initial: 100,
  // Published across the boundary — the remoteCell attach/value
  // endpoints serve it to any capability (trust-the-network v1).
  publish: true,
})

// The bid is an increment — a composed `update`, never a client-set
// absolute value (two racing bidders must both land).
embedAction("place-bid", async () => {
  await magentoBid.update((current) => current + BID_STEP)
})

export const MagentoInteractivePanel = parton(
  async function MagentoInteractivePanelRender(_: RenderArgs) {
    const qty = await magentoQty.resolve()
    const bid = await magentoBid.resolve()
    return (
      <Box padding="md" tone="subtle" data-testid="interactive-panel">
        <Stack gap="md">
          <Heading level={2}>Interactive panel</Heading>
          <TextField cell={qty} label="Quantity" type="text" data-testid="interactive-qty" />
          <Row justify="between">
            <Text tone="muted">Server quantity</Text>
            <Text data-testid="interactive-qty-value">{qty.value}</Text>
          </Row>
          <Row justify="between" align="center">
            <Text tone="muted">Current bid</Text>
            <Text tone="strong" data-testid="interactive-bid-value">
              EUR {bid.value}
            </Text>
          </Row>
          <Button action="place-bid" data-testid="interactive-bid-button">
            <Text>Bid +{BID_STEP}</Text>
          </Button>
          <Text size="sm" tone="muted">
            Writes land in e2e-magento's cells; the host bridge carries them.
          </Text>
        </Stack>
      </Box>
    )
  },
  { selector: "interactive-panel", match: "/remote/interactive-panel" },
)
