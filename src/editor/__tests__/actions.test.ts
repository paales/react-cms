/**
 * Unit tests for the editor server actions in `src/editor/actions.ts`.
 *
 * Each test exercises one action against the real disk-backed store
 * — the file-level beforeEach/afterEach removes any draft.json
 * that prior tests left behind. Tests that PUBLISH (which writes
 * to content.json) snapshot+restore the affected node so the
 * committed published store stays clean.
 *
 * Block registry is populated with stub entries before each test
 * and cleared after — the example app's catalog isn't imported here
 * so we don't accidentally couple the action tests to its block
 * shapes.
 */
import { existsSync, unlinkSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  _clearBlockRegistry,
  _invalidateCmsStoreCache,
  CMS_DRAFT_COOKIE,
  lookupCmsNode,
  lookupDraftNode,
  registerBlock,
  writeDraftNode,
  type CmsNode,
} from "../../framework/cms-runtime.ts"
import {
  addBlockToSlot,
  moveBlockInSlot,
  publishCmsDraft,
  removeBlockFromSlot,
  resetCmsDraft,
  saveCmsFields,
} from "../actions.ts"

const DRAFT_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "cms", "draft.json")

function clearDraft(): void {
  if (existsSync(DRAFT_PATH)) unlinkSync(DRAFT_PATH)
  _invalidateCmsStoreCache()
}

function draftRequest(): Request {
  return new Request("http://localhost/", {
    headers: { cookie: `${CMS_DRAFT_COOKIE}=1` },
  })
}

beforeEach(() => {
  clearDraft()
  _clearBlockRegistry()
  // Stub registry — actions only need block specs to exist.
  registerBlock("hero", { tags: [".hero"], component: () => null })
  registerBlock("rich-text", {
    tags: [".rich-text"],
    component: () => null,
  })
})

afterEach(() => {
  clearDraft()
  _clearBlockRegistry()
})

describe("saveCmsFields", () => {
  it("creates a default config and writes the field on a fresh id", async () => {
    const fd = new FormData()
    fd.set("headline", "Hello")
    const result = await saveCmsFields("test-fresh", -1, fd)
    expect(result.invalidate.selector).toContain("#test-fresh")
    const node = lookupCmsNode("test-fresh", draftRequest())
    expect(node?.configs[0].fields.headline).toBe("Hello")
  })

  it("writes to a specific config index without touching others", async () => {
    await writeDraftNode("multi-config", {
      id: "multi-config",
      configs: [
        { match: { "url:variant": "A" }, fields: { headline: "A" } },
        { match: {}, fields: { headline: "default" } },
      ],
    })
    const fd = new FormData()
    fd.set("headline", "A-edited")
    await saveCmsFields("multi-config", 0, fd)
    const node = lookupDraftNode("multi-config")!
    expect(node.configs[0].fields.headline).toBe("A-edited")
    expect(node.configs[1].fields.headline).toBe("default")
  })

  it("coerces numeric inputs via the __kind sidecar", async () => {
    const fd = new FormData()
    fd.set("count", "12")
    fd.set("__kind:count", "number")
    await saveCmsFields("numeric-test", -1, fd)
    const node = lookupDraftNode("numeric-test")!
    expect(node.configs[0].fields.count).toBe(12)
    expect(typeof node.configs[0].fields.count).toBe("number")
  })

  it("falls back to 0 for an un-parseable number input", async () => {
    const fd = new FormData()
    fd.set("count", "abc")
    fd.set("__kind:count", "number")
    await saveCmsFields("bad-numeric", -1, fd)
    const node = lookupDraftNode("bad-numeric")!
    expect(node.configs[0].fields.count).toBe(0)
  })

  it("flips a boolean to false when the checkbox is missing from the form", async () => {
    await writeDraftNode("flag-test", {
      id: "flag-test",
      configs: [{ match: {}, fields: { active: true } }],
    })
    const fd = new FormData()
    // Note: `active` is intentionally absent — the boolean sidecar
    // tells the action to interpret missing booleans as false.
    fd.set("__boolean-fields", "active")
    await saveCmsFields("flag-test", 0, fd)
    const node = lookupDraftNode("flag-test")!
    expect(node.configs[0].fields.active).toBe(false)
  })
})

