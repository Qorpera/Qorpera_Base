import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { type FileHandle, lstat, open, readlink, realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { OFFICE_HOST_NAMESPACE_RECORD, parseLxdOfficeHostNamespace } from "./lxd-office-host-namespace.ts";
import {
	type LxdOfficeMountPolicy,
	type LxdOfficePhysicalPolicy,
	officePhysicalPath,
} from "./lxd-office-physical-policy.ts";

async function rootParents(path: string): Promise<void> {
	let current = dirname(path);
	while (true) {
		const info = await lstat(current);
		if (!info.isDirectory() || info.uid !== 0 || (info.mode & 0o6022) !== 0)
			throw new Error("OFFICE_HOST_PATH_UNPROTECTED");
		if (current === "/") break;
		current = dirname(current);
	}
}

async function readBounded(file: FileHandle, limit: number): Promise<Buffer> {
	const bytes = Buffer.alloc(limit + 1);
	try {
		let offset = 0;
		while (offset < bytes.length) {
			const read = await file.read(bytes, offset, bytes.length - offset, null);
			if (!read.bytesRead) break;
			offset += read.bytesRead;
		}
		if (offset > limit) throw new Error("OFFICE_HOST_METADATA_TOO_LARGE");
		return bytes.subarray(0, offset);
	} catch (error) {
		bytes.fill(0);
		throw error;
	}
}

function identity(info: Stats) {
	return { dev: info.dev, ino: info.ino, uid: info.uid, gid: info.gid, mode: info.mode, nlink: info.nlink };
}

/** Root-owned configuration on protected local paths. No symlinks, special
 * files, multiple hard links, concurrent replacement or unbounded reads. */
export async function readLxdOfficeProtectedFile(path: string, limit: number): Promise<Buffer> {
	return readProtectedFile(path, limit, false);
}

/** Credentials are root-owned and readable only by root and the provider's
 * dedicated primary group. Validate the opened descriptor before reading. */
export async function readLxdOfficeCredentialFile(path: string, limit: number): Promise<Buffer> {
	return readProtectedFile(path, limit, true);
}

/** Public image inventory can contain the complete dependency closure; its
 * caller must compare the bytes with the immutable signed image manifest pin. */
export async function readLxdOfficeProtectedImageManifestFile(path: string): Promise<Buffer> {
	return readProtectedFile(path, 1024 ** 2, false, 1024 ** 2);
}

async function readProtectedFile(path: string, limit: number, confidential: boolean, ceiling = 65536): Promise<Buffer> {
	officePhysicalPath(path);
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > ceiling) throw new Error("INVALID_OFFICE_FILE_LIMIT");
	await rootParents(path);
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	let contents: Buffer | undefined;
	let returned = false;
	try {
		if (process.platform !== "linux") throw new Error("OFFICE_HOST_LINUX_REQUIRED");
		const fdInfo = await metadata(`/proc/self/fdinfo/${file.fd}`, 4096);
		const ids = [...fdInfo.matchAll(/^mnt_id:\s+([1-9][0-9]*)$/gm)];
		const mounts = (await metadata("/proc/self/mountinfo", 1048576))
			.split("\n")
			.filter((line) => line.split(" ", 1)[0] === ids[0]?.[1]);
		if (
			ids.length !== 1 ||
			mounts.length !== 1 ||
			!["ext4", "xfs", "btrfs", "zfs", "overlay", "tmpfs"].includes(mounts[0].split(" - ")[1]?.split(" ")[0])
		)
			throw new Error("OFFICE_HOST_LOCAL_CONFIGURATION_REQUIRED");
		const before = await file.stat();
		if (
			!before.isFile() ||
			before.uid !== 0 ||
			(before.mode & 0o6022) !== 0 ||
			(confidential &&
				(![0o400, 0o440].includes(before.mode & 0o7777) ||
					((before.mode & 0o040) !== 0 && before.gid !== process.getegid?.()))) ||
			before.nlink !== 1 ||
			before.size < 1 ||
			before.size > limit ||
			(await realpath(path)) !== path
		)
			throw new Error("OFFICE_HOST_FILE_UNPROTECTED");
		const bytes = await readBounded(file, limit);
		contents = bytes;
		const after = await file.stat();
		if (
			bytes.length !== before.size ||
			before.size !== after.size ||
			before.ctimeMs !== after.ctimeMs ||
			before.mtimeMs !== after.mtimeMs ||
			!isDeepStrictEqual(identity(before), identity(after)) ||
			!isDeepStrictEqual(identity(after), identity(await lstat(path)))
		)
			throw new Error("OFFICE_HOST_FILE_CHANGED");
		returned = true;
		return bytes;
	} finally {
		if (!returned) contents?.fill(0);
		await file.close();
	}
}

