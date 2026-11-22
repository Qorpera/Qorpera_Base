import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm, rmdir, stat } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { ObjectDependencyError, type ObjectDependencyHealth } from "./dependency.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const QUARANTINE = ".quarantine";
const MAX_QUARANTINED_BYTES = 8 * 1024 * 1024;
// WHY: a timed-out hard-NFS syscall keeps its libuv worker until the OS lets go. Two lanes leave at least two of
// the four default workers to the journal, so more lanes require a larger UV_THREADPOOL_SIZE first.
const DEFAULT_LANES = 2;
const MAX_LANES = 16;
const MIN_RESERVED_WORKERS = 2;
const MAX_UV_THREADPOOL_SIZE = 1024;
const MAX_INT32 = 2_147_483_647;
const MAX_KNOWN_DIRS = 4_096;
const MAX_WAITING = 512;

export function resolveObjectStoreLanes(environment: NodeJS.ProcessEnv): number {
	let lanes = DEFAULT_LANES;
	if (environment.QORPERA_OBJECT_GATEWAY_NAS_LANES !== undefined) {
		const rawLanes = environment.QORPERA_OBJECT_GATEWAY_NAS_LANES.trim();
		if (!/^[1-9][0-9]*$/.test(rawLanes)) throw new Error("QORPERA_OBJECT_GATEWAY_NAS_LANES is invalid");
		lanes = Number(rawLanes);
		if (!Number.isSafeInteger(lanes) || lanes < 1 || lanes > MAX_LANES)
			throw new Error("QORPERA_OBJECT_GATEWAY_NAS_LANES is invalid");
	}
	let poolSize = 4;
	if (environment.UV_THREADPOOL_SIZE !== undefined) {
		const rawPool = environment.UV_THREADPOOL_SIZE.trim();
		if (!/^[1-9][0-9]*$/.test(rawPool)) throw new Error("UV_THREADPOOL_SIZE is invalid");
		const parsedPool = Number(rawPool);
		if (!Number.isSafeInteger(parsedPool) || parsedPool > MAX_INT32) throw new Error("UV_THREADPOOL_SIZE is invalid");
		poolSize = Math.min(MAX_UV_THREADPOOL_SIZE, parsedPool);
	}
	if (poolSize - lanes < MIN_RESERVED_WORKERS)
		throw new Error(
			`QORPERA_OBJECT_GATEWAY_NAS_LANES=${lanes} requires UV_THREADPOOL_SIZE>=${lanes + MIN_RESERVED_WORKERS} to reserve workers for the journal`,
		);
	return lanes;
}

interface Lane {
	overdue: boolean;
}

interface Waiting {
	readonly key: string;
	start(): void;
	refuse(): void;
}

export type ObjectWriteResult = "exists" | "stored";

/** One entry of folder GC's quarantine (C1D §9.8), under a GC lease: an object's NAS file moved aside (`file`), or,
 * when the object had no NAS file, a marker that its Storage replica is the only copy (`replica`). `bytes` is the
 * object's size: the file's, or the one the marker's name holds. */
export interface QuarantinedObject {
	/** `<profileId>/<file name>`, where a later listing goes on from. */
	name: string;
	profileId: string;
	sha256: string;
	leaseId: string;
	bytes: number;
	kind: "file" | "replica";
}

const VERIFIED_BYTES = Symbol("verified-object-bytes");

export interface VerifiedObjectBytes {
	readonly [VERIFIED_BYTES]: { readonly sha256: string; readonly bytes: Uint8Array };
	readonly sha256: string;
	readonly bytes: Uint8Array;
}

