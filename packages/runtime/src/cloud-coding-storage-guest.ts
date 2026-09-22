import { type BigIntStats, constants } from "node:fs";
import { type FileHandle, lstat, mkdir, open } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { type CloudCodingStorageBinding, parseCloudCodingStorageBinding } from "@qorpera/contracts";
import { type CodingGuestConfiguration, parseCodingGuestConfiguration } from "./cloud-coding-guest-configuration.ts";

const CONFIG = "/etc/qorpera-coding/storage.json";
const MARKER = ".qorpera-volume.json";
const DATA = "/workspace";
const CUSTODY = "/var/lib/qorpera-coding";
const O_PATH = 0x200000;
interface Mount {
	id: number;
	root: string;
	target: string;
	filesystem: string;
	source: string;
	options: string[];
	superOptions: string[];
}
function mounts(input: string): Mount[] {
	if (!input || Buffer.byteLength(input) > 1048576) throw new Error("CODING_GUEST_STORAGE_MOUNT_INVALID");
	const decode = (value: string) => {
		const result = value.replace(/\\(040|011|012|134)/g, (_, octal: string) =>
			String.fromCharCode(Number.parseInt(octal, 8)),
		);
		if (/[\x00-\x20\x7f\\]/.test(result)) throw new Error("CODING_GUEST_STORAGE_MOUNT_INVALID");
		return result;
	};
	const seen = new Set<number>();
	return input
		.trim()
		.split("\n")
		.map((line) => {
			const fields = line.split(" "),
				separator = fields.indexOf("-"),
				id = Number(fields[0]);
			if (
				!/^[1-9][0-9]*$/.test(fields[0]) ||
				!Number.isSafeInteger(id) ||
				seen.has(id) ||
				separator < 6 ||
				fields.length !== separator + 4 ||
				fields.some((field) => !field)
			)
				throw new Error("CODING_GUEST_STORAGE_MOUNT_INVALID");
			seen.add(id);
			return {
				id,
				root: decode(fields[3]),
				target: decode(fields[4]),
				filesystem: fields[separator + 1],
				source: decode(fields[separator + 2]),
				options: fields[5].split(","),
				superOptions: fields[separator + 3].split(","),
			};
		});
}
function mounted(entries: Mount[], target: string, filesystem: string, noDescendants = true): number {
	const matches = entries.filter((entry) => entry.target === target);
	if (matches.length !== 1 || (noDescendants && entries.some((entry) => entry.target.startsWith(`${target}/`))))
		throw new Error("CODING_GUEST_STORAGE_MOUNT_INVALID");
	const mount = matches[0];
	if (
		mount.root !== "/" ||
		mount.filesystem !== filesystem ||
		[mount.options, mount.superOptions].some(
			(options) => options.filter((option) => option === "rw").length !== 1 || options.includes("ro"),
		)
	)
		throw new Error("CODING_GUEST_STORAGE_MOUNT_INVALID");
	return mount.id;
}
/** Kernel observation only. Host admission separately pins NFS identity and
 * excludes every previous writer; virtiofs does not expose the NFS server. */
