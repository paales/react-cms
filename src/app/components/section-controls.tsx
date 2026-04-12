"use client";

import { refreshStats, refreshHero, refreshAll } from "../actions.ts";

/**
 * Client component demonstrating section-level re-fetching.
 * Each button calls a server action that returns { invalidate: [...] }.
 * The framework reads the invalidate list and re-renders only those
 * sections. SectionListClient merges the fresh sections with its cache.
 */
export function SectionControls() {
	return (
		<div className="section-controls">
			<span style={{ color: "#888", fontSize: "0.8rem", alignSelf: "center" }}>
				Section Re-fetch:
			</span>
			<button type="button" onClick={() => refreshHero()}>
				Refresh Hero
			</button>
			<button type="button" onClick={() => refreshStats()}>
				Refresh Stats
			</button>
			<button type="button" onClick={() => refreshAll()}>
				Refresh All
			</button>
		</div>
	);
}
