import type { CloudMemberFolderKeptObjects } from "@qorpera/cloud-client/cloud-member-folder";

const DATABASE = "qorpera-kept-objects";
const VERSION = 1;
const BYTES = "bytes";
const INDEX = "index";
const OWNER = "owner";
const OWNER_KEY = "member";
const TOTAL_KEY = "bytes";
const BY_USED = "used";
const STORES = [BYTES, INDEX, OWNER];
const TAKE_MS = 4000;
const LATE = Symbol("late");
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

function bounded<T>(work: Promise<T>, ms: number, signal: AbortSignal): Promise<T | typeof LATE | undefined> {
	return new Promise((resolve, reject) => {
		const settle = (value: T | typeof LATE | undefined) => {
			clearTimeout(timer);
			signal.removeEventListener("abort", stopped);
			resolve(value);
		};
		const stopped = () => settle(undefined);
		const timer = setTimeout(() => settle(LATE), ms);
		signal.addEventListener("abort", stopped, { once: true });
		work.then(settle, (error) => {
			clearTimeout(timer);
			signal.removeEventListener("abort", stopped);
			reject(error);
		});
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
		if (this.#closed || signal.aborted || !SHA256.test(sha256)) return undefined;
		const taken = await bounded(this.#taken(sha256), TAKE_MS, signal).catch(() => undefined);
		if (taken !== LATE) return taken;
		void this.close();
		return undefined;
	}

	async #taken(sha256: string): Promise<Uint8Array | undefined> {
		const database = await this.#open();
		if (!database || this.#closed) return undefined;
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
	}

	keep(sha256: string, bytes: Uint8Array): void {
		if (this.#closed || !SHA256.test(sha256) || bytes.byteLength > MAX_OBJECT_BYTES) return;
		if (bytes.byteLength > this.#maxBytes) return;
		const copy = bytes.slice().buffer;
		this.#write(async (stores) => {
			const index = stores.objectStore(INDEX);
			const owner = stores.objectStore(OWNER);
			const [before, counted] = await Promise.all([
				answered(index.get(sha256) as IDBRequest<unknown>),
				answered(owner.get(TOTAL_KEY) as IDBRequest<unknown>),
			]);
			stores.objectStore(BYTES).put(copy, sha256);
			index.put({ sha256, bytes: copy.byteLength, used: this.#now() } satisfies KeptEntry);
			let total =
				(typeof counted === "number" ? counted : 0) - (isEntry(before) ? before.bytes : 0) + copy.byteLength;
			if (total > this.#maxBytes) {
				const enough = this.#maxBytes * TRIM_TO;
				const oldest = index.index(BY_USED).openCursor();
				await new Promise<void>((resolve, reject) => {
					oldest.onerror = () => reject(oldest.error);
					oldest.onsuccess = () => {
						const cursor = oldest.result;
						if (!cursor || total <= enough) {
							resolve();
							return;
						}
						const entry: unknown = cursor.value;
						if (isEntry(entry) && entry.sha256 !== sha256) {
							stores.objectStore(BYTES).delete(entry.sha256);
							cursor.delete();
							total -= entry.bytes;
						}
						cursor.continue();
					};
				});
			}
			owner.put(total, TOTAL_KEY);
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
		void this.close();
		await forgetKeptObjects(this.#factory);
	}

	#write(work: (stores: IDBTransaction) => void | Promise<void>): void {
		this.#writing = this.#writing
			.then(async () => {
				const database = await this.#open();
				if (!database || this.#closed) return;
				const transaction = database.transaction(STORES, "readwrite");
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
			database.createObjectStore(INDEX, { keyPath: "sha256" }).createIndex(BY_USED, "used");
			database.createObjectStore(OWNER);
		};
		const database = await answered(opening);
		if (this.#closed) {
			database.close();
			return undefined;
		}
		database.onversionchange = () => {
			database.close();
			this.#closed = true;
			this.#database = Promise.resolve(undefined);
		};
		const transaction = database.transaction(STORES, "readwrite");
		const done = finished(transaction);
		const owner = transaction.objectStore(OWNER);
		if ((await answered(owner.get(OWNER_KEY) as IDBRequest<unknown>)) !== this.#memberId) {
			transaction.objectStore(BYTES).clear();
			transaction.objectStore(INDEX).clear();
			owner.put(this.#memberId, OWNER_KEY);
			owner.put(0, TOTAL_KEY);
		}
		await done;
		if (this.#closed) {
			database.close();
			return undefined;
		}
		return database;
	}
}
