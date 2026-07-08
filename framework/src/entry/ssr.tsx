/**
 * SSR HTML renderer — the middle tier of a parton app's entry surface.
 * An app's `src/entry.ssr.tsx` is a single re-export:
 *
 *     export { renderHTML } from "@parton/framework/entry/ssr.tsx"
 *
 * The rsc handler reaches this module through the app's thin entry via
 * `import.meta.viteRsc.loadModule("ssr", "index")` (see
 * `./rsc.tsx`). `loadBootstrapScriptContent("index")` below is the
 * same kind of compile-time transform: it inlines the bootstrap for
 * the APP's client entry — the `client` environment's
 * `build.rollupOptions.input.index` (canonically
 * `./src/entry.browser.tsx`).
 */
import { createFromReadableStream } from "@vitejs/plugin-rsc/ssr"
import React from "react"
import type { ReactFormState } from "react-dom/client"
import { renderToReadableStream } from "react-dom/server.edge"
import { injectRSCPayload } from "rsc-html-stream/server"
import { reportServerRenderError } from "../runtime/errors.ts"
import type { RscPayload } from "./rsc.tsx"

export async function renderHTML(
  rscStream: ReadableStream<Uint8Array>,
  options: {
    formState?: ReactFormState
    nonce?: string
    debugNojs?: boolean
  },
): Promise<{ stream: ReadableStream<Uint8Array>; status?: number }> {
  const [rscStream1, rscStream2] = rscStream.tee()

  let payload: Promise<RscPayload> | undefined
  function SsrRoot() {
    payload ??= createFromReadableStream<RscPayload>(rscStream1)
    return React.use(payload).root
  }

  const bootstrapScriptContent = await import.meta.viteRsc.loadBootstrapScriptContent("index")

  let htmlStream: ReadableStream<Uint8Array>
  let status: number | undefined
  try {
    htmlStream = await renderToReadableStream(<SsrRoot />, {
      bootstrapScriptContent: options?.debugNojs ? undefined : bootstrapScriptContent,
      nonce: options?.nonce,
      formState: options?.formState,
      onError: onSsrRenderError,
    })
  } catch {
    status = 500
    htmlStream = await renderToReadableStream(
      <html lang="en">
        <body>
          <noscript>Internal Server Error: SSR failed</noscript>
        </body>
      </html>,
      {
        bootstrapScriptContent: `self.__NO_HYDRATE=1;${options?.debugNojs ? "" : bootstrapScriptContent}`,
        nonce: options?.nonce,
        onError: onSsrRenderError,
      },
    )
  }

  let responseStream: ReadableStream<Uint8Array> = htmlStream
  if (!options?.debugNojs) {
    responseStream = responseStream.pipeThrough(
      injectRSCPayload(rscStream2, { nonce: options?.nonce }),
    )
  }

  return { stream: responseStream, status }
}

// Mirrors entry/rsc.tsx. Production strips the message off an SSR render
// error and ships only a digest to the client; `reportServerRenderError`
// mints that digest, logs it with the real stack server-side, and
// returns it for React to serialize — so the client digest traces back
// to a server log line. Expected signals return undefined (no log, no
// digest): srvx cancels the reader on disconnect (AbortError), and
// `notFound()` / `redirect()` route via the framework-control channel,
// so their stacks are just noise here.
function onSsrRenderError(error: unknown): string | undefined {
  return reportServerRenderError("ssr", error)
}
