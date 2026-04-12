"use client";

/**
 * Client-side section merge coordinator.
 *
 * Caches section elements across renders. On full renders, all sections
 * are cached — both top-level and nested (which arrive as independent
 * entries). On partial renders, only fresh sections update the cache.
 *
 * Nested sections are supported: if "cart" is nested inside "header",
 * the server sends them as separate entries. The client caches each
 * independently. When rendering, patchNested walks the cached header
 * and replaces keyed placeholders with their cached (or fresh) content.
 *
 * This means refreshing "header" re-renders the header layout but keeps
 * the cached cart. Refreshing "cart" patches just the cart into the
 * cached header. No redundant data fetching.
 */

import {
  Children,
  cloneElement,
  isValidElement,
  useRef,
  type ReactNode,
} from "react";

interface SectionListClientProps {
  freshIds: string[];
  allIds: string[];
  children: ReactNode;
}

/**
 * Clone an element tree, replacing any keyed child whose cache entry
 * differs from the current child. Recurses into replacements to handle
 * deeply nested sections (e.g., header > nav > cart).
 */
function patchNested(node: ReactNode, cache: Map<string, ReactNode>): ReactNode {
  if (!isValidElement(node) || !node.props.children) return node;

  let changed = false;
  const patched: ReactNode[] = [];

  Children.forEach(node.props.children, (child) => {
    if (isValidElement(child) && child.key != null) {
      const cached = cache.get(String(child.key));
      if (cached && cached !== child) {
        // Replace with cached version, then recurse to patch ITS nested sections
        patched.push(patchNested(cached, cache));
        changed = true;
        return;
      }
    }
    const p = patchNested(child, cache);
    if (p !== child) changed = true;
    patched.push(p);
  });

  return changed ? cloneElement(node, {}, ...patched) : node;
}

export function SectionListClient({
  freshIds,
  allIds,
  children,
}: SectionListClientProps) {
  const cacheRef = useRef(new Map<string, ReactNode>());

  // Index fresh children by key (direct children only — nested sections
  // arrive as their own independent entries, not buried inside parents)
  Children.forEach(children, (child) => {
    if (isValidElement(child) && child.key != null) {
      cacheRef.current.set(String(child.key), child);
    }
  });

  // Render all top-level sections from cache, patching nested content in
  return (
    <>
      {allIds.map((id) => {
        const cached = cacheRef.current.get(id);
        if (!cached) return null;
        return patchNested(cached, cacheRef.current);
      })}
    </>
  );
}
