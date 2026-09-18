import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { type FileHandle, link, lstat, mkdir, open, opendir, realpath, unlink } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	type LxdOfficeAdoptionPlan,
	officeAdoptionRelativePath,
	planLxdOfficeAdoption,
} from "./lxd-office-adoption-plan.ts";
import type { LxdOfficeGuestBinding } from "./lxd-office-guest.ts";
import { officeCanonical, officeDigest } from "./lxd-office-image-provenance.ts";
import type { LxdOfficeStorageObservation } from "./lxd-office-inventory-worker.ts";
import { checkDirectory, code, publish, readRecord } from "./lxd-office-journal-files.ts";
import { assertLxdOfficeHostMount } from "./lxd-office-physical-host.ts";
import {
	inspectOfficeStorage,
	type OfficeInventoryEntry,
	type OfficeInventoryLimits,
	type OfficeInventorySource,
	parseOfficeInventoryLimits,
} from "./lxd-office-storage-inventory.ts";
import { type LxdOfficeStorageReview, readLxdOfficeStorageReview } from "./lxd-office-storage-review.ts";

const O_PATH = 0x200000;
const CHUNK = 256 * 1024;
export interface LxdOfficeAdoptionGuard {
	/** Required provider-owned live guard: same stopped initial allocation,
	 * enrolled host/policy, current cloud preparation authority, all mapped
	 * live profile grants and the reviewed exclusive-storage writer fence.
	 * Called before effects, between chunks and before publishing completion.
	 * No permissive production implementation is supplied by this IO layer. */
	assertWritable(
		plan: Readonly<LxdOfficeAdoptionPlan>,
		review: Readonly<LxdOfficeStorageReview>,
		signal: AbortSignal,
	): Promise<void>;
}
export interface LxdOfficeAdoptionFilesOptions {
	readonly binding: LxdOfficeGuestBinding;
	readonly observation: LxdOfficeStorageObservation;
	readonly input: unknown;
	readonly source: OfficeInventorySource;
	readonly limits: OfficeInventoryLimits;
	readonly journalRoot: string;
	readonly reviewPath: string;
}
export interface LxdOfficeAdoptionCopyResult {
	readonly schema: "qorpera.lxd-office-adoption-copy/v1";
	readonly state: "copied";
	readonly adoptionId: string;
	readonly observationSha256: string;
	readonly planSha256: string;
	readonly reviewSha256: string;
	readonly outputInventorySha256: string;
}
async function metadata(path: string, limit: number): Promise<string> {
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const buffer = Buffer.alloc(limit + 1);
		let length = 0;
		while (length < buffer.length) {
			const read = await file.read(buffer, length, buffer.length - length, null);
			if (!read.bytesRead) break;
			length += read.bytesRead;
		}
		if (length > limit) throw new Error("OFFICE_ADOPTION_METADATA_TOO_LARGE");
		return new TextDecoder("utf8", { fatal: true }).decode(buffer.subarray(0, length));
	} finally {
		await file.close();
	}
}
function inodeIdentity(info: BigIntStats) {
	return {
		dev: info.dev.toString(),
		ino: info.ino.toString(),
		uid: Number(info.uid),
		gid: Number(info.gid),
		mode: Number(info.mode & 0o7777n),
	};
}
function assertSource(info: BigIntStats, entry: OfficeInventoryEntry, root = false): void {
	if (
		!isDeepStrictEqual(inodeIdentity(info), {
			dev: entry.dev,
			ino: entry.ino,
			uid: entry.uid,
			gid: entry.gid,
			mode: entry.mode,
		}) ||
		(entry.kind === "directory"
			? !info.isDirectory()
			: !info.isFile() || info.nlink !== 1n || info.size !== BigInt(entry.bytes)) ||
		(!root && (info.ctimeNs.toString() !== entry.ctimeNs || info.mtimeNs.toString() !== entry.mtimeNs))
	)
		throw new Error("OFFICE_ADOPTION_SOURCE_CHANGED");
}
async function sync(file: FileHandle): Promise<void> {
	const writable = await open(`/proc/self/fd/${file.fd}`, constants.O_RDONLY | constants.O_NONBLOCK);
	try {
		await writable.sync();
	} finally {
		await writable.close();
	}
}

