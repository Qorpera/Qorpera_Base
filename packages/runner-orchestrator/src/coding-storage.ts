import { randomUUID } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { type FileHandle, link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import {
	type CloudCodingNasPolicy,
	type CloudCodingStorageBinding,
	parseCloudCodingNasPolicy,
	parseCloudCodingStorageBinding,
} from "@qorpera/contracts";
import { code } from "./lxd-office-journal-files.ts";
import { assertLxdOfficeHostMount } from "./lxd-office-physical-host.ts";

const O_PATH = 0x200000;
export const CODING_STORAGE_MARKER = ".qorpera-volume.json";
export interface CodingNasStorageOptions {
	/** Trusted test transport only. Production always reads kernel proc metadata. */
	readMountMetadata?: (fd: number) => Promise<{ mountInfo: string; fdInfo: string }>;
}
export interface CodingNasStorage {
	readonly controlPath: string;
	prepare(binding: CloudCodingStorageBinding, signal?: AbortSignal): Promise<void>;
	assert(binding: CloudCodingStorageBinding, signal?: AbortSignal): Promise<void>;
	prepareControl(signal?: AbortSignal): Promise<string>;
	assertControl(signal?: AbortSignal): Promise<void>;
}
async function bounded(path: string, maximum: number): Promise<string> {
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const buffer = Buffer.alloc(maximum + 1);
		let length = 0;
		while (length < buffer.length) {
			const read = await handle.read(buffer, length, buffer.length - length, null);
			if (!read.bytesRead) break;
			length += read.bytesRead;
		}
		if (length > maximum) throw new Error("CODING_STORAGE_METADATA_TOO_LARGE");
		return new TextDecoder("utf8", { fatal: true }).decode(buffer.subarray(0, length));
	} finally {
		await handle.close();
	}
}
function same(a: BigIntStats, b: BigIntStats): boolean {
	return a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.gid === b.gid && a.mode === b.mode;
}
async function syncDirectory(handle: FileHandle): Promise<void> {
	const reader = await open(`/proc/self/fd/${handle.fd}`, constants.O_RDONLY | constants.O_DIRECTORY);
	try {
		await reader.sync();
	} finally {
		await reader.close();
	}
}

/** Physical NAS custody only: the caller must independently hold current
 * execution and exclusive writer authority. No local fallback, chmod repair,
 * root-squash workaround, marker retargeting, or storage deletion is provided.
 * Hard-NFS operations remain pending until the kernel settles them; aborting
 * a caller never permits a second operation to race unresolved filesystem IO. */
