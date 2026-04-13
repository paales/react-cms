/**
 * GraphQL data pipeline for Partials.
 *
 * Separated from the partial orchestrator — this handles:
 *   discovery → compile → parallel fetch → data proxy per child
 *
 * The partial orchestrator handles filtering, templates, and client merge.
 * It passes only the active children here. This pipeline processes whatever
 * it receives — it doesn't know about partials, namespaces, or caching.
 *
 * Usage as a declarative wrapper inside <Partials>:
 *
 *   <Partials namespace="pokemon">
 *     <GraphQLPipeline getSchema={getSchema} execute={execute}>
 *       <HeroPartial key="hero" pokemonId={1} />
 *       <StatsPartial key="stats" pokemonId={1} />
 *     </GraphQLPipeline>
 *   </Partials>
 *
 * GraphQLPipeline is a marker component — never rendered by React directly.
 * Partials intercepts it, extracts its props, and runs the pipeline internally.
 */

import React from "react";
import { AccessRecorder } from "./access-recorder.ts";
import { renderForDiscovery } from "./discovery.ts";
import { createProxy } from "./proxy-node.ts";
import { compileQuery } from "./query-compiler.ts";
import { getCachedData, setCachedData } from "./partial-cache.ts";
import type { SchemaGraph } from "./schema.ts";
import { setQueryRoot } from "../framework/context.ts";

export interface PipelineContext {
  /** Per-child data cache config: { ttl: seconds, tags: string[] } */
  cacheConfig: Map<string, { ttl: number; tags: string[] }>;
}

export interface PipelineResult {
  children: React.ReactNode[];
  fetchMs: number;
  /** Compiled query per child ID */
  queries: Map<string, string>;
  /** Child IDs whose data came from cache */
  cacheHits: Set<string>;
}

export type PartialPipeline = (
  children: React.ReactElement[],
  context: PipelineContext,
) => Promise<PipelineResult>;

// ─── GraphQLPipeline marker component ─────────────────────────────────

export interface GraphQLPipelineProps {
  getSchema: () => Promise<SchemaGraph>;
  execute: <T>(query: string) => Promise<T>;
  children: React.ReactNode;
}

/**
 * Declarative marker for a GraphQL data pipeline inside <Partials>.
 *
 * Not rendered by React — Partials detects this element by its static
 * `_isPipeline` property, extracts `getSchema`/`execute` from props,
 * and runs the pipeline internally for the active children in this group.
 *
 * Multiple GraphQLPipeline instances can coexist under one <Partials>
 * for multi-backend pages (e.g., Pokemon + Magento in the same layout).
 */
export function GraphQLPipeline(_props: GraphQLPipelineProps): never {
  throw new Error(
    "GraphQLPipeline must be a child of <Partials>. " +
    "It is a declarative marker, not a renderable component.",
  );
}

/** @internal Partials uses this to identify pipeline wrapper elements */
GraphQLPipeline._isPipeline = true as const;

/** @internal Partials uses this to create the pipeline function from element props */
GraphQLPipeline._createPipeline = (
  props: GraphQLPipelineProps,
): PartialPipeline => createGraphQLPipeline(props.getSchema, props.execute);

/**
 * Create a pipeline that discovers data needs via proxy access recording,
 * compiles GraphQL queries, and fetches data in parallel.
 *
 * Usage:
 *   const pipeline = createGraphQLPipeline(getSchema, execute);
 *   <Partials namespace="pokemon" pipeline={pipeline}>
 */
export function createGraphQLPipeline(
  getSchema: () => Promise<SchemaGraph>,
  execute: <T>(query: string) => Promise<T>,
): PartialPipeline {
  return async (children, { cacheConfig }) => {
    const schema = await getSchema();
    const queryTypeName = schema.getQueryTypeName();
    const fetchStart = Date.now();

    // Phase 1: Per-child discovery — each child gets its own access recorder
    const plans = children.map((child) => {
      const id = String(child.key ?? "unknown");
      const recorder = new AccessRecorder();
      const phantom = createProxy(schema, queryTypeName, recorder);
      setQueryRoot(phantom, { query: "" });
      renderForDiscovery(child);
      const tree = recorder.getAccessTree();
      const query = compileQuery(tree);
      return { child, id, recorder, query };
    });

    // Phase 2: Parallel fetch — check data cache first, fetch on miss
    const responses = await Promise.all(
      plans.map(async (plan) => {
        const config = cacheConfig.get(plan.id);
        if (config && config.ttl > 0) {
          const cached = getCachedData(plan.query);
          if (cached) return { data: cached, fromCache: true };
        }
        const data = await execute<Record<string, unknown>>(plan.query);
        if (config && config.ttl > 0) {
          setCachedData(plan.query, data, config.ttl, config.tags);
        }
        return { data, fromCache: false };
      }),
    );
    const fetchMs = Date.now() - fetchStart;

    // Phase 3: Wrap each child with its data proxy
    const wrappedChildren = plans.map((plan, i) => {
      const dataProxy = createProxy(
        schema,
        queryTypeName,
        plan.recorder,
        responses[i].data,
      );
      return (
        <PipelineScope
          key={plan.id}
          proxy={dataProxy}
          meta={{ query: plan.query }}
        >
          {plan.child}
        </PipelineScope>
      );
    });

    const queries = new Map(plans.map((p) => [p.id, p.query]));
    const cacheHits = new Set(
      plans.filter((_, i) => responses[i].fromCache).map((p) => p.id),
    );

    return { children: wrappedChildren, fetchMs, queries, cacheHits };
  };
}

/**
 * Sets the query root proxy for a child's subtree.
 *
 * React's flight server renders server components depth-first:
 * PipelineScope sets the proxy, React renders children (which call
 * getQueryRoot()), then moves to the next sibling. This gives each
 * child its own isolated data proxy.
 */
function PipelineScope({
  proxy,
  meta,
  children,
}: {
  proxy: unknown;
  meta: { query: string };
  children: React.ReactNode;
}) {
  setQueryRoot(proxy, meta);
  return <>{children}</>;
}
