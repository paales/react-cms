/**
 * /chat-notes — explainer page for the chat overlay's streaming demo.
 * The actual streaming UI lives in `chat-overlay.tsx`.
 */

import { ReactCms } from "@react-cms/framework"

export const ChatNotesPage = ReactCms.partial(
  function ChatNotesRender() {
    return (
      <main className="pb-[60vh]">
        <title>Chat Notes — streaming demo</title>
        <h1 className="mb-4 text-2xl font-semibold">Chat — streaming the notes/ directory</h1>
        <p className="mb-3 leading-relaxed text-muted-foreground">
          The box in the bottom-right streams one markdown file from notes/, character by
          character, through a bounded recursive Piece server component.
        </p>
      </main>
    )
  },
  { match: "/chat-notes" },
)
