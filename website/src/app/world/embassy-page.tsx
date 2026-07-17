import { getEmbedGrants, parton, type RenderArgs } from "@parton/framework"
import {
  Divider,
  Heading,
  Row,
  Stack,
  Text,
  VocabularyStyles,
} from "@parton/framework/lib/vocabulary.tsx"

/**
 * The embassy's bulletin — the EMBEDDABLE PAGE behind the embassy
 * district's building (`./embassy-district.tsx`). An embeddable page
 * is an ordinary page (`docs/reference/remote-frame.md`): this parton
 * is gated to its own route, browsable standalone at
 * `/embassy/bulletin`, and the world embeds that URL with
 * `<RemoteFrame grant="paint">` — the app embedding itself.
 *
 * Authored against the framework vocabulary (the deep import above)
 * so it survives a paint splice: only the vetted tag set crosses, and
 * the tags paint from the HOST's stylesheet — the world's theme, not
 * this page's. The one exception is deliberate: the raw `<div>` below
 * is contraband, the violation-policy exhibit. Standalone it renders
 * like any HTML; at the border (the host's tier rewriter) it degrades
 * — DEV shows a `parton-tier-violation` marker in its place, prod
 * drops the row silently and logs one structured line.
 *
 * The world page's match carves out `/embassy` (`./world-page.tsx`),
 * so this page's body carries the bulletin alone — the "lean embed
 * surfaces" verdict from the embed-economics measurement.
 *
 * ── Seams: the district's remaining exhibits ──
 * Each future exhibit is another ordinary page under `/embassy/*`
 * (already excluded from the world's match), placed in `root.tsx` and
 * embedded by a wing of the building overlay:
 *   - /embassy/trade-desk  — the INTERACTIVE embassy (arc increment 5:
 *     Interactive grant + a bound cart cell; vocabulary form members).
 *   - /embassy/customs     — the URL-FOLLOWING embassy (arc increment
 *     6: request mask ∩ manifest; routes on a projection of the host
 *     URL).
 *   - /embassy/late-courier — the DEADLINE-MISSER (the `deadline`
 *     knob: a page that loses the host-side race on purpose, showing
 *     the fallback + on-late policy).
 */
export const EmbassyBulletin = parton(
  async function EmbassyBulletinRender(_: RenderArgs) {
    // The embed-surface variant, producer-side: under a
    // vocabulary-constrained grant a <style> row would itself be
    // contraband (and the HOST already ships the vocabulary
    // stylesheet); on an ordinary browser visit this page is the whole
    // document and must paint its own tags.
    const standalone = getEmbedGrants() === null
    return (
      <Stack gap="md" data-testid="embassy-bulletin">
        {standalone ? <VocabularyStyles /> : null}
        <Heading level={2} data-testid="embassy-bulletin-title">
          PEOPLES BULLETIN — WEEK 29
        </Heading>
        <Text size="sm" tone="muted">
          Issued by the Ministry of Information for display in foreign territories. The host
          territory provides the paint.
        </Text>
        <Divider />
        <Row justify="between">
          <Text tone="muted">Border crossings</Text>
          <Text data-testid="embassy-bulletin-border">OPEN</Text>
        </Row>
        <Row justify="between">
          <Text tone="muted">Trade caravans</Text>
          <Text>3 inbound</Text>
        </Row>
        <Row justify="between">
          <Text tone="muted">Vocabulary compliance</Text>
          <Text tone="positive">CERTIFIED</Text>
        </Row>
        <Divider />
        {/* CONTRABAND — the violation-policy exhibit: a raw styled
            element, not vocabulary. Standalone (this page is ordinary
            HTML) it renders below; under the world's paint grant the
            border seizes it — dev leaves a marker, prod drops the row. */}
        <div
          data-testid="embassy-contraband"
          style={{
            padding: "8px",
            border: "2px dashed #ff5f56",
            color: "#ff5f56",
            fontWeight: 700,
          }}
        >
          GLORIOUS FIREWORKS — 50% OFF (raw HTML, smuggled)
        </div>
        {/* CONTRABAND #2 — the escalation exhibit: a raw link. A spliced
            embed lives in the HOST document, so an anchor that crossed
            would natively navigate the WHOLE host page on click — and a
            cross-origin href is not even interceptable by the host's
            navigate listener. Links are deliberately not vocabulary; the
            border seizes this one like the crate. */}
        <a
          data-testid="embassy-defection-link"
          href="https://ministry.example/defect"
          style={{ color: "#ff5f56", fontWeight: 700 }}
        >
          DEFECT TODAY — apply at ministry.example (raw link, smuggled)
        </a>
        <Text size="sm" tone="muted">
          This bulletin is an ordinary page — visit /embassy/bulletin. Embedded under a paint grant,
          everything above crosses; the crate and the link do not.
        </Text>
      </Stack>
    )
  },
  { match: "/embassy/bulletin" },
)
