"use client";

import {
  useEffect,
  useRef,
  useState,
  useTransition,
  type ReactNode,
} from "react";
import { useNavigation } from "../../lib/partial-client.tsx";

/**
 * Utility: append / set / delete a search param on a relative URL
 * string (no `window.location` dependency). The base parameter is
 * only used to parse; `new URL` needs some origin. We throw the
 * origin away and return pathname+search.
 */
function withParam(
  base: string,
  key: string,
  value: string | null,
): string {
  const u = new URL(base, "http://_");
  if (value == null) u.searchParams.delete(key);
  else u.searchParams.set(key, value);
  return u.pathname + u.search;
}

/**
 * Search toggle buttons for the header.
 *
 * Two variants:
 * - "Search (URL)":   sets `?search=1` on the PAGE URL via
 *   `useNavigation().navigate(...)`. The page-level SearchArea
 *   reads the page URL and renders its dialog open.
 * - "Search (Frame)": navigates the `search` frame to `/?search=1` via
 *   `frame("search").navigate(...)`. The framed SearchArea reads the
 *   FRAME URL — no page-URL mutation at all.
 *
 * `<SearchArea/>` is the same component in both modes; its scope
 * (the surrounding frame or the page) decides where `?search=` is
 * read from.
 */
export function SearchToggle({ urlOpen }: { urlOpen: boolean }) {
  const [isPending, startTransition] = useTransition();
  const pageNav = useNavigation();
  const frameNav = useNavigation("search");
  // Frame state lives purely client-side (frame URL in `_frameUrls`).
  // Computed reactively — `useNavigation()` subscribes to `navigate`
  // events so this re-evaluates when the frame URL changes.
  const frameOpen = (() => {
    const cur = frameNav.currentUrl;
    if (!cur) return false;
    return new URL(cur, "http://_").searchParams.has("search");
  })();

  function openUrl() {
    const target = withParam(pageNav.currentUrl ?? "/", "search", "1");
    startTransition(() => {
      void pageNav.navigate(target, { history: "push", ids: ["search-page"] });
    });
  }

  function closeUrl() {
    let target = pageNav.currentUrl ?? "/";
    target = withParam(target, "search", null);
    target = withParam(target, "q", null);
    startTransition(() => {
      void pageNav.navigate(target, { history: "push", ids: ["search-page"] });
    });
  }

  function openFrame() {
    void frameNav.navigate("/?search=1");
  }

  function closeFrame() {
    void frameNav.navigate("/");
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

  if (urlOpen) {
    return (
      <button type="button" onClick={closeUrl} style={buttonStyle(true)}>
        {isPending ? (
          spinner
        ) : (
          <span style={{ fontSize: "1rem" }}>&#x2715;</span>
        )}
        Close
      </button>
    );
  }

  if (frameOpen) {
    return (
      <button
        type="button"
        onClick={closeFrame}
        style={buttonStyle(true)}
        data-testid="search-frame-close"
      >
        <span style={{ fontSize: "1rem" }}>&#x2715;</span>
        Close
      </button>
    );
  }

  return (
    <div style={{ display: "flex", gap: "0.5rem" }}>
      <button type="button" onClick={openUrl} style={buttonStyle(false)}>
        {isPending ? (
          spinner
        ) : (
          <span style={{ fontSize: "1rem" }}>&#x1F50D;</span>
        )}
        Search (URL)
      </button>
      <button
        type="button"
        onClick={openFrame}
        style={buttonStyle(false)}
        data-testid="search-frame-open"
      >
        <span style={{ fontSize: "1rem" }}>&#x1F50D;</span>
        Search (Frame)
      </button>
    </div>
  );
}

/**
 * Dialog wrapper for the search overlay. Uses the native <dialog>
 * element with showModal() for focus trap + backdrop + Escape.
 *
 * Close behavior is scope-aware: reads `useNavigation()` and updates
 * the appropriate URL (page or frame) to drop `?search=` and `?q=`.
 * No `mode` prop — the ambient navigation handle decides.
 */
export function SearchDialog({
  open,
  children,
}: {
  open: boolean;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const nav = useNavigation();

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
    let target = nav.currentUrl ?? "/";
    target = withParam(target, "search", null);
    target = withParam(target, "q", null);
    void nav.navigate(target, {
      history: "push",
      // Page scope: refetch the SearchArea holder. Frame scope: ignored
      // (frame nav refetches its whole subtree).
      ids: nav.name === null ? ["search-page"] : undefined,
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
 * Search input with live partial refetch — scope-agnostic.
 *
 * Reads `useNavigation()` without a name, so it binds to the
 * enclosing frame when there is one (frame mode) and to the window
 * otherwise (URL mode). `nav.currentUrl` is the URL it should modify
 * (page URL in URL mode, frame URL in frame mode). Navigate options
 * pass `tags: ["search-results"]` — the server resolves the tag
 * against the route registry to the three stage ids (page scope) and
 * refetches them; frame handles ignore the tag filter and refetch
 * the whole frame subtree (same resulting content).
 *
 * Same serial-dispatch guard for both modes: fire on first change,
 * wait for the response, fire again with the latest typed value.
 */
export function SearchInput({ query }: { query: string }) {
  const nav = useNavigation();
  const [value, setValue] = useState(query);
  // A/B the two commit modes live. Default (`disableTransition: false`)
  // wraps the commit in startTransition, so React holds the old results
  // visible until the new ones are fully ready — one atomic swap, no
  // fallback flash. Checked (`true`) falls back to a plain setState, so
  // each stage's Suspense shows its fallback and commits as its chunk
  // arrives — per-row streaming.
  const [disableTransition, setDisableTransition] = useState(false);
  const disableTransitionRef = useRef(disableTransition);
  disableTransitionRef.current = disableTransition;

  // Imperative serial queue — refs for synchronous flow control.
  // No useEffect, no reliance on React state timing.
  const latestRef = useRef(query);
  const dispatchedRef = useRef(query);
  const inFlightRef = useRef(false);

  async function sendLatest() {
    if (inFlightRef.current) return;
    const q = latestRef.current;
    if (q === dispatchedRef.current) return;

    inFlightRef.current = true;
    dispatchedRef.current = q;

    // `nav.currentUrl` is the scope-appropriate URL: page URL for the
    // window handle, frame URL for a frame handle. Mutate it and hand
    // the whole thing back to `nav.navigate`.
    const target = withParam(nav.currentUrl ?? "/", "q", q || null);

    await nav.navigate(target, {
      history: "replace",
      disableTransition: disableTransitionRef.current,
      // Tag-based refetch: resolves server-side to whichever stage
      // Partials are registered on this route. Frame handles ignore
      // the tag filter (the frame refetches its own subtree, which
      // already contains the tagged stages).
      tags: ["search-results"],
    });

    inFlightRef.current = false;
    // Re-check: user may have typed more while request was in flight
    sendLatest();
  }

  function handleChange(next: string) {
    setValue(next);
    latestRef.current = next;
    sendLatest();
  }

  const isStale = value !== dispatchedRef.current || inFlightRef.current;

  return (
    <div>
      <div style={{ position: "relative" }}>
        <input
          type="text"
          value={value}
          onChange={(e) => handleChange(e.target.value)}
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
        {isStale && (
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
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginTop: "0.5rem",
          fontSize: "0.75rem",
          color: "#888",
        }}
      >
        <label
          data-testid="disable-transition-toggle"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "0.4rem",
            cursor: "pointer",
            userSelect: "none",
          }}
        >
          <input
            type="checkbox"
            checked={disableTransition}
            onChange={(e) => setDisableTransition(e.target.checked)}
          />
          <span>
            disableTransition:{" "}
            <code style={{ color: disableTransition ? "#8b8" : "#8bd" }}>
              {String(disableTransition)}
            </code>
          </span>
          <span style={{ color: "#555" }}>
            {disableTransition
              ? "plain setState — fallback flashes, streams per chunk"
              : "startTransition — preserve UI, no fallback, no streaming"}
          </span>
        </label>
        <span style={{ color: "#555" }}>
          {nav.name === null ? "page URL scope" : `frame "${nav.name}" scope`}
        </span>
      </div>
    </div>
  );
}
