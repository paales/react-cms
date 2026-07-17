/**
 * Browser bootstrap — the hydration shell of a parton app's entry
 * surface. An app's `src/entry.browser.tsx` is two lines:
 *
 *     import { bootBrowser } from "@parton/framework/entry/browser.tsx"
 *     bootBrowser()
 *
 * `bootBrowser` hydrates the SSR document from the inlined Flight stream
 * and renders it — nothing more. The interactive LIVE LAYER (the channel
 * transport, the attach stream, the Navigation API intercept, the
 * server-action callback, the heartbeat — ~24 KiB) is NOT in this
 * chunk: `BrowserRoot` dynamically imports `./live-boot.tsx` from a
 * post-commit `useEffect` and installs it once. First paint hydrates
 * against the initial chunk alone; everything interactive rides the
 * channel the moment the live layer lands (a few ms after commit,
 * before any user click).
 *
 * A live-layer load failure degrades to plain document navigations —
 * the page stays functional, never a broken paint.
 */
import { createFromReadableStream } from "@vitejs/plugin-rsc/browser"
import React from "react"
import { createRoot, hydrateRoot } from "react-dom/client"
import { rscStream } from "rsc-html-stream/client"
import { _applyFpTrailerFromDocument } from "../lib/partial-client.tsx"
import { GlobalErrorBoundary, NavigationErrorBoundary } from "../runtime/error-boundary.tsx"
import type { LiveHost } from "./live-boot.tsx"
import type { RscPayload } from "./rsc.tsx"

// Dev only: pre-warm the live-layer import at boot so its module graph
// is loading well before `BrowserRoot`'s post-commit effect installs it
// — the channel establishes promptly, keeping dev HMR's establishment
// timing tight. Stripped from prod (`import.meta.env.DEV` is statically
// false); the `import()` specifier matches the effect's, so it's the
// SAME lazy chunk either way.
//
// The `rsc:update` HMR event is caught HERE, in the always-loaded
// initial chunk — an edit can land before the live layer's (larger,
// multi-fetch) module graph finishes loading in dev, and this catcher
// defers to `handleRscUpdate` only AFTER awaiting the import, so no dev
// edit is lost to the boot window.
if (import.meta.env.DEV) {
  void import("./live-boot.tsx")
  if (import.meta.hot) {
    import.meta.hot.on("rsc:update", () => {
      void import("./live-boot.tsx").then((m) => m.handleRscUpdate())
    })
  }
}

export function bootBrowser(): void {
  void main()
}

async function main() {
  // The live layer's hooks into React's committed tree, assigned by
  // `BrowserRoot`'s first effect and read (through the wrappers passed
  // to `installLiveLayer`) once the live layer lands.
  let setPayload: (v: RscPayload) => void
  let setPayloadRaw: (v: RscPayload) => void

  // Pending view-transition types — set synchronously by the navigate-
  // event handler when the navigation direction is known (push/forward
  // → "forward"; traverse-back → "back"), consumed by `setPayload` on
  // the very next commit. Keyed by no token because navigations on the
  // window are serialised — the next commit IS this navigation. Reset
  // even on no-types calls so a previous nav's type doesn't leak.
  let _pendingTransitionTypes: string[] = []
  function setPendingTransitionTypes(types: string[]) {
    _pendingTransitionTypes = types
  }

  const initialPayload = await createFromReadableStream<RscPayload>(rscStream)

  // The SSR HTML response carries the fp-trailer as an HTML comment
  // appended after `</html>` (see `wrapSsrStreamWithFpTrailer` in the
  // framework). Parse it now so the warm fps the server computed during
  // this cold render are registered before the heartbeat's attach
  // presents the manifest. Without this, the attach carries only cold
  // fps and every parton whose cold fp drifted from warm re-renders on
  // the first connection.
  _applyFpTrailerFromDocument()

  function BrowserRoot() {
    const [payload, setPayload_] = React.useState(initialPayload)

    React.useEffect(() => {
      setPayload = (v) =>
        React.startTransition(() => {
          // Drain pending types into THIS transition so any
          // `<ViewTransition>` in the tree fires `document.startViewTransition`
          // with `types: [...]` matching the navigation direction.
          const types = _pendingTransitionTypes
          _pendingTransitionTypes = []
          for (const t of types) React.addTransitionType(t)
          setPayload_(v)
        })
      setPayloadRaw = setPayload_
    }, [setPayload_])

    React.useEffect(() => {
      // Install the live layer post-commit. This effect is on the tree
      // root (`BrowserRoot`), so it runs after every child's — hydration
      // handlers are attached by the time the install's navigate
      // intercept goes live. The host wrappers defer to the setters
      // assigned by the effect above (which ran first).
      const host: LiveHost = {
        setPayload: (v) => setPayload(v),
        setPayloadRaw: (v) => setPayloadRaw(v),
        setPendingTransitionTypes,
      }
      let disposed = false
      let teardown: (() => void) | undefined
      import("./live-boot.tsx")
        .then((mod) => {
          if (disposed) return
          teardown = mod.installLiveLayer(host)
        })
        .catch((err) => {
          // The live layer failed to load — the page stays a functional
          // plain-document site (links are document navigations). Never a
          // broken paint.
          console.error(err)
        })
      return () => {
        disposed = true
        teardown?.()
      }
    }, [])

    // Recover from torn RSC streams when a navigation supersedes an
    // in-flight one (the payload is rendered HERE, so a recovery
    // remounts the payload — not BrowserRoot, whose state + the live
    // layer's install effect must survive). Genuine errors still bubble
    // to the outer <GlobalErrorBoundary>.
    return <NavigationErrorBoundary>{payload.root}</NavigationErrorBoundary>
  }

  const browserRoot = (
    <React.StrictMode>
      <GlobalErrorBoundary>
        <BrowserRoot />
      </GlobalErrorBoundary>
    </React.StrictMode>
  )

  if ("__NO_HYDRATE" in globalThis) {
    createRoot(document).render(browserRoot)
  } else {
    hydrateRoot(document, browserRoot, {
      formState: initialPayload.formState,
      onRecoverableError: silenceTornStream,
    })
  }
}

// When a client-initiated navigation (or the in-flight refetch for the
// initial page) gets cancelled mid-stream — user clicks away, newer
// navigation supersedes — React sees a Suspense boundary that never
// finished and logs "The server could not finish this Suspense boundary"
// through onRecoverableError. Expected; swallow it. Any other recoverable
// error still surfaces.
function silenceTornStream(error: unknown): void {
  if (
    error instanceof Error &&
    (error.message.includes("The server could not finish this Suspense boundary") ||
      error.name === "AbortError")
  ) {
    return
  }
  console.error(error)
}
