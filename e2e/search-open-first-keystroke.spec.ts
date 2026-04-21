import { test, expect, request } from "@playwright/test";

/**
 * E2E test: first-keystroke behavior after opening URL-mode search.
 *
 * URL mode (`?search=url`) — `useNavigation().navigate(url,
 * {history: "replace", ids: ["stage-1", "stage-2", "stage-3"]})`
 * writes `?q=` to the page URL (bookmarkable) AND dispatches a
 * targeted refetch of the three stages in one call.
 *
 * Expected streaming sequence with `disableTransition: true`:
 *   1. Navigate with `?search=url` (no q) — only stage-1 rendered.
 *   2. Type "p" — stage-1 fallback, then stage-1 content; stages 2/3
 *      fallbacks appear immediately and stream in (~1s, ~2s).
 *   3. Type "o" — same sequence.
 *   4. `<header>` stays mounted throughout (no blank body flash).
 *
 * Frame mode is covered separately in `search-frame.spec.ts`.
 */

// Stage 2/3 are wrapped in `<Cache>` with no TTL, so once a prior test
// (or prior run in the same dev server) has cached `{searchQuery: "p"}`
// or `{searchQuery: "po"}`, subsequent renders resolve instantly and
// the Suspense fallback never has a chance to flash. Clear the caches
// before each test so every run observes a cold-path stream.
test.beforeEach(async ({ baseURL }) => {
  const ctx = await request.newContext();
  await ctx.get(`${baseURL ?? "http://localhost:5173"}/__test/clear-caches`);
  await ctx.dispose();
});

type StateEntry = {
  t: number;
  keystroke: number;
  state: string;
  bodyChildren: number;
};

async function installTracker(page: import("@playwright/test").Page) {
  await page.evaluate(() => {
    const w = window as any;
    w.__bug = {
      keystroke: 0,
      t0: 0,
      states: [] as StateEntry[],
      lastState: "",
    };

    function snapshot() {
      const parts: string[] = [];
      for (let i = 1; i <= 3; i++) {
        const content = document.querySelector(`[data-testid="stage-${i}-content"]`);
        const fallback = document.querySelector(`[data-testid="stage-${i}-fallback"]`);
        // Fallback first: during a Suspense re-suspend, React keeps the
        // old content in the DOM (hidden) while rendering the fallback
        // alongside it. Content-first would report "content" for the
        // whole refetch and never see the fallback flash.
        if (fallback) parts.push(`S${i}:fallback`);
        else if (content) parts.push(`S${i}:content`);
        else parts.push(`S${i}:absent`);
      }
      parts.push(document.querySelector("header") ? "HDR:yes" : "HDR:no");
      parts.push(document.querySelector("dialog[open]") ? "DLG:yes" : "DLG:no");
      return parts.join("|");
    }

    const check = () => {
      const b = w.__bug;
      if (b.keystroke === 0) return;
      const state = snapshot();
      if (state !== b.lastState) {
        b.states.push({
          t: Math.round(performance.now() - b.t0),
          keystroke: b.keystroke,
          state,
          bodyChildren: document.body.children.length,
        });
        b.lastState = state;
      }
    };

    const observer = new MutationObserver(check);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
    });
    w.__bugPoll = setInterval(check, 5);
  });
}

async function startKeystroke(
  page: import("@playwright/test").Page,
  n: number,
) {
  await page.evaluate((k) => {
    const w = window as any;
    w.__bug.states = [];
    w.__bug.lastState = "";
    w.__bug.keystroke = k;
    w.__bug.t0 = performance.now();
  }, n);
}

async function readStates(
  page: import("@playwright/test").Page,
  includeFinal = true,
) {
  return page.evaluate((final) => {
    const w = window as any;
    if (final) clearInterval(w.__bugPoll);
    return {
      states: w.__bug.states.slice() as StateEntry[],
      finalS1: !!document.querySelector('[data-testid="stage-1-content"]'),
      finalS2: !!document.querySelector('[data-testid="stage-2-content"]'),
      finalS3: !!document.querySelector('[data-testid="stage-3-content"]'),
      finalS1fb: !!document.querySelector('[data-testid="stage-1-fallback"]'),
      finalS2fb: !!document.querySelector('[data-testid="stage-2-fallback"]'),
      finalS3fb: !!document.querySelector('[data-testid="stage-3-fallback"]'),
    };
  }, includeFinal);
}

