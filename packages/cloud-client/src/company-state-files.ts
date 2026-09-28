/** Company state files (contract 5.6): the files of the company folder that have a fixed
 * format — the vision, an agent, the sidebar's sections, a group chat, a connection, a
 * company review rule, a routine, a todo and a worker's brief and results. Every writer (the
 * runtime's tools, the web app, the object gateway and the folder service) reads them through
 * this one parser, so a file means the same thing whoever saves it. The database checks the
 * rules that need its state and keeps the indexes (RUNTIME-COMPANY-STATE-FILES.md). Browser-safe.
 *
 * A settings block ("front matter") is a strict subset of YAML 1.2: one `key: value` per
 * line, values are text, whole numbers or lists of these (`[a, b]` on one line, or one
 * `- item` per line below the key), and `#` after a space starts a note. Each kind has a
 * closed set of keys. The same bytes always give the same result, problems included. */

import { STAFF_CHARACTER_IDS } from "./staff-characters.ts";

export type CompanyStateFileKind =
	| "vision"
	| "agent"
	| "sections"
	| "group"
	| "routine"
	| "todo"
	| "worker-brief"
	| "worker-results"
	| "connection"
	| "rule";

/** One reason a file cannot be saved. Lines count from 1 over the whole file. */
export interface CompanyStateProblem {
	readonly line: number | null;
	readonly key: string | null;
	readonly code: CompanyStateProblemCode;
	readonly message: string;
}

export type CompanyStateProblemCode =
	| "too_large"
	| "encoding"
	| "front_matter"
	| "syntax"
	| "unknown_key"
	| "duplicate_key"
	| "missing"
	| "value"
	| "quote"
	| "name"
	| "body";

/** The largest structured file, the storage core's bound (RUNTIME-COMPANY-FOLDER-CORE.md §5). */
export const COMPANY_STATE_FILE_MAX_BYTES = 64 * 1024;
export const COMPANY_STATE_NAME_MAX_CHARS = 64;
/** Recorded with every parse the platform stores, so the rebuild's drift check knows which
 * rules a parse was made under. */
export const COMPANY_STATE_PARSER_VERSION = 1;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_ANY_CASE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const KEY = /^[a-z][a-z0-9_]*$/;
/** Characters a one-line value never holds: C0 and C1 controls (tab included, as Postgres
 * `[[:cntrl:]]`), and the two Unicode line separators. */
const NOT_ONE_LINE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const LINE_SEPARATOR = /[\u2028\u2029]/;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?Z$/;
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const encoder = new TextEncoder();

export const AGENT_COLOURS = Object.freeze([
	"charcoal",
	"brown",
	"coral",
	"orange",
	"gold",
	"green",
	"teal",
	"blue",
	"purple",
	"pink",
	"gray",
] as const);
export const AGENT_MODELS = Object.freeze(["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"] as const);
/** Effort an agent or a routine may ask for; runs accept these three today. */
export const COMPANY_STATE_EFFORTS = Object.freeze(["low", "medium", "high"] as const);
export const ROUTINE_WHEN = Object.freeze(["every", "weekly", "window", "once", "file-change"] as const);

export type AgentColour = (typeof AGENT_COLOURS)[number];
export type AgentFigure = (typeof STAFF_CHARACTER_IDS)[number];
export type AgentModel = (typeof AGENT_MODELS)[number];
export type CompanyStateEffort = (typeof COMPANY_STATE_EFFORTS)[number];
export type RoutineDay = (typeof DAYS)[number];

export interface VisionFile {
	readonly kind: "vision";
	/** The company's name: the first line, `# <name>`. */
	readonly name: string;
}

export interface AgentFile {
	readonly kind: "agent";
	readonly id: string;
	readonly name: string;
	readonly role: string;
	readonly agentKind: "co-founder" | "agent";
	readonly status: "active" | "archived";
	readonly colour: AgentColour | null;
	readonly figure: AgentFigure | null;
	readonly model: AgentModel | null;
	readonly effort: CompanyStateEffort | null;
	/** The body, trimmed: the agent's job, how it works and its voice. */
	readonly instructions: string;
}

export interface SectionsFile {
	readonly kind: "sections";
	readonly sections: readonly {
		readonly name: string;
		readonly line: number;
		/** Agents and group chats, in order, by id. */
		readonly members: readonly { readonly id: string; readonly line: number }[];
	}[];
}

export interface GroupFile {
	readonly kind: "group";
	readonly id: string;
	readonly name: string;
	/** Absent (null) shows "Group chat"; an empty subtitle shows nothing. */
	readonly subtitle: string | null;
	readonly agents: readonly string[];
	readonly people: readonly string[];
	readonly purpose: string;
}

export interface ConnectionFile {
	readonly kind: "connection";
	readonly id: string;
	readonly service: string;
	readonly account: string;
	readonly status: "connected" | "broken";
	readonly actions: readonly string[];
	readonly connectedBy: string;
	readonly connectedAt: string;
	/** The body, trimmed: what the account is for, written by the company. */
	readonly purpose: string;
}

export interface RuleFile {
	readonly kind: "rule";
	readonly id: string;
	readonly outcome: "ask-first" | "allow";
	/** How "When an agent wants to …" ends, as today's rule text. */
	readonly text: string;
}

export type RoutineTrigger =
	| { readonly when: "every"; readonly minutes: number; readonly starts: string | null }
	| {
			readonly when: "weekly";
			readonly days: readonly RoutineDay[];
			readonly time: string;
			readonly starts: string | null;
	  }
	| {
			readonly when: "window";
			readonly minutes: number;
			readonly from: string;
			readonly to: string;
			readonly days: readonly RoutineDay[] | null;
			readonly months: readonly number[] | null;
	  }
	| { readonly when: "once"; readonly at: string }
	| { readonly when: "file-change"; readonly watch: string; readonly match: "exact" | "subtree" };

export interface RoutineFile {
	readonly kind: "routine";
	readonly id: string;
	readonly title: string;
	readonly status: "active" | "paused" | "concluded";
	readonly trigger: RoutineTrigger;
	readonly timezone: string | null;
	readonly ends: string | null;
	readonly runs: number | null;
	readonly quiet: { readonly start: string; readonly end: string; readonly timezone: string } | null;
	readonly effort: CompanyStateEffort;
	readonly reply: "optional" | "required" | "silent";
	readonly conclusion: string | null;
	/** The body, trimmed: what to do each time. */
	readonly instructions: string;
}

export interface TodoFile {
	readonly kind: "todo";
	readonly id: string;
	readonly title: string;
	readonly status: "open" | "blocked" | "done" | "cancelled";
	readonly requestedBy: string | null;
	/** The body, trimmed: what to do and what done looks like. */
	readonly detail: string;
}

export interface WorkerBriefFile {
	readonly kind: "worker-brief";
	readonly id: string;
	readonly title: string;
	readonly species: "in-house" | "coding";
	readonly access: "read" | "write";
	readonly revival: "each" | "batch";
	readonly dispatchedAt: string;
	readonly brief: string;
}