function digest(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export function verifyObjectBytes(sha256: string, bytes: Uint8Array): VerifiedObjectBytes {
	if (!SHA256_PATTERN.test(sha256) || digest(bytes) !== sha256)
		throw new Error("Object bytes do not match their SHA-256 address");
	return Object.freeze({ [VERIFIED_BYTES]: Object.freeze({ sha256, bytes }), sha256, bytes });
}

export function hashAndVerifyObjectBytes(bytes: Uint8Array): VerifiedObjectBytes {
	const sha256 = digest(bytes);
	return Object.freeze({ [VERIFIED_BYTES]: Object.freeze({ sha256, bytes }), sha256, bytes });
}

export function isVerifiedObjectBytes(
	value: VerifiedObjectBytes | undefined,
	sha256: string,
	bytes: Uint8Array,
): boolean {
	if (!value) return false;
	const proven = value[VERIFIED_BYTES];
	return proven !== undefined && proven.sha256 === sha256 && proven.bytes === bytes;
}

export class FileSystemObjectStore {
	readonly #root: string;
	readonly #timeoutMs: number;
	readonly #waitMs: number;
	readonly #lanes: number;
	readonly #inFlight = new Map<string, Lane>();
	readonly #waiting = new Set<Waiting>();
	readonly #reading = new Map<string, Promise<Uint8Array>>();
	readonly #knownDirs = new Set<string>();
	readonly #creatingDirs = new Map<string, Promise<void>>();
	#health: ObjectDependencyHealth = { status: "unknown" };

	constructor(root: string, timeoutMs = 5_000, waitMs = 2_000, lanes = DEFAULT_LANES) {
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000)
			throw new Error("Object operation deadline is invalid");
		if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 30_000)
			throw new Error("Object operation wait is invalid");
		if (!Number.isSafeInteger(lanes) || lanes < 1 || lanes > MAX_LANES)
			throw new Error("Object operation lanes are invalid");
		this.#root = resolve(root);
		this.#timeoutMs = timeoutMs;
		this.#waitMs = waitMs;
		this.#lanes = lanes;
	}

	async put(
		profileId: string,
		sha256: string,
		bytes: Uint8Array,
		verified?: VerifiedObjectBytes,
	): Promise<ObjectWriteResult> {
		return this.#io(this.#objectPath(profileId, sha256), (signal) =>
			this.#put(profileId, sha256, bytes, verified, signal),
		);
	}

	dependencyHealth(): ObjectDependencyHealth {
		return { ...this.#health };
	}

	async probe(): Promise<void> {
		try {
			await this.#io("probe", async (signal) => {
				signal.throwIfAborted();
				const path = resolve(this.#root, `.gateway-health-${randomUUID()}`);
				const handle = await open(path, "wx", 0o600);
				try {
					signal.throwIfAborted();
					await handle.writeFile("health");
					signal.throwIfAborted();
					await handle.sync();
				} finally {
					await handle.close();
					await rm(path, { force: true });
				}
			});
			this.#health = { status: "healthy", checkedAt: new Date().toISOString() };
		} catch {
			this.#health = { status: "unavailable", checkedAt: new Date().toISOString() };
		}
	}

	async #put(
		profileId: string,
		sha256: string,
		bytes: Uint8Array,
		verified?: VerifiedObjectBytes,
		signal?: AbortSignal,
	): Promise<ObjectWriteResult> {
		signal?.throwIfAborted();
		if (!isVerifiedObjectBytes(verified, sha256, bytes) && digest(bytes) !== sha256)
			throw new Error("Object bytes do not match their SHA-256 address");
		const path = this.#objectPath(profileId, sha256);
		const parent = resolve(path, "..");
		try {
			await this.#get(profileId, sha256, bytes.byteLength, signal);
			return "exists";
		} catch (error) {
			if (!(error instanceof Error) || error.message !== "Object not found") throw error;
		}
		signal?.throwIfAborted();
		const temporary = `${path}.${randomUUID()}.tmp`;
		if (!this.#knownDirs.has(parent)) {
			await this.#directories(parent);
			this.#rememberDir(parent);
		}
		signal?.throwIfAborted();
		let renamed = false;
		try {
			let handle: Awaited<ReturnType<typeof open>>;
			try {
				handle = await open(temporary, "wx", 0o600);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				signal?.throwIfAborted();
				this.#knownDirs.delete(parent);
				await this.#directories(parent);
				this.#rememberDir(parent);
				signal?.throwIfAborted();
				handle = await open(temporary, "wx", 0o600);
			}
			try {
				await handle.writeFile(bytes);
				await handle.sync();
			} finally {
				await handle.close();
			}
			await rename(temporary, path);
			renamed = true;
			await this.#sync(parent);
		} finally {
			if (!renamed) await rm(temporary, { force: true });
		}
		return "stored";
	}

	get(profileId: string, sha256: string, expectedBytes: number): Promise<Uint8Array> {
		let path: string;
		try {
			path = this.#objectPath(profileId, sha256);
		} catch (error) {
			return Promise.reject(error);
		}
		const shared = `${path}:${expectedBytes}`;
		const underWay = this.#reading.get(shared);
		if (underWay) return underWay;
		const reading = this.#io(path, (signal) => this.#get(profileId, sha256, expectedBytes, signal));
		this.#reading.set(shared, reading);
		const settled = () => {
			if (this.#reading.get(shared) === reading) this.#reading.delete(shared);
		};
		reading.then(settled, settled);
		return reading;
	}

	getVerified(profileId: string, sha256: string, maxBytes = MAX_QUARANTINED_BYTES): Promise<Uint8Array> {
		if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_QUARANTINED_BYTES)
			return Promise.reject(new Error("Object size limit is invalid"));
		let path: string;
		try {
			path = this.#objectPath(profileId, sha256);
		} catch (error) {
			return Promise.reject(error);
		}
		const shared = `${path}:verified:${maxBytes}`;
		const underWay = this.#reading.get(shared);
		if (underWay) return underWay;
		const reading = this.#io(path, (signal) => this.#getVerified(profileId, sha256, maxBytes, signal));
		this.#reading.set(shared, reading);
		const settled = () => {
			if (this.#reading.get(shared) === reading) this.#reading.delete(shared);
		};
		reading.then(settled, settled);
		return reading;
	}

	async #get(profileId: string, sha256: string, expectedBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
		signal?.throwIfAborted();
		const path = this.#objectPath(profileId, sha256);
		try {
			const info = await stat(path);
			signal?.throwIfAborted();
			if (!info.isFile() || info.size !== expectedBytes) {
				throw new Error("Stored object failed integrity verification");
			}
			const bytes = await readFile(path, signal ? { signal } : undefined);
			if (bytes.byteLength !== expectedBytes || digest(bytes) !== sha256)
				throw new Error("Stored object failed integrity verification");
			return bytes;
		} catch (error) {
			if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
				throw new Error("Object not found");
			}
			throw error;
		}
	}

	async #getVerified(profileId: string, sha256: string, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
		signal?.throwIfAborted();
		const path = this.#objectPath(profileId, sha256);
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		try {
			handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
			signal?.throwIfAborted();
			const info = await handle.stat();
			if (!info.isFile() || info.size > maxBytes) {
				throw new Error("Stored object failed integrity verification");
			}
			const buffer = Buffer.allocUnsafe(info.size);
			let offset = 0;
			while (offset < info.size) {
				signal?.throwIfAborted();
				const { bytesRead } = await handle.read(buffer, offset, info.size - offset, offset);
				if (bytesRead === 0) throw new Error("Stored object failed integrity verification");
				offset += bytesRead;
			}
			signal?.throwIfAborted();
			const extra = Buffer.allocUnsafe(1);
			const trailing = await handle.read(extra, 0, 1, offset);
			if (trailing.bytesRead > 0 || digest(buffer) !== sha256)
				throw new Error("Stored object failed integrity verification");
			return buffer;
		} catch (error) {
			if (error && typeof error === "object" && "code" in error) {
				if (error.code === "ENOENT") throw new Error("Object not found");
				if (error.code === "ELOOP") throw new Error("Stored object failed integrity verification");
			}
			throw error;
		} finally {
			await handle?.close().catch(() => undefined);
		}
	}

	async remove(profileId: string, sha256: string): Promise<void> {
		const path = this.#objectPath(profileId, sha256);
		await this.#io(path, async () => {
			await rm(path, { force: true });
			try {
				await this.#sync(dirname(path));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		});
	}

	/** Folder GC's quarantine (C1D §9.8): the object's NAS file moves to `<root>/.quarantine/<profileId>/
	 * <sha256>.<leaseId>`, one rename on the same file system, and both directories are synced. `moved` also when this
	 * lease moved it before (a lane sent again); `absent` when there is no NAS file. */
	async quarantine(profileId: string, sha256: string, leaseId: string): Promise<"moved" | "absent"> {
		const source = this.#objectPath(profileId, sha256);
		const target = this.#quarantinePath(profileId, sha256, leaseId);
		return this.#io(source, async (signal) => {
			// The scan may remove an empty company folder between its mkdir (or the mkdir's sync) and the rename: then
			// both are asked once more, so a NAS file that is still there is never taken for an absent one.
			for (let attempt = 1; ; attempt++) {
				signal.throwIfAborted();
				try {
					await this.#directories(dirname(target));
					signal.throwIfAborted();
					await rename(source, target);
					break;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					signal.throwIfAborted();
					if (!(await this.#exists(source))) {
						if (!(await this.#exists(target))) return "absent";
						// This lease moved it before; that lane may have stopped before its syncs.
						break;
					}
					if (attempt === 2) throw error;
				}
			}
			await this.#sync(dirname(source));
			await this.#sync(dirname(target));
			return "moved";
		});
	}

	/** Before the finish of an object with no NAS file: an empty marker `<sha256>.<leaseId>.<bytes>.replica` in the
	 * quarantine directory says its Storage replica is the only copy, so a lane that stops after the finish leaves
	 * the scan something to find. The name is the whole record, so creating it is one atomic step. */
	async markReplicaOnly(profileId: string, sha256: string, leaseId: string, bytes: number): Promise<void> {
		if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_QUARANTINED_BYTES)
			throw new Error("Object size is invalid");
		const marker = `${this.#quarantinePath(profileId, sha256, leaseId)}.${bytes}.replica`;
		await this.#io(marker, async (signal) => {
			for (let attempt = 1; ; attempt++) {
				signal.throwIfAborted();
				try {
					await this.#directories(dirname(marker));
					signal.throwIfAborted();
					const handle = await open(marker, "w", 0o600);
					try {
						await handle.sync();
					} finally {
						await handle.close();
					}
					break;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT" || attempt === 2) throw error;
				}
			}
			await this.#sync(dirname(marker));
		});
	}

	/** Puts a quarantined object back: its file is renamed to the object's NAS path (replacing a copy put there since,
	 * which has the same bytes) and both directories are synced; its marker, if any, is removed. */
	async restoreQuarantined(profileId: string, sha256: string, leaseId: string, bytes: number): Promise<void> {
		const source = this.#quarantinePath(profileId, sha256, leaseId);
		const target = this.#objectPath(profileId, sha256);
		await this.#io(target, async (signal) => {
			signal.throwIfAborted();
			await this.#directories(dirname(target));
			signal.throwIfAborted();
			let moved = true;
			try {
				await rename(source, target);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				moved = false;
			}
			if (moved) await this.#sync(dirname(target));
			await rm(`${source}.${bytes}.replica`, { force: true });
			await this.#sync(dirname(source)).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
			});
		});
	}

	/** Whether a quarantine entry is still there. */
	async isQuarantined(entry: QuarantinedObject): Promise<boolean> {
		const path = this.#quarantinePath(entry.profileId, entry.sha256, entry.leaseId);
		const name = entry.kind === "file" ? path : `${path}.${entry.bytes}.replica`;
		return this.#io(name, () => this.#exists(name));
	}

	/** Removes a quarantined object's file and marker for good. */
	async removeQuarantined(profileId: string, sha256: string, leaseId: string, bytes: number): Promise<void> {
		const path = this.#quarantinePath(profileId, sha256, leaseId);
		await this.#io(path, async () => {
			await rm(path, { force: true });
			await rm(`${path}.${bytes}.replica`, { force: true });
			await this.#sync(dirname(path)).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
			});
		});
	}

	/** Up to `limit` quarantine entries, by company and name, after `after` (an entry's `<profileId>/<name>`). A
	 * company folder found empty is removed (a lane that meets the removal asks its rename again); a name that is not
	 * an entry is left alone. */
	async listQuarantine(limit: number, after?: string): Promise<QuarantinedObject[]> {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
			throw new Error("Quarantine batch limit is invalid");
		const root = resolve(this.#root, QUARANTINE);
		return this.#io(root, async (signal) => {
			signal.throwIfAborted();
			let companies: string[];
			try {
				companies = await readdir(root);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
				throw error;
			}
			const found: QuarantinedObject[] = [];
			const [afterCompany, afterName] = after === undefined ? [] : after.split("/");
			for (const profileId of companies
				.filter((name) => UUID_PATTERN.test(name) && (afterCompany === undefined || name >= afterCompany))
				.sort()) {
				signal.throwIfAborted();
				const folder = resolve(root, profileId);
				let names: string[];
				try {
					names = await readdir(folder);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
					throw error;
				}
				if (names.length === 0) {
					signal.throwIfAborted();
					await rmdir(folder).catch(() => undefined);
					continue;
				}
				for (const name of names.sort()) {
					signal.throwIfAborted();
					if (profileId === afterCompany && afterName !== undefined && name <= afterName) continue;
					// `<sha256>.<leaseId>`, or a marker `<sha256>.<leaseId>.<bytes>.replica`.
					const [sha256, leaseId, markerBytes, suffix, ...rest] = name.split(".");
					if (
						!SHA256_PATTERN.test(sha256 ?? "") ||
						!UUID_PATTERN.test(leaseId ?? "") ||
						rest.length > 0 ||
						(markerBytes === undefined
							? suffix !== undefined
							: suffix !== "replica" || !/^(0|[1-9][0-9]{0,6})$/.test(markerBytes))
					)
						continue;
					let bytes: number;
					if (markerBytes !== undefined) bytes = Number(markerBytes);
					else {
						const info = await stat(resolve(folder, name)).catch((error: NodeJS.ErrnoException) => {
							if (error.code === "ENOENT") return undefined;
							throw error;
						});
						if (!info?.isFile()) continue;
						bytes = info.size;
					}
					if (bytes > MAX_QUARANTINED_BYTES) continue;
					found.push({
						name: `${profileId}/${name}`,
						profileId,
						sha256: sha256!,
						leaseId: leaseId!,
						bytes,
						kind: markerBytes === undefined ? "file" : "replica",
					});
					if (found.length >= limit) return found;
				}
			}
			return found;
		});
	}

	#io<T>(key: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const start = () => {
				const lane: Lane = { overdue: false };
				const controller = new AbortController();
				this.#inFlight.set(key, lane);
				const deadline = setTimeout(() => {
					lane.overdue = true;
					const error = new ObjectDependencyError(503);
					controller.abort(error);
					reject(error);
					this.#refuseStranded();
				}, this.#timeoutMs);
				const settled = () => {
					clearTimeout(deadline);
					this.#inFlight.delete(key);
					this.#admit();
				};
				Promise.resolve()
					.then(() => operation(controller.signal))
					.then(resolve, reject)
					.then(settled, settled);
			};
			if (this.#stranded(key)) {
				reject(new ObjectDependencyError(503));
				return;
			}
			if (this.#open(key) && !this.#queued(key)) {
				start();
				return;
			}
			if (this.#waiting.size >= MAX_WAITING || this.#waitMs === 0) {
				reject(new ObjectDependencyError(503));
				return;
			}
			const waiting: Waiting = {
				key,
				start: () => {
					clearTimeout(patience);
					start();
				},
				refuse: () => {
					clearTimeout(patience);
					reject(new ObjectDependencyError(503));
				},
			};
			const patience = setTimeout(() => {
				this.#waiting.delete(waiting);
				waiting.refuse();
			}, this.#waitMs);
			this.#waiting.add(waiting);
		});
	}

	#open(key: string): boolean {
		return !this.#inFlight.has(key) && this.#inFlight.size < this.#lanes;
	}

	#queued(key: string): boolean {
		for (const waiting of this.#waiting) if (waiting.key === key) return true;
		return false;
	}

	#stranded(key: string): boolean {
		if (this.#inFlight.get(key)?.overdue) return true;
		if (this.#inFlight.size < this.#lanes) return false;
		for (const lane of this.#inFlight.values()) if (!lane.overdue) return false;
		return true;
	}

	#refuseStranded(): void {
		for (const waiting of [...this.#waiting]) {
			if (!this.#stranded(waiting.key)) continue;
			this.#waiting.delete(waiting);
			waiting.refuse();
		}
	}

	#admit(): void {
		const behind = new Set<string>();
		for (const waiting of [...this.#waiting]) {
			if (this.#inFlight.size >= this.#lanes) return;
			if (behind.has(waiting.key) || this.#inFlight.has(waiting.key)) {
				behind.add(waiting.key);
				continue;
			}
			this.#waiting.delete(waiting);
			waiting.start();
		}
	}

	#rememberDir(directory: string): void {
		this.#knownDirs.delete(directory);
		if (this.#knownDirs.size >= MAX_KNOWN_DIRS) {
			const oldest = this.#knownDirs.values().next().value;
			if (oldest !== undefined) this.#knownDirs.delete(oldest);
		}
		this.#knownDirs.add(directory);
	}

	/** Creates a directory and its missing parents, syncing each new name into its parent. */
	async #directories(path: string): Promise<void> {
		const existing = this.#creatingDirs.get(path);
		if (existing) return existing;
		const pending = (async () => {
			const created = await mkdir(path, { recursive: true, mode: 0o700 });
			if (!created) return;
			for (let directory = path; ; directory = dirname(directory)) {
				await this.#sync(directory);
				if (directory === dirname(created)) break;
			}
		})();
		this.#creatingDirs.set(path, pending);
		try {
			await pending;
		} finally {
			if (this.#creatingDirs.get(path) === pending) this.#creatingDirs.delete(path);
		}
	}

	async #exists(path: string): Promise<boolean> {
		try {
			await stat(path);
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw error;
		}
	}

	async #sync(path: string): Promise<void> {
		if (process.platform === "win32") return;
		const directory = await open(path, "r");
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
	}

	#quarantinePath(profileId: string, sha256: string, leaseId: string): string {
		this.#objectPath(profileId, sha256);
		if (!UUID_PATTERN.test(leaseId)) throw new Error("GC lease is invalid");
		return resolve(this.#root, QUARANTINE, profileId, `${sha256}.${leaseId}`);
	}

	#objectPath(profileId: string, sha256: string): string {
		if (!UUID_PATTERN.test(profileId) || !SHA256_PATTERN.test(sha256)) {
			throw new Error("Object identity is invalid");
		}
		const path = resolve(this.#root, profileId, sha256);
		if (!path.startsWith(`${this.#root}${sep}`)) throw new Error("Object path escapes the storage root");
		return path;
	}
}
