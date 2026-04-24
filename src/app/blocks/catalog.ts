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
import { registerBlock } from "../../framework/cms-runtime.ts";
import { HeroBlock } from "./hero.tsx";
import { RichTextBlock } from "./rich-text.tsx";

registerBlock("hero", {
  tags: [".demo-block", ".composed-hero"],
  component: HeroBlock,
});

registerBlock("rich-text", {
  tags: [".demo-block", ".composed-rich-text"],
  component: RichTextBlock,
});