export function assertCodingGuestMounts(mountInfo: string): Readonly<Record<string, number>> {
	const entries = mounts(mountInfo);
	return Object.freeze({
		[DATA]: mounted(entries, DATA, "virtiofs"),
		[CUSTODY]: mounted(entries, CUSTODY, "virtiofs"),
	});
}
async function readBounded(handle: FileHandle, maximum: number): Promise<Buffer> {
	const bytes = Buffer.alloc(maximum + 1);
	let length = 0;
	while (length < bytes.length) {
		const read = await handle.read(bytes, length, bytes.length - length, null);
		if (!read.bytesRead) break;
		length += read.bytesRead;
	}
	if (length > maximum) throw new Error("CODING_GUEST_STORAGE_METADATA_TOO_LARGE");
	return bytes.subarray(0, length);
}
async function metadata(path: string, maximum: number): Promise<string> {
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		return new TextDecoder("utf8", { fatal: true }).decode(await readBounded(handle, maximum));
	} finally {
		await handle.close();
	}
}
function same(a: BigIntStats, b: BigIntStats): boolean {
	return a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.gid === b.gid && a.mode === b.mode;
}
async function readConfiguration(path: string, uid = 0n, gid: bigint | undefined = 0n): Promise<unknown> {
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const before = await handle.stat({ bigint: true });
		if (
			!before.isFile() ||
			before.uid !== uid ||
			(gid !== undefined && before.gid !== gid) ||
			before.nlink !== 1n ||
			(before.mode & 0o7777n) !== 0o444n ||
			before.size < 1n ||
			before.size > 8192n
		)
			throw new Error("CODING_GUEST_STORAGE_CONFIGURATION_UNPROTECTED");
		const bytes = await readBounded(handle, 8192),
			after = await handle.stat({ bigint: true });
		if (
			BigInt(bytes.length) !== before.size ||
			!same(before, after) ||
			after.nlink !== 1n ||
			before.size !== after.size ||
			before.ctimeNs !== after.ctimeNs ||
			before.mtimeNs !== after.mtimeNs ||
			!same(after, await lstat(path, { bigint: true }))
		)
			throw new Error("CODING_GUEST_STORAGE_CONFIGURATION_CHANGED");
		return JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
	} finally {
		await handle.close();
	}
}
interface Root {
	path: string;
	handle: FileHandle;
	identity: BigIntStats;
	mountId: number;
}
async function checkRoot(
	root: Root,
	guest: CodingGuestConfiguration,
	binding: CloudCodingStorageBinding,
): Promise<void> {
	const expected = assertCodingGuestMounts(await metadata("/proc/self/mountinfo", 1048576));
	const fdInfo = await metadata(`/proc/self/fdinfo/${root.handle.fd}`, 4096);
	const ids = [...fdInfo.matchAll(/^mnt_id:\s+([1-9][0-9]*)$/gm)];
	const stat = await root.handle.stat({ bigint: true }),
		visible = await lstat(root.path, { bigint: true });
	if (
		!stat.isDirectory() ||
		stat.uid === BigInt(guest.uid) ||
		(stat.mode & 0o7777n) !== 0o755n ||
		!same(stat, visible) ||
		!same(stat, root.identity) ||
		ids.length !== 1 ||
		Number(ids[0][1]) !== expected[root.path] ||
		expected[root.path] !== root.mountId
	)
		throw new Error("CODING_GUEST_STORAGE_ROOT_UNPROTECTED");
	const marker = await readConfiguration(`/proc/self/fd/${root.handle.fd}/${MARKER}`, stat.uid, stat.gid);
	if (!isDeepStrictEqual(parseCloudCodingStorageBinding(marker), binding))
		throw new Error("CODING_GUEST_STORAGE_BINDING_CHANGED");
}
async function inspect(
	guest: CodingGuestConfiguration,
): Promise<{ binding: CloudCodingStorageBinding; roots: Root[] }> {
	if (process.platform !== "linux") throw new Error("CODING_GUEST_STORAGE_LINUX_REQUIRED");
	if (
		guest.workspacePath !== `${DATA}/repository` ||
		guest.homePath !== `${DATA}/home` ||
		guest.cachePath !== `${DATA}/cache` ||
		guest.outputRoot !== `${CUSTODY}/logs`
	)
		throw new Error("CODING_GUEST_STORAGE_PATHS_CHANGED");
	for (const path of ["/", "/etc", "/etc/qorpera-coding", "/var", "/var/lib"]) {
		const stat = await lstat(path, { bigint: true });
		if (!stat.isDirectory() || stat.uid !== 0n || (stat.mode & 0o022n) !== 0n)
			throw new Error("CODING_GUEST_STORAGE_CONFIGURATION_UNPROTECTED");
	}
	const binding = parseCloudCodingStorageBinding(await readConfiguration(CONFIG));
	if (binding.workerId !== guest.workerId) throw new Error("CODING_GUEST_STORAGE_SCOPE_CHANGED");
	const observed = assertCodingGuestMounts(await metadata("/proc/self/mountinfo", 1048576)),
		roots: Root[] = [];
	try {
		for (const path of [DATA, CUSTODY]) {
			const handle = await open(path, O_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW);
			let identity: BigIntStats;
			try {
				identity = await handle.stat({ bigint: true });
			} catch (error) {
				await handle.close();
				throw error;
			}
			const root = { path, handle, identity, mountId: observed[path] };
			roots.push(root);
			await checkRoot(root, guest, binding);
		}
		return { binding, roots };
	} catch (error) {
		await Promise.allSettled(roots.map((root) => root.handle.close()));
		throw error;
	}
}
export async function assertCloudCodingGuestStorage(guest: CodingGuestConfiguration): Promise<void> {
	const { roots } = await inspect(guest);
	await Promise.all(roots.map((root) => root.handle.close()));
}
async function initializeChild(
	parent: FileHandle,
	name: string,
	uid: number,
	gid: number,
	check: () => Promise<void>,
): Promise<void> {
	await check();
	const path = `/proc/self/fd/${parent.fd}/${name}`;
	let created = false;
	try {
		await mkdir(path, { mode: 0o755 });
		created = true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try {
		await check();
		const before = await handle.stat({ bigint: true });
		if (!before.isDirectory() || (before.mode & 0o022n) !== 0n || !same(before, await lstat(path, { bigint: true })))
			throw new Error("CODING_GUEST_STORAGE_DIRECTORY_UNPROTECTED");
		if (created) {
			if (before.uid !== 0n || before.gid !== 0n) throw new Error("CODING_GUEST_STORAGE_DIRECTORY_UNPROTECTED");
			await handle.chown(uid, gid);
		}
		const after = await handle.stat({ bigint: true });
		if (
			after.uid !== BigInt(uid) ||
			after.gid !== BigInt(gid) ||
			(after.mode & 0o022n) !== 0n ||
			before.ino !== after.ino ||
			before.dev !== after.dev ||
			!same(after, await lstat(path, { bigint: true }))
		)
			throw new Error("CODING_GUEST_STORAGE_DIRECTORY_UNPROTECTED");
		await handle.sync();
		const directory = await open(`/proc/self/fd/${parent.fd}`, constants.O_RDONLY | constants.O_DIRECTORY);
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
		await check();
	} finally {
		await handle.close();
	}
}
/** Fixed root bootstrap. Descriptor-relative effects stay on the verified
 * filesystem if a pathname mount disappears. No existing ownership repairs. */
export async function initializeCloudCodingGuestStorage(): Promise<void> {
	if (process.getuid?.() !== 0) throw new Error("CODING_GUEST_STORAGE_ROOT_REQUIRED");
	const guest = parseCodingGuestConfiguration(await readConfiguration("/etc/qorpera-coding/guest.json"));
	const { binding, roots } = await inspect(guest);
	try {
		for (const root of roots) {
			const check = () => checkRoot(root, guest, binding);
			const children =
				root.path === DATA
					? ([
							["repository", guest.uid, guest.gid],
							["home", guest.uid, guest.gid],
							["cache", guest.uid, guest.gid],
						] as const)
					: ([
							["logs", guest.uid, guest.gid],
							["inbox", 0, 0],
							["commands", 0, 0],
							["git", 0, 0],
						] as const);
			for (const [name, uid, gid] of children) await initializeChild(root.handle, name, uid, gid, check);
		}
		const run = await open("/run", O_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW);
		try {
			const original = await run.stat({ bigint: true });
			const check = async () => {
				const entries = mounts(await metadata("/proc/self/mountinfo", 1048576));
				const expected = mounted(entries, "/run", "tmpfs", false);
				if (
					entries.some(
						(entry) => entry.target === "/run/qorpera-coding" || entry.target.startsWith("/run/qorpera-coding/"),
					)
				)
					throw new Error("CODING_GUEST_STORAGE_RUNTIME_UNPROTECTED");
				const info = await run.stat({ bigint: true }),
					ids = [...(await metadata(`/proc/self/fdinfo/${run.fd}`, 4096)).matchAll(/^mnt_id:\s+([1-9][0-9]*)$/gm)];
				if (
					!info.isDirectory() ||
					info.uid !== 0n ||
					(info.mode & 0o022n) !== 0n ||
					!same(original, info) ||
					!same(info, await lstat("/run", { bigint: true })) ||
					ids.length !== 1 ||
					Number(ids[0][1]) !== expected
				)
					throw new Error("CODING_GUEST_STORAGE_RUNTIME_UNPROTECTED");
			};
			await initializeChild(run, "qorpera-coding", 0, 0, check);
		} finally {
			await run.close();
		}
		for (const root of roots) await checkRoot(root, guest, binding);
	} finally {
		await Promise.allSettled(roots.map((root) => root.handle.close()));
	}
}
