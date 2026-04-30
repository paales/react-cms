/**
 * Nav link — single anchor inside `app-nav`'s `links` slot.
 */

import { ReactCms, type RenderArgs } from "@react-cms/framework"
import { buttonVariants } from "@react-cms/copies/components/ui/button"

export const NavLinkBlock = ReactCms.partial(
  function NavLinkRender({ href, label }: { href: string; label: string } & RenderArgs) {
    return (
      <a href={href} className={buttonVariants({ variant: "ghost", size: "sm" })}>
        {label}
      </a>
    )
  },
  {
    type: "nav-link",
    tags: [".nav-item"],
    vary: ({ cms }) => ({
      href: cms.text("href"),
      label: cms.text("label"),
    }),
  },
)
