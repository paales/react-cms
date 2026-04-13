"use client";

import {
  useRef,
  useEffect,
  useState,
  useTransition,
  type ReactNode,
} from "react";
import { usePartial } from "../../lib/partial-client.tsx";

/**
 * Search toggle buttons for the header.
 *
 * Two variants to demonstrate the difference:
 * - "Search (URL)": opens overlay via ?search=url, search term goes in ?q= (bookmarkable)
 * - "Search (Partial)": opens overlay via ?search=partial, term uses usePartial (ephemeral)
 */
export function SearchToggle({
  isOpen,
  mode,
}: {
  isOpen: boolean;
  mode?: "url" | "partial";
}) {
  const [isPending, startTransition] = useTransition();

  function open(searchMode: "url" | "partial") {
    startTransition(() => {
      const url = new URL(window.location.href);
      url.searchParams.set("search", searchMode);
      history.pushState(null, "", url.toString());
    });
  }

  function close() {
    startTransition(() => {
      const url = new URL(window.location.href);
      url.searchParams.delete("search");
      url.searchParams.delete("q");
      history.pushState(null, "", url.toString());
    });
  }

  const buttonStyle = (active: boolean) => ({
    background: active ? "#4a5568" : "#2d3748",
    color: "#ededed",
    border: "1px solid #4a5568",
    padding: "0.4rem 0.8rem",
    borderRadius: 6,
    cursor: "pointer" as const,
    fontSize: "0.85rem",
    display: "inline-flex" as const,
    alignItems: "center" as const,
    gap: "0.4rem",
  });

  const spinner = (
    <span
      style={{
        display: "inline-block",
        width: 14,
        height: 14,
        border: "2px solid #888",
        borderTopColor: "#ededed",
        borderRadius: "50%",
        animation: "spin 0.6s linear infinite",
      }}
    />
  );

  if (isOpen) {
    return (
      <button type="button" onClick={close} style={buttonStyle(true)}>
        {isPending ? (
          spinner
        ) : (
          <span style={{ fontSize: "1rem" }}>&#x2715;</span>
        )}
        Close
      </button>
    );
  }

  return (
    <div style={{ display: "flex", gap: "0.5rem" }}>
      <button
        type="button"
        onClick={() => open("url")}
        style={buttonStyle(false)}
      >
        {isPending ? (
          spinner
        ) : (
          <span style={{ fontSize: "1rem" }}>&#x1F50D;</span>
        )}
        Search (URL)
      </button>
      <button
        type="button"
        onClick={() => open("partial")}
        style={buttonStyle(false)}
      >
        {isPending ? (
          spinner
        ) : (
          <span style={{ fontSize: "1rem" }}>&#x1F50D;</span>
        )}
        Search (Partial)
      </button>
    </div>
  );
}

/**
 * Dialog wrapper for the search overlay.
 * Uses the native <dialog> element with showModal() for proper
 * focus trapping, backdrop, and Escape to close.
 */
export function SearchDialog({
  open,
  children,
}: {
  open: boolean;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [, startTransition] = useTransition();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  function handleClose() {
    startTransition(() => {
      const url = new URL(window.location.href);
      url.searchParams.delete("search");
      url.searchParams.delete("q");
      history.pushState(null, "", url.toString());
    });
  }

  return (
    <dialog
      ref={dialogRef}
      onClose={handleClose}
      onClick={(e) => {
        // Close when clicking the backdrop (the dialog itself, not its content)
        if (e.target === dialogRef.current) handleClose();
      }}
      style={{
        background: "#111118",
        border: "1px solid #2d3748",
        padding: "1.25rem",
        borderRadius: 12,
        maxWidth: 720,
        width: "calc(100vw - 2em)",
        maxHeight: "80vh",
        overflow: "auto",
        display: "grid",
        top: "15vh",
        justifySelf: "center",
      }}
    >
      {children}
    </dialog>
  );
}

/**
 * Search input — usePartial variant (ephemeral, no URL change).
 *
 * Uses usePartial("search").refetch({ query }) to re-render the search
 * partial with new props. The search term lives in client state only —
 * not in the URL. On page refresh the search resets.
 */
export function SearchInput({
  query,
  mode,
}: {
  query: string;
  mode: "partial" | "url";
}) {
  const [value, setValue] = useState(query);
  const search = usePartial("search");
  const [urlPending, startTransition] = useTransition();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isPending = mode === "partial" ? search.isPending : urlPending;

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const next = e.target.value;
    setValue(next);

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      if (mode === "partial") {
        // Ephemeral: refetch partial with new props, no URL change
        search.refetch({ query: next });
      } else {
        // URL-based: update ?q= so the search is bookmarkable
        startTransition(() => {
          const url = new URL(window.location.href);
          if (next) {
            url.searchParams.set("q", next);
          } else {
            url.searchParams.delete("q");
          }
          history.replaceState(null, "", url.toString());
        });
      }
    }, 200);
  }

  return (
    <div style={{ position: "relative" }}>
      <input
        type="text"
        value={value}
        onChange={handleChange}
        placeholder="Search pokemon by name..."
        autoFocus
        style={{
          width: "100%",
          padding: "0.75rem 1rem",
          paddingRight: "2.5rem",
          background: "#1a1a2e",
          border: "1px solid #4a5568",
          borderRadius: 8,
          color: "#ededed",
          fontSize: "1rem",
          outline: "none",
        }}
      />
      {isPending && (
        <span
          style={{
            position: "absolute",
            right: 12,
            top: "50%",
            transform: "translateY(-50%)",
            display: "inline-block",
            width: 16,
            height: 16,
            border: "2px solid #888",
            borderTopColor: "#ededed",
            borderRadius: "50%",
            animation: "spin 0.6s linear infinite",
          }}
        />
      )}
      <span
        style={{
          position: "absolute",
          right: 12,
          bottom: -20,
          fontSize: "0.65rem",
          color: "#555",
        }}
      >
        {mode === "partial" ? "usePartial (ephemeral)" : "URL (bookmarkable)"}
      </span>
    </div>
  );
}
