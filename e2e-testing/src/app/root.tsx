import "./styles.css"
// Side-effect import — block specs self-register at module load.
import "./blocks/catalog.ts"
import { PartialRoot } from "@parton/framework"
import { AppNav } from "./components/app-nav.tsx"
import { ChatOverlay } from "./chat/chat-overlay.tsx"
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
import { LanesDemoPage } from "./pages/lanes-demo.tsx"
import { DeferredDemoPage } from "./pages/deferred-demo.tsx"
import { CursorsPage } from "./pages/cursors.tsx"
import { FormsDemoPage } from "./pages/forms-demo.tsx"
import { FramesDemoPage } from "./pages/frames-demo.tsx"
import { ChatNotesPage } from "./pages/chat-notes.tsx"
import { DocsPage } from "./pages/docs.tsx"
import { MagentoPage } from "./pages/magento/product-list.tsx"
import { ProductBrowsePage } from "./pages/magento/product-browse.tsx"
import { MagentoCartPage } from "./pages/magento/cart-page.tsx"
import { NotFoundFallback } from "./pages/not-found-fallback.tsx"
import {
  InspectBasePage,
  InspectDrawer1,
  InspectDrawer2,
  InspectDrawer3,
} from "./pages/inspect-stack.tsx"

export function Root() {
  // notFound() / redirect() set the framework control channel eagerly (before
  // throwing) and entry.rsc reads it after render — so this server component
  // never has to catch sentinels itself; it just declares the tree.
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
            <PokemonOverviewPage />
            <PokemonDetailPage />
            <CacheDemoPage />
            <CacheStreamingDemoPage />
            <RemoteFrameDemoPage />
            <RemoteFrameCrossOriginDemoPage />
            <CmsDemoPage />
            <DeferDemoPage />
            <SelectorDemoPage />
            <SentinelsDemoPage />
            <NotFoundDemoPage />
            <RedirectDemoPage />
            <StreamingDemoPage />
            <LanesDemoPage />
            <DeferredDemoPage />
            <CursorsPage />
            <FormsDemoPage />
            <FramesDemoPage />
            <ChatNotesPage />
            <DocsPage />
            <MagentoPage />
            <ProductBrowsePage />
            <MagentoCartPage />
            <InspectBasePage />
            <InspectDrawer1 />
            <InspectDrawer2 />
            <InspectDrawer3 />
            <NotFoundFallback />
          </div>
          <EditorShell />
          <ChatOverlay />
        </body>
      </html>
    </PartialRoot>
  )
}
