/**
 * In-process RSC test helpers. Used by tests under `*.rsc.test.tsx`,
 * which run inside the dedicated Vitest project configured with the
 * `react-server` condition and `vitePluginRscMinimal` transforms
 * (see `vitest.rsc.config.ts`). Both `"use client"` and `"use
 * server"` modules are rewritten correctly; client references are
 * stamped with their module path and serialised through permissive
 * Proxy manifests defined below — tests inspecting the Flight
 * payload or the element tree work without shipping real chunks.
 *
 * Replaces the old subprocess dance in `flight-streaming-helper.cjs`:
 * we build a Flight stream from a real server tree inside the
 * Vitest worker itself, no dev server required.
 *
 * Shape is intentionally small and close to the Storybook
 * vitest-plugin-rsc surface, so we can swap in / out if it ever
 * stabilises upstream.
 */

import type { ReactNode } from "react"
import { runWithRequestAsync } from "../framework/context.ts"
// Import the vendored Flight server/client directly. Going through
// `@vitejs/plugin-rsc/react/rsc` or `/rsc` pulls in plugin runtime
// code that expects Vite's transform pipeline (`import.meta.env.DEV`,
// virtual module graph, etc.) — fine in the app, not fine in bare
// Vitest. The `server.edge` / `client.edge` bundles only need the
// `react-server` condition (set in `vitest.rsc.config.ts`).
import * as ReactServer from "@vitejs/plugin-rsc/vendor/react-server-dom/server.edge"
import * as ReactClient from "@vitejs/plugin-rsc/vendor/react-server-dom/client.edge"

// Permissive Proxy manifests — `@vitejs/plugin-rsc`'s `"use client"`
// transform stamps each client component with a module path like
// `/src/foo.tsx#Export`. The Flight runtime looks those up on both
// sides (server serialise, client hydrate) in shape-different
// manifests. We fabricate entries on demand so any id resolves.
// Tests inspect the encoded stream or assert element structure;
// they don't mount the client reference, so empty `chunks` are fine.
const CLIENT_MANIFEST = new Proxy({} as Record<string, unknown>, {
  get: (_t, id) => {
    if (typeof id !== "string") return undefined
    return { id, chunks: [], name: "*" }
  },
})
// Consumer side is nested: `config[modulePath][exportName]` or
// `config[modulePath]["*"]`. A Proxy-of-Proxies handles both paths.
const CONSUMER_MANIFEST = new Proxy({} as Record<string, unknown>, {
  get: (_t, id) => {
    if (typeof id !== "string") return undefined
    return new Proxy({} as Record<string, unknown>, {
      get: (_t2, name) => (typeof name === "string" ? { id, chunks: [], name } : undefined),
    })
  },
})
const SERVER_MANIFEST = {
  serverModuleMap: {},
  moduleMap: CONSUMER_MANIFEST,
}

function renderToReadableStream<T>(data: T): ReadableStream<Uint8Array> {
  return ReactServer.renderToReadableStream(data, CLIENT_MANIFEST)
}

function createFromReadableStream<T>(stream: ReadableStream<Uint8Array>): Promise<T> {
  return ReactClient.createFromReadableStream(stream, {
    serverConsumerManifest: SERVER_MANIFEST,
  })
}

export type FlightBytes = ReadableStream<Uint8Array>

/** Render a server tree to raw Flight bytes. Nothing is mounted. */
export function renderServerToFlight(node: ReactNode): FlightBytes {
  return renderToReadableStream(node)
}

/**
 * Collect the Flight stream to a text string. Handy for string-level
 * assertions (e.g. "does this payload contain '$L1'?"). Consumes the
 * stream; if the caller also needs the bytes, `.tee()` first.
 */
export async function flightToString(stream: FlightBytes): Promise<string> {
  return new Response(stream).text()
}

/**
 * Parse a Flight stream to its deserialised payload (element tree,
 * lazy refs, etc.). Safe to call on server-only trees. Does not
 * mount anything.
 */
export function consumePayload<T>(stream: FlightBytes): Promise<T> {
  return createFromReadableStream<T>(stream)
}

/** Convenience: render + tee + stringify + parse in one call. */
export async function renderAndInspect<T>(node: ReactNode): Promise<{
  text: string
  payload: T
}> {
  const stream = renderServerToFlight(node)
  const [a, b] = stream.tee()
  const [text, payload] = await Promise.all([flightToString(a), consumePayload<T>(b)])
  return { text, payload }
}

/**
 * Render a tree inside a real request context — `runWithRequestAsync`
 * opens the ALS store so tracked accessors (`getCookie`,
 * `getSearchParam`, `getPathname`) resolve, and `<PartialRoot>` can
 * parse the URL. Returns the Flight stream + the cookies the render
 * asked to set.
 *
 * Example:
 *
 *   const { stream } = await renderWithRequest(
 *     "http://localhost/p/bulbasaur?q=hi",
 *     <MyServerPage />,
 *   );
 *   expect(await new Response(stream).text()).toContain("bulbasaur");
 */
export async function renderWithRequest(
  url: string,
  node: ReactNode,
  options: { headers?: Record<string, string> } = {},
): Promise<{ stream: FlightBytes; cookies: string[] }> {
  const request = new Request(url, { headers: options.headers })
  // `runWithRequestAsync` expects an async fn; wrap the sync render
  // call so the ALS scope persists across the stream lifetime.
  //
  // Registry commit timing: the vendored
  // `react-server-dom/server.edge` we drive in tests renders fully
  // lazily — `renderToReadableStream` returns immediately and queues
  // every server component (including `<PartialRoot>`) onto
  // microtasks that fire as the stream is pulled. If we returned the
  // raw stream from `fn`, `runWithRequestAsync`'s exit auto-commit
  // would fire BEFORE those microtasks have run any `<Partial>`
  // bodies — committing an empty pendingWrites buffer and stranding
  // every later registration.
  //
  // Force rendering to complete inside `fn` by tee-ing the stream
  // and draining one side. The drain pulls every chunk, which forces
  // every microtask to run. When the await resolves, every
  // `<PartialBoundary>` has registered into pendingWrites.
  // `runWithRequestAsync`'s exit hook then commits a fully-populated
  // buffer.
  //
  // The other tee side stays buffered for the caller to consume —
  // it's effectively a frozen recording at that point.
  const { result, cookies } = await runWithRequestAsync(request, async () => {
    const stream = renderServerToFlight(node)
    const [forCaller, forDrain] = stream.tee()
    await new Response(forDrain).arrayBuffer()
    return forCaller
  })
  return { stream: result, cookies }
}
