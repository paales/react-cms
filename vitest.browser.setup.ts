/**
 * Browser-mode Vitest setup. Runs before each test file in a real
 * Chromium tab (see `vitest.browser.config.ts`).
 *
 * React 19 checks `IS_REACT_ACT_ENVIRONMENT` to decide whether
 * `act(...)` is supported; without it every act call warns. We do
 * want act support here (browser tests that drive user interactions
 * need a way to flush scheduled updates), so flip it on.
 */
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
