import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { type FileHandle, open, opendir, realpath } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import {
	type CompanyComputerPreparationEntry,
	type CompanyComputerPreparationRequest,
	companyComputerPreparationRoot,
	parseCompanyComputerPreparationRequest,
} from "@qorpera/contracts";
import {
	assertCompanyComputerLinuxHost,
	assertCompanyComputerWorkbenchMount,
	openCompanyComputerLinuxDirectory,
	readCompanyComputerLinuxMetadata,
} from "./cloud-company-computer-linux-host.ts";

const O_PATH = 0x200000;
const CHUNK = 256 * 1024;
let pending = false;
function digest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function identity(info: BigIntStats) {
	return {
		dev: info.dev.toString(),
		ino: info.ino.toString(),
		uid: info.uid.toString(),
		gid: info.gid.toString(),
		mode: info.mode.toString(),
		size: info.size.toString(),
		nlink: info.nlink.toString(),
		mtime: info.mtimeNs.toString(),
		ctime: info.ctimeNs.toString(),
	};
}
async function mountId(file: FileHandle): Promise<string> {
	const data = await readCompanyComputerLinuxMetadata(`/proc/self/fdinfo/${file.fd}`, 4096);
	const matches = [...data.matchAll(/^mnt_id:\s+([1-9][0-9]*)$/gm)];
	if (matches.length !== 1) throw new Error("OFFICE_PREPARATION_MOUNT_UNCONFIRMED");
	return matches[0][1];
}
async function physical(request: CompanyComputerPreparationRequest, signal: AbortSignal): Promise<void> {
	await assertCompanyComputerLinuxHost(request.limits, signal);
	const status = await readCompanyComputerLinuxMetadata("/proc/self/status", 65536);
	const ids = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/m.exec(status);
	const groups = /^Gid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/m.exec(status);
	if (
		!ids ||
		ids.slice(1).some((id) => Number(id) !== request.uid) ||
		!groups ||
		groups.slice(1).some((id) => Number(id) !== request.gid) ||
		(await readCompanyComputerLinuxMetadata("/proc/sys/kernel/random/boot_id", 64)).trim() !== request.bootId
	)
		throw new Error("OFFICE_PREPARATION_BOOT_OR_WRITER_MISMATCH");
	signal.throwIfAborted();
}
async function inspect(request: CompanyComputerPreparationRequest, signal: AbortSignal) {
	await physical(request, signal);
	const path = companyComputerPreparationRoot(request);
	const root = await openCompanyComputerLinuxDirectory(path, true);
	try {
		const rootMount = await mountId(root);
		const entries = new Map(request.entries.map((entry) => [entry.path, entry]));
		const children = new Map<string, Map<string, CompanyComputerPreparationEntry>>();
		for (const entry of request.entries) {
			if (entry.path === ".") continue;
			const at = entry.path.lastIndexOf("/");
			const parent = at < 0 ? "." : entry.path.slice(0, at);
			const name = entry.path.slice(at + 1);
			let names = children.get(parent);
			if (!names) {
				names = new Map();
				children.set(parent, names);
			}
			names.set(name, entry);
		}
		const checkMount = async () => {
			signal.throwIfAborted();
			await assertCompanyComputerWorkbenchMount(root, request.workbenchMount, [path]);
			if ((await realpath(`/proc/self/fd/${root.fd}`)) !== path || (await realpath(path)) !== path)
				throw new Error("OFFICE_PREPARATION_ROOT_CHANGED");
		};
		const metadata = async (file: FileHandle, entry: CompanyComputerPreparationEntry) => {
			signal.throwIfAborted();
			const info = await file.stat({ bigint: true });
			if (
				info.uid !== BigInt(request.uid) ||
				info.gid !== BigInt(request.gid) ||
				(info.mode & 0o7777n) !== BigInt(entry.mode) ||
				(entry.kind === "directory"
					? !info.isDirectory()
					: !info.isFile() || info.nlink !== 1n || info.size !== BigInt(entry.bytes)) ||
				(await mountId(file)) !== rootMount
			)
				throw new Error("OFFICE_PREPARATION_CONTENT_MISMATCH");
			return identity(info);
		};
		const pass = async () => {
			await checkMount();
			const measured = new Map<string, ReturnType<typeof identity>>();
			const walk = async (directory: FileHandle, entry: CompanyComputerPreparationEntry): Promise<void> => {
				const before = await metadata(directory, entry);
				const expected = children.get(entry.path) ?? new Map<string, CompanyComputerPreparationEntry>();
				const seen = new Set<string>();
				const reader = await opendir(`/proc/self/fd/${directory.fd}`, { bufferSize: 32 });
				try {
					for (;;) {
						signal.throwIfAborted();
						const found = await reader.read();
						if (!found) break;
						const wanted = expected.get(found.name);
						if (!wanted || seen.has(found.name) || /[\x00-\x1f\x7f\\/\ufffd]/.test(found.name))
							throw new Error("OFFICE_PREPARATION_UNEXPECTED_ENTRY");
						seen.add(found.name);
						// Never open a FIFO, device or socket for reading. O_PATH first
						// pins its metadata; only a verified regular file is reopened.
						const child = await open(
							`/proc/self/fd/${directory.fd}/${found.name}`,
							O_PATH | constants.O_NOFOLLOW,
						);
						try {
							const start = await metadata(child, wanted);
							if (wanted.kind === "directory") await walk(child, wanted);
							else {
								const file = await open(`/proc/self/fd/${child.fd}`, constants.O_RDONLY | constants.O_NONBLOCK);
								try {
									if (!isDeepStrictEqual(await metadata(file, wanted), start))
										throw new Error("OFFICE_PREPARATION_CONTENT_CHANGED");
									const hash = createHash("sha256"),
										buffer = Buffer.alloc(CHUNK);
									let length = 0;
									for (;;) {
										signal.throwIfAborted();
										const read = await file.read(buffer, 0, Math.min(CHUNK, wanted.bytes - length + 1), null);
										if (!read.bytesRead) break;
										length += read.bytesRead;
										if (length > wanted.bytes) throw new Error("OFFICE_PREPARATION_CONTENT_CHANGED");
										hash.update(buffer.subarray(0, read.bytesRead));
									}
									if (
										length !== wanted.bytes ||
										hash.digest("hex") !== wanted.sha256 ||
										!isDeepStrictEqual(await metadata(file, wanted), start)
									)
										throw new Error("OFFICE_PREPARATION_CONTENT_CHANGED");
								} finally {
									await file.close();
								}
							}
							if (!isDeepStrictEqual(await metadata(child, wanted), start))
								throw new Error("OFFICE_PREPARATION_CONTENT_CHANGED");
							measured.set(wanted.path, start);
						} finally {
							await child.close();
						}
					}
				} finally {
					await reader.close();
				}
				if (seen.size !== expected.size || !isDeepStrictEqual(await metadata(directory, entry), before))
					throw new Error("OFFICE_PREPARATION_CONTENT_CHANGED");
				measured.set(entry.path, before);
			};
			await walk(root, entries.get(".")!);
			await checkMount();
			return request.entries.map((entry) => ({ path: entry.path, ...measured.get(entry.path)! }));
		};
		const first = await pass(),
			second = await pass();
		if (!isDeepStrictEqual(first, second)) throw new Error("OFFICE_PREPARATION_CONTENT_CHANGED");
		await physical(request, signal);
		await checkMount();
		signal.throwIfAborted();
		return {
			schema: "qorpera.office-guest-preparation-result/v1" as const,
			state: "prepared" as const,
			scope: request.scope,
			computerGeneration: request.computerGeneration,
			allocationId: request.allocationId,
			instanceSha256: request.instanceSha256,
			imageSha256: request.imageSha256,
			bootstrapSha256: request.bootstrapSha256,
			bootId: request.bootId,
			copy: request.copy,
			workbenchMount: request.workbenchMount,
			contentSha256: digest(request.entries),
			observationSha256: digest(second),
			entries: request.entries.length,
			totalBytes: request.entries.reduce((total, entry) => total + entry.bytes, 0),
		};
	} finally {
		await root.close();
	}
}

/** Read-only physical preparation; no service, browser, command, credential or
 * network adapter is loaded. The provider must hold its external writer fence.
 * Matching passes are evidence, not a snapshot, admission or a durable receipt.
 * Cancelled NFS work retains the process-wide slot until it actually settles. */
export async function prepareCompanyComputerGuest(value: unknown, caller: AbortSignal) {
	caller.throwIfAborted();
	if (pending) throw new Error("OFFICE_GUEST_PREPARATION_PENDING");
	const request = parseCompanyComputerPreparationRequest(value);
	const signal = AbortSignal.any([caller, AbortSignal.timeout(300000)]);
	pending = true;
	let abort = () => {};
	const stopped = new Promise<never>((_resolve, reject) => {
		abort = () => reject(new Error("OFFICE_GUEST_PREPARATION_ABORTED"));
		signal.addEventListener("abort", abort, { once: true });
	});
	const operation = inspect(request, signal).finally(() => {
		pending = false;
	});
	try {
		return await Promise.race([operation, stopped]);
	} finally {
		signal.removeEventListener("abort", abort);
	}
}
