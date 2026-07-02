/**
 * Per-parton lane demo — the head-of-line-blocking proof page.
 *
 * Two live partons share the page:
 *
 *   - `LaneClock` ticks once per second (`expiresAt: time.nextSecond`).
 *   - `LaneSlowCounter` is cell-backed and deliberately SLOW: its
 *     render awaits ~2.5s before returning, stamping server-clock
 *     start/finish times on its output.
 *
 * On the live connection, each update travels as its own lane — so the
 * clock keeps ticking, with fresh server-rendered seconds arriving,
 * WHILE the slow counter's render is still in flight. The e2e spec
 * asserts that overlap purely from the server-clock stamps the partons
 * themselves emit (a clock tick whose value lies strictly between the
 * slow render's start and finish), no wall-clock guessing.
 */

import {
	expires,
	localCell,
	parton,
	time,
	type RenderArgs,
	type ResolvedCell,
} from "@parton/framework";
import {
	LaneSlowBumpButton,
	SlowCommitBeacon,
} from "../components/lanes-demo-button.tsx";

// Deferred: the bump's POST returns no re-render — the new value
// reaches the page over the live connection's lane, which is the
// path this demo exists to prove.
export const laneSlowVersion = localCell({
	id: "lane-slow-version",
	shape: "number",
	initial: 0,
	deferred: true,
});

const SLOW_RENDER_MS = 2_500;

const LaneClock = parton(
	function LaneClockRender(_: RenderArgs) {
		// Wake boundary: the live driver opens a fresh lane every second;
		// fp-skip declines a snapshot past the boundary (TTL gate).
		const clock = time();
		expires(clock.nextSecond);
		const second = Math.floor(clock.now / 1000);
		return (
			<div
				className="font-mono text-sm"
				data-testid="lanes-demo-clock"
				data-clock-second={second}
			>
				{`server second ${second}`}
			</div>
		);
	},
	{ selector: "lanes-demo-clock" },
);

const LaneSlowCounter = parton(
	async function LaneSlowCounterRender({
		version,
	}: { version: ResolvedCell<number> } & RenderArgs) {
		const startedAt = Date.now();
		// Version 0 is the cold page load — render immediately so the
		// initial segment isn't gated. Every bumped re-render takes the
		// slow path: this parton's lane stays open for SLOW_RENDER_MS
		// while the clock's lanes keep flowing past it.
		if (version.value > 0) {
			await new Promise((resolve) => setTimeout(resolve, SLOW_RENDER_MS));
		}
		const finishedAt = Date.now();
		// Visible render window in the same unit the clock displays, so a
		// human can check the clock ticked THROUGH the slow render.
		const renderWindow =
			version.value > 0
				? ` — rendered during server seconds ${Math.floor(startedAt / 1000)} → ${Math.floor(finishedAt / 1000)}`
				: " (initial render — instant)";
		return (
			<div
				className="font-mono text-sm"
				data-testid="lanes-demo-slow"
				data-slow-version={version.value}
				data-slow-started={startedAt}
				data-slow-finished={finishedAt}
			>
				{`slow counter v${version.value}${renderWindow}`}
				<SlowCommitBeacon version={version.value} />
			</div>
		);
	},
	{
		selector: "lanes-demo-slow",
		schema: () => ({ version: laneSlowVersion }),
	},
);

// Its own parton (not part of the page's schema): resolving the cell
// stamps the `cell:` label on the resolver, and the bump should make
// only this small control and the slow counter relevant — never the
// page wrapper or the clock.
const LaneSlowControls = parton(
	function LaneSlowControlsRender({
		version,
	}: { version: ResolvedCell<number> } & RenderArgs) {
		return <LaneSlowBumpButton version={version} />;
	},
	{
		selector: "lanes-demo-controls",
		schema: () => ({ version: laneSlowVersion }),
	},
);

export const LanesDemoPage = parton(
	function LanesDemoPageRender() {
		return (
			<main className="mx-auto flex max-w-2xl flex-col gap-6 p-8">
				<h1 className="text-xl font-semibold">Per-parton lanes</h1>
				<p className="text-sm opacity-70">
					The clock ticks every second over its own lane. Bumping the slow
					counter opens a ~2.5s lane — and the clock keeps ticking through it,
					because lanes interleave instead of gating on the slowest render.
					After it lands, the counter reports the server-second window it
					rendered through: the clock will have displayed those very seconds
					while the render was still in flight.
				</p>
				<LaneClock />
				<LaneSlowCounter />
				<LaneSlowControls />
			</main>
		);
	},
	{ match: "/lanes-demo", selector: "lanes-demo-page" },
);
