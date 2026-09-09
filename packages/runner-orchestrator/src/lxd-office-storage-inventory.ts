import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { type FileHandle, lstat, open, opendir, realpath } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { officeCanonical, officeDigest, officeRecord } from "./lxd-office-image-provenance.ts";
import { assertLxdOfficeHostMount } from "./lxd-office-physical-host.ts";
import { type LxdOfficeMountPolicy, officePhysicalPath } from "./lxd-office-physical-policy.ts";

// Linux O_PATH opens the inode without opening a device, FIFO or socket. Only
// a verified directory/regular file is subsequently opened through its fd.
const O_PATH = 0x200000;
const CHUNK = 256 * 1024;
export interface OfficeInventoryLimits {
	maxEntries: number;
	maxDepth: number;
	maxFileBytes: number;
	maxTotalBytes: number;
	maxManifestBytes: number;
}
const maxima: OfficeInventoryLimits = {
	maxEntries: 100000,
	maxDepth: 64,
	maxFileBytes: 16 * 1024 ** 3,
	maxTotalBytes: 64 * 1024 ** 3,
	maxManifestBytes: 16 * 1024 ** 2,
};
export function parseOfficeInventoryLimits(value: unknown): Readonly<OfficeInventoryLimits> {
	const record = officeRecord(value, Object.keys(maxima));
	for (const key of Object.keys(maxima) as (keyof OfficeInventoryLimits)[]) {
		if (!Number.isSafeInteger(record[key]) || (record[key] as number) < 1 || (record[key] as number) > maxima[key])
			throw new Error("INVALID_OFFICE_INVENTORY_LIMITS");
	}
	if ((record.maxFileBytes as number) > (record.maxTotalBytes as number))
		throw new Error("INVALID_OFFICE_INVENTORY_LIMITS");
	return Object.freeze({ ...record }) as unknown as Readonly<OfficeInventoryLimits>;
}

export interface OfficeInventoryEntry {
	readonly path: string;
	readonly kind: "directory" | "file";
	readonly dev: string;
	readonly ino: string;
	readonly uid: number;
	readonly gid: number;
	readonly mode: number;
	readonly mtimeNs: string;
	readonly ctimeNs: string;
	readonly bytes: number;
	readonly sha256: string | null;
}
export interface OfficeStorageInventory {
	readonly schema: "qorpera.office-storage-inventory/v1";
	readonly root: string;
	readonly mountId: string;
	readonly entries: readonly OfficeInventoryEntry[];
	readonly totalBytes: number;
}
export interface OfficeInventorySource {
	readonly root: string;
	readonly uid: number;
	readonly gid: number;
	readonly mount: LxdOfficeMountPolicy;
	readonly serverAddress?: string;
}

function identity(info: BigIntStats) {
	return {
		dev: info.dev.toString(),
		ino: info.ino.toString(),
		uid: Number(info.uid),
		gid: Number(info.gid),
		mode: Number(info.mode & 0o7777n),
		mtimeNs: info.mtimeNs.toString(),
		ctimeNs: info.ctimeNs.toString(),
	};
}
function unchanged(before: BigIntStats, after: BigIntStats): void {
	if (
		!isDeepStrictEqual(identity(before), identity(after)) ||
		before.size !== after.size ||
		before.nlink !== after.nlink
	)
		throw new Error("OFFICE_INVENTORY_CHANGED");
}
async function metadata(path: string, limit: number, signal: AbortSignal): Promise<string> {
	signal.throwIfAborted();
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const bytes = Buffer.alloc(limit + 1);
		let size = 0;
		while (size < bytes.length) {
			signal.throwIfAborted();
			const read = await file.read(bytes, size, bytes.length - size, null);
			if (!read.bytesRead) break;
			size += read.bytesRead;
		}
		signal.throwIfAborted();
		if (size > limit) throw new Error("OFFICE_INVENTORY_METADATA_TOO_LARGE");
		return new TextDecoder("utf8", { fatal: true }).decode(bytes.subarray(0, size));
	} finally {
		await file.close();
	}
}
async function mountId(file: FileHandle, signal: AbortSignal): Promise<string> {
	const info = await metadata(`/proc/self/fdinfo/${file.fd}`, 4096, signal);
	const matches = [...info.matchAll(/^mnt_id:\s+([1-9][0-9]*)$/gm)];
	if (matches.length !== 1) throw new Error("OFFICE_INVENTORY_MOUNT_UNCONFIRMED");
	return matches[0][1];
}
function entryName(name: string): void {
	if (!name || name === "." || name === ".." || /[\x00-\x1f\x7f\\/\ufffd]/.test(name) || Buffer.byteLength(name) > 255)
		throw new Error("OFFICE_INVENTORY_NAME_UNSUPPORTED");
}

