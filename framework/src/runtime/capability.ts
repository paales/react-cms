/**
 * Capability scoping for `<RemoteFrame>`.
 *
 * A capability is a host-declared bag of key/value pairs that
 * crosses the wire as a single header on the remote fetch. The
 * remote endpoint reads it, stores it in an ALS context, and
 * exposes it via `getCapability()` to its rendering specs.
 *
 * This is the trust boundary for cross-origin RemoteFrame:
 *
 * - The host explicitly enumerates what the remote can see.
 *   `cart_id`, `currency`, `idempotency_key` — whatever the slot
 *   contract requires.
 * - The fetch sends with `credentials: "omit"`, so the host's
 *   cookies don't leak to the remote even on same-origin
 *   embeddings. The only context the remote sees from the host
 *   is what came through the capability header.
 * - The remote's tracked reads (`session()`, `cookie()`, `header()`) see only
 *   what the FETCH request carried — usually nothing from the
 *   host's session. The capability is the explicit channel.
 *
 * v1 wire shape: `x-parton-capability: <base64-url JSON>`. The
 * value is a flat `Record<string, JSON-serializable>`. Authors
 * pass it via the `capability` prop on RemoteFrame.
 *
 * Future work: signed capability tokens (so the remote can trust
 * the host's claims), expiration, scope hierarchies. v1 is
 * trust-the-network: same-machine dev or trusted-perimeter
 * production.
 */

import { AsyncLocalStorage } from "node:async_hooks"
import { embedGrantsOf } from "../lib/page-embed.ts"
import { getRequest } from "./context.ts"

export type CapabilityValue = string | number | boolean | null
export type Capability = Record<string, CapabilityValue>

const capabilityAls = new AsyncLocalStorage<Capability>()

export const CAPABILITY_HEADER = "x-parton-capability"

/** Active capability for the current request, or empty. */
export function getCapability(): Capability {
  return capabilityAls.getStore() ?? {}
}

/**
 * Runs `fn` inside a capability scope. The remote endpoint calls
 * this with the parsed header value before invoking the spec
 * render so `getCapability()` inside specs sees the values.
 */
export function runWithCapability<T>(cap: Capability, fn: () => T): T {
  return capabilityAls.run(cap, fn)
}

/**
 * The grant SET this render carries, or `null` for an ungoverned
 * render (an ordinary page view, or an embed with no `grant` at the
 * call site — full trust). The other half of the capability: the
 * value bag above says what the render may READ, the grant set says
 * what its payload may REFERENCE. Read straight off the embed
 * request's `x-parton-embed-grant` header (`lib/page-embed.ts` owns
 * the wire grammar) — no second ALS, the request scope IS the scope.
 *
 * Producer-side this is informational — render the embed-surface
 * variant (`getEmbedGrants()?.has("paint")` → skip the app chrome);
 * the framework's own parton pipeline consults it the same way to
 * emit bare, boundary-free bodies. Enforcement lives with the HOST's
 * tier rewriter at splice time.
 */
export function getEmbedGrants(): ReadonlySet<string> | null {
  let request: Request
  try {
    request = getRequest()
  } catch {
    return null
  }
  return embedGrantsOf(request.headers)
}

/** Encode for the wire. Base64url over a UTF-8 JSON encoding. */
export function encodeCapability(cap: Capability): string {
  const json = JSON.stringify(cap)
  if (typeof Buffer !== "undefined") {
    return Buffer.from(json, "utf-8").toString("base64url")
  }
  // Browser-side fallback (RemoteFrame runs server-side, but the
  // encode helper is exported so client code can use it too).
  const bytes = new TextEncoder().encode(json)
  let bin = ""
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/** Decode from the wire. Returns an empty capability on parse failure. */
export function decodeCapability(value: string | null | undefined): Capability {
  if (!value) return {}
  try {
    let json: string
    if (typeof Buffer !== "undefined") {
      json = Buffer.from(value, "base64url").toString("utf-8")
    } else {
      const padded =
        value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4)
      const bin = atob(padded)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      json = new TextDecoder().decode(bytes)
    }
    const parsed = JSON.parse(json)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Capability
    }
    return {}
  } catch {
    return {}
  }
}