function logTransitions(label: string, states: StateEntry[]) {
  console.log(`\n=== ${label} ===`);
  for (const s of states) {
    console.log(`  [${s.t}ms] bodyKids=${s.bodyChildren} ${s.state}`);
  }
}

test("URL mode: first keystroke streams stages 2/3 progressively", async ({
  page,
}) => {
  const errors: string[] = [];
  const consoleLines: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => consoleLines.push(msg.text()));
  page.on("request", (req) => {
    if (req.url().includes("/pokemon")) consoleLines.push(`REQ: ${req.url()}`);
  });

  await page.goto("/pokemon/1?search=url");
  await page.waitForSelector("input[type=text]", { timeout: 10000 });

  const initial = await page.evaluate(() => ({
    s1: !!document.querySelector(
      '[data-testid="stage-1-content"], input[type=text]',
    ),
    s2: !!document.querySelector(
      '[data-testid="stage-2-content"], [data-testid="stage-2-fallback"]',
    ),
    s3: !!document.querySelector(
      '[data-testid="stage-3-content"], [data-testid="stage-3-fallback"]',
    ),
    header: !!document.querySelector("header"),
  }));
  expect(initial.s1).toBe(true);
  expect(initial.s2).toBe(false);
  expect(initial.s3).toBe(false);
  expect(initial.header).toBe(true);

  await installTracker(page);
  // Opt into streaming mode so fallbacks flash + chunks commit per
  // stage. Default is startTransition (preserve old results, no
  // fallback) which this test is not about.
  await page.locator('[data-testid="disable-transition-toggle"] input').check();
  const input = page.locator("input[type=text]");
  // Wait for hydration: click+focus the input before the keypress so the
  // React onChange handler is attached. Without this, the first keystroke
  // sometimes lands before hydration completes and the handler's
  // replaceState → dispatch flow never runs, leaving the URL without ?q=.
  await input.click();
  await input.focus();
  await page.waitForTimeout(100);

  // Keystroke 1: 'p'
  await startKeystroke(page, 1);
  await input.press("p");
  await page.waitForTimeout(3000);
  const k1 = await readStates(page, false);
  logTransitions("URL mode — keystroke 1 ('p')", k1.states);

  const k1SawS2Fallback = k1.states.some((s) => s.state.includes("S2:fallback"));
  const k1SawS3Fallback = k1.states.some((s) => s.state.includes("S3:fallback"));
  expect(
    k1SawS2Fallback,
    "URL mode: stage-2 fallback should appear during keystroke 1",
  ).toBe(true);
  expect(
    k1SawS3Fallback,
    "URL mode: stage-3 fallback should appear during keystroke 1",
  ).toBe(true);
  expect(
    k1.finalS2,
    "URL mode: stage-2 content should stream in after keystroke 1",
  ).toBe(true);
  expect(
    k1.finalS3,
    "URL mode: stage-3 content should stream in after keystroke 1",
  ).toBe(true);

  // Header must stay mounted throughout the refetch — no blank flash.
  // The outer `layout/page` partial remounting would otherwise unmount
  // the whole page subtree (including <header>).
  const k1HeaderEverMissing = k1.states.some((s) => s.state.includes("HDR:no"));
  expect(
    k1HeaderEverMissing,
    "URL mode: <header> must stay mounted during keystroke 1 (no blank flash)",
  ).toBe(false);

  // Keystroke 2: 'o'
  await startKeystroke(page, 2);
  await input.press("o");
  await page.waitForTimeout(3000);
  const k2 = await readStates(page, true);
  logTransitions("URL mode — keystroke 2 ('o')", k2.states);

  const k2SawS2Fallback = k2.states.some((s) => s.state.includes("S2:fallback"));
  const k2SawS3Fallback = k2.states.some((s) => s.state.includes("S3:fallback"));
  expect(k2SawS2Fallback).toBe(true);
  expect(k2SawS3Fallback).toBe(true);
  expect(k2.finalS2).toBe(true);
  expect(k2.finalS3).toBe(true);

  const k2HeaderEverMissing = k2.states.some((s) => s.state.includes("HDR:no"));
  expect(
    k2HeaderEverMissing,
    "URL mode: <header> must stay mounted during keystroke 2 (no blank flash)",
  ).toBe(false);

  if (errors.length > 0) {
    console.log("\n=== Page errors ===");
    for (const e of errors) console.log(`  ${e.slice(0, 300)}`);
  }
  if (consoleLines.length > 0) {
    console.log("\n=== Requests / console ===");
    for (const l of consoleLines) console.log(`  ${l.slice(0, 300)}`);
  }
});

