/**
 * Composed container — has its own `body` slot of demo blocks.
 */

import { Children, ReactCms, type RenderArgs } from "@react-cms/framework"

export const PageComposedBlock = ReactCms.partial(
  function PageComposedRender({ parent, cmsId }: RenderArgs) {
    return (
      <section data-testid="cms-demo-composed-section">
        <h2 className="mt-8 mb-3 text-lg font-semibold">Composed from a slot</h2>
        <div data-testid="cms-demo-composed-slot">
          <Children name="body" allow=".demo-block" host={parent} hostCmsId={cmsId} />
        </div>
      </section>
    )
  },
  { type: "page-composed", tags: [".page-block"] },
)
