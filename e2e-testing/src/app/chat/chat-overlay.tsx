/**
 * Chat overlay — streaming notes demo.
 *
 * Frame-scoped (`frame="chat-overlay"`) so the open/close state lives
 * separately from the page URL. Each message in `?msgs=…` becomes a
 * pre-built per-fileId message spec; the slot lookup wraps `ChatMessage`
 * once per id.
 */

import { parton, tag, searchParam, type PartialCtx, type RenderArgs } from "@parton/framework"
import { Frame } from "@parton/framework"
import { ChatMessage } from "./piece.tsx"
import {
  AutoScrollToBottom,
  ChatClosePill,
  ChatOpenPill,
  NewMessageLink,
  ResetChatButton,
} from "./chat-controls.tsx"

export const AVAILABLE_FILES = [
  "AA_CHAT_STREAMING",
  "intro",
  "partial",
  "frames-navigation",
  "cache",
  "cms",
  "prior-art",
  "render-pipeline",
  "cache-internals",
  "frame-scope",
  "manifest-internals",
  "server-isolation",
  "flight-gotchas",
  "testing",
  "IDEAS",
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

// Pre-built message specs — one per fileId. Each gates by checking
// whether its fileId is in the `?msgs=` list. `ChatMessage` reads the
// log's state directly and a Suspense sentinel keeps the connection
// live until the producer signals done; the `tag()` read below is
// what subscribes each message to `log.ts::appendChunk`'s
// `refreshSelector` bumps.
const MessagePartials = AVAILABLE_FILES.map((fileId) =>
  parton(
    Object.assign(
      function MessageRender() {
        // The producer's wake signal: `log.ts::appendChunk` fires
        // `refreshSelector("chat-msg-<fileId>")` per appended chunk —
        // this read subscribes the message parton to it.
        tag(`chat-msg-${fileId}`)
        return <ChatMessage fileId={fileId} />
      },
      // One spec per file — the factory names each product.
      { displayName: `chat-msg-${fileId}` },
    ),
    {
      // The message exists iff its id is in the `?msgs=` list — a miss
      // parks the streamed DOM so back/forward restores it instantly.
      match: { searchParams: { msgs: (v) => parseMsgs(v).includes(fileId) } },
    },
  ),
)

export const ChatListPartial = parton(function ChatListRender(_: RenderArgs) {
  const msgIds = parseMsgs(searchParam("msgs"))
  return (
    <div data-testid="chat-list" className="min-h-30 flex-1 overflow-y-auto px-3 py-2">
      {msgIds.length === 0 ? (
        <div data-testid="chat-empty" className="text-xs italic text-muted-foreground">
          No messages. Click "stream next note" to start.
        </div>
      ) : (
        msgIds.map((fileId) => {
          const idx = AVAILABLE_FILES.indexOf(fileId)
          if (idx < 0) return null
          const Spec = MessagePartials[idx]
          return <Spec key={fileId} />
        })
      )}
    </div>
  )
})

export const ChatOverlayPartial = parton(function ChatOverlayRender(_: RenderArgs) {
  const msgIds = parseMsgs(searchParam("msgs"))
  const open = searchParam("chat") === "open"
  const nextHref = computeNextHref(msgIds)
  if (!open) return <ChatOpenPill />
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
      <ChatListPartial />
      <footer className="border-t px-3 py-2">
        <NewMessageLink nextHref={nextHref} />
      </footer>
    </aside>
  )
})

export function ChatOverlay() {
  return (
    <Frame name="chat-overlay">
      <ChatOverlayPartial />
    </Frame>
  )
}
