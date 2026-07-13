/**
 * The harness's bump transport — the trivial at-least-once carrier the
 * framework's invalidation-bridge seam leaves to the deployment. One
 * TCP connection per process to the harness broker (`harness.mjs`),
 * newline-framed JSON, each line one `InvalidationBumpBatch`. The
 * broker relays every line to every OTHER client verbatim.
 *
 * Reliability posture: TCP gives at-least-once while connected; a
 * reconnect window drops batches, which degrades the disconnected peer
 * to its query-time restore path — over-fetch territory, never
 * corruption (the SQLite store is the truth). Values never travel
 * here: the line protocol is exactly `{origin, selectors}`, which the
 * bus scenario asserts byte-for-byte off a broker spy.
 */

import net from "node:net"
import {
  deliverInvalidationBumps,
  setInvalidationBridge,
  type InvalidationBumpBatch,
} from "@parton/framework/runtime/invalidation-bridge.ts"

export function connectBusTransport(address: string): void {
  const [host, portRaw] = address.split(":")
  const port = Number(portRaw)
  let socket: net.Socket | null = null

  const connect = () => {
    const s = net.createConnection({ host: host || "127.0.0.1", port }, () => {
      socket = s
      console.log(`[mp-bus] connected to ${address}`)
    })
    let buffer = ""
    s.on("data", (chunk) => {
      buffer += chunk.toString("utf8")
      let nl: number
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        if (!line.trim()) continue
        try {
          deliverInvalidationBumps(JSON.parse(line) as InvalidationBumpBatch)
        } catch {
          // Malformed line — drop it; the next doorbell (or a viewer's
          // query-time restore) re-syncs.
        }
      }
    })
    const retry = () => {
      if (socket === s) socket = null
      setTimeout(connect, 1000).unref()
    }
    s.on("error", retry)
    s.on("close", () => {
      if (socket === s) retry()
    })
  }
  connect()

  setInvalidationBridge({
    publish(batch) {
      // Fire-and-forget: `publish` runs synchronously at commit; the
      // socket buffers. A batch lost to a dead socket is the
      // documented reconnect-window degradation.
      socket?.write(JSON.stringify(batch) + "\n")
    },
  })
}
