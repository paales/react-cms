"use client"

import { useEffect, useRef, type MouseEvent } from "react"
import { useNavigation } from "@parton/framework/client"
import { Button, buttonVariants } from "@parton/copies/components/ui/button"
import { cn } from "@parton/copies/lib/utils"

/**
 * "New message" link. Rendered as an anchor so a click before the client JS
 * bundle has hydrated still works (browser follows the href for a full
 * page nav). After hydration the `onClick` preempts and fires
 * `nav.navigate` for a client-side transition.
 */
export function NewMessageLink({ nextHref }: { nextHref: string | null }) {
  const [navigate] = useNavigation().navigate()

  if (nextHref == null) {
    return (
      <span
        data-testid="new-message-disabled"
        className="block p-1.5 text-center text-xs text-muted-foreground"
      >
        (all notes streaming)
      </span>
    )
  }

  const onClick = (ev: MouseEvent<HTMLAnchorElement>) => {
    // Let cmd/ctrl/shift-click open in a new tab / window.
    if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button !== 0) return
    ev.preventDefault()
    void navigate(nextHref, { history: "push" })
  }

  return (
    <a
      href={nextHref}
      data-testid="new-message-btn"
      onClick={onClick}
      className={cn(buttonVariants({ variant: "outline", size: "sm" }), "w-full")}
    >
      + Stream next note
    </a>
  )
}

/**
 * Keeps the chat-list scrolled to the bottom as new chunks arrive.
 * MutationObserver on the scrollable container: any DOM mutation inside
 * (new chunk, FlatPrefix reflow after compaction) sticks the scroll to
 * the bottom unless the user has scrolled away.
 */
const STICKY_THRESHOLD = 80

export function AutoScrollToBottom({ containerTestId }: { containerTestId: string }) {
  const stuck = useRef(true)

  useEffect(() => {
    const container = document.querySelector<HTMLElement>(`[data-testid="${containerTestId}"]`)
    if (!container) return

    const isNearBottom = () =>
      container.scrollHeight - container.scrollTop - container.clientHeight < STICKY_THRESHOLD

    const onScroll = () => {
      stuck.current = isNearBottom()
    }

    const mo = new MutationObserver(() => {
      if (stuck.current) {
        container.scrollTop = container.scrollHeight
      }
    })

    container.addEventListener("scroll", onScroll, { passive: true })
    mo.observe(container, {
      childList: true,
      subtree: true,
      characterData: true,
    })

    container.scrollTop = container.scrollHeight

    return () => {
      container.removeEventListener("scroll", onScroll)
      mo.disconnect()
    }
  }, [containerTestId])

  return null
}

/**
 * Collapsed-state pill at bottom-right. Sets `?chat=open` and triggers a
 * frame navigate (the overlay lives in its own `<Frame>`) so the full
 * overlay expands in place without re-rendering the host page.
 */
export function ChatOpenPill() {
  const [navigate] = useNavigation().navigate()

  const onClick = (ev: MouseEvent<HTMLAnchorElement>) => {
    if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button !== 0) return
    ev.preventDefault()
    void navigate(
      (url) => {
        url.searchParams.set("chat", "open")
        return url
      },
      { history: "replace" },
    )
  }

  return (
    <a
      // `data-hydrated`: React owns the anchor (the intercepting
      // onClick is live) — the chat overlay island hydrates after the
      // page shell; e2e specs click via the marker-qualified locator.
      ref={(el) => el?.setAttribute("data-hydrated", "")}
      href="?chat=open"
      data-testid="chat-open-pill"
      onClick={onClick}
      className={cn(
        buttonVariants({ variant: "outline", size: "sm" }),
        "fixed right-4 bottom-4 z-[100] rounded-full shadow-lg",
      )}
    >
      <span aria-hidden>💬</span>
      <span>notes stream</span>
    </a>
  )
}

/**
 * Collapses the overlay — inverse of `ChatOpenPill`: the same frame
 * navigate with `?chat=closed`, so the host page is untouched.
 */
export function ChatClosePill() {
  const [navigate] = useNavigation().navigate()

  const onClick = () => {
    void navigate(
      (url) => {
        url.searchParams.set("chat", "closed")
        return url
      },
      { history: "replace" },
    )
  }

  return (
    <Button
      // `data-hydrated` — see ChatOpenPill above.
      ref={(el) => el?.setAttribute("data-hydrated", "")}
      type="button"
      data-testid="chat-close-pill"
      onClick={onClick}
      aria-label="Collapse chat"
      variant="ghost"
      size="icon-xs"
    >
      ×
    </Button>
  )
}

export function ResetChatButton() {
  const onClick = async () => {
    await fetch("/__test/clear-caches", { method: "POST" })
    const url = new URL(window.location.href)
    url.search = ""
    window.location.href = url.toString()
  }

  return (
    <Button type="button" data-testid="reset-chat-btn" onClick={onClick} variant="ghost" size="xs">
      reset
    </Button>
  )
}
