"use server";

/**
 * Demo server actions for section invalidation.
 *
 * Each action returns { invalidate: [...sectionIds] }.
 * The framework reads this from the return value and renders
 * only those sections in the response. SectionListClient on the
 * client merges the fresh sections with its cache.
 */

export async function refreshHero() {
	return { invalidate: ["hero"] };
}

export async function refreshStats() {
	return { invalidate: ["stats"] };
}

export async function refreshAll() {
	return { invalidate: ["hero", "stats", "species"] };
}
