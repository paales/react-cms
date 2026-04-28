/**
 * Nav link — a single anchor inside `app-nav`'s `links` slot.
 *
 * Tagged `.nav-item` so it satisfies the slot's `allow` selector.
 * Authors edit `href` and `label` from the editor's field panel;
 * reorder/add/remove happens via the tree's slot controls. Styling
 * (button-ghost) lives in code so the chrome stays consistent
 * regardless of what authors put in the fields.
 */
import { getText } from "../../framework/context.ts"
import { buttonVariants } from "@/components/ui/button"

export function NavLinkBlock() {
  const href = getText("href")
  const label = getText("label")
  return (
    <a href={href} className={buttonVariants({ variant: "ghost", size: "sm" })}>
      {label}
    </a>
  )
}
