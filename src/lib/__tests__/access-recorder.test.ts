import { describe, expect, it } from "vitest";
import { AccessRecorder } from "../access-recorder.js";

describe("AccessRecorder", () => {
	it("records a single field access", () => {
		const recorder = new AccessRecorder();
		recorder.recordAccess(["name"]);

		const tree = recorder.getAccessTree();
		expect(tree).toHaveLength(1);
		expect(tree[0].field).toBe("name");
		expect(tree[0].children).toHaveLength(0);
	});

	it("records multiple flat fields", () => {
		const recorder = new AccessRecorder();
		recorder.recordAccess(["name"]);
		recorder.recordAccess(["id"]);

		const tree = recorder.getAccessTree();
		expect(tree).toHaveLength(2);
		expect(tree.map((n) => n.field)).toEqual(["name", "id"]);
	});

	it("records nested field access", () => {
		const recorder = new AccessRecorder();
		recorder.recordAccess(["sprites", "front_default"]);

		const tree = recorder.getAccessTree();
		expect(tree).toHaveLength(1);
		expect(tree[0].field).toBe("sprites");
		expect(tree[0].children).toHaveLength(1);
		expect(tree[0].children[0].field).toBe("front_default");
	});

	it("merges overlapping paths into a tree", () => {
		const recorder = new AccessRecorder();
		recorder.recordAccess(["sprites", "front_default"]);
		recorder.recordAccess(["sprites", "back_default"]);

		const tree = recorder.getAccessTree();
		expect(tree).toHaveLength(1);
		expect(tree[0].field).toBe("sprites");
		expect(tree[0].children).toHaveLength(2);
		expect(tree[0].children.map((c) => c.field)).toEqual(["front_default", "back_default"]);
	});

	it("records deeply nested paths", () => {
		const recorder = new AccessRecorder();
		recorder.recordAccess(["a", "b", "c", "d"]);

		const tree = recorder.getAccessTree();
		expect(tree[0].field).toBe("a");
		expect(tree[0].children[0].field).toBe("b");
		expect(tree[0].children[0].children[0].field).toBe("c");
		expect(tree[0].children[0].children[0].children[0].field).toBe("d");
	});

	it("records field arguments", () => {
		const recorder = new AccessRecorder();
		recorder.recordAccess(["pokemon"], { limit: 10, offset: 0 });

		const tree = recorder.getAccessTree();
		expect(tree[0].args).toEqual({ limit: 10, offset: 0 });
	});

	it("resets recorded paths", () => {
		const recorder = new AccessRecorder();
		recorder.recordAccess(["name"]);
		recorder.reset();

		expect(recorder.getAccessTree()).toHaveLength(0);
	});

	it("ignores empty paths", () => {
		const recorder = new AccessRecorder();
		recorder.recordAccess([]);

		expect(recorder.getAccessTree()).toHaveLength(0);
	});
});
