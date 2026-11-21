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

const EMPTY_I32 = new Int32Array(0);
const EMPTY_U32 = new Uint32Array(0);
const EMPTY_F64 = new Float64Array(0);

const HEX = new Int8Array(256).fill(-1);
for (let b = 0x30; b <= 0x39; b++) HEX[b] = b - 0x30;
for (let b = 0x41; b <= 0x46; b++) HEX[b] = b - 0x37;
for (let b = 0x61; b <= 0x66; b++) HEX[b] = b - 0x57;

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
	readonly #byFirst: (number[] | undefined)[] = new Array(256);
	readonly #byFirstExact: (number[] | undefined)[] = new Array(256);
	readonly #pairBits = new Uint8Array(8192);

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

	clone(): CodingSecretMask {
		const copy = new CodingSecretMask();
		copy.#forms.push(...this.#forms);
		for (const key of this.#known) copy.#known.add(key);
		for (const value of this.#values) copy.#values.add(value);
		for (let i = 0; i < 256; i++) {
			const first = this.#byFirst[i];
			if (first !== undefined) copy.#byFirst[i] = [...first];
			const exact = this.#byFirstExact[i];
			if (exact !== undefined) copy.#byFirstExact[i] = [...exact];
		}
		copy.#pairBits.set(this.#pairBits);
		return copy;
	}

	stream(): CodingSecretMaskStream {
		return new CodingSecretMaskStream(this.#forms, this.#byFirst, this.#byFirstExact, this.#pairBits);
	}

	#setPair(first: number, second: number): void {
		const pair = (first << 8) | second;
		this.#pairBits[pair >>> 3] |= 1 << (pair & 7);
	}

	#addForm(bytes: Uint8Array): void {
		const key = Buffer.from(bytes).toString("latin1");
		if (this.#known.has(key)) return;
		this.#known.add(key);
		const form = this.#forms.push(bytes) - 1;
		const b0 = bytes[0]!;
		const exact = this.#byFirstExact[b0];
		if (exact) exact.push(form);
		else this.#byFirstExact[b0] = [form];
		const firsts = b0 === SPACE ? [SPACE, PLUS] : b0 === LF ? [LF, CR] : [b0];
		for (const first of firsts) {
			const list = this.#byFirst[first];
			if (list) list.push(form);
			else this.#byFirst[first] = [form];
		}
		const b1 = bytes[1]!;
		const seconds = b1 === SPACE ? [SPACE, PLUS] : b1 === LF ? [LF, CR] : [b1];
		if (b0 === LF) {
			// WHY: CR at byte 0 enters AFTER_CR and only survives on LF, whereas LF advances to bytes[1].
			this.#setPair(CR, LF);
			for (const second of seconds) this.#setPair(LF, second);
		} else {
			for (const first of firsts) {
				for (const second of seconds) this.#setPair(first, second);
			}
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
	readonly #byFirst: readonly (readonly number[] | undefined)[];
	readonly #byFirstExact: readonly (readonly number[] | undefined)[];
	readonly #pairBits: Uint8Array;
	#held = new Uint8Array(0);
	#emitted = 0;
	#scanned = 0;
	#curForm = EMPTY_I32;
	#curIndex = EMPTY_I32;
	#curPhase = EMPTY_I32;
	#curDigit = EMPTY_I32;
	#curStart = EMPTY_F64;
	#curLen = 0;
	#nxtForm = EMPTY_I32;
	#nxtIndex = EMPTY_I32;
	#nxtPhase = EMPTY_I32;
	#nxtDigit = EMPTY_I32;
	#nxtStart = EMPTY_F64;
	#nxtLen = 0;
	#dedupEpoch = EMPTY_U32;
	#dedupLo = EMPTY_I32;
	#dedupHi = EMPTY_I32;
	#dedupMask = 0;
	#epoch = 0;
	#wildPhase = 0;
	#wildDigit = 0;
	#wildStart = 0;
	#wildLimit = 0;
	#masked: [number, number][] = [];
	/** Whether the bytes returned so far end inside a masked range. */
	#joined = false;
	#ended = false;
	#matched = false;
	#scanOnly = false;
	#pushUsed = false;

	constructor(
		forms: readonly Uint8Array[],
		byFirst: readonly (readonly number[] | undefined)[],
		byFirstExact: readonly (readonly number[] | undefined)[],
		pairBits: Uint8Array,
	) {
		this.#forms = forms;
		this.#byFirst = byFirst;
		this.#byFirstExact = byFirstExact;
		this.#pairBits = pairBits;
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
		if (this.#ended || this.#scanOnly || this.#emitted > 0 || this.#held.length > 0) {
			throw new Error("a coding secret mask stream resumes only before its first push");
		}
		if (masked === null) return;
		if (!Number.isSafeInteger(masked) || masked < 0) throw new RangeError("a masked byte count is a whole number");
		this.#joined = true;
		this.#masked = masked > 0 ? [[0, masked]] : [];
	}

	scan(chunk: Uint8Array): boolean {
		if (this.#ended) throw new Error("the coding secret mask stream has ended");
		if (this.#pushUsed) throw new Error("a coding secret mask stream cannot mix scan and push");
		this.#scanOnly = true;
		if (this.#matched) return true;
		if (chunk.length === 0 || this.#forms.length === 0) return false;
		const base = this.#scanned;
		this.#scanned += chunk.length;
		return this.#runChunk(chunk, base, true);
	}

	push(chunk: Uint8Array): Uint8Array {
		if (this.#ended) throw new Error("the coding secret mask stream has ended");
		if (this.#scanOnly) throw new Error("a coding secret mask stream cannot mix scan and push");
		this.#pushUsed = true;
		if (chunk.length === 0) return new Uint8Array(0);
		if (this.#forms.length === 0 && this.#held.length === 0 && this.#masked.length === 0) {
			this.#emitted += chunk.length;
			this.#joined = false;
			return Uint8Array.from(chunk);
		}
		const base = this.#emitted + this.#held.length;
		this.#runChunk(chunk, base, false);
		let boundary = base + chunk.length;
		if (this.#curLen > 0) boundary = Math.min(boundary, this.#curStart[0]!);
		if (this.#wildPhase !== 0) boundary = Math.min(boundary, this.#wildStart);
		if (this.#masked.length === 0) {
			const count = boundary - this.#emitted;
			if (this.#held.length === 0) {
				if (count === chunk.length) {
					this.#emitted = boundary;
					this.#joined = false;
					return Uint8Array.from(chunk);
				}
				if (count <= 0) {
					this.#held = Uint8Array.from(chunk);
					return new Uint8Array(0);
				}
				this.#held = chunk.slice(count);
				this.#emitted = boundary;
				this.#joined = false;
				return chunk.slice(0, count);
			}
			if (count <= 0) {
				const held = new Uint8Array(this.#held.length + chunk.length);
				held.set(this.#held);
				held.set(chunk, this.#held.length);
				this.#held = held;
				return new Uint8Array(0);
			}
			this.#emitted = boundary;
			this.#joined = false;
			if (count <= this.#held.length) {
				const out = this.#held.slice(0, count);
				const remain = this.#held.length - count;
				const held = new Uint8Array(remain + chunk.length);
				held.set(this.#held.subarray(count));
				held.set(chunk, remain);
				this.#held = held;
				return out;
			}
			const fromChunk = count - this.#held.length;
			const out = new Uint8Array(count);
			out.set(this.#held);
			out.set(chunk.subarray(0, fromChunk), this.#held.length);
			this.#held = fromChunk < chunk.length ? chunk.slice(fromChunk) : new Uint8Array(0);
			return out;
		}
		const held = new Uint8Array(this.#held.length + chunk.length);
		held.set(this.#held);
		held.set(chunk, this.#held.length);
		this.#held = held;
		return this.#emit(boundary);
	}

	end(): Uint8Array {
		if (this.#ended) return new Uint8Array(0);
		this.#ended = true;
		this.#curLen = 0;
		this.#wildPhase = 0;
		return this.#emit(this.#emitted + this.#held.length);
	}

	#runChunk(chunk: Uint8Array, base: number, stopOnMatch: boolean): boolean {
		const len = chunk.length;
		const byFirst = this.#byFirst;
		const byFirstExact = this.#byFirstExact;
		const pairBits = this.#pairBits;
		for (let i = 0; i < len; ) {
			if (this.#curLen === 0 && this.#wildPhase === 0) {
				const b0 = chunk[i]!;
				if (b0 !== PERCENT) {
					if (byFirst[b0] === undefined) {
						i++;
						continue;
					}
					if (i + 1 < len) {
						const b1 = chunk[i + 1]!;
						if (b1 !== PERCENT) {
							const pair = (b0 << 8) | b1;
							if ((pairBits[pair >>> 3]! & (1 << (pair & 7))) === 0) {
								i++;
								continue;
							}
						}
					}
				} else if (byFirst[PERCENT] === undefined && i + 1 < len) {
					const hi = HEX[chunk[i + 1]!]!;
					if (hi < 0) {
						i++;
						continue;
					}
					if (i + 2 < len) {
						const lo = HEX[chunk[i + 2]!]!;
						if (lo < 0 || byFirstExact[(hi << 4) | lo] === undefined) {
							i++;
							continue;
						}
					}
				}
			}
			if (this.#step(chunk[i]!, base + i, stopOnMatch)) return true;
			i++;
		}
		return false;
	}

	#growNext(): void {
		const cap = this.#nxtForm.length === 0 ? 16 : this.#nxtForm.length * 2;
		const form = new Int32Array(cap);
		const index = new Int32Array(cap);
		const phase = new Int32Array(cap);
		const digit = new Int32Array(cap);
		const start = new Float64Array(cap);
		form.set(this.#nxtForm);
		index.set(this.#nxtIndex);
		phase.set(this.#nxtPhase);
		digit.set(this.#nxtDigit);
		start.set(this.#nxtStart);
		this.#nxtForm = form;
		this.#nxtIndex = index;
		this.#nxtPhase = phase;
		this.#nxtDigit = digit;
		this.#nxtStart = start;
	}

	#growDedup(): void {
		const cap = this.#dedupEpoch.length === 0 ? 32 : this.#dedupEpoch.length * 2;
		const epoch = new Uint32Array(cap);
		const lo = new Int32Array(cap);
		const hi = new Int32Array(cap);
		const mask = cap - 1;
		const curEpoch = 1;
		this.#epoch = curEpoch;
		for (let i = 0; i < this.#nxtLen; i++) {
			const f = this.#nxtForm[i]!;
			const h = (this.#nxtIndex[i]! << 6) | (this.#nxtPhase[i]! << 4) | this.#nxtDigit[i]!;
			let slot = (Math.imul(f ^ h, 0x9e3779b1) >>> 0) & mask;
			while (epoch[slot] === curEpoch) slot = (slot + 1) & mask;
			epoch[slot] = curEpoch;
			lo[slot] = f;
			hi[slot] = h;
		}
		this.#dedupEpoch = epoch;
		this.#dedupLo = lo;
		this.#dedupHi = hi;
		this.#dedupMask = mask;
	}

	#keep(
		form: number,
		index: number,
		phase: number,
		digit: number,
		start: number,
		offset: number,
		stopOnMatch: boolean,
	): boolean {
		if (phase === NEXT && index === this.#forms[form]!.length) {
			if (stopOnMatch) {
				this.#matched = true;
				return true;
			}
			this.#mask(start, offset + 1);
			return false;
		}
		if (this.#nxtLen * 2 >= this.#dedupEpoch.length) this.#growDedup();
		const hi = (index << 6) | (phase << 4) | digit;
		const mask = this.#dedupMask;
		const epoch = this.#epoch;
		const dedupEpoch = this.#dedupEpoch;
		const dedupLo = this.#dedupLo;
		const dedupHi = this.#dedupHi;
		let slot = (Math.imul(form ^ hi, 0x9e3779b1) >>> 0) & mask;
		while (dedupEpoch[slot] === epoch) {
			if (dedupLo[slot] === form && dedupHi[slot] === hi) return false;
			slot = (slot + 1) & mask;
		}
		dedupEpoch[slot] = epoch;
		dedupLo[slot] = form;
		dedupHi[slot] = hi;
		const n = this.#nxtLen;
		if (n === this.#nxtForm.length) this.#growNext();
		this.#nxtForm[n] = form;
		this.#nxtIndex[n] = index;
		this.#nxtPhase[n] = phase;
		this.#nxtDigit[n] = digit;
		this.#nxtStart[n] = start;
		this.#nxtLen = n + 1;
		return false;
	}

	#step(byte: number, offset: number, stopOnMatch: boolean): boolean {
		let epoch = this.#epoch + 1;
		if (epoch === 0xffffffff) {
			this.#dedupEpoch.fill(0);
			epoch = 1;
		}
		this.#epoch = epoch;
		this.#nxtLen = 0;

		// WHY: A single wildcard state tracks index-0 %XX across all forms in O(1), expanding only on the second hex digit.
		const prevWildPhase = this.#wildPhase;
		const prevWildDigit = this.#wildDigit;
		const prevWildStart = this.#wildStart;
		const prevWildLimit = this.#wildLimit;
		let nextWildPhase = 0;
		let nextWildDigit = 0;
		let nextWildStart = 0;
		let nextWildLimit = 0;
		let wildExpandForms: readonly number[] | undefined;

		if (prevWildPhase === AFTER_PERCENT) {
			const digit = HEX[byte]!;
			if (digit >= 0) {
				nextWildPhase = AFTER_DIGIT;
				nextWildDigit = digit;
				nextWildStart = prevWildStart;
				nextWildLimit = prevWildLimit;
			}
		} else if (prevWildPhase === AFTER_DIGIT) {
			const digit = HEX[byte]!;
			if (digit >= 0) {
				wildExpandForms = this.#byFirstExact[(prevWildDigit << 4) | digit];
			}
		}

		// WHY: Preserve non-decreasing start order so the first candidate kept for any state is always the longest match.
		const curLen = this.#curLen;
		const curForm = this.#curForm;
		const curIndex = this.#curIndex;
		const curPhase = this.#curPhase;
		const curDigit = this.#curDigit;
		const curStart = this.#curStart;
		let k = 0;
		if (wildExpandForms !== undefined) {
			while (k < curLen && curStart[k]! <= prevWildStart) {
				if (
					this.#advance(
						curForm[k]!,
						curIndex[k]!,
						curPhase[k]!,
						curDigit[k]!,
						curStart[k]!,
						byte,
						offset,
						stopOnMatch,
					)
				) {
					return true;
				}
				k++;
			}
			for (let w = 0; w < wildExpandForms.length; w++) {
				const form = wildExpandForms[w]!;
				if (form < prevWildLimit && this.#keep(form, 1, NEXT, 0, prevWildStart, offset, stopOnMatch)) {
					return true;
				}
			}
		}
		while (k < curLen) {
			if (
				this.#advance(
					curForm[k]!,
					curIndex[k]!,
					curPhase[k]!,
					curDigit[k]!,
					curStart[k]!,
					byte,
					offset,
					stopOnMatch,
				)
			) {
				return true;
			}
			k++;
		}

		if (byte === PERCENT) {
			const literalStarts = this.#byFirst[PERCENT];
			if (literalStarts !== undefined) {
				for (let s = 0; s < literalStarts.length; s++) {
					if (this.#keep(literalStarts[s]!, 1, NEXT, 0, offset, offset, stopOnMatch)) return true;
				}
			}
			if (this.#forms.length > 0) {
				nextWildPhase = AFTER_PERCENT;
				nextWildDigit = 0;
				nextWildStart = offset;
				nextWildLimit = this.#forms.length;
			}
		} else {
			const starts = this.#byFirst[byte];
			if (starts !== undefined) {
				for (let s = 0; s < starts.length; s++) {
					const form = starts[s]!;
					if (this.#forms[form]![0] === LF && byte === CR) {
						if (this.#keep(form, 0, AFTER_CR, 0, offset, offset, stopOnMatch)) return true;
					} else {
						if (this.#keep(form, 1, NEXT, 0, offset, offset, stopOnMatch)) return true;
					}
				}
			}
		}

		this.#wildPhase = nextWildPhase;
		this.#wildDigit = nextWildDigit;
		this.#wildStart = nextWildStart;
		this.#wildLimit = nextWildLimit;

		const tmpForm = this.#curForm;
		const tmpIndex = this.#curIndex;
		const tmpPhase = this.#curPhase;
		const tmpDigit = this.#curDigit;
		const tmpStart = this.#curStart;
		this.#curForm = this.#nxtForm;
		this.#curIndex = this.#nxtIndex;
		this.#curPhase = this.#nxtPhase;
		this.#curDigit = this.#nxtDigit;
		this.#curStart = this.#nxtStart;
		this.#nxtForm = tmpForm;
		this.#nxtIndex = tmpIndex;
		this.#nxtPhase = tmpPhase;
		this.#nxtDigit = tmpDigit;
		this.#nxtStart = tmpStart;
		this.#curLen = this.#nxtLen;
		return false;
	}

	#advance(
		form: number,
		index: number,
		phase: number,
		digit: number,
		start: number,
		byte: number,
		offset: number,
		stopOnMatch: boolean,
	): boolean {
		const expected = this.#forms[form]![index]!;
		if (phase === NEXT) {
			if (byte === expected || (expected === SPACE && byte === PLUS)) {
				if (this.#keep(form, index + 1, NEXT, 0, start, offset, stopOnMatch)) return true;
			}
			if (byte === PERCENT) {
				if (this.#keep(form, index, AFTER_PERCENT, 0, start, offset, stopOnMatch)) return true;
			}
			if (expected === LF && byte === CR) {
				if (this.#keep(form, index, AFTER_CR, 0, start, offset, stopOnMatch)) return true;
			}
		} else if (phase === AFTER_PERCENT) {
			const nextDigit = HEX[byte]!;
			if (nextDigit >= 0) {
				if (this.#keep(form, index, AFTER_DIGIT, nextDigit, start, offset, stopOnMatch)) return true;
			}
		} else if (phase === AFTER_DIGIT) {
			const nextDigit = HEX[byte]!;
			if (nextDigit >= 0 && (digit << 4) + nextDigit === expected) {
				if (this.#keep(form, index + 1, NEXT, 0, start, offset, stopOnMatch)) return true;
			}
		} else if (byte === LF) {
			if (this.#keep(form, index + 1, NEXT, 0, start, offset, stopOnMatch)) return true;
		}
		return false;
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
