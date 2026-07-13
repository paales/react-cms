/**
 * The invalidation bridge seam — publish-after-commit ordering,
 * batching per commit section, loopback suppression, inbound apply
 * semantics (same delivery path, fresh local ts, no row stamp, no
 * re-publish), and doorbell idempotence. Runs over the SQLite adapter
 * because the seam's contract is only meaningful over a store a second
 * process could share — the independent second handle stands in for
 * that process, exactly as in `cell-update-sqlite.rsc.test.ts`.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { atomic, localCell } from "../../lib/cell.ts"
import { hash } from "../../lib/hash.ts"
import { stableStringify } from "../../lib/stable-stringify.ts"
import { setCellStorage, _resetCellStorage } from "../cell-storage.ts"
import { SqliteCellStorage } from "../cell-storage-sqlite.ts"
import {
  deliverInvalidationBumps,
  invalidationBridgeOrigin,
  setInvalidationBridge,
  type InvalidationBumpBatch,
} from "../invalidation-bridge.ts"
import {
  _clearInvalidationRegistry,
  _closeWakeSubscription,
  _compileSurfaceQuery,
  _openWakeSubscription,
  _setWakeSubscriptionEntry,
  _takeWakeSubscriptionPending,
  queryMatchingTs,
  refreshSelector,
  type WakeSubscription,
} from "../invalidation-registry.ts"

const pk = (args: object): string => hash(stableStringify(args))

let dir: string
let storage: SqliteCellStorage
/** The "other process": an independent connection to the same file. */
let other: SqliteCellStorage
const subs: WakeSubscription[] = []

/** Install a recording bridge; returns the published batches. */
function recordPublishes(): InvalidationBumpBatch[] {
  const published: InvalidationBumpBatch[] = []
  setInvalidationBridge({ publish: (batch) => published.push(batch) })
  return published
}

function subscribe(label: string, surface: Record<string, unknown>, id: string): WakeSubscription {
  const sub = _openWakeSubscription({ visible: () => null, hasAssignedSeq: () => false })
  subs.push(sub)
  _setWakeSubscriptionEntry(sub, id, {
    labels: [label],
    query: _compileSurfaceQuery(surface),
    carrier: id,
    carrierParkGates: null,
  })
  return sub
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "parton-bridge-"))
  storage = new SqliteCellStorage(join(dir, "cells.db"))
  other = new SqliteCellStorage(join(dir, "cells.db"))
  setCellStorage(storage)
  _clearInvalidationRegistry()
})

afterEach(() => {
  setInvalidationBridge(null)
  for (const sub of subs.splice(0)) _closeWakeSubscription(sub)
  _resetCellStorage()
  _clearInvalidationRegistry()
  storage.close()
  other.close()
  rmSync(dir, { recursive: true, force: true })
})

