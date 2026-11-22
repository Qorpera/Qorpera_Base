// Reads one SQL file of a company database (deploy/first-node/RUNTIME-COMPANY-DATABASES.md §1): its leading comment
// lines (the words), its `:name` parameters, and whether more than one statement is written. It finds parameters only
// outside strings, quoted names, dollar quotes and comments. It does not decide what the statement does: PostgreSQL
// does, where it runs.

// WHY: Use sticky /y regexes so readStatement matches at offset without O(N^2) text.slice() copies.
const NAME = /[a-z_][a-z0-9_]*/y;
const DOLLAR_TAG = /\$([A-Za-z_][A-Za-z0-9_]*)?\$/y;
// A character a name of PostgreSQL's may hold after its first: a `$` right after one is part of the name (`a$b`), not
// a dollar quote or a `$1`.
const NAME_PART = /[A-Za-z0-9_$\u0080-￿]/;

export const MAX_PARAMETERS = 64;
/** The parameter the gateway fills itself: the member looking. */
export const VIEWER = "viewer";

/** A file's words: its leading `--` lines, after any blank lines, up to the first blank or other line. */
export function leadingWords(text) {
	const words = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "") {
			if (words.length === 0) continue;
			break;
		}
		if (!trimmed.startsWith("--")) break;
		words.push(trimmed.replace(/^--+\s?/, ""));
	}
	return words;
}

/** A file's words with a call's values in place, as a change's are shown to a member before they say yes (§8): the
 * words' own text and `{ name, value }` in turn, so that whatever shows them can tell a value, which the caller
 * chose, from the words the file's writer wrote. `values`: a Map from each parameter's name to its text or null. A
 * `:name` that is no parameter stays as written; `::` is a cast. The words are cut at 1,000 characters and a value
 * at 200.
 * @param {string[]} words
 * @param {Map<string, string | null>} values
 * @returns {(string | { name: string, value: string | null })[]} */
export function wordsWith(words, values) {
	const text = words.join(" ").slice(0, 1000);
	const parts = [];
	let from = 0;
	for (const found of text.matchAll(/(?<![:A-Za-z0-9_]):([a-z_][a-z0-9_]*)/g)) {
		if (!values.has(found[1])) continue;
		if (found.index > from) parts.push(text.slice(from, found.index));
		const value = values.get(found[1]);
		parts.push({ name: found[1], value: value === null || value.length <= 200 ? value : `${value.slice(0, 200)}…` });
		from = found.index + found[0].length;
	}
	if (from < text.length) parts.push(text.slice(from));
	return parts;
}

/**
 * @param {string} text the file's text
 * @returns {{ ok: true, sql: string, parameters: string[], words: string[] } | { ok: false, problem: string }}
 * `sql` has each `:name` replaced by `$n` (one number per name) and no closing semicolon.
 */
export function readStatement(text) {
	if (typeof text !== "string" || text.includes("\0")) return { ok: false, problem: "The file is not text" };
	const words = leadingWords(text);
	const parameters = [];
	let sql = "";
	let last = -1; // where the last character outside comments and white space sits in `sql`
	let ended = false; // a semicolon was seen, with nothing after it yet
	// Parentheses outside strings, names, dollar quotes and comments must close in order: a statement the gateway
	// wraps in its own parentheses cannot close the gateway's.
	let depth = 0;
	const keep = (piece, counts) => {
		if (counts && ended) throw new Error("more");
		sql += piece;
		if (counts) last = sql.length - 1;
	};
	try {
		let at = 0;
		while (at < text.length) {
			const char = text[at];
			const next = text[at + 1];
			if (char === "-" && next === "-") {
				const end = text.indexOf("\n", at);
				const stop = end < 0 ? text.length : end;
				keep(text.slice(at, stop), false);
				at = stop;
			} else if (char === "/" && next === "*") {
				let depth = 1;
				let scan = at + 2;
				while (scan < text.length && depth > 0) {
					if (text[scan] === "/" && text[scan + 1] === "*") {
						depth++;
						scan += 2;
					} else if (text[scan] === "*" && text[scan + 1] === "/") {
						depth--;
						scan += 2;
					} else scan++;
				}
				if (depth > 0) return { ok: false, problem: "A comment is not closed" };
				keep(text.slice(at, scan), false);
				at = scan;
			} else if (char === "'" || char === '"') {
				// An E'…' string also takes a backslash before a quote; a plain one and a quoted name double the quote.
				const escapes = char === "'" && /[eE]/.test(text[at - 1] ?? "") && !NAME_PART.test(text[at - 2] ?? "");
				let scan = at + 1;
				for (;;) {
					if (scan >= text.length) return { ok: false, problem: char === "'" ? "A string is not closed" : "A quoted name is not closed" };
					if (escapes && text[scan] === "\\") scan += 2;
					else if (text[scan] === char && text[scan + 1] === char) scan += 2;
					else if (text[scan] === char) break;
					else scan++;
				}
				keep(text.slice(at, scan + 1), true);
				at = scan + 1;
			} else if (char === "$" && NAME_PART.test(text[at - 1] ?? "")) {
				keep(char, true);
				at++;
			} else if (char === "$") {
				DOLLAR_TAG.lastIndex = at;
				const tag = DOLLAR_TAG.exec(text);
				if (tag) {
					const end = text.indexOf(tag[0], at + tag[0].length);
					if (end < 0) return { ok: false, problem: "A dollar-quoted text is not closed" };
					keep(text.slice(at, end + tag[0].length), true);
					at = end + tag[0].length;
				} else if (/[0-9]/.test(next ?? "")) {
					return { ok: false, problem: "Write a parameter as :name, not as $1" };
				} else {
					keep(char, true);
					at++;
				}
			} else if (char === ":" && next === ":") {
				keep("::", true);
				at += 2;
			} else if (char === ":" && !NAME_PART.test(text[at - 1] ?? "")) {
				NAME.lastIndex = at + 1;
				const match = NAME.exec(text);
				if (match) {
					const name = match[0];
					if (name.length > 40) return { ok: false, problem: `The parameter :${name.slice(0, 40)}… has too long a name` };
					let number = parameters.indexOf(name) + 1;
					if (number === 0) {
						if (parameters.length === MAX_PARAMETERS) return { ok: false, problem: `A file names at most ${MAX_PARAMETERS} parameters` };
						parameters.push(name);
						number = parameters.length;
					}
					keep(`$${number}`, true);
					at += 1 + name.length;
				} else {
					keep(char, true);
					at++;
				}
			} else if (char === ";") {
				if (ended) throw new Error("more");
				ended = true;
				sql += " ";
				at++;
			} else {
				keep(char, !/\s/.test(char));
				if (char === "(") depth++;
				if (char === ")" && --depth < 0) return { ok: false, problem: "A parenthesis is closed that was not opened" };
				at++;
			}
		}
	} catch {
		return { ok: false, problem: "The file holds more than one statement: write one" };
	}
	if (last < 0) return { ok: false, problem: "The file holds no statement" };
	if (depth > 0) return { ok: false, problem: "A parenthesis is not closed" };
	return { ok: true, sql: sql.trimEnd(), parameters, words };
}
