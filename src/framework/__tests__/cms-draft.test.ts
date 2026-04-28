/**
 * Tests for the draft / published cookie fork. Exercises the real
 * disk-backed loader — a beforeEach / afterEach clears any draft
 * file that a previous test left behind, so failures don't leak.
 */
import { existsSync, unlinkSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  _invalidateCmsStoreCache,
  CMS_DRAFT_COOKIE,
  lookupCmsNode,
  publishDraft,
  writeDraftNode,
  type CmsNode,
} from "../cms-runtime.ts"

const DRAFT_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "cms", "draft.json")

function clearDraftFile(): void {
  if (existsSync(DRAFT_PATH)) unlinkSync(DRAFT_PATH)
  _invalidateCmsStoreCache()
}

function draftRequest(): Request {
  return new Request("http://localhost/", {
    headers: { cookie: `${CMS_DRAFT_COOKIE}=1` },
  })
}

function publishedRequest(): Request {
  return new Request("http://localhost/")
}

beforeEach(() => clearDraftFile())
afterEach(() => clearDraftFile())

describe("lookupCmsNode — draft / published fork", () => {
  it("reads the published store when no cookie is set", () => {
    // `cms-demo-hero` lives in the committed src/cms/content.json.
    const node = lookupCmsNode("cms-demo-hero")
    expect(node).not.toBeNull()
    expect(node?.configs[0].fields.headline).toBe("Welcome to the CMS demo")
  })

  it("still reads published when the cookie is set but draft has no entry for this id", async () => {
    await writeDraftNode("some-other-id", {
      id: "some-other-id",
      configs: [{ match: {}, fields: {} }],
    })
    const node = lookupCmsNode("cms-demo-hero", draftRequest())
    expect(node?.configs[0].fields.headline).toBe("Welcome to the CMS demo")
  })

  it("prefers the draft entry when the cookie is set", async () => {
    const draftNode: CmsNode = {
      id: "cms-demo-hero",
      configs: [
        {
          match: {},
          fields: { headline: "Draft headline", tone: "loud" },
        },
      ],
    }
    await writeDraftNode("cms-demo-hero", draftNode)
    const node = lookupCmsNode("cms-demo-hero", draftRequest())
    expect(node?.configs[0].fields.headline).toBe("Draft headline")
  })

  it("draft is invisible to requests without the cookie", async () => {
    await writeDraftNode("cms-demo-hero", {
      id: "cms-demo-hero",
      configs: [{ match: {}, fields: { headline: "Draft headline" } }],
    })
    const node = lookupCmsNode("cms-demo-hero", publishedRequest())
    expect(node?.configs[0].fields.headline).toBe("Welcome to the CMS demo")
  })
})

describe("writeDraftNode", () => {
  it("round-trips through the filesystem", async () => {
    const draftNode: CmsNode = {
      id: "test-write",
      configs: [{ match: {}, fields: { a: 1 } }],
    }
    await writeDraftNode("test-write", draftNode)
    expect(existsSync(DRAFT_PATH)).toBe(true)
    const read = lookupCmsNode("test-write", draftRequest())
    expect(read?.configs[0].fields.a).toBe(1)
  })

  it("overwrites prior draft entries with the same id", async () => {
    await writeDraftNode("test-write", {
      id: "test-write",
      configs: [{ match: {}, fields: { v: "first" } }],
    })
    await writeDraftNode("test-write", {
      id: "test-write",
      configs: [{ match: {}, fields: { v: "second" } }],
    })
    const read = lookupCmsNode("test-write", draftRequest())
    expect(read?.configs[0].fields.v).toBe("second")
  })
})

describe("lookupCmsNode — top-level draft wins over slot-nested copy", () => {
  // Regression cover: when the editor saves a slot child via
  // `writeDraftNode(childId, …)`, the resulting draft store has the
  // child BOTH at top-level (fresh) AND nested inside the parent's
  // slots (stale, from whenever the parent was last written). The
  // flat index must prefer top-level so lookupCmsNode returns the
  // fresh version.
  it("prefers a top-level draft entry over the same id nested in a parent slot", async () => {
    // Parent in draft with a stale copy of the child.
    await writeDraftNode("cms-demo-composed", {
      id: "cms-demo-composed",
      configs: [{ match: {}, fields: {} }],
      slots: {
        body: [
          {
            id: "composed-hero-1",
            type: "hero",
            configs: [{ match: {}, fields: { headline: "STALE" } }],
          },
        ],
      },
    })
    // Child at top-level with fresh content.
    await writeDraftNode("composed-hero-1", {
      id: "composed-hero-1",
      type: "hero",
      configs: [{ match: {}, fields: { headline: "FRESH" } }],
    })

    const node = lookupCmsNode("composed-hero-1", draftRequest())
    expect(node?.configs[0].fields.headline).toBe("FRESH")
  })
})

// NOTE: regression coverage for `listAllCmsNodes` slot-child dedupe
// lives in the e2e suite (`e2e/cms-edit.spec.ts > editing a slot
// child only renders one tree entry for the edited id`). Unit-level
// tests that wrote to draft.json from this file flaked under
// parallel cross-file vitest workers — multiple test files share the
// same on-disk draft.json and there's no per-test mutex. Keeping the
// unit tier off the shared file avoids the race; the e2e covers the
// behavior end-to-end.

describe("publishDraft", () => {
  // Storage isolation: inject a fresh JsonFileStorage pointing at a
  // tmp directory so the test doesn't pollute src/cms/content.json
  // (the previous implementation tried to write+restore the shared
  // file, which caused two issues: a mid-restore failure left the
  // committed JSON dirty, and the post-page-as-slot refactor changed
  // content.json's top-level shape so the "restore" wrote a
  // different shape than the file actually had).
  const tmpDir = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    `tmp-publish-test-${process.pid}`,
  )
  const tmpPublished = join(tmpDir, "content.json")
  const tmpDraft = join(tmpDir, "draft.json")

  beforeEach(async () => {
    const { JsonFileStorage, setCmsStorage } = await import("../cms-storage.ts")
    setCmsStorage(new JsonFileStorage(tmpPublished, tmpDraft))
    _invalidateCmsStoreCache()
  })

  afterEach(async () => {
    const { _resetCmsStorage } = await import("../cms-storage.ts")
    _resetCmsStorage()
    _invalidateCmsStoreCache()
    if (existsSync(tmpPublished)) unlinkSync(tmpPublished)
    if (existsSync(tmpDraft)) unlinkSync(tmpDraft)
    try {
      const { rmdirSync } = await import("node:fs")
      rmdirSync(tmpDir)
    } catch {
      // dir might already be gone or non-empty in flake; safe to
      // ignore for a test cleanup.
    }
  })

  it("copies draft entries into published and clears the draft", async () => {
    // Seed an initial published store via the injected backend.
    await writeDraftNode("seed-id", {
      id: "seed-id",
      configs: [{ match: {}, fields: { headline: "seed" } }],
    })
    await publishDraft()

    // Now drop a draft override and publish it.
    await writeDraftNode("seed-id", {
      id: "seed-id",
      configs: [{ match: {}, fields: { headline: "Published via test" } }],
    })
    await publishDraft()

    // The draft is cleared; the published copy carries the new value.
    const node = lookupCmsNode("seed-id")
    expect(node?.configs[0].fields.headline).toBe("Published via test")
  })
})
