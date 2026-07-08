/**
 * FS layer for the /docs viewer — path resolution (the traversal guard
 * is security-relevant), classification, the tree walk, and image-byte
 * serving.
 */

import { resolve } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  classify,
  codeLang,
  docsRoot,
  readDocTree,
  resolveDocPath,
  serveDocAsset,
} from "../docs-fs.ts"

// Pin DOCS_DIR at the repo-level docs/ so the suite is deterministic
// under vitest (which doesn't load the app's vite.config.ts).
const REPO_DOCS = resolve(import.meta.dirname, "../../../../../docs")
let priorDocsDir: string | undefined

beforeAll(() => {
  priorDocsDir = process.env.DOCS_DIR
  process.env.DOCS_DIR = REPO_DOCS
})

afterAll(() => {
  if (priorDocsDir === undefined) delete process.env.DOCS_DIR
  else process.env.DOCS_DIR = priorDocsDir
})

describe("resolveDocPath", () => {
  it("resolves a file inside the docs root", () => {
    const r = resolveDocPath("reference/intro.md")
    expect(r).not.toBeNull()
    expect(r?.rel).toBe("reference/intro.md")
    expect(r?.ext).toBe(".md")
    expect(r?.abs).toBe(resolve(docsRoot(), "reference/intro.md"))
  })

  it("treats the empty path as the root", () => {
    const r = resolveDocPath("")
    expect(r?.rel).toBe("")
    expect(r?.abs).toBe(docsRoot())
  })

  it("rejects traversal that escapes the root", () => {
    expect(resolveDocPath("../package.json")).toBeNull()
    expect(resolveDocPath("../../cms/data/content.json")).toBeNull()
    expect(resolveDocPath("reference/../../secret")).toBeNull()
  })

  it("rejects an absolute path outside the root", () => {
    expect(resolveDocPath("/etc/passwd")).toBeNull()
  })
})

describe("classify", () => {
  it("maps extensions to kinds", () => {
    expect(classify(".md")).toBe("markdown")
    expect(classify(".markdown")).toBe("markdown")
    expect(classify(".ts")).toBe("code")
    expect(classify(".json")).toBe("code")
    expect(classify(".png")).toBe("image")
    expect(classify(".svg")).toBe("image")
    expect(classify(".keep")).toBe("binary")
  })

  it("maps code extensions to shiki languages", () => {
    expect(codeLang(".tsx")).toBe("tsx")
    expect(codeLang(".mjs")).toBe("js")
    expect(codeLang(".unknown")).toBe("text")
  })
})

describe("readDocTree", () => {
  it("walks the root, dirs first, skipping dotfiles", async () => {
    const tree = await readDocTree()
    const names = tree.map((n) => n.name)
    expect(names).toContain("reference")
    expect(names).toContain("internals")
    expect(names.some((n) => n.startsWith("."))).toBe(false)

    const firstFileIdx = tree.findIndex((n) => n.kind !== "dir")
    const lastDirIdx = tree.map((n) => n.kind).lastIndexOf("dir")
    if (firstFileIdx !== -1) expect(lastDirIdx).toBeLessThan(firstFileIdx)

    const reference = tree.find((n) => n.name === "reference")
    expect(reference?.kind).toBe("dir")
    expect(reference?.children?.some((c) => c.name === "intro.md")).toBe(true)
  })
})

describe("serveDocAsset", () => {
  it("serves image bytes with the right MIME", async () => {
    const res = await serveDocAsset(
      new Request("http://x/docs/archive/design/v6-screenshots/01-default.png"),
    )
    expect(res?.status).toBe(200)
    expect(res?.headers.get("content-type")).toBe("image/png")
    const bytes = new Uint8Array(await res!.arrayBuffer())
    expect(bytes.length).toBeGreaterThan(0)
  })

  it("falls through (null) for non-image and non-docs requests", async () => {
    expect(await serveDocAsset(new Request("http://x/docs/reference/intro.md"))).toBeNull()
    expect(await serveDocAsset(new Request("http://x/pokemon/1"))).toBeNull()
    expect(await serveDocAsset(new Request("http://x/docs/x.png", { method: "POST" }))).toBeNull()
  })

  it("can't be made to traverse — the URL layer normalizes `..` away", async () => {
    // `new URL(...).pathname` collapses every `..` form (raw and
    // percent-encoded) before serveDocAsset runs, so a traversal URL no
    // longer starts with `/docs/` and falls through to null. The guard
    // inside `resolveDocPath` is defense-in-depth for direct callers.
    for (const u of ["http://x/docs/../secret.png", "http://x/docs/%2e%2e/secret.png"]) {
      expect(await serveDocAsset(new Request(u))).toBeNull()
    }
  })
})
