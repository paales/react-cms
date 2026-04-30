import { createFromReadableStream } from "@vitejs/plugin-rsc/ssr"
import React from "react"
import type { ReactFormState } from "react-dom/client"
import { renderToReadableStream } from "react-dom/server.edge"
import { injectRSCPayload } from "rsc-html-stream/server"
import type { RscPayload } from "./entry.rsc"

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
      onError: silenceClientDisconnect,
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
        onError: silenceClientDisconnect,
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

// Mirrors entry.rsc.tsx — swallow client-disconnect noise and framework
// sentinels. srvx cancels the reader with no argument on disconnect; the
// upstream signal aborts surface as AbortError. `notFound()` / `redirect()`
// also throw through here when surfaced via deep-async Flight chunks, but
// the framework-control channel already routed the response, so the stack
// trace is just noise.
function silenceClientDisconnect(error: unknown): string | undefined {
  if (error instanceof Error) {
    if (
      error.name === "AbortError" ||
      error.name === "NotFoundError" ||
      error.name === "RedirectError" ||
      error.message === "The render was aborted by the server without a reason."
    ) {
      return undefined
    }
  }
  console.error(error)
  return undefined
}
