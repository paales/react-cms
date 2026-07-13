/**
 * The vocabulary — the framework-shipped, framework-vetted component
 * set an embedded payload may reference below the Client tier
 * (docs/notes/remote-frame-arc.md § The vocabulary).
 *
 * The ref encoding: vocabulary components are plain SERVER components
 * whose rendered output is a closed set of reserved custom-element
 * tags (`parton-stack`, `parton-text`, …) with audited attributes.
 * Nothing else crosses the wire — no module reference, no client
 * code, no framework machinery. That single decision is what makes
 * "zero remote module loading below the Client tier" structural
 * rather than policed: a remote's Flight row names a vocabulary
 * component by TAG, and the tag resolves entirely from the HOST —
 * the vocabulary stylesheet in the host's own bundle
 * (`<VocabularyStyles/>`) is the "component". The remote controls
 * content; the host controls appearance (CSS custom properties on
 * the tags); neither controls the other's code. Precedent: Shopify
 * admin UI extensions.
 *
 * Vetted means the prop surface is audited ONCE, centrally, in the
 * `VOCABULARY` table below — the shared truth for both sides:
 *
 *   - emit side: the components serialize their typed props through
 *     `sanitizeVocabAttr`, so a vocabulary render can only ever emit
 *     what the table admits;
 *   - enforce side: the host's tier rewriter (`tier-rewrite.ts`)
 *     re-audits every row against the same table, so a hand-crafted
 *     payload gains nothing the components couldn't emit. No
 *     `style` / `className` passthrough, no event props, no
 *     `dangerouslySetInnerHTML` reachability, `src` restricted to
 *     absolute http(s).
 *
 * Import surface (deliberately NOT in the main barrel — vocabulary
 * names like `Text` are too generic to spray into the package
 * namespace; the deep path makes the opt-in explicit):
 *
 *   import { Stack, Text, VocabularyStyles } from "@parton/framework/lib/vocabulary.tsx"
 *
 * v1 is deliberately SMALL — the primitives an embeddable commerce
 * surface (summary cards, tickers, product blurbs) actually needs:
 * Stack, Row, Box, Text, Heading, Image, Divider. Interactive
 * members (TextField, Form, Tabs, links) belong to the Interactive
 * grant, a later increment.
 */

import { createElement, type ReactNode } from "react"

// ─── The audit table ───────────────────────────────────────────────────

export type VocabAttrRule =
  | { kind: "enum"; values: readonly string[] }
  | { kind: "int"; min: number; max: number }
  | { kind: "text"; maxLength: number }
  /** Absolute http(s) URL. Relative forms are rejected — in the host
   *  document they'd resolve against the HOST origin, a confusion the
   *  audit refuses rather than papers over. */
  | { kind: "src" }

export interface VocabTagSpec {
  attrs: Record<string, VocabAttrRule>
  /** Whether the tag renders children. `false` → the rewriter drops
   *  the `children` prop outright (img, divider). */
  children: boolean
}

const SPACE = { kind: "enum", values: ["none", "xs", "sm", "md", "lg"] } as const
const ALIGN = { kind: "enum", values: ["start", "center", "end", "stretch", "baseline"] } as const
const TONE = {
  kind: "enum",
  values: ["default", "muted", "strong", "positive", "critical"],
} as const

/** Inert, e2e-addressable hook. `data-*` renders as a plain attribute
 *  with no behavior; hosts may also style on it, which they already
 *  control. Present on every tag. */
const TEST_ID = { kind: "text", maxLength: 128 } as const

/** The closed tag set + per-tag audited attribute surface. THE single
 *  audit point — both the components (emit) and the tier rewriter
 *  (enforce) read it. Anything not listed here does not cross a
 *  vocabulary-constrained splice. */
