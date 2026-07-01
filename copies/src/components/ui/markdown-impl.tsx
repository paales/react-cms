import type { AnchorHTMLAttributes } from "react"
import { Streamdown, defaultRemarkPlugins } from "streamdown"
import { code } from "@streamdown/code"
import { math } from "@streamdown/math"
import { mermaid } from "@streamdown/mermaid"

import { cn } from "@parton/copies/lib/utils"

// Streamdown plugins: `code` is syntax highlighting (200+ languages,
// lazy-loaded grammars), `mermaid` renders ```mermaid fences as SVG
// diagrams, `math` renders `$$…$$` KaTeX. Passing `plugins` replaces
// Streamdown's defaults, so the set is explicit.
const PLUGINS = { code, mermaid, math }

// A scheme (`https:`, `mailto:`), protocol-relative (`//host`), or
// fragment (`#x`) URL is left untouched; everything else is relative.
const ABSOLUTE_URL = /^[a-z][a-z0-9+.-]*:|^\/\//i

/**
 * Resolve a markdown URL the way the HTML spec resolves an `<a href>` —
 * relative URLs against `baseUrl` (the document's own path), absolute
 * and external URLs untouched. A throwaway origin lets `URL` do the
 * path math; we strip it back to an absolute path.
 */
function resolveAgainstBase(url: string, baseUrl: string): string {
  if (!url || url.startsWith("#") || ABSOLUTE_URL.test(url)) return url
  try {
    const resolved = new URL(url, `http://base.invalid${baseUrl}`)
    return resolved.pathname + resolved.search + resolved.hash
  } catch {
    return url
  }
}

// Minimal mdast shape the URL-rewrite walk touches.
interface MdNode {
  type?: string
  url?: string
  children?: MdNode[]
}

/**
 * remark plugin that rewrites link / image / reference-definition URLs
 * to absolute paths against `baseUrl`. This runs on the mdast, *before*
 * Streamdown's own URL handling (which otherwise resolves relative URLs
 * against the root, dropping the document's directory). Operating on the
 * tree — not the raw string — means code spans and fences are untouched.
 */
function remarkResolveUrls(baseUrl: string) {
  // The outer call captures `baseUrl`; the returned `() => transformer`
  // is the unified plugin (attacher) that `remarkPlugins` expects.
  return () => (tree: MdNode) => {
    const walk = (node: MdNode) => {
      if (
        (node.type === "link" || node.type === "image" || node.type === "definition") &&
        typeof node.url === "string"
      ) {
        node.url = resolveAgainstBase(node.url, baseUrl)
      }
      if (node.children) for (const child of node.children) walk(child)
    }
    walk(tree)
  }
}

// Render cross-doc links as same-tab anchors so the framework router
// intercepts them (Streamdown's default link opens a new tab).
function SameTabAnchor({
  node: _node,
  target: _target,
  rel: _rel,
  className,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown }) {
  return (
    <a className={cn("font-medium text-primary underline underline-offset-2", className)} {...props} />
  )
}

/**
 * The concrete Streamdown-backed renderer behind `Markdown`
 * (`markdown.tsx`). Loaded through `React.lazy` so Streamdown and its
 * plugin stack (KaTeX, the shiki highlighter core, the mermaid glue —
 * far and away the heaviest client dependencies) live in their own
 * async chunk, fetched only when a page actually renders markdown.
 * Default export — `React.lazy`'s module shape.
 *
 *   - `mode="static"` drops the streaming caret + re-animation.
 *   - `parseIncompleteMarkdown={false}` keeps trailing constructs
 *     intact — the source is a whole file, never mid-token.
 *   - `linkSafety={{ enabled: false }}` renders links as real `<a href>`
 *     rather than the default click-to-confirm `<button>`.
 *   - `baseUrl` (with the URL-rewrite remark plugin) resolves relative
 *     links / images (`./block.md`, `./live/01.png`) against the
 *     document's path. Streamdown's defaults are preserved and the
 *     resolver appended, since passing `remarkPlugins` replaces them.
 *   - `plugins` enables code highlighting, mermaid diagrams, and KaTeX
 *     math (see `PLUGINS`).
 *
 * Streamdown and its plugins style themselves with Tailwind utilities;
 * the app's `@source` directives over their dist generate them. Math
 * additionally needs KaTeX's own stylesheet, imported by `markdown.tsx`
 * (kept eager so server-rendered math never paints unstyled).
 */
export default function MarkdownImpl({
  children,
  className,
  baseUrl,
}: { children: string; className?: string; baseUrl?: string }) {
  const remarkPlugins = baseUrl
    ? [...Object.values(defaultRemarkPlugins), remarkResolveUrls(baseUrl)]
    : Object.values(defaultRemarkPlugins)
  return (
    <Streamdown
      mode="static"
      parseIncompleteMarkdown={false}
      linkSafety={{ enabled: false }}
      remarkPlugins={remarkPlugins}
      plugins={PLUGINS}
      components={{ a: SameTabAnchor }}
      className={cn("max-w-none text-sm leading-relaxed [&_h1]:mt-0", className)}
    >
      {children}
    </Streamdown>
  )
}