async function metadata(path: string, limit: number): Promise<string> {
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		return new TextDecoder("utf8", { fatal: true }).decode(await readBounded(file, limit));
	} finally {
		await file.close();
	}
}

/** Match the already-open descriptor to the kernel mount ID. Checking a
 * pathname alone could accept the local directory hidden beneath lost NFS. */
export function assertLxdOfficeHostMount(
	mountInfo: string,
	fdInfo: string,
	expected: LxdOfficeMountPolicy,
	path: string,
	serverAddress?: string,
): void {
	if (Buffer.byteLength(mountInfo) > 1048576 || Buffer.byteLength(fdInfo) > 4096)
		throw new Error("OFFICE_HOST_MOUNT_TOO_LARGE");
	const ids = [...fdInfo.matchAll(/^mnt_id:\s+([1-9][0-9]*)$/gm)];
	if (ids.length !== 1) throw new Error("OFFICE_HOST_MOUNT_UNCONFIRMED");
	const decode = (value: string): string => {
		const decoded = value.replace(/\\(040|011|012|134)/g, (_, octal: string) =>
			String.fromCharCode(Number.parseInt(octal, 8)),
		);
		if (/[\x00-\x20\x7f\\]/.test(decoded)) throw new Error("OFFICE_HOST_MOUNT_PATH_UNSUPPORTED");
		return decoded;
	};
	const lines = mountInfo
		.trim()
		.split("\n")
		.map((line) => {
			const [prefix, suffix, extra] = line.split(" - ");
			const before = prefix.split(" ");
			const after = suffix?.split(" ");
			if (extra !== undefined || before.length < 6 || !after || after.length !== 3)
				throw new Error("OFFICE_HOST_MOUNT_UNCONFIRMED");
			return {
				id: before[0],
				root: decode(before[3]),
				mountPoint: decode(before[4]),
				filesystem: after[0],
				source: decode(after[1]),
				options: before[5].split(","),
				superOptions: after[2].split(","),
			};
		});
	const matches = lines.filter((line) => line.id === ids[0][1]);
	if (matches.length !== 1) throw new Error("OFFICE_HOST_MOUNT_UNCONFIRMED");
	const actual = matches[0];
	if (
		actual.root !== expected.root ||
		actual.mountPoint !== expected.mountPoint ||
		actual.filesystem !== expected.filesystem ||
		actual.source !== expected.source ||
		!actual.options.includes("rw") ||
		actual.options.includes("ro") ||
		!actual.superOptions.includes("rw") ||
		actual.superOptions.includes("ro") ||
		lines.filter((line) => line.mountPoint === expected.mountPoint).length !== 1 ||
		lines.some((line) => line.mountPoint.startsWith(`${path}/`))
	)
		throw new Error("OFFICE_HOST_MOUNT_MISMATCH");
	if (serverAddress !== undefined) {
		const options = actual.superOptions;
		const option = (key: string, allowed: readonly string[]) => {
			const values = options.filter((entry) => entry.startsWith(`${key}=`));
			return values.length === 1 && allowed.includes(values[0].slice(key.length + 1));
		};
		if (
			!actual.options.includes("nosuid") ||
			!actual.options.includes("nodev") ||
			!options.includes("hard") ||
			options.some((entry) => ["soft", "softerr", "softreval"].includes(entry)) ||
			!option("proto", ["tcp"]) ||
			!option("vers", ["4.1", "4.2"]) ||
			!option("addr", [serverAddress])
		)
			throw new Error("OFFICE_NAS_MOUNT_POLICY_MISMATCH");
	}
}

