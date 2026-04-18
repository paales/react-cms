// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeStoredSubscribe, WhenStored } from "../when-stored.tsx";

beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
});

describe("<WhenStored>", () => {
	it("throws when partialId is missing", () => {
		expect(() =>
			WhenStored({ storageKey: "greeting" } as never),
		).toThrowError(/partialId/);
	});
});

describe("makeStoredSubscribe (the `<WhenStored>` subscribe builder)", () => {
	it("fires immediately when the key is already present on mount", () => {
		localStorage.setItem("greeting", "hi");
		const subscribe = makeStoredSubscribe({ storageKey: "greeting" });
		const fire = vi.fn();
		subscribe(fire);
		expect(fire).toHaveBeenCalledTimes(1);
		expect(fire).toHaveBeenCalledWith({ value: "hi" });
	});

	it("does not fire when the key is absent on mount", () => {
		const subscribe = makeStoredSubscribe({ storageKey: "greeting" });
		const fire = vi.fn();
		subscribe(fire);
		expect(fire).not.toHaveBeenCalled();
	});

	it("fires when a matching storage event arrives", () => {
		const subscribe = makeStoredSubscribe({ storageKey: "greeting" });
		const fire = vi.fn();
		const cleanup = subscribe(fire);

		localStorage.setItem("greeting", "hello");
		window.dispatchEvent(
			new StorageEvent("storage", {
				key: "greeting",
				newValue: "hello",
				storageArea: localStorage,
			}),
		);
		expect(fire).toHaveBeenCalledWith({ value: "hello" });
		if (typeof cleanup === "function") cleanup();
	});

	it("ignores storage events for other keys", () => {
		const subscribe = makeStoredSubscribe({ storageKey: "greeting" });
		const fire = vi.fn();
		subscribe(fire);
		window.dispatchEvent(
			new StorageEvent("storage", {
				key: "OTHER",
				newValue: "val",
				storageArea: localStorage,
			}),
		);
		expect(fire).not.toHaveBeenCalled();
	});

	it("ignores storage events from a different storage area", () => {
		const subscribe = makeStoredSubscribe({ storageKey: "greeting" });
		const fire = vi.fn();
		subscribe(fire);
		window.dispatchEvent(
			new StorageEvent("storage", {
				key: "greeting",
				newValue: "hi",
				storageArea: sessionStorage,
			}),
		);
		expect(fire).not.toHaveBeenCalled();
	});

	it("uses the `as` prop as the input key", () => {
		localStorage.setItem("greeting", "hi");
		const subscribe = makeStoredSubscribe({
			storageKey: "greeting",
			as: "draftId",
		});
		const fire = vi.fn();
		subscribe(fire);
		expect(fire).toHaveBeenCalledWith({ draftId: "hi" });
	});

	it("reads sessionStorage when store='session'", () => {
		sessionStorage.setItem("greeting", "hi");
		const subscribe = makeStoredSubscribe({
			storageKey: "greeting",
			store: "session",
		});
		const fire = vi.fn();
		subscribe(fire);
		expect(fire).toHaveBeenCalledWith({ value: "hi" });
	});

	it("cleanup removes the storage listener", () => {
		const subscribe = makeStoredSubscribe({ storageKey: "greeting" });
		const fire = vi.fn();
		const cleanup = subscribe(fire);
		expect(typeof cleanup).toBe("function");
		(cleanup as () => void)();

		window.dispatchEvent(
			new StorageEvent("storage", {
				key: "greeting",
				newValue: "hi",
				storageArea: localStorage,
			}),
		);
		expect(fire).not.toHaveBeenCalled();
	});
});
