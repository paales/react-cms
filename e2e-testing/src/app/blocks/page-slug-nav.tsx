/**
 * Static slug nav for /cms-demo. No editable fields — pure UI,
 * registered as a block so the page can compose it via Children.
 */

import { ReactCms, type RenderArgs } from "@react-cms/framework"
import { buttonVariants } from "@react-cms/copies/components/ui/button"

const SLUG_LINKS: ReadonlyArray<[href: string, label: string]> = [
  ["/cms-demo", "Default (no slug)"],
  ["/cms-demo/alpha", "alpha"],
  ["/cms-demo/beta", "beta"],
  ["/cms-demo/gamma", "gamma"],
  ["/cms-demo/zulu", "zulu (unmatched)"],
]

export const PageSlugNavBlock = ReactCms.partial(
  function PageSlugNavRender({}: RenderArgs) {
    return (
      <nav
        className="mb-6 flex flex-wrap gap-1"
        aria-label="CMS demo slugs"
        data-testid="cms-demo-slug-nav-block"
      >
        {SLUG_LINKS.map(([href, label]) => (
          <a key={href} href={href} className={buttonVariants({ variant: "ghost", size: "sm" })}>
            {label}
          </a>
        ))}
      </nav>
    )
  },
  { type: "page-slug-nav", tags: [".page-block"] },
)
