/**
 * scroller() — the window model over item space.
 *
 * Pins the server half: the placed span around the anchor, the
 * reservation shells covering the rest, the cold-seed neighborhood
 * (only the anchor's slices resolve — the fetch is gated by culling),
 * the public anchor ids, the streamed landing script, placement
 * stability as the collection grows, and the SEED-VERDICT dep: an
 * anchor move re-renders only the leaves whose seed verdict flipped —
 * every other leaf's fp holds (the scroll-back zero-byte confirm).
 */

import { beforeEach, describe, expect, it } from "vitest"
import { clearRegistry } from "../partial-registry.ts"
import { PartialRoot } from "../partial.tsx"
import { scroller } from "../scroller.tsx"
import { renderWithRequest } from "../../test/rsc-server.ts"

async function flightAt(url: string, node: React.ReactNode): Promise<string> {
  const { stream } = await renderWithRequest(url, node)
  return await new Response(stream).text()
}

/** Leaf placements `[o, n]` on the wire, in emission order. */
function leavesOf(flight: string): Array<[number, number]> {
  const out: Array<[number, number]> = []
  const re = /"o":(\d+),"n":(\d+)[,}]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(flight)) !== null) out.push([Number(m[1]), Number(m[2])])
  return out
}

/** Leaf fingerprints zipped to their `o`, via wire emission order
 *  (leaf placements and their boundary emissions stream in span
 *  order). */
function leafFpsOf(flight: string): Map<number, string> {
  const os = leavesOf(flight).map(([o]) => o)
  const fps: string[] = []
  const re = /"partialId":"[^"]*-leaf[^"]*","partialFingerprint":"([^"]+)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(flight)) !== null) fps.push(m[1])
  const out = new Map<number, string>()
  for (let i = 0; i < Math.min(os.length, fps.length); i++) out.set(os[i], fps[i])
  return out
}

/** A deterministic in-memory source: `total` items, item i = `i`.
 *  Records every requested offset so tests can assert the fetch is
 *  gated by the span's cull seeds. */
function makeSource(state: { total: number; calls: number[] }) {
  return async ({ offset, limit }: { offset: number; limit: number }) => {
    state.calls.push(offset)
    const items: number[] = []
    for (let i = offset; i < Math.min(offset + limit, state.total); i++) items.push(i)
    return { items, total: state.total }
  }
}

describe("scroller: the placed span and its reservations", () => {
  beforeEach(() => clearRegistry("all"))

  const state = { total: 1302, calls: [] as number[] }
  const List = scroller({
    name: "probe-list",
    load: makeSource(state),
    render: ({ item: i, id }) => <i key={i} id={id} data-item={i} />,
    leaf: 24,
    ring: 6,
  })
  const tree = (
    <PartialRoot>
      <List />
    </PartialRoot>
  )

  it("head render: span at the head, after-reservation, only the seeded slices fetch", async () => {
    state.calls = []
    const flight = await flightAt("http://t/", tree)

    // The span: leaves [0..168), then ONE reservation for the rest.
    const ls = leavesOf(flight)
    expect(ls).toContainEqual([0, 24])
    expect(ls).toContainEqual([144, 24])
    expect(ls).not.toContainEqual([192, 24])
    expect(flight).toContain('"count":1134')

    // The public anchor surface: the wrapper id; a materialized
    // boundary's id on its first ITEM; a culled boundary's id riding
    // the placement (`aid` — the shell's first cell carries it).
    expect(flight).toContain('"id":"probe-list"')
    expect(flight).toContain('"id":"probe-list-p1"')
    expect(flight).toContain('"aid":"probe-list-p7"')

    // Cold seed (no ?page=): the anchor neighborhood (leaves 0 and
    // 24) materializes; the rest of the span is culled — placed, but
    // never fetched. The root's shape read shares leaf 0's slice.
    expect(flight).toMatch(/"data-item":0[,}]/)
    expect(flight).toMatch(/"data-item":24[,}]/)
    expect(flight).not.toMatch(/"data-item":48[,}]/)
    expect(new Set(state.calls)).toEqual(new Set([0, 24]))

    // The landing script rides the emission, id-addressed.
    expect(flight).toContain("getElementById")
  })

  it("?page=30 moves the span there — reservations on both sides", async () => {
    state.calls = []
    const flight = await flightAt("http://t/?page=30", tree)

    const ls = leavesOf(flight)
    expect(ls).toContainEqual([552, 24])
    expect(ls).toContainEqual([840, 24])
    expect(ls).not.toContainEqual([528, 24])
    expect(flight).toContain('"count":552')
    expect(flight).toContain('"count":438')

    // Seeded: the anchored leaf and its neighbors; the head is
    // fetched only by the root's shape read.
    expect(new Set(state.calls)).toEqual(new Set([0, 672, 696, 720]))
    expect(flight).toMatch(/"data-item":696[,}]/)
    expect(flight).not.toMatch(/"data-item":600[,}]/)
  })

  it("an anchor move re-renders ONLY verdict-flipped leaves — others hold their fp", async () => {
    // ?page=1 → seed window [0,24) pad 24: leaves 0, 24 seeded.
    // ?page=2 → seed window [24,48) pad 24: leaves 0, 24, 48 seeded.
    const at1 = leafFpsOf(await flightAt("http://t/", tree))
    const at2 = leafFpsOf(await flightAt("http://t/?page=2", tree))

    // Culled leaves ship no fp (nothing to advertise) — the property
    // lives on MATERIALIZED leaves whose verdict held: seeded at both
    // anchors, their fps must be byte-identical across the move. A
    // raw `search:page` dep would shift every one of them.
    for (const o of [0, 24]) {
      expect(at1.get(o), `leaf ${o} at page 1`).toBeDefined()
      expect(at2.get(o), `leaf ${o} at page 2`).toBe(at1.get(o))
    }
    // The flipped leaf (48: unseeded → seeded) materializes fresh.
    expect(at1.get(48)).toBeUndefined()
    expect(at2.get(48)).toBeDefined()
  })
})

describe("scroller: growth re-shapes only the tail", () => {
  beforeEach(() => clearRegistry("all"))

  const state = { total: 100, calls: [] as number[] }
  const List = scroller({
    name: "grow-list",
    load: makeSource(state),
    render: ({ item: i }) => <i key={i} data-item={i} />,
    leaf: 24,
    ring: 6,
  })
  const tree = (
    <PartialRoot>
      <List />
    </PartialRoot>
  )

  it("middle placements keep their props as total grows", async () => {
    state.total = 100
    const before = leavesOf(await flightAt("http://t/", tree))
    expect(before).toContainEqual([0, 24])
    expect(before).toContainEqual([96, 4])

    clearRegistry("all")
    state.total = 120
    const after = leavesOf(await flightAt("http://t/", tree))
    expect(after).toContainEqual([0, 24])
    expect(after).toContainEqual([96, 24])
    expect(after).not.toContainEqual([96, 4])
  })
})
