/**
 * jsdom doesn't implement the Navigation API. Install a minimal shim
 * that delegates `navigate` / `back` / `forward` to the `history`
 * counterparts jsdom DOES support, so unit tests can exercise code
 * that calls `windowNav().navigate(url, { silent: true })` etc.
 *
 * No event dispatch, no entry list, no traversal — just enough for
 * URL mutation + the event-listener hooks to be callable. Any test
 * that needs real navigation semantics should be a Playwright test.
 */

// Tell React 19 that this environment supports `act(...)` — otherwise
// renders that flush effects print a noisy warning for every call.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type NavigateOpts = {
  state?: unknown
  info?: unknown
  history?: "auto" | "push" | "replace"
}

if (typeof window !== "undefined" && !("navigation" in globalThis)) {
  const listeners = new Map<string, Set<(ev: Event) => void>>()
  const makeResult = () => ({
    committed: Promise.resolve(),
    finished: Promise.resolve(),
  })

  const nav = {
    activation: null,
    transition: null,
    canGoBack: false,
    canGoForward: false,
    get currentEntry() {
      return {
        id: "",
        index: 0,
        key: "",
        sameDocument: true,
        url: window.location.href,
        getState: () => history.state ?? null,
      }
    },
    entries: () => [],
    navigate(url: string, opts?: NavigateOpts) {
      if (opts?.history === "replace") {
        history.replaceState(opts?.state ?? null, "", url)
      } else {
        history.pushState(opts?.state ?? null, "", url)
      }
      return makeResult()
    },
    reload() {
      return makeResult()
    },
    traverseTo() {
      return makeResult()
    },
    back() {
      history.back()
      return makeResult()
    },
    forward() {
      history.forward()
      return makeResult()
    },
    updateCurrentEntry() {},
    addEventListener(type: string, cb: (ev: Event) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(cb)
    },
    removeEventListener(type: string, cb: (ev: Event) => void) {
      listeners.get(type)?.delete(cb)
    },
    dispatchEvent() {
      return true
    },
  }

  ;(globalThis as { navigation?: unknown }).navigation = nav
}
