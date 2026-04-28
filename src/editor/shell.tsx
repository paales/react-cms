/**
 * Editor shell — the chrome that wraps every page render when editor
 * mode is on (cookie-gated; see `Root` in `src/app/root.tsx`).
 *
 * Three-pane layout:
 *   - Left: tree of every Partial currently in the CMS store (draft
 *     merged over published). Click an entry to select it (adds
 *     `?select=<cmsId>` to the URL).
 *   - Center: an address bar plus the previewed page (`children`).
 *     The preview IS the window URL — navigating the address bar
 *     updates the window URL, and Root re-runs `pickRoute` against
 *     the new path. Browser back/forward, deep links, refresh —
 *     everything just works.
 *   - Right: form for the selected Partial. Inputs derive from the
 *     catalog manifest (for block-typed entries) unioned with the
 *     currently stored fields (so code-declared Partials that have
 *     a draft entry are also editable).
 *
 * Editor state on the URL: `?select=…&config=N`. The address bar
 * preserves them on every nav (the editor is a workspace, selection
 * persists across page changes); preview-internal `<a>` clicks drop
 * them by default — fresh browse, fresh selection.
 *
 * The matching config tab is auto-picked from the previewed page's
 * URL (e.g. visiting `/cms-demo/alpha` highlights the `slug=alpha`
 * tab). Authors can still override via explicit `?config=N`.
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
 * Scope deferred to later iterations (see docs/cms.md):
 *   - Block palette — authors can't add new slot entries beyond
 *     what the slot's `allow` permits.
 *   - Drag-drop.
 *   - Rich entity pickers.
 *   - Draft isolation per author/session.
 */

import type { ReactNode } from "react"
import { getRequest, getSearchParam } from "../framework/context.ts"
import {
  listAllCmsNodes,
  listBlockTypes,
  lookupDraftNode,
  parseSlotEntryId,
  pickBestConfigIndex,
  type CmsConfig,
  type ContentFieldKind,
  type MatchClause,
} from "../framework/cms-runtime.ts"
import { getCatalogManifest, type BlockManifest } from "../framework/cms-prerender.ts"
import { getRouteSnapshots } from "../lib/partial-registry.ts"
import { setSessionFrameUrl } from "../framework/session.ts"
import { Partial } from "../lib/index.ts"
import { ROOT } from "../lib/partial-context.ts"
import { Card, CardContent } from "@/components/ui/card"
import { Button, buttonVariants } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { CmsEditTreeLink } from "./components/tree-link.tsx"
import { CmsEditAddBlock } from "./components/add-block.tsx"
import { CmsEditAddressBar } from "./components/address-bar.tsx"
import {
  addBlockToSlot,
  moveBlockInSlot,
  publishCmsDraft,
  removeBlockFromSlot,
  resetCmsDraft,
  saveCmsFields,
} from "./actions.ts"

/**
 * Query-string params that belong to the editor (not the previewed
 * page) and must be stripped from the preview URL before scoring CMS
 * configs or showing the URL bar. The cookie-driven `editor` toggle
 * is still here too — it can land via the one-shot `?editor=1` URL
 * before the cookie has round-tripped, and we don't want it leaking
 * into accessor reads inside the previewed page.
 */
const EDITOR_RESERVED_PARAMS = ["editor", "select", "config"] as const

/**
 * Tree scope: every cmsId that rendered for the previewed page,
 * derived from the route-scoped partial registry.
 *
 * `<Partial cmsId="…">` self-registers under its route at render
 * time — so "what cmsIds belong on this page" is already a runtime
 * fact the framework tracks. The editor reads it. Chrome that
 * renders on every page (e.g. `<AppNav>`'s `app-nav`) appears in
 * every route's snapshot bucket; per-page roots (`cms-demo-root`)
 * appear only where they render.
 *
 * `getRouteSnapshots` returns the union of pending writes (this
 * render's registrations so far) AND the previousView (the prior
 * render's committed snapshots). Cold start (process boot OR a
 * route never rendered before): an empty list returns and the tree
 * shows the empty-state hint; the next render fills it in.
 */
