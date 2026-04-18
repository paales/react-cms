import React from "react";
import { describe, expect, it } from "vitest";
import { AnyOf } from "../any-of.tsx";

/**
 * `<AnyOf>` is a server component — no hooks, no DOM. It just clones
 * each child activator with `{partialId}` and hands the fallback
 * (children) to the first one. Easy to test against plain JSX.
 */
describe("<AnyOf>", () => {
	function Trigger(_: {
		partialId?: string;
		children?: React.ReactNode;
		label?: string;
	}) {
		return null;
	}

	it("throws when partialId is missing", () => {
		expect(() =>
			AnyOf({ activators: <Trigger /> } as never),
		).toThrowError(/partialId/);
	});

	function toKids(out: ReturnType<typeof AnyOf>) {
		return React.Children.toArray(out).filter(
			React.isValidElement,
		) as React.ReactElement<{
			partialId?: string;
			children?: React.ReactNode;
			label?: string;
		}>[];
	}

	it("clones each activator with the partialId", () => {
		const out = AnyOf({
			partialId: "feed",
			children: <span>fallback</span>,
			activators: (
				<>
					<Trigger />
					<Trigger />
					<Trigger />
				</>
			),
		});
		const kids = toKids(out);
		expect(kids).toHaveLength(3);
		for (const k of kids) {
			expect(k.props.partialId).toBe("feed");
		}
	});

	it("gives fallback only to the first activator; rest get null", () => {
		const out = AnyOf({
			partialId: "feed",
			children: <span data-testid="fb">fallback</span>,
			activators: (
				<>
					<Trigger label="a" />
					<Trigger label="b" />
				</>
			),
		});
		const kids = toKids(out);
		expect(kids[0].props.children).toBeTruthy();
		expect(JSON.stringify(kids[0].props.children)).toContain("fallback");
		expect(kids[1].props.children).toBeNull();
	});

	it("preserves user-set activator props when cloning", () => {
		const out = AnyOf({
			partialId: "feed",
			children: null,
			activators: (
				<>
					<Trigger label="first" />
					<Trigger label="second" />
				</>
			),
		});
		const kids = toKids(out);
		expect(kids[0].props.label).toBe("first");
		expect(kids[1].props.label).toBe("second");
		expect(kids[0].props.partialId).toBe("feed");
		expect(kids[1].props.partialId).toBe("feed");
	});

	it("ignores non-element entries in an activators array (null / false)", () => {
		const out = AnyOf({
			partialId: "feed",
			children: null,
			activators: [
				null,
				<Trigger key="a" />,
				false,
				<Trigger key="b" />,
			],
		});
		expect(toKids(out)).toHaveLength(2);
	});
});
