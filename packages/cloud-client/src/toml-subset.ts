/** A strict subset of TOML 1.0 for interface and table files (RUNTIME-INTERFACES.md §3). It reads what those files
 * use and refuses the rest with a line number, so the same bytes always mean the same thing in every reader:
 *
 * - comments, `[table]` and `[[array.of.tables]]` headers (bare or "quoted" key parts);
 * - `key = value` with a bare or "quoted" key (no dotted keys);
 * - values: "basic" and 'literal' strings on one line, decimal integers and floats, true and false, arrays (which
 *   may span lines) and inline tables (on one line).
 *
 * Not read: multi-line strings, dates and times, hex/octal/binary, inf/nan and `_` in numbers, dotted keys.
 * One pass over the text, no backtracking, so any input is read in linear time. Every key ends up an own property
 * (`__proto__` included), so a file can't reach an object's prototype. Browser-safe. */

export class TomlSubsetError extends Error {
	readonly line: number;
	constructor(line: number, message: string) {
		super(message);
		this.name = "TomlSubsetError";
		this.line = line;
	}
}

export interface TomlSubsetDocument {
	readonly value: Record<string, unknown>;
	/** The line each table header and key sits on, by path: `view.0.block.1.from`. An array of tables counts its
	 * entries from 0 under the array's key. */
	readonly lines: ReadonlyMap<string, number>;
}

const MAX_DEPTH = 8;
/** How a text that spans lines is written instead, said with each refusal of one (a model's first try often is). */
const ONE_LINE = 'write it on one line in "double quotes", with \\n for each line break';