function rootCmsIdsForPreviewedPage(): readonly string[] {
  const route = new URL(getRequest().url).pathname
  const ids = new Set<string>()
  const bucket = getRouteSnapshots(route)
  if (bucket) {
    for (const snap of bucket.values()) {
      if (snap.cmsId != null) ids.add(snap.cmsId)
    }
  }
  return [...ids]
}

/**
 * Framework-internal query params that ride along on RSC fetches but
 * should never persist on the visible window URL. `getRequest().url`
 * sees them when a refetch hits the server, and we strip them before
 * computing tree/config-tab hrefs so a click doesn't bake them into
 * the next page entry. Same shape as the strip we do for the
 * preview URL display — they're noise in both places.
 */
const FRAMEWORK_INTERNAL_PARAMS = [
  "partials",
  "cached",
  "__frame",
  "__frameUrl",
  "disableTransition",
] as const

/**
 * Strip editor- AND framework-internal params from the page URL to
 * get the URL the preview is "really" looking at. Used both as the
 * initial value for the address bar and as the synthetic Request's
 * URL for config-tab scoring (config tabs match against the
 * previewed page, not the full editor-state URL).
 */
function derivePreviewUrl(): string {
  const url = new URL(getRequest().url)
  stripEditorAndInternalParams(url)
  return url.pathname + (url.search ? url.search : "")
}

/**
 * Build a Request whose URL strips editor-internal params — used for
 * config-tab match scoring so a tab labeled `slug=alpha` highlights
 * when the previewed page is `/cms-demo/alpha`, regardless of any
 * `?select=…&config=…` editor state riding along on the URL.
 */
function previewRequest(): Request {
  const page = getRequest()
  const url = new URL(page.url)
  stripEditorAndInternalParams(url)
  return new Request(url, { headers: page.headers, method: "GET" })
}

function stripEditorAndInternalParams(url: URL): void {
  for (const p of EDITOR_RESERVED_PARAMS) url.searchParams.delete(p)
  for (const p of FRAMEWORK_INTERNAL_PARAMS) url.searchParams.delete(p)
}

