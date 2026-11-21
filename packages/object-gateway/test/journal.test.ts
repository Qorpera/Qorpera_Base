import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ObjectGatewayJournal } from "../src/journal.ts";

const hooks = vi.hoisted(() => ({
	onDirSync: undefined as ((directory: string) => Promise<void>) | undefined,
	onMkdir: undefined as ((path: string) => Promise<void>) | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
			if (hooks.onMkdir) await hooks.onMkdir(String(args[0]));
			return actual.mkdir(...args);
		},
		open: async (...args: Parameters<typeof actual.open>) => {
			const handle = await actual.open(...args);
			const path = String(args[0]);
			const flags = args[1];
			if (hooks.onDirSync && typeof flags === "number" && !path.endsWith(".tmp") && !path.endsWith(".json")) {
				const originalSync = handle.sync.bind(handle);
				handle.sync = async () => {
					await hooks.onDirSync?.(path);
					return originalSync();
				};
			}
			return handle;
		},
	};
});

const roots: string[] = [];

async function tempRoot(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "qorpera-journal-test-"));
	roots.push(dir);
	return dir;
}

afterEach(async () => {
	hooks.onDirSync = undefined;
	hooks.onMkdir = undefined;
	while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

describe("ObjectGatewayJournal durability and admission guards", () => {
	it("rejects directory creation failures cleanly without emitting unhandled rejections", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			const base = await tempRoot();
			const blocker = join(base, "not-a-dir");
			await writeFile(blocker, "file", { mode: 0o600 });
			const blockedJournal = new ObjectGatewayJournal(join(blocker, "state"), 10);
			await expect(blockedJournal.write("pending/a", { ok: true })).rejects.toThrow();

			const enospcJournal = new ObjectGatewayJournal(join(base, "enospc-state"), 10);
			hooks.onMkdir = async () => {
				throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
			};
			await expect(enospcJournal.write("pending/a", { ok: true })).rejects.toThrow("ENOSPC");

			hooks.onMkdir = undefined;
			await expect(enospcJournal.write("pending/a", { ok: true })).resolves.toBeUndefined();
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("enforces MAX_TEMP_FILES in both write admission and list()", async () => {
		const base = await tempRoot();
		const stateRoot = join(base, "state");
		const pendingDir = join(stateRoot, "pending");
		await mkdir(stateRoot, { mode: 0o700 });
		await mkdir(pendingDir, { mode: 0o700 });
		await Promise.all(
			Array.from({ length: 256 }, (_, i) => writeFile(join(pendingDir, `.orphan-${i}.tmp`), "", { mode: 0o600 })),
		);

		const journal = new ObjectGatewayJournal(stateRoot, 10);
		await expect(journal.write("pending/blocked", { ok: true })).rejects.toThrow(
			"Gateway journal capacity requires operator attention",
		);
		expect(await journal.list("pending")).toEqual([]);

		await writeFile(join(pendingDir, ".orphan-256.tmp"), "", { mode: 0o600 });
		await expect(journal.list("pending")).rejects.toThrow("Gateway journal capacity requires operator attention");
	});

	it("keeps DirectoryTracker synchronized when parent fsync fails after rename or rm", async () => {
		const base = await tempRoot();
		const stateRoot = join(base, "state");
		const pendingDir = join(stateRoot, "pending");
		const journal = new ObjectGatewayJournal(stateRoot, 1);
		await journal.list("pending");

		let failNextPendingSync = true;
		hooks.onDirSync = async (directory) => {
			if (directory === pendingDir && failNextPendingSync) {
				failNextPendingSync = false;
				throw Object.assign(new Error("EIO"), { code: "EIO" });
			}
		};
		await expect(journal.write("pending/a", { v: 1 })).rejects.toThrow("EIO");
		await expect(journal.write("pending/b", { v: 1 })).rejects.toThrow(
			"Gateway journal capacity requires operator attention",
		);
		await expect(journal.write("pending/a", { v: 2 })).resolves.toBeUndefined();

		failNextPendingSync = true;
		await expect(journal.remove("pending/a")).rejects.toThrow("EIO");
		await expect(journal.write("pending/b", { v: 3 })).resolves.toBeUndefined();
		expect(await journal.list("pending")).toEqual(["pending/b"]);
	});

	it("holds concurrent first writers until directory creation fsyncs finish", async () => {
		const base = await tempRoot();
		const stateRoot = join(base, "fresh-state");
		let inRootSync!: () => void;
		let releaseRootSync!: () => void;
		const rootSyncStarted = new Promise<void>((resolve) => {
			inRootSync = resolve;
		});
		const rootSyncGate = new Promise<void>((resolve) => {
			releaseRootSync = resolve;
		});
		let gated = true;
		hooks.onDirSync = async (directory) => {
			if (gated && directory === stateRoot) {
				gated = false;
				inRootSync();
				await rootSyncGate;
			}
		};

		const journal = new ObjectGatewayJournal(stateRoot, 10);
		let resolvedCount = 0;
		const first = journal.write("pending/a", { a: 1 }).then(() => {
			resolvedCount++;
		});
		await rootSyncStarted;
		const second = journal.write("pending/b", { b: 2 }).then(() => {
			resolvedCount++;
		});
		await new Promise<void>((resolve) => setTimeout(resolve, 25));
		expect(resolvedCount).toBe(0);
		releaseRootSync();
		await Promise.all([first, second]);
		expect(resolvedCount).toBe(2);
		expect(await journal.list("pending")).toEqual(["pending/a", "pending/b"]);
	});
});
