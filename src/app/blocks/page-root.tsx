/**
 * Page-level root container — single body slot accepting any block
 * tagged `.page-block`. Registering this as a block (vs. inlining
 * `<Children>` in `CmsDemoPage`) is what gets the slot's `allow`
 * value into the catalog manifest. The editor's slot palette reads
 * that manifest to filter the `+ add` buttons per slot, so authors
 * only see block types that actually fit. Without a registered
 * page-root, the palette would default to "show every block type"
 * because the parent has no type tag the manifest can key on.
 */
import { Children } from "../../lib"

export function PageRootBlock() {
  return <Children name="body" allow=".page-block" />
}
