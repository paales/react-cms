"use client"

import { useActivate } from "@react-cms/framework/lib/partial-client.tsx"
import type { ActivatorProps } from "@react-cms/framework"

export interface WhenStoredProps extends ActivatorProps {
  /** The storage key to watch. */
  storageKey: string
  /** Which store to read from. Default `"local"`. */
  store?: "local" | "session"
  /**
   * Prop name to send the stored value as. Default `"stored"`. The
   * activator fires a partial-refetch with `{ [as]: <storedValue> }`
   * as the prop payload, which the server forwards to the spec's
   * Render function as a JSX-style call-site prop.
   */
  as?: string
}

/**
 * Activator: fires the enclosing Partial's refetch when a key is
 * present (or appears) in `localStorage` / `sessionStorage`. The
 * stored value is sent as a prop named by `as` (defaults to
 * `"stored"`). The server reads `?partialProps={"<id>":{<as>:<v>}}`
 * and re-renders the spec with the value as a JSX call-site prop —
 * no URL writes, no `getSearchParam` reads.
 *
 *   const Draft = ReactCms.partial(
 *     function DraftRender({ draftId }: { draftId: string } & RenderArgs) { ... },
 *     {
 *       defer: <WhenStored storageKey="draft-id" as="draftId" />,
 *       fallback: <NewDraft />,
 *     },
 *   )
 *
 * Behavior:
 *  - On mount: reads the key. If present, fires immediately with the
 *    value as a prop.
 *  - Otherwise: subscribes to the `storage` event and fires when the
 *    key transitions to non-null.
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
  const propName = as ?? "stored"

  // `useActivate` captures `subscribe` via a ref, so returning a new
  // closure each render is fine — the ref holds the latest and the
  // underlying effect only re-registers on `[partialId, once]`.
  useActivate(partialId, (fire) => {
    const storage = store === "session" ? sessionStorage : localStorage
    const tryActivate = () => {
      const v = storage.getItem(storageKey)
      if (v == null) return
      fire({ props: { [propName]: v } })
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
