/**
 * Request context for server components and server actions.
 *
 * Uses AsyncLocalStorage to make the incoming request (cookies, headers)
 * available anywhere during a render or action, and to collect
 * Set-Cookie headers for the response.
 *
 * Tracked accessors (`getCookie`, `getHeader`, `getSearchParam`,
 * `getPathname`) additionally push their `(kind, name)` into a
 * per-Partial *access manifest* held in a second ALS slot. A cached
 * Partial uses that manifest as its cache key surface — so the author
 * doesn't have to re-declare which cookies/headers/URL params their
 * content depends on. See `notes/AUTO_TRACKED_CACHE_KEYS.md`.
 */

import { AsyncLocalStorage } from "node:async_hooks";

interface RequestStore {
  request: Request;
  cookies: string[];
}

const requestContext = new AsyncLocalStorage<RequestStore>();

/**
 * Per-Partial cache access manifest. Opened by `<Cache>` at the top of
 * its body, closes when Cache returns. Nested Partials open their own
 * manifest (ALS scopes stack naturally), so reads inside an inner
 * Partial are attributed to that Partial, not the outer one.
 *
 * Outside a Cache scope (inside a non-cached Partial body, a server
 * action, etc.), accessor calls no-op for tracking purposes. The
 * underlying read still happens normally — tracking is only a
 * side-effect.
 *
 * Scope holds both `current` (being filled during this render) and
 * `stored` (from a previous render, or null on first render). If
 * `stored` is set and an accessor reads a key NOT in `stored`, we
 * throw immediately — that's a hoisting violation (the Partial's key
 * surface changed). Missing keys (stored has X, current doesn't touch
 * X) are detected post-render by `<Cache>` and treated as a soft
 * failure (log + preserve the old entry).
 */
export interface ManifestScope {
  current: Set<string>;
  stored: ReadonlySet<string> | null;
  partialId: string;
}

const manifestContext = new AsyncLocalStorage<ManifestScope>();

export function runWithRequest<T>(
  request: Request,
  fn: () => T,
): { result: T; cookies: string[] } {
  const store: RequestStore = { request, cookies: [] };
  const result = requestContext.run(store, fn);
  return { result, cookies: store.cookies };
}

export async function runWithRequestAsync<T>(
  request: Request,
  fn: () => Promise<T>,
): Promise<{ result: T; cookies: string[] }> {
  const store: RequestStore = { request, cookies: [] };
  const result = await requestContext.run(store, fn);
  return { result, cookies: store.cookies };
}

function getStore(): RequestStore {
  const store = requestContext.getStore();
  if (!store)
    throw new Error(
      "No request context — are you inside a server component or action?",
    );
  return store;
}

export function getRequest(): Request {
  return getStore().request;
}

export function setRequest(request: Request): void {
  getStore().request = request;
}

// ─── Manifest tracking ─────────────────────────────────────────────────

export function runWithCacheManifest<T>(
  scope: ManifestScope,
  fn: () => Promise<T>,
): Promise<T> {
  return manifestContext.run(scope, fn);
}

export function getCurrentCacheManifest(): ManifestScope | undefined {
  return manifestContext.getStore();
}

export class HoistingViolationError extends Error {
  readonly partialId: string;
  readonly newKey: string;
  readonly previousKeys: string[];
  constructor(partialId: string, newKey: string, previousKeys: string[]) {
    super(
      `Partial "${partialId}" read "${newKey}" on this render, but its previous ` +
        `renders didn't read it. Request accessors (getCookie / getHeader / ` +
        `getSearchParam / getPathname) must be called unconditionally at the ` +
        `top of the component body, like React hooks. Move the read above ` +
        `any conditional branching, or — if the input genuinely shouldn't ` +
        `participate in the cache key — pass it through cache.vary instead. ` +
        `(previous keys: [${previousKeys.join(", ")}])`,
    );
    this.name = "HoistingViolationError";
    this.partialId = partialId;
    this.newKey = newKey;
    this.previousKeys = previousKeys;
  }
}

function trackAccess(kind: string, name: string): void {
  const scope = manifestContext.getStore();
  if (!scope) return;
  const key = `${kind}:${name}`;
  if (scope.current.has(key)) return;
  if (scope.stored !== null && !scope.stored.has(key)) {
    throw new HoistingViolationError(scope.partialId, key, [...scope.stored].sort());
  }
  scope.current.add(key);
}

/**
 * Given a manifest (from a prior render), resolve each tracked key
 * against the current request and return a values map. Used by
 * `<Cache>` to derive a cache key before running the Partial body on
 * subsequent requests.
 *
 * Does NOT participate in tracking — we're reading on behalf of the
 * cache layer, not the user's component.
 */
export function resolveManifest(manifest: Set<string>): Record<string, string> {
  const store = getStore();
  const url = new URL(store.request.url);
  const values: Record<string, string> = {};
  for (const spec of manifest) {
    const colonIdx = spec.indexOf(":");
    if (colonIdx < 0) continue;
    const kind = spec.slice(0, colonIdx);
    const name = spec.slice(colonIdx + 1);
    switch (kind) {
      case "cookie":
        values[spec] = readCookieRaw(store, name) ?? "";
        break;
      case "header":
        values[spec] = store.request.headers.get(name) ?? "";
        break;
      case "url":
        values[spec] =
          name === "_pathname"
            ? url.pathname
            : (url.searchParams.get(name) ?? "");
        break;
      default:
        values[spec] = "";
    }
  }
  return values;
}

// ─── Tracked accessors ─────────────────────────────────────────────────

function readCookieRaw(store: RequestStore, name: string): string | undefined {
  // Check cookies set during this request first (e.g., by a server action
  // that ran before the re-render). These are in Set-Cookie format.
  for (let i = store.cookies.length - 1; i >= 0; i--) {
    const match = store.cookies[i].match(new RegExp(`^${name}=([^;]*)`));
    if (match) return match[1];
  }
  // Fall back to the incoming request Cookie header.
  const header = store.request.headers.get("cookie") ?? "";
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match?.[1];
}

export function getCookie(name: string): string | undefined {
  trackAccess("cookie", name);
  return readCookieRaw(getStore(), name);
}

export function getHeader(name: string): string | null {
  trackAccess("header", name.toLowerCase());
  return getStore().request.headers.get(name);
}

export function getSearchParam(name: string): string | null {
  trackAccess("url", name);
  return new URL(getStore().request.url).searchParams.get(name);
}

export function getPathname(): string {
  trackAccess("url", "_pathname");
  return new URL(getStore().request.url).pathname;
}

export function setCookie(
  name: string,
  value: string,
  maxAge = 60 * 60 * 24 * 30,
): void {
  const store = getStore();
  store.cookies.push(
    `${name}=${value}; Path=/; Max-Age=${maxAge}; SameSite=Lax`,
  );
}
