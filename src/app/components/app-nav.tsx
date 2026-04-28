import { Partial, capturePartialContext } from "../../lib"
import { NavRootBlock } from "../blocks/nav-root.tsx"

/**
 * Shared cross-page nav. CMS-aware: the link list lives in the CMS
 * store under `cmsId="app-nav"`, with each link a `nav-link` block
 * in the `links` slot. Authors edit href/label, reorder, add, and
 * remove links via the editor; visitors see the rendered output.
 *
 * The `<nav>` chrome itself stays in code (`NavRootBlock`) — same
 * pattern `cms-demo-root` uses with `PageRootBlock`. Code defines
 * the grammar; data fills it (CMS_VISION.md Principle #5).
 */
export function AppNav() {
  const parent = capturePartialContext()
  return (
    <Partial parent={parent} selector="#app-nav" cmsId="app-nav">
      <NavRootBlock />
    </Partial>
  )
}
