"use server"

/**
 * CMS editor server actions.
 *
 *  - `saveCmsFields(cmsId, configIndex, formData)` — merge form
 *    entries into the draft node's chosen config (or create it).
 *  - `publishCmsDraft()` — copy draft → published, clear draft.
 *  - `resetCmsDraft(cmsId)` — drop a single id's draft override.
 *  - `addBlockToSlot` / `removeBlockFromSlot` / `moveBlockInSlot` —
 *    structural slot mutations.
 */

import {
  getSpecByType,
  lookupDraftNode,
  publishDraft,
  revertDraftNode,
  writeDraftNode,
  type CmsConfig,
  type CmsNode,
} from "@react-cms/framework"

function invalidateEditorAround(cmsId: string): { invalidate: { selector: string } } {
  return {
    invalidate: { selector: `#${cmsId} #cms-edit-tree #cms-edit-fields` },
  }
}

export async function saveCmsFields(
  cmsId: string,
  configIndex: number,
  formData: FormData,
): Promise<{ invalidate: { selector: string } }> {
  const existing: CmsNode = lookupDraftNode(cmsId) ?? { id: cmsId, configs: [] }
  const node: CmsNode = {
    ...existing,
    id: cmsId,
    configs: existing.configs.map((c) => ({
      match: { ...c.match },
      fields: { ...c.fields },
    })),
    slots: existing.slots,
  }

  let target: CmsConfig
  if (configIndex < 0) {
    let dflt = node.configs.find((c) => Object.keys(c.match).length === 0)
    if (!dflt) {
      dflt = { match: {}, fields: {} }
      node.configs.push(dflt)
    }
    target = dflt
  } else if (configIndex < node.configs.length) {
    target = node.configs[configIndex]
  } else {
    target = { match: {}, fields: {} }
    node.configs.push(target)
  }

  for (const [key, raw] of formData.entries()) {
    if (key.startsWith("__")) continue
    const value = raw
    if (typeof value === "string") {
      const kind = formData.get(`__kind:${key}`)
      if (kind === "number") {
        const n = Number(value)
        target.fields[key] = Number.isFinite(n) ? n : 0
      } else if (kind === "boolean") {
        target.fields[key] = value === "on" || value === "true"
      } else {
        target.fields[key] = value
      }
    }
  }

  const booleanFields = (formData.get("__boolean-fields") ?? "")
    .toString()
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  for (const name of booleanFields) {
    if (!formData.has(name)) target.fields[name] = false
  }

  await writeDraftNode(cmsId, node)
  return invalidateEditorAround(cmsId)
}

export async function publishCmsDraft(): Promise<{ invalidate: { selector: string } }> {
  await publishDraft()
  return { invalidate: { selector: "#cms-edit-tree" } }
}

export async function resetCmsDraft(
  cmsId: string,
): Promise<{ invalidate: { selector: string } }> {
  await revertDraftNode(cmsId)
  return invalidateEditorAround(cmsId)
}

function cloneNode(node: CmsNode): CmsNode {
  return {
    ...node,
    configs: node.configs.map((c) => ({
      match: { ...c.match },
      fields: { ...c.fields },
    })),
    slots: node.slots
      ? Object.fromEntries(
          Object.entries(node.slots).map(([name, children]) => [name, children.map(cloneNode)]),
        )
      : undefined,
  }
}

function generateBlockId(type: string): string {
  return `${type}-${Math.random().toString(36).slice(2, 10)}`
}

export async function addBlockToSlot(
  parentCmsId: string,
  slotName: string,
  blockType: string,
): Promise<{ invalidate: { selector: string } }> {
  if (!getSpecByType(blockType)) {
    throw new Error(
      `addBlockToSlot: block type "${blockType}" is not registered. ` +
        `Add it to the catalog before wiring it into the palette.`,
    )
  }
  const existing = lookupDraftNode(parentCmsId)
  if (!existing) {
    throw new Error(
      `addBlockToSlot: parent "${parentCmsId}" not found in draft or published stores.`,
    )
  }
  const parent = cloneNode(existing)
  const slots = parent.slots ?? {}
  const children = slots[slotName] ?? []
  const newChild: CmsNode = {
    id: generateBlockId(blockType),
    type: blockType,
    configs: [{ match: {}, fields: {} }],
  }
  parent.slots = { ...slots, [slotName]: [...children, newChild] }
  await writeDraftNode(parentCmsId, parent)
  return invalidateEditorAround(parentCmsId)
}

export async function removeBlockFromSlot(
  parentCmsId: string,
  slotName: string,
  childCmsId: string,
): Promise<{ invalidate: { selector: string } }> {
  const existing = lookupDraftNode(parentCmsId)
  if (!existing) {
    throw new Error(`removeBlockFromSlot: parent "${parentCmsId}" not found.`)
  }
  const parent = cloneNode(existing)
  const slots = parent.slots ?? {}
  const children = slots[slotName] ?? []
  parent.slots = {
    ...slots,
    [slotName]: children.filter((c) => c.id !== childCmsId),
  }
  await writeDraftNode(parentCmsId, parent)
  return invalidateEditorAround(parentCmsId)
}

export async function moveBlockInSlot(
  parentCmsId: string,
  slotName: string,
  childCmsId: string,
  direction: "up" | "down",
): Promise<{ invalidate: { selector: string } }> {
  const existing = lookupDraftNode(parentCmsId)
  if (!existing) {
    throw new Error(`moveBlockInSlot: parent "${parentCmsId}" not found.`)
  }
  const parent = cloneNode(existing)
  const slots = parent.slots ?? {}
  const children = [...(slots[slotName] ?? [])]
  const idx = children.findIndex((c) => c.id === childCmsId)
  if (idx < 0) return invalidateEditorAround(parentCmsId)
  const swapIdx = direction === "up" ? idx - 1 : idx + 1
  if (swapIdx < 0 || swapIdx >= children.length) return invalidateEditorAround(parentCmsId)
  const tmp = children[idx]
  children[idx] = children[swapIdx]
  children[swapIdx] = tmp
  parent.slots = { ...slots, [slotName]: children }
  await writeDraftNode(parentCmsId, parent)
  return invalidateEditorAround(parentCmsId)
}
