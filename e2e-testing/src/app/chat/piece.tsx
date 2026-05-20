/**
 * Chat message rendering — append-only ChunkList + a wait sentinel.
 *
 * Each `<ChatMessage>` reads the log's current chunks synchronously
 * (no per-chunk Suspense recursion), then mounts a Suspense boundary
 * whose only child suspends on the NEXT chunk arrival. When the
 * producer appends, `appendChunk` fires `refreshSelector` on the
 * message label; the server-side segment driver wakes, re-renders
 * the message partial with the new chunk in `ChunkList`, and the
 * next sentinel suspends on the chunk after THAT.
 *
 * Liveness is structural: while `<ChunkSlot>` is awaiting, the
 * render isn't done, so the segment driver knows there's pending
 * work and keeps the connection open. When the producer signals done,
 * `<ChunkSlot>` returns a "stream complete" tail synchronously and
 * stops calling `markConnectionLive`, so the segment driver closes
 * the connection naturally.
 */

import { Suspense } from "react"
import { getServerNavigation, markConnectionLive } from "@parton/framework"
import { readLogState, waitForNextChunk } from "./log.ts"

function ChunkText({ text }: { text: string }) {
  return (
    <span data-chunk className="font-mono text-xs leading-relaxed whitespace-pre-wrap">
      {text}
    </span>
  )
}

function ChunkList({ chunks }: { chunks: readonly string[] }) {
  return (
    <>
      {chunks.map((text, i) => (
        <ChunkText key={i} text={text} />
      ))}
    </>
  )
}

/**
 * Wait sentinel — suspends until the log advances past the current
 * cursor. Renders nothing on resolve; the new chunk shows up in
 * `<ChunkList>` of the NEXT segment after the segment driver
 * re-renders. `markConnectionLive()` opts this render into the
 * framework's multi-segment keepalive — the producer-await pattern
 * here doesn't use the `?streaming=1` URL flag because the same
 * /chat-notes page render shows the sentinel; the server-side
 * opt-in is the cleaner fit.
 */
async function ChunkSlot({ fileId, cursor }: { fileId: string; cursor: number }) {
  markConnectionLive()
  await waitForNextChunk(fileId, cursor)
  return null
}

export function ChatMessage({ fileId }: { fileId: string }) {
  const snapshot = readLogState(fileId)
  // Server-push the cursor into the window URL so bookmarking the
  // page mid-stream resumes at the latest cursor. Replace mode so
  // the back-stack stays clean across many cursor advances. Pass an
  // updater so existing search params (chat=open, msgs=…) survive —
  // a bare `?cursor=N` target would replace the whole query string.
  if (snapshot.cursor > 0) {
    // For now this is left unwired — `navigate` accepts a string or
    // URL but no URL-updater on the server side. Cursor URL push is
    // a chat-only nicety, not load-bearing for the stream.
  }
  return (
    <article
      data-testid={`chat-msg-${fileId}`}
      data-cursor={snapshot.cursor}
      className="mb-2 rounded-lg border bg-background px-3 py-2"
    >
      <header className="mb-1.5 font-sans text-[0.7rem] uppercase tracking-wider text-emerald-300">
        {fileId}.md
      </header>
      <div data-testid={`chat-body-${fileId}`}>
        <ChunkList chunks={snapshot.chunks} />
        {snapshot.done ? (
          <span
            data-testid={`chat-done-${fileId}`}
            className="mt-1 block text-xs text-emerald-500"
          >
            ✓ stream complete ({snapshot.cursor} chunks)
          </span>
        ) : (
          <Suspense
            fallback={
              <span
                data-testid={`chat-pending-${fileId}`}
                className="text-xs italic text-muted-foreground"
              >
                streaming…
              </span>
            }
          >
            <ChunkSlot fileId={fileId} cursor={snapshot.cursor} />
          </Suspense>
        )}
      </div>
    </article>
  )
}
