/**
 * Editor shell — three-pane layout (tree / preview / field form).
 *
 * Tree and field panels are `ReactCms.partial(...)` specs; the
 * preview pane renders the previewed page inline (`{children}`). The
 * field panel's `vary` folds the pathname so `pickBestConfigIndex`
 * re-evaluates as the previewed URL changes.
 */

import { ReactCms, type RenderArgs } from "@react-cms/framework"
import {
  EDITOR_COOKIE,
  listAllCmsNodes,
  lookupDraftNode,
  parseSlotEntryId,
  pickBestConfigIndex,
  listSpecTypes,
  type CmsConfig,
  type ContentFieldKind,
  type MatchClause,
} from "@react-cms/framework/runtime/cms-runtime.ts"
import { getCatalogManifest, type BlockManifest } from "@react-cms/framework/runtime/cms-prerender.ts"
import { getRouteSnapshots } from "@react-cms/framework/lib/partial-registry.ts"
import { setSessionFrameUrl } from "@react-cms/framework/runtime/session.ts"
import { getRequest, setCookie } from "@react-cms/framework/runtime/context.ts"
import { Card, CardContent } from "@react-cms/copies/components/ui/card"
import { Button, buttonVariants } from "@react-cms/copies/components/ui/button"
import { Badge } from "@react-cms/copies/components/ui/badge"
import { cn } from "@react-cms/copies/lib/utils"
import { CmsEditTreeLink } from "./components/tree-link.tsx"
import { CmsEditAddBlock } from "./components/add-block.tsx"
import { CmsEditAddressBar } from "./components/address-bar.tsx"
import {
  addBlockToSlot as _addBlockToSlot,
  moveBlockInSlot as _moveBlockInSlot,
  publishCmsDraft as _publishCmsDraft,
  removeBlockFromSlot as _removeBlockFromSlot,
  resetCmsDraft as _resetCmsDraft,
  saveCmsFields as _saveCmsFields,
} from "./actions.ts"

// Server actions return `{invalidate: {selector}}` directives; React's
// form-action prop expects `void | Promise<void>`. Cast at the boundary.
type FormAction = string | ((formData: FormData) => void | Promise<void>) | undefined
const asFormAction = (fn: unknown): FormAction => fn as FormAction
const addBlockToSlot = _addBlockToSlot
const moveBlockInSlot = _moveBlockInSlot
const publishCmsDraft = _publishCmsDraft
const removeBlockFromSlot = _removeBlockFromSlot
const resetCmsDraft = _resetCmsDraft
const saveCmsFields = _saveCmsFields

const EDITOR_RESERVED_PARAMS = ["editor", "select", "config"] as const
const FRAMEWORK_INTERNAL_PARAMS = [
  "partials",
  "cached",
  "__frame",
  "__frameUrl",
  "disableTransition",
] as const

function stripEditorAndInternalParams(url: URL): void {
  for (const p of EDITOR_RESERVED_PARAMS) url.searchParams.delete(p)
  for (const p of FRAMEWORK_INTERNAL_PARAMS) url.searchParams.delete(p)
}

function derivePreviewUrl(): string {
  const url = new URL(getRequest().url)
  stripEditorAndInternalParams(url)
  return url.pathname + url.search
}

/**
 * CmsIds that rendered for the previewed page, taken from the
 * route-scoped partial registry. Each `ReactCms.partial(...)` call
 * site self-registers its `cmsId` at render time, so "what cmsIds
 * belong on this page" is a runtime fact the framework already
 * tracks. The editor tree reads it and walks each as a tree root —
 * `buildCmsTreeEntries` filters slot-children-of-other-roots out
 * automatically, so passing the full set (roots + descendants) is
 * idempotent.
 *
 * Cold-start: an empty registry produces an empty tree. The next
 * full render of this route warms the canonical store and the tree
 * fills in. Inside cache-mode refetches the canonical store carries
 * the previous full render, so the tree stays populated.
 */
function renderedCmsIdsForPreviewedPage(): string[] {
  const ids = new Set<string>()
  const snapshots = getRouteSnapshots()
  if (snapshots) {
    for (const snap of snapshots.values()) {
      if (snap.cmsId != null) ids.add(snap.cmsId)
    }
  }
  return [...ids]
}

function previewRequest(): Request {
  const page = getRequest()
  const url = new URL(page.url)
  stripEditorAndInternalParams(url)
  return new Request(url, { headers: page.headers, method: "GET" })
}

function cmsEditHref(opts: { select: string; config?: number }): string {
  const url = new URL(getRequest().url)
  url.searchParams.set("select", opts.select)
  if (opts.config != null && opts.config >= 0) {
    url.searchParams.set("config", String(opts.config))
  } else {
    url.searchParams.delete("config")
  }
  url.searchParams.delete("editor")
  for (const p of FRAMEWORK_INTERNAL_PARAMS) url.searchParams.delete(p)
  return url.pathname + url.search
}