/** Verify a real process-owned kernel flock on the private local journal.
 * The provider supervisor must exec this worker under flock --no-fork; a
 * stale lock file, parent-owned lock or another inode is not sufficient. */
export async function assertOfficeAdoptionKernelLock(journalRoot: string): Promise<void> {
	if (process.platform !== "linux" || !process.getuid?.() || process.geteuid?.() !== process.getuid?.())
		throw new Error("OFFICE_ADOPTION_UNPRIVILEGED_LINUX_REQUIRED");
	const status = await metadata("/proc/self/status", 65536);
	const ids = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/m.exec(status);
	if (
		!ids ||
		ids.slice(1).some((id) => Number(id) !== process.getuid!()) ||
		!/^CapEff:\s+0+$/m.test(status) ||
		!/^CapPrm:\s+0+$/m.test(status) ||
		!/^NoNewPrivs:\s+1$/m.test(status)
	)
		throw new Error("OFFICE_ADOPTION_UNPRIVILEGED_LINUX_REQUIRED");
	await checkDirectory(journalRoot);
	const path = join(journalRoot, "adoption.lock");
	const info = await lstat(path, { bigint: true });
	if (
		!info.isFile() ||
		info.uid !== BigInt(process.getuid!()) ||
		(info.mode & 0o7777n) !== 0o600n ||
		info.nlink !== 1n ||
		info.size !== 0n ||
		(await realpath(path)) !== path
	)
		throw new Error("OFFICE_ADOPTION_LOCK_UNPROTECTED");
	const major = ((info.dev >> 8n) & 0xfffn) | ((info.dev >> 32n) & 0xfffff000n);
	const minor = (info.dev & 0xffn) | ((info.dev >> 12n) & 0xffffff00n);
	const matches = (await metadata("/proc/locks", 1048576)).split("\n").filter((line) => {
		const match = /^\d+:\s+FLOCK\s+ADVISORY\s+WRITE\s+(\d+)\s+([0-9a-f]+):([0-9a-f]+):(\d+)\s+0\s+EOF$/.exec(line);
		return (
			match &&
			Number(match[1]) === process.pid &&
			BigInt(`0x${match[2]}`) === major &&
			BigInt(`0x${match[3]}`) === minor &&
			BigInt(match[4]) === info.ino
		);
	});
	if (matches.length !== 1) throw new Error("OFFICE_ADOPTION_KERNEL_LOCK_REQUIRED");
}

