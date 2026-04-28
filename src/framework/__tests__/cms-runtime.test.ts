/**
 * Unit tests for the CMS resolver — `resolveCmsNode` cascade + match
 * evaluation, independent of the file-backed store. Exercises the
 * types in `src/framework/cms-runtime.ts` directly against fabricated
 * nodes so we can cover specificity, `{in: [...]}` clauses, pathname
 * param matching, and cascade inheritance without committing fixture
 * JSON per case.
 */
import { describe, expect, it } from "vitest"
import {
  buildCmsTreeEntries,
  lookupCmsNode,
  resolveCmsNode,
  slotAddEntryId,
  slotEntryId,
  type CmsConfig,
  type CmsNode,
} from "../cms-runtime.ts"

function node(...configs: CmsConfig[]): CmsNode {
  return { id: "test", configs }
}

describe("resolveCmsNode — match & cascade", () => {
  it("returns empty fields when no config matches", () => {
    const n = node({
      match: { "url:lang": "fr" },
      fields: { headline: "Bonjour" },
    })
    const request = new Request("http://localhost/?lang=en")
    expect(resolveCmsNode(n, request)).toEqual({})
  })

  it("returns default config fields on an empty match clause", () => {
    const n = node({
      match: {},
      fields: { headline: "Welcome", count: 3 },
    })
    const request = new Request("http://localhost/")
    expect(resolveCmsNode(n, request)).toEqual({
      headline: "Welcome",
      count: 3,
    })
  })

  it("matches exact string values on url clauses", () => {
    const n = node(
      {
        match: { "url:variant": "A" },
        fields: { headline: "Variant A" },
      },
      {
        match: {},
        fields: { headline: "default" },
      },
    )
    expect(resolveCmsNode(n, new Request("http://localhost/?variant=A")).headline).toBe("Variant A")
    expect(resolveCmsNode(n, new Request("http://localhost/?variant=B")).headline).toBe("default")
  })

  it("matches {in: [...]} clauses on url", () => {
    const n = node(
      {
        match: { "url:variant": { in: ["A", "B"] } },
        fields: { headline: "Variant A or B" },
      },
      {
        match: {},
        fields: { headline: "other" },
      },
    )
    expect(resolveCmsNode(n, new Request("http://localhost/?variant=A")).headline).toBe(
      "Variant A or B",
    )
    expect(resolveCmsNode(n, new Request("http://localhost/?variant=B")).headline).toBe(
      "Variant A or B",
    )
    expect(resolveCmsNode(n, new Request("http://localhost/?variant=C")).headline).toBe("other")
  })

  it("matches cookie clauses", () => {
    const n = node(
      {
        match: { "cookie:locale": "fr" },
        fields: { headline: "French" },
      },
      { match: {}, fields: { headline: "English" } },
    )
    const withCookie = new Request("http://localhost/", {
      headers: { cookie: "locale=fr" },
    })
    const withoutCookie = new Request("http://localhost/")
    expect(resolveCmsNode(n, withCookie).headline).toBe("French")
    expect(resolveCmsNode(n, withoutCookie).headline).toBe("English")
  })

  it("matches pathname clauses with exact param values", () => {
    const n = node(
      {
        match: { "pathname:/p/:slug": { slug: "alpha" } },
        fields: { headline: "Alpha" },
      },
      { match: {}, fields: { headline: "default" } },
    )
    expect(resolveCmsNode(n, new Request("http://localhost/p/alpha")).headline).toBe("Alpha")
    expect(resolveCmsNode(n, new Request("http://localhost/p/bravo")).headline).toBe("default")
  })

  it("matches pathname clauses with {in: [...]} on a param", () => {
    const n = node(
      {
        match: { "pathname:/p/:slug": { slug: { in: ["a", "b"] } } },
        fields: { headline: "A or B" },
      },
      { match: {}, fields: { headline: "other" } },
    )
    expect(resolveCmsNode(n, new Request("http://localhost/p/a")).headline).toBe("A or B")
    expect(resolveCmsNode(n, new Request("http://localhost/p/b")).headline).toBe("A or B")
    expect(resolveCmsNode(n, new Request("http://localhost/p/c")).headline).toBe("other")
  })

  it("more-specific config wins over less-specific", () => {
    const n = node(
      {
        match: {
          "pathname:/p/:slug": { slug: "alpha" },
          "url:variant": "A",
        },
        fields: { headline: "alpha + variant A" }, // 2 dims matched
      },
      {
        match: { "pathname:/p/:slug": { slug: "alpha" } },
        fields: { headline: "alpha only" }, // 1 dim matched
      },
      {
        match: {},
        fields: { headline: "default" }, // 0 dims
      },
    )
    expect(resolveCmsNode(n, new Request("http://localhost/p/alpha?variant=A")).headline).toBe(
      "alpha + variant A",
    )
    expect(resolveCmsNode(n, new Request("http://localhost/p/alpha?variant=B")).headline).toBe(
      "alpha only",
    )
  })

  it("inherits fields from less-specific configs (cascade)", () => {
    const n = node(
      {
        match: { "url:variant": "A" },
        fields: { headline: "variant-A headline" }, // doesn't set body
      },
      {
        match: {},
        fields: { headline: "default headline", body: "default body" },
      },
    )
    const resolved = resolveCmsNode(n, new Request("http://localhost/?variant=A"))
    // More-specific's headline wins; less-specific's body cascades.
    expect(resolved).toEqual({
      headline: "variant-A headline",
      body: "default body",
    })
  })

  it("ties between equal-specificity configs break by array order", () => {
    const n = node(
      {
        match: { "url:variant": "A" },
        fields: { headline: "first" },
      },
      {
        match: { "url:variant": "A" },
        fields: { headline: "second" },
      },
    )
    expect(resolveCmsNode(n, new Request("http://localhost/?variant=A")).headline).toBe("first")
  })

  it("skips configs whose match clauses refer to keys the request doesn't satisfy", () => {
    const n = node(
      {
        match: { "pathname:/elsewhere/:id": { id: "1" } },
        fields: { headline: "elsewhere" },
      },
      { match: {}, fields: { headline: "default" } },
    )
    expect(resolveCmsNode(n, new Request("http://localhost/p/alpha")).headline).toBe("default")
  })
})

