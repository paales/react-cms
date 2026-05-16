"use server"

/**
 * CMS editor server actions.
 *
 *  - `saveCmsFields(id, configIndex, formData)` — merge form
 *    entries into the draft node's chosen config (or create it).
 *  - `publishCmsDraft()` — copy draft → published, clear draft.
 *  - `resetCmsDraft(id)` — drop a single id's draft override.
 *  - `addBlockToSlot` / `removeBlockFromSlot` / `moveBlockInSlot` —
 *    structural slot mutations.
 */

import {
  getSlotBlockMeta,
  lookupDraftNode,
  publishDraft,
  revertDraftNode,
  writeDraftNode,
  type CmsConfig,
  type CmsNode,
} from "@react-cms/framework"

function invalidateEditorAround(id: string): { invalidate: { selector: string } } {
  return {
    invalidate: { selector: `#${id} #cms-edit-tree #cms-edit-fields` },
  }
}

export async function saveCmsFields(
  id: string,
  configIndex: number,
  formData: FormData,
): Promise<{ invalidate: { selector: string } }> {
  const existing: CmsNode = lookupDraftNode(id) ?? { id: id, configs: [] }
  const node: CmsNode = {
    ...existing,
    id: id,
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

  await writeDraftNode(id, node)
  return invalidateEditorAround(id)
}

export async function publishCmsDraft(): Promise<{ invalidate: { selector: string } }> {
  await publishDraft()
  return { invalidate: { selector: "#cms-edit-tree" } }
}

export async function resetCmsDraft(
  id: string,
): Promise<{ invalidate: { selector: string } }> {
  await revertDraftNode(id)
  return invalidateEditorAround(id)
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
  parentId: string,
  slotName: string,
  blockType: string,
): Promise<{ invalidate: { selector: string } }> {
  if (!getSlotBlockMeta(blockType)) {
    throw new Error(
      `addBlockToSlot: block type "${blockType}" is not registered. ` +
        `Add it to the catalog before wiring it into the palette.`,
    )
  }
  const existing = lookupDraftNode(parentId)
  if (!existing) {
    throw new Error(
      `addBlockToSlot: parent "${parentId}" not found in draft or published stores.`,
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
  await writeDraftNode(parentId, parent)
  return invalidateEditorAround(parentId)
}

export async function removeBlockFromSlot(
  parentId: string,
  slotName: string,
  childId: string,
): Promise<{ invalidate: { selector: string } }> {
  const existing = lookupDraftNode(parentId)
  if (!existing) {
    throw new Error(`removeBlockFromSlot: parent "${parentId}" not found.`)
  }
  const parent = cloneNode(existing)
  const slots = parent.slots ?? {}
  const children = slots[slotName] ?? []
  parent.slots = {
    ...slots,
    [slotName]: children.filter((c) => c.id !== childId),
  }
  await writeDraftNode(parentId, parent)
  return invalidateEditorAround(parentId)
}

export async function moveBlockInSlot(
  parentId: string,
  slotName: string,
  childId: string,
  direction: "up" | "down",
): Promise<{ invalidate: { selector: string } }> {
  const existing = lookupDraftNode(parentId)
  if (!existing) {
    throw new Error(`moveBlockInSlot: parent "${parentId}" not found.`)
  }
  const parent = cloneNode(existing)
  const slots = parent.slots ?? {}
  const children = [...(slots[slotName] ?? [])]
  const idx = children.findIndex((c) => c.id === childId)
  if (idx < 0) return invalidateEditorAround(parentId)
  const swapIdx = direction === "up" ? idx - 1 : idx + 1
  if (swapIdx < 0 || swapIdx >= children.length) return invalidateEditorAround(parentId)
  const tmp = children[idx]
  children[idx] = children[swapIdx]
  children[swapIdx] = tmp
  parent.slots = { ...slots, [slotName]: children }
  await writeDraftNode(parentId, parent)
  return invalidateEditorAround(parentId)
}