class Storage {
	readonly source: OfficeInventorySource;
	readonly root: FileHandle;
	readonly rootMountId: string;
	readonly guard: () => Promise<void>;
	readonly signal: AbortSignal;
	private constructor(
		source: OfficeInventorySource,
		root: FileHandle,
		rootMountId: string,
		guard: () => Promise<void>,
		signal: AbortSignal,
	) {
		this.source = source;
		this.root = root;
		this.rootMountId = rootMountId;
		this.guard = guard;
		this.signal = signal;
	}
	static async open(source: OfficeInventorySource, guard: () => Promise<void>, signal: AbortSignal): Promise<Storage> {
		const root = await open(source.root, O_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW);
		try {
			const fdInfo = await metadata(`/proc/self/fdinfo/${root.fd}`, 4096);
			const id = /^mnt_id:\s+([1-9][0-9]*)$/m.exec(fdInfo)?.[1];
			if (!id || (await realpath(source.root)) !== source.root) throw new Error("OFFICE_ADOPTION_ROOT_UNCONFIRMED");
			const result = new Storage(source, root, id, guard, signal);
			await result.mount();
			await result.safe(root, true);
			return result;
		} catch (error) {
			await root.close();
			throw error;
		}
	}
	async mount(): Promise<void> {
		this.signal.throwIfAborted();
		assertLxdOfficeHostMount(
			await metadata("/proc/self/mountinfo", 1048576),
			await metadata(`/proc/self/fdinfo/${this.root.fd}`, 4096),
			this.source.mount,
			this.source.root,
			this.source.serverAddress,
		);
		const original = await this.root.stat({ bigint: true });
		if (
			!isDeepStrictEqual(inodeIdentity(original), inodeIdentity(await lstat(this.source.root, { bigint: true }))) ||
			(await realpath(this.source.root)) !== this.source.root
		)
			throw new Error("OFFICE_ADOPTION_ROOT_CHANGED");
	}
	async safe(file: FileHandle, directory = false): Promise<BigIntStats> {
		const info = await file.stat({ bigint: true });
		if (
			info.uid !== BigInt(this.source.uid) ||
			info.gid !== BigInt(this.source.gid) ||
			(info.mode & 0o7022n) !== 0n ||
			(directory ? !info.isDirectory() : !info.isDirectory() && !info.isFile()) ||
			/^mnt_id:\s+([1-9][0-9]*)$/m.exec(await metadata(`/proc/self/fdinfo/${file.fd}`, 4096))?.[1] !==
				this.rootMountId
		)
			throw new Error("OFFICE_ADOPTION_INODE_UNSAFE");
		this.signal.throwIfAborted();
		return info;
	}
	async inode(path: string): Promise<FileHandle> {
		const parts = path === "." ? [] : officeAdoptionRelativePath(path).split("/");
		let current = await open(`/proc/self/fd/${this.root.fd}`, O_PATH);
		try {
			for (const name of parts) {
				await this.safe(current, true);
				const next = await open(`/proc/self/fd/${current.fd}/${name}`, O_PATH | constants.O_NOFOLLOW);
				await current.close();
				current = next;
			}
			await this.safe(current);
			return current;
		} catch (error) {
			await current.close();
			throw error;
		}
	}
	async parent(path: string): Promise<{ file: FileHandle; name: string; path: string }> {
		const parts = officeAdoptionRelativePath(path).split("/");
		const name = parts.pop()!;
		const file = await this.inode(parts.join("/") || ".");
		try {
			await this.safe(file, true);
			return { file, name, path: `/proc/self/fd/${file.fd}/${name}` };
		} catch (error) {
			await file.close();
			throw error;
		}
	}
	async ensureDirectory(path: string): Promise<void> {
		const parent = await this.parent(path);
		try {
			await this.guard();
			try {
				await mkdir(parent.path, { mode: 0o700 });
			} catch (error) {
				if (!code(error, "EEXIST")) throw error;
			}
			const file = await this.inode(path);
			try {
				const info = await this.safe(file, true);
				if ((info.mode & 0o7777n) !== 0o700n) throw new Error("OFFICE_ADOPTION_DIRECTORY_MODE_CHANGED");
				await sync(file);
			} finally {
				await file.close();
			}
			await sync(parent.file);
		} finally {
			await parent.file.close();
		}
	}
	async names(directory: FileHandle, maximum: number): Promise<string[]> {
		const handle = await opendir(`/proc/self/fd/${directory.fd}`, { bufferSize: 32 });
		const names = new Set<string>();
		try {
			while (true) {
				this.signal.throwIfAborted();
				const next = await handle.read();
				if (!next) break;
				officeAdoptionRelativePath(next.name);
				if (names.size >= maximum || names.has(next.name)) throw new Error("OFFICE_ADOPTION_UNEXPECTED_ENTRY");
				names.add(next.name);
			}
		} finally {
			await handle.close();
		}
		return [...names].sort();
	}
	async hash(file: FileHandle, expected: OfficeInventoryEntry, output?: FileHandle): Promise<void> {
		const reader = await open(`/proc/self/fd/${file.fd}`, constants.O_RDONLY | constants.O_NONBLOCK);
		try {
			const before = await reader.stat({ bigint: true });
			if (!before.isFile() || before.size !== BigInt(expected.bytes))
				throw new Error("OFFICE_ADOPTION_FILE_CHANGED");
			const hash = createHash("sha256");
			const buffer = Buffer.alloc(Math.min(CHUNK, expected.bytes + 1));
			let offset = 0;
			while (offset <= expected.bytes) {
				await this.guard();
				const read = await reader.read(buffer, 0, Math.min(buffer.length, expected.bytes - offset + 1), offset);
				if (!read.bytesRead) break;
				if (offset + read.bytesRead > expected.bytes) throw new Error("OFFICE_ADOPTION_FILE_CHANGED");
				hash.update(buffer.subarray(0, read.bytesRead));
				if (output) {
					let written = 0;
					while (written < read.bytesRead) {
						await this.guard();
						const result = await output.write(buffer, written, read.bytesRead - written, offset + written);
						if (!result.bytesWritten) throw new Error("OFFICE_ADOPTION_SHORT_WRITE");
						written += result.bytesWritten;
					}
				}
				offset += read.bytesRead;
			}
			const after = await reader.stat({ bigint: true });
			if (
				offset !== expected.bytes ||
				hash.digest("hex") !== expected.sha256 ||
				!isDeepStrictEqual(inodeIdentity(before), inodeIdentity(after)) ||
				before.ctimeNs !== after.ctimeNs ||
				before.mtimeNs !== after.mtimeNs ||
				before.nlink !== after.nlink ||
				before.size !== after.size
			)
				throw new Error("OFFICE_ADOPTION_FILE_CHANGED");
		} finally {
			await reader.close();
		}
	}
	async copy(entry: OfficeInventoryEntry, destination: string, stage: string, mode: number): Promise<void> {
		const source = await this.inode(entry.path);
		try {
			assertSource(await source.stat({ bigint: true }), entry);
			const parent = await this.parent(destination);
			try {
				const temporaryName = `${stage}/${createHash("sha256").update(destination).digest("hex")}`;
				const temporary = await this.parent(temporaryName);
				try {
					let target: FileHandle | undefined;
					try {
						target = await this.inode(destination);
					} catch (error) {
						if (!code(error, "ENOENT")) throw error;
					}
					if (target) {
						try {
							const info = await this.safe(target);
							if (!info.isFile() || Number(info.mode & 0o7777n) !== mode)
								throw new Error("OFFICE_ADOPTION_DESTINATION_CHANGED");
							if (info.nlink === 2n) {
								const staged = await this.inode(temporaryName);
								try {
									const other = await staged.stat({ bigint: true });
									if (other.dev !== info.dev || other.ino !== info.ino)
										throw new Error("OFFICE_ADOPTION_DESTINATION_CHANGED");
								} finally {
									await staged.close();
								}
								await this.guard();
								await unlink(temporary.path);
								await sync(temporary.file);
							} else if (info.nlink !== 1n) throw new Error("OFFICE_ADOPTION_DESTINATION_CHANGED");
							await this.hash(target, entry);
							await sync(target);
							await sync(parent.file);
						} finally {
							await target.close();
						}
					} else {
						// Only an unpromoted temporary in this operation's private
						// journaled staging namespace can be discarded after a crash.
						let stale: FileHandle | undefined;
						try {
							stale = await this.inode(temporaryName);
						} catch (error) {
							if (!code(error, "ENOENT")) throw error;
						}
						if (stale) {
							try {
								const info = await this.safe(stale);
								if (!info.isFile() || info.nlink !== 1n) throw new Error("OFFICE_ADOPTION_STAGING_UNSAFE");
								await this.guard();
								await unlink(temporary.path);
								await sync(temporary.file);
							} finally {
								await stale.close();
							}
						}
						await this.guard();
						const writer = await open(
							temporary.path,
							constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
							0o600,
						);
						try {
							await this.hash(source, entry, writer);
							assertSource(await source.stat({ bigint: true }), entry);
							await writer.chmod(mode);
							await writer.sync();
							await this.guard();
							await link(temporary.path, parent.path);
							const published = await this.inode(destination);
							try {
								const expected = await writer.stat({ bigint: true });
								const actual = await published.stat({ bigint: true });
								if (!isDeepStrictEqual(inodeIdentity(expected), inodeIdentity(actual)) || actual.nlink !== 2n)
									throw new Error("OFFICE_ADOPTION_PUBLICATION_CHANGED");
							} finally {
								await published.close();
							}
							await this.guard();
							await unlink(temporary.path);
							await sync(temporary.file);
							await sync(parent.file);
						} finally {
							await writer.close();
						}
					}
				} finally {
					await temporary.file.close();
				}
			} finally {
				await parent.file.close();
			}
			assertSource(await source.stat({ bigint: true }), entry);
		} finally {
			await source.close();
		}
	}
	async original(observation: LxdOfficeStorageObservation, names: readonly string[]): Promise<void> {
		const expectedNames = new Set(
			observation.inventory.entries.filter((entry) => entry.path !== ".").map((entry) => entry.path.split("/")[0]),
		);
		for (const name of names) expectedNames.add(name);
		for (const actual of await this.names(this.root, observation.inventory.entries.length + names.length))
			if (!expectedNames.has(actual)) throw new Error("OFFICE_ADOPTION_SOURCE_CHANGED");
		for (const entry of observation.inventory.entries) {
			await this.guard();
			const file = await this.inode(entry.path);
			try {
				assertSource(await file.stat({ bigint: true }), entry, entry.path === ".");
				if (entry.kind === "file") await this.hash(file, entry);
			} finally {
				await file.close();
			}
		}
		await this.mount();
	}
}

