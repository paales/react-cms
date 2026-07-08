/**
 * Vite plugin: the WebSocket transport's server wiring for dev +
 * preview. `createRscHandler` returns `{ fetch }` (a Request→Response
 * surface) — but a socket server lives OUTSIDE that surface, so this
 * plugin owns the FOURTH hook: it hooks the Node http server's `upgrade`
 * event, accepts the `/__parton/ws` handshake, and drives each socket
 * through the app's `handleChannelSocket` (which `createRscHandler`
 * exposes off its default export). The drive runs in the RSC
 * environment — where `<Root/>` renders — reached via the environment
 * runner in dev and the built bundle in preview.
 *
 * OPT-IN, and NOT wired into any app's `vite.config.ts` by default: add
 * `partonChannelServer()` to `plugins` to serve the socket, and the
 * client only uses it when a page opts in (`?transport=ws` /
 * `window.__partonTransport`). The default transport stays fetch, so an
 * app without this plugin is unaffected — the socket path simply 404s
 * the upgrade and the client falls back.
 *
 * The tunnel it drives is verified end to end in
 * `framework/src/lib/__tests__/channel-ws.rsc.test.tsx` (a real `ws`
 * server + the client transport); this plugin is the dev/preview glue
 * that hands each upgraded socket to that same `driveChannelSocket`. See
 * `docs/internals/channel.md` § The transport seam.
 */

import type { IncomingMessage } from "node:http"
import path from "node:path"
import type { Duplex } from "node:stream"
import { pathToFileURL } from "node:url"
import {
  type HttpServer,
  isRunnableDevEnvironment,
  type Plugin,
  type PreviewServer,
  type ResolvedConfig,
  type ViteDevServer,
} from "vite"
import { type WebSocket as WsSocket, WebSocketServer } from "ws"
import { CHANNEL_WS_ENDPOINT } from "../lib/channel-protocol.ts"
import type { ChannelSocket } from "../lib/channel-server.ts"

/** The socket-side handler `createRscHandler` exposes off its default
 *  export — one connection's whole drive. */
type ChannelSocketHandler = (socket: ChannelSocket, request: Request) => Promise<void>

export interface PartonChannelServerOptions {
  /** The RSC environment's build-input key (canonically `index`, the
   *  `environments.rsc.build.rollupOptions.input.index` entry). */
  entryName?: string
}

/**
 * Register the `/__parton/ws` upgrade handler for dev + preview. Place
 * anywhere in `plugins`; it does not alter the request pipeline. Absent
 * this plugin, the socket path is unserved and the client's opt-in WS
 * transport fails to establish (its bounded re-establishment / the
 * default fetch transport cover the app).
 */
export function partonChannelServer(options: PartonChannelServerOptions = {}): Plugin {
  const entryName = options.entryName ?? "index"
  return {
    name: "parton:channel-server",
    configureServer(server: ViteDevServer) {
      const httpServer = server.httpServer
      if (!httpServer) return
      attachUpgrade(httpServer, () => loadDevHandler(server, entryName))
    },
    configurePreviewServer(server: PreviewServer) {
      const httpServer = server.httpServer
      if (!httpServer) return
      attachUpgrade(httpServer, () => loadPreviewHandler(server.config, entryName))
    },
  }
}

/**
 * Hook the http server's `upgrade` event for our path only. A
 * non-matching upgrade is LEFT ALONE (no socket teardown) so Vite's own
 * HMR WebSocket upgrade — on the same event — still handles it.
 */
