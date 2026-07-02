/**
 * Parton actions — server-side handlers declared on a parton spec.
 *
 * An action is a server function that:
 *   - Receives the same `scope` prop bag as the parton's Render (resolved
 *     schema + match params).
 *   - Receives caller-supplied `args`, auto-typed as `Partial<{cellName:
 *     cellType}>` from the schema's cells.
 *   - Runs inside `runInvalidationTransaction`, so its writes (cell.set
 *     calls + framework auto-writes of args to matching cells) commit
 *     atomically; a throw rolls everything back.
 *
 * Wire id: `<partonId>/<actionName>`. The action handler is registered
 * here at parton-construction time; the `"use server"` dispatcher in
 * `runtime/parton-actions.ts` looks it up by id when invoked.
 *
 * Two callable surfaces:
 *   - **Render prop**: framework injects each action into Render's prop
 *     bag as `(args) => Promise<R>` — partition pre-bound to the
 *     parton's render-time partition. A client `<button onClick={() =>
 *     save({...})}>` lands on the same partition the parton resolved
 *     against, regardless of URL changes between render and click.
 *   - **Module-level**: `Spec.actions.X` is the same dispatch, partition
 *     NOT bound — resolves from the active request URL or via explicit
 *     `{vary}` override. Use for cross-context calls fired from outside
 *     the owning parton's render tree.
 *
 * `usePartonAction(actionProp)` wraps the prop ref with optimistic-aware
 * tracking: when called, args matching schema cells push into the cell-
 * client batcher's optimistic map; on settle (success or failure) the
 * optimistic values clear and the cell falls back to its server-
 * authoritative value (which a successful action commit will have
 * shifted; a failed action leaves unchanged → optimistic UI rewinds).
 */

/**
 * Action handler. The framework calls this with `(scope, args)` after
 * resolving the parton's vary + schema for the current request.
 *
 * `scope` shape: `match params + resolved schema`. Same prop
 * bag Render receives, minus `children`.
 *
 * `args` shape: caller-supplied. The framework iterates `args` keys
 * post-handler and auto-writes any whose key matches a cell in the
 * schema. Author code can also explicitly `cell.set` inside the
 * handler; both happen inside the same transaction.
 *
 * Throwing aborts the transaction — pending writes (auto-write +
 * explicit) all roll back.
 */
export type ActionHandler<Scope = unknown, Args = unknown, R = unknown> = (
  scope: Scope,
  args: Args,
) => Promise<R>

const actionRegistry = new Map<string, ActionHandler>()

export function getActionById(id: string): ActionHandler | undefined {
  return actionRegistry.get(id)
}

export function registerAction(id: string, handler: ActionHandler): void {
  actionRegistry.set(id, handler)
}

/** Test-only — wipe the registry between tests. */
export function _clearActionRegistry(): void {
  actionRegistry.clear()
  schemaRegistry.clear()
  inlineCellRegistry.clear()
}

// ─── Schema callback registry ─────────────────────────────────────────
//
// The action dispatcher needs to re-run a parton's schema callback to
// resolve cells against the bound partition. The schema callback is
// captured at parton-construction time and stored here keyed by
// partonId. Mirrors the spec catalog's vary storage but lives outside
// it so partial.tsx's catalog stays minimal.

/**
 * The schema callback shape — receives the parton-scoped `localCell`
 * factory (and optionally `{cms}` for blocks via the broader scope),
 * returns a record of cells + plain values.
 *
 * Loose typing here because the registry stores callbacks across all
 * partons regardless of their specific vary / schema types. The render
 * path narrows via the public types in `partial.tsx`.
 */
export type SchemaCallback = (
  scope: import("./cell.ts").ScopedCellFactories<unknown>,
) => Record<string, unknown>

const schemaRegistry = new Map<string, SchemaCallback>()

export function getSchemaForParton(partonId: string): SchemaCallback | undefined {
  return schemaRegistry.get(partonId)
}

export function registerSchema(partonId: string, schema: SchemaCallback): void {
  schemaRegistry.set(partonId, schema)
}

// ─── Inline-cell registry ─────────────────────────────────────────────
//
// Inline `localCell("key", …)` cells are discovered at RENDER (declared in
// the body), not at construction like the schema callback. The action
// dispatcher runs in a SEPARATE request, where the render's per-request
// snapshot store isn't visible — so the discovery is recorded here, in a
// module-global registry keyed by parton id, exactly like `schemaRegistry`.
// `resolveSchemaForAction` reads it so an `actions` handler resolves an
// inline cell by key without a render. Keyed by the parton's effective id
// (== the spec id for a singleton placement, which is what the action's
// bound id carries).

const inlineCellRegistry = new Map<string, Map<string, import("./cell.ts").InlineCellRecord>>()

export function registerInlineCell(
  partonId: string,
  key: string,
  record: import("./cell.ts").InlineCellRecord,
): void {
  let m = inlineCellRegistry.get(partonId)
  if (!m) {
    m = new Map()
    inlineCellRegistry.set(partonId, m)
  }
  m.set(key, record)
}

export function getInlineCellsForParton(
  partonId: string,
): ReadonlyMap<string, import("./cell.ts").InlineCellRecord> | undefined {
  return inlineCellRegistry.get(partonId)
}

/**
 * Resolved action handed to Render in its prop bag. Carries:
 *
 * - `ref`: bound server-action ref `__partonAction.bind(null, actionId,
 *   partitionKey)`. Calling `(args)` fires the dispatcher with the bound
 *   actionId + partition + caller args.
 * - `writes`: argKey → cellId map for the schema's cells. The client's
 *   `usePartonAction` reads this to know which optimistic-value slots
 *   to bump when the caller fires the action.
 *
 * The whole object crosses Flight: `ref` as a bound server-action ref
 * (natively serializable), `writes` as a plain object.
 */
export interface ResolvedAction<Args = Record<string, unknown>, R = unknown> {
  readonly __partonAction: true
  readonly ref: (args: Args) => Promise<R>
  readonly writes: Readonly<Record<string, string>>
}

export function isResolvedAction(value: unknown): value is ResolvedAction {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __partonAction?: boolean }).__partonAction === true
  )
}
