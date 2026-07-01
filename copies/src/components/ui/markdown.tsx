"use client"

import "katex/dist/katex.min.css"
import { Suspense, lazy } from "react"

/**
 * Markdown renderer — a thin wrapper over Streamdown for trusted,
 * complete markdown (docs, notes; not a partial token stream).
 *
 * This module is the client-reference boundary and stays deliberately
 * tiny: the Streamdown implementation and its plugin stack (KaTeX,
 * the shiki highlighter core, the mermaid glue) are the heaviest
 * client dependencies in the app, so they load through `React.lazy`
 * in their own async chunk — pages that never render markdown never
 * download them. Rendering options and the URL-resolution remark
 * plugin live in `markdown-impl.tsx`.
 *
 * KaTeX's stylesheet is imported here (eagerly) rather than in the
 * impl chunk so server-rendered math never paints unstyled while the
 * impl chunk is still in flight.
 */
const MarkdownImpl = lazy(() => import("./markdown-impl.tsx"))

export function Markdown(props: { children: string; className?: string; baseUrl?: string }) {
  // SSR renders the full markdown through the lazy module (React
  // resolves lazies server-side), so the fallback is only visible on a
  // client-side navigation while the impl chunk loads.
  return (
    <Suspense fallback={null}>
      <MarkdownImpl {...props} />
    </Suspense>
  )
}
