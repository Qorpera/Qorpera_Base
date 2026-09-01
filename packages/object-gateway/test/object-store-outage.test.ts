import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FileSystemObjectStore } from "../src/object-store.ts";

const filesystem = vi.hoisted(() => ({
	mkdir: vi.fn(),
	open: vi.fn(),
	readFile: vi.fn(),
	rename: vi.fn(),
	rm: vi.fn(),
	stat: vi.fn(),
}));
vi.mock("node:fs/promises", () => filesystem);

const profileId = "9ec79fc8-a1a7-4eb6-a764-4bc704d4103f";
const bytes = Buffer.from("synthetic immutable data");
const hash = createHash("sha256").update(bytes).digest("hex");

beforeEach(() => {
	vi.resetAllMocks();
});

describe("bounded NAS filesystem operations", () => {
	it("retains at most two blocked syscall slots without queuing more work", async () => {
		filesystem.stat.mockImplementation(() => new Promise(() => {}));
		const store = new FileSystemObjectStore("/synthetic-objects", 15);
		await expect(store.get(profileId, hash, bytes.length)).rejects.toMatchObject({ status: 503 });
		await expect(store.get(profileId, "a".repeat(64), bytes.length)).rejects.toMatchObject({ status: 503 });
		await expect(store.get(profileId, "b".repeat(64), bytes.length)).rejects.toMatchObject({ status: 503 });
		await expect(store.remove(profileId, hash)).rejects.toMatchObject({ status: 503 });
		await store.probe();
		expect(store.dependencyHealth().status).toBe("unavailable");
		expect(filesystem.stat).toHaveBeenCalledTimes(2);
		expect(filesystem.open).not.toHaveBeenCalled();
		expect(filesystem.rm).not.toHaveBeenCalled();
	});

	it("does not let deletion overtake an immutable write that completes after its caller timed out", async () => {
		let finish: () => void = () => {};
		const writing = new Promise<void>((resolve) => {
			finish = resolve;
		});
		filesystem.stat.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
		filesystem.open.mockResolvedValue({ writeFile: () => writing, sync: async () => {}, close: async () => {} });
		const store = new FileSystemObjectStore("/synthetic-objects", 15);
		await expect(store.put(profileId, hash, bytes)).rejects.toMatchObject({ status: 503 });
		await expect(store.remove(profileId, hash)).rejects.toMatchObject({ status: 503 });
		expect(filesystem.rename).not.toHaveBeenCalled();
		expect(filesystem.rm).not.toHaveBeenCalled();
		finish();
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(filesystem.rename).toHaveBeenCalledOnce();
		await store.remove(profileId, hash);
		expect(filesystem.rm).toHaveBeenLastCalledWith(`/synthetic-objects/${profileId}/${hash}`, { force: true });
	});

	it("fsyncs new directory entries and immutable deletion before acknowledging", async () => {
		const sync = vi.fn(async () => {});
		filesystem.stat.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
		filesystem.mkdir.mockResolvedValue(`/synthetic-objects/${profileId}`);
		filesystem.open.mockResolvedValue({ writeFile: async () => {}, sync, close: async () => {} });
		const store = new FileSystemObjectStore("/synthetic-objects", 1000);
		expect(await store.put(profileId, hash, bytes)).toBe("stored");
		expect(filesystem.open).toHaveBeenCalledWith("/synthetic-objects", "r");
		expect(sync).toHaveBeenCalledTimes(4);
		await store.remove(profileId, hash);
		expect(sync).toHaveBeenCalledTimes(5);
	});
});
