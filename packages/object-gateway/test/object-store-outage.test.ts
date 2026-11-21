import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FileSystemObjectStore, resolveObjectStoreLanes } from "../src/object-store.ts";

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
	it("retains at most two blocked syscall slots and refuses at once while both are blocked", async () => {
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

	it("reads one object once for every reader who asks while the read is under way", async () => {
		let arrive: (info: unknown) => void = () => {};
		filesystem.stat.mockImplementation(
			() =>
				new Promise((resolve) => {
					arrive = resolve;
				}),
		);
		filesystem.readFile.mockResolvedValue(bytes);
		const store = new FileSystemObjectStore("/synthetic-objects", 1000);
		const readers = [1, 2, 3, 4].map(() => store.get(profileId, hash, bytes.length));
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(filesystem.stat).toHaveBeenCalledOnce();
		arrive({ isFile: () => true, size: bytes.length });
		for (const read of await Promise.all(readers)) expect(Buffer.from(read)).toEqual(bytes);
		expect(filesystem.readFile).toHaveBeenCalledOnce();
		filesystem.stat.mockResolvedValue({ isFile: () => true, size: bytes.length });
		expect(Buffer.from(await store.get(profileId, hash, bytes.length))).toEqual(bytes);
		expect(filesystem.readFile).toHaveBeenCalledTimes(2);
	});

	it("lets a third object wait for a lane instead of refusing it, in the order asked", async () => {
		const objects = ["one", "two", "three", "four"].map((text) => {
			const content = Buffer.from(text);
			return { content, sha256: createHash("sha256").update(content).digest("hex") };
		});
		const named = (path: string) => objects.find((object) => path.endsWith(object.sha256));
		const begun: string[] = [];
		const arrivals = new Map<string, () => void>();
		filesystem.stat.mockImplementation(
			(path: string) =>
				new Promise((resolve) => {
					const object = named(path);
					if (!object) return;
					begun.push(object.sha256);
					arrivals.set(object.sha256, () => resolve({ isFile: () => true, size: object.content.length }));
				}),
		);
		filesystem.readFile.mockImplementation(async (path: string) => named(path)?.content);
		const store = new FileSystemObjectStore("/synthetic-objects", 1000);
		const [one, two, three, four] = objects.map((object) => object.sha256) as [string, string, string, string];
		const reads = objects.map((object) => store.get(profileId, object.sha256, object.content.length));
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(begun).toEqual([one, two]);
		arrivals.get(one)?.();
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(begun).toEqual([one, two, three]);
		arrivals.get(two)?.();
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(begun).toEqual([one, two, three, four]);
		arrivals.get(three)?.();
		arrivals.get(four)?.();
		expect((await Promise.all(reads)).map((read) => Buffer.from(read).toString())).toEqual([
			"one",
			"two",
			"three",
			"four",
		]);
	});

	it("refuses a waiting operation when its patience runs out, without starting it", async () => {
		filesystem.stat.mockImplementation(() => new Promise(() => {}));
		const store = new FileSystemObjectStore("/synthetic-objects", 1000, 15);
		void store.get(profileId, hash, bytes.length).catch(() => {});
		void store.get(profileId, "a".repeat(64), bytes.length).catch(() => {});
		await expect(store.get(profileId, "b".repeat(64), bytes.length)).rejects.toMatchObject({ status: 503 });
		await expect(store.remove(profileId, "c".repeat(64))).rejects.toMatchObject({ status: 503 });
		expect(filesystem.stat).toHaveBeenCalledTimes(2);
		expect(filesystem.rm).not.toHaveBeenCalled();
	});

	it("refuses every waiting operation as soon as both lanes are blocked past their deadline", async () => {
		filesystem.stat.mockImplementation(() => new Promise(() => {}));
		const store = new FileSystemObjectStore("/synthetic-objects", 15, 10_000);
		const refusal = (read: Promise<Uint8Array>) =>
			read.then(
				() => "read",
				(error: { status?: number }) => error.status,
			);
		const blocked = [hash, "a".repeat(64)].map((sha256) => refusal(store.get(profileId, sha256, bytes.length)));
		const began = Date.now();
		expect(await refusal(store.get(profileId, "b".repeat(64), bytes.length))).toBe(503);
		expect(Date.now() - began).toBeLessThan(1000);
		expect(await Promise.all(blocked)).toEqual([503, 503]);
		expect(filesystem.stat).toHaveBeenCalledTimes(2);
	});

	it("runs a deletion asked for during a write of the same object after that write, never before", async () => {
		let finish: () => void = () => {};
		const writing = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const order: string[] = [];
		filesystem.stat.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
		filesystem.open.mockResolvedValue({ writeFile: () => writing, sync: async () => {}, close: async () => {} });
		filesystem.rename.mockImplementation(async () => {
			order.push("rename");
		});
		filesystem.rm.mockImplementation(async (path: string) => {
			if (!path.endsWith(".tmp")) order.push("rm");
		});
		const store = new FileSystemObjectStore("/synthetic-objects", 1000);
		const put = store.put(profileId, hash, bytes);
		const removal = store.remove(profileId, hash);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(order).toEqual([]);
		finish();
		expect(await put).toBe("stored");
		await removal;
		expect(order).toEqual(["rename", "rm"]);
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

	it("scales lanes when configured and still isolates a full stuck-NAS outage at the configured lane cap", async () => {
		expect(resolveObjectStoreLanes({})).toBe(2);
		expect(resolveObjectStoreLanes({ UV_THREADPOOL_SIZE: "3", QORPERA_OBJECT_GATEWAY_NAS_LANES: "1" })).toBe(1);
		expect(resolveObjectStoreLanes({ UV_THREADPOOL_SIZE: "16", QORPERA_OBJECT_GATEWAY_NAS_LANES: "8" })).toBe(8);
		expect(() => resolveObjectStoreLanes({ QORPERA_OBJECT_GATEWAY_NAS_LANES: "4" })).toThrow("UV_THREADPOOL_SIZE>=6");
		expect(() => resolveObjectStoreLanes({ UV_THREADPOOL_SIZE: "8", QORPERA_OBJECT_GATEWAY_NAS_LANES: "7" })).toThrow(
			"UV_THREADPOOL_SIZE>=9",
		);
		expect(() => resolveObjectStoreLanes({ UV_THREADPOOL_SIZE: "2" })).toThrow("UV_THREADPOOL_SIZE>=4");
		expect(() => resolveObjectStoreLanes({ UV_THREADPOOL_SIZE: "1", QORPERA_OBJECT_GATEWAY_NAS_LANES: "2" })).toThrow(
			"UV_THREADPOOL_SIZE>=4",
		);
		for (const badLanes of ["", "0", "-1", "17", "2abc", "1.5"]) {
			expect(() =>
				resolveObjectStoreLanes({ UV_THREADPOOL_SIZE: "32", QORPERA_OBJECT_GATEWAY_NAS_LANES: badLanes }),
			).toThrow("QORPERA_OBJECT_GATEWAY_NAS_LANES is invalid");
		}
		for (const badPool of ["", "0", "-1", "abc", "4294967296"]) {
			expect(() =>
				resolveObjectStoreLanes({ UV_THREADPOOL_SIZE: badPool, QORPERA_OBJECT_GATEWAY_NAS_LANES: "2" }),
			).toThrow("UV_THREADPOOL_SIZE is invalid");
		}
		for (const badCtor of [0, -1, 17, 1.5]) {
			expect(() => new FileSystemObjectStore("/synthetic-objects", 15, 10_000, badCtor)).toThrow(
				"Object operation lanes are invalid",
			);
		}

		filesystem.stat.mockImplementation(() => new Promise(() => {}));
		const store = new FileSystemObjectStore("/synthetic-objects", 15, 10_000, 4);
		const results = await Promise.all(
			["1", "2", "3", "4", "5", "6"].map((digit) =>
				store.get(profileId, digit.repeat(64), bytes.length).then(
					() => "ok",
					(error: { status?: number }) => error.status,
				),
			),
		);
		expect(results).toEqual([503, 503, 503, 503, 503, 503]);
		expect(filesystem.stat).toHaveBeenCalledTimes(4);
	});

	it("caches known directories, recreates on ENOENT, skips temp unlink after rename, and cleans up on failure", async () => {
		const secondBytes = Buffer.from("second immutable payload");
		const secondHash = createHash("sha256").update(secondBytes).digest("hex");
		const thirdBytes = Buffer.from("third immutable payload");
		const thirdHash = createHash("sha256").update(thirdBytes).digest("hex");
		const sync = vi.fn(async () => {});
		const okHandle = { writeFile: async () => {}, sync, close: async () => {} };
		filesystem.stat.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
		filesystem.mkdir.mockResolvedValue(`/synthetic-objects/${profileId}`);
		filesystem.open.mockResolvedValue(okHandle);
		const store = new FileSystemObjectStore("/synthetic-objects", 1000);

		expect(await store.put(profileId, hash, bytes)).toBe("stored");
		expect(filesystem.mkdir).toHaveBeenCalledTimes(1);
		expect(filesystem.rm).not.toHaveBeenCalled();

		expect(await store.put(profileId, secondHash, secondBytes)).toBe("stored");
		expect(filesystem.mkdir).toHaveBeenCalledTimes(1);
		expect(filesystem.rm).not.toHaveBeenCalled();

		filesystem.open
			.mockRejectedValueOnce(Object.assign(new Error("gone"), { code: "ENOENT" }))
			.mockResolvedValue(okHandle);
		expect(await store.put(profileId, thirdHash, thirdBytes)).toBe("stored");
		expect(filesystem.mkdir).toHaveBeenCalledTimes(2);
		expect(filesystem.rm).not.toHaveBeenCalled();

		const fourthBytes = Buffer.from("fourth failing payload");
		const fourthHash = createHash("sha256").update(fourthBytes).digest("hex");
		filesystem.open.mockResolvedValueOnce({
			writeFile: async () => {
				throw new Error("ENOSPC");
			},
			sync,
			close: async () => {},
		});
		await expect(store.put(profileId, fourthHash, fourthBytes)).rejects.toThrow("ENOSPC");
		expect(filesystem.rm).toHaveBeenCalledTimes(1);
	});
});
