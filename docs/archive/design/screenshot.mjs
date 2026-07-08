// Renders the V6 prototype (project/Final Design.html) in a headless
// Chromium and dumps reference screenshots into ./v6-screenshots.
//
// Prereq: a static HTTP server pointed at ./project on port 8765,
// e.g. `cd docs/design/project && python3 -m http.server 8765`.
//
// Run from the repo root: `node docs/design/screenshot.mjs`.

import { chromium } from "playwright"
import { mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(HERE, "v6-screenshots")
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch()
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
})
const page = await context.newPage()
page.on("pageerror", (e) => console.error("[pageerror]", e.message))
page.on("console", (m) => {
  if (m.type() === "error") console.error("[console.error]", m.text())
})

await page.goto("http://localhost:8765/Final%20Design.html", { waitUntil: "networkidle" })
// Babel + react renders take a beat after networkidle
await page.waitForTimeout(2500)

async function shot(name) {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false })
  console.log("wrote", name)
}

await shot("01-default")

await page.evaluate(() => window.__setTweak && window.__setTweak({ treeStyle: "jsx" }))
await page.waitForTimeout(400)
await shot("02-jsx-tree")

await page.evaluate(() => window.__setTweak && window.__setTweak({ attachment: "floating" }))
await page.waitForTimeout(400)
await shot("03-floating")

await page.evaluate(
  () => window.__setTweak && window.__setTweak({ palette: "dark", surface: "translucent" }),
)
await page.waitForTimeout(400)
await shot("04-dark-translucent")

await page.evaluate(
  () =>
    window.__setTweak &&
    window.__setTweak({ palette: "inspector", surface: "translucent", attachment: "docked" }),
)
await page.waitForTimeout(400)
await shot("05-blur-docked")

await page.evaluate(
  () =>
    window.__setTweak &&
    window.__setTweak({
      palette: "inspector",
      surface: "light",
      attachment: "docked",
      treeStyle: "plain",
    }),
)
await page.waitForTimeout(400)
await page.locator('text="Home page"').first().click()
await page.waitForTimeout(300)
await shot("06-page-navigator-open")

await browser.close()
console.log("done")
