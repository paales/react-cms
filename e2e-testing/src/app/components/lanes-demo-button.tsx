"use client";

import { Button } from "@parton/copies/components/ui/button";
import type { ResolvedCell } from "@parton/framework";
import { useCell } from "@parton/framework/lib/cell-client.tsx";

/**
 * Bumps the slow counter's cell. The write's partition-scoped
 * invalidation wakes the live connection, which opens a ~2.5s lane for
 * `lanes-demo-slow` — while the clock's one-second lanes keep flowing
 * past it. The e2e spec clicks this and asserts the overlap from the
 * partons' own server-clock stamps.
 */
export function LaneSlowBumpButton({
	version: cell,
}: {
	version: ResolvedCell<number>;
}) {
	const version = useCell(cell);
	return (
		<Button
			// `data-hydrated`: React owns the button (onClick live) — e2e
			// clicks via the marker-qualified locator.
			ref={(el) => el?.setAttribute("data-hydrated", "")}
			data-testid="lanes-demo-bump"
			onClick={() => version.set(version.value + 1)}
		>
			Bump the slow counter
		</Button>
	);
}
