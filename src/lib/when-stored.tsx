"use client";

import { useMemo } from "react";
import { useActivate } from "./partial-client.tsx";
import type { ActivatorProps } from "./partial-component.tsx";

export interface WhenStoredProps extends ActivatorProps {
  /** The storage key to watch. */
  storageKey: string;
  /** Which store to read from. Default `"local"`. */
  store?: "local" | "session";
  /**
   * Name of the prop to inject into the Partial's content with the
   * stored value. Default `"value"`. The stored value is passed as a
   * string via `__inputs` — the content component is responsible for
   * parsing if needed.
   */
  as?: string;
}

/**
 * Build the `subscribe` callback `<WhenStored>` passes into
 * `useActivate`. Factored out so unit tests can exercise the storage /
 * event wiring directly without rendering a component.
 */
export function makeStoredSubscribe(opts: {
  storageKey: string;
  store?: "local" | "session";
  as?: string;
}) {
  const storageKey = opts.storageKey;
  const useSession = opts.store === "session";
  const as = opts.as ?? "value";

  return (fire: (inputs?: Record<string, unknown>) => void) => {
    const storage = useSession ? sessionStorage : localStorage;
    const tryActivate = () => {
      const v = storage.getItem(storageKey);
      if (v != null) fire({ [as]: v });
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
 * stored value is sent along as an `__inputs` prop override.
 *
 *   <Partial
 *     id="draft"
 *     fallback={<NewDraft/>}
 *     defer={<WhenStored storageKey="draft-id" as="draftId"/>}
 *   >
 *     <Editor/>      // receives `draftId="…"` after activation
 *   </Partial>
 *
 * Behavior:
 *  - On mount: reads the key. If present, activates immediately.
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