async function directory(
	path: string,
	policy: LxdOfficeMountPolicy,
	uid: number,
	gid: number | undefined,
	serverAddress: string | undefined,
): Promise<ReturnType<typeof identity>> {
	await rootParents(path);
	const handle = await open(
		path,
		constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	try {
		// Inspect proc first; this does not require an NFS metadata round trip.
		const inspect = async () =>
			assertLxdOfficeHostMount(
				await metadata("/proc/self/mountinfo", 1048576),
				await metadata(`/proc/self/fdinfo/${handle.fd}`, 4096),
				policy,
				path,
				serverAddress,
			);
		await inspect();
		const before = await handle.stat();
		if (
			!before.isDirectory() ||
			before.uid !== uid ||
			(gid !== undefined && before.gid !== gid) ||
			(before.mode & 0o7777) !== 0o700 ||
			(await realpath(path)) !== path
		)
			throw new Error("OFFICE_HOST_DIRECTORY_UNPROTECTED");
		await inspect();
		const after = await handle.stat();
		if (
			!isDeepStrictEqual(identity(before), identity(after)) ||
			!isDeepStrictEqual(identity(after), identity(await lstat(path)))
		)
			throw new Error("OFFICE_HOST_DIRECTORY_CHANGED");
		return identity(after);
	} finally {
		await handle.close();
	}
}

/** A read-only observation, not NAS durability, inventory, adoption or VM
 * readiness. Its caller must retain this operation after a deadline: Linux
 * may still be waiting for NFS and it must not launch replacement probes. */
export async function inspectLxdOfficePhysicalHost(policy: LxdOfficePhysicalPolicy, signal: AbortSignal) {
	if (process.platform !== "linux" || !process.geteuid?.())
		throw new Error("OFFICE_PROVIDER_UNPRIVILEGED_LINUX_REQUIRED");
	signal.throwIfAborted();
	const bootId = await metadata("/proc/sys/kernel/random/boot_id", 64);
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\n$/.test(bootId))
		throw new Error("OFFICE_PROVIDER_BOOT_UNCONFIRMED");
	const namespace = await assertLxdOfficeHostNamespace(bootId.trim());
	const machine = new TextDecoder("utf8", { fatal: true }).decode(
		await readLxdOfficeProtectedFile("/etc/machine-id", 64),
	);
	if (
		!/^[0-9a-f]{32}\n?$/.test(machine) ||
		/^0{32}\n?$/.test(machine) ||
		createHash("sha256").update(machine.trim()).digest("hex") !== policy.host.machineIdSha256
	)
		throw new Error("OFFICE_PROVIDER_HOST_MISMATCH");
	signal.throwIfAborted();
	await rootParents(policy.host.socketPath);
	const socket = await lstat(policy.host.socketPath);
	if (
		!socket.isSocket() ||
		socket.uid !== 0 ||
		socket.gid !== policy.host.socketGid ||
		(socket.mode & 0o7777) !== 0o660 ||
		(await realpath(policy.host.socketPath)) !== policy.host.socketPath
	)
		throw new Error("OFFICE_PROVIDER_SOCKET_UNPROTECTED");
	const journal = await directory(policy.journal.path, policy.journal, process.geteuid!(), undefined, undefined);
	signal.throwIfAborted();
	const workbench = await directory(
		policy.guest.workbenchSource,
		policy.workbench,
		policy.workbench.uid,
		policy.workbench.gid,
		policy.workbench.serverAddress,
	);
	signal.throwIfAborted();
	if (
		!isDeepStrictEqual(identity(socket), identity(await lstat(policy.host.socketPath))) ||
		bootId !== (await metadata("/proc/sys/kernel/random/boot_id", 64)) ||
		namespace !== (await readlink("/proc/self/ns/mnt"))
	)
		throw new Error("OFFICE_PROVIDER_HOST_CHANGED");
	return { bootId: bootId.trim(), namespace, socket: identity(socket), journal, workbench };
}

