"use server";

/**
 * CMS editor server actions.
 *
 * - `saveCmsFields(cmsId, formData)` — merge form entries into the
 *   draft node's default config (the `match: {}` config), creating
 *   the config or node if missing. Returns an invalidate directive
 *   targeting the edited Partial so the preview refetches in place.
 * - `publishCmsDraft()` — copy every draft entry into published,
 *   clear the draft file. Invalidates the whole page so the editor
 *   re-reads both stores.
 */

import {
  lookupCmsNode,
  publishDraft,
  writeDraftNode,
  type CmsConfig,
  type CmsNode,
} from "../../framework/cms-runtime.ts";

export async function saveCmsFields(
  cmsId: string,
  formData: FormData,
): Promise<{ invalidate: { selector: string } }> {
  const existing: CmsNode = lookupCmsNode(cmsId) ?? {
    id: cmsId,
    configs: [],
  };
  // Clone so we don't mutate the cached node shape.
  const node: CmsNode = {
    ...existing,
    id: cmsId,
    configs: existing.configs.map((c) => ({
      match: { ...c.match },
      fields: { ...c.fields },
    })),
    slots: existing.slots,
  };

  let defaultConfig: CmsConfig | undefined = node.configs.find(
    (c) => Object.keys(c.match).length === 0,
  );
  if (!defaultConfig) {
    defaultConfig = { match: {}, fields: {} };
    node.configs.push(defaultConfig);
  }

  for (const [key, raw] of formData.entries()) {
    if (key.startsWith("__")) continue; // editor-internal fields
    const value = raw;
    // FormData values are string | File. Coerce.
    if (typeof value === "string") {
      // Numeric-looking inputs come back as strings; store as number
      // only when the input is typed as number AND the parse is
      // clean. The form tells us via a sidecar `__kind:<name>`
      // entry.
      const kind = formData.get(`__kind:${key}`);
      if (kind === "number") {
        const n = Number(value);
        defaultConfig.fields[key] = Number.isFinite(n) ? n : 0;
      } else if (kind === "boolean") {
        defaultConfig.fields[key] = value === "on" || value === "true";
      } else {
        defaultConfig.fields[key] = value;
      }
    }
  }

  // HTML checkboxes only appear in formData when checked — so any
  // boolean field declared on the form but missing from formData is
  // "false". The form emits `__boolean-fields=<name1>,<name2>`.
  const booleanFields = (formData.get("__boolean-fields") ?? "")
    .toString()
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const name of booleanFields) {
    if (!formData.has(name)) {
      defaultConfig.fields[name] = false;
    }
  }

  writeDraftNode(cmsId, node);
  return { invalidate: { selector: `#${cmsId}` } };
}

export async function publishCmsDraft(): Promise<{
  invalidate: { selector: string };
}> {
  publishDraft();
  // Blunt: invalidate the editor page so the tree rebuilds from the
  // updated stores. A future iteration could target only the
  // previously-drafted ids.
  return { invalidate: { selector: "#cms-edit-tree" } };
}
