/**
 * App-level block catalog.
 *
 * Imported once (side-effect) by `src/app/root.tsx`. Every
 * `registerBlock` call binds a `type` tag to a `{tags, component}`
 * spec; slot primitives (`<Children>` / `<Child>`) look the tag up
 * at render time to resolve entries in the store.
 *
 * Authors add blocks by writing a component that reads its fields
 * via content accessors and dropping a `registerBlock(…)` line
 * here. HMR-friendly — re-imports replace the prior spec.
 */
import { registerBlock } from "../../framework/cms-runtime.ts"
import { HeroBlock } from "./hero.tsx"
import { RichTextBlock } from "./rich-text.tsx"
import { PageHeroBlock } from "./page-hero.tsx"
import { PageGreetingBlock } from "./page-greeting.tsx"
import { PageSlugNavBlock } from "./page-slug-nav.tsx"
import { PageComposedBlock } from "./page-composed.tsx"
import { PageMultiSlotBlock } from "./page-multi-slot.tsx"
import { GroupBlock } from "./group.tsx"
import { ProductCardBlock } from "./product-card.tsx"
import { PageRootBlock } from "./page-root.tsx"
import { NavRootBlock } from "./nav-root.tsx"
import { NavLinkBlock } from "./nav-link.tsx"

// Slot-level blocks (used inside `<Children>` slots within page-level
// blocks like the composed section).
registerBlock("hero", {
  tags: [".demo-block", ".composed-hero"],
  component: HeroBlock,
})

registerBlock("rich-text", {
  tags: [".demo-block", ".composed-rich-text"],
  component: RichTextBlock,
})

// Page root — registered so the catalog manifest knows the slot's
// `allow` value, which the editor's slot palette uses to filter the
// `+ add` buttons. Without this, the page root has no `type` and
// the palette has no manifest to consult.
registerBlock("page-root", {
  tags: [],
  component: PageRootBlock,
})

// App nav root — the styled `<nav>` chrome around the global links
// list. Same role as `page-root`: surfaces the `links` slot's
// `allow=".nav-item"` to the manifest so the editor's `+ Block`
// palette filters to nav-eligible blocks.
registerBlock("nav-root", {
  tags: [],
  component: NavRootBlock,
})

// Nav link — single anchor with editable `href` / `label`. Tagged
// `.nav-item` so it satisfies `nav-root`'s links slot allow filter.
registerBlock("nav-link", {
  tags: [".nav-item"],
  component: NavLinkBlock,
})

// Page-level blocks (slot children of the page root, `cms-demo-root`).
// The `.page-block` shared tag is what the page root's
// `<Children allow=".page-block" />` declaration matches against —
// the editor uses it to filter the `+ add` palette per slot.
registerBlock("page-hero", {
  tags: [".page-block"],
  component: PageHeroBlock,
})

registerBlock("page-slug-nav", {
  tags: [".page-block"],
  component: PageSlugNavBlock,
})

registerBlock("page-greeting", {
  tags: [".page-block"],
  component: PageGreetingBlock,
})

registerBlock("page-composed", {
  tags: [".page-block"],
  component: PageComposedBlock,
})

registerBlock("page-multi-slot", {
  tags: [".page-block"],
  component: PageMultiSlotBlock,
})

// Layout primitive — `.page-block` so it can sit at the page level,
// `.group-item` so it can also nest inside another Group (recursive
// composition). Holds its own `items` slot that accepts anything
// tagged `.group-item`.
registerBlock("group", {
  tags: [".page-block", ".group-item"],
  component: GroupBlock,
})

// Product card — `.group-item` so it slots into a Group's items
// slot. Not tagged `.page-block` because a card on its own at the
// page level isn't a useful page section; cards live inside a
// Group (a grid row, a horizontal scroller, etc.).
registerBlock("product-card", {
  tags: [".group-item"],
  component: ProductCardBlock,
})
