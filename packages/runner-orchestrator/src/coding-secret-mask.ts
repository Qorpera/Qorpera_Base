/** The shortest value the mask takes. The broker is to refuse a shorter
 * environment secret when it is captured (F3 5j-3), so every value a coding
 * machine is given can be masked. */
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

/** A form matched up to `index`, in `phase` after it (with `digit`, the first
 * hex digit after a `%`), from the raw offset `start`. */
interface Candidate {
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
 * terminal. `push` holds back the tail that could still start a value
 * (`pending` raw bytes, less than three times the longest form), and `end`
 * lets it through. Overlapping or touching matches become one `***`, wherever
 * the chunk boundaries fall. A new stream can take over at that tail
 * (`masked`, then `resume`), so the bytes can be pushed again later. */
export class CodingSecretMaskStream {
	readonly #forms: readonly Uint8Array[];
	readonly #byFirst: ReadonlyMap<number, readonly number[]>;
	#held = new Uint8Array(0);
	#emitted = 0;
	#candidates: Candidate[] = [];
	#masked: [number, number][] = [];
	/** Whether the bytes returned so far end inside a masked range. */
	#joined = false;
	#ended = false;
	#matched = false;

	constructor(forms: readonly Uint8Array[], byFirst: ReadonlyMap<number, readonly number[]>) {
		this.#forms = forms;
		this.#byFirst = byFirst;
	}

	/** Whether a value matched in the bytes pushed so far (the push check, 5j-5 b), returned yet or not. */
	get matched(): boolean {
		return this.#matched;
	}

	/** Raw bytes pushed and not yet returned. */
	pending(): number {
		return this.#held.length;
	}

