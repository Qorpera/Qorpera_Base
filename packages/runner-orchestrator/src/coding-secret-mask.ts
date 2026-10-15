/** The shortest secret value a coding machine may be given: the broker refuses
 * a shorter environment secret when it is captured, so every injected value is
 * masked. */
export const CODING_SECRET_MASK_MINIMUM_BYTES = 8;

const MASK = new TextEncoder().encode("***");
const PERCENT = 0x25;
const PLUS = 0x2b;
const SPACE = 0x20;
const CR = 0x0d;
const LF = 0x0a;

/** Between a form's bytes; after `%`; after `%` and one hex digit; after a
 * CR where the form has an LF (a terminal writes `\n` as `\r\n`). */
const NEXT = 0;
const AFTER_PERCENT = 1;
const AFTER_DIGIT = 2;
const AFTER_CR = 3;

interface Partial {
	form: number;
	index: number;
	phase: number;
	digit: number;
	start: number;
}

function hexDigit(byte: number): number {
	if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
	if (byte >= 0x41 && byte <= 0x46) return byte - 0x37;
	if (byte >= 0x61 && byte <= 0x66) return byte - 0x57;
	return -1;
}

/** The base64 characters that only the value decides, at each of the three
 * offsets it can have inside a longer base64 run, in both alphabets. Padding
 * and the characters it shares with its neighbours stay outside the form. */
function base64Forms(value: Uint8Array): string[] {
	const forms: string[] = [];
	for (let offset = 0; offset < 3; offset++) {
		const bytes = new Uint8Array(offset + value.length + 2);
		bytes.set(value, offset);
		const text = Buffer.from(bytes).toString("base64");
		const form = text.slice(Math.ceil((8 * offset) / 6), Math.floor((8 * (offset + value.length)) / 6));
		forms.push(form, form.replaceAll("+", "-").replaceAll("/", "_"));
	}
	return forms;
}

/** A coding machine's secret values, masked as `***` wherever they appear in
 * output: the exact bytes, base64 in both alphabets with or without padding,
 * and URL encoding (each byte also as `%XX` in either case, a space also as
 * `+`). The set only grows; a stream masks each value added before the bytes
 * that carry it arrive. Best effort: a value split by other bytes, or encoded
 * any other way, passes. */
export class CodingSecretMask {
	readonly #forms: Uint8Array[] = [];
	readonly #known = new Set<string>();
	readonly #values = new Set<string>();
	readonly #byFirst = new Map<number, number[]>();

	constructor(values: Iterable<string | Uint8Array> = []) {
		for (const value of values) this.add(value);
	}

	get size(): number {
		return this.#values.size;
	}