describe("lookupCmsNode — file-backed store", () => {
  it("resolves the demo nodes committed to src/cms/content.json", () => {
    // The demo fixture is the source of truth here; we read it
    // through the real loader to cover the full disk → JSON.parse →
    // lookup path.
    const hero = lookupCmsNode("cms-demo-hero")
    expect(hero).not.toBeNull()
    expect(hero?.displayName).toBe("#hero")
    expect(hero?.configs).toHaveLength(1)
    expect(hero?.configs[0].fields.headline).toBe("Welcome to the CMS demo")

    const greeting = lookupCmsNode("cms-demo-greeting")
    expect(greeting).not.toBeNull()
    expect(greeting?.configs.length).toBeGreaterThanOrEqual(3)
  })

  it("returns null for unknown ids", () => {
    expect(lookupCmsNode("does-not-exist")).toBeNull()
  })
})

describe("buildCmsTreeEntries — slot intermediaries + dedupe", () => {
  it("collapses the slot header for a single-slot parent (children render directly under the parent)", () => {
    const published: Record<string, CmsNode> = {
      parent: {
        id: "parent",
        configs: [{ match: {}, fields: {} }],
        slots: {
          body: [
            {
              id: "child-1",
              type: "hero",
              configs: [{ match: {}, fields: {} }],
            },
          ],
        },
      },
    }
    const entries = buildCmsTreeEntries(published, {})
    // Single-slot parents skip the `▸ body` header — there's nothing
    // to disambiguate when only one slot exists, so the label just
    // adds noise and a wasted indent. Children render at depth+1;
    // the +add palette stays at the same depth as the children.
    expect(entries.map((e) => ({ id: e.id, kind: e.kind, depth: e.depth }))).toEqual([
      { id: "parent", kind: "node", depth: 0 },
      { id: "child-1", kind: "node", depth: 1 },
      { id: slotAddEntryId("parent", "body"), kind: "slot-add", depth: 1 },
    ])
  })

  it("emits a slot intermediary per slot when a parent has 2+ slots", () => {
    const published: Record<string, CmsNode> = {
      multi: {
        id: "multi",
        configs: [{ match: {}, fields: {} }],
        slots: {
          body: [
            {
              id: "body-child",
              type: "hero",
              configs: [{ match: {}, fields: {} }],
            },
          ],
          sidebar: [
            {
              id: "sidebar-child",
              type: "rich-text",
              configs: [{ match: {}, fields: {} }],
            },
          ],
        },
      },
    }
    const entries = buildCmsTreeEntries(published, {})
    expect(entries.map((e) => ({ id: e.id, kind: e.kind, depth: e.depth }))).toEqual([
      { id: "multi", kind: "node", depth: 0 },
      { id: slotEntryId("multi", "body"), kind: "slot", depth: 1 },
      { id: "body-child", kind: "node", depth: 2 },
      { id: slotAddEntryId("multi", "body"), kind: "slot-add", depth: 2 },
      { id: slotEntryId("multi", "sidebar"), kind: "slot", depth: 1 },
      { id: "sidebar-child", kind: "node", depth: 2 },
      {
        id: slotAddEntryId("multi", "sidebar"),
        kind: "slot-add",
        depth: 2,
      },
    ])
  })

  it("emits the +add row for a single empty slot (collapsed header, palette still reachable)", () => {
    const published: Record<string, CmsNode> = {
      parent: {
        id: "parent",
        configs: [{ match: {}, fields: {} }],
        slots: { body: [] },
      },
    }
    const entries = buildCmsTreeEntries(published, {})
    expect(entries.map((e) => ({ id: e.id, kind: e.kind, depth: e.depth }))).toEqual([
      { id: "parent", kind: "node", depth: 0 },
      // Single-slot, header collapsed — but the +add row is still
      // emitted at depth+1 so authors can drop the first block in.
      { id: slotAddEntryId("parent", "body"), kind: "slot-add", depth: 1 },
    ])
  })

  it("dedupes a slot child that also has a top-level draft entry", () => {
    const published: Record<string, CmsNode> = {
      parent: {
        id: "parent",
        configs: [{ match: {}, fields: {} }],
        slots: {
          body: [
            {
              id: "child-1",
              type: "hero",
              configs: [{ match: {}, fields: { headline: "STALE" } }],
            },
          ],
        },
      },
    }
    const draft: Record<string, CmsNode> = {
      // The editor wrote a top-level draft for the slot child.
      "child-1": {
        id: "child-1",
        type: "hero",
        configs: [{ match: {}, fields: { headline: "FRESH" } }],
      },
    }
    const entries = buildCmsTreeEntries(published, draft)
    const childOccurrences = entries.filter((e) => e.id === "child-1")
    expect(childOccurrences).toHaveLength(1)
    // depth=1 because the parent has a single slot (`body`), so the
    // slot header is collapsed and children render directly under
    // the parent.
    expect(childOccurrences[0].depth).toBe(1)
    expect(childOccurrences[0].parentId).toBe("parent")
    expect(childOccurrences[0].slotName).toBe("body")
    expect(childOccurrences[0].hasDraft).toBe(true)
  })

  it("emits a draft-only top-level node as a root when no parent claims it", () => {
    const draft: Record<string, CmsNode> = {
      "brand-new": {
        id: "brand-new",
        type: "hero",
        configs: [{ match: {}, fields: {} }],
      },
    }
    const entries = buildCmsTreeEntries({}, draft)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      id: "brand-new",
      kind: "node",
      depth: 0,
      draftOnly: true,
      hasDraft: true,
    })
  })
})
