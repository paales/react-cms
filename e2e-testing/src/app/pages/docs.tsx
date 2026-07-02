/**
 * /docs{/:filepath*} — browsable viewer for the repo's `docs/` tree.
 *
 * One wrapper spec gates `/docs` and every path beneath it. The named
 * `:filepath*` captures the slash-spanning tail (`reference/intro.md`),
 * so each file is its own cache variant; `vary` folds the file's mtime
 * in as the freshness signal, so editing a doc on disk re-renders it.
 * `keepalive: false` — doc bodies are large and stateless, not worth
 * parking on every cross-route navigation.
 *
 * Rendering splits on file kind (see `docs-fs.ts`):
 *   - markdown → Streamdown.
 *   - code / text → a fenced block (shiki highlighting).
 *   - image → `<img>`; bytes are served by `serveDocAsset` in the RSC
 *     entry so embedded screenshots resolve through the same route.
 *   - a directory (or bare `/docs`) → a recursive tree index.
 */

import { readFile, stat } from "node:fs/promises"
import { statSync } from "node:fs"
import { parton, notFound, registerDepKind, type RenderArgs } from "@parton/framework"
import { Markdown } from "@parton/copies/components/ui/markdown"
import { DocsSidebar } from "../components/docs-sidebar.tsx"
import {
  classify,
  codeLang,
  readDocTree,
  resolveDocPath,
  type DocTreeNode,
  type ResolvedDoc,
} from "./docs-fs.ts"

// ─── Chrome ─────────────────────────────────────────────────────────────

function Breadcrumb({ rel }: { rel: string }) {
  const parts = rel ? rel.split("/") : []
  return (
    <nav className="mb-5 text-sm text-muted-foreground">
      <a href="/docs" className="hover:text-foreground hover:underline">
        docs
      </a>
      {parts.map((part, i) => {
        const href = `/docs/${parts.slice(0, i + 1).join("/")}`
        const last = i === parts.length - 1
        return (
          <span key={href}>
            <span className="px-1.5 text-muted-foreground/50">/</span>
            {last ? (
              <span className="text-foreground">{part}</span>
            ) : (
              <a href={href} className="hover:text-foreground hover:underline">
                {part}
              </a>
            )}
          </span>
        )
      })}
    </nav>
  )
}

// ─── Tree index (bare /docs + any directory) ────────────────────────────

const KIND_ICON: Record<DocTreeNode["kind"], string> = {
  dir: "📁",
  markdown: "📄",
  code: "🧩",
  image: "🖼️",
  binary: "📦",
}

// The directory index lists a folder's immediate children (the sidebar
// owns the full recursive tree). Folders link to their own index page;
// files link to their rendered view.
function DirList({ nodes }: { nodes: DocTreeNode[] }) {
  return (
    <ul className="grid gap-1 sm:grid-cols-2">
      {nodes.map((node) => (
        <li key={node.rel}>
          <a
            href={`/docs/${node.rel}`}
            className={
              node.kind === "dir"
                ? "flex items-center gap-2 rounded-md border bg-card px-3 py-2 font-medium hover:bg-muted"
                : "flex items-center gap-2 rounded-md px-3 py-1.5 text-muted-foreground hover:text-foreground hover:underline"
            }
          >
            <span className="shrink-0 opacity-80">{KIND_ICON[node.kind]}</span>
            <span className="truncate">
              {node.name}
              {node.kind === "dir" ? "/" : ""}
            </span>
          </a>
        </li>
      ))}
    </ul>
  )
}

async function DirIndex({ rel }: { rel: string }) {
  const tree = await readDocTree(rel)
  if (tree.length === 0) {
    return <p className="text-sm text-muted-foreground">This folder is empty.</p>
  }
  return (
    <section>
      {rel === "" ? (
        <p className="mb-5 max-w-prose text-sm text-muted-foreground">
          Everything under <code className="rounded bg-muted px-1.5 py-0.5">docs/</code> —
          framework reference, internals, active research notes, and the archive. Pick a file
          from the tree on the left, or browse the sections below. Markdown renders inline; code
          and config files show with syntax highlighting.
        </p>
      ) : null}
      <DirList nodes={tree} />
    </section>
  )
}

// ─── Single-file views ──────────────────────────────────────────────────

function longestBacktickRun(s: string): number {
  let max = 0
  let cur = 0
  for (const ch of s) {
    if (ch === "`") {
      cur += 1
      if (cur > max) max = cur
    } else {
      cur = 0
    }
  }
  return max
}

async function FileView({ resolved }: { resolved: ResolvedDoc }) {
  const kind = classify(resolved.ext)

  if (kind === "image") {
    return (
      <img
        src={`/docs/${resolved.rel}`}
        alt={resolved.rel}
        className="max-w-full rounded-lg border bg-card"
      />
    )
  }

  if (kind === "binary") {
    return (
      <div className="rounded-lg border bg-muted/30 p-6 text-sm text-muted-foreground">
        <code className="font-mono">{resolved.rel}</code> is a binary file — nothing to render.
      </div>
    )
  }

  const content = await readFile(resolved.abs, "utf8")
  const baseUrl = `/docs/${resolved.rel}`
  if (kind === "markdown") {
    return <Markdown baseUrl={baseUrl}>{content}</Markdown>
  }

  // Code / text: fence the contents so Streamdown highlights them. The
  // fence is one backtick longer than the longest run in the source so
  // a file that itself contains ``` can't break out of the block.
  const fence = "`".repeat(Math.max(3, longestBacktickRun(content) + 1))
  return (
    <Markdown baseUrl={baseUrl}>{`${fence}${codeLang(resolved.ext)}\n${content}\n${fence}`}</Markdown>
  )
}

// ─── Page wrapper ───────────────────────────────────────────────────────

// Tracked file-freshness read: the doc's mtime folds into the fp
// through a registered dep kind (re-read at every fold), so an edited
// file re-renders on the next visit instead of fp-skipping into stale
// bytes. A missing file folds "0" — the render handles the 404.
const docMtime = registerDepKind("docmtime", (abs) => {
  try {
    return String(statSync(abs).mtimeMs)
  } catch {
    return "0"
  }
})

async function DocsRender({ filepath }: { filepath?: string } & RenderArgs) {
  const resolved = resolveDocPath(filepath ?? "")
  if (!resolved) notFound()
  docMtime(resolved.abs)
  const stats = await stat(resolved.abs).catch(() => notFound())
  const tree = await readDocTree()
  const title = resolved.rel === "" ? "Docs" : resolved.rel
  return (
    <main className="pb-[40vh]">
      <title>{`${title} — parton docs`}</title>
      <div className="flex gap-6">
        <aside
          data-testid="docs-sidebar"
          className="sticky top-8 hidden max-h-[calc(100vh-4rem)] w-56 shrink-0 overflow-y-auto md:block"
        >
          <DocsSidebar tree={tree} currentPath={resolved.rel} />
        </aside>
        <div data-testid="docs-content" className="min-w-0 flex-1">
          <Breadcrumb rel={resolved.rel} />
          {stats.isDirectory() ? (
            <DirIndex rel={resolved.rel} />
          ) : (
            <FileView resolved={resolved} />
          )}
        </div>
      </div>
    </main>
  )
}

export const DocsPage = parton(DocsRender, {
  match: "/docs/:filepath*",
  keepalive: false,
})
