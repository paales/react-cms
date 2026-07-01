import {
	expect,
	test,
	waitForLiveConnection,
	waitForPageInteractive,
} from "./fixtures";

/**
 * Per-parton lanes — the head-of-line-blocking proof.
 *
 * `/lanes-demo` holds a 1 Hz clock parton (`expiresAt: nextSecond`)
 * and a slow cell-backed counter whose bumped render takes ~2.5s.
 * On the live connection each update is its own lane, so the clock's
 * ticks must keep arriving WHILE the slow render is in flight.
 *
 * Every assertion reads server-clock stamps the partons emit
 * themselves (`data-clock-second`, `data-slow-started/finished`) —
 * the overlap is proven when a clock second rendered and committed
 * whose value lies strictly inside the slow render's own
 * [started, finished] window. No wall-clock timing.
 */

test("clock lanes keep ticking while a slow parton's lane renders", async ({
	page,
}) => {
	await page.goto("/lanes-demo");
	await waitForPageInteractive(page);
	// The live subscription must be established (the heartbeat marks it)
	// before the bump, so updates arrive as lanes on the open connection.
	await waitForLiveConnection(page);

	const clock = page.getByTestId("lanes-demo-clock");
	const slow = page.getByTestId("lanes-demo-slow");
	await expect(slow).toHaveAttribute("data-slow-version", "0");

	// Collect every committed clock second from the DOM as it updates.
	const seenSeconds = new Set<string>();
	const recordTick = async () => {
		const v = await clock.getAttribute("data-clock-second");
		if (v) seenSeconds.add(v);
		return v;
	};
	await recordTick();

	await page
		.getByTestId("lanes-demo-bump")
		.and(page.locator("[data-hydrated]"))
		.click();

	// While the slow lane renders (~2.5s server-side), the clock must
	// commit fresh seconds. Poll until the slow counter lands at v1,
	// recording clock ticks along the way.
	await expect
		.poll(
			async () => {
				await recordTick();
				return await slow.getAttribute("data-slow-version");
			},
			{ timeout: 15_000 },
		)
		.toBe("1");
	await recordTick();

	const startedAt = Number(await slow.getAttribute("data-slow-started"));
	const finishedAt = Number(await slow.getAttribute("data-slow-finished"));
	// The slow render's own stamps prove it actually took the slow path.
	expect(finishedAt - startedAt).toBeGreaterThanOrEqual(2_000);

	// The proof: at least one clock second committed whose SERVER time
	// falls strictly inside the slow render's window. Under whole-tree
	// segments this is impossible — the driver drains the slow render
	// before emitting the next tick.
	const startedSecond = Math.floor(startedAt / 1000);
	const finishedSecond = Math.floor(finishedAt / 1000);
	const inside = [...seenSeconds]
		.map(Number)
		.filter((s) => s > startedSecond && s < finishedSecond);
	expect(
		inside.length,
		`expected a clock tick inside the slow window [${startedSecond}, ${finishedSecond}]; saw ${[...seenSeconds].join(", ")}`,
	).toBeGreaterThanOrEqual(1);
});

test("the slow lane's content itself arrives correctly after the overlap", async ({
	page,
}) => {
	await page.goto("/lanes-demo");
	await waitForPageInteractive(page);
	await waitForLiveConnection(page);

	const slow = page.getByTestId("lanes-demo-slow");
	await expect(slow).toHaveAttribute("data-slow-version", "0");
	const bump = page
		.getByTestId("lanes-demo-bump")
		.and(page.locator("[data-hydrated]"));

	await bump.click();
	await expect(slow).toHaveAttribute("data-slow-version", "1", {
		timeout: 15_000,
	});
	await expect(slow).toContainText("slow counter v1");

	// A second bump re-renders through the SAME connection (a new lane
	// for the same parton id).
	await bump.click();
	await expect(slow).toHaveAttribute("data-slow-version", "2", {
		timeout: 15_000,
	});
});