function define(target: Record<string, unknown>, key: string, value: unknown): void {
	Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

function isBareKeyChar(code: number): boolean {
	return (
		(code >= 0x41 && code <= 0x5a) ||
		(code >= 0x61 && code <= 0x7a) ||
		(code >= 0x30 && code <= 0x39) ||
		code === 0x5f ||
		code === 0x2d
	);
}

export function parseTomlSubset(text: string): TomlSubsetDocument {
	return new Reader(text).document();
}

class Reader {
	private i = 0;
	private line = 1;
	private readonly root: Record<string, unknown> = {};
	private readonly lines = new Map<string, number>();
	/** Tables a header defined, inline tables, and arrays of tables: what a later header may and may not reopen. */
	private readonly defined = new WeakSet<object>();
	private readonly frozen = new WeakSet<object>();
	private readonly tableArrays = new WeakSet<object>();
	private current: Record<string, unknown> = this.root;
	private prefix = "";

	private readonly text: string;

	constructor(text: string) {
		this.text = text;
	}

	document(): TomlSubsetDocument {
		const n = this.text.length;
		while (this.i < n) {
			this.skipBlank();
			if (this.i >= n) break;
			const ch = this.text[this.i];
			if (ch === "\n" || ch === "\r") {
				this.newline();
				continue;
			}
			if (ch === "#") {
				this.comment();
				continue;
			}
			if (ch === "[") this.header();
			else this.keyValue();
			this.endOfLine();
		}
		return { value: this.root, lines: this.lines };
	}

	private fail(message: string): never {
		throw new TomlSubsetError(this.line, message);
	}

	private skipBlank(): void {
		while (this.i < this.text.length && (this.text[this.i] === " " || this.text[this.i] === "\t")) this.i++;
	}

	private newline(): void {
		if (this.text[this.i] === "\r") {
			if (this.text[this.i + 1] !== "\n") this.fail("A carriage return must be followed by a line feed.");
			this.i++;
		}
		this.i++;
		this.line++;
	}

	private comment(): void {
		while (this.i < this.text.length && this.text[this.i] !== "\n" && this.text[this.i] !== "\r") {
			const code = this.text.charCodeAt(this.i);
			if ((code < 0x20 && code !== 0x09) || code === 0x7f) this.fail("A comment holds a control character.");
			this.i++;
		}
	}

	private endOfLine(): void {
		this.skipBlank();
		if (this.i >= this.text.length) return;
		const ch = this.text[this.i];
		if (ch === "#") {
			this.comment();
			return;
		}
		if (ch === "\n" || ch === "\r") return;
		this.fail("Expected the end of the line here.");
	}

	private key(): string {
		const ch = this.text[this.i];
		if (ch === '"') return this.basicString();
		if (ch === "'") return this.literalString();
		const start = this.i;
		while (this.i < this.text.length && isBareKeyChar(this.text.charCodeAt(this.i))) this.i++;
		if (this.i === start) this.fail("Expected a key: letters, digits, _ and -, or a quoted key.");
		return this.text.slice(start, this.i);
	}

	private header(): void {
		const many = this.text[this.i + 1] === "[";
		this.i += many ? 2 : 1;
		const parts: string[] = [];
		for (;;) {
			this.skipBlank();
			parts.push(this.key());
			this.skipBlank();
			if (this.text[this.i] === ".") {
				this.i++;
				continue;
			}
			break;
		}
		if (many) {
			if (this.text[this.i] !== "]" || this.text[this.i + 1] !== "]") this.fail("A [[header]] ends with ]].");
			this.i += 2;
		} else {
			if (this.text[this.i] !== "]") this.fail("A [header] ends with ].");
			this.i++;
		}
		let target = this.root;
		let path = "";
		for (let p = 0; p < parts.length - 1; p++) {
			const part = parts[p] ?? "";
			path = path ? `${path}.${part}` : part;
			if (!Object.hasOwn(target, part)) {
				const table: Record<string, unknown> = {};
				define(target, part, table);
				target = table;
				continue;
			}
			const value = target[part];
			if (Array.isArray(value) && this.tableArrays.has(value)) {
				const last = value[value.length - 1] as Record<string, unknown>;
				path = `${path}.${value.length - 1}`;
				target = last;
			} else if (isTable(value) && !this.frozen.has(value)) {
				target = value;
			} else {
				this.fail(`"${part}" is already a value, not a table.`);
			}
		}
		const last = parts[parts.length - 1] ?? "";
		path = path ? `${path}.${last}` : last;
		if (many) {
			let array = target[last] as unknown;
			if (!Object.hasOwn(target, last)) {
				array = [];
				this.tableArrays.add(array as object);
				define(target, last, array);
			} else if (!Array.isArray(array) || !this.tableArrays.has(array)) {
				this.fail(`"${last}" is already defined, not as [[${parts.join(".")}]].`);
			}
			const table: Record<string, unknown> = {};
			(array as unknown[]).push(table);
			path = `${path}.${(array as unknown[]).length - 1}`;
			this.current = table;
		} else {
			if (Object.hasOwn(target, last)) {
				const value = target[last];
				if (
					!isTable(value) ||
					this.frozen.has(value) ||
					this.defined.has(value) ||
					(Array.isArray(value) && this.tableArrays.has(value))
				) {
					this.fail(`[${parts.join(".")}] is already defined.`);
				}
				this.current = value as Record<string, unknown>;
			} else {
				const table: Record<string, unknown> = {};
				define(target, last, table);
				this.current = table;
			}
			this.defined.add(this.current);
		}
		this.prefix = path;
		if (!this.lines.has(path)) this.lines.set(path, this.line);
	}

	private keyValue(): void {
		const line = this.line;
		const key = this.key();
		this.skipBlank();
		if (this.text[this.i] === ".") this.fail("Dotted keys are not used in these files; write a [table] instead.");
		if (this.text[this.i] !== "=") this.fail(`Expected = after "${key}".`);
		this.i++;
		this.skipBlank();
		if (Object.hasOwn(this.current, key)) this.fail(`"${key}" is set twice.`);
		const value = this.value(0);
		define(this.current, key, value);
		const path = this.prefix ? `${this.prefix}.${key}` : key;
		this.lines.set(path, line);
	}

	private value(depth: number): unknown {
		if (depth > MAX_DEPTH) this.fail("Values are nested too deeply.");
		const ch = this.text[this.i];
		if (ch === '"') {
			if (this.text.startsWith('"""', this.i))
				this.fail(`Multi-line strings are not used in these files: ${ONE_LINE}.`);
			return this.basicString();
		}
		if (ch === "'") {
			if (this.text.startsWith("'''", this.i))
				this.fail(`Multi-line strings are not used in these files: ${ONE_LINE}.`);
			return this.literalString();
		}
		if (ch === "[") return this.array(depth);
		if (ch === "{") return this.inlineTable(depth);
		if (this.text.startsWith("true", this.i) && !isBareKeyChar(this.text.charCodeAt(this.i + 4))) {
			this.i += 4;
			return true;
		}
		if (this.text.startsWith("false", this.i) && !isBareKeyChar(this.text.charCodeAt(this.i + 5))) {
			this.i += 5;
			return false;
		}
		return this.number();
	}

	private number(): number {
		const start = this.i;
		while (this.i < this.text.length && /[0-9A-Za-z+\-._:]/.test(this.text[this.i] ?? "")) this.i++;
		const token = this.text.slice(start, this.i);
		if (token === "") this.fail("Expected a value: text in quotes, a number, true, false, [a list] or { a table }.");
		if (/^[+-]?(?:0|[1-9][0-9]*)$/.test(token)) {
			const value = Number(token);
			if (!Number.isSafeInteger(value)) this.fail(`${token} is too large.`);
			return value === 0 ? 0 : value;
		}
		if (/^[+-]?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(token)) {
			const value = Number(token);
			if (!Number.isFinite(value)) this.fail(`${token} is not a usable number.`);
			return value;
		}
		if (/^[0-9]{4}-[0-9]{2}/.test(token)) this.fail("Dates and times are written as text in quotes in these files.");
		this.fail(`"${token.slice(0, 40)}" is not a value; text goes in quotes.`);
	}

	private basicString(): string {
		this.i++;
		let out = "";
		let run = this.i;
		for (;;) {
			if (this.i >= this.text.length) this.fail("A quoted text never closes.");
			const code = this.text.charCodeAt(this.i);
			if (code === 0x22) {
				out += this.text.slice(run, this.i);
				this.i++;
				return out;
			}
			if (code === 0x5c) {
				out += this.text.slice(run, this.i);
				out += this.escape();
				run = this.i;
				continue;
			}
			if (code === 0x0a || code === 0x0d) this.fail(`A quoted text must close on its line: ${ONE_LINE}.`);
			if ((code < 0x20 && code !== 0x09) || code === 0x7f)
				this.fail("A quoted text holds a control character; write it as an escape.");
			this.i++;
		}
	}

	private escape(): string {
		const next = this.text[this.i + 1];
		this.i += 2;
		switch (next) {
			case "b":
				return "\b";
			case "t":
				return "\t";
			case "n":
				return "\n";
			case "f":
				return "\f";
			case "r":
				return "\r";
			case '"':
				return '"';
			case "\\":
				return "\\";
			case "u":
			case "U": {
				const size = next === "u" ? 4 : 8;
				const hex = this.text.slice(this.i, this.i + size);
				if (hex.length !== size || !/^[0-9A-Fa-f]+$/.test(hex)) this.fail(`\\${next} takes ${size} hex digits.`);
				const point = Number.parseInt(hex, 16);
				if (point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff))
					this.fail(`\\${next}${hex} is not a character.`);
				this.i += size;
				return String.fromCodePoint(point);
			}
			default:
				this.fail(`\\${next ?? ""} is not an escape TOML knows.`);
		}
	}

	private literalString(): string {
		const start = ++this.i;
		for (;;) {
			if (this.i >= this.text.length) this.fail("A quoted text never closes.");
			const code = this.text.charCodeAt(this.i);
			if (code === 0x27) {
				const out = this.text.slice(start, this.i);
				this.i++;
				return out;
			}
			if (code === 0x0a || code === 0x0d) this.fail(`A quoted text must close on its line: ${ONE_LINE}.`);
			if ((code < 0x20 && code !== 0x09) || code === 0x7f) this.fail("A quoted text holds a control character.");
			this.i++;
		}
	}

	/** Spaces, line ends and comments inside an array. */
	private skipInArray(): void {
		for (;;) {
			this.skipBlank();
			const ch = this.text[this.i];
			if (ch === "\n" || ch === "\r") this.newline();
			else if (ch === "#") this.comment();
			else return;
		}
	}

	private array(depth: number): unknown[] {
		this.i++;
		const out: unknown[] = [];
		this.frozen.add(out);
		for (;;) {
			this.skipInArray();
			if (this.i >= this.text.length) this.fail("A [list] never closes.");
			if (this.text[this.i] === "]") {
				this.i++;
				return out;
			}
			out.push(this.value(depth + 1));
			this.skipInArray();
			const ch = this.text[this.i];
			if (ch === ",") {
				this.i++;
				continue;
			}
			if (ch === "]") {
				this.i++;
				return out;
			}
			this.fail("Expected , or ] in a [list].");
		}
	}

	private inlineTable(depth: number): Record<string, unknown> {
		this.i++;
		const out: Record<string, unknown> = {};
		this.frozen.add(out);
		this.skipBlank();
		if (this.text[this.i] === "}") {
			this.i++;
			return out;
		}
		for (;;) {
			this.skipBlank();
			if (this.text[this.i] === "\n" || this.text[this.i] === "\r")
				this.fail("An { inline table } stays on one line.");
			const key = this.key();
			this.skipBlank();
			if (this.text[this.i] === ".") this.fail("Dotted keys are not used in these files.");
			if (this.text[this.i] !== "=") this.fail(`Expected = after "${key}".`);
			this.i++;
			this.skipBlank();
			if (Object.hasOwn(out, key)) this.fail(`"${key}" is set twice.`);
			define(out, key, this.value(depth + 1));
			this.skipBlank();
			const ch = this.text[this.i];
			if (ch === ",") {
				this.i++;
				continue;
			}
			if (ch === "}") {
				this.i++;
				return out;
			}
			this.fail("Expected , or } in an { inline table } on one line.");
		}
	}
}

function isTable(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
