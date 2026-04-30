/**
 * App nav root — styled `<nav>` chrome around the editable list of
 * `.nav-item` blocks.
 */

import { Children, ReactCms, type RenderArgs } from "@react-cms/framework"

export const NavRootBlock = ReactCms.partial(
  function NavRootRender({ parent, cmsId }: RenderArgs) {
    return (
      <nav className="mb-6 flex flex-wrap gap-1 border-b pb-3">
        <Children name="links" allow=".nav-item" host={parent} hostCmsId={cmsId} />
      </nav>
    )
  },
  { type: "nav-root", tags: [] as never },
)
