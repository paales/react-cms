/**
 * CMS demo — root-as-page-slot.
 *
 * The page is a single CMS-aware Partial whose body is a `<Children
 * name="body">` slot. Every visible piece of the page (hero, slug
 * nav, greeting, composed section, multi-slot section) is a slot
 * child stored in `cms-demo-root.slots.body[]` in the CMS store.
 *
 * Why this matters: the editor's tree models the page exactly the
 * same way it models any other slot-bearing node. Authors can
 * reorder, remove, or `+ add` page-level blocks from the
 * `slot:cms-demo-root:body` intermediary in the tree — no separate
 * "add a top-level block" surface needed. This is the "100% slot-
 * driven" vision: there is no special root-level render path,
 * just `<Children>` all the way down.
 *
 * Each piece of content is registered as a `page-*` block type in
 * `src/app/blocks/catalog.ts`. Match clauses (per-slug greeting
 * configs, etc.) live on the slot-child entries themselves; the
 * resolver evaluates them against the request URL the same way it
 * does for any CMS-aware Partial.
 *
 * See `docs/cms.md`.
 */

import { Children, Partial } from "../../lib"
import { ROOT } from "../../lib/partial-context.ts"
import { Card, CardContent } from "@/components/ui/card"

export function CmsDemoPage() {
  return (
    <>
      <Partial parent={ROOT} selector="#cms-demo-root" cmsId="cms-demo-root">
        <Children name="body" allow=".page-block" />
      </Partial>

      <Card className="mt-8 p-5">
        <CardContent className="px-0 text-sm text-muted-foreground">
          <p className="mb-2 font-semibold text-foreground">What you're looking at</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              The page above is a single Partial (
              <code className="rounded bg-muted px-1.5 py-0.5 text-[0.85em] font-mono">
                #cms-demo-root
              </code>
              ) whose only child is a{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 text-[0.85em] font-mono">
                &lt;Children name="body" /&gt;
              </code>{" "}
              slot. Every visible piece — hero, nav, greeting, composed, multi-slot — is a slot
              child contributed via the CMS store, not an explicit JSX declaration.
            </li>
            <li>
              The editor's tree (
              <a className="underline" href="/cms-edit">
                /cms-edit
              </a>
              ) shows the page root with a{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 text-[0.85em] font-mono">
                slot:cms-demo-root:body
              </code>{" "}
              intermediary; the slot's `+ add` palette lists every registered{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 text-[0.85em] font-mono">page-*</code>{" "}
              block type.
            </li>
            <li>
              Per-slug content (the greeting card) still works — match clauses on the greeting's
              slot-child entry resolve against the request URL exactly like any top-level CMS-aware
              Partial. Visit /cms-demo/alpha vs /cms-demo to see it.
            </li>
          </ul>
        </CardContent>
      </Card>
    </>
  )
}
