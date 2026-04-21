"use client";

import { useState } from "react";
import { useNavigation } from "../../lib/partial-client.tsx";

/**
 * Button that fires a targeted reload via `useNavigation().reload()`.
 * Supports three shapes:
 *   - `{ids: ["hero"]}`   — by id
 *   - `{tags: ["price"]}` — by tag (any partial carrying the tag)
 *   - `{tags: ["a","b"]}` — multi-tag union (server-side resolution)
 *
 * Tag → id resolution runs server-side against the route-scoped
 * registry (`partial.tsx:resolveTagsToIds`), so dynamic partials
 * that only exist after a render (prices inside `.map()`, etc.) are
 * addressable the same as static ones.
 */
export function SelectorRefetchButton({
  ids,
  tags,
  label,
  testId,
}: {
  ids?: string[];
  tags?: string[];
  label: string;
  testId: string;
}) {
  const nav = useNavigation();
  const [isPending, setIsPending] = useState(false);

  async function fire() {
    setIsPending(true);
    try {
      await nav.reload({ ids, tags });
    } finally {
      setIsPending(false);
    }
  }

  return (
    <button
      type="button"
      data-testid={testId}
      onClick={fire}
      disabled={isPending}
    >
      {isPending ? "…" : label}
    </button>
  );
}
