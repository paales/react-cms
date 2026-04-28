/**
 * App nav root — the styled `<nav>` chrome around an editable list
 * of `.nav-item` blocks. Mirrors `PageRootBlock`: registering the
 * chrome AS a block (rather than inlining `<Children>` in `AppNav`)
 * is what surfaces the slot's `allow` value to the catalog manifest,
 * which the editor's `+ Block` palette consults to filter the
 * dropdown for this slot.
 */
import { Children } from "../../lib"

export function NavRootBlock() {
  return (
    <nav className="mb-6 flex flex-wrap gap-1 border-b pb-3">
      <Children name="links" allow=".nav-item" />
    </nav>
  )
}
