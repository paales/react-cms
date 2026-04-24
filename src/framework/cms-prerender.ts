/**
 * Dev-time block catalog prerender.
 *
 * Runs each registered block component in a stub CMS scope so the
 * editor can introspect its accessor reads ahead of time:
 *
 *   - Content fields (`getText`, `getEnum`, …) populate `contentFields`.
 *   - Entity references (`getReference`) populate `references`.
 *   - Slot declarations (`<Children>` / `<Child>`) populate `childSlots`.
 *
 * The resulting manifest powers the editor's block palette, form
 * field generation, and allow-constraint filtering for drop zones.
 *
 * Limitation — v1: reads that happen AFTER the first `await` in an
 * async block body are not captured. The prerender awaits the
 * component's return value, but an async block that does
 * `await fetchData()` may reject (no real data), and we don't
 * try-catch past the first await. For simple sync blocks (the
 * common case) this limitation doesn't apply. The hoisting
 * discipline (read accessors before any await) already makes this
 * the expected shape.
 */

import {
  createCmsScope,
  getBlockSpec,
  listBlockTypes,
  type ContentFieldKind,
  type SlotSpec,
} from "./cms-runtime.ts";
import {
  _runWithPrerenderCmsScope,
  runWithRequestAsync,
} from "./context.ts";

export interface BlockManifest {
  readonly type: string;
  readonly tags: readonly `.${string}`[];
  readonly contentFields: Record<string, ContentFieldKind>;
  readonly references: Record<string, string>;
  readonly childSlots: Record<string, SlotSpec>;
}

const PRERENDER_REQUEST = new Request("http://localhost/__prerender/");

export async function prerenderBlock(type: string): Promise<BlockManifest | null> {
  const spec = getBlockSpec(type);
  if (!spec) return null;
  const scopeId = `__prerender:${type}`;

  const scope = createCmsScope(scopeId, scopeId);
  await runWithRequestAsync(PRERENDER_REQUEST, async () => {
    await _runWithPrerenderCmsScope(scope, async () => {
      try {
        const out = spec.component();
        // Async blocks: await the top-level promise so a pre-await
        // accessor read that happens inside a microtask still lands
        // in the scope. Failures are swallowed — the manifest is
        // advisory.
        if (out instanceof Promise) {
          await out.catch(() => undefined);
        }
      } catch {
        // Sync render errors (component throws before returning) —
        // accessor reads up to the throw still populated the scope.
      }
    });
  });

  return {
    type,
    tags: spec.tags,
    contentFields: Object.fromEntries(scope.contentFields),
    references: Object.fromEntries(scope.references),
    childSlots: Object.fromEntries(scope.childSlots),
  };
}

export async function buildCatalogManifest(): Promise<
  Record<string, BlockManifest>
> {
  const out: Record<string, BlockManifest> = {};
  for (const type of listBlockTypes()) {
    const manifest = await prerenderBlock(type);
    if (manifest) out[type] = manifest;
  }
  return out;
}

let cached: Promise<Record<string, BlockManifest>> | null = null;

/**
 * Lazy-built manifest for every registered block type. The first
 * caller kicks off the prerender; subsequent callers await the same
 * promise. HMR invalidation drops the cache so an edit to a block
 * component rebuilds on the next request.
 */
export function getCatalogManifest(): Promise<
  Record<string, BlockManifest>
> {
  if (!cached) cached = buildCatalogManifest();
  return cached;
}

export function _invalidateCatalogManifest(): void {
  cached = null;
}

if (import.meta.hot) {
  import.meta.hot.on("vite:beforeUpdate", () => {
    cached = null;
  });
  import.meta.hot.on("vite:beforeFullReload", () => {
    cached = null;
  });
}
