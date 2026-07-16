"use client"

import { type ReactNode } from "react"
import { ArrowLeft, X } from "lucide-react"
import {
  useNavigation,
  useScrollRestore,
  type FrameworkNavigation,
  type Navigate,
} from "@parton/framework/client"
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
  DrawerClose,
} from "@parton/copies/components/ui/drawer"
import { Button } from "@parton/copies/components/ui/button"
import { cn } from "@parton/copies/lib/utils"

type DrawerDirection = "left" | "right" | "top" | "bottom"

interface StackedDrawerProps {
  /** Stack level — 1 is bottom-most, higher numbers stack on top. Drives z-index. */
  level: number
  /** Slide-in side. */
  direction: DrawerDirection
  /** Open state — controlled by the host Partial's URL reads. */
  open: boolean
  /** Pathname to navigate to when this drawer is dismissed. */
  closeUrl: string
  title: string
  description?: string
  children: ReactNode
}

/**
 * Navigate to `closeUrl`, picking the cheapest history operation:
 *
 *   - if the previous browser entry IS `closeUrl`, traverseTo it.
 *     The framework auto-stamps `addTransitionType("back")` on
 *     traverse-back navigations, so any enclosing `<ViewTransition>`
 *     animates with the back direction.
 *   - otherwise (deep-link), navigate with `replace` so we don't
 *     pollute history with a forward stub. Replace carries no
 *     direction; CSS falls back to the default rule.
 *
 * Accepts the navigate fire fn (from `useNavigation().navigate()`)
 * separately from the handle, since the handle's `navigate` is a
 * hook now and can only be used during render — the helper here
 * runs from event-handler land.
 */
export function closeToParent(
  nav: FrameworkNavigation,
  navigate: Navigate,
  closeUrl: string,
): void {
  const current = nav.currentEntry
  const entries = nav.entries()
  const idx = current ? entries.findIndex((e) => e.id === current.id) : -1
  const prev = idx > 0 ? entries[idx - 1] : null
  if (prev?.url) {
    try {
      if (new URL(prev.url).pathname === closeUrl) {
        void nav.traverseTo(prev.key)
        return
      }
    } catch {
      // fall through to replace
    }
  }
  void navigate(closeUrl, { history: "replace" })
}

/**
 * Vaul drawer wrapped to participate in a URL-driven stack.
 *
 * Open/close is driven entirely by the URL: a host Partial computes
 * `open` from a tracked `pathname()` read. Opening is therefore a normal
 * `<a href="…">` push — the framework's anchor interception turns it
 * into a targeted refetch and the drawer's Partial's URL read flips
 * `open` from `false` to `true`. Vaul animates because the Partial
 * stays mounted (it renders content while we're on
 * `/inspect…`).
 *
 * Dismiss path (escape, overlay click, close button) calls
 * `handleOpenChange(false)`. We then choose between two close moves:
 *
 *   1. If the previous browser entry's pathname IS `closeUrl`, the
 *      user got here by stacking — `traverseTo(prev.key)` so browser
 *      back history collapses cleanly.
 *   2. Otherwise the user deep-linked here — `navigate(closeUrl,
 *      {history: "replace"})` so we don't pollute history with a
 *      forward stub.
 */
export function StackedDrawer({
  level,
  direction,
  open,
  closeUrl,
  title,
  description,
  children,
}: StackedDrawerProps) {
  const nav = useNavigation()
  const [navigate] = nav.navigate()

  function handleOpenChange(next: boolean) {
    if (next || !open) return
    closeToParent(nav, navigate, closeUrl)
  }

  // z-index lifts both the overlay and the content per level so deeper
  // drawers cover shallower ones (and their backdrops).
  const zIndex = 50 + (level - 1) * 20

  // Per-direction sizing so left/right drawers stay narrow and
  // top/bottom drawers stay centered.
  const sizeClass =
    direction === "left" || direction === "right" ? "w-full sm:max-w-md" : "mx-auto max-w-2xl"

  return (
    <Drawer open={open} onOpenChange={handleOpenChange} direction={direction}>
      <DrawerContent
        data-stack-level={level}
        data-testid={`drawer-${level}`}
        style={{ zIndex: zIndex + 1 }}
        className={cn(sizeClass)}
      >
        <DrawerHeader className="border-b">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-0.5">
              <DrawerTitle data-testid={`drawer-${level}-title`}>{title}</DrawerTitle>
              {description ? <DrawerDescription>{description}</DrawerDescription> : null}
            </div>
            <DrawerClose asChild>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label="Close drawer"
                className="-mr-2 -mt-1 size-8 shrink-0"
                data-testid={`drawer-close-${level}`}
              >
                <X className="size-4" />
              </Button>
            </DrawerClose>
          </div>
        </DrawerHeader>
        {/* Body slot: flex column that takes remaining space and lets
         * children own scroll/overflow. Authors that need scoping (e.g.
         * a `<ViewTransition>` whose snapshot must NOT capture overflow
         * past the drawer body) wrap their content in a `flex-1
         * min-h-0 overflow-hidden` shell with the scrollable inner
         * `<div className="h-full overflow-y-auto px-4 py-3">`. */}
        <div className="flex flex-1 min-h-0 flex-col">{children}</div>
      </DrawerContent>
    </Drawer>
  )
}

/**
 * In-drawer "back" affordance — used when navigating *within* a drawer
 * between sub-pages whose URLs build on the drawer's own URL (e.g.
 * moves list ↔ move detail). Calls `closeToParent` which traverses to
 * the previous browser entry; the framework auto-emits
 * `addTransitionType("back")` for traverse-back, so any enclosing
 * `<ViewTransition>` animates in the back direction without any
 * userland transition wiring here.
 */
export function DrawerBackLink({
  href,
  label,
  testId,
}: {
  href: string
  label: string
  testId?: string
}) {
  const nav = useNavigation()
  const [navigate] = nav.navigate()
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={(e) => {
        e.preventDefault()
        closeToParent(nav, navigate, href)
      }}
      className={cn(
        "-ml-1 mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground",
        "hover:text-foreground",
      )}
    >
      <ArrowLeft className="size-4" />
      {label}
    </button>
  )
}

/**
 * Scrollable drawer body section with scroll-position restoration via
 * the framework's `useScrollRestore` (writes/reads
 * `nav.currentEntry.state.__scrollPositions[scrollKey]`). Use a stable
 * `scrollKey` per logical scroll context — typically the URL pattern
 * the scroll belongs to (e.g. `"drawer-2-list"`). Different keys per
 * mounted scroll area must be distinct.
 */
export function DrawerScrollArea({
  scrollKey,
  className,
  children,
}: {
  scrollKey: string
  className?: string
  children: ReactNode
}) {
  const ref = useScrollRestore<HTMLDivElement>(scrollKey)
  return (
    <div
      ref={ref}
      className={cn("h-full overflow-y-auto px-4 py-3", className)}
      data-scroll-key={scrollKey}
    >
      {children}
    </div>
  )
}
