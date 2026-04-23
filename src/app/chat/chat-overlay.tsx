import { Partial } from "../../lib/partial.tsx";
import { ROOT, capturePartialContext } from "../../lib/partial-context.ts";
import { getSearchParam } from "../../framework/context.ts";
import { ChatMessage } from "./piece.tsx";
import {
  AutoScrollToBottom,
  ChatClosePill,
  ChatOpenPill,
  NewMessageLink,
  ResetChatButton,
} from "./chat-controls.tsx";

/**
 * Ordered pool of notes files streamable into the chat.
 */
export const AVAILABLE_FILES = [
  "AA_CHAT_STREAMING",
  "README",
  "STREAMING_CHAT",
  "PARTIAL_ARCHITECTURE",
  "SELECTOR_API",
  "NAVIGATE_UNIFIED",
  "AUTO_TRACKED_CACHE_KEYS",
  "DYNAMIC_PARTIAL_REGISTRY",
  "DEFER_ACTIVATORS",
  "SERVER_ISOLATION",
  "FRAME_SCOPING",
  "FRAMES",
  "CACHE_SCOPING",
  "IDEAS",
];

const DEFAULT_MSG = "AA_CHAT_STREAMING";

function parseMsgs(param: string | null): string[] {
  if (param == null) return [DEFAULT_MSG];
  return param
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s && AVAILABLE_FILES.includes(s));
}

function computeNextHref(msgIds: string[]): string | null {
  const next = AVAILABLE_FILES.find((f) => !msgIds.includes(f));
  if (!next) return null;
  const params = new URLSearchParams();
  params.set("msgs", [...msgIds, next].join(","));
  params.set("chat", "open");
  return `?${params.toString()}`;
}

/**
 * Global chat overlay. Mounted inside every page's layout.
 *
 * `defaultOpen` seeds the open/closed state the first time the overlay
 * renders on a route (before the user clicks the pill). `/chat-notes`
 * passes `true` so the overlay greets the visitor expanded; every
 * other page passes `false` so only the pill shows.
 *
 * `frameUrl` seeds the frame's URL on its first render. `/chat-notes`
 * projects its window URL's `?msgs=` and `?chat=` onto the frame URL
 * (via `chatOverlayFrameUrl()`) so deep links like
 * `/chat-notes?msgs=README` still drive the stream on initial load
 * and in e2e tests — even though the overlay itself lives outside the
 * page URL on every other route.
 */
export function ChatOverlay({
  defaultOpen = false,
  frameUrl,
}: {
  defaultOpen?: boolean;
  frameUrl?: string;
}) {
  return (
    <Partial
      parent={ROOT}
      selector="#chat-overlay"
      frame="chat-overlay"
      frameUrl={frameUrl}
    >
      <ChatOverlayBody defaultOpen={defaultOpen} />
    </Partial>
  );
}

function ChatOverlayBody({ defaultOpen }: { defaultOpen: boolean }) {
  const parent = capturePartialContext();
  const chatParam = getSearchParam("chat");
  const open = chatParam != null ? chatParam === "open" : defaultOpen;

  if (!open) return <ChatOpenPill />;

  const msgsParam = getSearchParam("msgs");
  const msgIds = parseMsgs(msgsParam);
  const nextHref = computeNextHref(msgIds);

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
        <div
          data-testid="chat-list"
          className="min-h-30 flex-1 overflow-y-auto px-3 py-2"
        >
          {msgIds.length === 0 ? (
            <div
              data-testid="chat-empty"
              className="text-xs italic text-muted-foreground"
            >
              No messages. Click “stream next note” to start.
            </div>
          ) : (
            msgIds.map((fileId) => (
              <Partial
                parent={parent}
                key={`chat-msg-${fileId}`}
                selector={`#chat-msg-${fileId}`}
              >
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
  );
}
