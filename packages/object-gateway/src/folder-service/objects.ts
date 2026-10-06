import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { isUuid, SHA256_HEX_PATTERN } from "@qorpera/contracts";
import type { TreeEntry } from "./view-tree.ts";

const CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_CHUNKS = 64;
const MAX_MANIFEST_BYTES = 32 * 1024;

/** The bytes on the storage server do not match what the core named. Never served. */
export class ObjectIntegrityError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ObjectIntegrityError";
	}
}

/** The storage server did not answer in time, or the object is missing. The machine may ask again. */
export class ObjectUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ObjectUnavailableError";
	}
}

/** The object is not on the storage server at all: asking again will not find it. */
export class ObjectMissingError extends ObjectUnavailableError {
	constructor(message: string) {
		super(message);
		this.name = "ObjectMissingError";
	}
}

interface Chunk {
	readonly sha256: string;
	readonly bytes: number;
	/** Offset of the chunk's first byte in the file. */
	readonly start: number;
}

interface Manifest {
	readonly fileSha256: string;
	readonly bytes: number;
	readonly chunks: readonly Chunk[];
}

function digest(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/** Checks a manifest's text against the entry the core named it for, and works out where each chunk starts. Both
 * schemas are read: v2 (every folder-v2 writer) and v1 (fixtures, and files carried over from the old core). */
export function parseManifest(text: Uint8Array, entry: TreeEntry): Manifest {
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(text));
	} catch {
		throw new ObjectIntegrityError("Manifest is not JSON");
	}
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new ObjectIntegrityError("Manifest is not an object");
	const m = value as Record<string, unknown>;
	const v2 = m.schema === "qorpera.cloud-file-manifest/v2";
	const keys = v2
		? ["schema", "fileSha256", "bytes", "mediaType", "executable", "chunks"]
		: ["schema", "fileSha256", "bytes", "mediaType", "chunks"];
	if (
		(!v2 && m.schema !== "qorpera.cloud-file-manifest/v1") ||
		Object.keys(m).length !== keys.length ||
		keys.some((key) => !(key in m))
	)
		throw new ObjectIntegrityError("Manifest has an unknown shape");
	if (
		m.fileSha256 !== entry.fileSha256 ||
		m.bytes !== entry.bytes ||
		(v2 && (m.mediaType !== entry.mediaType || m.executable !== entry.executable)) ||
		!Array.isArray(m.chunks) ||
		m.chunks.length > MAX_CHUNKS
	)
		throw new ObjectIntegrityError("Manifest does not match its entry");
	let start = 0;
	const chunks = m.chunks.map((value: unknown, index: number) => {
		const c = value as Record<string, unknown>;
		if (
			!c ||
			typeof c !== "object" ||
			Object.keys(c).length !== 2 ||
			typeof c.sha256 !== "string" ||
			!SHA256_HEX_PATTERN.test(c.sha256) ||
			!Number.isSafeInteger(c.bytes) ||
			(c.bytes as number) < 1 ||
			(c.bytes as number) > CHUNK_BYTES ||
			// v1 cut every chunk but the last at exactly 4 MiB.
			(!v2 && index < (m.chunks as unknown[]).length - 1 && c.bytes !== CHUNK_BYTES)
		)
			throw new ObjectIntegrityError("Manifest chunk is invalid");
		const chunk = { sha256: c.sha256, bytes: c.bytes as number, start };
		start += chunk.bytes;
		return chunk;
	});
	if (start !== entry.bytes) throw new ObjectIntegrityError("Manifest chunks do not add up to the file");
	return { fileSha256: m.fileSha256 as string, bytes: entry.bytes, chunks };
}

/** Bytes kept in memory, least recently used dropped first. */
class ByteCache {
	readonly #max: number;
	readonly #items = new Map<string, Buffer>();
	#bytes = 0;

	constructor(maxBytes: number) {
		this.#max = maxBytes;
	}

	get bytes(): number {
		return this.#bytes;
	}

	get(key: string): Buffer | undefined {
		const value = this.#items.get(key);
		if (value) {
			this.#items.delete(key);
			this.#items.set(key, value);
		}
		return value;
	}

