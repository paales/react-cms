/**
 * CMS editor — MVE (minimum viable editor).
 *
 * Three-pane layout:
 *   - Left: tree of every Partial currently in the CMS store (draft
 *     merged over published). Click an entry to select it (adds
 *     `?select=<cmsId>` to the editor URL).
 *   - Center: `<Partial frame="preview">` rendering the real site at
 *     `/cms-demo` with `?cms-draft=1` so the runtime reads drafts.
 *   - Right: form for the selected Partial. Inputs derive from the
 *     catalog manifest (for block-typed entries) unioned with the
 *     currently stored fields (so code-declared Partials that have
 *     a draft entry are also editable).
 *
 * Save: a server action (`saveCmsFields`) merges form data into the
 * selected node's default config and writes to draft. Returns an
 * `invalidate` directive so the preview refetches the edited
 * Partial without a full reload.
 *
 * Publish: `publishCmsDraft` copies draft → published and clears
 * the draft file. Editor invalidates the tree Partial so the list
 * reflects the merge.
 *
 * Scope deferred to later iterations (see notes/CMS_EDITOR.md):
 *   - Per-configuration match tabs — v1 edits only the default
 *     (`match: {}`) config.
 *   - Block palette — authors can't add new slot entries yet.
 *   - Drag-drop.
 *   - Rich entity pickers.
 *   - Draft isolation per author/session.
 */

import { getRequest, setCookie } from "../../framework/context.ts";
import {
  CMS_DRAFT_COOKIE,
  listAllCmsNodes,
  listBlockTypes,
  lookupDraftNode,
  parseSlotEntryId,
  type CmsConfig,
  type ContentFieldKind,
  type MatchClause,
} from "../../framework/cms-runtime.ts";
import {
  getCatalogManifest,
  type BlockManifest,
} from "../../framework/cms-prerender.ts";
import { Partial } from "../../lib";
import { ROOT } from "../../lib/partial-context.ts";
import { Card, CardContent } from "@/components/ui/card";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { CmsDemoPage } from "./cms-demo.tsx";
import { CmsEditTreeLink } from "../components/cms-edit-tree-link.tsx";
import {
  addBlockToSlot,
  moveBlockInSlot,
  publishCmsDraft,
  removeBlockFromSlot,
  resetCmsDraft,
  saveCmsFields,
} from "../actions/cms.ts";

const PREVIEW_FRAME_URL = "/cms-demo?cms-draft=1";

export function CmsEditPage() {
  // Draft mode is authoritative here. Belt-and-suspenders:
  //   - Cookie (set for this response + sent on every subsequent
  //     request, including server-action POSTs + cache-mode refetches
  //     of CMS-aware Partials inside the preview frame). The frame
  //     scope doesn't survive cache-mode snapshot reconstruction,
  //     so the page request's cookie is what the CMS read falls
  //     back to.
  //   - Query param on the frame URL (wins on the initial page
  //     render because the cookie hasn't round-tripped yet).
  setCookie(CMS_DRAFT_COOKIE, "1");

  // NOTE: `?select=` and `?config=` are read INSIDE TreeContents and
  // FieldPanel (not here). That way a cache-mode refetch of
  // `#cms-edit-tree` / `#cms-edit-fields` triggered by selector-
  // targeted nav (`<CmsEditTreeLink>`) re-resolves the URL state
  // freshly — the snapshots can't bake in a stale `selected` closure.

  return (
    <Partial parent={ROOT} selector="#cms-edit-root">
      <div
        className="grid gap-0 -mx-8 -my-8 min-h-screen"
        style={{
          gridTemplateColumns: "280px minmax(0, 1fr) 360px",
        }}
      >
        <aside
          className="overflow-y-auto border-r bg-muted/30 p-4"
          data-testid="cms-edit-tree-pane"
        >
          <TreePanel />
        </aside>
        <main
          className="overflow-y-auto p-4"
          data-testid="cms-edit-preview-pane"
        >
          <PreviewPanel />
        </main>
        <aside
          className="overflow-y-auto border-l bg-muted/30 p-4"
          data-testid="cms-edit-field-pane"
        >
          <Partial parent={ROOT} selector="#cms-edit-fields">
            <FieldPanel />
          </Partial>
        </aside>
      </div>
    </Partial>
  );
}