export function createCodingNasStorage(
	value: CloudCodingNasPolicy,
	options: CodingNasStorageOptions = {},
): CodingNasStorage {
	const policy = parseCloudCodingNasPolicy(value);
	let pending = false;
	const metadata =
		options.readMountMetadata ??
		(async (fd: number) => ({
			mountInfo: await bounded("/proc/self/mountinfo", 1048576),
			fdInfo: await bounded(`/proc/self/fdinfo/${fd}`, 4096),
		}));
	async function execute(
		binding: CloudCodingStorageBinding | undefined,
		create: boolean,
		signal?: AbortSignal,
	): Promise<void> {
		if (process.platform !== "linux" || !process.geteuid?.())
			throw new Error("CODING_STORAGE_UNPRIVILEGED_LINUX_REQUIRED");
		if (pending) throw new Error("CODING_STORAGE_IO_PENDING");
		const parsed = binding === undefined ? undefined : parseCloudCodingStorageBinding(binding);
		if (parsed && !isDeepStrictEqual(parsed.policy, policy)) throw new Error("CODING_STORAGE_POLICY_CHANGED");
		pending = true;
		const handles: FileHandle[] = [];
		const uid = BigInt(process.geteuid!()),
			gid = BigInt(process.getegid!());
		const checkSignal = () => signal?.throwIfAborted();
		let root: FileHandle | undefined;
		let rootIdentity: BigIntStats | undefined;
		const checkMount = async (handle: FileHandle) => {
			checkSignal();
			const observation = await metadata(handle.fd);
			assertLxdOfficeHostMount(
				observation.mountInfo,
				observation.fdInfo,
				{ mountPoint: policy.mountPoint, root: "/", filesystem: "nfs4", source: policy.source },
				policy.rootPath,
				policy.serverAddress,
			);
		};
		const stable = async () => {
			checkSignal();
			if (!root || !rootIdentity) throw new Error("CODING_STORAGE_ROOT_UNCONFIRMED");
			await checkMount(root);
			if (
				(await realpath(policy.rootPath)) !== policy.rootPath ||
				!same(rootIdentity, await lstat(policy.rootPath, { bigint: true }))
			)
				throw new Error("CODING_STORAGE_ROOT_CHANGED");
		};
		const owned = async (handle: FileHandle, mode: number) => {
			await checkMount(handle);
			const info = await handle.stat({ bigint: true });
			if (!info.isDirectory() || info.uid !== uid || info.gid !== gid || (info.mode & 0o7777n) !== BigInt(mode))
				throw new Error("CODING_STORAGE_DIRECTORY_UNPROTECTED");
		};
		const child = async (parent: FileHandle, name: string, mode: number) => {
			await stable();
			const path = `/proc/self/fd/${parent.fd}/${name}`;
			await checkMount(parent);
			let created = false;
			if (create) {
				try {
					await mkdir(path, { mode });
					created = true;
				} catch (error) {
					if (!code(error, "EEXIST")) throw error;
				}
			}
			const handle = await open(path, O_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW);
			handles.push(handle);
			if (created) {
				await checkMount(handle);
				const info = await handle.stat({ bigint: true });
				if (
					!info.isDirectory() ||
					info.uid !== uid ||
					info.gid !== gid ||
					(info.mode & 0o7777n & ~BigInt(mode)) !== 0n
				)
					throw new Error("CODING_STORAGE_DIRECTORY_UNPROTECTED");
				const fresh = await open(`/proc/self/fd/${handle.fd}`, constants.O_RDONLY | constants.O_DIRECTORY);
				try {
					await fresh.chmod(mode);
				} finally {
					await fresh.close();
				}
			}
			await owned(handle, mode);
			if (create) {
				await syncDirectory(handle);
				await syncDirectory(parent);
			}
			await stable();
			return handle;
		};
		try {
			checkSignal();
			let current = await open("/", O_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW);
			handles.push(current);
			for (const name of policy.rootPath.slice(1).split("/")) {
				const info = await current.stat({ bigint: true });
				// Root's sticky /tmp is safe for task fixtures: it cannot remove
				// another owner's child. Every child is still descriptor-pinned.
				if (
					!info.isDirectory() ||
					![0n, uid].includes(info.uid) ||
					((info.mode & 0o022n) !== 0n && !(info.uid === 0n && (info.mode & 0o1000n) !== 0n))
				)
					throw new Error("CODING_STORAGE_PARENT_UNPROTECTED");
				current = await open(
					`/proc/self/fd/${current.fd}/${name}`,
					O_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW,
				);
				handles.push(current);
			}
			root = current;
			await owned(root, 0o700);
			rootIdentity = await root.stat({ bigint: true });
			await stable();
			if (!parsed) {
				await child(root, "control", 0o700);
				return;
			}
			let parent = root;
			for (const name of ["workers", parsed.companyId, parsed.environmentId, parsed.workerId])
				parent = await child(parent, name, 0o700);
			for (const name of ["data", "guest-state"]) {
				const directory = await child(parent, name, 0o755);
				const path = `/proc/self/fd/${directory.fd}/${CODING_STORAGE_MARKER}`;
				const bytes = Buffer.from(JSON.stringify(parsed));
				if (create) {
					await stable();
					const temporary = `/proc/self/fd/${directory.fd}/.storage-${randomUUID()}`;
					const writer = await open(
						temporary,
						constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
						0o600,
					);
					try {
						await writer.writeFile(bytes);
						await writer.chmod(0o444);
						await writer.sync();
						await stable();
						try {
							await link(temporary, path);
						} catch (error) {
							if (!code(error, "EEXIST")) throw error;
						}
					} finally {
						await writer.close();
						await unlink(temporary);
						await syncDirectory(directory);
					}
				}
				const reader = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
				try {
					await checkMount(reader);
					const before = await reader.stat({ bigint: true });
					if (
						!before.isFile() ||
						before.uid !== uid ||
						before.gid !== gid ||
						before.nlink !== 1n ||
						(before.mode & 0o7777n) !== 0o444n ||
						before.size !== BigInt(bytes.length)
					)
						throw new Error("CODING_STORAGE_MARKER_UNPROTECTED");
					const actual = Buffer.alloc(bytes.length + 1);
					let offset = 0;
					while (offset < actual.length) {
						const r = await reader.read(actual, offset, actual.length - offset, null);
						if (!r.bytesRead) break;
						offset += r.bytesRead;
					}
					const after = await reader.stat({ bigint: true });
					if (
						offset !== bytes.length ||
						!actual.subarray(0, offset).equals(bytes) ||
						!same(before, after) ||
						before.size !== after.size ||
						after.nlink !== 1n ||
						before.ctimeNs !== after.ctimeNs ||
						before.mtimeNs !== after.mtimeNs ||
						!same(after, await lstat(path, { bigint: true }))
					)
						throw new Error("CODING_STORAGE_BINDING_CHANGED");
				} finally {
					await reader.close();
				}
				await stable();
			}
		} finally {
			await Promise.allSettled(handles.map((handle) => handle.close()));
			pending = false;
		}
	}
	return Object.freeze({
		controlPath: `${policy.rootPath}/control`,
		prepare: (binding: CloudCodingStorageBinding, signal?: AbortSignal) => execute(binding, true, signal),
		assert: (binding: CloudCodingStorageBinding, signal?: AbortSignal) => execute(binding, false, signal),
		prepareControl: async (signal?: AbortSignal) => {
			await execute(undefined, true, signal);
			return `${policy.rootPath}/control`;
		},
		assertControl: (signal?: AbortSignal) => execute(undefined, false, signal),
	});
}
