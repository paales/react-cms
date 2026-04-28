/**
 * Static slug nav for /cms-demo. Has no editable fields — it's
 * pure UI, registered as a block so the page can compose it via a
 * Children slot. The hrefs are hard-coded in code; the editor can
 * still reorder/remove this block from the page (one of the
 * benefits of modeling root as a slot — the "navigation" itself
 * is just another contributable block).
 */
import { buttonVariants } from "@/components/ui/button"

const SLUG_LINKS: ReadonlyArray<[href: string, label: string]> = [
  ["/cms-demo", "Default (no slug)"],
  ["/cms-demo/alpha", "alpha"],
  ["/cms-demo/beta", "beta"],
  ["/cms-demo/gamma", "gamma"],
  ["/cms-demo/zulu", "zulu (unmatched)"],
]

export function PageSlugNavBlock() {
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
}
