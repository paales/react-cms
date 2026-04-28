import { Partial } from "../../lib/partial.tsx"
import { ROOT, capturePartialContext } from "../../lib/partial-context.ts"
import { getSearchParam } from "../../framework/context.ts"
import { ChatMessage } from "./piece.tsx"
import {
  AutoScrollToBottom,
  ChatClosePill,
  ChatOpenPill,
  NewMessageLink,
  ResetChatButton,
} from "./chat-controls.tsx"

/**
 * Ordered pool of markdown files streamable into the chat. The
 * server-side producer in `log.ts` searches `notes/`, `docs/`,
 * `docs-dev/`, and `archive/` for each id; this list curates which
 * ids the +new-message picker offers.
 */
export const AVAILABLE_FILES = [
  // Lead with the framework reference — the chat demo doubles as a
  // way to read the docs.
  "AA_CHAT_STREAMING",
  "intro",
  "partial",
  "frames-navigation",
  "cache",
  "cms",
  "prior-art",
  // Internals.
  "render-pipeline",
  "cache-internals",
  "frame-scope",
  "manifest-internals",
  "server-isolation",
  "flight-gotchas",
  "testing",
  // Active research.
  "IDEAS",
  // Archived design retrospectives — useful chat content.
  "STREAMING_CHAT",
  "PARTIAL_ARCHITECTURE",
]

const DEFAULT_MSG = "AA_CHAT_STREAMING"

function parseMsgs(param: string | null): string[] {
  if (param == null) return [DEFAULT_MSG]
  return param
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s && AVAILABLE_FILES.includes(s))
}

function computeNextHref(msgIds: string[]): string | null {
  const next = AVAILABLE_FILES.find((f) => !msgIds.includes(f))
  if (!next) return null
  const params = new URLSearchParams()
  params.set("msgs", [...msgIds, next].join(","))
  params.set("chat", "open")
  return `?${params.toString()}`
}

export function ChatOverlay() {
  return (
    <Partial parent={ROOT} selector="#chat-overlay" frame="chat-overlay">
      <ChatOverlayBody />
    </Partial>
  )
}

function ChatOverlayBody() {
  const parent = capturePartialContext()
  const chatParam = getSearchParam("chat")
  const open = chatParam != null ? chatParam === "open" : false

  if (!open) return <ChatOpenPill />

  const msgsParam = getSearchParam("msgs")
  const msgIds = parseMsgs(msgsParam)
  const nextHref = computeNextHref(msgIds)

  return (
    <aside
      data-testid="chat-box"
      className="fixed right-4 bottom-4 z-100 flex max-h-[70vh] w-150 flex-col rounded-xl border bg-card text-card-foreground shadow-2xl"
    >
      <header className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <strong className="text-sm">notes stream</strong>
        <div className="flex gap-1.5">
          <ResetChatButton />
          <ChatClosePill />
        </div>
      </header>
      <AutoScrollToBottom containerTestId="chat-list" />
      <Partial parent={parent} selector="#chat-list">
        <div data-testid="chat-list" className="min-h-30 flex-1 overflow-y-auto px-3 py-2">
          {msgIds.length === 0 ? (
            <div data-testid="chat-empty" className="text-xs italic text-muted-foreground">
              No messages. Click “stream next note” to start.
            </div>
          ) : (
            msgIds.map((fileId) => (
              <Partial parent={parent} key={`chat-msg-${fileId}`} selector={`#chat-msg-${fileId}`}>
                <ChatMessage fileId={fileId} />
              </Partial>
            ))
          )}
        </div>
      </Partial>
      <footer className="border-t px-3 py-2">
        <NewMessageLink nextHref={nextHref} />
      </footer>
    </aside>
  )
}
