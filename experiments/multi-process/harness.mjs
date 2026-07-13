#!/usr/bin/env node
/**
 * Multi-process harness: two production builds of the harness app
 * (`./app`) behind a sticky reverse proxy, plus a tiny supervisor so
 * scenarios can kill and respawn individual backends (deploy / crash
 * simulation), a JSON-lines bump broker (the bus transport's relay),
 * and per-request byte accounting (the failover measurement's ruler).
 *
 * Topology (all ports overridable via env; 56xx so the harness never
 * collides with the canonical e2e servers on 5179/5181/5183):
 *
 *   client ── :5690 (proxy + supervisor, this process)
 *                ├── :5691  vite preview #0  (app/dist)
 *                └── :5692  vite preview #1  (same dist, separate node process)
 *            :5699  bump broker (JSON-lines relay)
 *
 * Both backends serve the SAME `vite build` output and share ONE
 * SQLite database (`.data/cells.sqlite`, WAL) — the shape of a real
 * horizontal deployment over a shared store. Everything in-memory
 * (partial registry, session store, invalidation registry, render
 * cache) is per-process by construction; the invalidation-bridge seam
 * plus this broker is what carries doorbells between them.
 *
 * ── Stickiness ─────────────────────────────────────────────────────────
 * Affinity resolution order, per request:
 *   1. `x-lb-backend` request header  — test override, never persisted.
 *   2. `__lb` cookie                  — the proxy's own affinity cookie.
 *   3. hash of `__frame_sid` cookie   — the framework's session cookie,
 *      for clients that carry a session but lost the affinity cookie.
 *   4. round-robin                    — first contact.
 * Whenever the served backend differs from the `__lb` cookie the proxy
 * appends `Set-Cookie: __lb=<n>` so the pin follows the client.
 *
 * ── Streaming ──────────────────────────────────────────────────────────
 * Response bodies are piped chunk-for-chunk (`upstream.on("data") →
 * res.write`) with no buffering, so the framework's held-open live
 * attach flushes lane segments in real time. Request bodies (action /
 * attach POSTs) are buffered in full before dispatch — that's what
 * makes transparent failover-with-replay possible when the pinned
 * backend is down.
 *
 * ── Failover ───────────────────────────────────────────────────────────
 * A connect error before response headers retries the remaining
 * backends in order and rewrites the `__lb` pin. An error after headers
 * have streamed kills the client socket (can't replay a half-delivered
 * stream) — the framework's reattach path owns recovery from there,
 * which is exactly what the failover scenario measures.
 *
 * ── Supervisor endpoints (served by the proxy itself) ─────────────────
 *   GET /__harness/status            → {proxy, bus, backends:[...]}
 *   GET /__harness/kill?i=0&signal=SIGTERM|SIGKILL
 *   GET /__harness/start?i=0         → waits for the port to answer
 *   GET /__harness/stats             → per-request records since reset
 *   GET /__harness/stats/reset
 *   GET /__harness/reset-store       → deletes the shared SQLite file
 *                                      (backends must be down)
 *
 * Usage:  node experiments/multi-process/harness.mjs
 *         (after `cd experiments/multi-process/app && vite build`)
 */

import http from "node:http"
import net from "node:net"
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, rmSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, "..", "..")
const APP_DIR = path.join(HERE, "app")
const VITE_BIN = path.join(REPO_ROOT, "node_modules", ".bin", "vite")
const DATA_DIR = path.join(HERE, ".data")
const SQLITE_PATH = path.join(DATA_DIR, "cells.sqlite")

const PROXY_PORT = Number(process.env.MP_PROXY_PORT ?? 5690)
const BACKEND_PORTS = (process.env.MP_BACKEND_PORTS ?? "5691,5692")
  .split(",")
  .map((p) => Number(p.trim()))
const BUS_PORT = Number(process.env.MP_BUS_PORT ?? 5699)

const AFFINITY_COOKIE = "__lb"
const SESSION_COOKIE = "__frame_sid"

// ─── Backend supervision ───────────────────────────────────────────────

