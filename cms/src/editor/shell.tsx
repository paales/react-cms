/**
 * Editor shell — floating-panel layout.
 *
 *   ┌──────────────── top toolbar (pill) ────────────────┐
 *   │  ⠿ ⤴ 🏠 Home page ⌄  ▭ ▯ ▮  ↶↷  ⛶ ☾ </> ● Draft ⌄ │
 *   └─────────────────────────────────────────────────────┘
 *   ┌── left panel ──┐   ┌────── preview ──────┐   ┌── right ──┐
 *   │ Layers ╲ Setts │   │  page renders here  │   │ <Element> │
 *   │   tree …       │   │  ╳selection chrome  │   │ Properties│
 *   └────────────────┘   └─────────────────────┘   └───────────┘
 *
 * Tweaks (palette / surface / attachment / device) live in URL
 * params and a sticky cookie. Tree and field panels are still
 * partials with the `#cms-edit-tree` and `#cms-edit-fields`
 * selectors — selector-targeted refetch on a tree click only re-runs
 * those two, never the preview.
 */

import {
  EDITOR_COOKIE,
  parton,
  cookie,
  getCurrentParton,
  pathname,
  searchParam,
  getCatalogManifest,
  getRouteSnapshots,
  getSlotBlockMeta,
  listAllCmsNodes,
  listSlotBlockIds,
  lookupDraftNode,
  parseSlotEntryId,
  pickBestConfigIndex,
  setSessionFrameUrl,
  type BlockManifest,
  type CmsConfig,
  type CmsNode,
  type ContentFieldKind,
  type MatchClause,
  type RenderArgs,
  type ResolvedCell,
} from "@parton/framework"
import {
  editorAttachment,
  editorDevice,
  editorLeftTab,
  editorPalette,
  editorSurface,
  editorTreeStyle,
} from "./state.ts"
import { CmsEditTreeLink } from "./components/tree-link.tsx"
import { CmsEditAddBlock } from "./components/add-block.tsx"
import { HydrationBeacon } from "./components/hydration-beacon.tsx"
import { EditorCloseLink } from "./components/editor-close-link.tsx"
import { Icon, SixDot } from "./components/icon.tsx"
import { PanelTabBar, type PanelTab } from "./components/panel-tab-bar.tsx"
import { PageNavigator } from "./components/page-navigator.tsx"
import { SessionToggleLink } from "./components/session-toggle.tsx"
import { StatusPill } from "./components/status-pill.tsx"
import { EditorChromeStyles } from "./editor-styles.tsx"
import {
  addBlockToSlot as _addBlockToSlot,
  moveBlockInSlot as _moveBlockInSlot,
  publishCmsDraft as _publishCmsDraft,
  removeBlockFromSlot as _removeBlockFromSlot,
  resetCmsDraft as _resetCmsDraft,
  saveCmsFields as _saveCmsFields,
} from "./actions.ts"

type FormAction = string | ((formData: FormData) => void | Promise<void>) | undefined
const asFormAction = (fn: unknown): FormAction => fn as FormAction
const addBlockToSlot = _addBlockToSlot
const moveBlockInSlot = _moveBlockInSlot
const publishCmsDraft = _publishCmsDraft
const removeBlockFromSlot = _removeBlockFromSlot
const resetCmsDraft = _resetCmsDraft
const saveCmsFields = _saveCmsFields

// URL-bound editor params (shareable / browser-history). Tweaks
// (palette / surface / attachment / device / tree style / left tab)
// are session-backed via the `session.*` vary surface — see the
// session.enum reads in each vary block below. Editor on/off lives
// in the `__editor` cookie (the sole source of truth); entry/exit
// flows through `nav.navigate(url, {cookies: {[EDITOR_COOKIE]: …}})`.
// `editor` stays in `EDITOR_RESERVED_PARAMS` only so stray legacy
// bookmarks get stripped from internal hrefs — the param itself has
// no effect.
const EDITOR_RESERVED_PARAMS = ["editor", "select", "config", "tabs"] as const
const FRAMEWORK_INTERNAL_PARAMS = [
  "partials",
  "cached",
  "__frame",
  "__frameUrl",
  "streaming",
] as const

type Palette = "light" | "dark"
type Surface = "light" | "translucent" | "solid"
type Attachment = "floating" | "docked"
type Device = "desktop" | "tablet" | "mobile"

function stripEditorAndInternalParams(url: URL): void {
  for (const p of EDITOR_RESERVED_PARAMS) url.searchParams.delete(p)
  for (const p of FRAMEWORK_INTERNAL_PARAMS) url.searchParams.delete(p)
}

function derivePreviewUrl(currentUrl: URL): string {
  const url = new URL(currentUrl)
  stripEditorAndInternalParams(url)
  return url.pathname + url.search
}

function renderedCmsIdsForPreviewedPage(): string[] {
  // The editor tree's roots are the CMS rows the previewed page
  // bound to. After the partial.tsx ↔ cms-block.ts split, snapshots
  // no longer carry a `contentKey` field — instead we cross-check
  // each snapshot's `type` against the slot-block meta side-table
  // (only block specs land there). The snapshot id of a CMS-bound
  // instance IS the CMS row key (singleton spec id, or the slot
  // entry's id from the `__instanceId` channel).
  const ids = new Set<string>()
  const snapshots = getRouteSnapshots()
  if (snapshots) {
    for (const [id, snap] of snapshots) {
      if (snap.type && getSlotBlockMeta(snap.type)) ids.add(id)
    }
  }
  return [...ids]
}

