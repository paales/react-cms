import { Suspense } from "react"
import { readLog, readLogPrefix } from "./log.ts"
import { ResumeTail } from "./resume-tail.tsx"

/**
 * Bounded linear recursion that emits a streaming message.
 */
const MAX_DEPTH = 12

export async function Piece({
  fileId,
  cursor,
  depth,
}: {
  fileId: string
  cursor: number
  depth: number
}) {
  const read = await readLog(fileId, cursor)
  if (read.done) {
    return (
      <span data-testid={`chat-done-${fileId}`} className="mt-1 block text-xs text-emerald-500">
        ✓ stream complete ({cursor} chunks)
      </span>
    )
  }
  const nextCursor = cursor + 1
  const nextDepth = depth + 1
  return (
    <>
      <ChunkText text={read.text} />
      {nextDepth >= MAX_DEPTH ? (
        <ResumeTail fileId={fileId} cursor={nextCursor} />
      ) : (
        <Suspense fallback={null}>
          <Piece fileId={fileId} cursor={nextCursor} depth={nextDepth} />
        </Suspense>
      )}
    </>
  )
}

function ChunkText({ text }: { text: string }) {
  return (
    <span data-chunk className="font-mono text-xs leading-relaxed whitespace-pre-wrap">
      {text}
    </span>
  )
}

export function FlatPrefix({ fileId, cursor }: { fileId: string; cursor: number }) {
  if (cursor <= 0) return null
  const chunks = readLogPrefix(fileId, cursor)
  return (
    <>
      {chunks.map((text, i) => (
        <ChunkText key={i} text={text} />
      ))}
    </>
  )
}

export function ChatMessage({ fileId, cursor }: { fileId: string; cursor: number }) {
  const startCursor = Math.max(0, cursor)
  return (
    <article
      data-testid={`chat-msg-${fileId}`}
      data-cursor={startCursor}
      className="mb-2 rounded-lg border bg-background px-3 py-2"
    >
      <header className="mb-1.5 font-sans text-[0.7rem] uppercase tracking-wider text-emerald-300">
        {fileId}.md
      </header>
      <div data-testid={`chat-body-${fileId}`}>
        <FlatPrefix fileId={fileId} cursor={startCursor} />
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
          <Piece fileId={fileId} cursor={startCursor} depth={0} />
        </Suspense>
      </div>
    </article>
  )
}
