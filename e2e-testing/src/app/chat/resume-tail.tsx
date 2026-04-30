"use client"

import { useEffect, useRef } from "react"
import { useNavigation } from "@react-cms/framework/lib/partial-client.tsx"

/**
 * Sentinel rendered at the bottom of a bounded `<Piece>` chain once it hits
 * `maxDepth`. On mount, fires a targeted refetch of the enclosing
 * `<Partial selector="#chat-msg-{fileId}">` with a bumped cursor in the URL.
 *
 * The server re-renders the message as `<FlatPrefix chunks=[0..cursor]/>` +
 * a fresh depth-0 `<Piece>` chain starting at `cursor`. Net effect: the
 * message's Suspense depth stays bounded while the content grows unbounded.
 *
 * `disableTransition: true` is load-bearing — the default transition
 * behavior would hold the entire refetch until all nested Pieces resolve
 * before committing, which defeats the whole point of the recursive
 * streaming shape. With transitions disabled, each Piece's chunk reveals as
 * its Flight payload arrives.
 */
export function ResumeTail({ fileId, cursor }: { fileId: string; cursor: number }) {
  const nav = useNavigation()
  // After the first compaction the refetch payload reuses the same
  // ResumeTail fiber (same type, different cursor prop) — React updates
  // rather than remounts. An "already fired" ref would block the second
  // and later compactions. Track which cursor we last fired for; fire
  // exactly once per unique cursor. The comparison also absorbs
  // StrictMode's double-invoked setup in dev (second invocation sees
  // the ref already equals the current cursor).
  const lastFiredCursor = useRef<number | null>(null)

  useEffect(() => {
    if (lastFiredCursor.current === cursor) return
    lastFiredCursor.current = cursor
    void nav.navigate(
      (url) => {
        url.searchParams.set(`cursor-${fileId}`, String(cursor))
        return url
      },
      {
        history: "replace",
        selector: `#chat-msg-${fileId}`,
        disableTransition: true,
      },
    )
  }, [fileId, cursor, nav])

  // Render an empty marker so the DOM can observe "a compact boundary lived
  // here" — useful for tests and for ruling out the case where depth-bound
  // firing gets swallowed silently.
  return <span data-testid={`resume-tail-${fileId}`} data-cursor={cursor} hidden />
}
