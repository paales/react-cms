import "./styles.css"
// Side-effect import — block specs self-register at module load.
import "./blocks/catalog.ts"
import {
  NotFoundError,
  PartialRoot,
  ROOT,
  Redirect,
  RedirectError,
  setFrameworkControl,
} from "@parton/framework"
import { AppNav } from "./components/app-nav.tsx"
import { ChatOverlay } from "./chat/chat-overlay.tsx"
import { NotFoundPage } from "./pages/not-found.tsx"
import { EditorShell } from "@parton/cms"

import { PokemonOverviewPage } from "./pages/pokemon.tsx"
import { PokemonDetailPage } from "./pages/pokemon-detail.tsx"
import { CacheDemoPage } from "./pages/cache-demo.tsx"
import { CacheStreamingDemoPage } from "./pages/cache-streaming-demo.tsx"
import { RemoteFrameDemoPage } from "./pages/remote-frame-demo.tsx"
import { RemoteFrameCrossOriginDemoPage } from "./pages/remote-frame-crossorigin-demo.tsx"
import { CmsDemoPage } from "./pages/cms-demo.tsx"
import { DeferDemoPage } from "./pages/defer-demo.tsx"
import { SelectorDemoPage } from "./pages/selector-demo.tsx"
import { SentinelsDemoPage, NotFoundDemoPage, RedirectDemoPage } from "./pages/sentinels-demo.tsx"
import { StreamingDemoPage } from "./pages/streaming-demo.tsx"
import { DeferredDemoPage } from "./pages/deferred-demo.tsx"
import { CursorsPage } from "./pages/cursors.tsx"
import { FormsDemoPage } from "./pages/forms-demo.tsx"
import { FramesDemoPage } from "./pages/frames-demo.tsx"
import { BarePage } from "./pages/bare-stream.tsx"
import { ChatNotesPage } from "./pages/chat-notes.tsx"
import { MagentoPage } from "./pages/magento/product-list.tsx"
import { MagentoCartPage } from "./pages/magento/cart-page.tsx"
import { NotFoundFallback } from "./pages/not-found-fallback.tsx"
import {
  InspectBasePage,
  InspectDrawer1,
  InspectDrawer2,
  InspectDrawer3,
} from "./pages/inspect-stack.tsx"

export function Root() {
  try {
    return (
      <PartialRoot>
        <html lang="en" className="light">
          <head>
            <meta charSet="UTF-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1.0" />
            <title>React Partials</title>
          </head>
          <body className="min-h-screen bg-background text-foreground antialiased">
            {/* Site content lives in a centered, max-width column. */}
            <div className="mx-auto min-h-screen max-w-225 p-8" data-testid="page-shell">
              <AppNav />
              <PokemonOverviewPage parent={ROOT} />
              <PokemonDetailPage parent={ROOT} />
              <CacheDemoPage parent={ROOT} />
              <CacheStreamingDemoPage parent={ROOT} />
              <RemoteFrameDemoPage parent={ROOT} />
              <RemoteFrameCrossOriginDemoPage parent={ROOT} />
              <CmsDemoPage parent={ROOT} />
              <DeferDemoPage parent={ROOT} />
              <SelectorDemoPage parent={ROOT} />
              <SentinelsDemoPage parent={ROOT} />
              <NotFoundDemoPage parent={ROOT} />
              <RedirectDemoPage parent={ROOT} />
              <StreamingDemoPage parent={ROOT} />
              <DeferredDemoPage parent={ROOT} />
              <CursorsPage parent={ROOT} />
              <FormsDemoPage parent={ROOT} />
              <FramesDemoPage parent={ROOT} />
              <BarePage parent={ROOT} />
              <ChatNotesPage parent={ROOT} />
              <MagentoPage parent={ROOT} />
              <MagentoCartPage parent={ROOT} />
              <InspectBasePage parent={ROOT} />
              <InspectDrawer1 parent={ROOT} />
              <InspectDrawer2 parent={ROOT} />
              <InspectDrawer3 parent={ROOT} />
              <NotFoundFallback parent={ROOT} />
            </div>
            <EditorShell parent={ROOT} />
            <ChatOverlay parent={ROOT} />
          </body>
        </html>
      </PartialRoot>
    )
  } catch (e) {
    if (e instanceof NotFoundError) {
      setFrameworkControl({ notFound: true })
      return (
        <html lang="en" className="light">
          <body>
            <NotFoundPage />
          </body>
        </html>
      )
    }
    if (e instanceof RedirectError) {
      setFrameworkControl({ redirect: { url: e.url, status: e.status } })
      return (
        <html lang="en" className="light">
          <body>
            <Redirect url={e.url} />
          </body>
        </html>
      )
    }
    throw e
  }
}
