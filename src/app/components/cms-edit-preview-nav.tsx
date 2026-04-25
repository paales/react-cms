"use client";

import { useEffect, useState, useSyncExternalStore, type FormEvent } from "react";
import { useNavigation } from "../../lib/partial-client.tsx";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Frame URL bar for the CMS editor preview.
 *
 * Drives the `<Partial frame="preview">` rendered next to it. The
 * preview is itself a frame (a "server iframe" — see notes/FRAMES.md),
 * so navigating it via `useNavigation("preview").navigate(href)` only
 * refetches the preview subtree. The editor's own URL (and the
 * tree / field panels) stay untouched. Authors can move the
 * previewed page around — e.g. `/cms-demo`, `/cms-demo/alpha`,
 * `/cms-demo/beta` — and the per-slug CMS configs in the
 * tree-selected node take effect immediately, demonstrating the
 * "edit any page in place" experience.
 *
 * Preset buttons mirror the demo page's slug-nav so a freshly-opened
 * editor has obvious targets to click. The text input handles
 * arbitrary paths.
 */
export interface PreviewNavLink {
  href: string;
  label: string;
}

export function CmsEditPreviewNav({
  initialUrl,
  links,
}: {
  initialUrl: string;
  links: ReadonlyArray<PreviewNavLink>;
}) {
  // The preview frame is named `"preview"` (see `<Partial
  // frame="preview">` in cms-edit.tsx). Targeting that frame by name
  // gives us the typed FrameworkNavigation handle scoped to the
  // frame's session entry.
  const nav = useNavigation("preview");
  const [draft, setDraft] = useState("");

  function navigate(href: string) {
    void nav.navigate(href);
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!draft.trim()) return;
    navigate(draft.trim());
  }

  // The frame's `currentEntry.url` is only available on the client
  // (the server has no Navigation API). Resolving it during SSR
  // causes a hydration mismatch — the server emits the entry URL
  // it can synthesize from session state, the client emits whatever
  // `window.navigation` reports, and the two often disagree.
  //
  // Fix: render `initialUrl` server-side (and on first hydration),
  // then swap to the live frame URL via `useSyncExternalStore` only
  // after the client mounts. The post-mount swap is a normal React
  // state update — no hydration warning.
  const liveUrl = useSyncExternalStore(
    (cb) => {
      nav.addEventListener("currententrychange", cb);
      return () => nav.removeEventListener("currententrychange", cb);
    },
    () => nav.currentEntry?.url ?? null,
    () => null,
  );
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const currentUrl =
    mounted && liveUrl ? safeShortUrl(liveUrl) : initialUrl;

  return (
    <div
      className="flex flex-col gap-2"
      data-testid="cms-edit-preview-nav"
    >
      <div className="flex items-center gap-2">
        <span className="text-xs uppercase tracking-wide text-muted-foreground">
          Preview URL
        </span>
        <code
          className="rounded bg-muted px-2 py-0.5 text-[0.75rem] font-mono"
          data-testid="cms-edit-preview-url"
        >
          {currentUrl}
        </code>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {links.map((link) => {
          const isActive = currentUrl === link.href;
          return (
            <Button
              key={link.href}
              type="button"
              size="sm"
              variant={isActive ? "default" : "outline"}
              onClick={() => navigate(link.href)}
              data-testid={`cms-edit-preview-nav-${link.href}`}
              className={cn(isActive && "pointer-events-none")}
            >
              {link.label}
            </Button>
          );
        })}
        <form onSubmit={onSubmit} className="flex items-center gap-1">
          <input
            type="text"
            placeholder="/path…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="rounded border border-input bg-background px-2 py-1 text-xs"
            data-testid="cms-edit-preview-nav-input"
          />
          <Button type="submit" size="sm" variant="outline">
            Go
          </Button>
        </form>
      </div>
    </div>
  );
}

/** Strip the origin so the URL bar shows a path (`/cms-demo/alpha`)
 *  rather than the full `http://localhost:5173/...` string. */
function safeShortUrl(href: string): string {
  try {
    const u = new URL(href);
    return u.pathname + u.search;
  } catch {
    return href;
  }
}
