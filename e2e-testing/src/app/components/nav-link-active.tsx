"use client"

import { useNavigation } from "@parton/framework/lib/partial-client.tsx"

/**
 * Nav anchor that marks itself active when the current page path
 * matches its href. "Active" is presentational and 100% URL-derived,
 * so it lives on the client — the host `.nav-item` block fp-skips
 * across navigations while this anchor flips `aria-current` locally.
 * `useNavigation()` is isomorphic, so the match is also correct on the
 * initial server paint (no hydration flash).
 */
export function NavLinkActive({
  href,
  label,
  className,
}: {
  href: string
  label: string
  className?: string
}) {
  const nav = useNavigation()
  const { currentEntry } = nav
  const active =
    currentEntry?.url != null && isActivePath(new URL(currentEntry.url).pathname, href)
  return (
    <a
      href={href}
      // Hover-eager preload: warm the destination's partials into the
      // client cache before the click. The click is still an ordinary
      // navigation that revalidates against the server — it just starts
      // warm, so the fp-skipped partials substitute from cache instantly.
      onPointerEnter={() => {
        void nav.preload(href)
      }}
      className={active ? `${className ?? ""} bg-accent text-accent-foreground`.trim() : className}
      aria-current={active ? "page" : undefined}
      data-active={active ? "" : undefined}
    >
      {label}
    </a>
  )
}

/**
 * Active on an exact path match, or when the current path is a
 * descendant of the link's href (`/cms-demo` active on
 * `/cms-demo/alpha`). Root `/` matches only itself.
 */
function isActivePath(pathname: string, href: string): boolean {
  const target = new URL(href, "http://_").pathname
  if (target === "/") return pathname === "/"
  return pathname === target || pathname.startsWith(`${target}/`)
}