// ─── Preview ───────────────────────────────────────────────────────────

function PreviewPanel() {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            Preview
          </p>
          <p className="text-sm font-medium">{PREVIEW_FRAME_URL}</p>
        </div>
        <form action={publishCmsDraft}>
          <Button type="submit" size="sm" variant="outline">
            Publish draft → live
          </Button>
        </form>
      </div>
      <div className="rounded-xl border bg-background p-4">
        <Partial
          parent={ROOT}
          selector="#cms-edit-preview"
          frame="preview"
          frameUrl={PREVIEW_FRAME_URL}
        >
          <CmsDemoPage />
        </Partial>
      </div>
    </div>
  );
}

// ─── Tree ──────────────────────────────────────────────────────────────

function TreePanel() {
  return (
    <Partial parent={ROOT} selector="#cms-edit-tree">
      <div>
        <p className="mb-3 text-xs uppercase tracking-wide text-muted-foreground">
          Content tree
        </p>
        <TreeContents />
      </div>
    </Partial>
  );
}

function TreeContents() {
  // Read URL state INSIDE the Partial so cache-mode refetches see the
  // fresh `?select=` value — the snapshot's content runs again on
  // every refetch.
  //
  // Why getRequest() and not getSearchParam(): the preview Partial's
  // <Partial frame="preview"> mutates the per-request frame-scope
  // cell to its own URL (`/cms-demo?cms-draft=1`). React 19's RSC
  // renderer interleaves siblings — TreeContents/FieldPanel may run
  // AFTER the preview's FrameWrapper has set the cell, so a tracked
  // `getSearchParam` would resolve against the frame URL (no
  // `?select=` param) instead of the editor's page URL. This is the
  // sibling-interleaving sharp edge documented in CLAUDE.md /
  // notes/FRAME_SCOPING.md. `getRequest()` returns the page request
  // unconditionally, sidestepping the leak. The editor route has no
  // <Partial cache>, so cache-key tracking isn't needed here.
  const selected = pageSearchParam("select");
  const entries = listAllCmsNodes();
  const blockTypes = listBlockTypes();
  if (entries.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        The store is empty. Partials appear here once they're saved to
        the draft or committed to <code>content.json</code>.
      </p>
    );
  }

  // Pre-compute per-slot child index lists so each slot-child row knows
  // its position (for ↑ / ↓ disable state).
  const slotPositions = new Map<string, { index: number; count: number }>();
  for (const entry of entries) {
    if (entry.kind === "node" && entry.parentId && entry.slotName) {
      const slotKey = `${entry.parentId}:${entry.slotName}`;
      const seen = slotPositions.get(slotKey);
      if (seen) {
        slotPositions.set(slotKey, { index: seen.count, count: seen.count + 1 });
      } else {
        slotPositions.set(slotKey, { index: 0, count: 1 });
      }
    }
  }
  // Reset and re-walk to assign per-row positions correctly (the count
  // pass above produced totals, but each row's `index` overwrote the
  // previous). Compute per-row indexes by scanning entries in order.
  const rowIndex = new Map<string, number>();
  const slotCounts = new Map<string, number>();
  for (const entry of entries) {
    if (entry.kind === "node" && entry.parentId && entry.slotName) {
      const slotKey = `${entry.parentId}:${entry.slotName}`;
      const next = (slotCounts.get(slotKey) ?? 0);
      rowIndex.set(entry.id, next);
      slotCounts.set(slotKey, next + 1);
    }
  }

  return (
    <ul className="space-y-1">
      {entries.map((entry) => {
        if (entry.kind === "slot") {
          return (
            <SlotTreeRow
              key={entry.id}
              parentCmsId={entry.parentId!}
              slotName={entry.slotName!}
              depth={entry.depth}
              blockTypes={blockTypes}
            />
          );
        }
        const isSelected = entry.id === selected;
        const label = entry.displayName ?? `#${entry.id}`;
        const slotKey =
          entry.parentId && entry.slotName
            ? `${entry.parentId}:${entry.slotName}`
            : null;
        const idx = slotKey != null ? (rowIndex.get(entry.id) ?? 0) : 0;
        const total = slotKey != null ? (slotCounts.get(slotKey) ?? 1) : 1;
        const inSlot = entry.parentId && entry.slotName;
        return (
          <li
            key={entry.id}
            style={{ paddingLeft: `${entry.depth * 12}px` }}
            className="flex items-center gap-1"
          >
            <CmsEditTreeLink
              href={`/cms-edit?select=${encodeURIComponent(entry.id)}`}
              className={cn(
                "flex flex-1 items-center gap-2 rounded-md px-2 py-1 text-sm transition-colors min-w-0",
                isSelected
                  ? "bg-primary/10 text-primary"
                  : "hover:bg-muted",
              )}
              testId={`cms-edit-tree-entry-${entry.id}`}
              selected={isSelected}
            >
              <span className="flex-1 truncate">{label}</span>
              {entry.type && (
                <Badge
                  variant="secondary"
                  className="px-1.5 py-0 text-[0.7rem]"
                >
                  {entry.type}
                </Badge>
              )}
              {entry.draftOnly ? (
                <Badge
                  variant="outline"
                  className="border-amber-400/60 px-1.5 py-0 text-[0.65rem] text-amber-600 dark:text-amber-400"
                  data-testid={`cms-edit-tree-entry-${entry.id}-draft-badge`}
                >
                  draft
                </Badge>
              ) : entry.hasDraft ? (
                <Badge
                  variant="outline"
                  className="border-blue-400/60 px-1.5 py-0 text-[0.65rem] text-blue-600 dark:text-blue-400"
                  data-testid={`cms-edit-tree-entry-${entry.id}-modified-badge`}
                >
                  modified
                </Badge>
              ) : null}
            </CmsEditTreeLink>
            {inSlot && (
              <SlotChildControls
                parentCmsId={entry.parentId!}
                slotName={entry.slotName!}
                childCmsId={entry.id}
                index={idx}
                total={total}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Slot intermediary tree row — non-clickable label + the +add-block
 * palette inline. Hosting the palette here is what makes slot
 * intermediaries functional (not just organizational), so they exist
 * for every slot regardless of how many slots a parent has.
 */
function SlotTreeRow({
  parentCmsId,
  slotName,
  depth,
  blockTypes,
}: {
  parentCmsId: string;
  slotName: string;
  depth: number;
  blockTypes: string[];
}) {
  const id = `slot:${parentCmsId}:${slotName}`;
  return (
    <li
      style={{ paddingLeft: `${depth * 12}px` }}
      className="flex items-center gap-1"
      data-testid={`cms-edit-tree-entry-${id}`}
    >
      <span
        className="flex flex-1 items-center gap-2 rounded-md px-2 py-1 text-xs italic text-muted-foreground min-w-0"
        data-testid={`cms-edit-tree-slot-label-${parentCmsId}-${slotName}`}
      >
        <span aria-hidden className="text-muted-foreground/70">
          ▸
        </span>
        <span className="flex-1 truncate">{slotName}</span>
      </span>
      {blockTypes.map((type) => (
        <form
          key={type}
          action={addBlockToSlot.bind(null, parentCmsId, slotName, type)}
          className="contents"
        >
          <button
            type="submit"
            className="rounded px-1 text-[0.7rem] text-muted-foreground hover:bg-muted hover:text-foreground"
            title={`Add ${type} block`}
            data-testid={`cms-edit-slot-add-${parentCmsId}-${slotName}-${type}`}
          >
            + {type}
          </button>
        </form>
      ))}
    </li>
  );
}

/**
 * Per-slot-child inline action buttons in the tree — ↑ / ↓ / ×.
 * Replaces the standalone SlotPanel rows that used to live in the
 * right-pane field panel.
 */
function SlotChildControls({
  parentCmsId,
  slotName,
  childCmsId,
  index,
  total,
}: {
  parentCmsId: string;
  slotName: string;
  childCmsId: string;
  index: number;
  total: number;
}) {
  return (
    <span className="flex shrink-0 items-center">
      <form
        action={moveBlockInSlot.bind(null, parentCmsId, slotName, childCmsId, "up")}
        className="contents"
      >
        <button
          type="submit"
          className="rounded px-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
          disabled={index === 0}
          title="Move up"
          aria-label={`Move ${childCmsId} up`}
        >
          ↑
        </button>
      </form>
      <form
        action={moveBlockInSlot.bind(null, parentCmsId, slotName, childCmsId, "down")}
        className="contents"
      >
        <button
          type="submit"
          className="rounded px-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
          disabled={index >= total - 1}
          title="Move down"
          aria-label={`Move ${childCmsId} down`}
        >
          ↓
        </button>
      </form>
      <form
        action={removeBlockFromSlot.bind(null, parentCmsId, slotName, childCmsId)}
        className="contents"
      >
        <button
          type="submit"
          className="rounded px-1 text-red-600/80 hover:bg-red-50 hover:text-red-700 dark:hover:bg-red-950/40"
          title="Remove"
          aria-label={`Remove ${childCmsId}`}
          data-testid={`cms-edit-slot-remove-${childCmsId}`}
        >
          ×
        </button>
      </form>
    </span>
  );
}

// ─── Field form ────────────────────────────────────────────────────────

async function FieldPanel() {
  // Read URL state inside the Partial — selector-targeted refetches
  // (`<CmsEditTreeLink>`) re-execute this body, so URL changes are
  // picked up without re-running ancestors. See `pageSearchParam`
  // for why we bypass `getSearchParam` (frame-scope leak from the
  // sibling preview Partial).
  const selected = pageSearchParam("select");
  const configIndexRaw = pageSearchParam("config");
  const configIndex = configIndexRaw != null ? Number(configIndexRaw) : null;
  if (!selected) {
    return (
      <div className="text-sm text-muted-foreground">
        Select a Partial from the tree to edit its fields.
      </div>
    );
  }

  // Slot intermediaries are non-selectable in the tree (rendered as
  // a plain span, not a CmsEditTreeLink), so `selected` should never
  // be a `slot:*` id. Belt-and-braces: if a `slot:*` id arrives via a
  // direct URL, we just prompt the author to pick a node — slot
  // management lives entirely in the tree now (inline +add /
  // ↑↓× buttons), so there's nothing to render in the field panel
  // for a slot selection.
  if (parseSlotEntryId(selected)) {
    return (
      <div className="text-sm text-muted-foreground">
        Slots aren't selectable. Use the inline buttons in the tree to
        add, reorder, or remove blocks; click a block to edit its
        fields here.
      </div>
    );
  }

  const node = lookupDraftNode(selected);
  const catalog = await getCatalogManifest();
  const manifest = node?.type ? catalog[node.type] : undefined;
  // Detect "this id has unpublished changes" — the same condition
  // that drives the tree's modified badge.
  const hasDraft = listAllCmsNodes().some(
    (e) => e.id === selected && e.hasDraft,
  );
  // Default tab: the `match: {}` config if present (most permissive);
  // else the first config. For a node without any configs yet, we
  // render a prompt + implicit "new default" on save.
  const configs = node?.configs ?? [];
  const effectiveIndex = pickEffectiveConfig(configs, configIndex);
  const currentConfig = effectiveIndex >= 0 ? configs[effectiveIndex] : null;
  const fieldMap = buildFieldMap(currentConfig, manifest);

  return (
    <div className="space-y-4">
      <div>
        <p className="text-xs uppercase tracking-wide text-muted-foreground">
          Selected
        </p>
        <p className="text-sm font-medium" data-testid="cms-edit-selected-id">
          {node?.displayName ?? `#${selected}`}
        </p>
        <p className="text-xs text-muted-foreground">id: {selected}</p>
      </div>

      {hasDraft && (
        <form action={resetCmsDraft.bind(null, selected)}>
          <Button
            type="submit"
            size="sm"
            variant="outline"
            className="border-blue-400/60 text-blue-700 hover:bg-blue-50 dark:text-blue-300 dark:hover:bg-blue-950/40"
            data-testid="cms-edit-reset-draft"
          >
            Reset draft → published
          </Button>
        </form>
      )}

      {configs.length > 0 && (
        <ConfigTabs
          selected={selected}
          configs={configs}
          activeIndex={effectiveIndex}
        />
      )}

      {Object.keys(fieldMap).length === 0 ? (
        <Card className="p-4">
          <CardContent className="px-0 text-sm text-muted-foreground">
            No fields on this configuration yet. For block-typed
            entries the catalog seeds the field list from the block's
            accessor reads; for code-declared Partials, saved fields
            appear here once written.
          </CardContent>
        </Card>
      ) : (
        <form
          action={saveCmsFields.bind(null, selected, effectiveIndex)}
          className="space-y-3"
          data-testid="cms-edit-field-form"
        >
          {Object.entries(fieldMap).map(([name, spec]) => (
            <FieldInput
              key={name}
              name={name}
              kind={spec.kind}
              value={spec.value}
            />
          ))}
          <BooleanSidecar
            fields={Object.entries(fieldMap)
              .filter(([, s]) => s.kind === "boolean")
              .map(([n]) => n)}
          />
          <div className="flex gap-2">
            <Button type="submit" size="sm">
              Save to draft
            </Button>
            <a
              href={cmsEditHref(selected, effectiveIndex)}
              className={buttonVariants({ size: "sm", variant: "ghost" })}
            >
              Discard changes
            </a>
          </div>
        </form>
      )}
    </div>
  );
}

// ─── Config tabs ──────────────────────────────────────────────────────

function pickEffectiveConfig(
  configs: readonly CmsConfig[],
  requested: number | null,
): number {
  if (configs.length === 0) return -1;
  if (requested != null && requested >= 0 && requested < configs.length) {
    return requested;
  }
  const defaultIdx = configs.findIndex(
    (c) => Object.keys(c.match).length === 0,
  );
  return defaultIdx >= 0 ? defaultIdx : 0;
}

function ConfigTabs({
  selected,
  configs,
  activeIndex,
}: {
  selected: string;
  configs: readonly CmsConfig[];
  activeIndex: number;
}) {
  return (
    <div data-testid="cms-edit-config-tabs">
      <p className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">
        Configuration
      </p>
      <div className="flex flex-wrap gap-1">
        {configs.map((cfg, idx) => {
          const isActive = idx === activeIndex;
          const label = formatMatchLabel(cfg.match);
          return (
            <a
              key={idx}
              href={cmsEditHref(selected, idx)}
              className={cn(
                "rounded-md border px-2 py-1 text-xs font-medium transition-colors",
                isActive
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-transparent hover:bg-muted",
              )}
              data-testid={`cms-edit-config-tab-${idx}`}
              data-active={isActive}
            >
              {label}
            </a>
          );
        })}
      </div>
      <p className="mt-1 text-[0.7rem] text-muted-foreground">
        Editing this configuration writes only to its field set. Other
        configurations (and the cascade fallback) stay untouched.
      </p>
    </div>
  );
}

/**
 * Collapse a match clause into a short human label for the tab.
 *
 *   {}                                         → "Default"
 *   {"url:variant": "A"}                       → "variant=A"
 *   {"url:variant": {in: ["A","B"]}}           → "variant∈A,B"
 *   {"pathname:/p/:slug": {slug: "alpha"}}     → "slug=alpha"
 *   {"pathname:/p/:slug": {slug: {in:[…]}}}    → "slug∈x,y"
 *   two or more keys                           → join with " · "
 */
export function formatMatchLabel(
  match: Record<string, MatchClause>,
): string {
  const entries = Object.entries(match);
  if (entries.length === 0) return "Default";
  const parts = entries.map(([key, clause]) => formatClause(key, clause));
  return parts.join(" · ");
}

function formatClause(key: string, clause: MatchClause): string {
  const colonIdx = key.indexOf(":");
  const kind = colonIdx > 0 ? key.slice(0, colonIdx) : key;
  const name = colonIdx > 0 ? key.slice(colonIdx + 1) : "";

  if (kind === "pathname") {
    if (typeof clause === "object" && clause !== null && !Array.isArray(clause)) {
      if ("in" in clause) return `${shortKey(name)}∈…`;
      const paramParts = Object.entries(
        clause as Record<string, ScalarOrIn>,
      ).map(([p, c]) => formatScalar(p, c));
      return paramParts.join(", ");
    }
    return shortKey(name);
  }
  return formatScalar(name, clause as ScalarOrIn);
}

type ScalarOrIn =
  | string
  | number
  | boolean
  | { in: ReadonlyArray<string | number> };

function formatScalar(name: string, clause: ScalarOrIn): string {
  if (typeof clause === "string") return `${name}=${clause}`;
  if (typeof clause === "number") return `${name}=${clause}`;
  if (typeof clause === "boolean") return `${name}=${clause}`;
  if (clause && typeof clause === "object" && "in" in clause) {
    return `${name}∈${clause.in.join(",")}`;
  }
  return name;
}

/**
 * Read a search param off the page request, bypassing the frame
 * scope cell. See the comment in TreeContents for why — the preview
 * Partial leaks its frame URL into the cell when this Partial's body
 * runs after it (sibling interleaving). The editor route has no
 * `<Partial cache>` so the cache-tracking that `getSearchParam` does
 * isn't needed here.
 */
function pageSearchParam(name: string): string | null {
  return new URL(getRequest().url).searchParams.get(name);
}

function shortKey(key: string): string {
  // For `pathname:/p/:slug` the full pattern is too verbose on a
  // tab. Strip everything but the last `:param` segment.
  const match = key.match(/:([^/]+)$/);
  return match ? match[1] : key;
}

function cmsEditHref(selected: string, configIndex: number): string {
  const sp = new URLSearchParams();
  sp.set("select", selected);
  if (configIndex >= 0) sp.set("config", String(configIndex));
  return `/cms-edit?${sp.toString()}`;
}

interface FieldSpec {
  kind: ContentFieldKind;
  value: unknown;
}

function buildFieldMap(
  config: CmsConfig | null,
  manifest: BlockManifest | undefined,
): Record<string, FieldSpec> {
  const out: Record<string, FieldSpec> = {};
  // Seed from the catalog so every field the block declares shows
  // up as an input, even when the current config hasn't set it yet
  // (cascade fallback will apply from a less-specific config).
  if (manifest) {
    for (const [name, kind] of Object.entries(manifest.contentFields)) {
      out[name] = {
        kind,
        value: config?.fields[name],
      };
    }
  }
  // Union currently-stored fields (covers code-declared Partials that
  // have a draft entry, and any fields saved before the catalog knew
  // about them).
  if (config) {
    for (const [name, value] of Object.entries(config.fields)) {
      if (name in out) continue;
      out[name] = { kind: inferKind(value), value };
    }
  }
  return out;
}

function inferKind(value: unknown): ContentFieldKind {
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "text";
}

function FieldInput({
  name,
  kind,
  value,
}: {
  name: string;
  kind: ContentFieldKind;
  value: unknown;
}) {
  const label = (
    <label
      htmlFor={`cms-edit-field-${name}`}
      className="mb-1 block text-xs font-medium text-muted-foreground"
    >
      {name}
      <span className="ml-2 text-[0.65rem] uppercase opacity-60">
        {kind}
      </span>
    </label>
  );
  const commonClass =
    "w-full rounded-md border border-input bg-background px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

  switch (kind) {
    case "number":
      return (
        <div>
          {label}
          <input
            id={`cms-edit-field-${name}`}
            type="number"
            name={name}
            defaultValue={String(value ?? 0)}
            className={commonClass}
            data-testid={`cms-edit-field-input-${name}`}
          />
          <input type="hidden" name={`__kind:${name}`} value="number" />
        </div>
      );
    case "boolean":
      return (
        <div className="flex items-center gap-2">
          <input
            id={`cms-edit-field-${name}`}
            type="checkbox"
            name={name}
            defaultChecked={Boolean(value)}
            data-testid={`cms-edit-field-input-${name}`}
          />
          <label
            htmlFor={`cms-edit-field-${name}`}
            className="text-xs font-medium text-muted-foreground"
          >
            {name}
          </label>
          <input type="hidden" name={`__kind:${name}`} value="boolean" />
        </div>
      );
    case "richText":
      return (
        <div>
          {label}
          <textarea
            id={`cms-edit-field-${name}`}
            name={name}
            defaultValue={String(value ?? "")}
            rows={4}
            className={cn(commonClass, "font-mono text-xs")}
            data-testid={`cms-edit-field-input-${name}`}
          />
        </div>
      );
    case "enum":
    case "image":
    case "text":
    default:
      return (
        <div>
          {label}
          <input
            id={`cms-edit-field-${name}`}
            type="text"
            name={name}
            defaultValue={String(value ?? "")}
            className={commonClass}
            data-testid={`cms-edit-field-input-${name}`}
          />
        </div>
      );
  }
}

function BooleanSidecar({ fields }: { fields: string[] }) {
  if (fields.length === 0) return null;
  return (
    <input type="hidden" name="__boolean-fields" value={fields.join(",")} />
  );
}