	add(value: string | Uint8Array): void {
		const bytes = typeof value === "string" ? new TextEncoder().encode(value) : Uint8Array.from(value);
		if (bytes.length < CODING_SECRET_MASK_MINIMUM_BYTES) {
			throw new RangeError(`a coding secret shorter than ${CODING_SECRET_MASK_MINIMUM_BYTES} bytes can't be masked`);
		}
		const key = Buffer.from(bytes).toString("latin1");
		if (this.#values.has(key)) return;
		this.#values.add(key);
		this.#addForm(bytes);
		for (const form of base64Forms(bytes)) this.#addForm(new TextEncoder().encode(form));
	}

	stream(): CodingSecretMaskStream {
		return new CodingSecretMaskStream(this.#forms, this.#byFirst);
	}

	#addForm(bytes: Uint8Array): void {
		const key = Buffer.from(bytes).toString("latin1");
		if (this.#known.has(key)) return;
		this.#known.add(key);
		const form = this.#forms.push(bytes) - 1;
		const firsts = bytes[0] === SPACE ? [SPACE, PLUS] : bytes[0] === LF ? [LF, CR] : [bytes[0]];
		for (const first of firsts) {
			const list = this.#byFirst.get(first);
			if (list) list.push(form);
			else this.#byFirst.set(first, [form]);
		}
	}
}

/** One byte stream's masking: stdout and stderr each take one, and so does a
 * terminal. `push` may hold back the tail that could still start a value
 * (`pending` raw bytes, at most three times the longest form); `end` lets it
 * through. */
export class CodingSecretMaskStream {
	readonly #forms: readonly Uint8Array[];
	readonly #byFirst: ReadonlyMap<number, readonly number[]>;
	#held = new Uint8Array(0);
	#emitted = 0;
	#partials: Partial[] = [];
	#masked: [number, number][] = [];
	#ended = false;

	constructor(forms: readonly Uint8Array[], byFirst: ReadonlyMap<number, readonly number[]>) {
		this.#forms = forms;
		this.#byFirst = byFirst;
	}

	/** Raw bytes pushed and not yet returned. */
	pending(): number {
		return this.#held.length;
	}

	push(chunk: Uint8Array): Uint8Array {
		if (this.#ended) throw new Error("the coding secret mask stream has ended");
		if (chunk.length === 0) return new Uint8Array(0);
		if (this.#forms.length === 0 && this.#held.length === 0) {
			this.#emitted += chunk.length;
			return Uint8Array.from(chunk);
		}
		const base = this.#emitted + this.#held.length;
		const held = new Uint8Array(this.#held.length + chunk.length);
		held.set(this.#held);
		held.set(chunk, this.#held.length);
		this.#held = held;
		for (let i = 0; i < chunk.length; i++) this.#step(chunk[i], base + i);
		let boundary = this.#emitted + this.#held.length;
		for (const partial of this.#partials) boundary = Math.min(boundary, partial.start);
		for (const [start, end] of this.#masked) {
			if (start < boundary && boundary < end) boundary = start;
		}
		return this.#emit(boundary);
	}

	end(): Uint8Array {
		if (this.#ended) return new Uint8Array(0);
		this.#ended = true;
		this.#partials = [];
		return this.#emit(this.#emitted + this.#held.length);
	}

	#step(byte: number, offset: number): void {
		const starts = byte === PERCENT ? this.#forms.keys() : (this.#byFirst.get(byte) ?? []);
		if (this.#partials.length === 0 && byte !== PERCENT && !this.#byFirst.has(byte)) return;
		// Partials are kept in order of their start, so the first one kept for a
		// state is the longest, and it alone can mask that state's match.
		const next = new Map<number, Partial>();
		const count = this.#forms.length;
		const keep = (partial: Partial) => {
			if (partial.phase === NEXT && partial.index === this.#forms[partial.form].length) {
				this.#mask(partial.start, offset + 1);
				return;
			}
			const key = ((partial.index * 4 + partial.phase) * 16 + partial.digit) * count + partial.form;
			if (!next.has(key)) next.set(key, partial);
		};
		for (const partial of this.#partials) this.#advance(partial, byte, keep);
		for (const form of starts) this.#advance({ form, index: 0, phase: NEXT, digit: 0, start: offset }, byte, keep);
		this.#partials = [...next.values()];
	}

	#advance(partial: Partial, byte: number, keep: (partial: Partial) => void): void {
		const expected = this.#forms[partial.form][partial.index];
		if (partial.phase === NEXT) {
			if (byte === expected || (expected === SPACE && byte === PLUS)) keep({ ...partial, index: partial.index + 1 });
			if (byte === PERCENT) keep({ ...partial, phase: AFTER_PERCENT });
			if (expected === LF && byte === CR) keep({ ...partial, phase: AFTER_CR });
		} else if (partial.phase === AFTER_PERCENT) {
			const digit = hexDigit(byte);
			if (digit >= 0) keep({ ...partial, phase: AFTER_DIGIT, digit });
		} else if (partial.phase === AFTER_DIGIT) {
			const digit = hexDigit(byte);
			if (digit >= 0 && partial.digit * 16 + digit === expected) {
				keep({ ...partial, index: partial.index + 1, phase: NEXT, digit: 0 });
			}
		} else if (byte === LF) {
			keep({ ...partial, index: partial.index + 1, phase: NEXT });
		}
	}

	#mask(start: number, end: number): void {
		const merged: [number, number][] = [];
		let range: [number, number] = [start, end];
		for (const existing of this.#masked) {
			if (existing[1] < range[0] || range[1] < existing[0]) merged.push(existing);
			else range = [Math.min(range[0], existing[0]), Math.max(range[1], existing[1])];
		}
		merged.push(range);
		merged.sort((a, b) => a[0] - b[0]);
		this.#masked = merged;
	}

	#emit(boundary: number): Uint8Array {
		const count = boundary - this.#emitted;
		if (count <= 0) return new Uint8Array(0);
		const parts: Uint8Array[] = [];
		let at = this.#emitted;
		const rest: [number, number][] = [];
		for (const [start, end] of this.#masked) {
			if (start >= boundary) {
				rest.push([start, end]);
				continue;
			}
			if (start > at) parts.push(this.#held.subarray(at - this.#emitted, start - this.#emitted));
			parts.push(MASK);
			at = end;
		}
		if (boundary > at) parts.push(this.#held.subarray(at - this.#emitted, boundary - this.#emitted));
		const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
		let length = 0;
		for (const part of parts) {
			out.set(part, length);
			length += part.length;
		}
		this.#held = this.#held.slice(count);
		this.#emitted = boundary;
		this.#masked = rest;
		return out;
	}
}