function buildPreviewRequest(currentUrl: URL, headers: Headers): Request {
  const url = new URL(currentUrl)
  stripEditorAndInternalParams(url)
  return new Request(url, { headers, method: "GET" })
}

interface HrefOpts {
  select?: string | null
  config?: number | null
  tabs?: string | null
  clearSelect?: boolean
}

function cmsEditHref(currentUrl: URL, opts: HrefOpts): string {
  const url = new URL(currentUrl)
  if (opts.clearSelect) url.searchParams.delete("select")
  else if (opts.select != null) url.searchParams.set("select", opts.select)

  if (opts.config != null && opts.config >= 0) {
    url.searchParams.set("config", String(opts.config))
  } else if (opts.config != null) {
    url.searchParams.delete("config")
  }
  if (opts.tabs != null) {
    if (opts.tabs === "") url.searchParams.delete("tabs")
    else url.searchParams.set("tabs", opts.tabs)
  }

  url.searchParams.delete("editor")
  for (const p of FRAMEWORK_INTERNAL_PARAMS) url.searchParams.delete(p)
  return url.pathname + url.search
}

function camelToSpace(s: string): string {
  if (!s) return s
  return s
    .replace(/[-_]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (c) => c.toUpperCase())
}

function blockTypeToPascal(type: string): string {
  return type
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((p) => p[0].toUpperCase() + p.slice(1))
    .join("")
}

function iconForType(type: string | undefined): string {
  if (!type) return "block"
  if (/hero|banner|page-hero/.test(type)) return "star"
  if (/nav-?(root|link)|menu/.test(type)) return "nav"
  if (/rich-?text|^text$/.test(type)) return "text"
  if (/heading|title/.test(type)) return "heading"
  if (/image|media/.test(type)) return "image"
  if (/button|cta/.test(type)) return "button"
  if (/grid|cols|column/.test(type)) return "cols"
  if (/page-(root|composed|multi|greeting|slug|hero)/.test(type)) return "page"
  if (/cart|product/.test(type)) return "cart"
  if (/group|section/.test(type)) return "section"
  return "block"
}

function readMultiTabs(currentUrl: URL): string[] {
  const raw = currentUrl.searchParams.get("tabs") ?? ""
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
}

// ─── Tree pane ─────────────────────────────────────────────────────────

