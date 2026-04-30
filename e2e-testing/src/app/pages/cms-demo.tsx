/**
 * /cms-demo — root-as-page-slot.
 *
 * One spec matches both `/cms-demo` and `/cms-demo/:slug` via the
 * tail catch-all pattern `/cms-demo/*`. The render is a
 * `<Children name="body">` slot whose entries (registered as `page-*`
 * blocks in the catalog) compose the page.
 */

import { Children, ReactCms } from "@react-cms/framework"
import { Card, CardContent } from "@react-cms/copies/components/ui/card"

export const CmsDemoRootPartial = ReactCms.partial(
  function CmsDemoRootRender({ cmsId, parent }) {
    return <Children name="body" allow=".page-block" host={parent} hostCmsId={cmsId} />
  },
  { cmsId: "cms-demo-root" },
)

export const CmsDemoPage = ReactCms.partial(
  function CmsDemoExplainerRender({ parent }) {
    return (
      <>
        <CmsDemoRootPartial parent={parent} />

        <Card className="mt-8 p-5">
          <CardContent className="px-0 text-sm text-muted-foreground">
            <p className="mb-2 font-semibold text-foreground">What you're looking at</p>
            <ul className="list-disc space-y-1 pl-5">
              <li>
                The page above is a single spec (
                <code className="rounded bg-muted px-1.5 py-0.5 text-[0.85em] font-mono">
                  #cms-demo-root
                </code>
                ) whose render is a{" "}
                <code className="rounded bg-muted px-1.5 py-0.5 text-[0.85em] font-mono">
                  &lt;Children name="body" /&gt;
                </code>{" "}
                slot. Every visible piece is a slot child in the CMS store.
              </li>
              <li>
                Per-slug content uses match clauses on slot-child entries — visit /cms-demo/alpha vs
                /cms-demo to see it.
              </li>
            </ul>
          </CardContent>
        </Card>
      </>
    )
  },
  { match: "/cms-demo/*" },
)
