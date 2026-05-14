/**
 * Path resolution regression. Two failure modes the runtime has to
 * survive:
 *
 *   1. `yarn dev` invokes vite from the workspace root (e2e-testing/),
 *      so process.cwd() is the workspace dir — a cwd-rooted SEARCH_DIRS
 *      would look under `e2e-testing/docs/notes/` (nonexistent) and
 *      miss the repo-level `docs/` tree.
 *
 *   2. `yarn preview` (and any post-build runtime) serves bundled code
 *      from `dist/rsc/`. `import.meta.dirname` inside a bundled chunk
 *      points at the dist tree, so a source-relative walk lands well
 *      outside the repo — what the user observed as `/Users/.../Sites/
 *      docs/notes/AA_CHAT_STREAMING.md`.
 *
 * The runtime trusts `process.env.DOCS_DIR` (set by each app's
 * `vite.config.ts` at startup) for both flows, and falls back to a
 * source-tree relative path for in-process vitest runs that bypass
 * vite.config.ts entirely.
 */

import path from "node:path"
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

const WORKSPACE_ROOT = path.resolve(import.meta.dirname, "../../../..")
const REPO_ROOT = path.resolve(WORKSPACE_ROOT, "..")

describe("chat log — markdown path resolution", () => {
  let priorCwd = ""
  let priorDocsDir: string | undefined
  beforeEach(() => {
    priorCwd = process.cwd()
    priorDocsDir = process.env.DOCS_DIR
    delete process.env.DOCS_DIR
    // Module scope captures SEARCH_DIRS at first import, so reset the
    // module graph before each test so the post-chdir cwd / post-env
    // mutation is what the newly-imported log.ts sees.
    vi.resetModules()
  })
  afterEach(() => {
    process.chdir(priorCwd)
    if (priorDocsDir === undefined) delete process.env.DOCS_DIR
    else process.env.DOCS_DIR = priorDocsDir
  })

  it("finds AA_CHAT_STREAMING.md from source-tree fallback when DOCS_DIR is unset", async () => {
    // Mirror `yarn workspace @react-cms/e2e-testing dev` without the
    // vite.config-set env var — the source-tree fallback walks four
    // levels up from `log.ts` and lands on the repo `docs/`.
    process.chdir(WORKSPACE_ROOT)
    const { readLog, _clearLogs } = await import("../log.ts")
    const { runWithRequestAsync } = await import(
      "@react-cms/framework/runtime/context.ts"
    )
    try {
      await runWithRequestAsync(new Request("http://t/"), async () => {
        const read = await readLog("AA_CHAT_STREAMING", 0)
        expect(read.done).toBe(false)
        expect(read.text.length).toBeGreaterThan(0)
      })
    } finally {
      _clearLogs("all")
    }
  })

  it("respects DOCS_DIR when running outside a source tree (bundled-preview scenario)", async () => {
    // Simulate `yarn preview`: cwd lands somewhere unhelpful and the
    // bundle is no longer at the source-relative offset the fallback
    // assumes. With DOCS_DIR set by vite.config.ts, the runtime still
    // finds the markdown.
    process.chdir(REPO_ROOT)
    process.env.DOCS_DIR = path.resolve(REPO_ROOT, "docs")
    const { readLog, _clearLogs } = await import("../log.ts")
    const { runWithRequestAsync } = await import(
      "@react-cms/framework/runtime/context.ts"
    )
    try {
      await runWithRequestAsync(new Request("http://t/"), async () => {
        const read = await readLog("AA_CHAT_STREAMING", 0)
        expect(read.done).toBe(false)
        expect(read.text.length).toBeGreaterThan(0)
      })
    } finally {
      _clearLogs("all")
    }
  })
})