export const VOCABULARY: Record<string, VocabTagSpec> = {
  "parton-stack": {
    attrs: { gap: SPACE, align: ALIGN, "data-testid": TEST_ID },
    children: true,
  },
  "parton-row": {
    attrs: {
      gap: SPACE,
      align: ALIGN,
      justify: { kind: "enum", values: ["start", "center", "end", "between"] },
      wrap: { kind: "enum", values: ["wrap"] },
      "data-testid": TEST_ID,
    },
    children: true,
  },
  "parton-box": {
    attrs: {
      padding: SPACE,
      tone: { kind: "enum", values: ["default", "subtle", "emphasis"] },
      "data-testid": TEST_ID,
    },
    children: true,
  },
  "parton-text": {
    attrs: {
      size: { kind: "enum", values: ["xs", "sm", "md", "lg"] },
      tone: TONE,
      align: { kind: "enum", values: ["start", "center", "end"] },
      "data-testid": TEST_ID,
    },
    children: true,
  },
  "parton-heading": {
    attrs: {
      level: { kind: "enum", values: ["1", "2", "3", "4"] },
      // a11y surface the Heading component emits alongside `level`.
      role: { kind: "enum", values: ["heading"] },
      "aria-level": { kind: "int", min: 1, max: 4 },
      "data-testid": TEST_ID,
    },
    children: true,
  },
  "parton-divider": {
    attrs: { "data-testid": TEST_ID },
    children: false,
  },
  // The one plain-HTML member: an image paints nothing as a custom
  // element, so Image emits a real `img` — with the smallest audited
  // surface that still renders one.
  img: {
    attrs: {
      src: { kind: "src" },
      alt: { kind: "text", maxLength: 512 },
      width: { kind: "int", min: 1, max: 8192 },
      height: { kind: "int", min: 1, max: 8192 },
      loading: { kind: "enum", values: ["lazy", "eager"] },
      decoding: { kind: "enum", values: ["async", "sync", "auto"] },
      "data-testid": TEST_ID,
    },
    children: false,
  },
}

/** Validate one attribute value against its rule. Returns the
 *  normalized wire value, or `null` to drop the attribute (never the
 *  element — a bad attribute degrades to the tag's default look). */
export function sanitizeVocabAttr(rule: VocabAttrRule, value: unknown): string | number | null {
  switch (rule.kind) {
    case "enum": {
      const s = typeof value === "number" ? String(value) : value
      return typeof s === "string" && rule.values.includes(s) ? s : null
    }
    case "int": {
      const n = typeof value === "string" ? Number(value) : value
      return typeof n === "number" && Number.isInteger(n) && n >= rule.min && n <= rule.max
        ? n
        : null
    }
    case "text":
      return typeof value === "string" ? value.slice(0, rule.maxLength) : null
    case "src": {
      if (typeof value !== "string") return null
      try {
        const url = new URL(value)
        return url.protocol === "http:" || url.protocol === "https:" ? url.href : null
      } catch {
        return null
      }
    }
  }
}

/** Element type of the DEV-only marker the tier rewriter leaves in
 *  place of a degraded row (`tier-rewrite.ts`). Lives here because it
 *  belongs to the reserved tag namespace and the vocabulary
 *  stylesheet styles it. */
export const TIER_VIOLATION_TAG = "parton-tier-violation"

// ─── Emit helper ───────────────────────────────────────────────────────

/** Build a vocabulary element: attrs pass through the SAME audit the
 *  host's rewriter applies, so emit and enforce can never drift. */
function vocab(tag: string, attrs: Record<string, unknown>, children?: ReactNode): ReactNode {
  const spec = VOCABULARY[tag]
  const props: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined) continue
    const rule = spec.attrs[name]
    if (!rule) continue
    const clean = sanitizeVocabAttr(rule, value)
    if (clean !== null) props[name] = clean
  }
  return spec.children ? createElement(tag, props, children) : createElement(tag, props)
}

// ─── The components ────────────────────────────────────────────────────

export type VocabSpace = "none" | "xs" | "sm" | "md" | "lg"
export type VocabAlign = "start" | "center" | "end" | "stretch" | "baseline"
export type VocabTone = "default" | "muted" | "strong" | "positive" | "critical"

interface CommonProps {
  /** Inert e2e hook — renders as `data-testid`. */
  "data-testid"?: string
}

