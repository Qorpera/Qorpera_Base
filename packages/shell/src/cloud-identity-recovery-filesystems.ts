import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { recoveryRecord } from "./cloud-identity-recovery-crypto.ts";
import { FileRecoveryObjectStore } from "./cloud-identity-recovery-store.ts";

export interface RecoveryDirectoryMount {
	mountPoint: string;
	root: string;
	filesystem: string;
	source: string;
}

/** Bind the already-open directory to its mount, not a pathname checked before
 * open. Local proc metadata never asks an unavailable NFS server for stat data. */
export function parseRecoveryDirectoryMount(mountInfo: string, fdInfo: string): RecoveryDirectoryMount {
	if (Buffer.byteLength(mountInfo) > 1_048_576 || Buffer.byteLength(fdInfo) > 4096)
		throw new Error("Recovery mount metadata exceeds its bound");
	const ids = [...fdInfo.matchAll(/^mnt_id:\s+([1-9][0-9]*)$/gm)];
	if (ids.length !== 1) throw new Error("Recovery directory has no exact mount identity");
	const entries = mountInfo.split("\n").filter((line) => line.split(" ", 1)[0] === ids[0][1]);
	if (entries.length !== 1) throw new Error("Recovery directory mount is unavailable or ambiguous");
	const [prefix, suffix, extra] = entries[0].split(" - ");
	const before = prefix.split(" ");
	const after = suffix?.split(" ");
	if (extra !== undefined || before.length < 6 || !after || after.length !== 3)
		throw new Error("Recovery directory mount metadata is invalid");
	const decoded = [before[3], before[4], after[1]].map((value) => {
		const result = value.replace(/\\(040|011|012|134)/g, (_, octal: string) =>
			String.fromCharCode(Number.parseInt(octal, 8)),
		);
		if (result.includes("\\") || /[\u0000-\u001f\u007f]/.test(result))
			throw new Error("Recovery mount path is unsupported");
		return result;
	});
	return { root: decoded[0], mountPoint: decoded[1], filesystem: after[0], source: decoded[2] };
}

async function readRecoveryProcFile(path: string, limit: number): Promise<string> {
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const bytes = Buffer.alloc(limit + 1);
		let length = 0;
		while (length < bytes.length) {
			const result = await handle.read(bytes, length, bytes.length - length, null);
			if (!result.bytesRead) break;
			length += result.bytesRead;
		}
		if (length > limit) throw new Error("Recovery mount metadata exceeds its bound");
		return new TextDecoder("utf8", { fatal: true }).decode(bytes.subarray(0, length));
	} finally {
		await handle.close();
	}
}

async function inspectRecoveryDirectory(fd: number): Promise<RecoveryDirectoryMount> {
	if (process.platform !== "linux" || !Number.isSafeInteger(fd) || fd < 0)
		throw new Error("Recovery mount inspection requires a Linux descriptor");
	const fdInfo = await readRecoveryProcFile(`/proc/self/fdinfo/${fd}`, 4096);
	const mountInfo = await readRecoveryProcFile("/proc/self/mountinfo", 1_048_576);
	return parseRecoveryDirectoryMount(mountInfo, fdInfo);
}

function recoveryRoot(value: unknown): string {
	if (
		typeof value !== "string" ||
		value.length > 4096 ||
		!isAbsolute(value) ||
		resolve(value) !== value ||
		value === "/" ||
		/[\u0000-\u001f\u007f\\]/.test(value)
	)
		throw new Error("Recovery filesystem paths must be canonical absolute paths");
	return value;
}

/** The journal is mandatory and local; the NAS is checked only when explicitly
 * used. Losing an NFS mount cannot turn its underlying local directory into a
 * successful NAS receipt. Both stores revalidate every opened descriptor. */
export async function openRecoveryFilesystems(
	configuration: unknown,
	inspect: (fd: number) => Promise<RecoveryDirectoryMount> = inspectRecoveryDirectory,
	timeoutMs = 5_000,
): Promise<{ journal: FileRecoveryObjectStore; nas: FileRecoveryObjectStore }> {
	const config = recoveryRecord(configuration, [
		"journalRoot",
		"journalMountPoint",
		"nasRoot",
		"nasMountPoint",
		"nasSource",
	]);
	const journalRoot = recoveryRoot(config.journalRoot);
	const journalMountPoint = recoveryRoot(config.journalMountPoint);
	const nasRoot = recoveryRoot(config.nasRoot);
	const nasMountPoint = recoveryRoot(config.nasMountPoint);
	const nasSource = config.nasSource;
	if (
		!(journalRoot === journalMountPoint || journalRoot.startsWith(journalMountPoint + sep)) ||
		!(nasRoot === nasMountPoint || nasRoot.startsWith(nasMountPoint + sep)) ||
		journalMountPoint === nasMountPoint ||
		journalMountPoint.startsWith(nasMountPoint + sep) ||
		nasMountPoint.startsWith(journalMountPoint + sep) ||
		typeof nasSource !== "string" ||
		nasSource.length < 4 ||
		nasSource.length > 4096 ||
		!nasSource.includes(":/") ||
		/[\u0000-\u0020\u007f\\]/.test(nasSource)
	)
		throw new Error("Recovery journal and NAS require separate explicit mounts");
	const journal = new FileRecoveryObjectStore(journalRoot, timeoutMs, async (directory) => {
		const mount = await inspect(directory.fd);
		if (
			mount.mountPoint !== journalMountPoint ||
			mount.root !== "/" ||
			!["ext4", "xfs", "btrfs", "zfs"].includes(mount.filesystem)
		)
			throw new Error("Recovery journal requires its dedicated persistent local filesystem");
	});
	const nas = new FileRecoveryObjectStore(nasRoot, timeoutMs, async (directory) => {
		const mount = await inspect(directory.fd);
		if (
			mount.mountPoint !== nasMountPoint ||
			mount.root !== "/" ||
			!["nfs", "nfs4"].includes(mount.filesystem) ||
			mount.source !== nasSource
		)
			throw new Error("Recovery NAS does not match its pinned mount");
	});
	await journal.verify(AbortSignal.timeout(timeoutMs));
	return { journal, nas };
}
