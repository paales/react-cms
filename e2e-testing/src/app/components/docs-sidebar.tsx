"use client"

/**
 * Docs file-tree sidebar — the persistent navigation rail for the
 * `/docs` viewer. Built on the `file-tree` ai-element: folders are
 * collapsible, the ancestors of the current file start expanded, and
 * the active file is highlighted. Files are plain `<a href>` so the
 * framework's router intercepts them for in-app navigation.
 *
 * The tree data is computed on the server (`readDocTree`) and handed
 * down as serializable props; this component only owns the
 * expand/collapse interaction.
 */

import { FileCodeIcon, FileTextIcon, ImageIcon, type LucideIcon } from "lucide-react"
import {
  FileTree,
  FileTreeFile,
  FileTreeFolder,
  FileTreeIcon,
  FileTreeName,
} from "@parton/copies/components/ai-elements/file-tree"
import type { DocTreeNode } from "../pages/docs-fs.ts"

const FILE_ICON: Record<string, LucideIcon> = {
  markdown: FileTextIcon,
  code: FileCodeIcon,
  image: ImageIcon,
  binary: FileTextIcon,
}

function Nodes({ nodes }: { nodes: DocTreeNode[] }) {
  return (
    <>
      {nodes.map((node) =>
        node.kind === "dir" ? (
          <FileTreeFolder key={node.rel} path={node.rel} name={node.name}>
            <Nodes nodes={node.children ?? []} />
          </FileTreeFolder>
        ) : (
          <FileTreeFile key={node.rel} path={node.rel} name={node.name}>
            <a href={`/docs/${node.rel}`} className="flex min-w-0 flex-1 items-center gap-1">
              <span className="size-4 shrink-0" />
              <FileTreeIcon>
                {(() => {
                  const Icon = FILE_ICON[node.kind] ?? FileTextIcon
                  return <Icon className="size-4 text-muted-foreground" />
                })()}
              </FileTreeIcon>
              <FileTreeName>{node.name}</FileTreeName>
            </a>
          </FileTreeFile>
        ),
      )}
    </>
  )
}

export function DocsSidebar({ tree, currentPath }: { tree: DocTreeNode[]; currentPath: string }) {
  // Expand the folders on the path to the current file so the tree
  // opens to where you are; everything else starts collapsed.
  const expanded = new Set<string>()
  if (currentPath) {
    const parts = currentPath.split("/")
    for (let i = 1; i < parts.length; i++) expanded.add(parts.slice(0, i).join("/"))
  }
  return (
    <FileTree
      defaultExpanded={expanded}
      selectedPath={currentPath}
      className="border-none bg-transparent text-[0.8rem]"
    >
      <Nodes nodes={tree} />
    </FileTree>
  )
}
