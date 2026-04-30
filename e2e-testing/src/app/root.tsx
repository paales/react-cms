import "./styles.css"
// Side-effect import — block specs self-register at module load.
import "./blocks/catalog.ts"
import { PartialRoot, ROOT } from "@react-cms/framework"
import { NotFoundError, RedirectError } from "@react-cms/framework/framework/errors.ts"
import { setFrameworkControl } from "@react-cms/framework/framework/context.ts"
import { Redirect } from "@react-cms/framework/framework/redirect-client.tsx"
import { PartialsDebug } from "@react-cms/framework/lib/partial-debug.tsx"
import { AppNav } from "./components/app-nav.tsx"
import { ChatOverlay } from "./chat/chat-overlay.tsx"
import { NotFoundPage } from "./pages/not-found.tsx"
import { EditorShell } from "@react-cms/cms"

import { PokemonOverviewPage } from "./pages/pokemon.tsx"
import { PokemonDetailPage } from "./pages/pokemon-detail.tsx"
import { CacheDemoPage } from "./pages/cache-demo.tsx"
import { CmsDemoPage } from "./pages/cms-demo.tsx"
import { DeferDemoPage } from "./pages/defer-demo.tsx"
import { SelectorDemoPage } from "./pages/selector-demo.tsx"
import { SentinelsDemoPage, NotFoundDemoPage, RedirectDemoPage } from "./pages/sentinels-demo.tsx"
import { FramesDemoPage } from "./pages/frames-demo.tsx"
import { BarePage } from "./pages/bare-stream.tsx"
import { ChatNotesPage } from "./pages/chat-notes.tsx"
import { MagentoPage } from "./pages/magento/product-list.tsx"
import { NotFoundFallback } from "./pages/not-found-fallback.tsx"

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
            <EditorShell parent={ROOT}>
              <AppNav />
              <PokemonOverviewPage parent={ROOT} />
              <PokemonDetailPage parent={ROOT} />
              <CacheDemoPage parent={ROOT} />
              <CmsDemoPage parent={ROOT} />
              <DeferDemoPage parent={ROOT} />
              <SelectorDemoPage parent={ROOT} />
              <SentinelsDemoPage parent={ROOT} />
              <NotFoundDemoPage parent={ROOT} />
              <RedirectDemoPage parent={ROOT} />
              <FramesDemoPage parent={ROOT} />
              <BarePage parent={ROOT} />
              <ChatNotesPage parent={ROOT} />
              <MagentoPage parent={ROOT} />
              <NotFoundFallback parent={ROOT} />{" "}
            </EditorShell>
            <ChatOverlay parent={ROOT} />
            {import.meta.env.DEV && <PartialsDebug />}
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
