/**
 * Request context for server components and server actions.
 *
 * Uses AsyncLocalStorage to make the incoming request (cookies, headers)
 * available anywhere during a render or action, and to collect
 * Set-Cookie headers for the response.
 */

import { AsyncLocalStorage } from "node:async_hooks";

interface RequestStore {
  request: Request;
  cookies: string[];
  /** Query root proxy set by Partials, read by partial components via getQueryRoot() */
  queryRoot?: unknown;
  /** Resolve metadata (compiled query string) */
  queryMeta?: { query: string };
}

const requestContext = new AsyncLocalStorage<RequestStore>();

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

export function getCookie(name: string): string | undefined {
  const store = getStore();
  // Check cookies set during this request first (e.g., by a server action
  // that ran before the re-render). These are in Set-Cookie format.
  for (let i = store.cookies.length - 1; i >= 0; i--) {
    const match = store.cookies[i].match(new RegExp(`^${name}=([^;]*)`));
    if (match) return match[1];
  }
  // Fall back to the incoming request Cookie header
  const header = store.request.headers.get("cookie") ?? "";
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match?.[1];
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

export function setQueryRoot(proxy: unknown, meta: { query: string }): void {
  const store = getStore();
  store.queryRoot = proxy;
  store.queryMeta = meta;
}

export function getQueryRoot(): any {
  const store = getStore();
  if (!store.queryRoot) {
    throw new Error(
      "getQueryRoot() must be called inside a Partials render",
    );
  }
  return store.queryRoot;
}

export function getQueryMeta(): { query: string } {
  const store = getStore();
  if (!store.queryMeta) {
    throw new Error(
      "getQueryMeta() must be called inside a Partials render",
    );
  }
  return store.queryMeta;
}
