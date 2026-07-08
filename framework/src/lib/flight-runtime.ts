/**
 * Flight render/decode shim.
 *
 * Production / dev: route through `@vitejs/plugin-rsc/rsc`, which has
 * the real client-reference manifest stamped in by Vite's transform
 * pipeline. Client components inside cached subtrees serialize and
 * re-mount on the SSR side correctly.
 *
 * Test: route through the vendored bundles with a permissive Proxy
 * manifest. Vite's `virtual:` module resolution doesn't fire under
 * Vitest's bare-Node ESM loader; the `@vitejs/plugin-rsc/rsc` import
 * leaks `virtual:` URLs that Node can't resolve.
 *
 * Selection: `process.env.VITEST === "true"` is set by Vitest during
 * test runs. We resolve the appropriate runtime once at module load.
 */

/// <reference path="./react-server-dom-vendor.d.ts" />

import * as ReactServer from "@vitejs/plugin-rsc/vendor/react-server-dom/server.edge"
import * as ReactClient from "@vitejs/plugin-rsc/vendor/react-server-dom/client.edge"
import { reportServerRenderError } from "../runtime/errors.ts"

// `<Cache>` subtrees and remote frames render through this Flight
// runtime, not the app entry's `renderToReadableStream`. Without an
// `onError`, a throw inside a cached subtree reaches React with no
// server-side log and an empty digest — that's the `[ssr] … digest=''`
// line in production with no real message. Route it through the same
// reporter the rsc/ssr entry paths use so the real error + stack is
// logged server-side under a digest.
function onCacheRenderError(error: unknown): string | undefined {
  return reportServerRenderError("rsc", error)
}

const IS_TEST =
  typeof process !== "undefined" &&
  (process.env.VITEST === "true" || process.env.VITEST === "1" || !!process.env.VITEST_WORKER_ID)

// ─── Test-mode stub manifests ─────────────────────────────────────────

const STUB_CLIENT_MANIFEST = new Proxy({} as Record<string, unknown>, {
  get: (_t, id) => {
    if (typeof id !== "string") return undefined
    return { id, chunks: [], name: "*" }
  },
})

const STUB_CONSUMER_MODULE_MAP = new Proxy({} as Record<string, unknown>, {
  get: (_t, id) => {
    if (typeof id !== "string") return undefined
    return new Proxy({} as Record<string, unknown>, {
      get: (_t2, name) => (typeof name === "string" ? { id, chunks: [], name } : undefined),
    })
  },
})

const STUB_SERVER_CONSUMER_MANIFEST = {
  moduleMap: STUB_CONSUMER_MODULE_MAP,
  serverModuleMap: {},
  moduleLoading: null,
}

// ─── Prod runtime — lazy import to avoid module-init virtual: leak ────
//
// In production, `@vitejs/plugin-rsc/rsc` is the canonical entry that
// bakes in the real client-reference manifest. We import it lazily so
// test-mode module load doesn't trip on its `virtual:` modules.

type FlightRenderOptions = { onError?: (error: unknown) => string | undefined }

type ProdRuntime = {
  renderToReadableStream: <T>(
    data: T,
    clientManifest?: unknown,
    options?: FlightRenderOptions,
  ) => ReadableStream<Uint8Array>
  createFromReadableStream: <T>(stream: ReadableStream<Uint8Array>) => Promise<T>
}

let _prodRuntime: ProdRuntime | null = null
let _prodRuntimePromise: Promise<ProdRuntime> | null = null

async function loadProdRuntime(): Promise<ProdRuntime> {
  if (_prodRuntime) return _prodRuntime
  if (_prodRuntimePromise) return _prodRuntimePromise
  _prodRuntimePromise = import("@vitejs/plugin-rsc/rsc").then((mod) => {
    const runtime = mod as unknown as ProdRuntime
    _prodRuntime = runtime
    return runtime
  })
  return _prodRuntimePromise
}

// ─── Public API ───────────────────────────────────────────────────────

export function renderToReadableStream<T>(data: T): ReadableStream<Uint8Array> {
  if (IS_TEST) {
    return ReactServer.renderToReadableStream(data, STUB_CLIENT_MANIFEST, {
      onError: onCacheRenderError,
    })
  }
  if (_prodRuntime) {
    return _prodRuntime.renderToReadableStream(data, undefined, { onError: onCacheRenderError })
  }
  // Sync caller, async load — kick off the load and stream once it
  // resolves. Vite's plugin-rsc resolves synchronously after first
  // import in practice; subsequent calls hit the cached `_prodRuntime`.
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const runtime = await loadProdRuntime()
        const stream = runtime.renderToReadableStream(data, undefined, {
          onError: onCacheRenderError,
        })
        const reader = stream.getReader()
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          controller.enqueue(value)
        }
        controller.close()
      } catch (err) {
        controller.error(err)
      }
    },
  })
}

export async function createFromReadableStream<T>(stream: ReadableStream<Uint8Array>): Promise<T> {
  if (IS_TEST) {
    return ReactClient.createFromReadableStream(stream, {
      serverConsumerManifest: STUB_SERVER_CONSUMER_MANIFEST,
    })
  }
  const runtime = await loadProdRuntime()
  return runtime.createFromReadableStream(stream)
}
