"use client"

/**
 * The Interactive grant's interaction bridge — the HOST-bundle client
 * component `<RemoteFrame grant="interactive">` mounts inside the
 * embed box, wrapping the spliced (inert) remote payload.
 *
 * Below the Client tier zero remote modules load, so interactivity
 * cannot arrive as remote code: the vocabulary's interactive members
 * (`TextField`, `Button` — `lib/vocabulary.tsx`) cross the wire as
 * reserved tags whose audited attributes NAME cells and actions the
 * REMOTE hosts, and this bridge — code the host already ships — wires
 * the behavior by DOM event delegation on the wrapper. The remote
 * decides WHAT is writable/invocable (its cells' `writeGuard`s, its
 * registered `embedAction`s); the host's bundle owns the code that
 * does the writing; the wire carries names and values only.
 *
 * Action refs are namespaced to the remote ORIGIN structurally: a tag
 * carries only the bare action/cell name, and the bridge posts it to
 * the origin the placement was spliced from (a prop of THIS component,
 * set by RemoteFrame server-side) — a payload can never route an
 * invocation to a third origin. Every POST carries the placement's
 * capability header; the producer authorizes against it
 * (`writeGuard` reads `getCapability()`; `embedAction` guards receive
 * the bag).
 *
 * Optimistic self-echo — writes cross a network hop and the UI must
 * not wait:
 *
 *  - A TextField's `<input>` is UNCONTROLLED (`defaultValue` on the
 *    wire): the DOM value IS the optimistic value, shown at
 *    keystroke; writes flush through a per-cell single-inflight,
 *    replace-coalescing queue (the same discipline `useCell().input()`
 *    applies to local cells), so rapid typing costs one round-trip at
 *    a time and only the latest value ever sends.
 *  - A Button holds `data-pending` (vocabulary CSS dims + inerts it)
 *    for the hop, preventing double-fire.
 *  - The SERVER echo is one coalesced `reload({selector: "@self"})`
 *    after the queue drains: the enclosing host parton re-renders,
 *    the RemoteFrame re-embeds, and the fresh remote render replaces
 *    the spliced content in place (uncontrolled inputs at stable
 *    positions keep the user's DOM value through the swap).
 *
 * Placement rule this implies: an interactive embed must sit inside
 * an ADDRESSABLE host parton — `@self` is the refresh target. Outside
 * one, interactions still write/invoke but the echo cannot land; the
 * `@self` resolution throws its standard wiring error.
 */

import { useEffect, useEffectEvent, useRef, type ReactNode, type Ref } from "react"
import { useNavigation } from "./use-navigation.tsx"
import {
  CAPABILITY_HEADER_NAME,
  REMOTE_ACTION_INVOKE_PATH,
  REMOTE_CELL_WRITE_PATH,
} from "./page-embed.ts"

/** One cell's write queue: latest pending value + in-flight flag —
 *  single-inflight, replace-coalesce. */
interface WriteQueueEntry {
  pending: string | null
  inflight: boolean
}

