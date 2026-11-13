/**
 * The search's regular expressions (keyholes S4, `regex`): RE2's kind, where every step is linear in the text, run by
 * V8's linear-time engine (the `l` flag, which needs the service started with `--enable-experimental-regexp-engine`;
 * deploy/folder-service/qorpera-folder-service.service). That engine takes no back-reference, no count above 16, no
 * case folding and no Unicode mode, and refuses whatever it cannot run in linear time. A pattern is read here first:
 * - what RE2 refuses (back-references, lookaround, inline flags, unknown escapes) is refused with why, so what a
 *   pattern may hold does not change with the engine's version;
 * - a search that is not case-sensitive runs on the text lowercased, as a literal search does, so the pattern's letters
 *   are lowercased to match, and each range in a character class gets its lowercase forms added (ranges of up to 4,096
 *   characters in all; a pattern with more keeps the rest as written);
 * - every group is emitted non-capturing, a character above U+FFFF outside a class as one unit, and a character class
 *   as escapes only, so nothing the model writes is read twice.
 * Every refusal is a SearchPatternError whose message starts with a fixed code and says what to change.
 */

export class SearchPatternError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SearchPatternError";
	}
}

let linear: boolean | undefined;

/** Whether this process runs V8's linear-time engine (the service's unit starts node with its flag). */
export function linearRegexAvailable(): boolean {
	if (linear === undefined)
		try {
			// biome-ignore lint/complexity/useRegexLiterals: a literal with the l flag does not parse where the engine is off
			new RegExp("a", "l");
			linear = true;
		} catch {
			linear = false;
		}
	return linear;
}

/** Code points of class ranges whose lowercase forms are added, in all, for one pattern. */
const FOLD_BUDGET = 4096;
const SPECIAL = new Set(Array.from("\\^$.|?*+()[]{}/"));

/** The pattern compiled for V8's linear engine, multiline (`^` and `$` at each line's ends): matched against text
 * lowercased when `caseSensitive` is false. */
export function compilePattern(pattern: string, caseSensitive: boolean): RegExp {
	if (!linearRegexAvailable())
		throw new SearchPatternError("REGEX_OFF: this node's folder search runs no regular expressions; search for text");
	const source = translate(pattern, caseSensitive);
	try {
		return new RegExp(source, "lm");
	} catch (error) {
		if ((error as Error).message.includes("linear time"))
			throw new SearchPatternError(
				"REGEX_TOO_LARGE: a count above 16, or counts inside counts, cannot run in linear time; write a smaller one",
			);
		throw new SearchPatternError("REGEX_SYNTAX: the pattern is not a regular expression (check its brackets)");
	}
}

type Escape = { readonly char: number } | { readonly raw: string };

function hex(chars: readonly string[], from: number, digits: number): number {
	const text = chars.slice(from, from + digits).join("");
	if (text.length !== digits || !/^[0-9A-Fa-f]+$/.test(text))
		throw new SearchPatternError("REGEX_ESCAPE: \\x takes two hex digits, \\u four, \\x{...} up to six");
	return Number.parseInt(text, 16);
}

function scalar(code: number): number {
	if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff))
		throw new SearchPatternError("REGEX_ESCAPE: that escape names no character");
	return code;
}

