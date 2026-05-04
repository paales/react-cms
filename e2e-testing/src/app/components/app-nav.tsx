/**
 * Static cross-page nav.
 *
 * The CMS-driven version (links from `cmsId="app-nav"`) is deferred
 * until the block migration lands. Static link list keeps the demo
 * navigable in the meantime.
 */

const LINKS = [
  { href: "/", label: "Pokedex" },
  { href: "/cache-demo", label: "Cache Demo" },
  { href: "/defer-demo", label: "Defer Demo" },
  { href: "/selector-demo", label: "Selector Demo" },
  { href: "/sentinels-demo", label: "Sentinels Demo" },
  { href: "/frames-demo", label: "Frames Demo" },
  { href: "/inspect", label: "Inspect (Stacked Drawers)" },
  { href: "/cms-demo", label: "CMS Demo" },
  { href: "/magento", label: "Magento" },
  { href: "/bare", label: "Bare" },
]

export function AppNav() {
  return (
    <nav className="mb-6 flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
      {LINKS.map((l) => (
        <a key={l.href} href={l.href} className="hover:text-foreground">
          {l.label}
        </a>
      ))}
      <span className="ml-auto text-xs opacity-50">|</span>
      <a
        href="/cms-demo?editor=1"
        className="rounded-md border border-border px-2 py-0.5 text-xs hover:bg-muted hover:text-foreground"
        data-testid="app-nav-open-editor"
      >
        Open editor →
      </a>
    </nav>
  )
}
