import { describe, expect, it } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, resolve } from "node:path"

/**
 * The RSC plugin requires all exported functions from "use server" files
 * to be async. This test catches sync exports that would fail at build time
 * with: [plugin:rsc:use-server] unsupported non async function
 */

function findFiles(dir: string, ext: string[]): string[] {
  const results: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (entry === "node_modules" || entry === ".git") continue
    if (statSync(full).isDirectory()) {
      results.push(...findFiles(full, ext))
    } else if (ext.some((e) => full.endsWith(e))) {
      results.push(full)
    }
  }
  return results
}

describe("server action conventions", () => {
  it('all exports from "use server" files must be async functions', () => {
    const root = resolve(import.meta.dirname, "../../..")
    const files = findFiles(join(root, "src"), [".ts", ".tsx"])

    const violations: string[] = []

    for (const file of files) {
      const content = readFileSync(file, "utf-8")

      // Only check files with "use server" directive at the top
      if (!content.match(/^["']use server["']/m)) continue

      // Find exported non-async functions
      // Matches: export function foo(  but NOT: export async function foo(
      const lines = content.split("\n")
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        const syncMatch = line.match(/^export\s+function\s+(\w+)/)
        if (syncMatch) {
          const relativePath = file.replace(root + "/", "")
          violations.push(
            `${relativePath}:${i + 1} — export function ${syncMatch[1]}() must be async`,
          )
        }
      }
    }

    expect(
      violations,
      [
        'Sync exports in "use server" files will fail at build time with:',
        "  [plugin:rsc:use-server] unsupported non async function",
        "",
        "Violations:",
        ...violations.map((v) => `  ${v}`),
      ].join("\n"),
    ).toEqual([])
  })
})
