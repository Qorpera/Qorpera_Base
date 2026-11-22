import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_RECORDS = 50_000;
const MAX_TEMP_FILES = 256;
const MAX_AUDIT_BYTES = 128 * 1024 * 1024;

interface DirectoryTracker {
	known: Set<string>;
	reserving: Set<string>;
	activeWrites: number;
	orphanedHidden: number;
}

/** Private, single-service-writer cloud state. Never put this on a worker disk or in Company File. */
export class ObjectGatewayJournal {
	readonly #root: string;
	readonly #maxRecords: number;
	readonly #locks = new Map<string, Promise<unknown>>();
	readonly #tracked = new Map<string, DirectoryTracker>();
	readonly #creating = new Map<string, Promise<void>>();

	constructor(root: string, maxRecords = MAX_RECORDS) {
		if (!isAbsolute(root) || /[\0\r\n]/.test(root) || resolve(root) === "/") {
			throw new Error("Gateway journal root must be a private absolute directory");
		}
		this.#root = resolve(root);
		if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > MAX_RECORDS)
			throw new Error("Gateway journal capacity is invalid");
		this.#maxRecords = maxRecords;
	}

	get maxRecords(): number {
		return this.#maxRecords;
	}

	async exclusive<T>(key: string, operation: (contended: boolean) => Promise<T>): Promise<T> {
		const existing = this.#locks.get(key);
		const contended = existing !== undefined;
		const previous = existing ?? Promise.resolve();
		const pending = previous.catch(() => undefined).then(() => operation(contended));
		this.#locks.set(key, pending);
		try {
			return await pending;
		} finally {
			if (this.#locks.get(key) === pending) this.#locks.delete(key);
		}
	}

	async read(key: string, options?: { readonly skipDirectoryCheck?: boolean }): Promise<unknown | undefined> {
		const path = this.#path(key);
		if (!options?.skipDirectoryCheck) await this.#directory(dirname(path));
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
		const encoded = JSON.stringify(value);
		if (encoded === undefined || Buffer.byteLength(encoded) > MAX_RECORD_BYTES)
			throw new Error("Gateway journal record exceeds its limit");
		const parent = dirname(path);
		const name = basename(path);
		// Updates remain possible at capacity so reconciliation can drain work.
		// WHY: serialize capacity admission under capacity:<parent> while distinct keys fsync concurrently.
		await this.exclusive(`file:${path}`, async () => {
			await this.#directory(parent);
			let reserved = false;
			let admitted = false;
			await this.exclusive(`capacity:${parent}`, async () => {
				const tracker = await this.#tracker(parent);
				if (
					tracker.activeWrites >= MAX_TEMP_FILES ||
					tracker.orphanedHidden + tracker.activeWrites >= MAX_TEMP_FILES
				) {
					await this.#syncTracker(parent, tracker);
					if (
						tracker.activeWrites >= MAX_TEMP_FILES ||
						tracker.orphanedHidden + tracker.activeWrites >= MAX_TEMP_FILES
					)
						throw new Error("Gateway journal capacity requires operator attention");
				}
				if (!tracker.known.has(name)) {
					if (tracker.known.size + tracker.reserving.size >= this.#maxRecords) {
						await this.#syncTracker(parent, tracker);
						if (!tracker.known.has(name) && tracker.known.size + tracker.reserving.size >= this.#maxRecords)
							throw new Error("Gateway journal capacity requires operator attention");
					}
					if (!tracker.known.has(name)) {
						tracker.reserving.add(name);
						reserved = true;
					}
				}
				tracker.activeWrites++;
				admitted = true;
			});
			const state = { renamed: false };
			try {
				await this.#writeFile(path, parent, encoded, state);
			} finally {
				if (admitted) {
					await this.exclusive(`capacity:${parent}`, async () => {
						const tracker = this.#tracked.get(parent);
						if (!tracker) return;
						tracker.activeWrites = Math.max(0, tracker.activeWrites - 1);
						if (reserved) tracker.reserving.delete(name);
						if (state.renamed) tracker.known.add(name);
					});
				}
			}
		});
	}

	async #writeFile(path: string, parent: string, encoded: string, state: { renamed: boolean }): Promise<void> {
		try {
			const current = await lstat(path);
			this.#private(current.mode, current.uid);
			if (!current.isFile() || current.isSymbolicLink()) throw new Error("Gateway journal target is invalid");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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
			state.renamed = true;
			await this.#sync(parent);
		} finally {
			if (!state.renamed) await rm(temporary, { force: true });
		}
	}

	async remove(key: string): Promise<void> {
		const path = this.#path(key);
		const parent = dirname(path);
		const name = basename(path);
		await this.exclusive(`file:${path}`, async () => {
			await this.#directory(parent);
			let unlinked = false;
			try {
				await rm(path, { force: true });
				unlinked = true;
				await this.#sync(parent);
			} finally {
				if (unlinked) {
					await this.exclusive(`capacity:${parent}`, async () => {
						this.#tracked.get(parent)?.known.delete(name);
					});
				}
			}
		});
	}

	async list(section: "pending"): Promise<string[]> {
		const directory = join(this.#root, section);
		await this.#directory(directory);
		const entries = await readdir(directory, { withFileTypes: true });
		const visible = entries.filter((entry) => !entry.name.startsWith("."));
		if (visible.length > this.#maxRecords || entries.length - visible.length > MAX_TEMP_FILES)
			throw new Error("Gateway journal capacity requires operator attention");
		return visible
			.map((entry) => {
				if (!entry.isFile() || !/^[a-z0-9-]+\.json$/.test(entry.name))
					throw new Error("Gateway journal entry is invalid");
				return `${section}/${entry.name.slice(0, -5)}`;
			})
			.sort();
	}

	/** Appends the events with one sync, however many. */
	async audit(...events: Record<string, unknown>[]): Promise<void> {
		await this.exclusive("audit", async () => {
			await this.#directory(this.#root);
			const lines = events.map((event) => `${JSON.stringify(event)}\n`);
			if (lines.some((line) => Buffer.byteLength(line) > 16 * 1024))
				throw new Error("Gateway audit event is too large");
			const encoded = lines.join("");
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

	async #tracker(parent: string): Promise<DirectoryTracker> {
		let tracker = this.#tracked.get(parent);
		if (!tracker) {
			tracker = { known: new Set<string>(), reserving: new Set<string>(), activeWrites: 0, orphanedHidden: 0 };
			await this.#syncTracker(parent, tracker);
			this.#tracked.set(parent, tracker);
		}
		return tracker;
	}

	async #syncTracker(parent: string, tracker: DirectoryTracker): Promise<void> {
		const entries = await readdir(parent);
		tracker.known.clear();
		let hidden = 0;
		for (const entry of entries) {
			if (entry.startsWith(".")) hidden++;
			else if (!tracker.reserving.has(entry)) tracker.known.add(entry);
		}
		tracker.orphanedHidden = Math.max(0, hidden - tracker.activeWrites);
	}

	async #directory(path: string): Promise<void> {
		await this.#ensurePrivateDirectory(this.#root, "Gateway journal root is invalid");
		if (path !== this.#root) await this.#ensurePrivateDirectory(path, "Gateway journal directory is invalid");
	}

	async #ensurePrivateDirectory(path: string, invalidMessage: string): Promise<void> {
		const existingCreate = this.#creating.get(path);
		if (existingCreate) await existingCreate;
		let metadata: Awaited<ReturnType<typeof lstat>>;
		try {
			metadata = await lstat(path);
			const inflightCreate = this.#creating.get(path);
			if (inflightCreate) await inflightCreate;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			let create = this.#creating.get(path);
			if (!create) {
				create = this.#createDirectory(path);
				this.#creating.set(path, create);
				const clear = () => {
					if (this.#creating.get(path) === create) this.#creating.delete(path);
				};
				create.then(clear, clear);
			}
			await create;
			metadata = await lstat(path);
		}
		if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(invalidMessage);
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