export function EditorShell({ children }: { children: ReactNode }) {
  // NOTE: `?select=` and `?config=` are read INSIDE TreeContents and
  // FieldPanel (not here). That way a cache-mode refetch of
  // `#cms-edit-tree` / `#cms-edit-fields` triggered by selector-
  // targeted nav (`<CmsEditTreeLink>`) re-resolves the URL state
  // freshly — the snapshots can't bake in a stale `selected` closure.
  //
  // Frame-URL ↔ window-URL sync: we want the address bar to drive
  // window navigation (so URLs are bookmarkable, browser back/forward
  // works, and `pickRoute` against the page request runs against the
  // user-typed path), AND we want the `<Partial frame="preview">`
  // scope so tracked accessor reads inside the previewed page (e.g.
  // a search Partial reading `url:q`) don't see editor-state params
  // like `?select=` from the page URL. The two are reconciled by
  // overwriting the session frame URL on every Root render with the
  // window URL minus editor params. The frame's accessors then see
  // a clean URL; the editor chrome's accessors (outside the frame)
  // see the full page URL with editor state. No cross-contamination.
  //
  // Side effect: `useNavigation("preview").navigate(...)` writes to
  // session, but the next Root render overwrites it. There is no
  // explicit caller of that handle today; the address bar uses
  // `useNavigation()` (window-scoped) which goes through normal
  // page navigation. If a future component wants frame-isolated
  // navigation, this sync needs to be relaxed.
  const previewUrl = derivePreviewUrl()
  // Sync the preview frame's session URL to the window URL — but
  // ONLY when this isn't itself a frame refetch. A frame refetch
  // arrives with `?__frame=preview&__frameUrl=…` query params;
  // `PartialRoot` already wrote the new URL to the session before
  // we got here. Overwriting it now would clobber the frame nav
  // (e.g. LoadMore's `?pages=2` bump on the Pokemon page would
  // round-trip but the session URL would snap back to `/` and the
  // server would render against the unchanged URL — infinite scroll
  // appears broken).
  const incomingUrl = new URL(getRequest().url)
  const isPreviewFrameRefetch = incomingUrl.searchParams.getAll("__frame").includes("preview")
  if (!isPreviewFrameRefetch) {
    setSessionFrameUrl(["preview"], previewUrl)
  }

  // Layout: 3-column grid where the LEFT and RIGHT columns are
  // sticky+scroll-internal, and the CENTER column flows with the
  // window. Two reasons:
  //   1. IntersectionObserver activators (`<WhenVisible>`) inside
  //      the previewed page default their root to the window
  //      viewport. If the preview pane scrolled internally instead,
  //      observers would never fire — the trivia partial / infinite
  //      scroll on the Pokemon homepage break.
  //   2. Browser-native scroll experience: page-down / mouse wheel
  //      scrolls the previewed content as expected, the editor
  //      sidebars stay pinned where the author left them.
  return (
    <div
      className="grid gap-0 min-h-screen items-start"
      style={{
        gridTemplateColumns: "320px minmax(0, 1fr) 360px",
      }}
    >
      <aside
        className="sticky top-0 h-screen overflow-y-auto border-r bg-muted/30 p-4"
        data-testid="cms-edit-tree-pane"
      >
        <TreePanel />
      </aside>
      <main className="min-h-screen" data-testid="cms-edit-preview-pane">
        <PreviewPanel previewUrl={previewUrl}>{children}</PreviewPanel>
      </main>
      <aside
        className="sticky top-0 h-screen overflow-y-auto border-l bg-muted/30 p-4"
        data-testid="cms-edit-field-pane"
      >
        <Partial parent={ROOT} selector="#cms-edit-fields">
          <FieldPanel />
        </Partial>
      </aside>
    </div>
  )
}

// ─── Preview ───────────────────────────────────────────────────────────

function PreviewPanel({ previewUrl, children }: { previewUrl: string; children: ReactNode }) {
  return (
    <>
      {/* Sticky address bar pins to the top of the preview column
          while content scrolls under it. `top: 0` aligns with the
          two side aside panels for visual continuity. */}
      <div
        className="sticky top-0 z-10 flex items-center gap-3 border-b bg-background/95 px-4 py-3 backdrop-blur"
        data-testid="cms-edit-preview-chrome"
      >
        <CmsEditAddressBar initialUrl={previewUrl} />
        <form action={publishCmsDraft}>
          <Button type="submit" size="sm" variant="outline">
            Publish
          </Button>
        </form>
      </div>
      <div className="p-4">
        {/* `<Partial frame="preview">` opens a frame scope so tracked
            accessor reads inside the previewed page (`getSearchParam`,
            `getCookie`, etc.) resolve against the frame's request —
            which carries the WINDOW URL minus editor-internal params.
            Without this isolation, the search Partial inside the
            preview would see the editor's `?select=` on the page URL
            and pick it up as a manifest read, throwing
            `HoistingViolationError` once the user clicks a tree
            entry and `select` appears for the first time.
            Selector token `#preview` matches the `frame="preview"`
            name so frame refetches dispatch through it correctly. */}
        <Partial parent={ROOT} selector="#preview" frame="preview" frameUrl={previewUrl}>
          {children}
        </Partial>
      </div>
    </>
  )
}

// ─── Tree ──────────────────────────────────────────────────────────────

function TreePanel() {
  return (
    <Partial parent={ROOT} selector="#cms-edit-tree">
      <div>
        <p className="mb-3 text-xs uppercase tracking-wide text-muted-foreground">Content tree</p>
        <TreeContents />
      </div>
    </Partial>
  )
}

