import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { boundedObjectOperation, ObjectDependencyError, type ObjectDependencyHealth } from "./dependency.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export type ObjectWriteResult = "exists" | "stored";

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
		const created = await mkdir(parent, { recursive: true, mode: 0o700 });
		if (created) {
			for (let directory = parent; ; directory = dirname(directory)) {
				await this.#sync(directory);
				if (directory === dirname(created)) break;
			}
		}
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

	async #sync(path: string): Promise<void> {
		if (process.platform === "win32") return;
		const directory = await open(path, "r");
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
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
