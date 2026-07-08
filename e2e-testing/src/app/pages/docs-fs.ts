/**
 * Filesystem layer for the `/docs` viewer.
 *
 * The viewer renders the repo's `docs/` tree at request time. These
 * helpers resolve a URL-supplied path to a real file inside the docs
 * root, classify it, walk the tree for the index, and serve image
 * bytes for `<img>` subresource requests.
 *
 * Path resolution mirrors `chat/log.ts`:
 *   1. `DOCS_DIR` env — set by `vite.config.ts` to the repo-level
 *      `docs/`. Robust across dev / build / preview regardless of cwd
 *      or where the bundle lands.
 *   2. `import.meta.dirname`-relative — fallback for source-tree runs
 *      (vitest) that don't load the app's vite config. Only correct
 *      when this file sits at its authored path.
 */

import { readFile, readdir } from "node:fs/promises"
import { extname, resolve, sep } from "node:path"

export function docsRoot(): string {
  if (process.env.DOCS_DIR) return resolve(process.env.DOCS_DIR)
  return resolve(import.meta.dirname, "../../../../docs")
}

export type DocKind = "markdown" | "code" | "image" | "binary"

// ext → shiki language id for code-file fences.
const CODE_LANG: Record<string, string> = {
  ".ts": "ts",
  ".tsx": "tsx",
  ".mts": "ts",
  ".cts": "ts",
  ".js": "js",
  ".jsx": "jsx",
  ".mjs": "js",
  ".cjs": "js",
  ".json": "json",
  ".css": "css",
  ".html": "html",
  ".htm": "html",
  ".txt": "text",
  ".graphql": "graphql",
  ".gql": "graphql",
  ".yml": "yaml",
  ".yaml": "yaml",
  ".sh": "bash",
}

// ext → MIME for image subresources served by `serveDocAsset`.
const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
}

export function classify(ext: string): DocKind {
  if (ext === ".md" || ext === ".markdown") return "markdown"
  if (ext in CODE_LANG) return "code"
  if (ext in IMAGE_MIME) return "image"
  return "binary"
}

export function codeLang(ext: string): string {
  return CODE_LANG[ext] ?? "text"
}

export function imageMime(ext: string): string | null {
  return IMAGE_MIME[ext] ?? null
}

export interface ResolvedDoc {
  /** Absolute path, guaranteed inside the docs root. */
  abs: string
  /** Posix-style path relative to the root (`"reference/intro.md"`). */
  rel: string
  /** Lowercase extension including the dot (`".md"`), or `""`. */
  ext: string
}

/**
 * Resolve a URL path segment to a file inside the docs root, or `null`
 * when it escapes (path traversal). The guard is on the *resolved*
 * absolute path being inside the root — the real signal — not a string
 * scan of the raw input.
 */
export function resolveDocPath(filepath: string): ResolvedDoc | null {
  const root = docsRoot()
  const abs = resolve(root, filepath)
  if (abs !== root && !abs.startsWith(root + sep)) return null
  const rel =
    abs === root
      ? ""
      : abs
          .slice(root.length + 1)
          .split(sep)
          .join("/")
  return { abs, rel, ext: extname(abs).toLowerCase() }
}

export interface DocTreeNode {
  name: string
  /** Posix path relative to the docs root. */
  rel: string
  kind: "dir" | DocKind
  children?: DocTreeNode[]
}

/**
 * Recursively read the docs tree under `relDir` (root when empty).
 * Dotfiles are skipped (`.DS_Store`, editor scratch state). Directories
 * sort before files, then alphabetically.
 */
export async function readDocTree(relDir = ""): Promise<DocTreeNode[]> {
  const abs = relDir ? resolve(docsRoot(), relDir) : docsRoot()
  const entries = await readdir(abs, { withFileTypes: true })
  const nodes: DocTreeNode[] = []
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      nodes.push({ name: entry.name, rel, kind: "dir", children: await readDocTree(rel) })
    } else {
      nodes.push({ name: entry.name, rel, kind: classify(extname(entry.name).toLowerCase()) })
    }
  }
  nodes.sort(
    (a, b) =>
      (a.kind === "dir" ? 0 : 1) - (b.kind === "dir" ? 0 : 1) || a.name.localeCompare(b.name),
  )
  return nodes
}

/**
 * Serve raw bytes for an image under `/docs/…` so `<img>` subresource
 * requests (direct links and screenshots embedded in markdown) load
 * through the same route the pages render under. Returns `null` when
 * the request isn't a docs image GET, so the caller falls through to
 * the normal RSC/SSR pipeline that renders HTML doc pages.
 */
export async function serveDocAsset(request: Request): Promise<Response | null> {
  if (request.method !== "GET") return null
  const { pathname } = new URL(request.url)
  if (!pathname.startsWith("/docs/")) return null
  const mime = imageMime(extname(pathname).toLowerCase())
  if (!mime) return null
  const resolved = resolveDocPath(decodeURIComponent(pathname.slice("/docs/".length)))
  if (!resolved) return new Response("Not found", { status: 404 })
  try {
    const bytes = await readFile(resolved.abs)
    return new Response(bytes, {
      headers: { "content-type": mime, "cache-control": "no-cache" },
    })
  } catch {
    return new Response("Not found", { status: 404 })
  }
}
