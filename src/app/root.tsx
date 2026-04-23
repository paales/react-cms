import "./styles.css";
import type { ReactNode } from "react";
import { PokemonPage } from "./pages/pokemon.tsx";
import { MagentoPage } from "./pages/magento/product-list.tsx";
import { BarePage } from "./pages/bare-stream.tsx";
import { CacheDemoPage } from "./pages/cache-demo.tsx";
import { DeferDemoPage } from "./pages/defer-demo.tsx";
import { SelectorDemoPage } from "./pages/selector-demo.tsx";
import { SentinelsDemoPage } from "./pages/sentinels-demo.tsx";
import { FramesDemoPage } from "./pages/frames-demo.tsx";
import { ChatNotesPage, chatOverlayFrameUrl } from "./pages/chat-notes.tsx";
import { NotFoundPage } from "./pages/not-found.tsx";
import { PartialRoot, Partial } from "../lib/partial.tsx";
import { ROOT } from "../lib/partial-context.ts";
import { matchPath, pickRoute } from "../framework/router.ts";
import {
  NotFoundError,
  RedirectError,
  notFound,
  redirect,
} from "../framework/errors.ts";
import { setFrameworkControl } from "../framework/context.ts";
import { Redirect } from "../framework/redirect-client.tsx";
import { DebugToolbar } from "./components/debug-toolbar.tsx";
import { AppNav } from "./components/app-nav.tsx";
import { ChatOverlay } from "./chat/chat-overlay.tsx";
import { TooltipProvider } from "@/components/ui/tooltip";

export function Root() {
  try {
    return (
      <PartialRoot>
        <html lang="en" className="dark">
          <Partial parent={ROOT} selector="#head">
            <head>
              <meta charSet="UTF-8" />
              <meta
                name="viewport"
                content="width=device-width, initial-scale=1.0"
              />
              <title>React Partials</title>
            </head>
          </Partial>
          <body className="mx-auto min-h-screen max-w-225 bg-background p-8 text-foreground antialiased">
            <AppNav />
            {pickRoute([
              ["/bare", BarePage],
              ["/cache-demo", () => <CacheDemoPage />],
              ["/defer-demo", DeferDemoPage],
              ["/selector-demo", SelectorDemoPage],
              ["/sentinels-demo", SentinelsDemoPage],
              ["/frames-demo", FramesDemoPage],
              ["/chat-notes", ChatNotesPage],
              ["/not-found-demo", () => notFound()],
              ["/redirect-demo", () => redirect("/cache-demo")],
              ["/magento", MagentoPage],
              ["/magento/*", MagentoPage],
              ["/*", PokemonPage],
            ])}
            <ChatOverlay
              defaultOpen={matchPath("/chat-notes") != null}
              frameUrl={
                matchPath("/chat-notes") != null
                  ? chatOverlayFrameUrl()
                  : undefined
              }
            />
          </body>
        </html>
      </PartialRoot>
    );
  } catch (e) {
    if (e instanceof NotFoundError) {
      setFrameworkControl({ notFound: true });
      return (
        <html lang="en" className="light">
          <body>
            <NotFoundPage />
          </body>
        </html>
      );
    }
    if (e instanceof RedirectError) {
      setFrameworkControl({ redirect: { url: e.url, status: e.status } });
      // HTML path: the entry handler catches this via the control
      // channel after `renderHTML` awaits and returns a 302 + Location
      // header before this component mounts on the client.
      // RSC-refetch path: the stream includes `<Redirect>`, client
      // commits, its useEffect fires `navigation.navigate(url)`.
      return (
        <html lang="en" className="light">
          <body>
            <Redirect url={e.url} />
          </body>
        </html>
      );
    }
    throw e;
  }
}
