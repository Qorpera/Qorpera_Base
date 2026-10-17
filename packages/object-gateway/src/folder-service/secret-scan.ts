import { createHmac } from "node:crypto";

/**
 * The save check's matcher (5j-5 (a); RUNTIME-FOLDER-CODING-MACHINES.md, "Masking"): a coding machine's secret values
 * as its executor sends them, as keyed hashes only, and the scan that looks for them in what the machine saves. The
 * service never holds a value. For each value the executor sends its length in bytes (UTF-8), `start`, a 20-bit keyed
 * tag of its first 8 bytes, and `whole`, the first 16 bytes of HMAC-SHA256(kv, value). The tag's constants and kv come
 * from the set's key: kw = HMAC-SHA256(key, "qorpera-secret-window/v1"), kv = HMAC-SHA256(key, "qorpera-secret-value/v1").
 * The scan rolls an 8-byte window over the bytes; a window whose tag is one of the set's is a candidate, confirmed by
 * `whole` over each length that tag has. A tag keeps 20 bits so that about 2^44 prefixes share each: the set does not
 * give a value's first bytes away. The executor makes the same hashes; the vectors in secret-scan.test.ts pin the
 * formula both sides follow.
 */

/** A value is at least one window long: the executor sends no shorter one. */
export const SECRET_MIN_BYTES = 8;
export const SECRET_MAX_BYTES = 32 * 1024;
/** Values one machine's set holds at most. */
export const SECRET_VALUES_MAX = 4096;
export const SECRET_TAG_BITS = 20;
const WINDOW_LABEL = "qorpera-secret-window/v1";
const VALUE_LABEL = "qorpera-secret-value/v1";
/** The bytes one file's candidates may hash to be confirmed: this many, or 4 times the file's, whichever is more. Past
 * it the file is refused as not checked: the service is one event loop for the node, and a file made of a value's first
 * 8 bytes over and over would cost one HMAC over the value's length for every 8 bytes. */
const CONFIRM_FLOOR = 64 * 1024 * 1024;
const CONFIRM_FACTOR = 4;

/** Why the check refuses a file: what a report says, and nothing of the value or where it is. */
export const CARRIES = "it carries a secret value";
export const UNCHECKED = "it could not be checked for secret values";

/** A file's bytes carry one of the values, or could not be checked within the bound. No value, tag or offset in it. */
export class SecretRefusal extends Error {
	constructor(reason: typeof CARRIES | typeof UNCHECKED) {
		super(reason);
		this.name = "SecretRefusal";
	}
}

/** One value as the executor sends it: never the value itself. `whole` is base64url. */
export interface SecretValue {
	readonly length: number;
	readonly start: number;
	readonly whole: string;
}

interface Matcher {
	readonly c0: number;
	readonly c1: number;
	readonly c2: number;
	readonly c3: number;
	readonly c4: number;
	readonly c5: number;
	readonly c6: number;
	readonly c7: number;
	readonly kv: Buffer;
	/** A bit for each tag some value has. */
	readonly bitmap: Uint32Array;
	/** Each tag's lengths, and the wholes of each. */
	readonly tags: ReadonlyMap<number, ReadonlyMap<number, ReadonlySet<string>>>;
	readonly longest: number;
}

/** What a scan may still hash to confirm candidates. */
interface Budget {
	left: number;
}

/** The tag of the 8 bytes `hi` (the first four, big-endian) and `lo` (the last four). */
function tagOf(m: Matcher, hi: number, lo: number): number {
	let h = Math.imul(hi ^ m.c0, m.c1 | 1);
	h ^= h >>> 15;
	h = Math.imul(h ^ lo ^ m.c2, m.c3 | 1);
	h ^= h >>> 13;
	h = Math.imul(h ^ m.c4, m.c5 | 1);
	h ^= h >>> 16;
	h = Math.imul(h ^ m.c6, m.c7 | 1);
	return h >>> (32 - SECRET_TAG_BITS);
}

/** Whether a value starts at one of `bytes`' offsets up to `last` and ends within `bytes`. Throws past the budget. */
function found(m: Matcher, bytes: Buffer, last: number, budget: Budget): boolean {
	const end = Math.min(last + 8, bytes.length);
	let hi = 0;
	let lo = 0;
	for (let i = 0; i < end; i++) {
		hi = ((hi << 8) | (lo >>> 24)) >>> 0;
		lo = ((lo << 8) | (bytes[i] as number)) >>> 0;
		if (i < 7) continue;
		const tag = tagOf(m, hi, lo);
		if (((m.bitmap[tag >>> 5] as number) & (1 << (tag & 31))) === 0) continue;
		const start = i - 7;
		for (const [length, wholes] of m.tags.get(tag) ?? []) {
			if (start + length > bytes.length) continue;
			budget.left -= length;
			if (budget.left < 0) throw new SecretRefusal(UNCHECKED);
			const whole = createHmac("sha256", m.kv)
				.update(bytes.subarray(start, start + length))
				.digest()
				.toString("base64url", 0, 16);
			if (wholes.has(whole)) return true;
		}
	}
	return false;
}

