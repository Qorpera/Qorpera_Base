/** A skill file (contract 15.2) in the SKILL.md shape Grok Bots, Claude and Codex share:
 * YAML front matter with the skill's name and a description of when to use it, then the
 * Markdown steps. The runtime's skill tools and the member web client read skills through
 * this one parser, so an agent and a member always see the same description. Browser-safe. */

/** The shared skill-name rule: lowercase letters and digits in hyphenated words. */
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const CLOUD_SKILL_NAME_MAX_CHARS = 64;
const FRONT_KEY = /^([A-Za-z0-9_][A-Za-z0-9_.-]*):(?:[ \t]+(.*?))?[ \t]*$/;
const BLOCK_SCALAR = /^([|>])[+-]?[1-9]?[+-]?(?:[ \t]+#.*)?$/;
/** YAML double-quoted escapes beyond \x, \u and \U. */
const YAML_ESCAPES: Readonly<Record<string, string>> = {
	"0": "\0",
	a: String.fromCodePoint(7),
	b: "\b",
	t: "\t",
	"\t": "\t",
	n: "\n",
	v: "\v",
	f: "\f",
	r: "\r",
	e: String.fromCodePoint(0x1b),
	" ": " ",
	'"': '"',
	"/": "/",
	"\\": "\\",
	N: String.fromCodePoint(0x85),
	_: String.fromCodePoint(0xa0),
	L: String.fromCodePoint(0x2028),
	P: String.fromCodePoint(0x2029),
};

/** Whether a folder or mention names a skill. */
export function isCloudSkillName(value: string): boolean {
	return value.length <= CLOUD_SKILL_NAME_MAX_CHARS && NAME.test(value);
}

interface FrontField {
	/** Line range inside the front matter, the key line and its continuation lines. */
	readonly start: number;
	readonly end: number;
	readonly value: string | null;
}

/** A skill file split into its front matter (null when it has none) and body. */
export interface CloudSkillDocument {
	readonly front: readonly string[] | null;
	readonly fields: ReadonlyMap<string, FrontField>;
	readonly description: string | null;
	readonly body: string;
	/** The file's own line ending, kept when the file is rewritten. */
	readonly newline: "\n" | "\r\n";
}

/** A YAML double-quoted scalar from its opening quote, up to the first quote no backslash escapes. */
function doubleQuoted(quoted: string): string {
	let text = "";
	for (let index = 1; index < quoted.length; index++) {
		const character = quoted[index];
		if (character === '"') break;
		if (character !== "\\") {
			text += character;
			continue;
		}
		const code = quoted[++index] ?? "";
		const size = code === "x" ? 2 : code === "u" ? 4 : code === "U" ? 8 : 0;
		const hex = size ? quoted.slice(index + 1, index + 1 + size) : "";
		if (YAML_ESCAPES[code] !== undefined) text += YAML_ESCAPES[code];
		else if (size && hex.length === size && /^[0-9a-fA-F]+$/.test(hex) && Number.parseInt(hex, 16) <= 0x10ffff) {
			text += String.fromCodePoint(Number.parseInt(hex, 16));
			index += size;
		} else text += `\\${code}`;
	}
	return text;
}

/** One top-level YAML scalar, enough for the name and description of a skill file:
 * plain (continued on indented lines), single- or double-quoted, and | or > blocks.
 * A key whose value is a nested map or list has no scalar value. */
function frontScalar(raw: string, more: readonly string[]): string | null {
	const block = BLOCK_SCALAR.exec(raw);
	if (block) {
		const lines = [...more];
		while (lines.length && !lines.at(-1)!.trim()) lines.pop();
		const indent = Math.min(
			...lines.filter((line) => line.trim()).map((line) => line.length - line.trimStart().length),
		);
		const text = lines.map((line) => line.slice(Number.isFinite(indent) ? indent : 0));
		if (block[1] === "|") return text.join("\n");
		// Folded: lines join with a space, a blank line is a line break.
		return text
			.join("\n")
			.split(/\n[ \t]*\n/)
			.map((paragraph) => paragraph.replace(/\s*\n\s*/g, " "))
			.join("\n");
	}
	// Continuation lines of a flow scalar; inside quotes a line starting with # is text, not a comment.
	const lines = more.map((line) => line.trim()).filter(Boolean);
	const continued = lines.filter((line) => !line.startsWith("#"));
	const quoted = [raw, ...lines].join(" ");
	if (raw.startsWith('"')) return doubleQuoted(quoted);
	if (raw.startsWith("'")) {
		// Inside single quotes '' is one quote; the first lone quote closes the scalar.
		let text = "";
		for (let index = 1; index < quoted.length; index++) {
			if (quoted[index] !== "'") text += quoted[index];
			else if (quoted[index + 1] === "'") text += quoted[index++];
			else break;
		}
		return text;
	}
	if (!raw)
		// A plain scalar may start on the next line; indented keys or list items make a nested value.
		return continued.length && !continued.some((line) => /^[^\s:]+:(\s|$)/.test(line) || line.startsWith("- "))
			? continued.join(" ")
			: null;
	return [raw.replace(/[ \t]+#.*$/, ""), ...continued].join(" ");
}

/** Whitespace collapsed to single spaces: a description is one line. */
export function oneLine(text: string): string {
	return text.trim().replace(/\s+/g, " ");
}

/** Reads a SKILL.md: YAML front matter between --- lines, then the body. */
export function parseCloudSkillFile(text: string): CloudSkillDocument {
	// A file keeps CRLF only when every line ends that way.
	const newline = text.includes("\r\n") && !/(^|[^\r])\n/.test(text) ? "\r\n" : "\n";
	const unmarked = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
	const lines = unmarked.split(/\r?\n/);
	const close =
		lines[0]?.trimEnd() === "---"
			? lines.findIndex((line, index) => index > 0 && /^(---|\.\.\.)\s*$/.test(line))
			: -1;
	if (close < 0) return { front: null, fields: new Map(), description: null, body: unmarked, newline };
	const front = lines.slice(1, close);
	const fields = new Map<string, FrontField>();
	for (let index = 0; index < front.length; index++) {
		const match = FRONT_KEY.exec(front[index]);
		if (!match) continue;
		let end = index + 1;
		while (end < front.length && (!front[end].trim() || /^[ \t]/.test(front[end]))) end++;
		if (!fields.has(match[1]))
			fields.set(match[1], { start: index, end, value: frontScalar(match[2] ?? "", front.slice(index + 1, end)) });
	}
	const description = fields.get("description")?.value;
	return {
		front,
		fields,
		description: description && oneLine(description) ? oneLine(description) : null,
		body: lines
			.slice(close + 1)
			.join("\n")
			.replace(/^\n+/, ""),
		newline,
	};
}

/** A skill file: the existing front matter kept line for line (other keys such as
 * license or metadata survive), with a new description when one is given. */
export function renderCloudSkillFile(
	name: string,
	change: { description?: string; body: string },
	current: CloudSkillDocument | null = null,
): string {
	const described = change.description === undefined ? null : `description: ${JSON.stringify(change.description)}`;
	const front = [...(current?.front ?? [])];
	const field = current?.fields.get("description");
	if (described && field) front.splice(field.start, field.end - field.start, described);
	else if (described) {
		const named = current?.fields.get("name");
		front.splice(named ? named.end : front.length, 0, described);
	}
	if (!current?.fields.has("name")) front.unshift(`name: ${name}`);
	const text = `---\n${front.join("\n")}\n---\n\n${change.body.replace(/^(\r?\n)+/, "").trimEnd()}\n`;
	return current?.newline === "\r\n" ? text.replace(/\r?\n/g, "\r\n") : text;
}