/** @type {{port: number, child: import("node:child_process").ChildProcess | null}[]} */
const backends = BACKEND_PORTS.map((port) => ({ port, child: null }))

function spawnBackend(i) {
  const b = backends[i]
  if (b.child && b.child.exitCode === null) return
  const env = {
    ...process.env,
    NODE_ENV: "production",
    // Both halves of the multi-process contract, on every backend:
    // the shared per-key store and the bump bus.
    MP_SQLITE: SQLITE_PATH,
    MP_BUS: `127.0.0.1:${BUS_PORT}`,
  }
  const child = spawn(VITE_BIN, ["preview", "--port", String(b.port), "--strictPort"], {
    cwd: APP_DIR,
    stdio: ["ignore", "inherit", "inherit"],
    env,
  })
  child.on("exit", (code, signal) => {
    console.log(`[harness] backend #${i} (:${b.port}) exited code=${code} signal=${signal}`)
  })
  b.child = child
  console.log(`[harness] backend #${i} spawned on :${b.port} (pid ${child.pid})`)
}

function backendUp(i) {
  const b = backends[i]
  return b.child !== null && b.child.exitCode === null && b.child.signalCode === null
}

function probePort(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: "localhost", port, path: "/__mp/value", timeout: 1000 }, (res) => {
      res.resume()
      resolve(true)
    })
    req.on("error", () => resolve(false))
    req.on("timeout", () => {
      req.destroy()
      resolve(false)
    })
  })
}

async function waitForPort(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await probePort(port)) return true
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

/** Wait until nothing answers on the port. Spawning a strictPort vite
 *  into a port the old process hasn't released yet kills the NEW
 *  process while the OLD one keeps serving stale state — the
 *  supervisor must never report such a "restart" as success. */
async function waitForPortFree(port, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await probePort(port))) return true
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

// ─── Affinity ──────────────────────────────────────────────────────────

function parseCookies(header) {
  const out = {}
  if (!header) return out
  for (const part of header.split(";")) {
    const eq = part.indexOf("=")
    if (eq < 0) continue
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim()
  }
  return out
}

function hashString(s) {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h
}

let roundRobin = 0

function pickBackend(req, cookies) {
  const forced = req.headers["x-lb-backend"]
  if (forced !== undefined && backends[Number(forced)]) {
    return { index: Number(forced), source: "header" }
  }
  const pinned = cookies[AFFINITY_COOKIE]
  if (pinned !== undefined && backends[Number(pinned)]) {
    return { index: Number(pinned), source: "cookie" }
  }
  const sid = cookies[SESSION_COOKIE]
  if (sid) return { index: hashString(sid) % backends.length, source: "session" }
  return { index: roundRobin++ % backends.length, source: "round-robin" }
}

// ─── Request stats (the failover measurement's ruler) ──────────────────

/** @type {Array<{method: string, path: string, backend: number, status: number | null, bytes: number, startMs: number, endMs: number | null, aborted: boolean}>} */
let stats = []
const STATS_MAX = 5000

function recordStat(rec) {
  if (stats.length >= STATS_MAX) stats.shift()
  stats.push(rec)
}

// ─── Proxying ──────────────────────────────────────────────────────────

// One fresh connection per upstream request. The vite preview backends
// close keep-alive sockets after 5s idle (`Keep-Alive: timeout=5`);
// with Node's default pooled agent a reused socket can be closed by
// the backend at pick-time, surfacing as ECONNRESET — which the
// failover path would misread as "backend down" and silently replay
// the request (POSTs included!) on the other process, re-pinning the
// client. keepAlive:false makes every pre-response error a genuine
// connect failure, so failover only fires for actually-dead backends.
const upstreamAgent = new http.Agent({ keepAlive: false })

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
])

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => resolve(Buffer.concat(chunks)))
    req.on("error", reject)
  })
}