describe("outbound — publish-after-commit, batched per commit section", () => {
  it("publish observes the committed row through an independent handle", async () => {
    const c = localCell({ id: "bridge.pub", shape: "number", initial: 0 })
    const atPublish: unknown[] = []
    setInvalidationBridge({
      publish: () => atPublish.push(other.read("default", "bridge.pub", pk({ k: "p" }))),
    })
    await c.with({ k: "p" }).set(7)
    // The doorbell rang exactly once, and the value was already
    // re-readable from the shared store when it did.
    expect(atPublish).toEqual([7])
  })

  it("an atomic() is ONE batch carrying every selector, published after the whole overlay flushed", async () => {
    const a = localCell({ id: "bridge.batch.a", shape: "number", initial: 0 })
    const b = localCell({ id: "bridge.batch.b", shape: "number", initial: 0 })
    const published = recordPublishes()
    const rowsAtPublish: unknown[] = []
    setInvalidationBridge({
      publish: (batch) => {
        published.push(batch)
        rowsAtPublish.push({
          a: other.read("default", "bridge.batch.a", pk({ k: "x" })),
          b: other.read("default", "bridge.batch.b", pk({ k: "y" })),
        })
      },
    })
    await atomic(async () => {
      await a.with({ k: "x" }).set(1)
      await b.with({ k: "y" }).set(2)
    })
    expect(published).toHaveLength(1)
    expect(published[0].origin).toBe(invalidationBridgeOrigin())
    expect(published[0].selectors).toEqual(["cell:bridge.batch.a?k=x", "cell:bridge.batch.b?k=y"])
    // Publish-after-commit for the BATCH: both rows visible before the
    // single doorbell, regardless of write order inside the batch.
    expect(rowsAtPublish).toEqual([{ a: 1, b: 2 }])
  })

  it("a rolled-back transaction publishes nothing", async () => {
    const c = localCell({ id: "bridge.rollback", shape: "number", initial: 0 })
    const published = recordPublishes()
    await expect(
      atomic(async () => {
        await c.with({ k: "rb" }).set(9)
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")
    expect(published).toEqual([])
  })

  it("non-cell selectors travel too, and a throwing transport never breaks the commit", async () => {
    setInvalidationBridge({
      publish: () => {
        throw new Error("transport down")
      },
    })
    expect(() => refreshSelector("cart?cart_id=1")).not.toThrow()
    // The local commit landed despite the broken bridge.
    expect(queryMatchingTs(["cart"], { cart_id: "1" })).toBeGreaterThan(0)
  })
})

describe("inbound — same delivery path, local timeline, no stamp, no re-publish", () => {
  it("a foreign batch commits locally and delivers through the wake index", () => {
    const sub = subscribe("cell:bridge.in", { k: "w" }, "watcher-1")
    let wakes = 0
    sub.wakes.add(() => wakes++)
    deliverInvalidationBumps({ origin: "peer-process", selectors: ["cell:bridge.in?k=w"] })
    expect(wakes).toBe(1)
    expect(_takeWakeSubscriptionPending(sub)).toEqual(["watcher-1"])
    expect(queryMatchingTs(["cell:bridge.in"], { k: "w" })).toBeGreaterThan(0)
  })

  it("drops this process's own batches (transport echo)", () => {
    const sub = subscribe("cell:bridge.echo", { k: "e" }, "watcher-echo")
    let wakes = 0
    sub.wakes.add(() => wakes++)
    deliverInvalidationBumps({
      origin: invalidationBridgeOrigin(),
      selectors: ["cell:bridge.echo?k=e"],
    })
    expect(wakes).toBe(0)
    expect(queryMatchingTs(["cell:bridge.echo"], { k: "e" })).toBe(0)
  })

  it("an inbound apply is never re-published (no forwarding ping-pong)", () => {
    const published = recordPublishes()
    deliverInvalidationBumps({ origin: "peer-process", selectors: ["cell:bridge.fwd?k=f"] })
    expect(published).toEqual([])
  })

  it("duplicate doorbells are idempotent: the ts advances, delivery repeats, nothing corrupts", () => {
    const sub = subscribe("cell:bridge.dup", { k: "d" }, "watcher-dup")
    const batch: InvalidationBumpBatch = {
      origin: "peer-process",
      selectors: ["cell:bridge.dup?k=d"],
    }
    deliverInvalidationBumps(batch)
    const first = queryMatchingTs(["cell:bridge.dup"], { k: "d" })
    _takeWakeSubscriptionPending(sub)
    deliverInvalidationBumps(batch)
    const second = queryMatchingTs(["cell:bridge.dup"], { k: "d" })
    // A late/duplicate bump means one more re-read + fp compare — the
    // entry moves forward, the same id is delivered again.
    expect(second).toBeGreaterThan(first)
    expect(_takeWakeSubscriptionPending(sub)).toEqual(["watcher-dup"])
  })

  it("never re-stamps the shared row — the writer's ts stays authoritative", async () => {
    const c = localCell({ id: "bridge.stamp", shape: "number", initial: 0 })
    // The local write stamps the row with THIS process's committed ts.
    await c.with({ k: "s" }).set(1)
    const writerTs = other.readTs("default", "bridge.stamp", pk({ k: "s" }))
    expect(writerTs).toBeGreaterThan(0)
    // A foreign doorbell for the same selector commits a fresh LOCAL
    // entry but leaves the row's stamp untouched.
    deliverInvalidationBumps({ origin: "peer-process", selectors: ["cell:bridge.stamp?k=s"] })
    expect(other.readTs("default", "bridge.stamp", pk({ k: "s" }))).toBe(writerTs)
    expect(queryMatchingTs(["cell:bridge.stamp"], { k: "s" })).toBeGreaterThan(writerTs ?? 0)
  })

  it("selector round-trip preserves type-tagged constraints across the wire encoding", async () => {
    const published = recordPublishes()
    const c = localCell({ id: "bridge.types", shape: "number", initial: 0 })
    await c.with({ uid: 123 }).set(5)
    expect(published).toHaveLength(1)
    const wire = published[0].selectors[0]
    // Apply the wire form back (as a peer would): the number
    // constraint must still match type-exactly, not as a string.
    _clearInvalidationRegistry()
    deliverInvalidationBumps({ origin: "peer-process", selectors: [wire] })
    expect(queryMatchingTs(["cell:bridge.types"], { uid: 123 })).toBeGreaterThan(0)
    expect(queryMatchingTs(["cell:bridge.types"], { uid: "123" })).toBe(0)
  })
})
