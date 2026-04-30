/**
 * Durable streaming log per notes file — the "LLM-ish" source the chat demo
 * consumes.
 *
 * Why a log and not the raw file-read:
 *
 *   - The source isn't actually resumable (real LLM APIs aren't either). So
 *     we read once, append to an in-memory chunk array, and every Flight
 *     reader pulls from that array. Resume = continue from cursor.
 *   - Disconnects (a `<ResumeTail>` reload, a full page reload, a browser
 *     navigation) don't cancel the source producer. It keeps appending.
 *   - On resume the flat-prefix render dumps chunks 0..cursor synchronously
 *     and the fresh `<Piece>` chain picks up from `cursor`.
 *
 * The "tokens" are paragraphs of the file, with a small simulated delay per
 * chunk so the recursion actually has something to stream and the bounded-
 * depth compaction seam is observable.
 */

import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { getScope, isTestMode } from "@react-cms/framework/framework/context.ts"

// Demo cadence (human-perceptible trickle). Playwright workers hit
// the fast-path below so the e2e suite doesn't pay the 100 ms × 10 s
// budget per streaming test.
const CHUNK_DELAY_MS = 100
const CHUNK_CHAR_SIZE = 25
// Total time budget per stream. At 25 char / 100 ms that's ~100 chunks
// and ~2.5 KB of content before the producer stops and emits done.
// Keeps the demo feeling like a slow trickle without producing walls of
// text for long notes files.
const STREAM_BUDGET_MS = 10_000

// Test-mode overrides — fast enough that chat-notes specs settle in
// well under a second, slow enough that Suspense boundaries still
// reveal chunks one at a time (so the compaction seam is observable).
const CHUNK_DELAY_MS_TEST = 5
const STREAM_BUDGET_MS_TEST = 3_000

// Files are addressed by basename (no .md). The producer searches
// these directories in order; first match wins. Lets the demo stream
// any markdown in the project — current docs, framework internals,
// active research, archived design proposals — without the chat
// overlay having to hardcode where each file lives.
const SEARCH_DIRS = [
  resolve(process.cwd(), "docs/notes"),
  resolve(process.cwd(), "docs/reference"),
  resolve(process.cwd(), "docs/internals"),
  resolve(process.cwd(), "docs/archive"),
]

async function readMarkdown(fileId: string): Promise<string> {
  let firstError: unknown = null
  for (const dir of SEARCH_DIRS) {
    try {
      return await readFile(resolve(dir, `${fileId}.md`), "utf8")
    } catch (err) {
      if (firstError == null) firstError = err
    }
  }
  throw firstError ?? new Error(`chat log: no markdown for '${fileId}'`)
}

interface MessageLog {
  chunks: string[]
  done: boolean
  error: Error | null
  waiters: Set<() => void>
  aborted: boolean
}

// Per-scope log store so parallel Playwright workers (each scoped via
// the `x-test-scope` header) don't share producer state — one test's
// in-flight stream shouldn't be visible to another worker reading the
// same fileId.
const scopes = new Map<string, Map<string, MessageLog>>()

function logs(): Map<string, MessageLog> {
  const scope = getScope()
  let m = scopes.get(scope)
  if (!m) {
    m = new Map()
    scopes.set(scope, m)
  }
  return m
}

function ensureLog(fileId: string): MessageLog {
  const bucket = logs()
  let log = bucket.get(fileId)
  if (log) return log
  log = {
    chunks: [],
    done: false,
    error: null,
    waiters: new Set(),
    aborted: false,
  }
  bucket.set(fileId, log)
  // Snapshot the test-mode decision at producer start — it's tied to
  // the current scope's first request, not any later reader. Keeps
  // demo cadence for real users and fast cadence for Playwright.
  const fast = isTestMode()
  const chunkDelayMs = fast ? CHUNK_DELAY_MS_TEST : CHUNK_DELAY_MS
  const streamBudgetMs = fast ? STREAM_BUDGET_MS_TEST : STREAM_BUDGET_MS
  void runProducer(fileId, log, chunkDelayMs, streamBudgetMs)
  return log
}

async function runProducer(
  fileId: string,
  log: MessageLog,
  chunkDelayMs: number,
  streamBudgetMs: number,
): Promise<void> {
  const start = Date.now()
  try {
    const text = await readMarkdown(fileId)
    // Hard-slice into fixed-length chunks so the stream feels like
    // token-by-token reveal rather than paragraph drops. A word-boundary
    // splitter would look nicer but variable chunk sizes make compaction
    // timing unpredictable; fixed-size keeps the seam easy to reason about.
    for (let i = 0; i < text.length; i += CHUNK_CHAR_SIZE) {
      if (log.aborted) return
      if (Date.now() - start >= streamBudgetMs) break
      await new Promise((r) => setTimeout(r, chunkDelayMs))
      if (log.aborted) return
      log.chunks.push(text.slice(i, i + CHUNK_CHAR_SIZE))
      wakeAll(log)
    }
  } catch (e) {
    log.error = e instanceof Error ? e : new Error(String(e))
  } finally {
    log.done = true
    wakeAll(log)
  }
}

function wakeAll(log: MessageLog): void {
  const waiters = [...log.waiters]
  log.waiters.clear()
  for (const w of waiters) w()
}

export interface LogRead {
  /** The chunk text, or empty string when `done`. */
  text: string
  /** True when no more chunks will ever be produced for this cursor. */
  done: boolean
}

/**
 * Await the chunk at `cursor`. Resolves when the producer has appended at
 * least `cursor + 1` chunks, OR the producer has finished with fewer chunks
 * (in which case `done: true`).
 */
export async function readLog(fileId: string, cursor: number): Promise<LogRead> {
  const log = ensureLog(fileId)
  while (true) {
    if (log.error) throw log.error
    if (cursor < log.chunks.length) {
      return { text: log.chunks[cursor], done: false }
    }
    if (log.done) return { text: "", done: true }
    await new Promise<void>((resolve) => log.waiters.add(resolve))
  }
}

/**
 * Return the chunks already produced in range [0, cursor). Used for the flat
 * prefix render after a compaction reload. Never blocks — if fewer than
 * `cursor` chunks are available (reload landed before producer caught up),
 * the returned array is shorter, and the `<Piece>` chain starting at the
 * actual length will fill the rest.
 */
export function readLogPrefix(fileId: string, cursor: number): string[] {
  const log = ensureLog(fileId)
  return log.chunks.slice(0, Math.max(0, cursor))
}

/**
 * Test-only: wipe logs. No argument (or `"all"`): every scope —
 * what the debug toolbar's flush button and HMR dispose hooks use.
 * Pass a specific scope to target a single worker's logs.
 */
export function _clearLogs(scope?: string | "all"): void {
  const wipe = (m: Map<string, MessageLog>) => {
    // Mark live producers aborted so they exit their loop instead of
    // continuing to burn CPU / setTimeout scheduling in the background
    // after a test has moved on.
    for (const log of m.values()) {
      log.aborted = true
      wakeAll(log)
    }
    m.clear()
  }
  if (scope === undefined || scope === "all") {
    for (const m of scopes.values()) wipe(m)
    scopes.clear()
    return
  }
  const m = scopes.get(scope)
  if (!m) return
  wipe(m)
  scopes.delete(scope)
}