export const EditorTreePartial = parton(
  async function EditorTreeRender({
    selected,
    treeStyle: treeStyleCell,
    currentUrl: currentUrlRaw,
  }: {
    selected: string | null
    treeStyle: ResolvedCell<"jsx" | "plain">
    currentUrl: string
  } & RenderArgs) {
    const treeStyle = treeStyleCell.value
    const currentUrl = new URL(currentUrlRaw)
    const catalog = await getCatalogManifest()
    const rootIds = renderedCmsIdsForPreviewedPage()
    const entries = listAllCmsNodes(rootIds)
    const blockTypes = listSlotBlockIds()

    const parentTypeById = new Map<string, string | undefined>()
    for (const entry of entries) {
      if (entry.kind === "node") parentTypeById.set(entry.id, entry.type)
    }

    if (entries.length === 0) {
      return (
        <div style={{ padding: 14 }}>
          <p style={{ fontSize: 12, color: "var(--cms-ink-3)" }} data-testid="cms-edit-tree-empty">
            {rootIds.length === 0
              ? "No CMS-aware partials rendered on this page yet. Navigate to a page that mounts a CMS root, or refresh once to warm the registry."
              : "The CMS store is empty for this page's roots."}
          </p>
        </div>
      )
    }

    const rowIndex = new Map<string, number>()
    const slotCounts = new Map<string, number>()
    for (const entry of entries) {
      if (entry.kind === "node" && entry.parentId && entry.slotName) {
        const key = `${entry.parentId}:${entry.slotName}`
        const next = slotCounts.get(key) ?? 0
        rowIndex.set(entry.id, next)
        slotCounts.set(key, next + 1)
      }
    }

    return (
      <div className="cms-panel-body cms-panel-body--tree">
        <HydrationBeacon testId="cms-edit-tree-hydrated" />
        {entries.map((entry) => {
          const indent = 6 + entry.depth * 16
          if (entry.kind === "slot") {
            return (
              <div
                key={entry.id}
                style={{ paddingLeft: indent }}
                data-testid={`cms-edit-tree-entry-${entry.id}`}
              >
                <div
                  className="cms-tree-slot-label"
                  data-testid={`cms-edit-tree-slot-label-${entry.parentId}-${entry.slotName}`}
                >
                  <span aria-hidden style={{ color: "var(--cms-ink-3)" }}>
                    ▸
                  </span>
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>
                    {entry.slotName}
                  </span>
                </div>
              </div>
            )
          }
          if (entry.kind === "slot-add") {
            const parentType = parentTypeById.get(entry.parentId!)
            const parentManifest = parentType ? catalog[parentType] : undefined
            const allow = parentManifest?.childSlots[entry.slotName!]?.allow ?? null
            const filteredTypes =
              allow == null || isWildcardAllow(allow)
                ? blockTypes
                : blockTypes.filter((type) => {
                    const m = catalog[type]
                    if (!m) return false
                    return blockLabelsSatisfyAllow(m.labels, allow)
                  })
            const options = filteredTypes.map((type) => ({
              type,
              displayName: camelToSpace(type),
              labels: catalog[type]?.labels ?? [],
              action: addBlockToSlot.bind(null, entry.parentId!, entry.slotName!, type),
            }))
            return (
              <div
                key={entry.id}
                style={{ paddingLeft: indent, display: "flex", alignItems: "center" }}
                data-testid={`cms-edit-tree-entry-${entry.id}`}
              >
                <CmsEditAddBlock
                  parentId={entry.parentId!}
                  slotName={entry.slotName!}
                  options={options}
                />
              </div>
            )
          }
          const isSelected = entry.id === selected
          const label = entry.displayName ?? `#${entry.id}`
          const slotKey =
            entry.parentId && entry.slotName ? `${entry.parentId}:${entry.slotName}` : null
          const idx = slotKey != null ? (rowIndex.get(entry.id) ?? 0) : 0
          const total = slotKey != null ? (slotCounts.get(slotKey) ?? 1) : 1
          const inSlot = entry.parentId && entry.slotName
          const tagName = entry.type ? blockTypeToPascal(entry.type) : label
          const showJsx = treeStyle === "jsx"
          const hasChildren = entry.depth === 0 // page-level rows usually expand
          return (
            <div key={entry.id} className="cms-tree-row-wrapper" style={{ paddingLeft: indent }}>
              <CmsEditTreeLink
                href={cmsEditHref(currentUrl, { select: entry.id })}
                className="cms-tree-row"
                testId={`cms-edit-tree-entry-${entry.id}`}
                selected={isSelected}
              >
                <span className="cms-tree-leading">
                  <span className="chev">
                    {hasChildren ? (
                      <Icon name="chevDown" size={11} />
                    ) : (
                      <span style={{ width: 11, height: 11 }} />
                    )}
                  </span>
                  <span className="grip" aria-hidden>
                    <SixDot />
                  </span>
                </span>
                <span className="cms-tree-row-icon">
                  <Icon name={iconForType(entry.type)} size={14} />
                </span>
                <span className="cms-tree-row-name">
                  {showJsx ? (
                    <span className="tag" title={label}>
                      &lt;{tagName}&gt;
                    </span>
                  ) : (
                    <span className="label" title={label}>
                      {camelToSpace(label)}
                    </span>
                  )}
                </span>
                {entry.draftOnly ? (
                  <span
                    data-testid={`cms-edit-tree-entry-${entry.id}-draft-badge`}
                    style={{
                      fontSize: 10,
                      padding: "1px 5px",
                      border: "1px solid rgba(224,169,27,0.6)",
                      borderRadius: 3,
                      color: "#a37212",
                      lineHeight: 1.2,
                    }}
                  >
                    draft
                  </span>
                ) : entry.hasDraft ? (
                  <span
                    data-testid={`cms-edit-tree-entry-${entry.id}-modified-badge`}
                    style={{
                      fontSize: 10,
                      padding: "1px 5px",
                      border: "1px solid rgba(44,127,214,0.5)",
                      borderRadius: 3,
                      color: "var(--cms-accent)",
                      lineHeight: 1.2,
                    }}
                  >
                    modified
                  </span>
                ) : null}
              </CmsEditTreeLink>
              <div className="cms-tree-tools">
                {inSlot && (
                  <>
                    <form
                      action={asFormAction(
                        moveBlockInSlot.bind(
                          null,
                          entry.parentId!,
                          entry.slotName!,
                          entry.id,
                          "up",
                        ),
                      )}
                      style={{ display: "contents" }}
                    >
                      <button
                        type="submit"
                        disabled={idx === 0}
                        title="Move up"
                        aria-label={`Move ${entry.id} up`}
                      >
                        ↑
                      </button>
                    </form>
                    <form
                      action={asFormAction(
                        moveBlockInSlot.bind(
                          null,
                          entry.parentId!,
                          entry.slotName!,
                          entry.id,
                          "down",
                        ),
                      )}
                      style={{ display: "contents" }}
                    >
                      <button
                        type="submit"
                        disabled={idx >= total - 1}
                        title="Move down"
                        aria-label={`Move ${entry.id} down`}
                      >
                        ↓
                      </button>
                    </form>
                    <form
                      action={asFormAction(
                        removeBlockFromSlot.bind(null, entry.parentId!, entry.slotName!, entry.id),
                      )}
                      style={{ display: "contents" }}
                    >
                      <button
                        type="submit"
                        title="Remove"
                        aria-label={`Remove ${entry.id}`}
                        data-testid={`cms-edit-slot-remove-${entry.id}`}
                      >
                        <Icon name="trash" size={13} />
                      </button>
                    </form>
                  </>
                )}
                {/* Visibility toggle (visual placeholder — there's no
                    `hidden` field on CmsNode in this codebase yet). */}
                <button type="button" title="Hide" aria-label={`Toggle visibility ${entry.id}`}>
                  <Icon name="eye" size={13} />
                </button>
              </div>
            </div>
          )
        })}
      </div>
    )
  },
  {
    selector: "#cms-edit-tree",
    schema: () => {
      // Tracked reads: selection + page identity. The full URL is a
      // derived output for link-building; its nav-relevant dimensions
      // are the recorded pathname/select reads.
      const selected = searchParam("select")
      pathname()
      return {
        treeStyle: editorTreeStyle,
        selected,
        currentUrl: getCurrentParton()?.request.url ?? "",
      }
    },
  },
)

// ─── Settings pane (left panel — Settings tab) ─────────────────────────