	/** Where the bytes held back (`pending`) start, for a stream that takes over there: `null` when what was returned
	 * so far doesn't end in a `***`; else how many of those bytes are already behind that `***` (0 for none yet, when
	 * a match that starts there still continues it). */
	masked(): number | null {
		if (!this.#joined) return null;
		const first = this.#masked[0];
		return first !== undefined && first[0] === this.#emitted ? first[1] - this.#emitted : 0;
	}

	/** Before the first push: takes over from a stream whose `masked()` this was, at the start of the bytes it held
	 * back, which are pushed again. From there it returns what that stream would have. */
	resume(masked: number | null): void {
		if (this.#ended || this.#emitted > 0 || this.#held.length > 0) {
			throw new Error("a coding secret mask stream resumes only before its first push");
		}
		if (masked === null) return;
		if (!Number.isSafeInteger(masked) || masked < 0) throw new RangeError("a masked byte count is a whole number");
		this.#joined = true;
		this.#masked = masked > 0 ? [[0, masked]] : [];
	}

	push(chunk: Uint8Array): Uint8Array {
		if (this.#ended) throw new Error("the coding secret mask stream has ended");
		if (chunk.length === 0) return new Uint8Array(0);
		if (this.#forms.length === 0 && this.#held.length === 0 && this.#masked.length === 0) {
			this.#emitted += chunk.length;
			this.#joined = false;
			return Uint8Array.from(chunk);
		}
		const base = this.#emitted + this.#held.length;
		const held = new Uint8Array(this.#held.length + chunk.length);
		held.set(this.#held);
		held.set(chunk, this.#held.length);
		this.#held = held;
		for (let i = 0; i < chunk.length; i++) this.#step(chunk[i], base + i);
		let boundary = this.#emitted + this.#held.length;
		for (const candidate of this.#candidates) boundary = Math.min(boundary, candidate.start);
		return this.#emit(boundary);
	}

	end(): Uint8Array {
		if (this.#ended) return new Uint8Array(0);
		this.#ended = true;
		this.#candidates = [];
		return this.#emit(this.#emitted + this.#held.length);
	}

	#step(byte: number, offset: number): void {
		if (this.#candidates.length === 0 && byte !== PERCENT && !this.#byFirst.has(byte)) return;
		// Candidates are kept in order of their start, so the first one kept for a
		// state is the longest, and it alone can mask that state's match.
		const next = new Map<number, Candidate>();
		const count = this.#forms.length;
		const keep = (candidate: Candidate) => {
			if (candidate.phase === NEXT && candidate.index === this.#forms[candidate.form].length) {
				this.#mask(candidate.start, offset + 1);
				return;
			}
			const key = ((candidate.index * 4 + candidate.phase) * 16 + candidate.digit) * count + candidate.form;
			if (!next.has(key)) next.set(key, candidate);
		};
		for (const candidate of this.#candidates) this.#advance(candidate, byte, keep);
		const starts = byte === PERCENT ? this.#forms.keys() : (this.#byFirst.get(byte) ?? []);
		for (const form of starts) this.#advance({ form, index: 0, phase: NEXT, digit: 0, start: offset }, byte, keep);
		this.#candidates = [...next.values()];
	}

	#advance(candidate: Candidate, byte: number, keep: (candidate: Candidate) => void): void {
		const expected = this.#forms[candidate.form][candidate.index];
		if (candidate.phase === NEXT) {
			const literal = byte === expected || (expected === SPACE && byte === PLUS);
			if (literal) keep({ ...candidate, index: candidate.index + 1 });
			if (byte === PERCENT) keep({ ...candidate, phase: AFTER_PERCENT });
			if (expected === LF && byte === CR) keep({ ...candidate, phase: AFTER_CR });
		} else if (candidate.phase === AFTER_PERCENT) {
			const digit = hexDigit(byte);
			if (digit >= 0) keep({ ...candidate, phase: AFTER_DIGIT, digit });
		} else if (candidate.phase === AFTER_DIGIT) {
			const digit = hexDigit(byte);
			if (digit >= 0 && candidate.digit * 16 + digit === expected) {
				keep({ ...candidate, index: candidate.index + 1, phase: NEXT, digit: 0 });
			}
		} else if (byte === LF) {
			keep({ ...candidate, index: candidate.index + 1, phase: NEXT });
		}
	}

	/** The ranges stay sorted and apart. A match ends at the byte just read, so
	 * it ends at or after every range so far and can only reach back into the
	 * last ones: those that end at or after its start merge into it. */
	#mask(start: number, end: number): void {
		this.#matched = true;
		let from = start;
		let to = end;
		while (this.#masked.length > 0) {
			const last = this.#masked[this.#masked.length - 1];
			if (last[1] < from) break;
			from = Math.min(from, last[0]);
			to = Math.max(to, last[1]);
			this.#masked.pop();
		}
		this.#masked.push([from, to]);
	}

	/** Returns the raw bytes before `boundary` with each masked range as `***`.
	 * A range the boundary falls inside is split there, so a run of overlapping
	 * matches is never held back whole, and a range that starts where the last
	 * one returned ended continues that `***` rather than writing another. */
	#emit(boundary: number): Uint8Array {
		const count = boundary - this.#emitted;
		if (count <= 0) return new Uint8Array(0);
		const parts: Uint8Array[] = [];
		const rest: [number, number][] = [];
		let at = this.#emitted;
		let joined = this.#joined;
		for (const [start, end] of this.#masked) {
			if (start >= boundary) {
				rest.push([start, end]);
				continue;
			}
			if (start > at) {
				parts.push(this.#held.subarray(at - this.#emitted, start - this.#emitted));
				joined = false;
			}
			if (!joined) parts.push(MASK);
			joined = true;
			at = Math.min(end, boundary);
			if (end > boundary) rest.push([boundary, end]);
		}
		if (boundary > at) {
			parts.push(this.#held.subarray(at - this.#emitted, boundary - this.#emitted));
			joined = false;
		}
		const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
		let length = 0;
		for (const part of parts) {
			out.set(part, length);
			length += part.length;
		}
		this.#held = this.#held.slice(count);
		this.#emitted = boundary;
		this.#masked = rest;
		this.#joined = joined;
		return out;
	}
}