function attachUpgrade(
  httpServer: HttpServer,
  loadHandler: () => Promise<ChannelSocketHandler>,
): void {
  const wss = new WebSocketServer({ noServer: true })
  httpServer.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let pathname: string
    try {
      pathname = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`).pathname
    } catch {
      return
    }
    if (pathname !== CHANNEL_WS_ENDPOINT) return
    wss.handleUpgrade(req, socket, head, (ws) => {
      void driveOne(ws, req, loadHandler)
    })
  })
}

async function driveOne(
  ws: WsSocket,
  req: IncomingMessage,
  loadHandler: () => Promise<ChannelSocketHandler>,
): Promise<void> {
  // Adapt the socket NOW — synchronously in the upgrade callback, before
  // the async handler load — so its listeners buffer the attach the
  // client sends immediately on `open`. `loadHandler()` is a cold RSC
  // import on the first upgrade; without buffering, that attach lands in
  // the gap before `driveChannelSocket` registers `onMessage` and is
  // DROPPED (Node drops an unheard `message` event), so the connection
  // never establishes. See `wsToChannelSocket`.
  const socket = wsToChannelSocket(ws)
  try {
    const handleSocket = await loadHandler()
    await handleSocket(socket, nodeRequest(req))
  } catch (err) {
    try {
      ws.close()
    } catch {}
    console.error("[parton:channel-server] socket drive failed", err)
  }
}

/** Dev: import the RSC entry through the runnable `rsc` environment
 *  (react-server condition, the module graph `<Root/>` renders in), the
 *  same runner plugin-rsc dispatches the fetch handler through. */
async function loadDevHandler(
  server: ViteDevServer,
  entryName: string,
): Promise<ChannelSocketHandler> {
  const environment = server.environments.rsc
  if (!environment || !isRunnableDevEnvironment(environment)) {
    throw new Error(
      "[parton:channel-server] the 'rsc' environment is not a runnable dev environment",
    )
  }
  const source = entrySource(
    (environment.config as { build?: { rollupOptions?: { input?: unknown } } }).build?.rollupOptions
      ?.input,
    entryName,
  )
  if (!source) {
    throw new Error(`[parton:channel-server] no rsc build input named '${entryName}'`)
  }
  const resolved = await environment.pluginContainer.resolveId(source)
  if (!resolved) {
    throw new Error(`[parton:channel-server] cannot resolve rsc entry '${source}'`)
  }
  return handlerFrom(await environment.runner.import(resolved.id))
}

/** Preview: import the built RSC bundle (`<rsc outDir>/<entry>.js`). */
async function loadPreviewHandler(
  config: ResolvedConfig,
  entryName: string,
): Promise<ChannelSocketHandler> {
  const outDir = config.environments?.rsc?.build?.outDir
  if (!outDir) {
    throw new Error("[parton:channel-server] no rsc build.outDir configured")
  }
  const entryPath = path.resolve(config.root, outDir, `${entryName}.js`)
  return handlerFrom(await import(pathToFileURL(entryPath).href))
}

function handlerFrom(mod: unknown): ChannelSocketHandler {
  const handler = (
    mod as {
      default?: { handleChannelSocket?: ChannelSocketHandler }
    }
  ).default?.handleChannelSocket
  if (typeof handler !== "function") {
    throw new Error(
      "[parton:channel-server] the rsc entry's default export has no handleChannelSocket — use createRscHandler({ Root })",
    )
  }
  return handler
}

/** Pick the entry's source from the RSC environment's build input
 *  (string, or the `{ [entryName]: source }` record form apps use). */
function entrySource(input: unknown, name: string): string | undefined {
  if (typeof input === "string") return input
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const value = (input as Record<string, unknown>)[name]
    return typeof value === "string" ? value : undefined
  }
  return undefined
}

/** Build a Request from the upgrade's IncomingMessage — its `Cookie`
 *  header supplies the scope + session binding, its URL the origin the
 *  attach's stated URL validates against. */
function nodeRequest(req: IncomingMessage): Request {
  const host = req.headers.host ?? "localhost"
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    if (Array.isArray(value)) for (const one of value) headers.append(key, one)
    else headers.set(key, value)
  }
  return new Request(`http://${host}${req.url ?? "/"}`, { headers })
}

/** Adapt a `ws` server socket to the transport-agnostic ChannelSocket
 *  the tunnel drives. Downstream frames go out binary (`send`); upstream
 *  attach/envelopes arrive as text (`onMessage`). Backpressure is real:
 *  `bufferedAmount` + the send-flush callback (`onDrain`), no timers. */
function wsToChannelSocket(ws: WsSocket): ChannelSocket {
  const drainHandlers: Array<() => void> = []
  // The raw `ws` listeners attach at CONSTRUCTION (synchronously, before
  // the async handler load), and buffer/latch whatever arrives before
  // `driveChannelSocket` registers its own `onMessage`/`onClose` — the
  // gap in which the client's attach (sent on `open`) would otherwise be
  // dropped. Once the real handlers register, the buffer replays in
  // order and everything after flows straight through.
  const bufferedMessages: string[] = []
  let messageHandler: ((data: string) => void) | null = null
  ws.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
    const text = Array.isArray(data)
      ? Buffer.concat(data).toString("utf8")
      : Buffer.from(data as ArrayBuffer).toString("utf8")
    if (messageHandler) messageHandler(text)
    else bufferedMessages.push(text)
  })
  let closed = false
  let closeHandler: (() => void) | null = null
  ws.on("close", () => {
    closed = true
    closeHandler?.()
  })
  return {
    send(bytes) {
      try {
        ws.send(bytes, () => {
          for (const handler of [...drainHandlers]) handler()
        })
      } catch {}
    },
    get bufferedAmount() {
      return ws.bufferedAmount
    },
    close() {
      try {
        ws.close()
      } catch {}
    },
    onMessage(handler) {
      messageHandler = handler
      for (const text of bufferedMessages.splice(0)) handler(text)
    },
    onClose(handler) {
      closeHandler = handler
      if (closed) handler()
    },
    onDrain(handler) {
      drainHandlers.push(handler)
    },
  }
}
