/**
 * Ambient declarations for the vendored react-server-dom bundles that
 * `@vitejs/plugin-rsc` re-exports under `vendor/…`. These ship as plain
 * `.js` with no `.d.ts`, so without this they resolve to implicit
 * `any` (TS7016).
 *
 * Only the two entrypoints + the handful of exports the framework
 * actually calls are declared. The manifest arguments are vendored RSC
 * internals with no stable public type — they're typed `unknown` here
 * (callers pass permissive Proxy manifests). Delete / tighten if the
 * plugin starts shipping its own types.
 */

declare module "@vitejs/plugin-rsc/vendor/react-server-dom/server.edge" {
  export function renderToReadableStream<T>(
    data: T,
    clientManifest?: unknown,
    options?: unknown,
  ): ReadableStream<Uint8Array>
}

declare module "@vitejs/plugin-rsc/vendor/react-server-dom/client.edge" {
  export function createFromReadableStream<T>(
    stream: ReadableStream<Uint8Array>,
    options?: { serverConsumerManifest?: unknown } & Record<string, unknown>,
  ): Promise<T>
}