/** Vertical flow container (`parton-stack`). */
export function Stack(
  props: { gap?: VocabSpace; align?: VocabAlign; children?: ReactNode } & CommonProps,
): ReactNode {
  return vocab(
    "parton-stack",
    { gap: props.gap, align: props.align, "data-testid": props["data-testid"] },
    props.children,
  )
}

/** Horizontal flow container (`parton-row`). */
export function Row(
  props: {
    gap?: VocabSpace
    align?: VocabAlign
    justify?: "start" | "center" | "end" | "between"
    wrap?: boolean
    children?: ReactNode
  } & CommonProps,
): ReactNode {
  return vocab(
    "parton-row",
    {
      gap: props.gap,
      align: props.align,
      justify: props.justify,
      wrap: props.wrap ? "wrap" : undefined,
      "data-testid": props["data-testid"],
    },
    props.children,
  )
}

/** Padded block container (`parton-box`). `tone` is a host-themed
 *  surface treatment, not a color the remote picks. */
export function Box(
  props: {
    padding?: VocabSpace
    tone?: "default" | "subtle" | "emphasis"
    children?: ReactNode
  } & CommonProps,
): ReactNode {
  return vocab(
    "parton-box",
    { padding: props.padding, tone: props.tone, "data-testid": props["data-testid"] },
    props.children,
  )
}

/** Body text (`parton-text`). */
export function Text(
  props: {
    size?: "xs" | "sm" | "md" | "lg"
    tone?: VocabTone
    align?: "start" | "center" | "end"
    children?: ReactNode
  } & CommonProps,
): ReactNode {
  return vocab(
    "parton-text",
    {
      size: props.size,
      tone: props.tone,
      align: props.align,
      "data-testid": props["data-testid"],
    },
    props.children,
  )
}

/** Heading (`parton-heading`), levels 1–4. Emits `role="heading"` +
 *  `aria-level` so the custom element stays a real heading to AT. */
export function Heading(
  props: { level?: 1 | 2 | 3 | 4; children?: ReactNode } & CommonProps,
): ReactNode {
  const level = props.level ?? 2
  return vocab(
    "parton-heading",
    {
      level: String(level),
      role: "heading",
      "aria-level": level,
      "data-testid": props["data-testid"],
    },
    props.children,
  )
}

/** Image — the one plain-HTML member (`img`). `src` must be an
 *  absolute http(s) URL; anything else emits no `src` at all. */
export function Image(
  props: {
    src: string
    alt?: string
    width?: number
    height?: number
    loading?: "lazy" | "eager"
  } & CommonProps,
): ReactNode {
  return vocab("img", {
    src: props.src,
    alt: props.alt ?? "",
    width: props.width,
    height: props.height,
    loading: props.loading ?? "lazy",
    decoding: "async",
    "data-testid": props["data-testid"],
  })
}

/** Horizontal rule (`parton-divider`). */
export function Divider(props: CommonProps = {}): ReactNode {
  return vocab("parton-divider", { "data-testid": props["data-testid"] })
}

// ─── The host-side stylesheet ──────────────────────────────────────────

/**
 * Base CSS for the vocabulary tags. Every visual knob is a CSS custom
 * property with a neutral default, so a host themes the vocabulary by
 * setting `--parton-*` variables anywhere above its embed boxes —
 * custom properties inherit straight through the containment
 * boundary. The `parton-embed-box` sizing is deliberately absent:
 * size containment (`contain: strict`, stamped inline by the
 * framework) means the HOST defines the box — style
 * `parton-embed-box` in host CSS.
 */