async function TreeContents() {
  // Read URL state INSIDE the Partial so cache-mode refetches see the
  // fresh `?select=` value — the snapshot's content runs again on
  // every refetch. Tracked accessor folds the read into the manifest,
  // so the structural fingerprint captures `?select=` automatically:
  // a same-route nav that changes the param differs the fp and the
  // fp-skip protocol re-renders correctly.
  const selected = getSearchParam("select")
  // Tree shows what `<Partial cmsId>` rendered for this page —
  // derived from the route-scoped partial registry, not a hardcoded
  // map. Chrome (app-nav) appears on every page because it renders
  // on every page; per-page roots only appear on their pages.
  const rootIds = rootCmsIdsForPreviewedPage()
  const entries = listAllCmsNodes(rootIds)
  const blockTypes = listBlockTypes()
  const catalog = await getCatalogManifest()

  // Build parentId → parentType map so we can look up each slot
  // intermediary's parent block type (and from there, the slot's
  // `allow` declaration in the manifest).
  const parentTypeById = new Map<string, string | undefined>()
  for (const entry of entries) {
    if (entry.kind === "node") parentTypeById.set(entry.id, entry.type)
  }

  if (entries.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="cms-edit-tree-empty">
        {rootIds.length === 0
          ? "Loading content tree… the registry is cold for this route. Refresh once to populate."
          : "The CMS store is empty. Partials appear here once they're saved to the draft or committed to content.json."}
      </p>
    )
  }

  // Per-row slot index (for ↑ / ↓ disable state). Single pass: walk
  // entries in order and assign each slot child its position within
  // its slot.
  const rowIndex = new Map<string, number>()
  const slotCounts = new Map<string, number>()
  for (const entry of entries) {
    if (entry.kind === "node" && entry.parentId && entry.slotName) {
      const slotKey = `${entry.parentId}:${entry.slotName}`
      const next = slotCounts.get(slotKey) ?? 0
      rowIndex.set(entry.id, next)
      slotCounts.set(slotKey, next + 1)
    }
  }

  return (
    <ul className="space-y-1">
      {entries.map((entry) => {
        if (entry.kind === "slot") {
          return (
            <SlotHeaderRow
              key={entry.id}
              parentCmsId={entry.parentId!}
              slotName={entry.slotName!}
              depth={entry.depth}
            />
          )
        }
        if (entry.kind === "slot-add") {
          // Filter the +add palette by the slot's `allow` selector —
          // we look up the parent's block type → manifest →
          // `childSlots[slotName].allow` → keep only block types
          // whose tags satisfy the allow tokens. The wildcard token
          // `*` short-circuits filtering (slot accepts every block).
          // If the parent has no type or no manifest entry, the
          // palette falls back to the full block-type list (better
          // to show too many options than zero on an unrecognized
          // parent).
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
          return (
            <SlotAddRow
              key={entry.id}
              parentCmsId={entry.parentId!}
              slotName={entry.slotName!}
              depth={entry.depth}
              blockTypes={filteredTypes}
            />
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
        )
      })}
    </ul>
  )
}

/**
 * Slot header tree row — non-clickable label rendered ABOVE the
 * slot's children. Pure organization: makes it obvious which slot
 * a child belongs to, especially for parents with multiple slots.
 * The corresponding `+ add` palette lives in `<SlotAddRow>` rendered
 * after the slot's children.
 */
function SlotHeaderRow({
  parentCmsId,
  slotName,
  depth,
}: {
  parentCmsId: string
  slotName: string
  depth: number
}) {
  const id = `slot:${parentCmsId}:${slotName}`
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
    </li>
  )
}

/**
 * Slot footer tree row — the "+ Block" dropdown rendered AT THE END
 * of a slot's children. New blocks naturally land at the bottom of
 * the slot so the list grows downward (matches Shopify, WordPress,
 * Storyblok). Indented at the same depth as the slot's children so
 * the trigger feels like a sibling-row "add new" action.
 *
 * Clicking "+ Block" opens a menu with one item per registered block
 * type that satisfies the slot's `allow` selector. Each menu item
 * triggers the same server action (`addBlockToSlot`) the inline
 * buttons used to.
 */