function forwardOnce(req, res, body, index, cookiePin, repin) {
  return new Promise((resolve) => {
    const b = backends[index]
    // The client-facing Host header is preserved (virtual-host style):
    // the framework's attach endpoint verifies `Origin` against the
    // request URL it reconstructs from Host, so rewriting Host to the
    // backend port would 403 every live attach as cross-origin.
    const headers = { ...req.headers }
    delete headers["x-lb-backend"]
    for (const h of HOP_BY_HOP) delete headers[h]

    const rec = {
      method: req.method,
      path: req.url,
      backend: index,
      status: null,
      bytes: 0,
      startMs: Date.now(),
      endMs: null,
      aborted: false,
    }

    const upstream = http.request(
      {
        host: "localhost",
        port: b.port,
        path: req.url,
        method: req.method,
        headers,
        agent: upstreamAgent,
      },
      (up) => {
        recordStat(rec)
        rec.status = up.statusCode ?? 502
        const outHeaders = {}
        for (const [k, v] of Object.entries(up.headers)) {
          if (!HOP_BY_HOP.has(k.toLowerCase())) outHeaders[k] = v
        }
        const setCookies = [].concat(up.headers["set-cookie"] ?? [])
        if (repin && cookiePin !== String(index)) {
          setCookies.push(`${AFFINITY_COOKIE}=${index}; Path=/; SameSite=Lax`)
        }
        if (setCookies.length > 0) outHeaders["set-cookie"] = setCookies
        outHeaders["x-lb-backend"] = String(index)
        res.writeHead(up.statusCode ?? 502, outHeaders)
        // Chunk-for-chunk pass-through — no buffering, live segments
        // flush as the backend emits them.
        up.on("data", (chunk) => {
          rec.bytes += chunk.length
          res.write(chunk)
        })
        up.on("end", () => {
          rec.endMs = Date.now()
          res.end()
          resolve({ ok: true })
        })
        up.on("error", () => {
          rec.endMs = Date.now()
          rec.aborted = true
          res.destroy()
          resolve({ ok: true }) // headers were sent; nothing to retry
        })
        res.on("close", () => {
          if (rec.endMs === null) {
            rec.endMs = Date.now()
            rec.aborted = true
          }
          up.destroy()
        })
      },
    )
    upstream.on("error", (err) => resolve({ ok: false, err }))
    // If the client goes away while we're still talking to the
    // backend (held-attach abort), tear the upstream down too.
    res.on("close", () => upstream.destroy())
    upstream.end(body)
  })
}

async function proxy(req, res) {
  const cookies = parseCookies(req.headers.cookie)
  const pick = pickBackend(req, cookies)
  const body = await readBody(req)
  const cookiePin = cookies[AFFINITY_COOKIE]

  // Try the pinned backend first, then fail over through the rest. A
  // header-forced pick is a test probe — it must not re-pin the client.
  const repin = pick.source !== "header"
  const order = [pick.index, ...backends.map((_, i) => i).filter((i) => i !== pick.index)]
  for (const index of order) {
    const attempt = await forwardOnce(req, res, body, index, cookiePin, repin)
    if (attempt.ok) {
      if (index !== pick.index) {
        console.log(
          `[proxy] ${req.method} ${req.url} — backend #${pick.index} down, failed over to #${index}`,
        )
      }
      return
    }
  }
  res.writeHead(502, { "content-type": "text/plain" })
  res.end("no backend available")
}

// ─── Supervisor endpoints ──────────────────────────────────────────────

