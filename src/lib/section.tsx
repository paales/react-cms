/**
 * Section Architecture
 *
 * Pages are flat lists of sections. Each section is independently
 * re-renderable — like Shopify's section architecture for React.
 *
 * <SectionList getSchema={getSchema} execute={execute} sections={sections}>
 *   <div key="header">
 *     <CartSection key="cart" />
 *   </div>
 *   <ProductGrid key="products" search={search} />
 *   <QueryDebug key="debug" />
 * </SectionList>
 *
 * The `key` of each child is its section ID. SectionList owns the resolve
 * lifecycle: discovery → compile → fetch. Components read the query root
 * via getQueryRoot() from the request context — no prop injection needed.
 *
 * Nested sections are first-class: `<div key="header"><Cart key="cart" /></div>`
 * renders cart independently of its parent. Refreshing "header" re-renders
 * the header layout but keeps the cached cart. Refreshing "cart" patches
 * just the cart into the cached header. Refreshing both updates everything.
 *
 * On full page render: all sections render, one GraphQL query.
 * On section re-fetch (?sections=hero,stats): only those sections render.
 * The client SectionListClient merges fresh sections with its cache,
 * so non-requested sections remain visible.
 */

import React, { type ReactNode } from "react";
import { AccessRecorder } from "./access-recorder.ts";
import { renderForDiscovery } from "./discovery.ts";
import { createProxy } from "./proxy-node.ts";
import { compileQuery } from "./query-compiler.ts";
import { SectionListClient } from "./section-client.tsx";
import type { SchemaGraph } from "./schema.ts";
import { setQueryRoot } from "../framework/context.ts";

interface SectionListProps {
  children: ReactNode;
  /** Schema provider for the GraphQL backend */
  getSchema: () => Promise<SchemaGraph>;
  /** Query executor for the GraphQL backend */
  execute: <T>(query: string) => Promise<T>;
  /** Comma-separated section IDs to render, or undefined for all */
  sections?: string | null;
}

interface SectionEntry {
  id: string;
  element: React.ReactElement;
  depth: number;
}

/** Walk the children tree to collect all keyed elements at any depth. */
function collectSections(children: ReactNode, depth = 0): SectionEntry[] {
  const entries: SectionEntry[] = [];
  React.Children.forEach(children, (child) => {
    if (React.isValidElement(child) && child.key != null) {
      entries.push({ id: String(child.key), element: child, depth });
      if (child.props.children) {
        entries.push(...collectSections(child.props.children, depth + 1));
      }
    }
  });
  return entries;
}

/**
 * Replace nested sections inside an element with keyed placeholders.
 * This allows parent sections to render without triggering discovery
 * or data fetching for their nested children — those render independently.
 */
function stripNested(element: React.ReactElement, nestedIds: Set<string>): React.ReactElement {
  const { children } = element.props;
  if (!children) return element;

  let changed = false;
  const result: ReactNode[] = [];

  React.Children.forEach(children, (child) => {
    if (React.isValidElement(child) && child.key != null && nestedIds.has(String(child.key))) {
      result.push(React.createElement("i", { key: child.key, hidden: true }));
      changed = true;
    } else if (React.isValidElement(child)) {
      const stripped = stripNested(child, nestedIds);
      if (stripped !== child) changed = true;
      result.push(stripped);
    } else {
      result.push(child);
    }
  });

  return changed ? React.cloneElement(element, {}, ...result) : element;
}

/**
 * Resolve boundary + section orchestrator.
 *
 * Owns the full lifecycle: runs discovery across all active sections,
 * compiles a single GraphQL query, fetches data, then stores the
 * data-backed proxy on the request context. Section components read
 * it via getQueryRoot() — no prop injection needed.
 *
 * Nested sections are extracted from their parents and rendered
 * independently. Parents get keyed placeholders; the client patches
 * cached nested sections back in via patchNested.
 */
export async function SectionList({
  children,
  getSchema,
  execute,
  sections,
}: SectionListProps) {
  // Collect all keyed elements (top-level and nested)
  const allSections = collectSections(children);
  const topLevel = allSections.filter((e) => e.depth === 0);
  const nested = allSections.filter((e) => e.depth > 0);
  const nestedIds = new Set(nested.map((e) => e.id));
  const allIds = topLevel.map((e) => e.id);

  const requestedIds = sections
    ? new Set(sections.split(",").map((s) => s.trim()))
    : null;

  // freshIds can include nested IDs (e.g., "cart" inside "header")
  const freshIds = requestedIds
    ? allSections.map((e) => e.id).filter((id) => requestedIds.has(id))
    : allSections.map((e) => e.id);

  // Active entries: sections to discover + render (may be nested)
  const activeEntries = requestedIds
    ? allSections.filter((e) => requestedIds.has(e.id))
    : allSections;

  // Strip nested sections from parents — they render independently.
  // Parents get keyed placeholders; the client patches cached children in.
  const activeChildren = activeEntries.map((e) =>
    nestedIds.has(e.id) ? e.element : stripNested(e.element, nestedIds),
  );

  // Phase 1: Discovery — phantom proxy on request context, walk active sections
  const schema = await getSchema();
  const queryTypeName = schema.getQueryTypeName();
  const recorder = new AccessRecorder();
  const phantom = createProxy(schema, queryTypeName, recorder);

  setQueryRoot(phantom, { query: "" });
  for (const child of activeChildren) {
    renderForDiscovery(child);
  }

  // Phase 2: Compile + fetch
  const tree = recorder.getAccessTree();
  const query = compileQuery(tree);
  const data = await execute<Record<string, unknown>>(query);

  // Phase 3: Store data proxy on request context for component rendering
  const dataProxy = createProxy(schema, queryTypeName, new AccessRecorder(), data);
  setQueryRoot(dataProxy, { query });

  // Return active children as-is — components read q via getQueryRoot()
  return (
    <SectionListClient freshIds={freshIds} allIds={allIds}>
      {activeChildren}
    </SectionListClient>
  );
}
