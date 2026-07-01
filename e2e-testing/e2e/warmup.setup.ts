import { test, waitForPageInteractive } from "./fixtures";

/**
 * Warmup pre-pass — the `warmup` Playwright project. Runs alone
 * before the `chromium` project (a project dependency), visiting
 * every route once, serially.
 *
 * Why: `yarn test:e2e` boots a fresh dev server, whose module graph
 * is compiled lazily — the first hit on each page pays RSC + SSR +
 * client transforms, and the optimizer discovers missed deps as the
 * browser requests them (which triggers a full-page reload when it
 * re-bundles). Without this pass those costs land in the middle of
 * the parallel spec run: assertions race cold compiles, and an
 * optimizer reload can abort an in-flight navigation. One serial
 * crawl absorbs all of it before the first spec starts.
 *
 * The route list mirrors the app-nav links (see
 * `cms/data/content.json` → `app-nav.slots.links`) plus the
 * non-nav entry points specs exercise directly. Waiting for the
 * page-interactive marker (rather than just the response) makes each
 * visit compile the full client graph and complete hydration.
 */

const ROUTES = [
	"/",
	"/pokemon/1",
	"/pokemon/1?search=url",
	"/docs",
	"/magento",
	"/magento/browse",
	"/magento/cart",
	"/cache-demo",
	"/cache-streaming-demo",
	"/defer-demo",
	"/deferred-demo",
	"/selector-demo",
	"/sentinels-demo",
	"/frames-demo",
	"/inspect",
	"/cms-demo",
	"/cms-demo?editor=1",
	"/streaming-demo",
	"/cursors",
	"/forms-demo",
	"/chat-notes",
	"/remote-frame-demo",
	"/remote-frame-crossorigin-demo",
] as const;

test("warm every route on the fresh dev server", async ({ page }) => {
	// A cold compile of a heavy page can take tens of seconds; the
	// whole crawl gets a generous budget so it never races the clock.
	test.setTimeout(300_000);
	for (const route of ROUTES) {
		// A dep-optimizer discovery mid-navigation reloads the page and
		// aborts the in-flight `goto` (net::ERR_ABORTED). That reload IS
		// the warming this crawl exists to trigger, so retry the route —
		// the re-navigation runs against the now-optimized graph. Bounded:
		// each discovery pass optimizes strictly more of the graph.
		for (let attempt = 1; ; attempt++) {
			try {
				await page.goto(route, { timeout: 60_000 });
				break;
			} catch (err) {
				if (attempt >= 3 || !String(err).includes("ERR_ABORTED")) throw err;
			}
		}
		await waitForPageInteractive(page, { timeout: 60_000 });
	}
});
