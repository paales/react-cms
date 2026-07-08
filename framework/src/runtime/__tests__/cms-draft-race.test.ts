/**
 * Concurrency safety for draft writes. `writeDraftNode` is a
 * read-modify-write: load the draft store, set one key, save the whole
 * store back. Two concurrent calls both observe the pre-write store, so
 * the second save clobbers the first's key — a lost logical update the
 * atomic file-write can't prevent (the bytes aren't torn; the update
 * just vanishes).
 *
 * Storage isolation: an in-memory backend with an async boundary on
 * load/save is injected so the interleave is deterministic, with no
 * shared on-disk draft.json flake.
 */
import { afterEach, describe, expect, it } from "vitest"
import {
  _invalidateCmsStoreCache,
  publishDraft,
  writeDraftNode,
  type CmsStore,
} from "../cms-runtime.ts"
import {
  getCmsStorage,
  setCmsStorage,
  _resetCmsStorage,
  type CmsStorage,
  type LoadedStore,
} from "../cms-storage.ts"

/**
 * In-memory backend that yields to the microtask queue on every
 * load/save. The yield is what lets two concurrent `writeDraftNode`
 * calls interleave their load-mutate-save: both read the old store
 * before either saves.
 */
function asyncMemoryStorage(): CmsStorage {
  let published: CmsStore = { partials: {} }
  let draft: CmsStore | null = null
  let tick = 1
  return {
    async loadPublished(): Promise<LoadedStore | null> {
      await Promise.resolve()
      return { store: structuredClone(published), mtime: tick }
    },
    loadPublishedSync(): LoadedStore | null {
      return { store: structuredClone(published), mtime: tick }
    },
    async savePublished(store: CmsStore): Promise<void> {
      await Promise.resolve()
      published = structuredClone(store)
      tick++
    },
    async loadDraft(): Promise<LoadedStore | null> {
      await Promise.resolve()
      return draft ? { store: structuredClone(draft), mtime: tick } : null
    },
    loadDraftSync(): LoadedStore | null {
      return draft ? { store: structuredClone(draft), mtime: tick } : null
    },
    async saveDraft(store: CmsStore): Promise<void> {
      await Promise.resolve()
      draft = structuredClone(store)
      tick++
    },
    async deleteDraft(): Promise<void> {
      await Promise.resolve()
      draft = null
      tick++
    },
  }
}

afterEach(() => {
  _resetCmsStorage()
  _invalidateCmsStoreCache()
})

describe("writeDraftNode — concurrent writes", () => {
  it("keeps both keys when two writes race", async () => {
    setCmsStorage(asyncMemoryStorage())
    _invalidateCmsStoreCache()

    // Fire two writes for distinct ids without awaiting between them —
    // both load the (empty) store, set their key, and save. Without
    // serialization the second save overwrites the first's key.
    await Promise.all([
      writeDraftNode("a", { id: "a", configs: [{ match: {}, fields: { v: "a" } }] }),
      writeDraftNode("b", { id: "b", configs: [{ match: {}, fields: { v: "b" } }] }),
    ])

    // Read the persisted draft store directly off the backend.
    const final = await getCmsStorage().loadDraft()
    const ids = Object.keys(final?.store.partials ?? {}).sort()
    expect(ids).toEqual(["a", "b"])
  })

  it("keeps every key when many writes race", async () => {
    setCmsStorage(asyncMemoryStorage())
    _invalidateCmsStoreCache()

    const ids = Array.from({ length: 8 }, (_, i) => `n${i}`)
    await Promise.all(
      ids.map((id) => writeDraftNode(id, { id, configs: [{ match: {}, fields: { v: id } }] })),
    )

    const final = await getCmsStorage().loadDraft()
    expect(Object.keys(final?.store.partials ?? {}).sort()).toEqual([...ids].sort())
  })

  it("does not lose a concurrent draft write across a publish", async () => {
    setCmsStorage(asyncMemoryStorage())
    _invalidateCmsStoreCache()

    await writeDraftNode("seed", { id: "seed", configs: [{ match: {}, fields: {} }] })

    // A draft write racing a publish must not vanish: serialized logical
    // writes mean the new key lands either in the published copy (if it
    // ran first) or in the post-publish draft (if it ran after), never
    // nowhere.
    await Promise.all([
      writeDraftNode("late", { id: "late", configs: [{ match: {}, fields: {} }] }),
      publishDraft(),
    ])

    const backend = getCmsStorage()
    const published = await backend.loadPublished()
    const draft = await backend.loadDraft()
    const allIds = new Set([
      ...Object.keys(published?.store.partials ?? {}),
      ...Object.keys(draft?.store.partials ?? {}),
    ])
    expect(allIds.has("late")).toBe(true)
  })
})