	set(key: string, value: Buffer): void {
		if (value.byteLength > this.#max) return;
		const previous = this.#items.get(key);
		if (previous) {
			this.#bytes -= previous.byteLength;
			this.#items.delete(key);
		}
		this.#items.set(key, value);
		this.#bytes += value.byteLength;
		for (const [oldest, bytes] of this.#items) {
			if (this.#bytes <= this.#max) break;
			this.#items.delete(oldest);
			this.#bytes -= bytes.byteLength;
		}
	}
}

export interface NasObjectsOptions {
	/** The storage server's object share, e.g. `/srv/qorpera/canonical`. */
	readonly root: string;
	/** Memory for chunks and manifests. */
	readonly cacheBytes: number;
	/** Reads from the share at once; more wait in turn. */
	readonly parallel?: number;
	/** One object read's deadline. A hung NFS read keeps its slot until it returns. */
	readonly timeoutMs?: number;
}

/** Reads company objects straight from the storage server's share, after the core named them. Every object is
 * checked against its hash before it is used or kept; nothing is ever written. */
export class NasObjects {
	readonly #root: string;
	readonly #cache: ByteCache;
	readonly #parallel: number;
	readonly #timeoutMs: number;
	readonly #pending = new Map<string, Promise<Buffer>>();
	readonly #waiting: (() => void)[] = [];
	#running = 0;

	constructor(options: NasObjectsOptions) {
		this.#root = resolve(options.root);
		this.#cache = new ByteCache(options.cacheBytes);
		this.#parallel = options.parallel ?? 16;
		this.#timeoutMs = options.timeoutMs ?? 30_000;
		if (!Number.isSafeInteger(this.#parallel) || this.#parallel < 1)
			throw new Error("Object read parallelism is invalid");
	}

	get cachedBytes(): number {
		return this.#cache.bytes;
	}

	/** `length` bytes of a file from `offset` (fewer at its end). */
	async read(profileId: string, entry: TreeEntry, offset: number, length: number): Promise<Buffer> {
		if (entry.kind !== "file" || entry.manifestSha256 === undefined) throw new Error("Only files have bytes");
		const end = Math.min(entry.bytes, offset + length);
		if (offset >= end) return Buffer.alloc(0);
		const manifest = parseManifest(await this.#object(profileId, entry.manifestSha256, MAX_MANIFEST_BYTES), entry);
		const needed = manifest.chunks.filter((c) => c.start < end && c.start + c.bytes > offset);
		const parts = await Promise.all(needed.map((c) => this.#object(profileId, c.sha256, c.bytes, c.bytes)));
		return Buffer.concat(
			parts.map((bytes, i) => {
				const c = needed[i]!;
				return bytes.subarray(Math.max(0, offset - c.start), Math.min(c.bytes, end - c.start));
			}),
		);
	}

	/** One object, from memory or the share, checked against its hash (and its size when known). */
	#object(profileId: string, hash: string, maximum: number, exact?: number): Promise<Buffer> {
		const key = `${profileId}/${hash}`;
		const cached = this.#cache.get(key);
		if (cached) return Promise.resolve(cached);
		let pending = this.#pending.get(key);
		if (!pending) {
			pending = this.#turn(() => this.#load(profileId, hash, maximum, exact)).finally(() =>
				this.#pending.delete(key),
			);
			this.#pending.set(key, pending);
		}
		return pending;
	}

	async #load(profileId: string, hash: string, maximum: number, exact: number | undefined): Promise<Buffer> {
		if (!isUuid(profileId) || !SHA256_HEX_PATTERN.test(hash))
			throw new ObjectIntegrityError("Object identity is invalid");
		const path = resolve(this.#root, profileId, hash);
		if (!path.startsWith(`${this.#root}${sep}`)) throw new ObjectIntegrityError("Object path escapes the share");
		let handle: Awaited<ReturnType<typeof open>>;
		try {
			handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ELOOP") throw new ObjectIntegrityError("Object is a link");
			if (code === "ENOENT") {
				// Missing only when the company's objects are there: with no profile folder at all (a share that is not
				// mounted shows an empty mountpoint) nothing can be read now, and the page fails rather than look empty.
				if (!(await this.#profileThere(profileId)))
					throw new ObjectUnavailableError("The company's objects are not on the storage server now");
				throw new ObjectMissingError("Object is not on the storage server");
			}
			throw new ObjectUnavailableError(`Object could not be opened (${code ?? "unknown"})`);
		}
		try {
			const info = await handle.stat();
			if (!info.isFile()) throw new ObjectIntegrityError("Object is not a regular file");
			if (info.size > maximum || (exact !== undefined && info.size !== exact))
				throw new ObjectIntegrityError("Object has the wrong size");
			const bytes = Buffer.allocUnsafe(info.size);
			let read = 0;
			while (read < bytes.byteLength) {
				const { bytesRead } = await handle.read(bytes, read, bytes.byteLength - read, read);
				if (bytesRead === 0) break;
				read += bytesRead;
			}
			if (read !== bytes.byteLength || digest(bytes) !== hash)
				throw new ObjectIntegrityError("Object failed its hash check");
			this.#cache.set(`${profileId}/${hash}`, bytes);
			return bytes;
		} finally {
			await handle.close();
		}
	}

	async #profileThere(profileId: string): Promise<boolean> {
		try {
			return (await stat(resolve(this.#root, profileId))).isDirectory();
		} catch {
			return false;
		}
	}

	/** Runs an object read when one of the parallel slots is free. The deadline counts from the request, waiting
	 * included; a read past it keeps its slot until the share answers, so a hung share cannot pile up reads, and a
	 * read whose caller gave up while it waited never starts. */
	async #turn<T>(operation: () => Promise<T>): Promise<T> {
		let expired = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				expired = true;
				reject(new ObjectUnavailableError("The storage server did not answer"));
			}, this.#timeoutMs);
		});
		const work = (async (): Promise<T> => {
			// A finished read hands its slot straight to the next waiting one.
			if (this.#running >= this.#parallel) await new Promise<void>((go) => this.#waiting.push(go));
			else this.#running++;
			try {
				if (expired) throw new ObjectUnavailableError("The storage server did not answer");
				return await operation();
			} finally {
				this.#done();
			}
		})();
		try {
			return await Promise.race([work, deadline]);
		} finally {
			clearTimeout(timer);
			// The losing side's rejection is handled here, not left unhandled.
			void work.catch(() => undefined);
			void deadline.catch(() => undefined);
		}
	}

	#done(): void {
		const next = this.#waiting.shift();
		if (next) next();
		else this.#running--;
	}
}
