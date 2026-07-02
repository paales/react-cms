/**
 * Chat overlay — streaming notes demo.
 *
 * Frame-scoped (`frame="chat-overlay"`) so the open/close state lives
 * separately from the page URL. Each message in `?msgs=…` becomes a
 * pre-built per-fileId message spec; the slot lookup wraps `ChatMessage`
 * once per id.
 */

import { park, parton, searchParam, type PartialCtx, type RenderArgs } from "@parton/framework"
import { Frame } from "@parton/framework/lib/frame.tsx"
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
// whether its fileId is in the `?msgs=` list. The cursor used to live
// in the URL (carrying the ResumeTail compaction handoff); it's
// gone now — `ChatMessage` reads the log's state directly and a
// Suspense sentinel keeps the connection live until the producer
// signals done. `refreshSelector(chat-msg-${fileId})` from
// `log.ts::appendChunk` is what wakes the segment driver.
const MessagePartials = AVAILABLE_FILES.map((fileId) =>
  parton(
    function MessageRender() {
      return <ChatMessage fileId={fileId} />
    },
    {
      selector: `#chat-msg-${fileId}`,
      schema: () => {
        const msgs = parseMsgs(searchParam("msgs"))
        if (!msgs.includes(fileId)) park()
        return {}
      },
    },
  ),
)

export const ChatListPartial = parton(
  function ChatListRender({ msgIds }: { msgIds: string[] } & RenderArgs) {
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
  },
  {
    selector: "#chat-list",
    schema: () => ({ msgIds: parseMsgs(searchParam("msgs")) }),
  },
)

export const ChatOverlayPartial = parton(
  function ChatOverlayRender({
    open,
    nextHref,
  }: {
    open: boolean
    nextHref: string | null
  } & RenderArgs) {
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
  },
  {
    selector: "#chat-overlay",
    schema: () => {
      const msgIds = parseMsgs(searchParam("msgs"))
      return { open: searchParam("chat") === "open", nextHref: computeNextHref(msgIds) }
    },
  },
)

export function ChatOverlay() {
  return (
    <Frame name="chat-overlay">
      <ChatOverlayPartial />
    </Frame>
  )
}