export const VOCABULARY_CSS = `
parton-stack,parton-row,parton-box,parton-text,parton-heading,parton-divider{box-sizing:border-box;min-width:0}
parton-stack{display:flex;flex-direction:column;gap:var(--parton-gap-md,.75rem)}
parton-row{display:flex;flex-direction:row;align-items:center;gap:var(--parton-gap-md,.75rem)}
parton-stack[gap=none],parton-row[gap=none]{gap:0}
parton-stack[gap=xs],parton-row[gap=xs]{gap:var(--parton-gap-xs,.25rem)}
parton-stack[gap=sm],parton-row[gap=sm]{gap:var(--parton-gap-sm,.5rem)}
parton-stack[gap=lg],parton-row[gap=lg]{gap:var(--parton-gap-lg,1.25rem)}
parton-stack[align=start],parton-row[align=start]{align-items:flex-start}
parton-stack[align=center],parton-row[align=center]{align-items:center}
parton-stack[align=end],parton-row[align=end]{align-items:flex-end}
parton-stack[align=stretch],parton-row[align=stretch]{align-items:stretch}
parton-row[align=baseline]{align-items:baseline}
parton-row[justify=center]{justify-content:center}
parton-row[justify=end]{justify-content:flex-end}
parton-row[justify=between]{justify-content:space-between}
parton-row[wrap]{flex-wrap:wrap}
parton-box{display:block;background:var(--parton-box-background,transparent);border-radius:var(--parton-box-radius,.375rem)}
parton-box[padding=xs]{padding:var(--parton-gap-xs,.25rem)}
parton-box[padding=sm]{padding:var(--parton-gap-sm,.5rem)}
parton-box[padding=md]{padding:var(--parton-gap-md,.75rem)}
parton-box[padding=lg]{padding:var(--parton-gap-lg,1.25rem)}
parton-box[tone=subtle]{background:var(--parton-box-subtle-background,color-mix(in srgb,currentColor 6%,transparent))}
parton-box[tone=emphasis]{background:var(--parton-box-emphasis-background,color-mix(in srgb,currentColor 12%,transparent))}
parton-text{display:block;color:var(--parton-text-color,inherit);font-size:var(--parton-text-size-md,.9rem);line-height:1.5}
parton-text[size=xs]{font-size:var(--parton-text-size-xs,.7rem)}
parton-text[size=sm]{font-size:var(--parton-text-size-sm,.8rem)}
parton-text[size=lg]{font-size:var(--parton-text-size-lg,1.05rem)}
parton-text[tone=muted]{color:var(--parton-text-muted-color,color-mix(in srgb,currentColor 55%,transparent))}
parton-text[tone=strong]{color:var(--parton-text-strong-color,inherit);font-weight:600}
parton-text[tone=positive]{color:var(--parton-text-positive-color,#15803d)}
parton-text[tone=critical]{color:var(--parton-text-critical-color,#b91c1c)}
parton-text[align=center]{text-align:center}
parton-text[align=end]{text-align:end}
parton-heading{display:block;color:var(--parton-heading-color,inherit);font-weight:var(--parton-heading-weight,600);line-height:1.25}
parton-heading[level="1"]{font-size:var(--parton-heading-size-1,1.5rem)}
parton-heading[level="2"]{font-size:var(--parton-heading-size-2,1.25rem)}
parton-heading[level="3"]{font-size:var(--parton-heading-size-3,1.05rem)}
parton-heading[level="4"]{font-size:var(--parton-heading-size-4,.9rem)}
parton-divider{display:block;border-block-start:1px solid var(--parton-divider-color,color-mix(in srgb,currentColor 20%,transparent))}
parton-tier-violation{display:block;padding:.375rem .5rem;border:1px dashed #dc2626;border-radius:.25rem;color:#dc2626;font-family:ui-monospace,monospace;font-size:.7rem}
parton-tier-violation::before{content:"tier violation (" attr(data-offense) "): " attr(data-type)}
`.trim()

/**
 * Host-side vocabulary stylesheet. A host embedding at a
 * vocabulary-constrained grant renders this once anywhere in its
 * tree; React hoists and dedupes it by `href` + `precedence`. This
 * IS the host-bundle resolution of the vocabulary refs — a
 * `parton-text` row paints because the host shipped this sheet, not
 * because any remote code loaded.
 */
export function VocabularyStyles(): ReactNode {
  return (
    <style href="parton-vocabulary" precedence="default">
      {VOCABULARY_CSS}
    </style>
  )
}
