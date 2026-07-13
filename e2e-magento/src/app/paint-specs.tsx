/**
 * Paint-tier embeddable pages — authored against the framework
 * vocabulary (`@parton/framework/lib/vocabulary.tsx`) so they survive
 * a `grant="paint"` splice: the host's tier rewriter admits only the
 * vetted tag set, and the producer's grant-aware render (this app's
 * `Root` + the framework's bare parton emission) ships them without
 * any client apparatus.
 *
 *   /remote/paint-summary — pure vocabulary. The whole page paints
 *     under a Paint grant; the host themes it via `--parton-*` CSS
 *     custom properties.
 *   /remote/paint-mixed — vocabulary plus two deliberate violations
 *     (a raw `<div>`, a client component). Proves degrade-in-place:
 *     the offending rows resolve to nothing (DEV: a visible marker)
 *     while the surrounding vocabulary still paints.
 */

import { getCapability, parton, type RenderArgs } from "@parton/framework"
import {
  Box,
  Divider,
  Heading,
  Image,
  Row,
  Stack,
  Text,
} from "@parton/framework/lib/vocabulary.tsx"
import { PaintLeakWidget } from "./paint-leak-widget.tsx"

/** This app's own public origin — for absolute image URLs (the
 *  vocabulary's `src` audit rejects relative forms, which would
 *  resolve against the HOST origin). The Playwright config exports it
 *  to both dev servers; a plain `yarn dev:magento` uses the default. */
const SELF_ORIGIN = process.env.MAGENTO_REMOTE_ORIGIN ?? "http://localhost:5181"

export const MagentoPaintSummary = parton(
  async function MagentoPaintSummaryRender(_: RenderArgs) {
    const cap = getCapability()
    const currency = String(cap.currency ?? "EUR")
    const total = typeof cap.total === "number" ? cap.total : 127.45
    return (
      <Box padding="md" tone="subtle" data-testid="paint-summary">
        <Stack gap="md">
          <Row gap="md" align="center">
            <Image
              src={`${SELF_ORIGIN}/paint-logo.svg`}
              alt="e2e-magento"
              width={32}
              height={32}
              data-testid="paint-summary-logo"
            />
            <Heading level={2}>Order summary</Heading>
          </Row>
          <Row justify="between">
            <Text tone="muted">Subtotal</Text>
            <Text data-testid="paint-summary-subtotal">
              {currency} {(total - 10).toFixed(2)}
            </Text>
          </Row>
          <Row justify="between">
            <Text tone="muted">Shipping</Text>
            <Text>{currency} 10.00</Text>
          </Row>
          <Divider />
          <Row justify="between">
            <Text tone="strong">Total</Text>
            <Text tone="strong" data-testid="paint-summary-total">
              {currency} {total.toFixed(2)}
            </Text>
          </Row>
          <Text size="sm" tone="muted">
            Rendered by e2e-magento; painted entirely from the host bundle's vocabulary styles.
          </Text>
        </Stack>
      </Box>
    )
  },
  { selector: "paint-summary", match: "/remote/paint-summary" },
)

export const MagentoPaintMixed = parton(
  async function MagentoPaintMixedRender(_: RenderArgs) {
    return (
      <Stack gap="sm" data-testid="paint-mixed">
        <Heading level={3}>Mixed surface</Heading>
        <Text data-testid="paint-mixed-before">vocabulary line before the violations</Text>
        {/* Violation 1: a raw HTML element — not in the vocabulary. */}
        <div data-testid="paint-mixed-raw">raw div leak</div>
        {/* Violation 2: a client-module reference. */}
        <PaintLeakWidget />
        <Text tone="muted" data-testid="paint-mixed-after">
          still painted after the violations
        </Text>
      </Stack>
    )
  },
  { selector: "paint-mixed", match: "/remote/paint-mixed" },
)
