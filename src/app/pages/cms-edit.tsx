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

import { getSearchParam, setCookie } from "../../framework/context.ts";
import {
  CMS_DRAFT_COOKIE,
  listAllCmsNodes,
  lookupCmsNode,
  type CmsNode,
  type ContentFieldKind,
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
import { publishCmsDraft, saveCmsFields } from "../actions/cms.ts";

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

  const selected = getSearchParam("select");

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
          <TreePanel selected={selected} />
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
          <FieldPanel selected={selected} />
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

function TreePanel({ selected }: { selected: string | null }) {
  return (
    <Partial parent={ROOT} selector="#cms-edit-tree">
      <div>
        <p className="mb-3 text-xs uppercase tracking-wide text-muted-foreground">
          Content tree
        </p>
        <TreeContents selected={selected} />
      </div>
    </Partial>
  );
}

function TreeContents({ selected }: { selected: string | null }) {
  const entries = listAllCmsNodes();
  if (entries.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        The store is empty. Partials appear here once they're saved to
        the draft or committed to <code>content.json</code>.
      </p>
    );
  }
  return (
    <ul className="space-y-1">
      {entries.map((entry) => {
        const isSelected = entry.id === selected;
        const label = entry.displayName ?? `#${entry.id}`;
        return (
          <li
            key={entry.id}
            style={{ paddingLeft: `${entry.depth * 12}px` }}
          >
            <a
              href={`/cms-edit?select=${encodeURIComponent(entry.id)}`}
              className={cn(
                "flex items-center gap-2 rounded-md px-2 py-1 text-sm transition-colors",
                isSelected
                  ? "bg-primary/10 text-primary"
                  : "hover:bg-muted",
              )}
              data-testid={`cms-edit-tree-entry-${entry.id}`}
              data-selected={isSelected}
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
              {entry.draftOnly && (
                <Badge
                  variant="outline"
                  className="border-amber-400/60 px-1.5 py-0 text-[0.65rem] text-amber-600 dark:text-amber-400"
                >
                  draft
                </Badge>
              )}
            </a>
          </li>
        );
      })}
    </ul>
  );
}

// ─── Field form ────────────────────────────────────────────────────────

async function FieldPanel({ selected }: { selected: string | null }) {
  if (!selected) {
    return (
      <div className="text-sm text-muted-foreground">
        Select a Partial from the tree to edit its fields.
      </div>
    );
  }
  const node = lookupCmsNode(selected);
  const catalog = await getCatalogManifest();
  const manifest = node?.type ? catalog[node.type] : undefined;
  const fieldMap = buildFieldMap(node, manifest);
  const selectedHref = `/cms-edit?select=${encodeURIComponent(selected)}`;

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

      {Object.keys(fieldMap).length === 0 ? (
        <Card className="p-4">
          <CardContent className="px-0 text-sm text-muted-foreground">
            No fields discovered for this Partial yet. Render it once
            with accessor reads at the top of the body so the catalog
            picks them up, or save an initial value from code.
          </CardContent>
        </Card>
      ) : (
        <form
          action={saveCmsFields.bind(null, selected)}
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
              href={selectedHref}
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

interface FieldSpec {
  kind: ContentFieldKind;
  value: unknown;
}

function buildFieldMap(
  node: CmsNode | null,
  manifest: BlockManifest | undefined,
): Record<string, FieldSpec> {
  const out: Record<string, FieldSpec> = {};
  const defaultConfig = node?.configs.find(
    (c) => Object.keys(c.match).length === 0,
  );
  // Seed from the catalog (covers block-typed entries comprehensively).
  if (manifest) {
    for (const [name, kind] of Object.entries(manifest.contentFields)) {
      out[name] = {
        kind,
        value: defaultConfig?.fields[name],
      };
    }
  }
  // Union currently-stored fields (covers code-declared Partials that
  // have a draft entry, and any fields saved before the catalog knew
  // about them).
  if (defaultConfig) {
    for (const [name, value] of Object.entries(defaultConfig.fields)) {
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
