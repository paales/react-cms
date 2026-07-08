/**
 * Remote endpoint dispatch — the host-app side of `<RemoteFrame>`.
 *
 * An app that wants to expose its addressable partons as remote
 * frames mounts a single handler:
 *
 *     const remote = createRemoteHandler({
 *       name: "magento",
 *       renderToFlightStream: (element) =>
 *         renderToReadableStream(element, { onError: ... }),
 *       typesPath: new URL("./app/remote-types.ts", import.meta.url).pathname,
 *     })
 *
 *     // in your fetch handler:
 *     const r = await remote(request)
 *     if (r) return r
 *
 * The handler claims these paths:
 *
 *   OPTIONS  *                         → CORS preflight (204)
 *   GET      /__remote/manifest.json   → spec inventory for the CLI
 *   GET      /__remote/types.d.ts      → author-provided types file
 *   GET      /__remote/<selector>      → Flight bytes + snapshot trailer
 *
 * Any other path returns `null` so the caller can fall through to
 * its normal page handler.
 */

import { promises as fs } from "node:fs"
import type { ReactNode } from "react"
import { ROOT } from "../lib/partial.tsx"
import { getSpecById, listSpecs } from "../lib/spec-catalog.ts"
import { enterRequestRegistry, getActiveRegistry } from "../lib/partial-registry.ts"
import { wrapStreamWithSnapshotTrailer } from "../lib/snapshot-trailer.ts"
import { CAPABILITY_HEADER, decodeCapability, runWithCapability } from "./capability.ts"
import { runWithRequestAsync } from "./context.ts"

export interface RemoteHandlerOptions {
  /** Short app name. Appears in the manifest so generated bindings
   *  carry a stable identifier. */
  name: string
  /** Callback that produces a Flight stream from a React element.
   *  Each app passes its own bound `renderToReadableStream` so the
   *  framework doesn't need to depend on `@vitejs/plugin-rsc/rsc`. */
  renderToFlightStream: (element: ReactNode) => ReadableStream<Uint8Array>
  /** Absolute filesystem path to the author's `remote-types.ts` (or
   *  any TypeScript file). The handler serves its raw contents at
   *  `/__remote/types.d.ts` so the CLI can copy them into the
   *  consumer's repo. Omit if the app doesn't expose typed
   *  capability bindings. */
  typesPath?: string
}

/** Permissive CORS for v1 — capability scoping is the trust boundary
 *  the host can rely on; the request itself is `credentials: "omit"`. */
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "*",
  "access-control-expose-headers": "*",
}

const MANIFEST_PATH = "/__remote/manifest.json"
const TYPES_PATH = "/__remote/types.d.ts"
const REMOTE_PREFIX = "/__remote/"

export interface RemoteManifestSpec {
  /** Canonical spec id; the URL is `<origin>/__remote/<selector>`. */
  selector: string
  /** PascalCase export name the CLI will use in generated bindings. */
  exportName: string
  /** Refetch labels (first is `selector`). */
  labels: string[]
  /** Type name in the served `types.d.ts`, or null if the spec
   *  doesn't declare a capability. */
  capabilityType: string | null
}

export interface RemoteManifest {
  name: string
  origin: string
  specs: RemoteManifestSpec[]
}

export function buildRemoteManifest(name: string, origin: string): RemoteManifest {
  const specs = listSpecs()
    .filter((s) => s.addressable !== false)
    .map<RemoteManifestSpec>((s) => ({
      selector: s.id,
      exportName: pascalCase(s.id),
      labels: s.labels,
      capabilityType: s.capabilityType ?? null,
    }))
    .sort((a, b) => a.selector.localeCompare(b.selector))
  return { name, origin, specs }
}

function pascalCase(input: string): string {
  return input
    .split(/[-_/.\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("")
}

export function createRemoteHandler(
  opts: RemoteHandlerOptions,
): (request: Request) => Promise<Response | null> {
  return async function remoteHandler(request: Request): Promise<Response | null> {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: { ...CORS_HEADERS, "access-control-max-age": "600" },
      })
    }

    const url = new URL(request.url)

    if (url.pathname === MANIFEST_PATH) {
      const manifest = buildRemoteManifest(opts.name, url.origin)
      return new Response(JSON.stringify(manifest, null, 2), {
        status: 200,
        headers: {
          "content-type": "application/json;charset=utf-8",
          ...CORS_HEADERS,
        },
      })
    }

    if (url.pathname === TYPES_PATH) {
      if (!opts.typesPath) {
        return new Response("// no types declared by this remote\n", {
          status: 200,
          headers: {
            "content-type": "text/plain;charset=utf-8",
            ...CORS_HEADERS,
          },
        })
      }
      try {
        const body = await fs.readFile(opts.typesPath, "utf8")
        return new Response(body, {
          status: 200,
          headers: {
            "content-type": "text/plain;charset=utf-8",
            ...CORS_HEADERS,
          },
        })
      } catch (err) {
        return new Response(`// failed to read ${opts.typesPath}: ${(err as Error).message}\n`, {
          status: 500,
          headers: {
            "content-type": "text/plain;charset=utf-8",
            ...CORS_HEADERS,
          },
        })
      }
    }

    if (url.pathname.startsWith(REMOTE_PREFIX)) {
      const id = decodeURIComponent(url.pathname.slice(REMOTE_PREFIX.length))
      const spec = getSpecById(id)
      if (!spec || spec.addressable === false) {
        return new Response(`Unknown spec: ${id}`, {
          status: 404,
          headers: CORS_HEADERS,
        })
      }
      const Component = spec.Component
      const capability = decodeCapability(request.headers.get(CAPABILITY_HEADER))
      const { result: stream } = await runWithRequestAsync(request, async () => {
        enterRequestRegistry("__remote", "streaming")
        return runWithCapability(capability, () => {
          const flightStream = opts.renderToFlightStream(<Component />)
          return wrapStreamWithSnapshotTrailer(flightStream, () => {
            const reg = getActiveRegistry()
            return reg ? reg.pendingWrites : new Map()
          })
        })
      })
      return new Response(stream, {
        status: 200,
        headers: {
          "content-type": "text/x-component;charset=utf-8",
          ...CORS_HEADERS,
        },
      })
    }

    return null
  }
}
