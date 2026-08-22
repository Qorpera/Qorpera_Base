import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export type ObjectWriteResult = "exists" | "stored";

function digest(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export class FileSystemObjectStore {
	readonly #root: string;

	constructor(root: string) {
		this.#root = resolve(root);
	}

	async put(profileId: string, sha256: string, bytes: Uint8Array): Promise<ObjectWriteResult> {
		if (digest(bytes) !== sha256) throw new Error("Object bytes do not match their SHA-256 address");
		const path = this.#objectPath(profileId, sha256);
		const parent = resolve(path, "..");
		try {
			const existing = await this.get(profileId, sha256, bytes.byteLength);
			if (digest(existing) !== sha256) throw new Error("Stored object failed integrity verification");
			return "exists";
		} catch (error) {
			if (!(error instanceof Error) || error.message !== "Object not found") throw error;
		}
		const temporary = `${path}.${randomUUID()}.tmp`;
		await mkdir(parent, { recursive: true, mode: 0o700 });
		try {
			const handle = await open(temporary, "wx", 0o600);
			try {
				await handle.writeFile(bytes);
				await handle.sync();
			} finally {
				await handle.close();
			}
			await rename(temporary, path);
			if (process.platform !== "win32") {
				const directory = await open(parent, "r");
				try {
					await directory.sync();
				} finally {
					await directory.close();
				}
			}
		} finally {
			await rm(temporary, { force: true });
		}
		return "stored";
	}

	async get(profileId: string, sha256: string, expectedBytes: number): Promise<Uint8Array> {
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
		await rm(this.#objectPath(profileId, sha256), { force: true });
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
