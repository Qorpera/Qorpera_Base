import { createHmac, randomBytes } from "node:crypto";

/** A coding machine's secret values as the folder service's save check takes them (5j-5 (a), object-gateway
 * folder-service/secret-scan.ts): keyed hashes, never a value. `length`: the value's bytes (UTF-8); `start`: a 20-bit
 * keyed tag of its first 8 bytes; `whole`: the first 16 bytes of its keyed hash, base64url. */
export interface CodingFolderSecretValue {
	readonly length: number;
	readonly start: number;
	readonly whole: string;
}

/** What one `secrets` request sends for a machine: the key (32 bytes, base64url) and every value's hashes, once. */
export interface CodingFolderSecretSet {
	readonly key: string;
	readonly values: readonly CodingFolderSecretValue[];
}

/** The values the service takes (its control socket's limits); the mask takes none shorter. */
export const CODING_FOLDER_SECRET_MIN_BYTES = 8;
export const CODING_FOLDER_SECRET_MAX_BYTES = 32 * 1024;
export const CODING_FOLDER_SECRET_VALUES_MAX = 4096;

/** This executor's key for the save check: made at start, held in memory only, the same for every machine, so an
 * unchanged set is sent unchanged and the service checks nothing again. */
export class CodingFolderSecretKey {
	readonly #key: string;
	readonly #kv: Buffer;
	/** The tag's constants. */
	readonly #c: readonly number[];
	constructor(key: Buffer = randomBytes(32)) {
		if (key.byteLength !== 32) throw new Error("A folder secret key is 32 bytes");
		this.#key = key.toString("base64url");
		const kw = createHmac("sha256", key).update("qorpera-secret-window/v1").digest();
		this.#kv = createHmac("sha256", key).update("qorpera-secret-value/v1").digest();
		this.#c = Array.from({ length: 8 }, (_, i) => kw.readUInt32BE(4 * i));
	}

	/** The set for `values`, each once. `omitted`: how many the service could not take (shorter or longer than it
	 * checks, or past the most one set holds), which no save is checked for. */
	set(values: Iterable<string>): { set: CodingFolderSecretSet; omitted: number } {
		const hashes: CodingFolderSecretValue[] = [];
		let omitted = 0;
		for (const value of new Set(values)) {
			const bytes = Buffer.from(value);
			if (
				bytes.byteLength < CODING_FOLDER_SECRET_MIN_BYTES ||
				bytes.byteLength > CODING_FOLDER_SECRET_MAX_BYTES ||
				hashes.length === CODING_FOLDER_SECRET_VALUES_MAX
			)
				omitted++;
			else hashes.push(this.#hashes(bytes));
		}
		return { set: Object.freeze({ key: this.#key, values: Object.freeze(hashes) }), omitted };
	}

	#hashes(bytes: Buffer): CodingFolderSecretValue {
		const c = this.#c as [number, number, number, number, number, number, number, number];
		let h = Math.imul(bytes.readUInt32BE(0) ^ c[0], c[1] | 1);
		h ^= h >>> 15;
		h = Math.imul(h ^ bytes.readUInt32BE(4) ^ c[2], c[3] | 1);
		h ^= h >>> 13;
		h = Math.imul(h ^ c[4], c[5] | 1);
		h ^= h >>> 16;
		h = Math.imul(h ^ c[6], c[7] | 1);
		return Object.freeze({
			length: bytes.byteLength,
			start: h >>> 12,
			whole: createHmac("sha256", this.#kv).update(bytes).digest().toString("base64url", 0, 16),
		});
	}
}