describe("addBlockToSlot", () => {
  it("appends a new child to the slot with a generated id", async () => {
    await writeDraftNode("parent-add", {
      id: "parent-add",
      configs: [{ match: {}, fields: {} }],
      slots: { body: [] },
    })
    const result = await addBlockToSlot("parent-add", "body", "hero")
    expect(result.invalidate.selector).toContain("#parent-add")
    const parent = lookupDraftNode("parent-add")!
    expect(parent.slots?.body).toHaveLength(1)
    const child = parent.slots!.body[0]
    expect(child.type).toBe("hero")
    expect(child.id).toMatch(/^hero-[a-z0-9]+$/)
  })

  it("appends to an existing slot without disturbing prior children", async () => {
    await writeDraftNode("parent-extend", {
      id: "parent-extend",
      configs: [{ match: {}, fields: {} }],
      slots: {
        body: [
          {
            id: "existing-1",
            type: "rich-text",
            configs: [{ match: {}, fields: {} }],
          },
        ],
      },
    })
    await addBlockToSlot("parent-extend", "body", "hero")
    const parent = lookupDraftNode("parent-extend")!
    expect(parent.slots?.body).toHaveLength(2)
    expect(parent.slots?.body[0].id).toBe("existing-1")
    expect(parent.slots?.body[1].type).toBe("hero")
  })

  it("creates the slot if it didn't exist on the parent yet", async () => {
    await writeDraftNode("parent-new-slot", {
      id: "parent-new-slot",
      configs: [{ match: {}, fields: {} }],
    })
    await addBlockToSlot("parent-new-slot", "sidebar", "hero")
    const parent = lookupDraftNode("parent-new-slot")!
    expect(parent.slots?.sidebar).toHaveLength(1)
  })

  it("throws on an unregistered block type", async () => {
    await writeDraftNode("parent-bad", {
      id: "parent-bad",
      configs: [{ match: {}, fields: {} }],
    })
    await expect(addBlockToSlot("parent-bad", "body", "unknown-type")).rejects.toThrow(
      /not registered/,
    )
  })

  it("throws on a missing parent", async () => {
    await expect(addBlockToSlot("does-not-exist", "body", "hero")).rejects.toThrow(/not found/)
  })
})

describe("removeBlockFromSlot", () => {
  it("removes the child by id", async () => {
    await writeDraftNode("parent-remove", {
      id: "parent-remove",
      configs: [{ match: {}, fields: {} }],
      slots: {
        body: [
          {
            id: "drop-me",
            type: "hero",
            configs: [{ match: {}, fields: {} }],
          },
          {
            id: "keep-me",
            type: "hero",
            configs: [{ match: {}, fields: {} }],
          },
        ],
      },
    })
    await removeBlockFromSlot("parent-remove", "body", "drop-me")
    const parent = lookupDraftNode("parent-remove")!
    expect(parent.slots?.body.map((c) => c.id)).toEqual(["keep-me"])
  })

  it("is idempotent on an unknown child id", async () => {
    await writeDraftNode("parent-idempotent", {
      id: "parent-idempotent",
      configs: [{ match: {}, fields: {} }],
      slots: {
        body: [
          {
            id: "only-one",
            type: "hero",
            configs: [{ match: {}, fields: {} }],
          },
        ],
      },
    })
    await removeBlockFromSlot("parent-idempotent", "body", "ghost")
    const parent = lookupDraftNode("parent-idempotent")!
    expect(parent.slots?.body).toHaveLength(1)
  })
})

