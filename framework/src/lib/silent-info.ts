/**
 * Framework-internal navigation `info` brand — the pure, eager guard.
 *
 * The Navigation API's `info` option is a one-shot payload delivered on
 * the resulting `navigate` event. Unlike `state` it is not persisted on
 * the history entry, so it's a natural channel for signalling intent
 * from initiator to listener.
 *
 * Two framework-internal paths go through `nav.navigate()` and need the
 * page-level intercept to stand down:
 *   - window-scoped silent nav (URL-only update, or caller dispatches
 *     its own targeted refetch via `enqueueRefetch`)
 *   - frame nav with explicit `history: "push" | "replace"` (caller
 *     dispatches `_dispatchFrameRefetch` itself)
 *
 * Frame navs with the default `history: "auto"` do NOT stamp silent
 * info — they patch state via `updateCurrentEntry`, which fires
 * `currententrychange` but not `navigate`, so there's nothing for the
 * listener to intercept.
 *
 * Any non-framework-branded `info` (user-provided via
 * `navigate(url, { info })`) passes straight through as a normal
 * page-level navigation.
 *
 * This lives apart from `refetch.ts` so it stays free of the channel
 * transport: `makeSilentInfo` must be callable SYNCHRONOUSLY inside a
 * navigate initiator's user gesture (the `nav.navigate({info})` call
 * that stamps the brand), and the page-level listener reads
 * `isFrameworkSilentInfo` inside the navigate event — neither can
 * afford to pull the heavy live layer into its static closure.
 */

export interface FrameworkSilentInfo {
  __framework: "silent-navigate"
  mode: "window" | "frame"
  name?: string
}

export function makeSilentInfo(mode: "window" | "frame", name?: string): FrameworkSilentInfo {
  return { __framework: "silent-navigate", mode, name }
}

export function isFrameworkSilentInfo(info: unknown): info is FrameworkSilentInfo {
  return (
    info != null &&
    typeof info === "object" &&
    (info as { __framework?: unknown }).__framework === "silent-navigate"
  )
}
