import "./styles.css";
// Side-effect import — binds block types to components so slots
// (`<Children>` / `<Child>`) can resolve entries in the CMS store.
import "./blocks/catalog.ts";
import type { ReactNode } from "react";
import { PokemonPage } from "./pages/pokemon.tsx";
import { MagentoPage } from "./pages/magento/product-list.tsx";
import { BarePage } from "./pages/bare-stream.tsx";
import { CacheDemoPage } from "./pages/cache-demo.tsx";
import { DeferDemoPage } from "./pages/defer-demo.tsx";
import { SelectorDemoPage } from "./pages/selector-demo.tsx";
import { SentinelsDemoPage } from "./pages/sentinels-demo.tsx";
import { FramesDemoPage } from "./pages/frames-demo.tsx";
import { CmsDemoPage } from "./pages/cms-demo.tsx";
import { CmsEditPage } from "./pages/cms-edit.tsx";
import { NotFoundPage } from "./pages/not-found.tsx";
import { PartialRoot, Partial } from "../lib/partial.tsx";
import { ROOT } from "../lib/partial-context.ts";
import { pickRoute } from "../framework/router.ts";
import {
  NotFoundError,
  RedirectError,
  notFound,
  redirect,
} from "../framework/errors.ts";
import { setFrameworkControl } from "../framework/context.ts";
import { Redirect } from "../framework/redirect-client.tsx";
import { PartialsDebug } from "../lib/partial-debug.tsx";
import { AppNav } from "./components/app-nav.tsx";
import { ChatOverlay } from "./chat/chat-overlay.tsx";
import { TooltipProvider } from "@/components/ui/tooltip";

export function Root() {
  try {
    return (
      <PartialRoot>
        <html lang="en" className="light">
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
              ["/cms-demo", CmsDemoPage],
              ["/cms-demo/:slug", CmsDemoPage],
              ["/cms-edit", CmsEditPage],
              ["/not-found-demo", () => notFound()],
              ["/redirect-demo", () => redirect("/cache-demo")],
              ["/magento", MagentoPage],
              ["/magento/*", MagentoPage],
              ["/*", PokemonPage],
            ])}
            <ChatOverlay />
            {import.meta.env.DEV && <PartialsDebug />}
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
