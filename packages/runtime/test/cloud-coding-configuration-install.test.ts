import { randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCloudCodingStorageBinding } from "@qorpera/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
	installCloudCodingGuestConfiguration,
	prepareCloudCodingGuestSession,
} from "../src/cloud-coding-configuration-install.ts";
import {
	type CodingGuestConfiguration,
	DEFAULT_CODING_GUEST_RESOURCES,
} from "../src/cloud-coding-guest-configuration.ts";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "coding-configuration-")));
	directories.push(directory);
	await chmod(directory, 0o700);
	const workerId = randomUUID();
	const guest: CodingGuestConfiguration = {
		schema: "qorpera.coding-command-guest/v4",
		workerId,
		vmId: randomUUID(),
		bootId: randomUUID(),
		uid: 200000,
		gid: 200000,
		workspacePath: `/workspace/${workerId}/repository`,
		homePath: `/workspace/${workerId}/home`,
		cachePath: `/workspace/${workerId}/cache`,
		outputRoot: `/var/lib/qorpera-coding/${workerId}/logs`,
		resourceProfile: { ...DEFAULT_CODING_GUEST_RESOURCES },
	};
	const storage = createCloudCodingStorageBinding(
		{
			schema: "qorpera.coding-nas-policy/v1",
			mountPoint: "/nas",
			rootPath: "/nas/coding",
			source: "10.0.0.2:/coding",
			serverAddress: "10.0.0.2",
		},
		{
			workerId: guest.workerId,
			companyId: randomUUID(),
			environmentId: randomUUID(),
			writerGeneration: 1,
			machineIdSha256: "a".repeat(64),
		},
	);
	const packet = { schema: "qorpera.coding-configuration-install/v1", guest, storage };
	let bootId = guest.bootId;
	const write = async (name: string, value: unknown) => {
		await unlink(join(directory, name)).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
		});
		await writeFile(join(directory, name), JSON.stringify(value), { flag: "wx", mode: 0o444 });
		await chmod(join(directory, name), 0o444);
	};
	await write("configuration-inbox.json", packet);
	return {
		directory,
		guest,
		storage,
		packet,
		write,
		read: async (name: string) => JSON.parse(await readFile(join(directory, name), "utf8")),
		boot: (value: string) => {
			bootId = value;
		},
		install: (session = guest.workerId) =>
			installCloudCodingGuestConfiguration(session, {
				configurationRoot: directory,
				protectedUid: process.getuid?.(),
				protectedGid: process.getgid?.(),
				readBootId: async () => bootId,
			}),
	};
}
describe.runIf(process.platform === "linux")("protected guest configuration crash recovery", () => {
	it("installs exact protected files and leaves current-boot inodes unchanged on retry", async () => {
		const f = await fixture();
		await f.install();
		const before = await lstat(join(f.directory, "guest.json"));
		await f.install();
		expect(await f.read("guest.json")).toEqual(f.guest);
		expect(await f.read("storage.json")).toEqual(f.storage);
		expect(await f.read(`configuration-${f.guest.bootId}.json`)).toEqual(f.packet);
		const after = await lstat(join(f.directory, "guest.json"));
		expect(after.ino).toBe(before.ino);
		expect(after.mode & 0o7777).toBe(0o444);
		expect(after.nlink).toBe(1);
	});
	it.each(["claim", "storage", "guest"])("resumes after a crash that published %s only", async (phase) => {
		const f = await fixture();
		await f.write(`configuration-${f.guest.bootId}.json`, f.packet);
		if (phase !== "claim") await f.write("storage.json", f.storage);
		if (phase === "guest") await f.write("guest.json", f.guest);
		await f.install();
		expect(await f.read("guest.json")).toEqual(f.guest);
		expect(await f.read("storage.json")).toEqual(f.storage);
	});
	it.each(["claim", "storage", "guest"])(
		"recovers an interrupted atomic hardlink publication of %s",
		async (phase) => {
			const f = await fixture();
			const name = phase === "claim" ? `configuration-${f.guest.bootId}.json` : `${phase}.json`;
			await f.write(name, phase === "claim" ? f.packet : phase === "storage" ? f.storage : f.guest);
			const temporary = join(f.directory, `.configuration-${randomUUID()}.tmp`);
			await link(join(f.directory, name), temporary);
			await f.install();
			expect((await lstat(join(f.directory, name))).nlink).toBe(1);
			await expect(lstat(temporary)).rejects.toMatchObject({ code: "ENOENT" });
			expect(await f.read("guest.json")).toEqual(f.guest);
		},
	);
	it("installs only a packet for the session it was run for", async () => {
		const f = await fixture();
		await expect(f.install(randomUUID())).rejects.toThrow("SCOPE_CHANGED");
		await expect(lstat(join(f.directory, "guest.json"))).rejects.toMatchObject({ code: "ENOENT" });
	});
	it("rejects a conflicting claim without installing active files", async () => {
		const f = await fixture();
		await f.write(`configuration-${f.guest.bootId}.json`, { ...f.packet, guest: { ...f.guest, uid: 200001 } });
		await expect(f.install()).rejects.toThrow("CLAIM_CHANGED");
		await expect(lstat(join(f.directory, "guest.json"))).rejects.toMatchObject({ code: "ENOENT" });
	});
	it("only advances boot identity, keeps storage immutable and does not poison a rejected new boot", async () => {
		const f = await fixture();
		await f.install();
		const before = await lstat(join(f.directory, "storage.json"));
		const nextBoot = randomUUID();
		f.boot(nextBoot);
		await f.write("configuration-inbox.json", { ...f.packet, guest: { ...f.guest, bootId: nextBoot, uid: 200001 } });
		await expect(f.install()).rejects.toThrow("GUEST_CHANGED");
		await expect(lstat(join(f.directory, `configuration-${nextBoot}.json`))).rejects.toMatchObject({
			code: "ENOENT",
		});
		await f.write("configuration-inbox.json", { ...f.packet, guest: { ...f.guest, bootId: nextBoot } });
		await f.install();
		expect(await f.read("guest.json")).toEqual({ ...f.guest, bootId: nextBoot });
		expect((await lstat(join(f.directory, "storage.json"))).ino).toBe(before.ino);
	});
	it("refuses a stale boot before publication", async () => {
		const f = await fixture();
		f.boot(randomUUID());
		await expect(f.install()).rejects.toThrow("BOOT_CHANGED");
		await expect(lstat(join(f.directory, "storage.json"))).rejects.toMatchObject({ code: "ENOENT" });
	});
	it("never repairs a current configuration's permissions", async () => {
		const f = await fixture();
		await f.install();
		await chmod(join(f.directory, "guest.json"), 0o644);
		await expect(f.install()).rejects.toThrow("FILE_UNPROTECTED");
		expect((await lstat(join(f.directory, "guest.json"))).mode & 0o7777).toBe(0o644);
	});
	it("refuses a symlink and arbitrary hardlink instead of repairing them", async () => {
		const f = await fixture();
		await f.write("unexpected.json", f.guest);
		await symlink("unexpected.json", join(f.directory, "guest.json"));
		await expect(f.install()).rejects.toMatchObject({ code: "ELOOP" });
		await unlink(join(f.directory, "guest.json"));
		await link(join(f.directory, "unexpected.json"), join(f.directory, "guest.json"));
		await expect(f.install()).rejects.toThrow("FILE_UNPROTECTED");
		expect((await lstat(join(f.directory, "unexpected.json"))).nlink).toBe(2);
	});
	it("refuses changed storage before claiming a new boot", async () => {
		const f = await fixture();
		await f.install();
		const nextBoot = randomUUID();
		f.boot(nextBoot);
		await f.write("configuration-inbox.json", {
			...f.packet,
			guest: { ...f.guest, bootId: nextBoot },
			storage: { ...f.storage, machineIdSha256: "b".repeat(64) },
		});
		await expect(f.install()).rejects.toThrow("STORAGE_CHANGED");
		await expect(lstat(join(f.directory, `configuration-${nextBoot}.json`))).rejects.toMatchObject({
			code: "ENOENT",
		});
	});
});
it.runIf(process.getuid?.() !== 0)("the fixed installer requires root before touching guest paths", async () => {
	await expect(installCloudCodingGuestConfiguration(randomUUID())).rejects.toThrow("ROOT_REQUIRED");
	await expect(prepareCloudCodingGuestSession(randomUUID())).rejects.toThrow("ROOT_REQUIRED");
});
