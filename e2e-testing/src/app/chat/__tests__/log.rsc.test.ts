/**
 * Path resolution regression: the dev server's cwd is the e2e-testing
 * workspace root, not the repo root. SEARCH_DIRS must resolve to the
 * repo-level `docs/` regardless of where the runtime was launched from
 * — otherwise opening the chat overlay against the default fileId
 * (`AA_CHAT_STREAMING`) blows up with ENOENT for
 * `<workspace>/docs/notes/AA_CHAT_STREAMING.md`.
 */

import path from "node:path"
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

const WORKSPACE_ROOT = path.resolve(import.meta.dirname, "../../../..")

describe("chat log — markdown path resolution", () => {
  let priorCwd = ""
  beforeEach(() => {
    priorCwd = process.cwd()
    // Module scope captures SEARCH_DIRS at first import, so reset the
    // module graph before each test so the post-chdir cwd is what the
    // newly-imported log.ts sees.
    vi.resetModules()
  })
  afterEach(() => {
    process.chdir(priorCwd)
  })

  it("finds AA_CHAT_STREAMING.md when launched from the workspace root", async () => {
    // Mirror `yarn workspace @react-cms/e2e-testing dev` — vite invokes
    // its plugins from the workspace root, so process.cwd() is the
    // workspace dir, not the repo dir.
    process.chdir(WORKSPACE_ROOT)
    const { readLog, _clearLogs } = await import("../log.ts")
    const { runWithRequestAsync } = await import(
      "@react-cms/framework/runtime/context.ts"
    )
    try {
      await runWithRequestAsync(new Request("http://t/"), async () => {
        const read = await readLog("AA_CHAT_STREAMING", 0)
        expect(read.done).toBe(false)
        // Producer streams 25-char chunks; the first one should be a
        // non-empty prefix of the markdown file.
        expect(read.text.length).toBeGreaterThan(0)
      })
    } finally {
      _clearLogs("all")
    }
  })
})