export const EditorSettingsPartial = parton(
  function EditorSettingsRender({ pathname }: { pathname: string } & RenderArgs) {
    return (
      <div className="cms-panel-body">
        <div className="cms-section-head" style={{ marginTop: 6 }}>
          Page
        </div>
        <div className="cms-row">
          <span className="cms-row-label">Title</span>
          <span className="cms-wf-field">Home page</span>
        </div>
        <div className="cms-row">
          <span className="cms-row-label">Handle</span>
          <span
            className="cms-wf-field"
            style={{ fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12 }}
          >
            {pathname}
          </span>
        </div>
        <div className="cms-row">
          <span className="cms-row-label">Visible</span>
          <span className="cms-wf-toggle" data-on />
        </div>
        <div className="cms-section-head">SEO</div>
        <div className="cms-row">
          <span className="cms-row-label">Meta</span>
          <span className="cms-wf-field" style={{ color: "var(--cms-ink-3)" }}>
            (not configured)
          </span>
        </div>
        <div className="cms-row">
          <span className="cms-row-label">Indexable</span>
          <span className="cms-wf-toggle" data-on />
        </div>
      </div>
    )
  },
  {
    selector: "#cms-edit-settings",
    schema: () => ({ pathname: pathname() }),
  },
)

// ─── Field panel ───────────────────────────────────────────────────────

export const EditorFieldPanelPartial = parton(
  async function EditorFieldPanelRender({
    selected,
    effectiveIndex: vEffectiveIndex,
    currentUrl: currentUrlRaw,
  }: {
    selected: string | null
    effectiveIndex: number
    currentUrl: string
  } & RenderArgs) {
    const currentUrl = new URL(currentUrlRaw)
    if (!selected) {
      return (
        <div className="cms-panel-body">
          <div style={{ fontSize: 12, color: "var(--cms-ink-3)" }}>
            Select a Partial from the tree to edit its fields.
          </div>
        </div>
      )
    }
    if (parseSlotEntryId(selected)) {
      return (
        <div className="cms-panel-body">
          <div style={{ fontSize: 12, color: "var(--cms-ink-3)" }}>
            Slots aren't selectable. Click a block to edit its fields.
          </div>
        </div>
      )
    }
    const node = lookupDraftNode(selected)
    const catalog = await getCatalogManifest()
    const manifest = node?.type ? catalog[node.type] : undefined
    const hasDraft = listAllCmsNodes().some((e) => e.id === selected && e.hasDraft)
    const configs = node?.configs ?? []
    const effectiveIndex =
      vEffectiveIndex >= 0 && vEffectiveIndex < configs.length
        ? vEffectiveIndex
        : configs.length > 0
          ? 0
          : -1
    const currentConfig = effectiveIndex >= 0 ? configs[effectiveIndex] : null
    const fieldMap = buildFieldMap(currentConfig, manifest)

    return (
      <div className="cms-panel-body">
        <div className="cms-selected-head">
          <Icon name={iconForType(node?.type)} size={14} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 500 }} data-testid="cms-edit-selected-id">
              {node?.displayName ?? `#${selected}`}
            </div>
            <div
              style={{
                fontSize: 11,
                color: "var(--cms-ink-3)",
                fontFamily: "ui-monospace, Menlo, monospace",
              }}
            >
              {selected}
            </div>
          </div>
          {hasDraft && (
            <form action={asFormAction(resetCmsDraft.bind(null, selected))}>
              <button
                type="submit"
                className="cms-btn cms-btn--ghost"
                data-testid="cms-edit-reset-draft"
                style={{ height: 24, padding: "0 8px", fontSize: 12 }}
              >
                Reset draft → published
              </button>
            </form>
          )}
        </div>

        {configs.length > 0 && (
          <ConfigTabs
            selected={selected}
            configs={configs}
            activeIndex={effectiveIndex}
            currentUrl={currentUrl}
          />
        )}

        {Object.keys(fieldMap).length === 0 ? (
          <div
            style={{
              padding: 12,
              fontSize: 12,
              color: "var(--cms-ink-3)",
              border: "1px solid var(--cms-line)",
              borderRadius: 8,
              background: "rgba(0,0,0,0.02)",
            }}
          >
            No fields on this configuration yet.
          </div>
        ) : (
          <form
            key={`${selected}:${effectiveIndex}`}
            action={asFormAction(saveCmsFields.bind(null, selected, effectiveIndex))}
            data-testid="cms-edit-field-form"
          >
            <div className="cms-section-head">Fields</div>
            {Object.entries(fieldMap).map(([name, spec]) => (
              <FieldInput key={name} name={name} kind={spec.kind} value={spec.value} />
            ))}
            <BooleanSidecar
              fields={Object.entries(fieldMap)
                .filter(([, s]) => s.kind === "boolean")
                .map(([n]) => n)}
            />
            <HydrationBeacon testId="cms-edit-field-form-hydrated" />
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button type="submit" className="cms-btn">
                Save to draft
              </button>
              <a
                href={cmsEditHref(currentUrl, { select: selected, config: effectiveIndex })}
                className="cms-btn cms-btn--ghost"
              >
                Discard changes
              </a>
            </div>
          </form>
        )}

        <SpacingVisualizer />
      </div>
    )
  },
  {
    selector: "#cms-edit-fields",
    schema: () => {
      // Tracked reads: selection, requested config tab, page identity —
      // plus the selected node's content row (`cms:` dep), which is what
      // moves `effectiveIndex` when configs are edited.
      const select = searchParam("select")
      const config = searchParam("config")
      pathname()
      const cp = getCurrentParton()
      const url = new URL(cp?.request.url ?? "http://localhost/")
      const requested = config != null ? Number(config) : null
      let effectiveIndex = -1
      if (select && !parseSlotEntryId(select)) {
        cp?.deps.add(`cms:${select}`)
        const node = lookupDraftNode(select)
        const configs = node?.configs ?? []
        if (configs.length > 0) {
          const previewReq = buildPreviewRequest(url, cp?.request.headers ?? new Headers())
          effectiveIndex = pickEffectiveConfig(configs, requested, previewReq)
        }
      }
      return {
        selected: select,
        effectiveIndex,
        currentUrl: url.toString(),
      }
    },
  },
)

