import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, rmdir, stat } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { boundedObjectOperation, ObjectDependencyError, type ObjectDependencyHealth } from "./dependency.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const QUARANTINE = ".quarantine";
const MAX_QUARANTINED_BYTES = 8 * 1024 * 1024;

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

function digest(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export class FileSystemObjectStore {
	readonly #root: string;
	readonly #timeoutMs: number;
	readonly #inFlight = new Set<string>();
	#health: ObjectDependencyHealth = { status: "unknown" };

	constructor(root: string, timeoutMs = 5_000) {
		this.#root = resolve(root);
		this.#timeoutMs = timeoutMs;
	}

	async put(profileId: string, sha256: string, bytes: Uint8Array): Promise<ObjectWriteResult> {
		return this.#io(this.#objectPath(profileId, sha256), () => this.#put(profileId, sha256, bytes));
	}

	dependencyHealth(): ObjectDependencyHealth {
		return { ...this.#health };
	}

	async probe(): Promise<void> {
		try {
			await this.#io("probe", async () => {
				const path = resolve(this.#root, `.gateway-health-${randomUUID()}`);
				const handle = await open(path, "wx", 0o600);
				try {
					await handle.writeFile("health");
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

	async #put(profileId: string, sha256: string, bytes: Uint8Array): Promise<ObjectWriteResult> {
		if (digest(bytes) !== sha256) throw new Error("Object bytes do not match their SHA-256 address");
		const path = this.#objectPath(profileId, sha256);
		const parent = resolve(path, "..");
		try {
			const existing = await this.#get(profileId, sha256, bytes.byteLength);
			if (digest(existing) !== sha256) throw new Error("Stored object failed integrity verification");
			return "exists";
		} catch (error) {
			if (!(error instanceof Error) || error.message !== "Object not found") throw error;
		}
		const temporary = `${path}.${randomUUID()}.tmp`;
		await this.#directories(parent);
		try {
			const handle = await open(temporary, "wx", 0o600);
			try {
				await handle.writeFile(bytes);
				await handle.sync();
			} finally {
				await handle.close();
			}
			await rename(temporary, path);
			await this.#sync(parent);
		} finally {
			await rm(temporary, { force: true });
		}
		return "stored";
	}

	async get(profileId: string, sha256: string, expectedBytes: number): Promise<Uint8Array> {
		return this.#io(this.#objectPath(profileId, sha256), () => this.#get(profileId, sha256, expectedBytes));
	}

	async #get(profileId: string, sha256: string, expectedBytes: number): Promise<Uint8Array> {
		const path = this.#objectPath(profileId, sha256);
		try {
			const info = await stat(path);
			if (!info.isFile() || info.size !== expectedBytes) {
				throw new Error("Stored object failed integrity verification");
			}
			const bytes = await readFile(path);
			if (digest(bytes) !== sha256) throw new Error("Stored object failed integrity verification");
			return bytes;
		} catch (error) {
			if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
				throw new Error("Object not found");
			}
			throw error;
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
		return this.#io(source, async () => {
			// The scan may remove an empty company folder between its mkdir (or the mkdir's sync) and the rename: then
			// both are asked once more, so a NAS file that is still there is never taken for an absent one.
			for (let attempt = 1; ; attempt++) {
				try {
					await this.#directories(dirname(target));
					await rename(source, target);
					break;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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
		await this.#io(marker, async () => {
			for (let attempt = 1; ; attempt++) {
				try {
					await this.#directories(dirname(marker));
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
		await this.#io(target, async () => {
			await this.#directories(dirname(target));
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
		return this.#io(root, async () => {
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
				const folder = resolve(root, profileId);
				let names: string[];
				try {
					names = await readdir(folder);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
					throw error;
				}
				if (names.length === 0) {
					await rmdir(folder).catch(() => undefined);
					continue;
				}
				for (const name of names.sort()) {
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

	async #io<T>(key: string, operation: () => Promise<T>): Promise<T> {
		// A timed-out hard-NFS syscall can remain in the OS. Keep its slot until
		// it actually settles: no unbounded queue, no delete overtaking a late
		// write, and at least two default libuv workers remain for the journal.
		if (this.#inFlight.has(key) || this.#inFlight.size >= 2) throw new ObjectDependencyError(503);
		this.#inFlight.add(key);
		const pending = Promise.resolve().then(operation);
		void pending.then(
			() => this.#inFlight.delete(key),
			() => this.#inFlight.delete(key),
		);
		return boundedObjectOperation(() => pending, this.#timeoutMs);
	}

	/** Creates a directory and its missing parents, syncing each new name into its parent. */
	async #directories(path: string): Promise<void> {
		const created = await mkdir(path, { recursive: true, mode: 0o700 });
		if (!created) return;
		for (let directory = path; ; directory = dirname(directory)) {
			await this.#sync(directory);
			if (directory === dirname(created)) break;
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