/** One machine's secret values (the control socket's `secrets`), kept for this run only. */
export class SecretSet {
	readonly #key: Buffer;
	/** Each value once, by its length, tag and whole. */
	readonly #values: ReadonlyMap<string, SecretValue>;
	#matcher: Matcher | undefined;

	constructor(key: Buffer, values: Iterable<SecretValue>) {
		this.#key = Buffer.from(key);
		const each = new Map<string, SecretValue>();
		for (const v of values) each.set(`${v.length}.${v.start}.${v.whole}`, v);
		this.#values = each;
	}

	get size(): number {
		return this.#values.size;
	}

	/** The same key and values: what was checked against one was checked against the other. */
	equals(other: SecretSet): boolean {
		if (other === this) return true;
		if (!this.#key.equals(other.#key) || this.#values.size !== other.#values.size) return false;
		for (const id of this.#values.keys()) if (!other.#values.has(id)) return false;
		return true;
	}

	/** The values a check against `older` did not look for: those it lacks, under the same key; under another, all. */
	since(older: SecretSet | undefined): SecretSet {
		if (older === this) return new SecretSet(this.#key, []);
		if (!older || !this.#key.equals(older.#key)) return this;
		return new SecretSet(
			this.#key,
			[...this.#values].filter(([id]) => !older.#values.has(id)).map(([, v]) => v),
		);
	}

	/** Whether `text` (a name, a link's target) holds one of the values, as UTF-8. */
	carries(text: string): boolean {
		const m = this.#matching();
		if (!m) return false;
		const bytes = Buffer.from(text);
		return found(m, bytes, bytes.length - 8, { left: Number.POSITIVE_INFINITY });
	}

	/** A scan of a file of `size` bytes, given its bytes in order. */
	scan(size: number): SecretScan {
		return new SecretScan(this.#matching(), Math.max(CONFIRM_FLOOR, CONFIRM_FACTOR * size));
	}

	#matching(): Matcher | undefined {
		if (this.#values.size === 0) return undefined;
		if (this.#matcher) return this.#matcher;
		const kw = createHmac("sha256", this.#key).update(WINDOW_LABEL).digest();
		const bitmap = new Uint32Array(2 ** (SECRET_TAG_BITS - 5));
		const tags = new Map<number, Map<number, Set<string>>>();
		let longest = 0;
		for (const v of this.#values.values()) {
			bitmap[v.start >>> 5] = (bitmap[v.start >>> 5] as number) | (1 << (v.start & 31));
			const lengths = tags.get(v.start) ?? new Map<number, Set<string>>();
			tags.set(v.start, lengths);
			const wholes = lengths.get(v.length) ?? new Set<string>();
			lengths.set(v.length, wholes);
			wholes.add(v.whole);
			longest = Math.max(longest, v.length);
		}
		this.#matcher = {
			c0: kw.readUInt32BE(0),
			c1: kw.readUInt32BE(4),
			c2: kw.readUInt32BE(8),
			c3: kw.readUInt32BE(12),
			c4: kw.readUInt32BE(16),
			c5: kw.readUInt32BE(20),
			c6: kw.readUInt32BE(24),
			c7: kw.readUInt32BE(28),
			kv: createHmac("sha256", this.#key).update(VALUE_LABEL).digest(),
			bitmap,
			tags,
			longest,
		};
		return this.#matcher;
	}
}

/** One file's scan: its bytes pushed in order, then `end`. Each throws `SecretRefusal` at the first value found, or once
 * confirming candidates passed the file's budget. A set with no values scans nothing. */
export class SecretScan {
	readonly #m: Matcher | undefined;
	readonly #budget: Budget;
	/** The bytes from the first offset not scanned yet: a value starting there may end in the next chunk. */
	#tail = Buffer.alloc(0);

	constructor(m: Matcher | undefined, budget: number) {
		this.#m = m;
		this.#budget = { left: budget };
	}

	push(chunk: Buffer): void {
		const m = this.#m;
		if (!m) return;
		const bytes = this.#tail.length === 0 ? chunk : Buffer.concat([this.#tail, chunk]);
		// Every offset up to `last` has the longest value's bytes here.
		const last = bytes.length - m.longest;
		if (last >= 0 && found(m, bytes, last, this.#budget)) throw new SecretRefusal(CARRIES);
		this.#tail = Buffer.from(bytes.subarray(Math.max(0, last + 1)));
	}

	end(): void {
		const m = this.#m;
		if (m && found(m, this.#tail, this.#tail.length - 8, this.#budget)) throw new SecretRefusal(CARRIES);
		this.#tail = Buffer.alloc(0);
	}
}