// ─── Helpers ───────────────────────────────────────────────────────────

function pickEffectiveConfig(
  configs: readonly CmsConfig[],
  requested: number | null,
  previewReq: Request,
): number {
  if (configs.length === 0) return -1
  if (requested != null && requested >= 0 && requested < configs.length) return requested
  const best = pickBestConfigIndex(configs, previewReq)
  if (best != null) return best
  const defaultIdx = configs.findIndex((c) => Object.keys(c.match).length === 0)
  return defaultIdx >= 0 ? defaultIdx : 0
}

function ConfigTabs({
  selected,
  configs,
  activeIndex,
  currentUrl,
}: {
  selected: string
  configs: readonly CmsConfig[]
  activeIndex: number
  currentUrl: URL
}) {
  return (
    <div data-testid="cms-edit-config-tabs" style={{ marginBottom: 6 }}>
      <div className="cms-section-head" style={{ marginTop: 0 }}>
        Configuration
      </div>
      <div className="cms-wf-segment" style={{ flexWrap: "wrap", height: "auto", padding: 2 }}>
        {configs.map((cfg, idx) => {
          const isActive = idx === activeIndex
          const label = formatMatchLabel(cfg.match)
          return (
            <CmsEditTreeLink
              key={idx}
              href={cmsEditHref(currentUrl, { select: selected, config: idx })}
              testId={`cms-edit-config-tab-${idx}`}
              selected={isActive}
            >
              <span
                data-active={isActive ? "true" : undefined}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: "2px 8px",
                  fontFamily: "ui-monospace, Menlo, monospace",
                  fontSize: 11,
                  whiteSpace: "nowrap",
                  borderRadius: 4,
                  color: "var(--cms-ink-2)",
                  ...(isActive
                    ? {
                        background: "var(--cms-input-bg)",
                        color: "var(--cms-ink)",
                        boxShadow: "0 1px 2px rgba(0,0,0,0.06)",
                      }
                    : {}),
                }}
              >
                {label}
              </span>
            </CmsEditTreeLink>
          )
        })}
      </div>
    </div>
  )
}

export function formatMatchLabel(match: Record<string, MatchClause>): string {
  const entries = Object.entries(match)
  if (entries.length === 0) return "Default"
  return entries.map(([k, c]) => formatClause(k, c)).join(" · ")
}

function formatClause(key: string, clause: MatchClause): string {
  const colonIdx = key.indexOf(":")
  const kind = colonIdx > 0 ? key.slice(0, colonIdx) : key
  const name = colonIdx > 0 ? key.slice(colonIdx + 1) : ""
  if (kind === "pathname") {
    if (typeof clause === "object" && clause !== null && !Array.isArray(clause)) {
      if ("in" in clause) return `${shortKey(name)}∈…`
      const paramParts = Object.entries(clause as Record<string, ScalarOrIn>).map(([p, c]) =>
        formatScalar(p, c),
      )
      return paramParts.join(", ")
    }
    return shortKey(name)
  }
  return formatScalar(name, clause as ScalarOrIn)
}

type ScalarOrIn = string | number | boolean | { in: ReadonlyArray<string | number> }

function formatScalar(name: string, clause: ScalarOrIn): string {
  if (typeof clause === "string") return `${name}=${clause}`
  if (typeof clause === "number") return `${name}=${clause}`
  if (typeof clause === "boolean") return `${name}=${clause}`
  if (clause && typeof clause === "object" && "in" in clause) {
    return `${name}∈${clause.in.join(",")}`
  }
  return name
}

function shortKey(key: string): string {
  const match = key.match(/:([^/]+)$/)
  return match ? match[1] : key
}

function isWildcardAllow(allow: string): boolean {
  return allow.split(/\s+/).some((t) => t.trim() === "*")
}

function blockLabelsSatisfyAllow(labels: readonly string[], allow: string): boolean {
  const tokens = allow
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => (t.startsWith("#") || t.startsWith(".") ? t.slice(1) : t))
  for (const token of tokens) {
    if (labels.includes(token)) return true
  }
  return false
}

interface FieldSpec {
  kind: ContentFieldKind
  value: unknown
}

function buildFieldMap(
  config: CmsConfig | null,
  manifest: BlockManifest | undefined,
): Record<string, FieldSpec> {
  const out: Record<string, FieldSpec> = {}
  if (manifest) {
    for (const [name, kind] of Object.entries(manifest.contentFields)) {
      out[name] = { kind, value: config?.fields[name] }
    }
  }
  if (config) {
    for (const [name, value] of Object.entries(config.fields)) {
      if (name in out) continue
      out[name] = { kind: inferKind(value), value }
    }
  }
  return out
}

function inferKind(value: unknown): ContentFieldKind {
  if (typeof value === "number") return "number"
  if (typeof value === "boolean") return "boolean"
  return "text"
}

