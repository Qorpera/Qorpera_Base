import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CloudCodingNasPolicy, createCloudCodingStorageBinding } from "@qorpera/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { CODING_STORAGE_MARKER, createCodingNasStorage } from "../src/coding-storage.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const linux = process.platform === "linux" && !!process.geteuid?.();
async function fixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "coding-storage-test-")));
	roots.push(root);
	const policy: CloudCodingNasPolicy = {
		schema: "qorpera.coding-nas-policy/v1",
		mountPoint: root,
		rootPath: root,
		source: "10.0.0.2:/coding",
		serverAddress: "10.0.0.2",
	};
	const binding = createCloudCodingStorageBinding(policy, {
		workerId: "00000000-0000-4000-8000-000000000001",
		companyId: "00000000-0000-4000-8000-000000000002",
		environmentId: "00000000-0000-4000-8000-000000000003",
		writerGeneration: 1,
		machineIdSha256: "a".repeat(64),
	});
	let mountInfo = `42 1 0:44 / ${root} rw,nosuid,nodev - nfs4 10.0.0.2:/coding rw,vers=4.1,hard,proto=tcp,addr=10.0.0.2\n`;
	let wait: Promise<void> | undefined;
	const storage = createCodingNasStorage(policy, {
		readMountMetadata: async () => {
			await wait;
			return { mountInfo, fdInfo: "mnt_id:\t42\n" };
		},
	});
	return {
		root,
		policy,
		binding,
		storage,
		setMount: (value: string) => {
			mountInfo = value;
		},
		getMount: () => mountInfo,
		pause: (value: Promise<void>) => {
			wait = value;
		},
	};
}
describe("coding NAS physical custody", () => {
	it("rejects an unbound root outside the pinned mount", () => {
		expect(() =>
			createCodingNasStorage({
				schema: "qorpera.coding-nas-policy/v1",
				mountPoint: "/nas",
				rootPath: "/local",
				source: "10.0.0.2:/coding",
				serverAddress: "10.0.0.2",
			}),
		).toThrow();
	});
	it.runIf(linux)("provisions only deterministic protected roots and immutable exact markers", async () => {
		const f = await fixture();
		await f.storage.prepare(f.binding);
		await f.storage.assert(f.binding);
		for (const directory of [f.binding.dataSource, f.binding.custodySource]) {
			expect((await stat(directory)).mode & 0o7777).toBe(0o755);
			const marker = join(directory, CODING_STORAGE_MARKER);
			expect((await stat(marker)).mode & 0o7777).toBe(0o444);
			expect(JSON.parse(await readFile(marker, "utf8"))).toEqual(f.binding);
		}
		expect(await f.storage.prepareControl()).toBe(join(f.root, "control"));
		await f.storage.assertControl();
		expect((await stat(f.storage.controlPath)).mode & 0o7777).toBe(0o700);
		await f.storage.prepare(f.binding);
		await expect(f.storage.prepare({ ...f.binding, writerGeneration: 2 })).rejects.toThrow("BINDING_CHANGED");
	});
	it.runIf(linux)("never creates local fallback when NFS disappears or changes policy", async () => {
		const f = await fixture();
		for (const changed of [
			f.getMount().replace("nfs4", "ext4"),
			f.getMount().replace("hard", "soft"),
			f.getMount().replace("addr=10.0.0.2", "addr=10.0.0.9"),
			f.getMount().replace("nosuid,", ""),
		]) {
			f.setMount(changed);
			await expect(f.storage.prepare(f.binding)).rejects.toThrow();
		}
		await expect(stat(join(f.root, "workers"))).rejects.toMatchObject({ code: "ENOENT" });
	});
	it.runIf(linux)("refuses symlink descendants without following them", async () => {
		const f = await fixture();
		const outside = join(f.root, "outside");
		await mkdir(outside, { mode: 0o700 });
		await symlink(outside, join(f.root, "workers"));
		await expect(f.storage.prepare(f.binding)).rejects.toThrow();
		await expect(stat(join(outside, f.binding.companyId))).rejects.toMatchObject({ code: "ENOENT" });
	});
	it.runIf(linux)("rejects broadened existing permissions and changed marker bytes", async () => {
		const f = await fixture();
		await f.storage.prepare(f.binding);
		await chmod(f.binding.dataSource, 0o777);
		await expect(f.storage.prepare(f.binding)).rejects.toThrow("DIRECTORY_UNPROTECTED");
		await chmod(f.binding.dataSource, 0o755);
		const marker = join(f.binding.custodySource, CODING_STORAGE_MARKER);
		await chmod(marker, 0o600);
		await writeFile(marker, (await readFile(marker, "utf8")).replace('"writerGeneration":1', '"writerGeneration":2'));
		await chmod(marker, 0o444);
		await expect(f.storage.assert(f.binding)).rejects.toThrow("BINDING_CHANGED");
	});
	it.runIf(linux)("keeps unresolved IO pending and refuses a second operation", async () => {
		const f = await fixture();
		let release = () => {};
		f.pause(
			new Promise<void>((resolve) => {
				release = resolve;
			}),
		);
		const first = f.storage.prepareControl();
		await expect(f.storage.prepareControl()).rejects.toThrow("IO_PENDING");
		release();
		await first;
	});
	it.runIf(linux)("actual kernel observation rejects a local filesystem before writing", async () => {
		const f = await fixture();
		await expect(createCodingNasStorage(f.policy).prepare(f.binding)).rejects.toThrow();
		await expect(stat(join(f.root, "workers"))).rejects.toMatchObject({ code: "ENOENT" });
	});
});