/** Linux restricts /proc/1/ns to PID 1's UID or a privileged observer. A
 * protected root startup record permits the dedicated provider to compare
 * its real namespace without adding SYS_PTRACE or weakening mount custody.
 */
export async function assertLxdOfficeHostNamespace(bootId: string): Promise<string> {
	const namespace = await readlink("/proc/self/ns/mnt");
	if (!/^mnt:\[[1-9][0-9]{0,19}\]$/.test(namespace)) throw new Error("OFFICE_PROVIDER_HOST_MOUNT_NAMESPACE_REQUIRED");
	let hostNamespace = "";
	try {
		hostNamespace = await readlink("/proc/1/ns/mnt");
	} catch (error) {
		if (!["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
	}
	// A restricted proc namespace link can also return an empty target. It
	// provides no authority; use the same protected, boot-bound startup record.
	if (hostNamespace === "") {
		const record = parseLxdOfficeHostNamespace(
			JSON.parse(
				new TextDecoder("utf8", { fatal: true }).decode(
					await readLxdOfficeProtectedFile(OFFICE_HOST_NAMESPACE_RECORD, 1024),
				),
			),
		);
		if (record.bootId !== bootId) throw new Error("OFFICE_PROVIDER_BOOT_UNCONFIRMED");
		hostNamespace = record.namespace;
	}
	if (namespace !== hostNamespace) throw new Error("OFFICE_PROVIDER_HOST_MOUNT_NAMESPACE_REQUIRED");
	return namespace;
}

/** Whole-host inventory uses only host/socket custody, independently of any
 * company's office policy, workbench, image or journal. Call before and after
 * the daemon read and compare the complete returned evidence. */
export async function inspectLxdHostInventorySocket(
	host: {
		machineIdSha256: string;
		socketPath: string;
		socketGid: number;
	},
	signal: AbortSignal,
) {
	if (process.platform !== "linux" || !process.geteuid?.())
		throw new Error("NODE_OBSERVER_UNPRIVILEGED_LINUX_REQUIRED");
	signal.throwIfAborted();
	officePhysicalPath(host.socketPath);
	const bootId = await metadata("/proc/sys/kernel/random/boot_id", 64);
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\n$/.test(bootId))
		throw new Error("NODE_OBSERVER_BOOT_UNCONFIRMED");
	const namespace = await assertLxdOfficeHostNamespace(bootId.trim());
	const machine = new TextDecoder("utf8", { fatal: true }).decode(
		await readLxdOfficeProtectedFile("/etc/machine-id", 64),
	);
	if (
		!/^[0-9a-f]{32}\n?$/.test(machine) ||
		/^0{32}\n?$/.test(machine) ||
		createHash("sha256").update(machine.trim()).digest("hex") !== host.machineIdSha256
	)
		throw new Error("NODE_OBSERVER_HOST_DIFFERS");
	await rootParents(host.socketPath);
	const socket = await lstat(host.socketPath);
	if (
		!socket.isSocket() ||
		socket.uid !== 0 ||
		socket.gid !== host.socketGid ||
		(socket.mode & 0o7777) !== 0o660 ||
		(await realpath(host.socketPath)) !== host.socketPath
	)
		throw new Error("NODE_OBSERVER_SOCKET_UNPROTECTED");
	signal.throwIfAborted();
	if (
		bootId !== (await metadata("/proc/sys/kernel/random/boot_id", 64)) ||
		namespace !== (await readlink("/proc/self/ns/mnt")) ||
		!isDeepStrictEqual(identity(socket), identity(await lstat(host.socketPath)))
	)
		throw new Error("NODE_OBSERVER_HOST_CHANGED");
	return { bootId: bootId.trim(), namespace, socket: identity(socket) };
}