function FieldInput({
  name,
  kind,
  value,
}: {
  name: string
  kind: ContentFieldKind
  value: unknown
}) {
  const label = (
    <label htmlFor={`cms-edit-field-${name}`} className="cms-row-label">
      {name}
    </label>
  )
  switch (kind) {
    case "number": {
      const num = Number(value ?? 0) || 0
      // Heuristic for slider visualization: assume 0–100 normalized for display
      const pct = Math.max(0, Math.min(100, num))
      return (
        <div className="cms-row">
          {label}
          <span className="cms-wf-slider-row">
            <span className="cms-wf-slider">
              <span className="cms-wf-slider-fill" style={{ width: `${pct}%` }} />
              <span className="cms-wf-slider-thumb" style={{ left: `${pct}%` }} />
            </span>
            <span className="cms-wf-slider-num">
              <input
                id={`cms-edit-field-${name}`}
                type="number"
                name={name}
                defaultValue={String(num)}
                data-testid={`cms-edit-field-input-${name}`}
              />
            </span>
            <input type="hidden" name={`__kind:${name}`} value="number" />
          </span>
        </div>
      )
    }
    case "boolean":
      return (
        <div className="cms-row">
          {label}
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input
              id={`cms-edit-field-${name}`}
              type="checkbox"
              name={name}
              defaultChecked={Boolean(value)}
              data-testid={`cms-edit-field-input-${name}`}
            />
            <input type="hidden" name={`__kind:${name}`} value="boolean" />
          </span>
        </div>
      )
    case "richText":
      return (
        <div className="cms-row" style={{ alignItems: "flex-start" }}>
          {label}
          <span>
            <textarea
              id={`cms-edit-field-${name}`}
              name={name}
              defaultValue={String(value ?? "")}
              rows={4}
              className="cms-wf-field cms-wf-textarea"
              data-testid={`cms-edit-field-input-${name}`}
            />
          </span>
        </div>
      )
    default: {
      const str = String(value ?? "")
      // If the value looks like it references a binding (e.g. `{{x}}`),
      // render a "dynamic source" decoration with a database icon as
      // the `Source` row.
      const dyn = /\{\{[^}]+\}\}/.exec(str)
      if (dyn) {
        const before = str.slice(0, dyn.index)
        const ref = dyn[0]
        const after = str.slice(dyn.index + dyn[0].length)
        return (
          <div className="cms-row">
            {label}
            <span className="cms-wf-field cms-source-field">
              <input
                id={`cms-edit-field-${name}`}
                type="text"
                name={name}
                defaultValue={str}
                data-testid={`cms-edit-field-input-${name}`}
                style={{
                  flex: 1,
                  border: 0,
                  outline: 0,
                  background: "transparent",
                  fontSize: 13,
                  padding: 0,
                  color: "var(--cms-ink)",
                }}
              />
              <span className="db" title="Dynamic source">
                <Icon name="database" size={13} />
              </span>
            </span>
          </div>
        )
      }
      return (
        <div className="cms-row">
          {label}
          <input
            id={`cms-edit-field-${name}`}
            type="text"
            name={name}
            defaultValue={str}
            className="cms-wf-field"
            data-testid={`cms-edit-field-input-${name}`}
          />
        </div>
      )
    }
  }
}

function BooleanSidecar({ fields }: { fields: string[] }) {
  if (fields.length === 0) return null
  return <input type="hidden" name="__boolean-fields" value={fields.join(",")} />
}

function SpacingVisualizer() {
  return (
    <>
      <div className="cms-section-head">Spacing</div>
      <div className="cms-spacing">
        <div className="cms-spacing-margin cms-stripes-margin" />
        <div className="cms-spacing-padding cms-stripes-padding" />
        <div className="cms-spacing-content" />
        <span
          className="cms-spacing-num"
          style={{ left: "50%", top: 2, transform: "translateX(-50%)" }}
        >
          80
        </span>
        <span
          className="cms-spacing-num"
          style={{ left: "50%", bottom: 2, transform: "translateX(-50%)" }}
        >
          80
        </span>
        <span
          className="cms-spacing-num"
          style={{ left: 2, top: "50%", transform: "translateY(-50%)" }}
        >
          24
        </span>
        <span
          className="cms-spacing-num"
          style={{ right: 2, top: "50%", transform: "translateY(-50%)" }}
        >
          24
        </span>
      </div>
    </>
  )
}

// ─── Top toolbar ───────────────────────────────────────────────────────

