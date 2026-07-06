"use client";

/**
 * Skeleton fixtures for the cull-gate rsc tests. A `cull.skeleton` is
 * a client component: on the wire a culled emission carries only its
 * reference + the placement's serializable props — its body never
 * renders server-side, so nothing here appears as Flight text.
 */

export function SkelBox(_props: object) {
	return <div data-skel="1" />;
}
