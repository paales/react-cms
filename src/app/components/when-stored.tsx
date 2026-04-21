"use client";

import { useMemo } from "react";
import { useActivate } from "../../lib/partial-client.tsx";
import type { ActivatorProps } from "../../lib/partial-component.tsx";

export interface WhenStoredProps extends ActivatorProps {
  /** The storage key to watch. */
  storageKey: string;
  /** Which store to read from. Default `"local"`. */
  store?: "local" | "session";
  /**
   * Name of the URL search param to write the stored value into
   * before activating. The server reads it via `getSearchParam(as)`
   * on re-render. Default `"value"`.
   */
  as?: string;
}

/**
 * Build the `subscribe` callback `<WhenStored>` passes into
 * `useActivate`. Factored out so unit tests can exercise the storage /
 * event wiring directly without rendering a component.
 *
 * On activation:
 *   1. Write the stored value to the current URL's `?<as>=<value>`
 *      via `history.replaceState` (no navigate event — marked silent
 *      by the navigation layer's pushState/replaceState bookkeeping
 *      through the targeted refetch path).
 *   2. Fire the activator so the framework dispatches a targeted
 *      reload for this partial id. The server reads the fresh URL
 *      via tracked accessors.
 */
export function makeStoredSubscribe(opts: {
  storageKey: string;
  store?: "local" | "session";
  as?: string;
}) {
  const storageKey = opts.storageKey;
  const useSession = opts.store === "session";
  const as = opts.as ?? "value";

  return (fire: () => void) => {
    const storage = useSession ? sessionStorage : localStorage;
    const tryActivate = () => {
      const v = storage.getItem(storageKey);
      if (v == null) return;
      if (typeof window !== "undefined") {
        const url = new URL(window.location.href);
        if (url.searchParams.get(as) !== v) {
          url.searchParams.set(as, v);
          history.replaceState(history.state, "", url.toString());
        }
      }
      fire();
    };
    tryActivate();
    const onStorage = (e: StorageEvent) => {
      if (e.storageArea !== storage) return;
      if (e.key === storageKey && e.newValue != null) tryActivate();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  };
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
 * Storage events only fire on OTHER tabs — a same-tab write won't
 * notify. If the author expects same-tab activation, they should set
 * the value *before* mounting the Partial (e.g. on a preceding page)
 * or dispatch a custom event and use a different activator.
 */
export function WhenStored({
  partialId,
  children,
  storageKey,
  store,
  as,
}: WhenStoredProps) {
  if (!partialId) {
    throw new Error(
      "<WhenStored> requires `partialId`. Use it as the `defer` prop of a <Partial>.",
    );
  }
  const subscribe = useMemo(
    () => makeStoredSubscribe({ storageKey, store, as }),
    [storageKey, store, as],
  );
  useActivate(partialId, subscribe);
  return <>{children}</>;
}
