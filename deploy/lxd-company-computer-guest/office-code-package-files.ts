import { createHash, randomUUID } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { type FileHandle, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { COMPANY_COMPUTER_CODE_PACKAGE_ARTIFACTS } from "../../packages/contracts/src/index.ts";
import { assertOfficeInstallLocalDescriptor } from "../../packages/runner-orchestrator/src/lxd-office-installation-host.ts";
import { assertCompanyComputerImageArtifact } from "../../packages/runtime/src/cloud-company-computer-linux-host.ts";

export const packageHash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const keys = ["dev", "ino", "mode", "uid", "gid", "nlink", "size", "mtimeNs", "ctimeNs"] as const;
export const packageStamp = (s: BigIntStats) => Object.fromEntries(keys.map((key) => [key, String(s[key])]));
export const packageMissing = (e: unknown) => e instanceof Error && "code" in e && e.code === "ENOENT";
export async function packageDirectory(path: string, mode: number, create = false): Promise<void> {
	if (create) {
		await assertCompanyComputerImageArtifact(dirname(path), true);
		try {
			await mkdir(path, { mode });
		} catch (e) {
			if (!(e instanceof Error && "code" in e && e.code === "EEXIST")) throw e;
		}
	}
	await assertCompanyComputerImageArtifact(path, true);
	const s = await lstat(path);
	if ((s.mode & 0o7777) !== mode) throw new Error("CODE_PACKAGE_DIRECTORY_MODE");
}
/** Bounded descriptor read. Every directory is canonical and root protected;
 * a same-name replacement, hard link or in-place write invalidates the read. */
export async function readPackageFile(path: string, limit: number, mode: number) {
	if (!Number.isSafeInteger(limit) || limit < 0 || limit > 32 * 1024 ** 2) throw new Error("CODE_PACKAGE_READ_LIMIT");
	await assertCompanyComputerImageArtifact(path);
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		await assertOfficeInstallLocalDescriptor(file.fd);
		const before = await file.stat({ bigint: true });
		if (
			!before.isFile() ||
			before.uid !== 0n ||
			before.gid !== 0n ||
			before.nlink !== 1n ||
			(before.mode & 0o7777n) !== BigInt(mode) ||
			before.size > BigInt(limit)
		)
			throw new Error("CODE_PACKAGE_FILE_CUSTODY");
		const bytes = Buffer.alloc(Number(before.size) + 1);
		let n = 0;
		while (n < bytes.length) {
			const r = await file.read(bytes, n, bytes.length - n, n);
			if (!r.bytesRead) break;
			n += r.bytesRead;
		}
		const after = await file.stat({ bigint: true }),
			named = await lstat(path, { bigint: true });
		if (n !== Number(before.size) || keys.some((k) => before[k] !== after[k] || before[k] !== named[k]))
			throw new Error("CODE_PACKAGE_FILE_CHANGED");
		await assertCompanyComputerImageArtifact(dirname(path), true);
		return { bytes: bytes.subarray(0, n), stamp: packageStamp(before) };
	} finally {
		await file.close();
	}
}
export async function assertPackageStamp(path: string, stamp: Record<string, string>): Promise<void> {
	await assertCompanyComputerImageArtifact(path);
	const current = packageStamp(await lstat(path, { bigint: true }));
	if (JSON.stringify(current) !== JSON.stringify(stamp)) throw new Error("CODE_PACKAGE_INVENTORY_CHANGED");
}

/** Recheck a previously hashed immutable inventory. Exact inode, ownership,
 * mode, link count, length and nanosecond change times must remain pinned;
 * every shared named parent is still canonical and root protected. */
export async function assertPackageInventoryStamps(stamps: readonly { path: string; stamp: Record<string, string> }[]) {
	const parents = new Set(stamps.map((s) => dirname(s.path)));
	for (const path of parents) await assertCompanyComputerImageArtifact(path, true);
	for (const item of stamps) {
		const current = packageStamp(await lstat(item.path, { bigint: true }));
		if (JSON.stringify(current) !== JSON.stringify(item.stamp)) throw new Error("CODE_PACKAGE_INVENTORY_CHANGED");
	}
	for (const path of parents) await assertCompanyComputerImageArtifact(path, true);
}

/** Measure a complete signed inventory using held directory descriptors.
 * Shared ancestors and mount provenance are checked per directory, not once
 * per file. Every file is still hashed and restatted, and all named anchors
 * are checked again before the snapshot is accepted. */