/** The escape at `at` (a backslash) and where it ends. */
function escapeAt(chars: readonly string[], at: number, inClass: boolean): { escape: Escape; end: number } {
	const c = chars[at + 1];
	if (c === undefined) throw new SearchPatternError("REGEX_SYNTAX: the pattern ends with a backslash");
	if ("dDwWsS".includes(c)) return { escape: { raw: `\\${c}` }, end: at + 2 };
	if (c === "b" || c === "B") {
		if (inClass) throw new SearchPatternError("REGEX_ESCAPE: \\b and \\B are not characters; leave them out of [ ]");
		return { escape: { raw: `\\${c}` }, end: at + 2 };
	}
	if (/^[1-9]$/.test(c) || c === "k")
		throw new SearchPatternError(
			"REGEX_BACKREFERENCE: a back-reference cannot run in linear time; search without it",
		);
	if (c === "p" || c === "P")
		throw new SearchPatternError(
			"REGEX_ESCAPE: \\p classes are not taken; write the characters as a class like [a-z]",
		);
	const plain: Record<string, number> = { n: 0x0a, t: 0x09, r: 0x0d, f: 0x0c, v: 0x0b };
	if (plain[c] !== undefined) return { escape: { char: plain[c]! }, end: at + 2 };
	if (c === "0") {
		if (/^[0-9]$/.test(chars[at + 2] ?? ""))
			throw new SearchPatternError("REGEX_ESCAPE: octal escapes are not taken");
		return { escape: { char: 0 }, end: at + 2 };
	}
	if (c === "x") {
		if (chars[at + 2] === "{") {
			const close = chars.indexOf("}", at + 3);
			if (close < 0 || close - (at + 3) < 1 || close - (at + 3) > 6)
				throw new SearchPatternError("REGEX_ESCAPE: \\x{...} takes one to six hex digits");
			return { escape: { char: scalar(hex(chars, at + 3, close - (at + 3))) }, end: close + 1 };
		}
		return { escape: { char: hex(chars, at + 2, 2) }, end: at + 4 };
	}
	if (c === "u") return { escape: { char: scalar(hex(chars, at + 2, 4)) }, end: at + 6 };
	if (c === "c") {
		const letter = chars[at + 2] ?? "";
		if (!/^[A-Za-z]$/.test(letter)) throw new SearchPatternError("REGEX_ESCAPE: \\c takes a letter");
		return { escape: { char: letter.toUpperCase().charCodeAt(0) - 64 }, end: at + 3 };
	}
	if (/^[A-Za-z0-9]$/.test(c)) throw new SearchPatternError(`REGEX_ESCAPE: \\${c} is not an escape this search takes`);
	return { escape: { char: c.codePointAt(0)! }, end: at + 2 };
}

const unit = (code: number): string => `\\u${code.toString(16).padStart(4, "0")}`;

/** One character outside a class, as the pattern's source: escaped where it means something, and a character of two
 * code units (or one that lowercases to several) as one group, so a count after it takes it whole. */
function literal(code: number, caseSensitive: boolean): string {
	const own = String.fromCodePoint(code);
	const folded = caseSensitive ? own : own.toLowerCase();
	const text = Array.from(folded)
		.map((c) => {
			const point = c.codePointAt(0)!;
			if (point > 0xffff) return c;
			return SPECIAL.has(c) || point < 0x20 || point === 0x7f ? unit(point) : c;
		})
		.join("");
	return folded.length > 1 ? `(?:${text})` : text;
}

/** The pattern as V8's linear engine runs it (module comment). */
export function translate(pattern: string, caseSensitive: boolean): string {
	const chars = Array.from(pattern);
	let out = "";
	let budget = FOLD_BUDGET;
	let i = 0;
	while (i < chars.length) {
		const c = chars[i]!;
		if (c === "\\") {
			const { escape: read, end } = escapeAt(chars, i, false);
			out += "raw" in read ? read.raw : literal(read.char, caseSensitive);
			i = end;
			continue;
		}
		if (c === "[") {
			const { source, end, used } = characterClass(chars, i, caseSensitive, budget);
			out += source;
			budget -= used;
			i = end;
			continue;
		}
		if (c === "(") {
			if (chars[i + 1] !== "?") {
				out += "(?:";
				i++;
				continue;
			}
			const kind = chars[i + 2];
			if (kind === ":") {
				out += "(?:";
				i += 3;
				continue;
			}
			if (kind === "=" || kind === "!" || (kind === "<" && (chars[i + 3] === "=" || chars[i + 3] === "!")))
				throw new SearchPatternError(
					"REGEX_LOOKAROUND: lookahead and lookbehind are not taken; search without them",
				);
			const named = kind === "P" && chars[i + 3] === "<" ? i + 4 : kind === "<" ? i + 3 : -1;
			if (named >= 0) {
				const close = chars.indexOf(">", named);
				if (close < 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(chars.slice(named, close).join("")))
					throw new SearchPatternError("REGEX_SYNTAX: a named group is (?<name>...)");
				out += "(?:";
				i = close + 1;
				continue;
			}
			throw new SearchPatternError(
				"REGEX_FLAGS: inline flags like (?i) are not taken; say case_sensitive instead, and group with (?:...)",
			);
		}
		if (c === "{") {
			// A count only when it is one, RE2's way: otherwise the brace is a character.
			const close = chars.indexOf("}", i);
			const body = close < 0 ? "" : chars.slice(i + 1, close).join("");
			if (/^[0-9]{1,4}(,[0-9]{0,4})?$/.test(body)) {
				out += `{${body}}`;
				i = close + 1;
				continue;
			}
			out += "\\{";
			i++;
			continue;
		}
		if (c === "}" || c === "]") {
			out += `\\${c}`;
			i++;
			continue;
		}
		if (".^$|)*+?".includes(c)) {
			out += c;
			i++;
			continue;
		}
		out += literal(c.codePointAt(0)!, caseSensitive);
		i++;
	}
	return out;
}

