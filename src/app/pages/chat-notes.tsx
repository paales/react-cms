export function ChatNotesPage() {
  return (
    <main className="pb-[60vh]">
      <title>Chat Notes — streaming demo</title>
      <h1 className="mb-4 text-2xl font-semibold">
        Chat — streaming the{" "}
        <code className="rounded bg-muted px-1.5 py-0.5 text-[0.85em]">notes/</code> directory
      </h1>
      <p className="mb-3 leading-relaxed text-muted-foreground">
        The box in the bottom-right streams one markdown file from{" "}
        <code className="rounded bg-muted px-1.5 py-0.5 text-[0.85em]">notes/</code>, character by
        character, through a bounded recursive{" "}
        <code className="rounded bg-muted px-1.5 py-0.5 text-[0.85em]">&lt;Piece&gt;</code> server
        component. When the Piece chain hits its depth bound it compacts via a targeted{" "}
        <code className="rounded bg-muted px-1.5 py-0.5 text-[0.85em]">reload</code> — the message
        re-renders as a synchronous flat prefix plus a fresh depth-0 Piece chain for the tail. Watch
        the message keep growing while the Suspense depth stays bounded.
      </p>
      <h2 className="mt-4 mb-2 text-lg text-foreground/80">How it works</h2>
      <p className="mb-3 leading-relaxed text-muted-foreground">
        The server-side log (
        <code className="rounded bg-muted px-1.5 py-0.5 text-[0.85em]">src/app/chat/log.ts</code>)
        holds all produced chunks. Every refetch rehydrates its prefix from the log synchronously,
        so reconnects are cheap. Cursors live in the URL (
        <code className="rounded bg-muted px-1.5 py-0.5 text-[0.85em]">
          ?cursor-&lt;fileId&gt;=N
        </code>
        ) so page reloads and browser back/forward resume correctly. The producer runs on a
        ten-second budget so even long files stop on their own.
      </p>
      <p className="mb-3 leading-relaxed text-muted-foreground">
        The chat box is mounted on every page — navigate around and messages in progress keep
        streaming. Click "+ stream next note" to start another file in parallel.
      </p>
    </main>
  )
}