let pending = false;
/** Actual Linux byte-copy primitive, requiring an external live provider guard
 * and a process-owned kernel lock. It leaves all original bytes in place,
 * publishes only fsynced complete files without overwriting destinations and
 * resumes partial staging after crashes. It grants no guest/client admission,
 * creates no completed boot receipt and is not an autonomous provider worker. */
export async function executeLxdOfficeAdoptionFiles(
	options: LxdOfficeAdoptionFilesOptions,
	guard: LxdOfficeAdoptionGuard,
	caller: AbortSignal,
	settle = false,
): Promise<LxdOfficeAdoptionCopyResult> {
	caller.throwIfAborted();
	if (pending) throw new Error("OFFICE_ADOPTION_IO_PENDING");
	const snapshot = structuredClone(options);
	pending = true;
	const signal = AbortSignal.any([caller, AbortSignal.timeout(300000)]);
	let abort = () => {};
	const stopped = new Promise<never>((_resolve, reject) => {
		abort = () => reject(new Error("OFFICE_ADOPTION_IO_ABORTED"));
		signal.addEventListener("abort", abort, { once: true });
	});
	const operation = execute(snapshot, guard, signal).finally(() => {
		pending = false;
	});
	try {
		return await Promise.race([operation, stopped]);
	} finally {
		signal.removeEventListener("abort", abort);
		if (settle) await operation.catch(() => {});
	}
}
async function execute(
	options: LxdOfficeAdoptionFilesOptions,
	guard: LxdOfficeAdoptionGuard,
	signal: AbortSignal,
): Promise<LxdOfficeAdoptionCopyResult> {
	const limits = parseOfficeInventoryLimits(options.limits);
	const plan = planLxdOfficeAdoption(options.input, options.binding, options.observation);
	for (const entries of [
		options.observation.inventory.entries,
		plan.items.map((item) => ({ path: item.destination, bytes: item.kind === "file" ? item.source!.bytes : 0 })),
	]) {
		if (
			entries.length + 1 > limits.maxEntries ||
			entries.some(
				(entry) =>
					entry.path.split("/").length > limits.maxDepth ||
					!Number.isSafeInteger(entry.bytes) ||
					entry.bytes < 0 ||
					entry.bytes > limits.maxFileBytes,
			) ||
			entries.reduce((sum, entry) => sum + entry.bytes, 0) > limits.maxTotalBytes
		)
			throw new Error("OFFICE_ADOPTION_LIMIT_EXCEEDED");
	}
	if (
		Buffer.byteLength(officeCanonical(options.observation.inventory)) > limits.maxManifestBytes ||
		Buffer.byteLength(officeCanonical(plan)) > limits.maxManifestBytes
	)
		throw new Error("OFFICE_ADOPTION_LIMIT_EXCEEDED");
	const planSha256 = officeDigest(plan);
	const { review, reviewSha256 } = await readLxdOfficeStorageReview(
		options.reviewPath,
		options.observation,
		planSha256,
		signal,
	);
	if (
		options.source.root !== options.binding.workbenchSource ||
		options.source.root !== options.source.mount.mountPoint
	)
		throw new Error("OFFICE_ADOPTION_SOURCE_MISMATCH");
	const authorize = async () => {
		signal.throwIfAborted();
		await assertOfficeAdoptionKernelLock(options.journalRoot);
		await guard.assertWritable(plan, review, signal);
		signal.throwIfAborted();
	};
	await authorize();
	const stage = `.qorpera-adoption-staging-${plan.adoptionId}`;
	if (
		options.observation.inventory.entries.some((entry) => entry.path === stage || entry.path.startsWith(`${stage}/`))
	)
		throw new Error("OFFICE_ADOPTION_STAGING_ALREADY_EXISTS");
	const authority = {
		schema: "qorpera.lxd-office-adoption-authority/v1",
		planSha256,
		reviewSha256,
		observationSha256: plan.observationSha256,
	};
	const name = `adoption-${plan.adoptionId}.json`;
	let existing: unknown;
	try {
		existing = (await readRecord(join(options.journalRoot, name))).value;
	} catch (error) {
		if (!code(error, "ENOENT")) throw error;
	}
	if (existing === undefined) {
		if (
			officeDigest(await inspectOfficeStorage(options.source, limits, signal)) !==
			officeDigest(options.observation.inventory)
		)
			throw new Error("OFFICE_ADOPTION_SOURCE_CHANGED");
		await authorize();
		await publish(options.journalRoot, name, Buffer.from(officeCanonical(authority)));
		existing = (await readRecord(join(options.journalRoot, name))).value;
	}
	if (!isDeepStrictEqual(existing, authority)) throw new Error("OFFICE_ADOPTION_JOURNAL_MISMATCH");
	const storage = await Storage.open(options.source, authorize, signal);
	try {
		if (storage.rootMountId !== options.observation.inventory.mountId)
			throw new Error("OFFICE_ADOPTION_MOUNT_CHANGED");
		await storage.original(options.observation, [plan.destinationName, stage]);
		await storage.ensureDirectory(plan.destinationName);
		await storage.ensureDirectory(stage);
		for (const item of plan.items) {
			await authorize();
			const destination = `${plan.destinationName}/${item.destination}`;
			if (item.kind === "directory") await storage.ensureDirectory(destination);
			else {
				if (!item.source) throw new Error("OFFICE_ADOPTION_SOURCE_MISSING");
				await storage.copy(item.source, destination, stage, item.mode);
			}
		}
		await storage.original(options.observation, [plan.destinationName, stage]);
		const staged = await storage.inode(stage);
		try {
			if ((await storage.names(staged, plan.items.length + 1)).length)
				throw new Error("OFFICE_ADOPTION_STAGING_NOT_EMPTY");
		} finally {
			await staged.close();
		}
		const output = await inspectOfficeStorage(
			{ ...options.source, root: `${options.source.root}/${plan.destinationName}` },
			limits,
			signal,
		);
		const outputByPath = new Map(output.entries.map((entry) => [entry.path, entry]));
		if (
			output.entries.length !== plan.items.length + 1 ||
			plan.items.some((item) => {
				const actual = outputByPath.get(item.destination);
				return (
					!actual ||
					actual.kind !== item.kind ||
					actual.mode !== item.mode ||
					actual.bytes !== (item.kind === "file" ? item.source!.bytes : 0) ||
					actual.sha256 !== (item.kind === "file" ? item.source!.sha256 : null)
				);
			})
		)
			throw new Error("OFFICE_ADOPTION_OUTPUT_MISMATCH");
		await storage.mount();
		await authorize();
		const result: LxdOfficeAdoptionCopyResult = Object.freeze({
			schema: "qorpera.lxd-office-adoption-copy/v1",
			state: "copied",
			adoptionId: plan.adoptionId,
			observationSha256: plan.observationSha256,
			planSha256,
			reviewSha256,
			outputInventorySha256: officeDigest(output),
		});
		const completed = `adoption-result-${plan.adoptionId}.json`;
		await publish(options.journalRoot, completed, Buffer.from(officeCanonical(result)));
		if (!isDeepStrictEqual((await readRecord(join(options.journalRoot, completed))).value, result))
			throw new Error("OFFICE_ADOPTION_RESULT_CHANGED");
		await authorize();
		return result;
	} finally {
		await storage.root.close();
	}
}
