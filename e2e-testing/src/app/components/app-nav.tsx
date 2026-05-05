/**
 * App nav — placement of the `nav-root` block at `cmsId="app-nav"`.
 *
 * The links live in `cms/data/content.json` under `app-nav.slots.links`
 * as `nav-link` block entries. Authors edit, reorder, add, and remove
 * them through the editor's slot controls. Mounting the block here
 * puts `app-nav` in the partial registry on every page, which is what
 * the registry-driven editor tree keys off — chrome that renders on
 * every page appears in every page's tree.
 */

import { ROOT } from "@react-cms/framework"
import { NavRootBlock } from "../blocks/nav-root.tsx"

export function AppNav() {
  return <NavRootBlock parent={ROOT} cmsId="app-nav" />
}
