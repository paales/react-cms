import net from "node:net"
import type { APIRequestContext, BrowserContext, Page } from "@playwright/test"

export const PROXY = "http://localhost:5690"
export const BACKEND_URLS = ["http://localhost:5691", "http://localhost:5692"]
export const BUS_PORT = 5699

// ─── Affinity ──────────────────────────────────────────────────────────

/** Pin a browser context to backend N via the proxy's affinity cookie. */
export async function pin(context: BrowserContext, backend: number): Promise<void> {
  await context.addCookies([{ name: "__lb", value: String(backend), url: PROXY }])
}

// ─── Supervisor ────────────────────────────────────────────────────────

export interface HarnessStatus {
  proxy: number
  bus: number
  sqlite: string
  backends: Array<{ index: number; port: number; pid: number | null; up: boolean }>
}

export async function harnessStatus(request: APIRequestContext): Promise<HarnessStatus> {
  const res = await request.get(`${PROXY}/__harness/status`)
  return (await res.json()) as HarnessStatus
}

export async function killBackend(
  request: APIRequestContext,
  i: number,
  signal: "SIGTERM" | "SIGKILL" = "SIGTERM",
): Promise<void> {
  const res = await request.get(`${PROXY}/__harness/kill?i=${i}&signal=${signal}`)
  if (!res.ok()) throw new Error(`kill backend ${i} failed: ${res.status()}`)
}

export async function startBackend(request: APIRequestContext, i: number): Promise<void> {
  const res = await request.get(`${PROXY}/__harness/start?i=${i}`)
  if (!res.ok()) throw new Error(`start backend ${i} failed: ${res.status()}`)
}

/** Restart backends to a boot-fresh state (empty registries, fresh
 *  handles on the shared SQLite store). `resetStore: true` also wipes
 *  the store between the kill and the respawn, so counter baselines
 *  start at 0. */
export async function restartBackends(
  request: APIRequestContext,
  indices: number[] = [0, 1],
  opts: { resetStore?: boolean } = {},
): Promise<void> {
  const status = await harnessStatus(request)
  for (const i of indices) {
    if (status.backends[i]?.up) await killBackend(request, i, "SIGTERM")
  }
  if (opts.resetStore) {
    const res = await request.get(`${PROXY}/__harness/reset-store`)
    if (!res.ok()) throw new Error(`reset-store failed: ${res.status()}`)
  }
  for (const i of indices) await startBackend(request, i)
}

// ─── Proxy byte accounting ─────────────────────────────────────────────

export interface RequestStat {
  method: string
  path: string
  backend: number
  status: number | null
  bytes: number
  startMs: number
  endMs: number | null
  aborted: boolean
}

export async function proxyStats(request: APIRequestContext): Promise<RequestStat[]> {
  const res = await request.get(`${PROXY}/__harness/stats`)
  const body = (await res.json()) as { requests: RequestStat[] }
  return body.requests
}

export async function resetProxyStats(request: APIRequestContext): Promise<void> {
  await request.get(`${PROXY}/__harness/stats/reset`)
}

// ─── App endpoints (direct-to-backend, bypassing affinity) ─────────────

/** POST /__mp/update on a SPECIFIC backend; returns the committed
 *  value (CAS-final). `delayMs` makes the endpoint sleep BEFORE the
 *  write — the drain scenario's deliberate in-flight window. */
export async function updateOn(
  request: APIRequestContext,
  backend: number,
  opts: { delayMs?: number } = {},
): Promise<{ value: number; pid: number }> {
  const delay = opts.delayMs !== undefined ? `?delay=${opts.delayMs}` : ""
  const res = await request.post(`${BACKEND_URLS[backend]}/__mp/update${delay}`)
  if (!res.ok()) throw new Error(`update on backend ${backend} failed: ${res.status()}`)
  return (await res.json()) as { value: number; pid: number }
}

/** GET /__mp/value on a SPECIFIC backend — that process's read of the
 *  shared store. */
export async function valueOn(request: APIRequestContext, backend: number): Promise<number> {
  const res = await request.get(`${BACKEND_URLS[backend]}/__mp/value`)
  if (!res.ok()) throw new Error(`value on backend ${backend} failed: ${res.status()}`)
  return ((await res.json()) as { value: number }).value
}

// ─── Page helpers ──────────────────────────────────────────────────────

/** Hydration barrier: the bump button's client effect stamps
 *  `data-mp-ready` on <body> once the client runtime is live. */
export async function ready(page: Page): Promise<void> {
  await page.locator("body[data-mp-ready]").waitFor({ timeout: 15_000 })
}

export async function counterValue(page: Page): Promise<number> {
  const text = await page.getByTestId("counter").textContent()
  return Number((text ?? "").replace(/\D+/g, ""))
}

// ─── Bus spy ───────────────────────────────────────────────────────────

export interface BusSpy {
  /** Every complete line relayed by the broker since the spy attached. */
  lines(): string[]
  close(): void
}

/** Attach a passive client to the bump broker. The broker relays every
 *  line to every OTHER client, so the spy sees exactly the batches the
 *  backends exchange — the wire the zero-values assertion reads. */
export function spyOnBus(): Promise<BusSpy> {
  return new Promise((resolve, reject) => {
    const collected: string[] = []
    let buffer = ""
    const sock = net.createConnection({ host: "127.0.0.1", port: BUS_PORT }, () => {
      resolve({
        lines: () => [...collected],
        close: () => sock.destroy(),
      })
    })
    sock.on("data", (chunk) => {
      buffer += chunk.toString("utf8")
      let nl: number
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        if (line.trim()) collected.push(line)
      }
    })
    sock.on("error", reject)
  })
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}
