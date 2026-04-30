/**
 * Multi-slot container — `body` + `sidebar`.
 */

import { Children, ReactCms, type RenderArgs } from "@react-cms/framework"

export const PageMultiSlotBlock = ReactCms.partial(
  function PageMultiSlotRender({ parent, cmsId }: RenderArgs) {
    return (
      <section
        className="mt-8 grid gap-4 md:grid-cols-[1fr_280px]"
        data-testid="cms-demo-multi-slot-section"
      >
        <div data-testid="cms-demo-multi-slot-body">
          <h3 className="mb-2 text-sm uppercase tracking-wide text-muted-foreground">Body</h3>
          <Children name="body" allow=".demo-block" host={parent} hostCmsId={cmsId} />
        </div>
        <aside data-testid="cms-demo-multi-slot-sidebar">
          <h3 className="mb-2 text-sm uppercase tracking-wide text-muted-foreground">Sidebar</h3>
          <Children name="sidebar" allow=".demo-block" host={parent} hostCmsId={cmsId} />
        </aside>
      </section>
    )
  },
  { type: "page-multi-slot", tags: [".page-block"] },
)
