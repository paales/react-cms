"use client"

import { useActivate, useNavigation } from "../../lib/partial-client.tsx"
import type { ActivatorProps } from "../../lib/partial-component.tsx"

export interface WhenStoredProps extends ActivatorProps {
  /** The storage key to watch. */
  storageKey: string
  /** Which store to read from. Default `"local"`. */
  store?: "local" | "session"
  /**
   * Name of the URL search param to write the stored value into
   * before activating. The server reads it via `getSearchParam(as)`
   * on re-render. Default `"value"`.
   */
  as?: string
}

/**
 * Activator: fires the enclosing Partial's refetch when a key is
 * present (or appears) in `localStorage` / `sessionStorage`. The
 * stored value is written to the page URL as `?<as>=<value>` so the
 * server can read it via `getSearchParam(as)` on re-render.
 *
 *   <Partial
 *     id="draft"
 *     fallback={<NewDraft/>}
 *     defer={<WhenStored storageKey="draft-id" as="draftId"/>}
 *   >
 *     <Editor/>      // reads `getSearchParam("draftId")` server-side
 *   </Partial>
 *
 * Behavior:
 *  - On mount: reads the key. If present, writes to the URL and
 *    activates immediately.
 *  - Otherwise: subscribes to the `storage` event and activates when
 *    the key transitions to non-null.
 *
 * The URL write uses `nav.navigate(url, { history: "replace", silent })`
 * — stamped with a framework silent-info marker, so the page-level
 * navigate interceptor declines to refetch. Only the activator's own
 * targeted reload (via `useActivate`) hits the server.
 *
 * Storage events only fire on OTHER tabs — a same-tab write won't
 * notify. If the author expects same-tab activation, they should set
 * the value *before* mounting the Partial (e.g. on a preceding page)
 * or dispatch a custom event and use a different activator.
 */
export function WhenStored({ partialId, children, storageKey, store, as }: WhenStoredProps) {
  if (!partialId) {
    throw new Error("<WhenStored> requires `partialId`. Use it as the `defer` prop of a <Partial>.")
  }
  const nav = useNavigation()

  // `useActivate` captures `subscribe` via a ref, so returning a new
  // closure each render is fine — the ref holds the latest and the
  // underlying effect only re-registers on `[partialId, once]`.
  useActivate(partialId, (fire) => {
    const storage = store === "session" ? sessionStorage : localStorage
    const tryActivate = () => {
      const v = storage.getItem(storageKey)
      if (v == null) return
      if ("location" in globalThis) {
        const url = new URL(window.location.href)
        if (url.searchParams.get(as ?? "value") !== v) {
          url.searchParams.set(as ?? "value", v)
          void nav.navigate(url.toString(), {
            history: "replace",
            silent: true,
          })
        }
      }
      fire()
    }
    tryActivate()
    const onStorage = (e: StorageEvent) => {
      if (e.storageArea !== storage) return
      if (e.key === storageKey && e.newValue != null) tryActivate()
    }
    window.addEventListener("storage", onStorage)
    return () => window.removeEventListener("storage", onStorage)
  })
  return <>{children}</>
}