/** Read-only, bounded, descriptor-relative inventory. Two identical complete
 * passes are required; neither pass is a snapshot or a writer fence. The
 * provider must independently keep every guest/other NAS writer quiescent.
 * This function returns no file contents and performs no adoption or grant. */
async function inspect(
	input: OfficeInventorySource,
	value: OfficeInventoryLimits,
	signal: AbortSignal,
): Promise<Readonly<OfficeStorageInventory>> {
	if (process.platform !== "linux") throw new Error("OFFICE_INVENTORY_LINUX_REQUIRED");
	const limits = parseOfficeInventoryLimits(value);
	const source = { ...input, mount: { ...input.mount } };
	officePhysicalPath(source.root);
	if (
		!(source.root === source.mount.mountPoint || source.root.startsWith(`${source.mount.mountPoint}/`)) ||
		![source.uid, source.gid].every((id) => Number.isSafeInteger(id) && id > 0 && id < 2 ** 32 - 1)
	)
		throw new Error("INVALID_OFFICE_INVENTORY_SOURCE");
	signal.throwIfAborted();
	const root = await open(source.root, O_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try {
		const rootBefore = await root.stat({ bigint: true });
		if ((rootBefore.mode & 0o7777n) !== 0o700n || (await realpath(source.root)) !== source.root)
			throw new Error("OFFICE_INVENTORY_ROOT_UNPROTECTED");
		unchanged(rootBefore, await lstat(source.root, { bigint: true }));
		const rootMountId = await mountId(root, signal);
		const checkMount = async () => {
			assertLxdOfficeHostMount(
				await metadata("/proc/self/mountinfo", 1048576, signal),
				await metadata(`/proc/self/fdinfo/${root.fd}`, 4096, signal),
				source.mount,
				source.root,
				source.serverAddress,
			);
		};
		await checkMount();
		const scan = async (): Promise<OfficeStorageInventory> => {
			const entries: OfficeInventoryEntry[] = [];
			let totalBytes = 0;
			// Include the complete envelope in the same manifest memory budget.
			let manifestBytes = Buffer.byteLength(
				officeCanonical({
					schema: "qorpera.office-storage-inventory/v1",
					root: source.root,
					mountId: rootMountId,
					entries: [],
					totalBytes: limits.maxTotalBytes,
				}),
			);
			const walk = async (inode: FileHandle, path: string, depth: number): Promise<void> => {
				signal.throwIfAborted();
				if (depth > limits.maxDepth || entries.length >= limits.maxEntries || Buffer.byteLength(path) > 4096)
					throw new Error("OFFICE_INVENTORY_LIMIT_EXCEEDED");
				const before = await inode.stat({ bigint: true });
				if ((!before.isDirectory() && !before.isFile()) || (before.isFile() && before.nlink !== 1n))
					throw new Error("OFFICE_INVENTORY_FILE_TYPE_UNSUPPORTED");
				if (
					before.uid !== BigInt(source.uid) ||
					before.gid !== BigInt(source.gid) ||
					(before.mode & 0o7022n) !== 0n
				)
					throw new Error("OFFICE_INVENTORY_OWNER_OR_MODE_UNSAFE");
				if ((await mountId(inode, signal)) !== rootMountId) throw new Error("OFFICE_INVENTORY_MOUNT_CHANGED");
				const size = before.isFile() ? Number(before.size) : 0;
				if (
					!Number.isSafeInteger(size) ||
					size < 0 ||
					size > limits.maxFileBytes ||
					totalBytes + size > limits.maxTotalBytes
				)
					throw new Error("OFFICE_INVENTORY_LIMIT_EXCEEDED");
				totalBytes += size;
				let sha256: string | null = null;
				if (before.isFile()) {
					// Following this procfs magic link is intentional: its target is
					// the inode already held and verified above, never a path in NAS.
					const file = await open(`/proc/self/fd/${inode.fd}`, constants.O_RDONLY | constants.O_NONBLOCK);
					try {
						unchanged(before, await file.stat({ bigint: true }));
						const hash = createHash("sha256");
						const buffer = Buffer.alloc(Math.min(CHUNK, size + 1));
						let offset = 0;
						while (offset <= size) {
							signal.throwIfAborted();
							const read = await file.read(buffer, 0, Math.min(buffer.length, size - offset + 1), offset);
							if (!read.bytesRead) break;
							offset += read.bytesRead;
							if (offset > size) throw new Error("OFFICE_INVENTORY_CHANGED");
							hash.update(buffer.subarray(0, read.bytesRead));
						}
						if (offset !== size) throw new Error("OFFICE_INVENTORY_CHANGED");
						unchanged(before, await file.stat({ bigint: true }));
						sha256 = hash.digest("hex");
					} finally {
						await file.close();
					}
				}
				const entry: OfficeInventoryEntry = Object.freeze({
					path,
					kind: before.isDirectory() ? "directory" : "file",
					...identity(before),
					bytes: size,
					sha256,
				});
				manifestBytes += Buffer.byteLength(officeCanonical(entry)) + 1;
				if (manifestBytes > limits.maxManifestBytes) throw new Error("OFFICE_INVENTORY_LIMIT_EXCEEDED");
				entries.push(entry);
				if (before.isDirectory()) {
					// Streaming enumeration bounds a single huge directory too.
					const directory = await opendir(`/proc/self/fd/${inode.fd}`, { bufferSize: 32 });
					const names = new Set<string>();
					try {
						while (true) {
							signal.throwIfAborted();
							const next = await directory.read();
							if (!next) break;
							entryName(next.name);
							if (names.has(next.name)) throw new Error("OFFICE_INVENTORY_CHANGED");
							names.add(next.name);
							if (entries.length >= limits.maxEntries) throw new Error("OFFICE_INVENTORY_LIMIT_EXCEEDED");
							const child = await open(`/proc/self/fd/${inode.fd}/${next.name}`, O_PATH | constants.O_NOFOLLOW);
							try {
								await walk(child, path === "." ? next.name : `${path}/${next.name}`, depth + 1);
							} finally {
								await child.close();
							}
						}
					} finally {
						await directory.close();
					}
				}
				unchanged(before, await inode.stat({ bigint: true }));
				signal.throwIfAborted();
			};
			await walk(root, ".", 0);
			entries.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
			return Object.freeze({
				schema: "qorpera.office-storage-inventory/v1",
				root: source.root,
				mountId: rootMountId,
				entries: Object.freeze(entries),
				totalBytes,
			});
		};
		const first = await scan();
		await checkMount();
		const second = await scan();
		await checkMount();
		unchanged(rootBefore, await root.stat({ bigint: true }));
		unchanged(rootBefore, await lstat(source.root, { bigint: true }));
		if ((await realpath(source.root)) !== source.root || officeDigest(first) !== officeDigest(second))
			throw new Error("OFFICE_INVENTORY_CHANGED");
		signal.throwIfAborted();
		return second;
	} finally {
		await root.close();
	}
}

// A hard-NFS syscall can outlive cancellation. Replacement callers, including
// replacement worker objects, remain fenced until that syscall actually ends.
let pending = false;
export async function inspectOfficeStorage(
	input: OfficeInventorySource,
	value: OfficeInventoryLimits,
	caller: AbortSignal,
): Promise<Readonly<OfficeStorageInventory>> {
	caller.throwIfAborted();
	if (pending) throw new Error("OFFICE_INVENTORY_INSPECTION_PENDING");
	pending = true;
	const signal = AbortSignal.any([caller, AbortSignal.timeout(300000)]);
	let abort = () => {};
	const stopped = new Promise<never>((_resolve, reject) => {
		abort = () => reject(new Error("OFFICE_INVENTORY_INSPECTION_ABORTED"));
		signal.addEventListener("abort", abort, { once: true });
	});
	const operation = inspect(input, value, signal).finally(() => {
		pending = false;
	});
	try {
		return await Promise.race([operation, stopped]);
	} finally {
		signal.removeEventListener("abort", abort);
	}
}