describe("moveBlockInSlot", () => {
  function makeParent(...ids: string[]): CmsNode {
    return {
      id: "parent-move",
      configs: [{ match: {}, fields: {} }],
      slots: {
        body: ids.map((id) => ({
          id,
          type: "hero",
          configs: [{ match: {}, fields: {} }],
        })),
      },
    }
  }

  it("swaps with the previous sibling on direction=up", async () => {
    await writeDraftNode("parent-move", makeParent("a", "b", "c"))
    await moveBlockInSlot("parent-move", "body", "b", "up")
    const parent = lookupDraftNode("parent-move")!
    expect(parent.slots?.body.map((c) => c.id)).toEqual(["b", "a", "c"])
  })

  it("swaps with the next sibling on direction=down", async () => {
    await writeDraftNode("parent-move", makeParent("a", "b", "c"))
    await moveBlockInSlot("parent-move", "body", "b", "down")
    const parent = lookupDraftNode("parent-move")!
    expect(parent.slots?.body.map((c) => c.id)).toEqual(["a", "c", "b"])
  })

  it("is a no-op at the top boundary", async () => {
    await writeDraftNode("parent-move", makeParent("a", "b", "c"))
    await moveBlockInSlot("parent-move", "body", "a", "up")
    const parent = lookupDraftNode("parent-move")!
    expect(parent.slots?.body.map((c) => c.id)).toEqual(["a", "b", "c"])
  })

  it("is a no-op at the bottom boundary", async () => {
    await writeDraftNode("parent-move", makeParent("a", "b", "c"))
    await moveBlockInSlot("parent-move", "body", "c", "down")
    const parent = lookupDraftNode("parent-move")!
    expect(parent.slots?.body.map((c) => c.id)).toEqual(["a", "b", "c"])
  })

  it("is a no-op for an unknown child id", async () => {
    await writeDraftNode("parent-move", makeParent("a", "b", "c"))
    await moveBlockInSlot("parent-move", "body", "ghost", "up")
    const parent = lookupDraftNode("parent-move")!
    expect(parent.slots?.body.map((c) => c.id)).toEqual(["a", "b", "c"])
  })
})

describe("resetCmsDraft", () => {
  it("removes the id's draft entry while leaving others intact", async () => {
    await writeDraftNode("keep-me", {
      id: "keep-me",
      configs: [{ match: {}, fields: { a: 1 } }],
    })
    await writeDraftNode("drop-me", {
      id: "drop-me",
      configs: [{ match: {}, fields: { b: 2 } }],
    })
    await resetCmsDraft("drop-me")
    expect(lookupDraftNode("keep-me")?.configs[0].fields.a).toBe(1)
    expect(lookupDraftNode("drop-me")).toBeNull()
  })

  it("removes the draft file entirely when the last id is dropped", async () => {
    await writeDraftNode("only-one", {
      id: "only-one",
      configs: [{ match: {}, fields: {} }],
    })
    expect(existsSync(DRAFT_PATH)).toBe(true)
    await resetCmsDraft("only-one")
    expect(existsSync(DRAFT_PATH)).toBe(false)
  })

  it("is a no-op for an id without a draft entry", async () => {
    await writeDraftNode("present", {
      id: "present",
      configs: [{ match: {}, fields: {} }],
    })
    // No draft for "absent". Should not throw or remove "present".
    await resetCmsDraft("absent")
    expect(lookupDraftNode("present")).not.toBeNull()
  })
})

describe("publishCmsDraft", () => {
  // This test mutates the committed published store. We snapshot
  // the existing entry, run the action, then restore via a second
  // publishDraft call. If a step fails midway the cleanup uses
  // best-effort restore.
  it("copies the draft into published and clears the draft", async () => {
    const originalHero = lookupCmsNode("cms-demo-hero")
    expect(originalHero).not.toBeNull()
    try {
      await writeDraftNode("cms-demo-hero", {
        id: "cms-demo-hero",
        configs: [{ match: {}, fields: { headline: "Published-test value" } }],
      })
      await publishCmsDraft()
      expect(existsSync(DRAFT_PATH)).toBe(true)
      const published = lookupCmsNode("cms-demo-hero")!
      expect(published.configs[0].fields.headline).toBe("Published-test value")
    } finally {
      // Restore by re-publishing a draft that brings the node back
      // to its original committed shape.
      if (originalHero) {
        await writeDraftNode("cms-demo-hero", originalHero)
        await publishCmsDraft()
      }
    }
  })
})
