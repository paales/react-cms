/**
 * RSC integration test for `<Children>` / `<Child>` slot primitives.
 * Renders a CMS-aware Partial whose content invokes `<Children>`;
 * asserts that each slot entry resolves through the block registry
 * and renders its CMS-authored fields, and that the resulting payload
 * includes per-entry `partialId` markers.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

// Same pattern as other `.rsc.test.tsx` files — cache.tsx imports
// `@vitejs/plugin-rsc/rsc` (virtual module) which can't load in the
// rsc-test env. Bypass-mock.
vi.mock("../cache.tsx", () => ({
  Cache: ({ children }: { children: React.ReactNode }) => children,
  _cacheStats: async () => ({ size: 0, keys: [] }),
  _clearCache: async () => {},
}))

import { getText } from "../../framework/context.ts"
import { _clearBlockRegistry, registerBlock } from "../../framework/cms-runtime.ts"
import { Partial, PartialRoot } from "../partial.tsx"
import { ROOT } from "../partial-context.ts"
import { clearRegistry } from "../partial-registry.ts"
import { Children } from "../slot.tsx"
import { flightToString, renderWithRequest } from "../../test/rsc-server.ts"

beforeEach(() => {
  clearRegistry()
  _clearBlockRegistry()
})

function HeroBlock() {
  const headline = getText("headline")
  return <div>{`slot-hero:${headline}`}</div>
}

function RichTextBlock() {
  const body = getText("body")
  return <div>{`slot-text:${body}`}</div>
}

async function renderToText(url: string, node: React.ReactNode): Promise<string> {
  const { stream } = await renderWithRequest(url, node)
  return flightToString(stream)
}

describe("<Children> slot rendering", () => {
  it("renders every registered entry in store order", async () => {
    registerBlock("hero", { tags: [".demo-block"], component: HeroBlock })
    registerBlock("rich-text", {
      tags: [".demo-block"],
      component: RichTextBlock,
    })

    const tree = (
      <PartialRoot>
        <Partial parent={ROOT} selector="#composed" cmsId="cms-demo-composed">
          <Children name="body" allow=".demo-block" />
        </Partial>
      </PartialRoot>
    )
    const text = await renderToText("http://localhost/cms-demo", tree)
    expect(text).toContain("slot-hero:First hero in the body slot")
    expect(text).toContain("slot-text:This rich-text block is the second entry")
    expect(text).toContain("slot-hero:Third block (default)")
  })

  it("per-entry cascade still works at slot depth", async () => {
    registerBlock("hero", { tags: [".demo-block"], component: HeroBlock })
    registerBlock("rich-text", {
      tags: [".demo-block"],
      component: RichTextBlock,
    })

    const tree = (
      <PartialRoot>
        <Partial parent={ROOT} selector="#composed" cmsId="cms-demo-composed">
          <Children name="body" allow=".demo-block" />
        </Partial>
      </PartialRoot>
    )
    // On /cms-demo/alpha the third hero's per-slug config wins over
    // its default — proving cascade flows recursively through slots.
    const text = await renderToText("http://localhost/cms-demo/alpha", tree)
    expect(text).toContain("slot-hero:Alpha-only third block")
    expect(text).not.toContain("slot-hero:Third block (default)")
  })

  it("emits a `partialId` marker per slot entry so fp-skip + invalidation target each block independently", async () => {
    registerBlock("hero", { tags: [".demo-block"], component: HeroBlock })
    registerBlock("rich-text", {
      tags: [".demo-block"],
      component: RichTextBlock,
    })

    const tree = (
      <PartialRoot>
        <Partial parent={ROOT} selector="#composed" cmsId="cms-demo-composed">
          <Children name="body" allow=".demo-block" />
        </Partial>
      </PartialRoot>
    )
    const text = await renderToText("http://localhost/cms-demo", tree)
    // Each of the three entries gets its own PartialErrorBoundary
    // client component with `partialId` set to the cmsId.
    expect(text).toContain('"partialId":"composed-hero-1"')
    expect(text).toContain('"partialId":"composed-text-1"')
    expect(text).toContain('"partialId":"composed-hero-2"')
  })

  it("missing block type is skipped (dev-mode warn, no throw)", async () => {
    // Intentionally don't register "rich-text" — the slot has one
    // such entry that should be skipped cleanly while the others
    // still render.
    registerBlock("hero", { tags: [".demo-block"], component: HeroBlock })

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const tree = (
        <PartialRoot>
          <Partial parent={ROOT} selector="#composed" cmsId="cms-demo-composed">
            <Children name="body" allow=".demo-block" />
          </Partial>
        </PartialRoot>
      )
      const text = await renderToText("http://localhost/cms-demo", tree)
      // Hero entries render; rich-text is silently dropped.
      expect(text).toContain("slot-hero:First hero in the body slot")
      expect(text).toContain("slot-hero:Third block (default)")
      expect(text).not.toContain("slot-text:")
    } finally {
      warnSpy.mockRestore()
    }
  })

  it("renders nothing when the host Partial has no cmsId (slot is CMS-scope-gated)", async () => {
    registerBlock("hero", { tags: [".demo-block"], component: HeroBlock })

    const tree = (
      <PartialRoot>
        <Partial parent={ROOT} selector="#no-cms">
          <div>
            before
            <Children name="body" allow=".demo-block" />
            after
          </div>
        </Partial>
      </PartialRoot>
    )
    const text = await renderToText("http://localhost/cms-demo", tree)
    expect(text).toContain("before")
    expect(text).toContain("after")
    expect(text).not.toContain("slot-hero:")
  })
})
