/**
 * Page-level root container — single `body` slot accepting `.page-block`.
 */

import { Children, ReactCms, type RenderArgs } from "@react-cms/framework"

export const PageRootBlock = ReactCms.partial(
  function PageRootRender({ parent, cmsId }: RenderArgs) {
    return <Children name="body" allow=".page-block" host={parent} hostCmsId={cmsId} />
  },
  { type: "page-root", tags: [] as never },
)