function EditorToolbar({
  treeStyle,
  palette,
  attachment,
  device,
  previewUrl,
  homeLabel,
}: {
  treeStyle: "jsx" | "plain"
  palette: Palette
  attachment: Attachment
  device: Device
  previewUrl: string
  homeLabel: string
}) {
  return (
    <div className="cms-toolbar" data-topbar>
      {attachment !== "docked" && (
        <span
          className="cms-toolbar-icon"
          title="Drag toolbar"
          style={{ cursor: "grab", opacity: 0.6 }}
          aria-hidden
        >
          <SixDot />
        </span>
      )}
      <EditorCloseLink
        className="cms-toolbar-icon"
        title="Exit design mode"
        testId="cms-edit-close"
      >
        <Icon name="exit" size={16} />
      </EditorCloseLink>
      <Sep />
      <PageNavigator currentPath={previewUrl.split("?")[0]} homeLabel={homeLabel} />
      <Sep />
      <div style={{ display: "flex", gap: 2 }}>
        {(["desktop", "tablet", "mobile"] as const).map((d) => (
          <SessionToggleLink
            key={d}
            name="editor-device"
            value={d}
            className="cms-toolbar-icon"
            active={device === d}
            title={d.charAt(0).toUpperCase() + d.slice(1)}
          >
            <Icon name={d} size={16} />
          </SessionToggleLink>
        ))}
      </div>
      <Sep />
      <span className="cms-toolbar-icon" title="Undo" data-disabled>
        <Icon name="undo" size={16} />
      </span>
      <span className="cms-toolbar-icon" title="Redo" data-disabled>
        <Icon name="redo" size={16} />
      </span>
      <Sep />
      <SessionToggleLink
        name="editor-attachment"
        value={attachment === "docked" ? "floating" : "docked"}
        className="cms-toolbar-icon"
        active={attachment === "docked"}
        title={attachment === "docked" ? "Floating panels" : "Dock panels"}
      >
        <Icon name={attachment === "docked" ? "floatPanels" : "dockPanels"} size={16} />
      </SessionToggleLink>
      <SessionToggleLink
        name="editor-palette"
        value={palette === "dark" ? "light" : "dark"}
        className="cms-toolbar-icon"
        title={palette === "dark" ? "Switch to light" : "Switch to dark"}
      >
        <Icon name={palette === "dark" ? "sun" : "moon"} size={14} />
      </SessionToggleLink>
      <Sep />
      <SessionToggleLink
        name="editor-tree-style"
        value={treeStyle === "jsx" ? "plain" : "jsx"}
        className="cms-toolbar-icon"
        testId="cms-edit-tree-style-toggle"
        active={treeStyle === "jsx"}
        title={treeStyle === "jsx" ? "Switch to plain names" : "Switch to JSX tags"}
      >
        <span
          style={{
            fontFamily: "ui-monospace, Menlo, monospace",
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          &lt;/&gt;
        </span>
      </SessionToggleLink>
      <Sep />
      <StatusPill />
      <Sep />
      <form action={asFormAction(publishCmsDraft)} style={{ display: "contents" }}>
        <button type="submit" className="cms-toolbar-save" title="Publish draft">
          Save
        </button>
      </form>
    </div>
  )
}

function Sep() {
  return <span className="cms-toolbar-sep" aria-hidden />
}

// ─── Canvas chrome (selection rect + insertion line) ───────────────────

function CanvasChrome({
  selectedLabel,
  selectedType,
}: {
  selectedLabel: string | null
  selectedType: string | undefined
}) {
  if (!selectedLabel) return null
  // The DOM-rect overlay flagged in IDEAS.md as future work — without
  // a way to map id → DOM rect of the rendered partial, the canvas
  // chrome anchors generically to the preview pane. The visual is a
  // 1380×200 block centered horizontally: blue-purple dashed
  // selection, corner markers, bottom-left attached element-name tag,
  // pink margin bands above/below, and the +-circle insertion line
  // above.
  const tagName = selectedType ? blockTypeToPascal(selectedType) : selectedLabel
  return (
    <div className="cms-canvas-overlay">
      <div
        className="cms-selection-rect"
        style={{
          left: "5%",
          right: "5%",
          top: "55%",
          height: 200,
        }}
      >
        <div className="cms-canvas-margin-band cms-canvas-margin-band--top cms-stripes-margin" />
        <div className="cms-canvas-margin-band cms-canvas-margin-band--bottom cms-stripes-margin" />
        <span className="cms-selection-corner" style={{ left: -4, top: -4 }} />
        <span className="cms-selection-corner" style={{ right: -4, top: -4 }} />
        <span className="cms-selection-corner" style={{ left: -4, bottom: -4 }} />
        <span className="cms-selection-corner" style={{ right: -4, bottom: -4 }} />
        <span className="cms-selection-tag" style={{ left: -1, top: "100%", marginTop: 22 }}>
          <span className="tag">{tagName}</span>
          <span className="dim">selected</span>
        </span>
      </div>
      <div
        className="cms-insertion-line"
        style={{ left: "5%", right: "5%", top: "calc(55% - 22px)" }}
      >
        <span className="plus">
          <Icon name="plus" size={12} strokeWidth={2.4} />
        </span>
      </div>
    </div>
  )
}

// ─── Editor shell ──────────────────────────────────────────────────────

export const EditorShell = parton(
  function EditorShellRender({
    editor,
    leftTab: leftTabCell,
    treeStyle: treeStyleCell,
    selected,
    palette: paletteCell,
    surface: surfaceCell,
    attachment: attachmentCell,
    device: deviceCell,
    currentUrl: currentUrlRaw,
    previewUrl,
    isPreviewFrameRefetch,
  }: {
    editor: boolean
    leftTab: ResolvedCell<"layers" | "settings">
    treeStyle: ResolvedCell<"jsx" | "plain">
    selected: string | null
    palette: ResolvedCell<Palette>
    surface: ResolvedCell<Surface>
    attachment: ResolvedCell<Attachment>
    device: ResolvedCell<Device>
    currentUrl: string
    previewUrl: string
    isPreviewFrameRefetch: boolean
  } & RenderArgs) {
    const leftTab = leftTabCell.value
    const treeStyle = treeStyleCell.value
    const palette = paletteCell.value
    const surface = surfaceCell.value
    const attachment = attachmentCell.value
    const device = deviceCell.value
    // Editor off — the partial emits nothing. The page renders on its
    // own; this partial is a sibling overlay placed at body level.
    if (!editor) return null

    const currentUrl = new URL(currentUrlRaw)
    if (!isPreviewFrameRefetch) setSessionFrameUrl(["preview"], previewUrl)

    const selectedNode: CmsNode | null = selected ? lookupDraftNode(selected) : null
    const selectedLabel = selectedNode?.displayName ?? (selected ? `#${selected}` : null)

    // Multi-element tabs in the right panel — `?tabs=id1,id2,…` is a
    // co-pending list of recently inspected blocks (newest first). The
    // active tab is whichever entry matches `?select=`. Closing a tab
    // removes it from the list; if the active tab is closed, fall back
    // to the next one.
    const openTabIds = new Set<string>(readMultiTabs(currentUrl))
    if (selected) openTabIds.add(selected)
    const tabs: Array<{ id: string; label: string; type: string | undefined }> = [
      ...openTabIds,
    ].map((id) => {
      const n = lookupDraftNode(id)
      return { id, label: n?.displayName ?? `#${id}`, type: n?.type }
    })
    function closeHrefFor(id: string): string {
      const next = [...openTabIds].filter((x) => x !== id).join(",")
      const newSelect = id === selected ? null : selected
      return cmsEditHref(currentUrl, {
        tabs: next || "",
        select: newSelect ?? undefined,
        clearSelect: newSelect == null,
      })
    }

    // Editor on — emit only chrome. The page is a sibling, rendered
    // by its own placement in root, untouched by the editor. The
    // chrome lives inside a `.cms-editor` wrapper with
    // `display: contents` so it doesn't reserve layout space, and
    // the panels are `position: fixed`. Editor CSS variables +
    // data-* attrs still cascade because the chrome elements remain
    // DOM descendants of `.cms-editor`.
    return (
      <>
        <EditorChromeStyles />
        <div
          className="cms-editor"
          data-attachment={attachment}
          data-surface={surface}
          data-dark={palette === "dark" ? "" : undefined}
          data-device={device}
          style={{ display: "contents" }}
        >
          <EditorToolbar
            treeStyle={treeStyle}
            palette={palette}
            attachment={attachment}
            device={device}
            previewUrl={previewUrl}
            homeLabel="Home page"
          />

          {/* Left panel — Layers / Settings */}
          <aside className="cms-panel cms-panel--left" data-testid="cms-edit-tree-pane">
            <PanelTabBar
              surface={surface}
              attachment={attachment}
              tabs={[
                {
                  id: "layers",
                  label: "Layers",
                  icon: <Icon name="layers" size={14} />,
                  active: leftTab === "layers",
                  sessionToggle: { name: "editor-left-tab", value: "layers" },
                },
                {
                  id: "settings",
                  label: "Settings",
                  icon: <Icon name="settings" size={14} />,
                  active: leftTab === "settings",
                  sessionToggle: { name: "editor-left-tab", value: "settings" },
                },
              ]}
            />
            <div style={{ flex: 1, overflow: "auto", display: "flex", flexDirection: "column" }}>
              {leftTab === "layers" ? <EditorTreePartial /> : <EditorSettingsPartial />}
            </div>
            <ResizeGrip />
          </aside>

          {/* Right panel — element tabs + properties */}
          <aside className="cms-panel cms-panel--right" data-testid="cms-edit-field-pane">
            <PanelTabBar
              surface={surface}
              attachment={attachment}
              align="right"
              tabs={
                tabs.length === 0
                  ? [{ id: "properties", label: "Properties", active: true }]
                  : tabs.map<PanelTab>((t) => ({
                      id: t.id,
                      label: t.label,
                      icon: <Icon name={iconForType(t.type)} size={14} />,
                      active: t.id === selected,
                      href: cmsEditHref(currentUrl, { select: t.id }),
                      closeHref: closeHrefFor(t.id),
                    }))
              }
            />
            <EditorFieldPanelPartial />
            <ResizeGrip />
          </aside>

          {/* Canvas selection chrome (disabled for now — wired below
              `false &&` so the code path stays in tree). When DOM-
              coordinate tracking lands, this can paint over a
              specific rect inside the page. */}
          {false && selected && (
            <CanvasChrome selectedLabel={selectedLabel} selectedType={selectedNode?.type} />
          )}
        </div>
      </>
    )
  },
  {
    schema: () => {
      // Cookie is the sole source of truth for editor on/off.
      // Entry/exit (deep-links, click triggers, tests) all flow through
      // `nav.navigate(url, {cookies: {[EDITOR_COOKIE]: "1" | ""}})` —
      // there's no URL-param sync side-effect. Tests set the cookie
      // directly via `context.addCookies` before navigating.
      const editor = cookie(EDITOR_COOKIE) === "1"
      // Editor off — every non-authoring visit, the common case: read
      // NOTHING beyond the cookie, so the fp folds only that one read
      // and stays constant across navigation. After the first
      // (null-body) render the shell fp-skips to a bare placeholder
      // instead of re-emitting its error-boundary on every nav.
      // Parking is wrong here — keepalive would leave the prior chrome
      // hidden in the DOM, so the close button couldn't clear it.
      let selected: string | null = null
      let currentUrl = ""
      let previewUrl = ""
      let isPreviewFrameRefetch = false
      if (editor) {
        // Editor on: selection + page identity are the tracked nav
        // axes; the full URL is a derived output for chrome links.
        selected = searchParam("select")
        searchParam("__frame")
        pathname()
        const url = new URL(getCurrentParton()?.request.url ?? "http://localhost/")
        isPreviewFrameRefetch = url.searchParams.getAll("__frame").includes("preview")
        currentUrl = url.toString()
        previewUrl = derivePreviewUrl(url)
      }
      return {
        editor,
        selected,
        currentUrl,
        previewUrl,
        isPreviewFrameRefetch,
        leftTab: editorLeftTab,
        treeStyle: editorTreeStyle,
        palette: editorPalette,
        surface: editorSurface,
        attachment: editorAttachment,
        device: editorDevice,
      }
    },
  },
)

function ResizeGrip() {
  return (
    <svg className="cms-panel-resize" width="12" height="12" viewBox="0 0 12 12" aria-hidden>
      <line
        x1="11"
        y1="5"
        x2="5"
        y2="11"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinecap="round"
      />
      <line
        x1="11"
        y1="9"
        x2="9"
        y2="11"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinecap="round"
      />
    </svg>
  )
}
