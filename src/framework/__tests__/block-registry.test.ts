/**
 * Unit tests for the block registry surface in `cms-runtime.ts`.
 * Small and boring — the registry is a Map with three entry points
 * (`registerBlock` / `getBlockSpec` / `listBlockTypes`) plus a test
 * reset. Tests pin: registration round-trips, unknown types return
 * undefined, later registrations overwrite (HMR shape), and
 * `_clearBlockRegistry` resets for test isolation.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { _clearBlockRegistry, getBlockSpec, listBlockTypes, registerBlock } from "../cms-runtime.ts"

function noopComponent() {
  return null
}

beforeEach(() => {
  _clearBlockRegistry()
})

afterEach(() => {
  _clearBlockRegistry()
})

describe("block registry", () => {
  it("round-trips a registered spec", () => {
    registerBlock("hero", {
      tags: [".hero"],
      component: noopComponent,
    })
    const spec = getBlockSpec("hero")
    expect(spec).toBeDefined()
    expect(spec?.tags).toEqual([".hero"])
    expect(spec?.component).toBe(noopComponent)
  })

  it("returns undefined for unknown types", () => {
    expect(getBlockSpec("nope")).toBeUndefined()
  })

  it("later registrations overwrite prior ones (HMR shape)", () => {
    registerBlock("hero", {
      tags: [".hero"],
      component: noopComponent,
    })
    const replacement = () => null
    registerBlock("hero", {
      tags: [".hero-v2"],
      component: replacement,
    })
    const spec = getBlockSpec("hero")
    expect(spec?.tags).toEqual([".hero-v2"])
    expect(spec?.component).toBe(replacement)
  })

  it("listBlockTypes returns registered type keys", () => {
    registerBlock("hero", { tags: [".hero"], component: noopComponent })
    registerBlock("rich-text", {
      tags: [".rich-text"],
      component: noopComponent,
    })
    expect(listBlockTypes().sort()).toEqual(["hero", "rich-text"])
  })

  it("_clearBlockRegistry empties the registry", () => {
    registerBlock("hero", { tags: [".hero"], component: noopComponent })
    expect(getBlockSpec("hero")).toBeDefined()
    _clearBlockRegistry()
    expect(getBlockSpec("hero")).toBeUndefined()
    expect(listBlockTypes()).toEqual([])
  })
})