// ─── Tree pane ─────────────────────────────────────────────────────────

export const EditorTreePartial = ReactCms.partial(
  async function EditorTreeRender({
    selected,
  }: {
    selected: string | null
    previewPath: string
  } & RenderArgs) {
    // Tree shows what `<Spec cmsId>` rendered for the previewed page —
    // the registry maps "this page's tree" without a hardcoded route
    // table. The `await` below also yields long enough for sibling
    // partials (page roots + their slot children) to synchronously
    // register before we read the registry.
    const catalog = await getCatalogManifest()
    const rootIds = renderedCmsIdsForPreviewedPage()
    const entries = listAllCmsNodes(rootIds)
    const blockTypes = listSpecTypes()

    const parentTypeById = new Map<string, string | undefined>()
    for (const entry of entries) {
      if (entry.kind === "node") parentTypeById.set(entry.id, entry.type)
    }

    if (entries.length === 0) {
      return (
        <p className="text-sm text-muted-foreground" data-testid="cms-edit-tree-empty">
          {rootIds.length === 0
            ? "No CMS-aware partials rendered on this page yet. Navigate to a page that mounts a CMS root, or refresh once to warm the registry."
            : "The CMS store is empty for this page's roots."}
        </p>
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
      <div>
        <p className="mb-3 text-xs uppercase tracking-wide text-muted-foreground">Content tree</p>
        <ul className="space-y-1">
          {entries.map((entry) => {
            if (entry.kind === "slot") {
              return (
                <li
                  key={entry.id}
                  style={{ paddingLeft: `${entry.depth * 12}px` }}
                  className="flex items-center gap-1"
                  data-testid={`cms-edit-tree-entry-${entry.id}`}
                >
                  <span
                    className="flex flex-1 items-center gap-2 rounded-md px-2 py-1 text-xs italic text-muted-foreground min-w-0"
                    data-testid={`cms-edit-tree-slot-label-${entry.parentId}-${entry.slotName}`}
                  >
                    <span aria-hidden className="text-muted-foreground/70">
                      ▸
                    </span>
                    <span className="flex-1 truncate">{entry.slotName}</span>
                  </span>
                </li>
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
                      return blockTagsSatisfyAllow(m.tags, allow)
                    })
              const options = filteredTypes.map((type) => ({
                type,
                action: addBlockToSlot.bind(null, entry.parentId!, entry.slotName!, type),
              }))
              return (
                <li
                  key={entry.id}
                  style={{ paddingLeft: `${entry.depth * 12}px` }}
                  className="flex items-center gap-1"
                  data-testid={`cms-edit-tree-entry-${entry.id}`}
                >
                  <CmsEditAddBlock
                    parentCmsId={entry.parentId!}
                    slotName={entry.slotName!}
                    options={options}
                  />
                </li>
              )
            }
            const isSelected = entry.id === selected
            const label = entry.displayName ?? `#${entry.id}`
            const slotKey =
              entry.parentId && entry.slotName ? `${entry.parentId}:${entry.slotName}` : null
            const idx = slotKey != null ? (rowIndex.get(entry.id) ?? 0) : 0
            const total = slotKey != null ? (slotCounts.get(slotKey) ?? 1) : 1
            const inSlot = entry.parentId && entry.slotName
            return (
              <li
                key={entry.id}
                style={{ paddingLeft: `${entry.depth * 12}px` }}
                className="flex items-center gap-1"
              >
                <CmsEditTreeLink
                  href={cmsEditHref({ select: entry.id })}
                  className={cn(
                    "flex flex-1 items-center gap-2 rounded-md px-2 py-1 text-sm transition-colors min-w-0",
                    isSelected ? "bg-primary/10 text-primary" : "hover:bg-muted",
                  )}
                  testId={`cms-edit-tree-entry-${entry.id}`}
                  selected={isSelected}
                >
                  <span className="flex-1 truncate" title={label}>
                    {label}
                  </span>
                  {entry.type && (
                    <Badge variant="secondary" className="px-1.5 py-0 text-[0.7rem]">
                      {entry.type}
                    </Badge>
                  )}
                  {entry.draftOnly ? (
                    <Badge
                      variant="outline"
                      className="border-amber-400/60 px-1.5 py-0 text-[0.65rem]"
                      data-testid={`cms-edit-tree-entry-${entry.id}-draft-badge`}
                    >
                      draft
                    </Badge>
                  ) : entry.hasDraft ? (
                    <Badge
                      variant="outline"
                      className="border-blue-400/60 px-1.5 py-0 text-[0.65rem]"
                      data-testid={`cms-edit-tree-entry-${entry.id}-modified-badge`}
                    >
                      modified
                    </Badge>
                  ) : null}
                </CmsEditTreeLink>
                {inSlot && (
                  <span className="flex shrink-0 items-center">
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
                      className="contents"
                    >
                      <button
                        type="submit"
                        className="rounded px-1 text-muted-foreground hover:bg-muted disabled:opacity-30"
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
                      className="contents"
                    >
                      <button
                        type="submit"
                        className="rounded px-1 text-muted-foreground hover:bg-muted disabled:opacity-30"
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
                      className="contents"
                    >
                      <button
                        type="submit"
                        className="rounded px-1 text-red-600/80 hover:bg-red-50"
                        title="Remove"
                        aria-label={`Remove ${entry.id}`}
                        data-testid={`cms-edit-slot-remove-${entry.id}`}
                      >
                        ×
                      </button>
                    </form>
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      </div>
    )
  },
  {
    selector: "#cms-edit-tree",
    // Fold the previewed pathname into the fp so cross-page
    // navigation invalidates the tree even though `?select=` is
    // unchanged. The previewed pathname == the request pathname
    // (editor toggle / select live in `?search`, never the path),
    // so reading `pathname` directly is correct.
    vary: ({ search: { select: selected = null }, pathname }) => ({
      selected,
      previewPath: pathname,
    }),
  },
)

// ─── Field panel ───────────────────────────────────────────────────────

export const EditorFieldPanelPartial = ReactCms.partial(
  async function EditorFieldPanelRender({
    selected,
    configIndexRaw,
  }: {
    pathname: string
    selected: string | null
    configIndexRaw: string | null
  } & RenderArgs) {
    if (!selected) {
      return (
        <div className="text-sm text-muted-foreground">
          Select a Partial from the tree to edit its fields.
        </div>
      )
    }
    if (parseSlotEntryId(selected)) {
      return (
        <div className="text-sm text-muted-foreground">
          Slots aren't selectable. Click a block to edit its fields.
        </div>
      )
    }
    const node = lookupDraftNode(selected)
    const catalog = await getCatalogManifest()
    const manifest = node?.type ? catalog[node.type] : undefined
    const hasDraft = listAllCmsNodes().some((e) => e.id === selected && e.hasDraft)
    const configs = node?.configs ?? []
    const configIndex = configIndexRaw != null ? Number(configIndexRaw) : null
    const effectiveIndex = pickEffectiveConfig(configs, configIndex)
    const currentConfig = effectiveIndex >= 0 ? configs[effectiveIndex] : null
    const fieldMap = buildFieldMap(currentConfig, manifest)

    return (
      <div className="space-y-4">
        <div>
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Selected</p>
          <p className="text-sm font-medium" data-testid="cms-edit-selected-id">
            {node?.displayName ?? `#${selected}`}
          </p>
          <p className="text-xs text-muted-foreground">id: {selected}</p>
        </div>

        {hasDraft && (
          <form action={asFormAction(resetCmsDraft.bind(null, selected))}>
            <Button type="submit" size="sm" variant="outline" data-testid="cms-edit-reset-draft">
              Reset draft → published
            </Button>
          </form>
        )}

        {configs.length > 0 && (
          <ConfigTabs selected={selected} configs={configs} activeIndex={effectiveIndex} />
        )}

        {Object.keys(fieldMap).length === 0 ? (
          <Card className="p-4">
            <CardContent className="px-0 text-sm text-muted-foreground">
              No fields on this configuration yet.
            </CardContent>
          </Card>
        ) : (
          <form
            key={`${selected}:${effectiveIndex}`}
            action={asFormAction(saveCmsFields.bind(null, selected, effectiveIndex))}
            className="space-y-3"
            data-testid="cms-edit-field-form"
          >
            {Object.entries(fieldMap).map(([name, spec]) => (
              <FieldInput key={name} name={name} kind={spec.kind} value={spec.value} />
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
                href={cmsEditHref({ select: selected, config: effectiveIndex })}
                className={buttonVariants({ size: "sm", variant: "ghost" })}
              >
                Discard changes
              </a>
            </div>
          </form>
        )}
      </div>
    )
  },
  {
    selector: "#cms-edit-fields",
    vary: ({ pathname, search: { select: selected = null, config: configIndexRaw = null } }) => ({
      // Pathname is folded into the fp so the auto-picked config tab
      // follows preview navigation — pickBestConfigIndex reads the
      // previewed-page pathname inside render, but the vary surface
      // would otherwise miss path-only changes.
      pathname,
      selected,
      configIndexRaw,
    }),
  },
)

// ─── Helpers (config tabs, field map, format helpers) ──────────────────

function pickEffectiveConfig(configs: readonly CmsConfig[], requested: number | null): number {
  if (configs.length === 0) return -1
  if (requested != null && requested >= 0 && requested < configs.length) return requested
  const best = pickBestConfigIndex(configs, previewRequest())
  if (best != null) return best
  const defaultIdx = configs.findIndex((c) => Object.keys(c.match).length === 0)
  return defaultIdx >= 0 ? defaultIdx : 0
}

function ConfigTabs({
  selected,
  configs,
  activeIndex,
}: {
  selected: string
  configs: readonly CmsConfig[]
  activeIndex: number
}) {
  return (
    <div data-testid="cms-edit-config-tabs">
      <p className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">Configuration</p>
      <div className="flex flex-wrap gap-1">
        {configs.map((cfg, idx) => {
          const isActive = idx === activeIndex
          const label = formatMatchLabel(cfg.match)
          return (
            <a
              key={idx}
              href={cmsEditHref({ select: selected, config: idx })}
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

function blockTagsSatisfyAllow(tags: readonly `.${string}`[], allow: string): boolean {
  const tokens = allow
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
  for (const token of tokens) {
    if (token.startsWith(".") && tags.includes(token as `.${string}`)) return true
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
    <label
      htmlFor={`cms-edit-field-${name}`}
      className="mb-1 block text-xs font-medium text-muted-foreground"
    >
      {name}
      <span className="ml-2 text-[0.65rem] uppercase opacity-60">{kind}</span>
    </label>
  )
  const commonClass =
    "w-full rounded-md border border-input bg-background px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2"

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
      )
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
      )
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
      )
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
      )
  }
}

function BooleanSidecar({ fields }: { fields: string[] }) {
  if (fields.length === 0) return null
  return <input type="hidden" name="__boolean-fields" value={fields.join(",")} />
}

// ─── Editor shell ──────────────────────────────────────────────────────
//
// `EditorShell` is itself a partial. Its vary reads both the
// `?editor=1`/`?editor=0` URL toggle (immediate effect this request)
// and the editor cookie (sticky across requests). The render persists
// the URL toggle to the cookie so the next request reads it back from
// the cookie alone. When the resolved mode is off, the spec just
// passes its children through (no UI); when on, it wraps them in the
// three-pane layout.

export const EditorShell = ReactCms.partial(
  function EditorShellRender({
    editor,
    sync,
    parent,
    children,
  }: { editor: boolean; sync: string | null } & RenderArgs) {
    // Persist the URL toggle as a cookie so subsequent requests stick
    // without `?editor=` in the URL.
    if (sync === "1") setCookie(EDITOR_COOKIE, "1")
    else if (sync === "0") setCookie(EDITOR_COOKIE, "", 0)

    if (!editor) {
      return (
        <div className="mx-auto min-h-screen max-w-225 p-8" data-testid="page-shell">
          {children}
        </div>
      )
    }
    const previewUrl = derivePreviewUrl()
    const incomingUrl = new URL(getRequest().url)
    const isPreviewFrameRefetch = incomingUrl.searchParams.getAll("__frame").includes("preview")
    if (!isPreviewFrameRefetch) setSessionFrameUrl(["preview"], previewUrl)
    return (
      <div
        className="grid gap-0 min-h-screen items-start"
        style={{ gridTemplateColumns: "320px minmax(0, 1fr) 360px" }}
      >
        <aside
          className="sticky top-0 h-screen overflow-y-auto border-r bg-muted/30 p-4"
          data-testid="cms-edit-tree-pane"
        >
          <EditorTreePartial parent={parent} />
        </aside>
        <main className="min-h-screen" data-testid="cms-edit-preview-pane">
          <div
            className="sticky top-0 z-10 flex items-center gap-3 border-b bg-background/95 px-4 py-3 backdrop-blur"
            data-testid="cms-edit-preview-chrome"
          >
            <CmsEditAddressBar initialUrl={previewUrl} />
            <form action={asFormAction(publishCmsDraft)}>
              <Button type="submit" size="sm" variant="outline">
                Publish
              </Button>
            </form>
          </div>
          <div className="p-4">{children}</div>
        </main>
        <aside
          className="sticky top-0 h-screen overflow-y-auto border-l bg-muted/30 p-4"
          data-testid="cms-edit-field-pane"
        >
          <EditorFieldPanelPartial parent={parent} />
        </aside>
      </div>
    )
  },
  {
    vary: ({
      search: { editor: editorParam = null },
      cookies: { [EDITOR_COOKIE]: cookieFlag },
    }) => {
      // URL toggle wins for the current request so the editor pops
      // open immediately; the render also sets the cookie so the
      // mode persists. The framework folds the page URL into every
      // spec's fingerprint, so descendant page wrappers re-evaluate
      // on URL changes without needing to opt in here.
      const editor = editorParam === "1" ? true : editorParam === "0" ? false : cookieFlag === "1"
      return { editor, sync: editorParam }
    },
  },
)
