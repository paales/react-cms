/**
 * Chat overlay — streaming notes demo.
 *
 * Frame-scoped (`frame="chat-overlay"`) so the open/close state lives
 * separately from the page URL. Each message in `?msgs=…` becomes a
 * pre-built per-fileId message spec; the slot lookup wraps `ChatMessage`
 * once per id.
 */

import { ReactCms, type PartialCtx, type RenderArgs } from "@react-cms/framework"
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
// whether its fileId is in the `?msgs=` list.
const MessagePartials = AVAILABLE_FILES.map((fileId) =>
  ReactCms.partial(
    function MessageRender({ cursor }: { cursor: number } & RenderArgs) {
      return <ChatMessage fileId={fileId} cursor={cursor} />
    },
    {
      selector: `#chat-msg-${fileId}`,
      vary: ({ search }) => {
        const { msgs: msgsRaw = null } = search
        const msgs = parseMsgs(msgsRaw)
        if (!msgs.includes(fileId)) return null
        const cursor = Math.max(0, Number(search[`cursor-${fileId}`]) || 0)
        return { cursor }
      },
    },
  ),
)

export const ChatListPartial = ReactCms.partial(
  function ChatListRender({ msgIds, parent }: { msgIds: string[] } & RenderArgs) {
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
            return <Spec key={fileId} parent={parent} />
          })
        )}
      </div>
    )
  },
  {
    selector: "#chat-list",
    vary: ({ search: { msgs = null } }) => ({ msgIds: parseMsgs(msgs) }),
  },
)

export const ChatOverlayPartial = ReactCms.partial(
  function ChatOverlayRender({
    open,
    msgIds,
    nextHref,
    parent,
  }: {
    open: boolean
    msgIds: string[]
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
        <ChatListPartial parent={parent} />
        <footer className="border-t px-3 py-2">
          <NewMessageLink nextHref={nextHref} />
        </footer>
      </aside>
    )
  },
  {
    selector: "#chat-overlay",
    frame: "chat-overlay",
    vary: ({ search: { chat, msgs = null } }) => {
      const msgIds = parseMsgs(msgs)
      return { open: chat === "open", msgIds, nextHref: computeNextHref(msgIds) }
    },
  },
)

export function ChatOverlay({ parent }: { parent: PartialCtx }) {
  return <ChatOverlayPartial parent={parent} />
}
