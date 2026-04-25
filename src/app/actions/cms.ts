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
  getBlockSpec,
  lookupDraftNode,
  publishDraft,
  revertDraftNode,
  writeDraftNode,
  type CmsConfig,
  type CmsNode,
} from "../../framework/cms-runtime.ts";

/**
 * Mutations that change slot structure (add/remove/reorder) need to
 * refetch both the preview Partial (to re-render the actual content)
 * AND the editor's tree + field panels (to re-render the slot list,
 * config tabs, etc.). Baking the selector list into a helper keeps
 * every action's return in sync.
 */
function invalidateEditorAround(cmsId: string): {
  invalidate: { selector: string };
} {
  return {
    invalidate: {
      selector: `#${cmsId} #cms-edit-tree #cms-edit-fields`,
    },
  };
}

export async function saveCmsFields(
  cmsId: string,
  configIndex: number,
  formData: FormData,
): Promise<{ invalidate: { selector: string } }> {
  const existing: CmsNode = lookupDraftNode(cmsId) ?? {
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

  // Index resolution: configIndex < 0 is "find or create the default
  // (match: {}) config" — used by the UI when no explicit config is
  // selected. A non-negative index targets that slot in `node.configs`,
  // creating entries up to that slot if the node was freshly made.
  let target: CmsConfig;
  if (configIndex < 0) {
    let existing = node.configs.find(
      (c) => Object.keys(c.match).length === 0,
    );
    if (!existing) {
      existing = { match: {}, fields: {} };
      node.configs.push(existing);
    }
    target = existing;
  } else if (configIndex < node.configs.length) {
    target = node.configs[configIndex];
  } else {
    target = { match: {}, fields: {} };
    node.configs.push(target);
  }

  for (const [key, raw] of formData.entries()) {
    if (key.startsWith("__")) continue; // editor-internal fields
    const value = raw;
    if (typeof value === "string") {
      const kind = formData.get(`__kind:${key}`);
      if (kind === "number") {
        const n = Number(value);
        target.fields[key] = Number.isFinite(n) ? n : 0;
      } else if (kind === "boolean") {
        target.fields[key] = value === "on" || value === "true";
      } else {
        target.fields[key] = value;
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
      target.fields[name] = false;
    }
  }

  writeDraftNode(cmsId, node);
  return invalidateEditorAround(cmsId);
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

/**
 * Drop the selected node's draft override. After this runs, the
 * editor (and any draft-cookie reader) sees the published value
 * for `cmsId` instead of whatever was being drafted. No-op if the
 * id has no draft entry to begin with.
 */
export async function resetCmsDraft(
  cmsId: string,
): Promise<{ invalidate: { selector: string } }> {
  revertDraftNode(cmsId);
  return invalidateEditorAround(cmsId);
}

/**
 * Deep clone of a CmsNode with its configs and slot children. Used
 * by mutation actions so we never write back the cached object that
 * `lookupCmsNode` returned — mutating it would silently corrupt the
 * in-memory index for other concurrent reads.
 */
function cloneNode(node: CmsNode): CmsNode {
  return {
    ...node,
    configs: node.configs.map((c) => ({
      match: { ...c.match },
      fields: { ...c.fields },
    })),
    slots: node.slots
      ? Object.fromEntries(
          Object.entries(node.slots).map(([name, children]) => [
            name,
            children.map(cloneNode),
          ]),
        )
      : undefined,
  };
}

/**
 * Generate a unique block id for a new slot entry. 8 chars of
 * base36 randomness after the type prefix — collision space is
 * ~2.8T, overkill for draft storage.
 */
function generateBlockId(type: string): string {
  return `${type}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Append a newly-instantiated block of `blockType` to `parentCmsId`'s
 * `slotName` slot. Writes the parent to the draft store with the
 * new child attached. The child starts with an empty default config
 * — authors fill fields via the normal `saveCmsFields` flow on the
 * new block.
 *
 * Throws if the block type isn't registered (the palette shouldn't
 * offer unregistered types, but we guard at the action boundary too).
 */
export async function addBlockToSlot(
  parentCmsId: string,
  slotName: string,
  blockType: string,
): Promise<{ invalidate: { selector: string } }> {
  if (!getBlockSpec(blockType)) {
    throw new Error(
      `addBlockToSlot: block type "${blockType}" is not registered. ` +
        `Add it to the app's catalog before wiring it into the palette.`,
    );
  }
  const existing = lookupDraftNode(parentCmsId);
  if (!existing) {
    throw new Error(
      `addBlockToSlot: parent "${parentCmsId}" not found in draft or published stores.`,
    );
  }
  const parent = cloneNode(existing);
  const slots = parent.slots ?? {};
  const children = slots[slotName] ?? [];
  const newChild: CmsNode = {
    id: generateBlockId(blockType),
    type: blockType,
    configs: [{ match: {}, fields: {} }],
  };
  parent.slots = {
    ...slots,
    [slotName]: [...children, newChild],
  };
  writeDraftNode(parentCmsId, parent);
  return invalidateEditorAround(parentCmsId);
}

/**
 * Remove a slot child by `childCmsId` from `parentCmsId`'s `slotName`
 * slot. Idempotent — if the child isn't found the parent is written
 * back unchanged. The child's top-level draft entry (if any) is not
 * deleted here; authors who want a clean store can re-publish.
 */
export async function removeBlockFromSlot(
  parentCmsId: string,
  slotName: string,
  childCmsId: string,
): Promise<{ invalidate: { selector: string } }> {
  const existing = lookupDraftNode(parentCmsId);
  if (!existing) {
    throw new Error(
      `removeBlockFromSlot: parent "${parentCmsId}" not found.`,
    );
  }
  const parent = cloneNode(existing);
  const slots = parent.slots ?? {};
  const children = slots[slotName] ?? [];
  parent.slots = {
    ...slots,
    [slotName]: children.filter((c) => c.id !== childCmsId),
  };
  writeDraftNode(parentCmsId, parent);
  return invalidateEditorAround(parentCmsId);
}

/**
 * Reorder a slot's children. `direction` is `"up"` (swap with
 * previous sibling) or `"down"` (swap with next). No-op at the
 * boundaries. Simple one-step move so the UI can expose `↑ / ↓`
 * buttons without a drag-drop layer yet.
 */
export async function moveBlockInSlot(
  parentCmsId: string,
  slotName: string,
  childCmsId: string,
  direction: "up" | "down",
): Promise<{ invalidate: { selector: string } }> {
  const existing = lookupDraftNode(parentCmsId);
  if (!existing) {
    throw new Error(
      `moveBlockInSlot: parent "${parentCmsId}" not found.`,
    );
  }
  const parent = cloneNode(existing);
  const slots = parent.slots ?? {};
  const children = [...(slots[slotName] ?? [])];
  const idx = children.findIndex((c) => c.id === childCmsId);
  if (idx < 0) {
    // Nothing to do.
    return invalidateEditorAround(parentCmsId);
  }
  const swapIdx = direction === "up" ? idx - 1 : idx + 1;
  if (swapIdx < 0 || swapIdx >= children.length) {
    return invalidateEditorAround(parentCmsId);
  }
  const tmp = children[idx];
  children[idx] = children[swapIdx];
  children[swapIdx] = tmp;
  parent.slots = { ...slots, [slotName]: children };
  writeDraftNode(parentCmsId, parent);
  return invalidateEditorAround(parentCmsId);
}
