import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	openRecoveryFilesystems,
	parseRecoveryDirectoryMount,
	type RecoveryDirectoryMount,
} from "@qorpera/runtime/cloud-identity-recovery-filesystems";
import { afterEach, describe, expect, it, vi } from "vitest";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "qorpera-recovery-mounts-"));
	roots.push(root);
	const config = {
		journalRoot: join(root, "journal-volume", "journal"),
		journalMountPoint: join(root, "journal-volume"),
		nasRoot: join(root, "nas-parent", "nas", "objects"),
		nasMountPoint: join(root, "nas-parent", "nas"),
		nasSource: "192.0.2.90:/recovery-test",
	};
	await mkdir(config.journalRoot, { recursive: true, mode: 0o700 });
	const journalMount: RecoveryDirectoryMount = {
		mountPoint: config.journalMountPoint,
		root: "/",
		filesystem: "ext4",
		source: "/dev/fixture-disk",
	};
	const nasMount: RecoveryDirectoryMount = {
		mountPoint: config.nasMountPoint,
		root: "/",
		filesystem: "nfs4",
		source: config.nasSource,
	};
	return { config, journalMount, nasMount };
}

describe("descriptor-bound recovery mount parsing", () => {
	const table =
		"10 1 8:1 / / rw - ext4 /dev/root rw\n" +
		"42 10 0:40 / /mnt/private\\040nas rw,relatime shared:1 - nfs4 192.0.2.90:/recovery rw\n";

	it("uses the opened descriptor's mount ID, not longest pathname matching", () => {
		expect(parseRecoveryDirectoryMount(table, "pos:\t0\nflags:\t0300000\nmnt_id:\t42\nino:\t123\n")).toEqual({
			root: "/",
			mountPoint: "/mnt/private nas",
			filesystem: "nfs4",
			source: "192.0.2.90:/recovery",
		});
		expect(parseRecoveryDirectoryMount(table, "mnt_id:\t10\n").filesystem).toBe("ext4");
	});

	it.each([
		["", "mnt_id:\t42\n"],
		[table, ""],
		[table, "mnt_id:\t0\n"],
		[table, "mnt_id:\t42\nmnt_id:\t10\n"],
		[table + table, "mnt_id:\t42\n"],
		["42 10 0:40 / /mnt/nas rw", "mnt_id:\t42\n"],
		["42 10 0:40 / /mnt/nas rw - nfs4", "mnt_id:\t42\n"],
		["42 10 0:40 / /mnt/\\012nas rw - nfs4 host:/export rw", "mnt_id:\t42\n"],
		["42 10 0:40 / /mnt/\\999nas rw - nfs4 host:/export rw", "mnt_id:\t42\n"],
		["x".repeat(1_048_577), "mnt_id:\t42\n"],
		[table, "x".repeat(4097)],
	])("rejects unavailable, malformed, ambiguous or oversized metadata (%#)", (mounts, descriptor) => {
		expect(() => parseRecoveryDirectoryMount(mounts, descriptor)).toThrow();
	});
});