async function handleHarness(req, res, url) {
  if (url.pathname === "/__harness/status") {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(
      JSON.stringify({
        proxy: PROXY_PORT,
        bus: BUS_PORT,
        sqlite: SQLITE_PATH,
        backends: backends.map((b, i) => ({
          index: i,
          port: b.port,
          pid: b.child?.pid ?? null,
          up: backendUp(i),
        })),
      }),
    )
    return
  }
  if (url.pathname === "/__harness/stats") {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ now: Date.now(), requests: stats }))
    return
  }
  if (url.pathname === "/__harness/stats/reset") {
    stats = []
    res.writeHead(200)
    res.end("ok")
    return
  }
  if (url.pathname === "/__harness/reset-store") {
    if (backends.some((_, i) => backendUp(i))) {
      res.writeHead(409)
      res.end("backends must be down to reset the store")
      return
    }
    rmSync(SQLITE_PATH, { force: true })
    rmSync(`${SQLITE_PATH}-wal`, { force: true })
    rmSync(`${SQLITE_PATH}-shm`, { force: true })
    res.writeHead(200)
    res.end("store reset")
    return
  }
  if (url.pathname === "/__harness/kill") {
    const i = Number(url.searchParams.get("i"))
    const signal = url.searchParams.get("signal") ?? "SIGTERM"
    const b = backends[i]
    if (!b || !backendUp(i)) {
      res.writeHead(409)
      res.end("backend not running")
      return
    }
    b.child.kill(signal)
    // Wait for actual exit so callers can rely on the port being free.
    await new Promise((resolve) => {
      if (b.child.exitCode !== null) return resolve()
      b.child.once("exit", resolve)
      setTimeout(resolve, 5000)
    })
    res.writeHead(200)
    res.end(`killed #${i} with ${signal}`)
    return
  }
  if (url.pathname === "/__harness/start") {
    const i = Number(url.searchParams.get("i"))
    if (!backends[i]) {
      res.writeHead(404)
      res.end("no such backend")
      return
    }
    if (!backendUp(i)) {
      const freed = await waitForPortFree(backends[i].port)
      if (!freed) {
        res.writeHead(500)
        res.end(`port ${backends[i].port} still held by a previous process`)
        return
      }
    }
    spawnBackend(i)
    const up = await waitForPort(backends[i].port)
    res.writeHead(up ? 200 : 500)
    res.end(up ? `backend #${i} up` : `backend #${i} did not come up`)
    return
  }
  res.writeHead(404)
  res.end("unknown harness endpoint")
}

// ─── Boot ──────────────────────────────────────────────────────────────

if (!existsSync(path.join(APP_DIR, "dist"))) {
  console.error(
    "[harness] app/dist missing — run `node_modules/.bin/vite build` in experiments/multi-process/app first.",
  )
  process.exit(1)
}
mkdirSync(DATA_DIR, { recursive: true })

// ── Bump broker ────────────────────────────────────────────────────────
// JSON-lines relay: every line a client sends is forwarded verbatim to
// every OTHER client. The line protocol is the bridge seam's
// `InvalidationBumpBatch` — `{origin, selectors}`, selectors only,
// never values (the bus scenario spies on this socket to prove it).
const busClients = new Set()
const busServer = net.createServer((sock) => {
  busClients.add(sock)
  let buffer = ""
  sock.on("data", (chunk) => {
    buffer += chunk.toString("utf8")
    let nl
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl + 1)
      buffer = buffer.slice(nl + 1)
      for (const peer of busClients) {
        if (peer !== sock && !peer.destroyed) peer.write(line)
      }
    }
  })
  const drop = () => busClients.delete(sock)
  sock.on("close", drop)
  sock.on("error", drop)
})
busServer.listen(BUS_PORT, () => {
  console.log(`[harness] bump broker on :${BUS_PORT}`)
})

for (let i = 0; i < backends.length; i++) spawnBackend(i)

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PROXY_PORT}`)
  if (url.pathname.startsWith("/__harness/")) {
    handleHarness(req, res, url).catch((err) => {
      res.writeHead(500)
      res.end(String(err))
    })
    return
  }
  proxy(req, res).catch((err) => {
    if (!res.headersSent) res.writeHead(502)
    res.end(`proxy error: ${err}`)
  })
})

server.listen(PROXY_PORT, async () => {
  const ready = await Promise.all(backends.map((b) => waitForPort(b.port)))
  console.log(
    `[harness] sticky proxy on :${PROXY_PORT} → backends ${backends
      .map((b, i) => `#${i}=:${b.port}(${ready[i] ? "up" : "DOWN"})`)
      .join(" ")}`,
  )
})

function shutdown() {
  for (const b of backends) b.child?.kill("SIGTERM")
  server.close()
  busServer.close()
  process.exit(0)
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