export interface WorkerResultsFile {
	readonly kind: "worker-results";
	readonly outcome: "succeeded" | "blocked" | "failed" | "cancelled";
	readonly reportedAt: string;
	readonly decision: "accepted" | "rejected" | null;
	readonly note: string | null;
	readonly report: string;
}

export type CompanyStateFile =
	| VisionFile
	| AgentFile
	| SectionsFile
	| GroupFile
	| ConnectionFile
	| RuleFile
	| RoutineFile
	| TodoFile
	| WorkerBriefFile
	| WorkerResultsFile;

/** Where a structured file sits: its kind and the names its path carries, as keys. */
export interface CompanyStatePath {
	readonly kind: CompanyStateFileKind;
	/** The agent's folder name, for files inside `agents/<handle>/`. */
	readonly agent: string | null;
	/** The group's folder name, for `group.md`. */
	readonly group: string | null;
	/** The file's own name without `.md`: routine, todo, rule and connection files. */
	readonly name: string | null;
	/** The todo and worker folder names, for a worker's brief and results. */
	readonly todo: string | null;
	readonly worker: string | null;
}

export type CompanyStateFileResult =
	| { readonly ok: true; readonly path: CompanyStatePath; readonly file: CompanyStateFile }
	| { readonly ok: false; readonly path: CompanyStatePath; readonly problems: readonly CompanyStateProblem[] };

/** The folder's key for a path, as the database computes it
 * (`normalize(lower(upper(normalize(p, NFKC))), NFKC)`, 20260828005000). Two spellings with
 * one key are one path. */
export function companyPathKey(path: string): string {
	return path.normalize("NFKC").toUpperCase().toLowerCase().normalize("NFKC");
}

/** The kind of structured file a path holds, or null for an ordinary file. Kinds are decided
 * on the path's key, as the folder decides which entry a path is; the names as written are
 * checked by {@link parseCompanyStateFile}. */
export function companyStatePath(path: string): CompanyStatePath | null {
	const parts = companyPathKey(path).split("/");
	const none = { agent: null, group: null, name: null, todo: null, worker: null };
	const stem = (part: string | undefined) => (part?.endsWith(".md") ? part.slice(0, -3) : null);
	const [a, b, c, d, e, f] = parts;
	if (parts.length === 2 && a === "vision" && b === "vision.md") return { kind: "vision", ...none };
	if (parts.length === 2 && a === "agents" && b === "sections.md") return { kind: "sections", ...none };
	if (parts.length === 2 && a === "connections" && stem(b) !== null)
		return { kind: "connection", ...none, name: stem(b) };
	if (parts.length === 2 && a === "rules" && stem(b) !== null) return { kind: "rule", ...none, name: stem(b) };
	if (a !== "agents" || b === undefined || b === "sections.md") return null;
	if (b === "groups")
		return parts.length === 4 && d === "group.md" ? { kind: "group", ...none, group: c ?? null } : null;
	if (parts.length === 3 && c === "agent.md") return { kind: "agent", ...none, agent: b };
	if (parts.length === 4 && c === "routines" && stem(d) !== null)
		return { kind: "routine", ...none, agent: b, name: stem(d) };
	if (parts.length === 4 && c === "todos" && stem(d) !== null)
		return { kind: "todo", ...none, agent: b, name: stem(d) };
	if (parts.length === 6 && c === "todos" && (f === "brief.md" || f === "results.md"))
		return {
			kind: f === "brief.md" ? "worker-brief" : "worker-results",
			...none,
			agent: b,
			todo: d ?? null,
			worker: e ?? null,
		};
	return null;
}

/** Whether a folder or file name follows the naming rule of contract 5.6. */
export function isCompanyStateName(value: string): boolean {
	return value.length <= COMPANY_STATE_NAME_MAX_CHARS && NAME.test(value);
}

const PLAIN_LATIN: Readonly<Record<string, string>> = {
	æ: "ae",
	ø: "oe",
	å: "aa",
	ß: "ss",
	œ: "oe",
	ð: "d",
	þ: "th",
	ł: "l",
	đ: "d",
	ı: "i",
};

/** A folder or file name made from a display name (contract 5.6): plain-Latin lowercase
 * letters, digits and hyphens. Empty when nothing is left; the caller then uses its
 * fallback ("agent", "group") and numbers a taken name with {@link freeCompanyStateName}. */
export function companyStateName(display: string): string {
	const latin = [...display.normalize("NFC").toLowerCase()]
		.map((character) => PLAIN_LATIN[character] ?? character)
		.join("");
	const words = latin
		.normalize("NFKD")
		.replace(/\p{M}/gu, "")
		.replace(/[\s_]+/g, "-")
		.replace(/[^a-z0-9-]/g, "")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
	return words.slice(0, COMPANY_STATE_NAME_MAX_CHARS).replace(/-$/, "");
}

/** Folder names under `agents/` that no agent may take (contract 5.6). */
export const COMPANY_STATE_RESERVED_AGENT_NAMES = Object.freeze(["groups"] as const);

/** The first free name: the name itself, then -2, -3 and so on. `taken` holds lowercase names,
 * reserved ones included. */
export function freeCompanyStateName(display: string, fallback: string, taken: ReadonlySet<string>): string {
	const base = companyStateName(display) || fallback;
	if (!taken.has(base)) return base;
	for (let number = 2; ; number++) {
		const suffix = `-${number}`;
		const name = `${base.slice(0, COMPANY_STATE_NAME_MAX_CHARS - suffix.length).replace(/-$/, "")}${suffix}`;
		if (!taken.has(name)) return name;
	}
}

/** A fresh id for a new file. Kept out of parse results, which must be the same for the same
 * bytes; a place that shows a missing-id problem may offer one. */
export function newCompanyStateId(): string {
	return globalThis.crypto.randomUUID();
}

/** An instant in the one form the platform compares: seconds always, and a fraction only when
 * it is not zero, without trailing zeros. Null when it is not a valid UTC instant. */
export function canonicalCompanyStateInstant(text: string): string | null {
	const match = INSTANT.exec(text);
	if (!match) return null;
	const [, year, month, day, hour, minute, second = "00", fraction = ""] = match;
	// setUTCFullYear keeps years below 100 as written, which Date.UTC would move to the 1900s.
	const date = new Date(0);
	date.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
	date.setUTCHours(Number(hour), Number(minute), Number(second));
	if (
		date.getUTCFullYear() !== Number(year) ||
		date.getUTCMonth() !== Number(month) - 1 ||
		date.getUTCDate() !== Number(day) ||
		date.getUTCHours() !== Number(hour) ||
		date.getUTCMinutes() !== Number(minute) ||
		Number(second) > 59
	)
		return null;
	const kept = fraction.replace(/0+$/, "");
	return `${year}-${month}-${day}T${hour}:${minute}:${second}${kept ? `.${kept}` : ""}Z`;
}

/** Why a time zone name cannot be used, or null. The name must be written as the platform's
 * list writes it; the database checks the same name against that list. */
export function companyStateTimeZoneProblem(name: string): string | null {
	if (!/^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/.test(name))
		return `unknown time zone "${name}"; use a name like Europe/Copenhagen`;
	let resolved: string;
	try {
		resolved = new Intl.DateTimeFormat("en-US", { timeZone: name }).resolvedOptions().timeZone;
	} catch {
		return `unknown time zone "${name}"; use a name like Europe/Copenhagen`;
	}
	if (resolved !== name && resolved.toLowerCase() === name.toLowerCase()) return `write the time zone as ${resolved}`;
	return null;
}