describe("independent recovery filesystem startup", () => {
	it("starts with no NAS directory, while keeping the journal usable", async () => {
		const { config, journalMount } = await fixture();
		const inspect = vi.fn(async () => journalMount);
		const { journal, nas } = await openRecoveryFilesystems(config, inspect);
		expect(inspect).toHaveBeenCalledTimes(1);
		const address = "a".repeat(64);
		const bytes = Buffer.from("synthetic private journal");
		expect(await journal.put(address, bytes, AbortSignal.timeout(1000))).toEqual(bytes);
		await expect(nas.get(address, AbortSignal.timeout(1000))).rejects.toThrow();
		expect(await journal.get(address, AbortSignal.timeout(1000))).toEqual(bytes);
		// Failed NAS lookup did not even acquire a descriptor for inspection.
		expect(inspect).toHaveBeenCalledTimes(3);
	});

	it("never treats the unmounted local directory as a NAS receipt", async () => {
		const { config, journalMount } = await fixture();
		await mkdir(config.nasRoot, { recursive: true, mode: 0o700 });
		const { nas } = await openRecoveryFilesystems(config, async () => journalMount);
		const address = "b".repeat(64);
		await expect(nas.put(address, Buffer.from("must not be published"), AbortSignal.timeout(1000))).rejects.toThrow(
			"pinned mount",
		);
		await expect(readFile(join(config.nasRoot, address))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("validates the exact export and descriptor again after a mount changes", async () => {
		const { config, journalMount, nasMount } = await fixture();
		await mkdir(config.nasRoot, { recursive: true, mode: 0o700 });
		let current = journalMount;
		const { nas } = await openRecoveryFilesystems(config, async () => current);
		current = nasMount;
		const address = "c".repeat(64);
		const bytes = Buffer.from("synthetic encrypted replica");
		expect(await nas.put(address, bytes, AbortSignal.timeout(1000))).toEqual(bytes);
		for (const change of [
			{ source: "192.0.2.91:/recovery-test" },
			{ filesystem: "ext4" },
			{ mountPoint: config.journalMountPoint },
			{ root: "/different-subtree" },
		]) {
			current = { ...nasMount, ...change };
			await expect(nas.get(address, AbortSignal.timeout(1000))).rejects.toThrow("pinned mount");
		}
		current = nasMount;
		expect(await nas.get(address, AbortSignal.timeout(1000))).toEqual(bytes);
	});

	it("keeps a stalled NAS operation bounded and does not block journal work", async () => {
		const { config, journalMount, nasMount } = await fixture();
		await mkdir(config.nasRoot, { recursive: true, mode: 0o700 });
		let finishNas: ((mount: RecoveryDirectoryMount) => void) | undefined;
		const stalled = new Promise<RecoveryDirectoryMount>((resolveMount) => {
			finishNas = resolveMount;
		});
		const inspect = vi
			.fn(async () => journalMount)
			.mockImplementationOnce(async () => journalMount)
			.mockImplementationOnce(() => stalled);
		const { journal, nas } = await openRecoveryFilesystems(config, inspect, 30);
		const address = "d".repeat(64);
		try {
			await expect(nas.get(address, AbortSignal.timeout(1000))).rejects.toThrow();
			await expect(nas.get(address, AbortSignal.timeout(1000))).rejects.toThrow("outstanding");
			expect(await journal.get(address, AbortSignal.timeout(1000))).toBeUndefined();
			expect(inspect).toHaveBeenCalledTimes(3);
		} finally {
			finishNas?.(nasMount);
			await stalled;
		}
	});

	it.each([
		{ filesystem: "nfs4" },
		{ filesystem: "tmpfs" },
		{ filesystem: "overlay" },
		{ root: "/ordinary-directory" },
		{ mountPoint: "/" },
	])("rejects a missing, remote or disposable journal mount (%j)", async (change) => {
		const { config, journalMount } = await fixture();
		await expect(openRecoveryFilesystems(config, async () => ({ ...journalMount, ...change }))).rejects.toThrow(
			"persistent local filesystem",
		);
	});

	it.each([
		{ journalRoot: "/" },
		{ journalRoot: "relative" },
		{ journalRoot: "/a/../b" },
		{ nasRoot: "/not-the-nas/objects" },
		{ nasSource: "" },
		{ nasSource: "arbitrary path" },
		{ journalMountPoint: "/" },
		{ nasMountPoint: "/" },
		{ extra: true },
	])("rejects invalid filesystem configuration before I/O (%j)", async (change) => {
		const { config, journalMount } = await fixture();
		const inspect = vi.fn(async () => journalMount);
		await expect(openRecoveryFilesystems({ ...config, ...change }, inspect)).rejects.toThrow();
		expect(inspect).not.toHaveBeenCalled();
	});

	it("rejects overlapping journal and NAS mounts", async () => {
		const { config, journalMount } = await fixture();
		for (const nasMountPoint of [config.journalMountPoint, join(config.journalMountPoint, "nas")]) {
			await expect(
				openRecoveryFilesystems(
					{
						...config,
						nasMountPoint,
						nasRoot: join(nasMountPoint, "objects"),
					},
					async () => journalMount,
				),
			).rejects.toThrow("separate");
		}
	});
});
