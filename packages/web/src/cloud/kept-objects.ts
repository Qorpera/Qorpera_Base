import type { CloudMemberFolderKeptObjects } from "@qorpera/cloud-client/cloud-member-folder";

const DATABASE = "qorpera-kept-objects";
const VERSION = 1;
const BYTES = "bytes";
const INDEX = "index";
const OWNER = "owner";
const OWNER_KEY = "member";
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_OBJECT_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024;
const TRIM_TO = 0.9;
const TOUCH_MS = 60 * 60 * 1000;

interface KeptEntry {
	readonly sha256: string;
	readonly bytes: number;
	readonly used: number;
}

export interface KeptObjectsOptions {
	readonly factory?: IDBFactory;
	readonly maxBytes?: number;
	readonly now?: () => number;
}

function browserFactory(): IDBFactory | undefined {
	try {
		return typeof indexedDB === "undefined" ? undefined : indexedDB;
	} catch {
		return undefined;
	}
}

function answered<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

function finished(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onabort = () => reject(transaction.error);
		transaction.onerror = () => reject(transaction.error);
	});
}

function isEntry(value: unknown): value is KeptEntry {
	if (!value || typeof value !== "object") return false;
	const entry = value as Record<string, unknown>;
	return (
		typeof entry.sha256 === "string" &&
		Number.isSafeInteger(entry.bytes) &&
		(entry.bytes as number) >= 0 &&
		typeof entry.used === "number"
	);
}

export async function forgetKeptObjects(factory: IDBFactory | undefined = browserFactory()): Promise<void> {
	if (!factory) return;
	await answered(factory.deleteDatabase(DATABASE)).catch(() => undefined);
}

export class KeptObjects implements CloudMemberFolderKeptObjects {
	readonly #memberId: string;
	readonly #factory: IDBFactory | undefined;
	readonly #maxBytes: number;
	readonly #now: () => number;
	#database: Promise<IDBDatabase | undefined> | undefined;
	#closed = false;
	#writing: Promise<void> = Promise.resolve();

	constructor(memberId: string, options: KeptObjectsOptions = {}) {
		this.#memberId = memberId;
		this.#factory = "factory" in options ? options.factory : browserFactory();
		this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
		this.#now = options.now ?? Date.now;
		if (!Number.isSafeInteger(this.#maxBytes) || this.#maxBytes < 0) throw new Error("Invalid kept objects size");
	}

	async take(sha256: string, signal: AbortSignal): Promise<Uint8Array | undefined> {
		if (this.#closed || !SHA256.test(sha256)) return undefined;
		const database = await this.#open();
		if (!database || this.#closed || signal.aborted) return undefined;
		try {
			const transaction = database.transaction([BYTES, INDEX], "readonly");
			const [held, entry] = await Promise.all([
				answered(transaction.objectStore(BYTES).get(sha256) as IDBRequest<unknown>),
				answered(transaction.objectStore(INDEX).get(sha256) as IDBRequest<unknown>),
			]);
			if (!(held instanceof ArrayBuffer) || !isEntry(entry) || entry.bytes !== held.byteLength) return undefined;
			const now = this.#now();
			if (now - entry.used > TOUCH_MS)
				this.#write((stores) => {
					stores.objectStore(INDEX).put({ ...entry, used: now });
				});
			return new Uint8Array(held);
		} catch {
			return undefined;
		}
	}

	keep(sha256: string, bytes: Uint8Array): void {
		if (this.#closed || !SHA256.test(sha256) || bytes.byteLength > MAX_OBJECT_BYTES) return;
		if (bytes.byteLength > this.#maxBytes) return;
		const copy = bytes.slice().buffer;
		this.#write(async (stores) => {
			const index = stores.objectStore(INDEX);
			stores.objectStore(BYTES).put(copy, sha256);
			index.put({ sha256, bytes: copy.byteLength, used: this.#now() } satisfies KeptEntry);
			const entries = ((await answered(index.getAll() as IDBRequest<unknown[]>)) as unknown[]).filter(isEntry);
			let total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
			if (total <= this.#maxBytes) return;
			for (const entry of entries.sort((a, b) => a.used - b.used)) {
				if (total <= this.#maxBytes * TRIM_TO) break;
				if (entry.sha256 === sha256) continue;
				stores.objectStore(BYTES).delete(entry.sha256);
				index.delete(entry.sha256);
				total -= entry.bytes;
			}
		});
	}

	settled(): Promise<void> {
		return this.#writing;
	}

	close(): Promise<void> {
		this.#closed = true;
		const opened = this.#database;
		this.#database = Promise.resolve(undefined);
		return (async () => {
			(await opened)?.close();
		})();
	}

	async forget(): Promise<void> {
		await this.close();
		await forgetKeptObjects(this.#factory);
	}

	#write(work: (stores: IDBTransaction) => void | Promise<void>): void {
		this.#writing = this.#writing
			.then(async () => {
				const database = await this.#open();
				if (!database || this.#closed) return;
				const transaction = database.transaction([BYTES, INDEX], "readwrite");
				const done = finished(transaction);
				try {
					await work(transaction);
				} catch (error) {
					done.catch(() => undefined);
					transaction.abort();
					throw error;
				}
				await done;
			})
			.catch(() => undefined);
	}

	#open(): Promise<IDBDatabase | undefined> {
		this.#database ??= this.#opened().catch(() => undefined);
		return this.#database;
	}

	async #opened(): Promise<IDBDatabase | undefined> {
		const factory = this.#factory;
		if (!factory) return undefined;
		const opening = factory.open(DATABASE, VERSION);
		opening.onupgradeneeded = () => {
			const database = opening.result;
			database.createObjectStore(BYTES);
			database.createObjectStore(INDEX, { keyPath: "sha256" });
			database.createObjectStore(OWNER);
		};
		const database = await answered(opening);
		database.onversionchange = () => {
			database.close();
			this.#closed = true;
			this.#database = Promise.resolve(undefined);
		};
		const transaction = database.transaction([BYTES, INDEX, OWNER], "readwrite");
		const done = finished(transaction);
		const owner = transaction.objectStore(OWNER);
		if ((await answered(owner.get(OWNER_KEY) as IDBRequest<unknown>)) !== this.#memberId) {
			transaction.objectStore(BYTES).clear();
			transaction.objectStore(INDEX).clear();
			owner.put(this.#memberId, OWNER_KEY);
		}
		await done;
		if (this.#closed) {
			database.close();
			return undefined;
		}
		return database;
	}
}