// ---------------------------------------------------------------------------------------------
// Reading the settings block

interface Value {
	readonly line: number;
	/** A single value, or a list. */
	readonly items: readonly Item[] | null;
	readonly item: Item | null;
}

interface Item {
	readonly text: string;
	readonly quoted: boolean;
	readonly line: number;
}

interface Split {
	readonly front: ReadonlyMap<string, Value> | null;
	/** The body as written. */
	readonly body: string;
	/** The body's first line number. */
	readonly bodyLine: number;
}

class Problems {
	readonly list: CompanyStateProblem[] = [];
	add(code: CompanyStateProblemCode, line: number | null, key: string | null, message: string): void {
		this.list.push({ line, key, code, message });
	}
	has(key: string): boolean {
		return this.list.some((problem) => problem.key === key);
	}
}

/** A YAML 1.2 plain scalar the core schema reads as something other than text. */
function ambiguousPlain(text: string): boolean {
	return /^(?:~|null|Null|NULL|true|True|TRUE|false|False|FALSE|[-+]?(?:\.inf|\.Inf|\.INF)|\.nan|\.NaN|\.NAN|[-+]?[0-9]+|0o[0-7]+|0x[0-9a-fA-F]+|[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?)$/.test(
		text,
	);
}

const ESCAPES: Readonly<Record<string, string>> = {
	'"': '"',
	"\\": "\\",
	"/": "/",
	b: "\b",
	f: "\f",
	n: "\n",
	r: "\r",
	t: "\t",
};

/** One scalar at the start of `rest`: double-quoted, single-quoted or plain. Returns the value
 * and what follows it, or a message. In a one-line list a plain scalar stops at `,` or `]`
 * and holds no flow indicator, as YAML reads it there. */
function scalar(rest: string, inList: boolean): { item: Omit<Item, "line">; after: string } | string {
	if (rest.startsWith('"')) {
		let text = "";
		for (let index = 1; index < rest.length; index++) {
			const character = rest[index] ?? "";
			if (character === '"') return { item: { text, quoted: true }, after: rest.slice(index + 1) };
			if (character !== "\\") {
				text += character;
				continue;
			}
			const code = rest[++index] ?? "";
			if (ESCAPES[code] !== undefined) {
				text += ESCAPES[code];
				continue;
			}
			const hex = code === "u" ? rest.slice(index + 1, index + 5) : "";
			if (!/^[0-9a-fA-F]{4}$/.test(hex)) return `the escape \\${code} is not supported here`;
			const unit = Number.parseInt(hex, 16);
			index += 4;
			if (unit >= 0xdc00 && unit <= 0xdfff) return "a \\u escape is half of a character";
			if (unit >= 0xd800 && unit <= 0xdbff) {
				const low = /^\\u([0-9a-fA-F]{4})/.exec(rest.slice(index + 1));
				const second = low ? Number.parseInt(low[1] ?? "", 16) : 0;
				if (second < 0xdc00 || second > 0xdfff) return "a \\u escape is half of a character";
				text += String.fromCharCode(unit, second);
				index += 6;
				continue;
			}
			text += String.fromCharCode(unit);
		}
		return "a double quote is not closed on its line";
	}
	if (rest.startsWith("'")) {
		let text = "";
		for (let index = 1; index < rest.length; index++) {
			if (rest[index] !== "'") text += rest[index];
			else if (rest[index + 1] === "'") text += rest[index++];
			else return { item: { text, quoted: true }, after: rest.slice(index + 1) };
		}
		return "a single quote is not closed on its line";
	}
	if (/^[[\]{},#&*!|>%@`]/.test(rest) || /^[-?:](?:\s|$)/.test(rest))
		return "a value cannot start with this character; put it in double quotes";
	const stop = inList ? /(?:\s#|[,\]])/ : /\s#/;
	const end = rest.search(stop);
	const raw = (end < 0 ? rest : rest.slice(0, end)).trimEnd();
	if (/: |:$/.test(raw)) return 'a value with ": " in it goes in double quotes';
	if (inList && /[[{}]/.test(raw)) return "a list item with [, { or } in it goes in double quotes";
	return { item: { text: raw, quoted: false }, after: end < 0 ? "" : rest.slice(end) };
}

/** A value after `key:` on its line: a scalar or a one-line list, then an optional note. */
function lineValue(rest: string, line: number): Value | string {
	if (rest.startsWith("[")) {
		const items: Item[] = [];
		let after = rest.slice(1).trimStart();
		if (after.startsWith("]")) after = after.slice(1);
		else
			for (;;) {
				const parsed = scalar(after, true);
				if (typeof parsed === "string") return parsed;
				if (!parsed.item.quoted && !parsed.item.text) return "a list item is empty";
				items.push({ ...parsed.item, line });
				after = parsed.after.trimStart();
				if (after.startsWith(",")) {
					after = after.slice(1).trimStart();
					continue;
				}
				if (after.startsWith("]")) {
					after = after.slice(1);
					break;
				}
				return "a list on one line must end with ]";
			}
		if (after.trim() && !/^\s+#/.test(after)) return "unexpected text after the list";
		return { line, items, item: null };
	}
	const parsed = scalar(rest, false);
	if (typeof parsed === "string") return parsed;
	if (parsed.after.trim() && !/^\s+#/.test(parsed.after)) return "unexpected text after the value";
	return { line, items: null, item: { ...parsed.item, line } };
}

interface OpenList {
	readonly key: string;
	readonly line: number;
	readonly items: Item[];
	indent: number | null;
}

/** Splits a file into its settings block and body. Front matter is required when `front`. */
function split(text: string, front: boolean, problems: Problems): Split | null {
	const lines = text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
	if (!front) return { front: null, body: text, bodyLine: 1 };
	if (lines[0] !== "---") {
		problems.add("front_matter", 1, null, "the file must start with a line of three dashes (---) and its settings");
		return null;
	}
	const close = lines.findIndex((line, index) => index > 0 && line === "---");
	if (close < 0) {
		problems.add("front_matter", 1, null, "the settings have no closing line of three dashes (---)");
		return null;
	}
	const values = new Map<string, Value>();
	let open: OpenList | null = null;
	const finish = () => {
		if (open) values.set(open.key, { line: open.line, items: open.items, item: null });
		open = null;
	};
	for (let index = 1; index < close; index++) {
		const line = lines[index] ?? "";
		const number = index + 1;
		if (line.includes("\t")) {
			problems.add("syntax", number, null, "tabs are not allowed in the settings; use spaces");
			continue;
		}
		if (LINE_SEPARATOR.test(line)) {
			problems.add("syntax", number, null, "line separator characters are not allowed in the settings");
			continue;
		}
		if (!line.trim() || /^\s*#/.test(line)) continue;
		const item = /^( *)-(?: +(.*))?$/.exec(line);
		if (item) {
			const current: OpenList | null = open;
			if (!current) {
				problems.add("syntax", number, null, "a list item must follow a setting that has no value on its line");
				continue;
			}
			const indent = item[1]?.length ?? 0;
			if (current.indent !== null && indent !== current.indent) {
				problems.add("syntax", number, current.key, "list items must line up under the first one");
				continue;
			}
			current.indent = indent;
			const parsed = scalar(item[2] ?? "", false);
			if (typeof parsed === "string") problems.add("syntax", number, current.key, parsed);
			else if (parsed.after.trim() && !/^\s+#/.test(parsed.after))
				problems.add("syntax", number, current.key, "unexpected text after the list item");
			else if (!parsed.item.quoted && !parsed.item.text)
				problems.add("syntax", number, current.key, "a list item is empty");
			else current.items.push({ ...parsed.item, line: number });
			continue;
		}
		finish();
		const match = /^([^\s:#][^:]*):(?: +(.*))?$/.exec(line);
		if (!match) {
			problems.add("syntax", number, null, 'each setting is one line, "name: value"');
			continue;
		}
		const key = match[1] ?? "";
		if (!KEY.test(key)) {
			problems.add("syntax", number, key, `"${key}" is not a setting name`);
			continue;
		}
		if (values.has(key)) {
			problems.add("duplicate_key", number, key, `${key} is set twice`);
			continue;
		}
		const rest = (match[2] ?? "").trim();
		if (!rest || rest.startsWith("#")) {
			open = { key, line: number, items: [], indent: null };
			continue;
		}
		const value = lineValue(rest, number);
		if (typeof value === "string") problems.add("syntax", number, key, value);
		else values.set(key, value);
	}
	finish();
	const after = lines.slice(close + 1).join("\n");
	return { front: values, body: after, bodyLine: close + 2 };
}

// ---------------------------------------------------------------------------------------------
// Checking settings

interface TextLimits {
	readonly min?: number;
	/** Count UTF-8 bytes, as the database does for this field, instead of characters. */
	readonly bytes?: boolean;
}

class Fields {
	readonly used = new Set<string>();
	readonly values: ReadonlyMap<string, Value>;
	readonly problems: Problems;
	constructor(values: ReadonlyMap<string, Value>, problems: Problems) {
		this.values = values;
		this.problems = problems;
	}

	/** Whether the key is present; marks it as allowed. */
	has(key: string): boolean {
		this.used.add(key);
		return this.values.has(key);
	}

	line(key: string): number | null {
		return this.values.get(key)?.line ?? null;
	}

	private one(key: string, required: boolean): Item | null {
		this.used.add(key);
		const value = this.values.get(key);
		if (!value) {
			if (required) this.problems.add("missing", null, key, `${key} is required`);
			return null;
		}
		if (!value.item) {
			if (value.items?.length === 0)
				this.problems.add("missing", value.line, key, `${key} is empty; give it a value or remove the line`);
			else this.problems.add("value", value.line, key, `${key} takes one value, not a list`);
			return null;
		}
		return value.item;
	}

	text(key: string, required: boolean, max: number, limits: TextLimits = {}): string | null {
		const item = this.one(key, required);
		if (!item) return null;
		const text = item.text;
		const min = limits.min ?? 1;
		if (!item.quoted && ambiguousPlain(text)) {
			this.problems.add("quote", item.line, key, `put the value of ${key} in double quotes`);
			return null;
		}
		if (NOT_ONE_LINE.test(text)) {
			this.problems.add("value", item.line, key, `${key} must be one line of text, without tabs`);
			return null;
		}
		if (text !== text.trim()) {
			this.problems.add("value", item.line, key, `remove the spaces at the start or end of ${key}`);
			return null;
		}
		const size = limits.bytes ? encoder.encode(text).byteLength : [...text].length;
		if (size < min || size > max) {
			const unit = limits.bytes ? "bytes" : "characters";
			this.problems.add("value", item.line, key, !text ? `${key} is empty` : `${key} must be ${min}–${max} ${unit}`);
			return null;
		}
		return text;
	}

	choice<const T extends string>(key: string, required: boolean, allowed: readonly T[]): T | null {
		const item = this.one(key, required);
		if (!item) return null;
		if ((allowed as readonly string[]).includes(item.text)) return item.text as T;
		this.problems.add("value", item.line, key, `${key} must be one of: ${allowed.join(", ")} (found "${item.text}")`);
		return null;
	}

	id(key: string, required: boolean): string | null {
		const item = this.one(key, required);
		if (!item) return null;
		if (UUID.test(item.text)) return item.text;
		this.problems.add(
			"value",
			item.line,
			key,
			UUID_ANY_CASE.test(item.text) ? `${key} must be written in lowercase` : `${key} must be an id`,
		);
		return null;
	}

	whole(key: string, required: boolean, min: number, max: number): number | null {
		const item = this.one(key, required);
		if (!item) return null;
		const number = !item.quoted && /^[0-9]{1,9}$/.test(item.text) ? Number(item.text) : Number.NaN;
		if (Number.isInteger(number) && number >= min && number <= max) return number;
		this.problems.add("value", item.line, key, `${key} must be a whole number from ${min} to ${max}, without quotes`);
		return null;
	}

	instant(key: string, required: boolean): string | null {
		const item = this.one(key, required);
		if (!item) return null;
		const instant = canonicalCompanyStateInstant(item.text);
		if (instant) return instant;
		this.problems.add("value", item.line, key, `${key} must be a UTC time like 2026-09-30T07:00:00Z`);
		return null;
	}

	clock(key: string, required: boolean): string | null {
		const item = this.one(key, required);
		if (!item) return null;
		if (CLOCK.test(item.text)) return item.text;
		this.problems.add("value", item.line, key, `${key} must be a time of day like "08:00"`);
		return null;
	}

	timeZone(key: string, required: boolean): string | null {
		const item = this.one(key, required);
		if (!item) return null;
		const problem = companyStateTimeZoneProblem(item.text);
		if (!problem) return item.text;
		this.problems.add("value", item.line, key, problem);
		return null;
	}

	/** A list; `null` when absent. An empty list is allowed only when `empty`. */
	list(key: string, required: boolean, empty: boolean): Item[] | null {
		this.used.add(key);
		const value = this.values.get(key);
		if (!value) {
			if (required) this.problems.add("missing", null, key, `${key} is required`);
			return null;
		}
		if (value.item) {
			this.problems.add("value", value.line, key, `${key} is a list: [a, b] or one "- item" per line`);
			return null;
		}
		const items = [...(value.items ?? [])];
		if (!items.length && !empty) {
			this.problems.add(
				"value",
				value.line,
				key,
				`${key} needs at least one entry; remove the line to leave it out`,
			);
			return null;
		}
		return items;
	}

	ids(key: string, required: boolean, empty: boolean): string[] | null {
		const items = this.list(key, required, empty);
		if (!items) return items;
		const ids: string[] = [];
		for (const item of items) {
			if (!UUID.test(item.text))
				this.problems.add(
					"value",
					item.line,
					key,
					UUID_ANY_CASE.test(item.text)
						? `ids in ${key} are written in lowercase`
						: `each entry of ${key} must be an id`,
				);
			else if (ids.includes(item.text))
				this.problems.add("value", item.line, key, `${item.text} is listed twice in ${key}`);
			else ids.push(item.text);
		}
		return ids;
	}

	days(key: string, required: boolean): RoutineDay[] | null {
		const items = this.list(key, required, false);
		if (!items) return null;
		const chosen: RoutineDay[] = [];
		for (const item of items) {
			const day = item.text as RoutineDay;
			if (!DAYS.includes(day))
				this.problems.add("value", item.line, key, `days are ${DAYS.join(", ")} (found "${item.text}")`);
			else if (chosen.includes(day)) this.problems.add("value", item.line, key, `${day} is listed twice`);
			else chosen.push(day);
		}
		return chosen;
	}

	/** Refuses keys this kind does not use. */
	close(kind: string): void {
		const allowed = [...this.used].sort().join(", ");
		for (const [key, value] of this.values)
			if (!this.used.has(key))
				this.problems.add(
					"unknown_key",
					value.line,
					key,
					`unknown setting "${key}" for ${kind}; allowed: ${allowed}`,
				);
	}
}

/** The body, trimmed as the index keeps it. */
function body(split: Split, problems: Problems, what: string, required: boolean, maxBytes: number): string | null {
	const text = split.body.trim();
	if (required && !text) {
		problems.add("body", split.bodyLine, null, `write ${what} below the second --- line`);
		return null;
	}
	if (encoder.encode(text).byteLength > maxBytes) {
		problems.add("body", split.bodyLine, null, `${what} is longer than ${maxBytes} bytes`);
		return null;
	}
	return text;
}

/** An ATX heading's text: trimmed, with an optional closing run of `#` removed (CommonMark).
 * Written without regular expressions over the whole line, so a long line costs its length. */
function headingText(rest: string): string {
	let text = rest.trim();
	let end = text.length;
	while (end > 0 && text[end - 1] === "#") end--;
	if (end === 0) return "";
	if (end < text.length && /\s/.test(text[end - 1] ?? "")) text = text.slice(0, end).trim();
	return text;
}

// ---------------------------------------------------------------------------------------------
// The kinds

function vision(split: Split, problems: Problems): VisionFile | null {
	const lines = split.body.split("\n");
	const index = lines.findIndex((line) => line.trim());
	const first = index < 0 ? "" : (lines[index] ?? "").replace(/\r$/, "");
	const marker = /^# +/.exec(first);
	const name = marker ? headingText(first.slice(marker[0].length)) : "";
	if (!name || NOT_ONE_LINE.test(name)) {
		problems.add("body", index < 0 ? 1 : index + 1, null, "the first line must be # and the company's name");
		return null;
	}
	if ([...name].length > 120) {
		problems.add("body", index + 1, null, "the company's name must be at most 120 characters");
		return null;
	}
	return { kind: "vision", name };
}

function agent(split: Split, fields: Fields, problems: Problems): AgentFile | null {
	const id = fields.id("id", true);
	const name = fields.text("name", true, 160);
	const role = fields.text("role", true, 320);
	const agentKind = fields.choice("kind", true, ["co-founder", "agent"] as const);
	const status = fields.choice("status", true, ["active", "archived"] as const);
	const colour = fields.choice("colour", false, AGENT_COLOURS);
	const figure = fields.choice("figure", false, STAFF_CHARACTER_IDS);
	const model = fields.choice("model", false, AGENT_MODELS);
	const effort = fields.choice("effort", false, COMPANY_STATE_EFFORTS);
	const instructions = body(split, problems, "the agent's instructions", true, 32768);
	fields.close("an agent");
	if (problems.list.length || !id || !name || !role || !agentKind || !status || instructions === null) return null;
	return { kind: "agent", id, name, role, agentKind, status, colour, figure, model, effort, instructions };
}

function sections(split: Split, problems: Problems): SectionsFile | null {
	const lines = split.body.split("\n");
	const found: { name: string; line: number; members: { id: string; line: number }[] }[] = [];
	const names = new Set<string>();
	const ids = new Set<string>();
	lines.forEach((raw, index) => {
		const line = raw.replace(/\r$/, "");
		const number = index + 1;
		if (line.startsWith("##") && !line.startsWith("###")) {
			if (line !== "##" && !line.startsWith("## ")) {
				problems.add("syntax", number, null, "put a space after ## in a section's name");
				return;
			}
			const name = headingText(line.slice(2));
			if (!name || NOT_ONE_LINE.test(name) || [...name].length > 60)
				problems.add("value", number, null, "a section's name must be 1–60 characters, without tabs");
			else if (names.has(name.toLowerCase()))
				problems.add("value", number, null, `there are two sections named "${name}"`);
			names.add(name.toLowerCase());
			found.push({ name, line: number, members: [] });
			return;
		}
		const entry = /^\s*[-*]\s+(\S+)(?:\s.*)?$/.exec(line);
		const section = found.at(-1);
		const id = entry?.[1] ?? "";
		if (!section) {
			if (UUID_ANY_CASE.test(id)) problems.add("syntax", number, null, "put this line under a ## section");
			return;
		}
		if (!line.trim()) return;
		if (!entry || !UUID.test(id)) {
			problems.add(
				"syntax",
				number,
				null,
				UUID_ANY_CASE.test(id) ? "ids are written in lowercase" : 'under a section, each line is "- " and an id',
			);
			return;
		}
		if (ids.has(id)) problems.add("value", number, null, `${id} is listed twice`);
		ids.add(id);
		section.members.push({ id, line: number });
	});
	if (problems.list.length) return null;
	return { kind: "sections", sections: found };
}

function group(split: Split, fields: Fields, problems: Problems): GroupFile | null {
	const id = fields.id("id", true);
	const name = fields.text("name", true, 256);
	const subtitle = fields.has("subtitle") ? fields.text("subtitle", false, 256, { min: 0 }) : null;
	const agents = fields.ids("agents", true, false);
	const people = fields.ids("people", false, true) ?? [];
	if (agents && agents.length < 2 && !problems.has("agents"))
		problems.add("value", fields.line("agents"), "agents", "a group chat needs at least two agents");
	const purpose = body(split, problems, "what the group is for", true, 32768);
	fields.close("a group chat");
	if (problems.list.length || !id || !name || !agents || purpose === null) return null;
	return { kind: "group", id, name, subtitle, agents, people, purpose };
}

function connection(split: Split, fields: Fields, problems: Problems): ConnectionFile | null {
	const id = fields.id("id", true);
	const service = fields.text("service", true, 64);
	if (service && !/^[a-z][a-z0-9_-]{0,63}$/.test(service))
		problems.add("value", fields.line("service"), "service", "service is a connector id like gmail");
	const account = fields.text("account", true, 254);
	const status = fields.choice("status", true, ["connected", "broken"] as const);
	const actions: string[] = [];
	for (const item of fields.list("actions", true, true) ?? []) {
		if (!/^[a-z][a-z0-9_]{0,63}$/.test(item.text))
			problems.add("value", item.line, "actions", `"${item.text}" is not an action name`);
		else if (actions.includes(item.text)) problems.add("value", item.line, "actions", `${item.text} is listed twice`);
		else actions.push(item.text);
	}
	const connectedBy = fields.id("connected_by", true);
	const connectedAt = fields.instant("connected_at", true);
	const purpose = body(split, problems, "what the account is for", false, 32768);
	fields.close("a connection");
	if (
		problems.list.length ||
		!id ||
		!service ||
		!account ||
		!status ||
		!connectedBy ||
		!connectedAt ||
		purpose === null
	)
		return null;
	return { kind: "connection", id, service, account, status, actions, connectedBy, connectedAt, purpose };
}

function rule(split: Split, fields: Fields, problems: Problems): RuleFile | null {
	const id = fields.id("id", true);
	const outcome = fields.choice("outcome", true, ["ask-first", "allow"] as const);
	const text = body(split, problems, 'how "When an agent wants to …" ends', true, 4096);
	if (text !== null && (NOT_ONE_LINE.test(text) || [...text].length > 280))
		problems.add(
			"body",
			split.bodyLine,
			null,
			'the rule is how "When an agent wants to …" ends: one line, at most 280 characters, without tabs',
		);
	fields.close("a rule");
	if (problems.list.length || !id || !outcome || text === null) return null;
	return { kind: "rule", id, outcome, text };
}

const TRIGGER_KEYS = {
	every: ["minutes", "starts"],
	weekly: ["days", "time", "starts"],
	window: ["minutes", "from", "to", "days", "months"],
	once: ["at"],
	"file-change": ["watch", "match"],
} as const;

function routine(split: Split, fields: Fields, problems: Problems): RoutineFile | null {
	const id = fields.id("id", true);
	const title = fields.text("title", true, 160, { bytes: true });
	const status = fields.choice("status", true, ["active", "paused", "concluded"] as const);
	const when = fields.choice("when", true, ROUTINE_WHEN);
	// Every key any trigger uses is known to this kind; a key of another trigger is refused by name.
	const own = new Set<string>(when ? TRIGGER_KEYS[when] : []);
	for (const key of new Set<string>(Object.values(TRIGGER_KEYS).flat()))
		if (!own.has(key) && fields.has(key))
			problems.add(
				"unknown_key",
				fields.line(key),
				key,
				when ? `${key} is not used with when: ${when}` : `${key} needs a valid when`,
			);
	let trigger: RoutineTrigger | null = null;
	if (when === "every") {
		const minutes = fields.whole("minutes", true, 5, 10080);
		const starts = fields.instant("starts", false);
		if (minutes !== null) trigger = { when, minutes, starts };
	} else if (when === "weekly") {
		const days = fields.days("days", true);
		const time = fields.clock("time", true);
		const starts = fields.instant("starts", false);
		if (days?.length && time) trigger = { when, days, time, starts };
	} else if (when === "window") {
		const minutes = fields.whole("minutes", true, 5, 10080);
		const from = fields.clock("from", true);
		const to = fields.clock("to", true);
		const days = fields.has("days") ? fields.days("days", false) : null;
		let months: number[] | null = null;
		const monthItems = fields.list("months", false, false);
		if (monthItems) {
			months = [];
			for (const item of monthItems) {
				const month = !item.quoted && /^[0-9]{1,2}$/.test(item.text) ? Number(item.text) : 0;
				if (month < 1 || month > 12)
					problems.add("value", item.line, "months", "months are numbers from 1 to 12, without quotes");
				else if (months.includes(month))
					problems.add("value", item.line, "months", `month ${month} is listed twice`);
				else months.push(month);
			}
		}
		if (from && to && from > to) problems.add("value", fields.line("to"), "to", "to must not be earlier than from");
		if (minutes !== null && from && to) trigger = { when, minutes, from, to, days, months };
	} else if (when === "once") {
		const at = fields.instant("at", true);
		if (at) trigger = { when, at };
	} else if (when === "file-change") {
		const watch = fields.text("watch", true, 4096)?.replace(/\/+$/, "") ?? null;
		if (
			watch !== null &&
			(!watch || watch.startsWith("/") || watch.split("/").some((part) => !part || part === "." || part === ".."))
		)
			problems.add(
				"value",
				fields.line("watch"),
				"watch",
				"watch is a folder or file path inside the company, like sales/leads",
			);
		const match = fields.choice("match", true, ["exact", "subtree"] as const);
		if (watch && match) trigger = { when, watch, match };
	}
	const timezone = fields.timeZone("timezone", when !== null && when !== "every");
	const ends = fields.instant("ends", false);
	const runs = fields.whole("runs", false, 1, 100000);
	if (runs !== null && when === "once")
		problems.add("value", fields.line("runs"), "runs", "runs is not used with when: once");
	let quiet: RoutineFile["quiet"] = null;
	const quietText = fields.text("quiet", false, 11);
	const quietZone = fields.has("quiet_timezone") ? fields.timeZone("quiet_timezone", false) : timezone;
	if (quietText !== null) {
		const match = /^(\d{2}:\d{2})-(\d{2}:\d{2})$/.exec(quietText);
		const start = match?.[1] ?? "";
		const end = match?.[2] ?? "";
		if (!CLOCK.test(start) || !CLOCK.test(end) || start === end)
			problems.add("value", fields.line("quiet"), "quiet", 'quiet hours look like "22:00-07:00"');
		else if (quietZone) quiet = { start, end, timezone: quietZone };
		else if (!problems.has("timezone") && !problems.has("quiet_timezone"))
			problems.add("missing", fields.line("quiet"), "timezone", "quiet hours need a timezone (or quiet_timezone)");
	} else if (fields.values.has("quiet_timezone"))
		problems.add("value", fields.line("quiet_timezone"), "quiet_timezone", "quiet_timezone goes with quiet");
	if (trigger?.when === "once" && ends && Date.parse(trigger.at) >= Date.parse(ends))
		problems.add("value", fields.line("at"), "at", "at must be before ends");
	const effort = fields.has("effort") ? fields.choice("effort", false, COMPANY_STATE_EFFORTS) : "medium";
	const reply = fields.has("reply")
		? fields.choice("reply", false, ["optional", "required", "silent"] as const)
		: "optional";
	const conclusion = fields.text("conclusion", status === "concluded", 2000, { bytes: true });
	if (status && status !== "concluded" && fields.values.has("conclusion"))
		problems.add(
			"value",
			fields.line("conclusion"),
			"conclusion",
			"conclusion is only written when status is concluded",
		);
	const instructions = body(split, problems, "what the routine does", true, 32768);
	fields.close("a routine");
	if (problems.list.length || !id || !title || !status || !trigger || !effort || !reply || instructions === null)
		return null;
	return {
		kind: "routine",
		id,
		title,
		status,
		trigger,
		timezone,
		ends,
		runs,
		quiet,
		effort,
		reply,
		conclusion: status === "concluded" ? conclusion : null,
		instructions,
	};
}

function todo(split: Split, fields: Fields, problems: Problems): TodoFile | null {
	const id = fields.id("id", true);
	const title = fields.text("title", true, 200, { bytes: true });
	const status = fields.choice("status", true, ["open", "blocked", "done", "cancelled"] as const);
	const requestedBy = fields.id("requested_by", false);
	const detail = body(split, problems, "the todo", false, 4000);
	fields.close("a todo");
	if (problems.list.length || !id || !title || !status || detail === null) return null;
	return { kind: "todo", id, title, status, requestedBy, detail };
}

function workerBrief(split: Split, fields: Fields, problems: Problems): WorkerBriefFile | null {
	const id = fields.id("id", true);
	const title = fields.text("title", true, 200, { bytes: true });
	const species = fields.choice("species", true, ["in-house", "coding"] as const);
	const access = fields.choice("access", true, ["read", "write"] as const);
	const revival = fields.choice("revival", true, ["each", "batch"] as const);
	const dispatchedAt = fields.instant("dispatched_at", true);
	const brief = body(split, problems, "the brief", true, 32768);
	fields.close("a worker's brief");
	if (problems.list.length || !id || !title || !species || !access || !revival || !dispatchedAt || brief === null)
		return null;
	return { kind: "worker-brief", id, title, species, access, revival, dispatchedAt, brief };
}

function workerResults(split: Split, fields: Fields, problems: Problems): WorkerResultsFile | null {
	const outcome = fields.choice("outcome", true, ["succeeded", "blocked", "failed", "cancelled"] as const);
	const reportedAt = fields.instant("reported_at", true);
	const decision = fields.choice("decision", false, ["accepted", "rejected"] as const);
	const note = fields.text("note", false, 1000, { bytes: true });
	if (fields.values.has("note") && !fields.values.has("decision"))
		problems.add("value", fields.line("note"), "note", "a note goes with a decision");
	const report = body(split, problems, "the report", true, 32768);
	fields.close("a worker's results");
	if (problems.list.length || !outcome || !reportedAt || report === null) return null;
	return { kind: "worker-results", outcome, reportedAt, decision, note, report };
}

/** Reads a structured file. Returns null for an ordinary file. Checks everything the file
 * says by itself; the database adds the rules that need its state (ids that exist, names that
 * are taken, who may write, the Co-Founder). `text` is the file decoded as strict UTF-8: a
 * writer that cannot decode the bytes reports an `encoding` problem itself and sends no text. */
export function parseCompanyStateFile(path: string, text: string): CompanyStateFileResult | null {
	const where = companyStatePath(path);
	if (!where) return null;
	const problems = new Problems();
	const refused = () => ({ ok: false as const, path: where, problems: problems.list });
	if (encoder.encode(text).byteLength > COMPANY_STATE_FILE_MAX_BYTES) {
		problems.add("too_large", null, null, `the file is larger than ${COMPANY_STATE_FILE_MAX_BYTES} bytes`);
		return refused();
	}
	if (text.includes("\u0000") || LONE_SURROGATE.test(text)) {
		problems.add("encoding", null, null, "the file must be plain UTF-8 text");
		return refused();
	}
	const unmarked = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
	// Names the path carries follow the naming rule of contract 5.6, as written.
	const written = path.split("/");
	const named: [string | undefined, string, string][] = [];
	if (where.kind === "group") named.push([written[2], "a group chat's folder", "group"]);
	else if (where.agent !== null) named.push([written[1], "an agent's folder", "agent"]);
	if (where.kind === "routine" || where.kind === "todo") named.push([written[3]?.slice(0, -3), "the file", "file"]);
	if (where.kind === "rule" || where.kind === "connection") named.push([written[1]?.slice(0, -3), "the file", "file"]);
	if (where.kind === "worker-brief" || where.kind === "worker-results")
		named.push([written[3], "the todo's folder", "todo"], [written[4], "the worker's folder", "worker"]);
	for (const [name, what, fallback] of named)
		if (name === undefined || !isCompanyStateName(name))
			problems.add(
				"name",
				null,
				null,
				`the name of ${what} (${name ?? ""}) must be lowercase letters a–z, digits and single hyphens, at most ${COMPANY_STATE_NAME_MAX_CHARS} characters, for example ${
					companyStateName(name ?? "") || fallback
				}`,
			);
	if (where.kind !== "vision" && where.kind !== "sections" && !written.at(-1)?.endsWith(".md"))
		problems.add("name", null, null, "the file name ends in .md, in lowercase");
	const front = where.kind !== "vision" && where.kind !== "sections";
	const parts = split(unmarked, front, problems);
	if (!parts) return refused();
	const fields = new Fields(parts.front ?? new Map(), problems);
	let file: CompanyStateFile | null = null;
	switch (where.kind) {
		case "vision":
			file = vision(parts, problems);
			break;
		case "agent":
			file = agent(parts, fields, problems);
			break;
		case "sections":
			file = sections(parts, problems);
			break;
		case "group":
			file = group(parts, fields, problems);
			break;
		case "connection":
			file = connection(parts, fields, problems);
			break;
		case "rule":
			file = rule(parts, fields, problems);
			break;
		case "routine":
			file = routine(parts, fields, problems);
			break;
		case "todo":
			file = todo(parts, fields, problems);
			break;
		case "worker-brief":
			file = workerBrief(parts, fields, problems);
			break;
		case "worker-results":
			file = workerResults(parts, fields, problems);
			break;
	}
	if (!file || problems.list.length) return refused();
	return { ok: true, path: where, file };
}

// ---------------------------------------------------------------------------------------------
// Writing: the canonical form the platform's own writers use. Members' and agents' own edits
// are kept as written; only these writers produce files from scratch. A writer always makes a
// file this parser can read; a value the format does not allow (a tab in a name) is then
// refused by the parse with its reason.

/** A text value as it is written after `key: `: plain when that reads back the same, else
 * double-quoted with every control and line separator character escaped. */
export function companyStateValue(text: string): string {
	const plain =
		text.length > 0 &&
		text === text.trim() &&
		!/^[[\]{},#&*!|>%@`"']/.test(text) &&
		!/^[-?:](?:\s|$)/.test(text) &&
		!/: |:$| #/.test(text) &&
		!ambiguousPlain(text) &&
		!NOT_ONE_LINE.test(text);
	return plain ? text : quote(text);
}

function quote(text: string): string {
	return JSON.stringify(text).replace(
		/[\u007f-\u009f\u2028\u2029]/g,
		(character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
}

function listValue(items: readonly string[]): string {
	return `[${items.map((item) => (/[[\]{},]/.test(item) ? quote(item) : companyStateValue(item))).join(", ")}]`;
}

function document(lines: readonly (readonly [string, string | null])[], text: string): string {
	const front = lines.filter(([, value]) => value !== null).map(([key, value]) => `${key}: ${value}`);
	return `---\n${front.join("\n")}\n---\n${text.trim() ? `${text.trim()}\n` : ""}`;
}

function note(name: string | undefined): string {
	return name ? ` # ${name.replace(/\s+/g, " ").trim()}` : "";
}

function idList(key: string, ids: readonly string[], names?: ReadonlyMap<string, string>): string {
	if (!ids.length) return `${key}: []`;
	return [`${key}:`, ...ids.map((id) => `  - ${id}${note(names?.get(id))}`)].join("\n");
}

export function writeVisionFile(name: string, text: string): string {
	return `# ${name.trim()}\n${text.trim() ? `\n${text.trim()}\n` : ""}`;
}

export function writeAgentFile(file: Omit<AgentFile, "kind">): string {
	return document(
		[
			["id", file.id],
			["name", companyStateValue(file.name)],
			["role", companyStateValue(file.role)],
			["kind", file.agentKind],
			["status", file.status],
			["colour", file.colour],
			["figure", file.figure],
			["model", file.model],
			["effort", file.effort],
		],
		file.instructions,
	);
}

/** `names` puts each agent's or group chat's name beside its id, for reading. */
export function writeSectionsFile(file: Omit<SectionsFile, "kind">, names?: ReadonlyMap<string, string>): string {
	const out = ["# Sections", "", "Each line is an id. The words after it are only for reading."];
	for (const section of file.sections) {
		out.push("", `## ${section.name}`);
		for (const member of section.members) {
			const name = names?.get(member.id);
			out.push(`- ${member.id}${name ? ` ${name.replace(/\s+/g, " ").trim()}` : ""}`);
		}
	}
	return `${out.join("\n")}\n`;
}

export function writeGroupFile(file: Omit<GroupFile, "kind">, names?: ReadonlyMap<string, string>): string {
	const front = [
		"---",
		`id: ${file.id}`,
		`name: ${companyStateValue(file.name)}`,
		...(file.subtitle !== null ? [`subtitle: ${file.subtitle ? companyStateValue(file.subtitle) : '""'}`] : []),
		idList("agents", file.agents, names),
		idList("people", file.people, names),
		"---",
	];
	return `${front.join("\n")}\n${file.purpose.trim()}\n`;
}

export function writeConnectionFile(file: Omit<ConnectionFile, "kind">): string {
	return document(
		[
			["id", file.id],
			["service", file.service],
			["account", companyStateValue(file.account)],
			["status", file.status],
			["actions", listValue(file.actions)],
			["connected_by", file.connectedBy],
			["connected_at", file.connectedAt],
		],
		file.purpose,
	);
}

export function writeRuleFile(file: Omit<RuleFile, "kind">): string {
	return document(
		[
			["id", file.id],
			["outcome", file.outcome],
		],
		file.text,
	);
}

export function writeRoutineFile(file: Omit<RoutineFile, "kind">): string {
	const trigger = file.trigger;
	const lines: [string, string | null][] = [
		["id", file.id],
		["title", companyStateValue(file.title)],
		["status", file.status],
		["when", trigger.when],
	];
	if (trigger.when === "every") lines.push(["minutes", String(trigger.minutes)], ["starts", trigger.starts]);
	if (trigger.when === "weekly")
		lines.push(["days", listValue(trigger.days)], ["time", quote(trigger.time)], ["starts", trigger.starts]);
	if (trigger.when === "window")
		lines.push(
			["minutes", String(trigger.minutes)],
			["from", quote(trigger.from)],
			["to", quote(trigger.to)],
			["days", trigger.days ? listValue(trigger.days) : null],
			["months", trigger.months ? `[${trigger.months.join(", ")}]` : null],
		);
	if (trigger.when === "once") lines.push(["at", trigger.at]);
	if (trigger.when === "file-change")
		lines.push(["watch", companyStateValue(trigger.watch)], ["match", trigger.match]);
	lines.push(
		["timezone", file.timezone],
		["ends", file.ends],
		["runs", file.runs === null ? null : String(file.runs)],
		["quiet", file.quiet ? quote(`${file.quiet.start}-${file.quiet.end}`) : null],
		["quiet_timezone", file.quiet && file.quiet.timezone !== file.timezone ? file.quiet.timezone : null],
		["effort", file.effort],
		["reply", file.reply],
		["conclusion", file.status === "concluded" && file.conclusion ? companyStateValue(file.conclusion) : null],
	);
	return document(lines, file.instructions);
}

export function writeTodoFile(file: Omit<TodoFile, "kind">, requesterName?: string): string {
	return document(
		[
			["id", file.id],
			["title", companyStateValue(file.title)],
			["status", file.status],
			["requested_by", file.requestedBy ? `${file.requestedBy}${note(requesterName)}` : null],
		],
		file.detail,
	);
}

export function writeWorkerBriefFile(file: Omit<WorkerBriefFile, "kind">): string {
	return document(
		[
			["id", file.id],
			["title", companyStateValue(file.title)],
			["species", file.species],
			["access", file.access],
			["revival", file.revival],
			["dispatched_at", file.dispatchedAt],
		],
		file.brief,
	);
}

export function writeWorkerResultsFile(file: Omit<WorkerResultsFile, "kind">): string {
	return document(
		[
			["outcome", file.outcome],
			["reported_at", file.reportedAt],
			["decision", file.decision],
			["note", file.note === null ? null : companyStateValue(file.note)],
		],
		file.report,
	);
}

/** A setting's new value for {@link setCompanyStateSettings}: text, a whole number, a list, or
 * null to remove the key. */
export type CompanyStateSetting = string | number | readonly string[] | null;

/** Changes settings of a file with a settings block and keeps every other byte as it was: the
 * byte-order mark, each line's own line ending, notes, blank lines and the body. So a member's
 * or an agent's own layout survives a status change made from the app. A changed key keeps
 * its place, and its list lines go with it. A new key goes last in the settings. */
export function setCompanyStateSettings(text: string, changes: Readonly<Record<string, CompanyStateSetting>>): string {
	const mark = text.charCodeAt(0) === 0xfeff ? "﻿" : "";
	const lines = text.slice(mark.length).split("\n");
	const bare = (line: string | undefined) => (line ?? "").replace(/\r$/, "");
	const close = bare(lines[0]) === "---" ? lines.findIndex((line, index) => index > 0 && bare(line) === "---") : -1;
	if (close < 0) throw new Error("The file has no settings block");
	const ending = (lines[0] ?? "").endsWith("\r") ? "\r" : "";
	const encoded = new Map<string, string | null>();
	for (const [key, value] of Object.entries(changes)) {
		if (!KEY.test(key)) throw new Error(`Invalid setting name: ${key}`);
		encoded.set(
			key,
			value === null
				? null
				: typeof value === "number"
					? String(value)
					: typeof value === "string"
						? companyStateValue(value)
						: listValue(value),
		);
	}
	const out: string[] = [lines[0] ?? "---"];
	for (let index = 1; index < close; index++) {
		const line = lines[index] ?? "";
		const key = /^([a-z][a-z0-9_]*):/.exec(bare(line))?.[1];
		if (key !== undefined && encoded.has(key)) {
			const value = encoded.get(key);
			encoded.delete(key);
			// The key's own list lines go with it: its items, and the notes and blank lines
			// between them, up to its last item.
			let last = index;
			for (let next = index + 1; next < close; next++) {
				const candidate = bare(lines[next]);
				if (/^ *-(?: |$)/.test(candidate)) last = next;
				else if (candidate.trim() && !/^\s*#/.test(candidate)) break;
			}
			index = last;
			if (value !== null && value !== undefined) out.push(`${key}: ${value}${line.endsWith("\r") ? "\r" : ""}`);
			continue;
		}
		out.push(line);
	}
	for (const [key, value] of encoded) if (value !== null) out.push(`${key}: ${value}${ending}`);
	return mark + [...out, ...lines.slice(close)].join("\n");
}
