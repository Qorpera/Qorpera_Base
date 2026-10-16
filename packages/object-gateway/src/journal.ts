import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_RECORDS = 10_000;
const MAX_AUDIT_BYTES = 128 * 1024 * 1024;

/** Private, single-service-writer cloud state. Never put this on a worker disk or in Company File. */
export class ObjectGatewayJournal {
	readonly #root: string;
	readonly #maxRecords: number;
	readonly #locks = new Map<string, Promise<unknown>>();

	constructor(root: string, maxRecords = MAX_RECORDS) {
		if (!isAbsolute(root) || /[\0\r\n]/.test(root) || resolve(root) === "/") {
			throw new Error("Gateway journal root must be a private absolute directory");
		}
		this.#root = resolve(root);
		if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > MAX_RECORDS)
			throw new Error("Gateway journal capacity is invalid");
		this.#maxRecords = maxRecords;
	}

	async exclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.#locks.get(key) ?? Promise.resolve();
		const pending = previous.catch(() => undefined).then(operation);
		this.#locks.set(key, pending);
		try {
			return await pending;
		} finally {
			if (this.#locks.get(key) === pending) this.#locks.delete(key);
		}
	}

	async read(key: string): Promise<unknown | undefined> {
		const path = this.#path(key);
		await this.#directory(dirname(path));
		try {
			const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
			try {
				const metadata = await handle.stat();
				this.#private(metadata.mode, metadata.uid);
				if (!metadata.isFile() || metadata.size > MAX_RECORD_BYTES)
					throw new Error("Gateway journal record is invalid");
				return JSON.parse(await handle.readFile("utf-8")) as unknown;
			} finally {
				await handle.close();
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}

	async write(key: string, value: unknown): Promise<void> {
		const path = this.#path(key);
		// Updates remain possible at capacity so reconciliation can drain work.
		// Serialize admission before any bytes can be acknowledged without an intent.
		await this.exclusive(`capacity:${dirname(path)}`, () => this.#write(path, value));
	}

	async #write(path: string, value: unknown): Promise<void> {
		const encoded = JSON.stringify(value);
		if (encoded === undefined || Buffer.byteLength(encoded) > MAX_RECORD_BYTES)
			throw new Error("Gateway journal record exceeds its limit");
		const parent = dirname(path);
		await this.#directory(parent);
		try {
			const current = await lstat(path);
			this.#private(current.mode, current.uid);
			if (!current.isFile() || current.isSymbolicLink()) throw new Error("Gateway journal target is invalid");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			const entries = await readdir(parent);
			if (entries.length >= this.#maxRecords)
				throw new Error("Gateway journal capacity requires operator attention");
		}
		const temporary = join(parent, `.${randomUUID()}.tmp`);
		try {
			const handle = await open(
				temporary,
				constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
				0o600,
			);
			try {
				await handle.writeFile(`${encoded}\n`);
				await handle.sync();
			} finally {
				await handle.close();
			}
			await rename(temporary, path);
			await this.#sync(parent);
		} finally {
			await rm(temporary, { force: true });
		}
	}

	async remove(key: string): Promise<void> {
		const path = this.#path(key);
		await this.#directory(dirname(path));
		await rm(path, { force: true });
		await this.#sync(dirname(path));
	}

	async list(section: "pending"): Promise<string[]> {
		const directory = join(this.#root, section);
		await this.#directory(directory);
		const entries = await readdir(directory, { withFileTypes: true });
		if (entries.length > this.#maxRecords) throw new Error("Gateway journal capacity requires operator attention");
		return entries
			.filter((entry) => !entry.name.startsWith("."))
			.map((entry) => {
				if (!entry.isFile() || !/^[a-z0-9-]+\.json$/.test(entry.name))
					throw new Error("Gateway journal entry is invalid");
				return `${section}/${entry.name.slice(0, -5)}`;
			})
			.sort();
	}

	async audit(event: Record<string, unknown>): Promise<void> {
		await this.exclusive("audit", async () => {
			await this.#directory(this.#root);
			const encoded = `${JSON.stringify(event)}\n`;
			if (Buffer.byteLength(encoded) > 16 * 1024) throw new Error("Gateway audit event is too large");
			const handle = await open(
				join(this.#root, "audit.jsonl"),
				constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
				0o600,
			);
			try {
				const metadata = await handle.stat();
				this.#private(metadata.mode, metadata.uid);
				if (!metadata.isFile() || metadata.size + Buffer.byteLength(encoded) > MAX_AUDIT_BYTES)
					throw new Error("Gateway audit capacity requires operator attention");
				await handle.writeFile(encoded);
				await handle.sync();
			} finally {
				await handle.close();
			}
			await this.#sync(this.#root);
		});
	}

	#path(key: string): string {
		if (!/^pending\/[a-z0-9-]{1,160}$/.test(key)) throw new Error("Gateway journal key is invalid");
		return join(this.#root, `${key}.json`);
	}

	async #directory(path: string): Promise<void> {
		await this.#createDirectory(this.#root);
		const root = await lstat(this.#root);
		if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("Gateway journal root is invalid");
		this.#private(root.mode, root.uid);
		if (path !== this.#root) await this.#createDirectory(path);
		const metadata = await lstat(path);
		if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Gateway journal directory is invalid");
		this.#private(metadata.mode, metadata.uid);
	}

	async #createDirectory(path: string): Promise<void> {
		const created = await mkdir(path, { recursive: true, mode: 0o700 });
		if (!created) return;
		// Fsyncing a new record's directory alone does not persist that
		// directory's name in its parent after a power loss.
		for (let directory = path; ; directory = dirname(directory)) {
			await this.#sync(directory);
			if (directory === dirname(created)) break;
		}
	}

	#private(mode: number, uid: number): void {
		if (process.platform !== "win32" && (uid !== process.getuid?.() || (mode & 0o077) !== 0)) {
			throw new Error("Gateway journal must be private to its service account");
		}
	}

	async #sync(directory: string): Promise<void> {
		if (process.platform === "win32") return;
		const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
		try {
			await handle.sync();
		} finally {
			await handle.close();
		}
	}
}