export function EmbedInteractiveBridge({
  origin,
  capability,
  children,
}: {
  /** The remote origin this placement was spliced from — the ONLY
   *  origin the bridge will address. */
  origin: string
  /** The placement's encoded capability (base64url JSON), or null. */
  capability: string | null
  children?: ReactNode
}) {
  const hostRef = useRef<HTMLElement | null>(null)
  const [reload] = useNavigation().reload()
  // (cellId + partition) → queue entry.
  const queuesRef = useRef(new Map<string, WriteQueueEntry>())
  const refreshScheduledRef = useRef(false)

  const postJson = useEffectEvent(async (path: string, body: unknown): Promise<boolean> => {
    const headers: Record<string, string> = { "content-type": "application/json;charset=utf-8" }
    if (capability !== null) headers[CAPABILITY_HEADER_NAME] = capability
    try {
      const res = await fetch(`${origin}${path}`, {
        method: "POST",
        headers,
        credentials: "omit",
        body: JSON.stringify(body),
      })
      return res.ok
    } catch {
      return false
    }
  })

  // The coalesced server echo: at most one @self reload per settled
  // burst, fired only when every write queue drained (a reload while
  // a newer value is still queued would echo the OLDER server state).
  const scheduleRefresh = useEffectEvent(() => {
    if (refreshScheduledRef.current) return
    refreshScheduledRef.current = true
    queueMicrotask(() => {
      refreshScheduledRef.current = false
      for (const entry of queuesRef.current.values()) {
        if (entry.inflight || entry.pending !== null) return
      }
      reload({ selector: "@self" })
    })
  })

  const pumpQueue = useEffectEvent(async (key: string, cellId: string, partition: unknown) => {
    const entry = queuesRef.current.get(key)
    if (!entry || entry.inflight) return
    entry.inflight = true
    // Single-inflight, replace-coalesce: only the latest pending value
    // ever sends; values queued during a hop send on the next loop turn.
    while (entry.pending !== null) {
      const value = entry.pending
      entry.pending = null
      await postJson(REMOTE_CELL_WRITE_PATH, { cell: cellId, partition, value })
    }
    entry.inflight = false
    scheduleRefresh()
  })

  const onInput = useEffectEvent((event: Event) => {
    const input = event.target as HTMLInputElement | null
    if (!input || input.tagName !== "INPUT") return
    const field = input.closest("parton-textfield")
    if (!field || !hostRef.current?.contains(field)) return
    const cellId = field.getAttribute("cell-id")
    if (!cellId) return
    let partition: unknown = {}
    try {
      partition = JSON.parse(field.getAttribute("cell-partition") ?? "{}")
    } catch {
      partition = {}
    }
    const key = `${cellId}|${field.getAttribute("cell-partition") ?? ""}`
    const entry = queuesRef.current.get(key) ?? { pending: null, inflight: false }
    queuesRef.current.set(key, entry)
    entry.pending = input.value
    void pumpQueue(key, cellId, partition)
  })

  const onClick = useEffectEvent((event: Event) => {
    const target = event.target as HTMLElement | null
    const button = target?.closest("parton-button")
    if (!button || !hostRef.current?.contains(button)) return
    if (button.hasAttribute("data-pending")) return
    const action = button.getAttribute("action")
    if (!action) return
    let payload: unknown = undefined
    const rawPayload = button.getAttribute("payload")
    if (rawPayload !== null) {
      try {
        payload = JSON.parse(rawPayload)
      } catch {
        payload = undefined
      }
    }
    button.setAttribute("data-pending", "")
    void postJson(REMOTE_ACTION_INVOKE_PATH, { action, payload }).then(() => {
      button.removeAttribute("data-pending")
      scheduleRefresh()
    })
  })

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    host.addEventListener("input", onInput)
    host.addEventListener("click", onClick)
    // The explicit "wired" signal — the `markPageInteractive` pattern:
    // the embed's DOM streams in (and is visible) before this client
    // component hydrates, so out-of-process observers (specs, tools)
    // wait on the marker the wiring itself writes, never on timing.
    host.setAttribute("data-interactive-ready", "")
    return () => {
      host.removeAttribute("data-interactive-ready")
      host.removeEventListener("input", onInput)
      host.removeEventListener("click", onClick)
    }
    // Effect Events are non-reactive by contract — omitted from deps.
  }, [])

  // A reserved custom element (display:contents — never participates
  // in layout). The tag renders via a type-cast JSX alias so it stays
  // off the global intrinsic surface while the ref flows through the
  // ordinary JSX path.
  const Wrapper = "parton-embed-interactive" as unknown as "div"
  return (
    <Wrapper ref={hostRef as Ref<HTMLDivElement>} style={{ display: "contents" }}>
      {children}
    </Wrapper>
  )
}
