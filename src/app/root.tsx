import "./styles.css"
// Side-effect import — binds block types to components so slots
// (`<Children>` / `<Child>`) can resolve entries in the CMS store.
import "./blocks/catalog.ts"
import { PokemonPage } from "./pages/pokemon.tsx"
import { MagentoPage } from "./pages/magento/product-list.tsx"
import { BarePage } from "./pages/bare-stream.tsx"
import { CacheDemoPage } from "./pages/cache-demo.tsx"
import { DeferDemoPage } from "./pages/defer-demo.tsx"
import { SelectorDemoPage } from "./pages/selector-demo.tsx"
import { SentinelsDemoPage } from "./pages/sentinels-demo.tsx"
import { FramesDemoPage } from "./pages/frames-demo.tsx"
import { CmsDemoPage } from "./pages/cms-demo.tsx"
import { NotFoundPage } from "./pages/not-found.tsx"
import { EditorShell } from "../editor/shell.tsx"
import { PartialRoot, Partial } from "../lib/partial.tsx"
import { ROOT } from "../lib/partial-context.ts"
import { pickRoute } from "../framework/router.ts"
import { NotFoundError, RedirectError, notFound, redirect } from "../framework/errors.ts"
import { getRequest, setCookie, setFrameworkControl } from "../framework/context.ts"
import { EDITOR_COOKIE, isEditorRequest } from "../framework/cms-runtime.ts"
import { Redirect } from "../framework/redirect-client.tsx"
import { PartialsDebug } from "../lib/partial-debug.tsx"
import { AppNav } from "./components/app-nav.tsx"
import { ChatOverlay } from "./chat/chat-overlay.tsx"

function pickRoutedPage() {
  return pickRoute([
    ["/bare", BarePage],
    ["/cache-demo", () => <CacheDemoPage />],
    ["/defer-demo", DeferDemoPage],
    ["/selector-demo", SelectorDemoPage],
    ["/sentinels-demo", SentinelsDemoPage],
    ["/frames-demo", FramesDemoPage],
    ["/cms-demo", CmsDemoPage],
    ["/cms-demo/:slug", CmsDemoPage],
    ["/not-found-demo", () => notFound()],
    ["/redirect-demo", () => redirect("/cache-demo")],
    ["/magento", MagentoPage],
    ["/magento/*", MagentoPage],
    ["/*", PokemonPage],
  ])
}

/**
 * Component-form of `pickRoutedPage` used inside the editor's preview
 * Partial. The component reference (rather than a function call's
 * return value) is what gets baked into the Partial's snapshot, so a
 * cache-mode refetch — e.g. LoadMore's `?pages=2` frame nav on the
 * Pokemon homepage — re-invokes `pickRoute` against the current
 * request and re-renders the page handler with the new URL. Without
 * this indirection, the snapshot freezes the output of the handler
 * computed at the original render time.
 *
 * `notFound()` / `redirect()` thrown from inside this component
 * propagate via the framework control channel (set in the throwers
 * before they throw), not via Root's try/catch — the entry handler
 * reads `getFrameworkControl()` post-render and emits the correct
 * 302 / 404 / `<Redirect>` payload regardless of where the throw
 * was caught.
 */
export function RouteSwitch() {
  return pickRoutedPage()
}

/**
 * Persist the editor toggle as a cookie so a one-shot `?editor=1` /
 * `?editor=0` URL keeps editor mode on (or off) across subsequent
 * requests without polluting every URL with the flag. Visitors who
 * never visit `?editor=1` carry no cookie and pay no editor cost —
 * the toggle is opt-in and sticky.
 *
 * Mutates response cookies (via `setCookie`) only when the URL flag
 * disagrees with the current cookie state — avoids a fresh
 * Set-Cookie header on every request.
 */
function syncEditorCookie(): void {
  const url = new URL(getRequest().url)
  const flag = url.searchParams.get("editor")
  if (flag === "1") {
    setCookie(EDITOR_COOKIE, "1")
  } else if (flag === "0") {
    setCookie(EDITOR_COOKIE, "", 0)
  }
}

export function Root() {
  try {
    syncEditorCookie()
    const editorOn = isEditorRequest(getRequest())
    return (
      <PartialRoot>
        <html lang="en" className="light">
          <Partial parent={ROOT} selector="#head">
            <head>
              <meta charSet="UTF-8" />
              <meta name="viewport" content="width=device-width, initial-scale=1.0" />
              <title>React Partials</title>
            </head>
          </Partial>
          {/* Editor mode bleeds full-width for the three-pane layout;
              app pages keep the 900px reading column. */}
          <body
            className={
              editorOn
                ? "min-h-screen bg-background text-foreground antialiased"
                : "mx-auto min-h-screen max-w-225 bg-background p-8 text-foreground antialiased"
            }
          >
            {/* The previewed site is identical in both modes — editor
                mode just wraps it in a three-pane shell. AppNav lives
                INSIDE the preview so the editor renders a faithful
                copy of the site (top-level nav included), not a
                stripped-down version.

                Editor mode renders `<RouteSwitch />` (a component) so
                React re-invokes the route handler on cache-mode
                refetches; non-editor inlines the function call so
                synchronous `notFound()` / `redirect()` throws bubble
                directly to Root's try/catch. */}
            {editorOn ? (
              <EditorShell>
                <AppNav />
                <RouteSwitch />
              </EditorShell>
            ) : (
              <>
                <AppNav />
                {pickRoutedPage()}
              </>
            )}
            <ChatOverlay />
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
      )
    }
    throw e
  }
}