function SlotAddRow({
  parentCmsId,
  slotName,
  depth,
  blockTypes,
}: {
  parentCmsId: string
  slotName: string
  depth: number
  blockTypes: string[]
}) {
  const id = `slot-add:${parentCmsId}:${slotName}`
  // Bind one action per block type on the server, then pass the
  // bound references to the client dropdown. Bound server actions
  // are RSC-serializable across the boundary.
  const options = blockTypes.map((type) => ({
    type,
    action: addBlockToSlot.bind(null, parentCmsId, slotName, type),
  }))
  return (
    <li
      style={{ paddingLeft: `${depth * 12}px` }}
      className="flex items-center gap-1"
      data-testid={`cms-edit-tree-entry-${id}`}
    >
      <CmsEditAddBlock parentCmsId={parentCmsId} slotName={slotName} options={options} />
    </li>
  )
}

/**
 * Per-slot-child inline action buttons in the tree — ↑ / ↓ / ×.
 */
function SlotChildControls({
  parentCmsId,
  slotName,
  childCmsId,
  index,
  total,
}: {
  parentCmsId: string
  slotName: string
  childCmsId: string
  index: number
  total: number
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
  )
}

// ─── Field form ────────────────────────────────────────────────────────

async function FieldPanel() {
  // Tracked accessors (sync top — required hoisting). Reads also fold
  // into the surrounding Partial's manifest, so the structural
  // fingerprint differs when either param changes — a plain-anchor
  // nav (config tab, browser URL bar, refresh) invalidates fp-skip
  // correctly.
  const selected = getSearchParam("select")
  const configIndexRaw = getSearchParam("config")
  const configIndex = configIndexRaw != null ? Number(configIndexRaw) : null
  if (!selected) {
    return (
      <div className="text-sm text-muted-foreground">
        Select a Partial from the tree to edit its fields.
      </div>
    )
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
        Slots aren't selectable. Use the inline buttons in the tree to add, reorder, or remove
        blocks; click a block to edit its fields here.
      </div>
    )
  }

  const node = lookupDraftNode(selected)
  const catalog = await getCatalogManifest()
  const manifest = node?.type ? catalog[node.type] : undefined
  // Detect "this id has unpublished changes" — the same condition
  // that drives the tree's modified badge.
  const hasDraft = listAllCmsNodes().some((e) => e.id === selected && e.hasDraft)
  const configs = node?.configs ?? []
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
        <ConfigTabs selected={selected} configs={configs} activeIndex={effectiveIndex} />
      )}

      {Object.keys(fieldMap).length === 0 ? (
        <Card className="p-4">
          <CardContent className="px-0 text-sm text-muted-foreground">
            No fields on this configuration yet. For block-typed entries the catalog seeds the field
            list from the block's accessor reads; for code-declared Partials, saved fields appear
            here once written.
          </CardContent>
        </Card>
      ) : (
        // Form key is `selected:effectiveIndex` so switching the
        // active config (or the selected node) remounts every input.
        // Without it, React reuses the existing `defaultValue`-driven
        // inputs across re-renders and the live `.value` stays at
        // whatever the user first saw, even though the new server-
        // rendered markup carries the new values.
        <form
          key={`${selected}:${effectiveIndex}`}
          action={saveCmsFields.bind(null, selected, effectiveIndex)}
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
}

// ─── Config tabs ──────────────────────────────────────────────────────

/**
 * Pick the config tab to show by default.
 *
 * Order:
 *   1. Explicit `?config=N` from the URL — author override.
 *   2. The highest-scoring config for the previewed page URL —
 *      navigating the preview to `/cms-demo/alpha` highlights the
 *      `slug=alpha` tab automatically without an explicit override.
 *   3. The empty-match (`{}`) config — the cascade default.
 *   4. Index 0 — falls back to whatever's there for empty-config
 *      nodes that the author is just starting on.
 */
function pickEffectiveConfig(configs: readonly CmsConfig[], requested: number | null): number {
  if (configs.length === 0) return -1
  if (requested != null && requested >= 0 && requested < configs.length) {
    return requested
  }
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
      <p className="mt-1 text-[0.7rem] text-muted-foreground">
        Editing this configuration writes only to its field set. Other configurations (and the
        cascade fallback) stay untouched.
      </p>
    </div>
  )
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
export function formatMatchLabel(match: Record<string, MatchClause>): string {
  const entries = Object.entries(match)
  if (entries.length === 0) return "Default"
  const parts = entries.map(([key, clause]) => formatClause(key, clause))
  return parts.join(" · ")
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

/**
 * Wildcard allow — a slot that accepts every registered block. The
 * editor's palette filter short-circuits when this returns true so
 * the +add row lists every block type (matches the runtime, where
 * `<Children allow="*">` declares the same intent).
 */
function isWildcardAllow(allow: string): boolean {
  return allow.split(/\s+/).some((t) => t.trim() === "*")
}

/**
 * Check whether a block's tag list satisfies a slot's `allow`
 * selector. Allow follows the same selector grammar as
 * `<Partial selector>`:
 *
 *   - Each whitespace-separated token starts with `.` (shared) or
 *     `#` (unique).
 *   - A `.foo` token matches a block whose tags include `.foo`.
 *   - A `#foo` token matches a block whose unique-token name equals
 *     `foo` (rare; allow is usually class-based).
 *
 * Multiple tokens combine as union — a block matches if it satisfies
 * ANY of the allow tokens.
 */
function blockTagsSatisfyAllow(tags: readonly `.${string}`[], allow: string): boolean {
  const tokens = allow
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
  for (const token of tokens) {
    if (token.startsWith(".") && tags.includes(token as `.${string}`)) {
      return true
    }
  }
  return false
}

function shortKey(key: string): string {
  // For `pathname:/p/:slug` the full pattern is too verbose on a
  // tab. Strip everything but the last `:param` segment.
  const match = key.match(/:([^/]+)$/)
  return match ? match[1] : key
}

/**
 * Build an editor-state href that keeps the user on the currently
 * previewed page (`getRequest().url`'s pathname + user-meaningful
 * search params) and updates only the editor params (`select`,
 * `config`).
 *
 * Editor-state lives on the window URL: tree clicks and config-tab
 * clicks change `?select=…&config=…` while the previewed page path
 * stays put. That way browser back/forward walks selection history
 * AND a plain reload preserves the workspace.
 *
 * Strips framework-internal refetch params (`partials`, `cached`,
 * etc.) — `getRequest().url` sees them on RSC fetches but they're
 * ephemeral; if we copied them onto the href, the next nav would
 * pin them onto the browser URL and the next refetch would carry
 * stale fingerprint hints.
 */
function cmsEditHref(opts: { select: string; config?: number }): string {
  const url = new URL(getRequest().url)
  url.searchParams.set("select", opts.select)
  if (opts.config != null && opts.config >= 0) {
    url.searchParams.set("config", String(opts.config))
  } else {
    url.searchParams.delete("config")
  }
  // The cookie keeps editor mode on; URL flag would just be noise.
  url.searchParams.delete("editor")
  for (const p of FRAMEWORK_INTERNAL_PARAMS) {
    url.searchParams.delete(p)
  }
  return url.pathname + url.search
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
  // Seed from the catalog so every field the block declares shows
  // up as an input, even when the current config hasn't set it yet
  // (cascade fallback will apply from a less-specific config).
  if (manifest) {
    for (const [name, kind] of Object.entries(manifest.contentFields)) {
      out[name] = {
        kind,
        value: config?.fields[name],
      }
    }
  }
  // Union currently-stored fields (covers code-declared Partials that
  // have a draft entry, and any fields saved before the catalog knew
  // about them).
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
    "w-full rounded-md border border-input bg-background px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"

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
      )
  }
}

function BooleanSidecar({ fields }: { fields: string[] }) {
  if (fields.length === 0) return null
  return <input type="hidden" name="__boolean-fields" value={fields.join(",")} />
}
