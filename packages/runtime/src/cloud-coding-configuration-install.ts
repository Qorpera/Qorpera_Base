import { randomUUID } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { type FileHandle, link, lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { cloudCodingSessionLayout, parseCloudCodingStorageBinding } from "@qorpera/contracts";
import { parseCodingGuestConfiguration } from "./cloud-coding-guest-configuration.ts";

const O_PATH = 0x200000;
export interface CodingConfigurationInstallPorts {
	/** Trusted fixture hooks. Fixed CLI never accepts these from its packet. */
	configurationRoot?: string;
	protectedUid?: number;
	protectedGid?: number;
	readBootId?: () => Promise<string>;
}
function same(a: BigIntStats, b: BigIntStats): boolean {
	return a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.gid === b.gid && a.mode === b.mode;
}
async function bytes(handle: FileHandle, maximum: number): Promise<Buffer> {
	const buffer = Buffer.alloc(maximum + 1);
	let length = 0;
	while (length < buffer.length) {
		const read = await handle.read(buffer, length, buffer.length - length, null);
		if (!read.bytesRead) break;
		length += read.bytesRead;
	}
	if (length > maximum) throw new Error("CODING_CONFIGURATION_TOO_LARGE");
	return buffer.subarray(0, length);
}
function missing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Creates the session's boot-local configuration folder before its packet is
 * staged: root-owned, not writable by anyone else, never a link. Existing
 * folders are checked, never repaired. */
export async function prepareCloudCodingGuestSession(workerId: string): Promise<void> {
	if (process.platform !== "linux" || process.getuid?.() !== 0) throw new Error("CODING_CONFIGURATION_ROOT_REQUIRED");
	const layout = cloudCodingSessionLayout(workerId);
	for (const path of [dirname(layout.runtimeRoot), layout.runtimeRoot, layout.configurationRoot]) {
		await mkdir(path, { mode: 0o755 }).catch((error) => {
			if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
		});
		const info = await lstat(path, { bigint: true });
		if (!info.isDirectory() || info.uid !== 0n || info.gid !== 0n || (info.mode & 0o7022n) !== 0n)
			throw new Error("CODING_CONFIGURATION_PATH_UNPROTECTED");
	}
}

/** Resumes exact protected installation across crashes. The per-boot immutable
 * claim excludes conflicting packets before either active config is written.
 * Existing current-boot files are compared, never repaired; storage identity
 * cannot change even across boots. No packet field selects a filesystem path:
 * the folder is the session's own (cloudCodingSessionLayout), and the packet
 * must name that session. */
export async function installCloudCodingGuestConfiguration(
	workerId: string,
	ports: CodingConfigurationInstallPorts = {},
): Promise<void> {
	if (!ports.readBootId && (process.platform !== "linux" || process.getuid?.() !== 0))
		throw new Error("CODING_CONFIGURATION_ROOT_REQUIRED");
	const root = ports.configurationRoot ?? cloudCodingSessionLayout(workerId).configurationRoot,
		uid = BigInt(ports.protectedUid ?? 0),
		gid = BigInt(ports.protectedGid ?? 0);
	if ((await realpath(root)) !== root) throw new Error("CODING_CONFIGURATION_PATH_UNPROTECTED");
	if (!ports.configurationRoot) {
		let parent = dirname(root);
		for (;;) {
			const info = await lstat(parent, { bigint: true });
			if (!info.isDirectory() || info.uid !== 0n || (info.mode & 0o022n) !== 0n)
				throw new Error("CODING_CONFIGURATION_PATH_UNPROTECTED");
			if (parent === "/") break;
			parent = dirname(parent);
		}
	}
	const directory = await open(root, O_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try {
		const identity = await directory.stat({ bigint: true });
		if (!identity.isDirectory() || identity.uid !== uid || identity.gid !== gid || (identity.mode & 0o7022n) !== 0n)
			throw new Error("CODING_CONFIGURATION_PATH_UNPROTECTED");
		const stable = async () => {
			if ((await realpath(root)) !== root || !same(identity, await lstat(root, { bigint: true })))
				throw new Error("CODING_CONFIGURATION_PATH_CHANGED");
		};
		const path = (name: string) => `/proc/self/fd/${directory.fd}/${name}`;
		const syncDirectory = async () => {
			const sync = await open(`/proc/self/fd/${directory.fd}`, constants.O_RDONLY | constants.O_DIRECTORY);
			try {
				await sync.sync();
			} finally {
				await sync.close();
			}
		};
		// link() publishes complete bytes without replacing a winner. If the
		// process dies before unlinking its temporary name, recover only that
		// same protected inode; arbitrary hard links remain a refusal.
		const recoverPublishedLink = async (handle: FileHandle, expected: BigIntStats) => {
			const names = await readdir(`/proc/self/fd/${directory.fd}`);
			if (names.length > 4096) throw new Error("CODING_CONFIGURATION_DIRECTORY_TOO_LARGE");
			for (const name of names) {
				if (
					!/^\.configuration-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/.test(name)
				)
					continue;
				let candidate: BigIntStats;
				try {
					candidate = await lstat(path(name), { bigint: true });
				} catch (error) {
					if (missing(error)) continue;
					throw error;
				}
				if (!same(expected, candidate) || !candidate.isFile()) continue;
				await stable();
				await unlink(path(name)).catch((error) => {
					if (!missing(error)) throw error;
				});
				await syncDirectory();
			}
			const after = await handle.stat({ bigint: true });
			if (!same(expected, after) || after.nlink !== 1n || after.size !== expected.size)
				throw new Error("CODING_CONFIGURATION_FILE_UNPROTECTED");
		};
		const read = async (name: string): Promise<unknown> => {
			await stable();
			const handle = await open(path(name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
			try {
				const before = await handle.stat({ bigint: true });
				if (
					!before.isFile() ||
					before.uid !== uid ||
					before.gid !== gid ||
					(before.nlink !== 1n && before.nlink !== 2n) ||
					(before.mode & 0o7777n) !== 0o444n ||
					before.size < 1n ||
					before.size > 16384n
				)
					throw new Error("CODING_CONFIGURATION_FILE_UNPROTECTED");
				const value = await bytes(handle, 16384),
					after = await handle.stat({ bigint: true });
				if (
					BigInt(value.length) !== before.size ||
					!same(before, after) ||
					before.size !== after.size ||
					after.nlink !== before.nlink ||
					before.ctimeNs !== after.ctimeNs ||
					before.mtimeNs !== after.mtimeNs ||
					!same(after, await lstat(path(name), { bigint: true }))
				)
					throw new Error("CODING_CONFIGURATION_FILE_CHANGED");
				if (after.nlink === 2n) {
					if (name === "configuration-inbox.json") throw new Error("CODING_CONFIGURATION_FILE_UNPROTECTED");
					await recoverPublishedLink(handle, after);
					if (!same(after, await lstat(path(name), { bigint: true })))
						throw new Error("CODING_CONFIGURATION_FILE_CHANGED");
				}
				return JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(value));
			} finally {
				await handle.close();
			}
		};
		const raw = await read("configuration-inbox.json");
		if (
			!raw ||
			typeof raw !== "object" ||
			Array.isArray(raw) ||
			Object.keys(raw).sort().join() !== "guest,schema,storage"
		)
			throw new Error("CODING_CONFIGURATION_PACKET_INVALID");
		const packet = raw as Record<string, unknown>;
		if (packet.schema !== "qorpera.coding-configuration-install/v1")
			throw new Error("CODING_CONFIGURATION_PACKET_INVALID");
		const guest = parseCodingGuestConfiguration(packet.guest),
			storage = parseCloudCodingStorageBinding(packet.storage);
		if (guest.workerId !== workerId || storage.workerId !== workerId)
			throw new Error("CODING_CONFIGURATION_SCOPE_CHANGED");
		const readBootId =
			ports.readBootId ??
			(async () => {
				const handle = await open("/proc/sys/kernel/random/boot_id", constants.O_RDONLY | constants.O_NOFOLLOW);
				try {
					return (await bytes(handle, 64)).toString("utf8").trim();
				} finally {
					await handle.close();
				}
			});
		const checkBoot = async () => {
			await stable();
			if ((await readBootId()) !== guest.bootId) throw new Error("CODING_CONFIGURATION_BOOT_CHANGED");
		};
		const publish = async (name: string, value: unknown, replace = false) => {
			await checkBoot();
			const temporary = path(`.configuration-${randomUUID()}.tmp`),
				handle = await open(
					temporary,
					constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
					0o600,
				);
			try {
				await handle.writeFile(JSON.stringify(value));
				await handle.chmod(0o444);
				await handle.sync();
				await checkBoot();
				if (replace) await rename(temporary, path(name));
				else {
					try {
						await link(temporary, path(name));
					} catch (error) {
						if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
					}
				}
			} finally {
				await handle.close();
				await unlink(temporary).catch((error) => {
					if (!missing(error)) throw error;
				});
			}
			await syncDirectory();
		};
		await checkBoot();
		const claim = `configuration-${guest.bootId}.json`,
			normalized = { schema: packet.schema, guest, storage };
		let oldStorage: unknown;
		try {
			oldStorage = await read("storage.json");
		} catch (error) {
			if (!missing(error)) throw error;
		}
		if (oldStorage !== undefined && !isDeepStrictEqual(parseCloudCodingStorageBinding(oldStorage), storage))
			throw new Error("CODING_CONFIGURATION_STORAGE_CHANGED");
		let oldGuest: unknown;
		try {
			oldGuest = await read("guest.json");
		} catch (error) {
			if (!missing(error)) throw error;
		}
		if (
			oldGuest !== undefined &&
			!isDeepStrictEqual({ ...parseCodingGuestConfiguration(oldGuest), bootId: guest.bootId }, guest)
		)
			throw new Error("CODING_CONFIGURATION_GUEST_CHANGED");
		await publish(claim, normalized);
		if (!isDeepStrictEqual(await read(claim), normalized)) throw new Error("CODING_CONFIGURATION_CLAIM_CHANGED");
		if (oldStorage === undefined) await publish("storage.json", storage);
		if (!isDeepStrictEqual(parseCloudCodingStorageBinding(await read("storage.json")), storage))
			throw new Error("CODING_CONFIGURATION_STORAGE_CHANGED");
		if (oldGuest === undefined) await publish("guest.json", guest);
		else {
			const previous = parseCodingGuestConfiguration(await read("guest.json"));
			if (!isDeepStrictEqual({ ...previous, bootId: guest.bootId }, guest))
				throw new Error("CODING_CONFIGURATION_GUEST_CHANGED");
			if (previous.bootId !== guest.bootId) {
				// Only the unique packet claimed for the kernel's current boot may
				// replace a validated previous boot; concurrent exact retries agree.
				await publish("guest.json", guest, true);
			}
		}
		if (!isDeepStrictEqual(parseCodingGuestConfiguration(await read("guest.json")), guest))
			throw new Error("CODING_CONFIGURATION_GUEST_CHANGED");
		await checkBoot();
	} finally {
		await directory.close();
	}
}
