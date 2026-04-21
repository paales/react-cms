"use client";

import { useCallback, useEffect, useState } from "react";
import { useNavigation } from "../../lib/partial-client.tsx";

/**
 * Manual activator: a plain button that calls
 * `useNavigation().reload({ids: [id]})`. Demonstrates `defer={true}`
 * — the framework isn't wired to any trigger; the app decides when
 * to activate.
 */
export function ActivateButton({
  partialId,
  label,
  testId,
  disableTransition,
}: {
  partialId: string;
  label?: string;
  testId?: string;
  /**
   * If true, the refetch bypasses React's `startTransition` wrapper —
   * each response commits on arrival rather than being held back
   * waiting for a newer transition. Useful for concurrent-refetch
   * demos where each response should be observable independently.
   */
  disableTransition?: boolean;
}) {
  const nav = useNavigation();
  const [isPending, setIsPending] = useState(false);
  const activate = async () => {
    setIsPending(true);
    try {
      await nav.reload({ ids: [partialId], disableTransition });
    } finally {
      setIsPending(false);
    }
  };
  return (
    <button
      type="button"
      data-testid={testId ?? `activate-${partialId}`}
      onClick={activate}
      disabled={isPending}
      style={{
        background: "#2d3748",
        color: "#ededed",
        border: "1px solid #4a5568",
        padding: "0.4rem 0.8rem",
        borderRadius: 6,
        cursor: isPending ? "wait" : "pointer",
        fontSize: "0.85rem",
      }}
    >
      {isPending ? "…" : label ?? "Activate"}
    </button>
  );
}

/**
 * Read / write a localStorage key. Used in the WhenStored demo so the user
 * can trigger activation from the page itself (the StorageEvent handler
 * in WhenStored only fires for OTHER tabs, so this helper emits a synthetic
 * StorageEvent for same-tab testing).
 */
export function StorageKeyEditor({
  storageKey,
  testId,
}: {
  storageKey: string;
  testId?: string;
}) {
  const [value, setValue] = useState("");
  const [stored, setStored] = useState<string | null>(null);

  useEffect(() => {
    setStored(localStorage.getItem(storageKey));
    const onStorage = (e: StorageEvent) => {
      if (e.key === storageKey) setStored(e.newValue);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [storageKey]);

  const write = useCallback(() => {
    const oldValue = localStorage.getItem(storageKey);
    localStorage.setItem(storageKey, value);
    // Same-tab storage events don't fire natively — dispatch a synthetic
    // one so WhenStored's listener picks it up.
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: storageKey,
        oldValue,
        newValue: value,
        storageArea: localStorage,
      }),
    );
    setStored(value);
  }, [storageKey, value]);

  const clear = useCallback(() => {
    const oldValue = localStorage.getItem(storageKey);
    localStorage.removeItem(storageKey);
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: storageKey,
        oldValue,
        newValue: null,
        storageArea: localStorage,
      }),
    );
    setStored(null);
  }, [storageKey]);

  return (
    <div
      style={{
        display: "flex",
        gap: "0.5rem",
        alignItems: "center",
        marginTop: "0.5rem",
      }}
    >
      <input
        data-testid={testId ? `${testId}-input` : `${storageKey}-input`}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={`value for "${storageKey}"`}
        style={{
          background: "#111",
          color: "#ededed",
          border: "1px solid #4a5568",
          padding: "0.3rem 0.5rem",
          borderRadius: 4,
          fontSize: "0.85rem",
        }}
      />
      <button
        type="button"
        data-testid={testId ? `${testId}-set` : `${storageKey}-set`}
        onClick={write}
        style={{
          background: "#2d3748",
          color: "#ededed",
          border: "1px solid #4a5568",
          padding: "0.3rem 0.7rem",
          borderRadius: 4,
          fontSize: "0.8rem",
          cursor: "pointer",
        }}
      >
        Set
      </button>
      <button
        type="button"
        data-testid={testId ? `${testId}-clear` : `${storageKey}-clear`}
        onClick={clear}
        style={{
          background: "#2d3748",
          color: "#ededed",
          border: "1px solid #4a5568",
          padding: "0.3rem 0.7rem",
          borderRadius: 4,
          fontSize: "0.8rem",
          cursor: "pointer",
        }}
      >
        Clear
      </button>
      <code style={{ color: "#888", fontSize: "0.8rem" }}>
        current: {stored == null ? "∅" : JSON.stringify(stored)}
      </code>
    </div>
  );
}