export async function readPackageInventory(
	artifacts: readonly { path: string; bytes: number; mode: number; sha256: string }[],
	signal: AbortSignal,
) {
	const parents = new Map<string, { file: FileHandle; identity: BigIntStats }>();
	const stamps: Array<{ path: string; stamp: Record<string, string> }> = [];
	const checkParent = async (path: string, held: { file: FileHandle; identity: BigIntStats }) => {
		const named = await lstat(path, { bigint: true }),
			current = await held.file.stat({ bigint: true });
		if (
			["dev", "ino", "mode", "uid", "gid"].some((k) => {
				const key = k as "dev" | "ino" | "mode" | "uid" | "gid";
				return held.identity[key] !== named[key] || held.identity[key] !== current[key];
			}) ||
			(await realpath(`/proc/self/fd/${held.file.fd}`)) !== path
		)
			throw new Error("CODE_PACKAGE_INVENTORY_DIRECTORY_CHANGED");
	};
	try {
		for (const a of artifacts) {
			signal.throwIfAborted();
			if (!Number.isSafeInteger(a.bytes) || a.bytes < 0 || a.bytes > 32 * 1024 ** 2)
				throw new Error("CODE_PACKAGE_READ_LIMIT");
			const parent = dirname(a.path);
			let held = parents.get(parent);
			if (!held) {
				await assertCompanyComputerImageArtifact(parent, true);
				const file = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
				try {
					await assertOfficeInstallLocalDescriptor(file.fd);
					held = { file, identity: await file.stat({ bigint: true }) };
					await checkParent(parent, held);
					parents.set(parent, held);
				} catch (e) {
					await file.close();
					throw e;
				}
			}
			const path = `/proc/self/fd/${held.file.fd}/${basename(a.path)}`;
			const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
			try {
				const before = await file.stat({ bigint: true });
				if (
					!before.isFile() ||
					before.dev !== held.identity.dev ||
					before.uid !== 0n ||
					before.gid !== 0n ||
					before.nlink !== 1n ||
					(before.mode & 0o7777n) !== BigInt(a.mode) ||
					before.size !== BigInt(a.bytes)
				)
					throw new Error("CODE_PACKAGE_INVENTORY_CUSTODY");
				const bytes = Buffer.alloc(a.bytes + 1);
				let length = 0;
				while (length < bytes.length) {
					signal.throwIfAborted();
					const r = await file.read(bytes, length, bytes.length - length, length);
					if (!r.bytesRead) break;
					length += r.bytesRead;
				}
				const after = await file.stat({ bigint: true }),
					named = await lstat(path, { bigint: true });
				if (
					length !== a.bytes ||
					keys.some((k) => before[k] !== after[k] || before[k] !== named[k]) ||
					packageHash(bytes.subarray(0, length)) !== a.sha256
				)
					throw new Error("CODE_PACKAGE_INVENTORY");
				stamps.push({ path: a.path, stamp: packageStamp(before) });
			} finally {
				await file.close();
			}
		}
		for (const item of stamps) {
			signal.throwIfAborted();
			const held = parents.get(dirname(item.path))!;
			const current = packageStamp(
				await lstat(`/proc/self/fd/${held.file.fd}/${basename(item.path)}`, { bigint: true }),
			);
			if (JSON.stringify(current) !== JSON.stringify(item.stamp)) throw new Error("CODE_PACKAGE_INVENTORY_CHANGED");
		}
		for (const [path, held] of parents) {
			await assertCompanyComputerImageArtifact(path, true);
			await checkParent(path, held);
		}
		signal.throwIfAborted();
		return stamps;
	} finally {
		for (const held of parents.values()) await held.file.close();
	}
}
export async function assertPackageAbsent(path: string): Promise<void> {
	try {
		await lstat(path);
	} catch (e) {
		if (packageMissing(e)) return;
		throw e;
	}
	throw new Error("CODE_PACKAGE_PATH_ALREADY_EXISTS");
}
/** Claims and receipts never overwrite any existing prefix, even identical.
 * Failed publication is retained for diagnosis and cannot grant a replay. */
export async function claimPackageFile(path: string, bytes: Buffer, mode = 0o400): Promise<void> {
	await assertCompanyComputerImageArtifact(dirname(path), true);
	const parent = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try {
		await assertOfficeInstallLocalDescriptor(parent.fd);
		if ((await realpath(`/proc/self/fd/${parent.fd}`)) !== dirname(path))
			throw new Error("CODE_PACKAGE_PARENT_CHANGED");
		const file = await open(
			`/proc/self/fd/${parent.fd}/${basename(path)}`,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
			mode,
		);
		try {
			await file.writeFile(bytes);
			await file.chmod(mode);
			await file.sync();
		} finally {
			await file.close();
		}
		await parent.sync();
	} finally {
		await parent.close();
	}
	if (!(await readPackageFile(path, bytes.length, mode)).bytes.equals(bytes))
		throw new Error("CODE_PACKAGE_PUBLICATION_CHANGED");
}
/** Only callers holding the real preparation flock may publish fixed /opt
 * code files. The old inode is rechecked after staging and before rename. */
export async function replacePackageCode(
	file: string,
	bytes: Buffer,
	previous: Record<string, string> | null,
	authorize: () => Promise<void>,
	assertDeadline: () => void,
): Promise<void> {
	if (!(COMPANY_COMPUTER_CODE_PACKAGE_ARTIFACTS as readonly string[]).includes(file))
		throw new Error("CODE_PACKAGE_TARGET");
	const directory = "/opt/qorpera-office",
		path = `${directory}/${file}`;
	await packageDirectory(directory, 0o755);
	const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	const temp = `/proc/self/fd/${parent.fd}/.code-package-${randomUUID()}`;
	let pending = false;
	try {
		await assertOfficeInstallLocalDescriptor(parent.fd);
		if ((await realpath(`/proc/self/fd/${parent.fd}`)) !== directory) throw new Error("CODE_PACKAGE_PARENT_CHANGED");
		const handle = await open(
			temp,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
			0o444,
		);
		pending = true;
		try {
			await handle.writeFile(bytes);
			await handle.chmod(0o444);
			await handle.sync();
		} finally {
			await handle.close();
		}
		await authorize();
		if (previous) await assertPackageStamp(path, previous);
		else await assertPackageAbsent(path);
		await packageDirectory(directory, 0o755);
		const held = await parent.stat(),
			named = await lstat(directory);
		if (held.dev !== named.dev || held.ino !== named.ino) throw new Error("CODE_PACKAGE_PARENT_CHANGED");
		assertDeadline();
		await rename(temp, `/proc/self/fd/${parent.fd}/${basename(path)}`);
		pending = false;
		await parent.sync();
		if (!(await readPackageFile(path, bytes.length, 0o444)).bytes.equals(bytes))
			throw new Error("CODE_PACKAGE_WRITE_UNCONFIRMED");
	} finally {
		try {
			if (pending) {
				await unlink(temp);
				await parent.sync();
			}
		} finally {
			await parent.close();
		}
	}
}