/** A class from its `[` (RE2's way: a `]` right after `[` or `[^` is a character), as escapes only; with its
 * lowercase forms when the search is not case-sensitive, within `budget` code points of ranges. */
function characterClass(
	chars: readonly string[],
	open: number,
	caseSensitive: boolean,
	budget: number,
): { source: string; end: number; used: number } {
	let j = open + 1;
	const negated = chars[j] === "^";
	if (negated) j++;
	const ranges: [number, number][] = [];
	const raws: string[] = [];
	const member = (at: number): { code?: number; raw?: string; end: number } => {
		const c = chars[at];
		if (c === undefined) throw new SearchPatternError("REGEX_SYNTAX: a [ has no ]");
		if (c === "[" && chars[at + 1] === ":")
			throw new SearchPatternError("REGEX_SYNTAX: [:alpha:] classes are not taken; write [a-zA-Z] or \\w");
		if (c === "\\") {
			const { escape: read, end } = escapeAt(chars, at, true);
			return "raw" in read ? { raw: read.raw, end } : { code: read.char, end };
		}
		return { code: c.codePointAt(0)!, end: at + 1 };
	};
	let first = true;
	while (chars[j] !== "]" || first) {
		first = false;
		const lo = member(j);
		if (lo.raw !== undefined) {
			raws.push(lo.raw);
			j = lo.end;
			continue;
		}
		let hi = lo;
		if (chars[lo.end] === "-" && chars[lo.end + 1] !== undefined && chars[lo.end + 1] !== "]") {
			hi = member(lo.end + 1);
			if (hi.raw !== undefined)
				throw new SearchPatternError("REGEX_SYNTAX: a range ends at a character, not a class");
			if (hi.code! < lo.code!) throw new SearchPatternError("REGEX_SYNTAX: a range in [ ] is out of order");
		}
		if (hi.code! > 0xffff) throw new SearchPatternError("REGEX_SYNTAX: [ ] takes characters up to U+FFFF only");
		ranges.push([lo.code!, hi.code!]);
		j = hi.end;
		if (chars[j] === undefined) throw new SearchPatternError("REGEX_SYNTAX: a [ has no ]");
	}
	let used = 0;
	if (!caseSensitive) {
		const added: number[] = [];
		for (const [lo, hi] of ranges) {
			if (used + (hi - lo + 1) > budget) break;
			used += hi - lo + 1;
			for (let code = lo; code <= hi; code++) {
				const lower = String.fromCharCode(code).toLowerCase();
				if (lower.length === 1 && lower.charCodeAt(0) !== code) added.push(lower.charCodeAt(0));
			}
		}
		for (const code of added) ranges.push([code, code]);
	}
	const body = ranges.map(([lo, hi]) => (lo === hi ? unit(lo) : `${unit(lo)}-${unit(hi)}`)).join("");
	return { source: `[${negated ? "^" : ""}${body}${raws.join("")}]`, end: j + 1, used };
}
