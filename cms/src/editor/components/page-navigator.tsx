"use client"

import { useEffect, useRef, useState } from "react"
import { useNavigation } from "@parton/framework/client"
import { Icon } from "./icon.tsx"

/**
 * Page navigator dropdown — opens below the toolbar's "Home page"
 * pill. Shopify-style menu with search input, sectioned items, and
 * right-arrow indicators on parents that would expand to a sub-menu
 * (the design has these but the items themselves are placeholders;
 * this codebase doesn't have a full template registry yet).
 *
 * Selecting an item navigates the preview to that path.
 */

interface NavItem {
  label: string
  href?: string
  icon?: string
  arrow?: boolean
  sep?: boolean
  active?: boolean
}

const ITEMS: NavItem[] = [
  { label: "Home page", href: "/", icon: "home", active: true },
  { label: "Pokédex", href: "/pokedex", icon: "block" },
  { label: "Magento demo", href: "/magento", icon: "cart" },
  { label: "CMS demo", href: "/cms-demo", icon: "page" },
  { sep: true, label: "" },
  { label: "Cart", href: "/cart", icon: "cart" },
  { label: "Checkout & accounts", href: "/checkout", icon: "block" },
  { sep: true, label: "" },
  { label: "Pages", icon: "page", arrow: true },
  { label: "Blogs", icon: "pen", arrow: true },
  { label: "Blog posts", icon: "pen", arrow: true },
  { sep: true, label: "" },
  { label: "Search", href: "/search", icon: "search" },
  { label: "Password", icon: "block" },
]

export function PageNavigator({
  currentPath,
  homeLabel = "Home page",
}: {
  currentPath: string
  homeLabel?: string
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState("")
  const ref = useRef<HTMLDivElement>(null)
  const [navigate] = useNavigation().navigate()

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false)
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [open])

  function go(href: string) {
    setOpen(false)
    void navigate(href, { history: "push" })
  }

  const filtered = ITEMS.filter(
    (i) => i.sep || (i.label && i.label.toLowerCase().includes(q.toLowerCase())),
  )

  // Mark the item that matches currentPath as active.
  const activeHref = ITEMS.find((i) => i.href === currentPath)?.href

  return (
    <>
      <button
        type="button"
        className="cms-toolbar-pill"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Switch page"
        style={{ border: 0, font: "inherit" }}
      >
        <Icon name="home" size={16} />
        <span>{homeLabel}</span>
        <Icon name="chevDown" size={14} />
      </button>
      {open && (
        <div ref={ref}>
          <div className="cms-page-nav-backdrop" onClick={() => setOpen(false)} />
          <div className="cms-page-nav" role="menu">
            <div className="cms-page-nav-search">
              <Icon name="search" size={16} />
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search online store"
                spellCheck={false}
              />
            </div>
            {filtered.map((it, i) =>
              it.sep ? (
                <div key={i} className="cms-page-nav-divider" />
              ) : (
                <a
                  key={i}
                  href={it.href ?? "#"}
                  className="cms-page-nav-item"
                  data-active={it.href === activeHref || (it.active && !activeHref) || undefined}
                  onClick={(e) => {
                    if (it.href) {
                      e.preventDefault()
                      go(it.href)
                    }
                  }}
                >
                  <Icon name={it.icon ?? "block"} size={16} />
                  <span style={{ flex: 1 }}>{it.label}</span>
                  {it.arrow && <Icon name="chevRight" size={14} />}
                </a>
              ),
            )}
          </div>
        </div>
      )}
    </>
  )
}
