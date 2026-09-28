/** Company state files (contract 5.6): the files of the company folder that have a fixed
 * format — the vision, an agent, the sidebar's sections, a group chat, a connection, a
 * company review rule, a routine, a todo and a worker's brief and results. Every writer (the
 * runtime's tools, the web app, the object gateway and the folder service) reads them through
 * this one parser, so a file means the same thing whoever saves it. The database checks the
 * rules that need its state and keeps the indexes (RUNTIME-COMPANY-STATE-FILES.md). Browser-safe.
 *
 * A settings block ("front matter") is a strict subset of YAML 1.2: one `key: value` per
 * line, values are text, whole numbers or lists of these (`[a, b]` on one line, or one
 * `- item` per indented line), and `#` starts a note. Each kind has a closed set of keys. */

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
export const COMPANY_STATE_PARSER_VERSION = 1;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const KEY = /^[a-z][a-z0-9_]*$/;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(\.\d{1,6})?)?Z$/;
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
export const AGENT_FIGURES = Object.freeze([
	"planet",
	"acorn",
	"flame",
	"rocket",
	"crown",
	"heart",
	"ghost",
	"brain",
] as const);
export const AGENT_MODELS = Object.freeze(["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"] as const);
export const AGENT_EFFORTS = Object.freeze(["low", "medium", "high"] as const);
export const ROUTINE_EFFORTS = Object.freeze(["low", "medium", "high", "xhigh", "max"] as const);
export const ROUTINE_WHEN = Object.freeze(["every", "weekly", "window", "once", "file-change"] as const);

export type AgentColour = (typeof AGENT_COLOURS)[number];
export type AgentFigure = (typeof AGENT_FIGURES)[number];
export type AgentModel = (typeof AGENT_MODELS)[number];
export type AgentEffort = (typeof AGENT_EFFORTS)[number];
export type RoutineEffort = (typeof ROUTINE_EFFORTS)[number];
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
	readonly effort: AgentEffort | null;
	/** The body: the agent's job, how it works and its voice. */
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
	/** The body: what the account is for, written by the company. */
	readonly purpose: string;
}

export interface RuleFile {
	readonly kind: "rule";
	readonly id: string;
	readonly outcome: "ask-first" | "allow";
	/** The rule, one sentence: "When an agent wants to …". */
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
	readonly quiet: { readonly start: string; readonly end: string } | null;
	readonly effort: RoutineEffort;
	readonly reply: "optional" | "required" | "silent";
	readonly conclusion: string | null;
	/** The body: what to do each time. */
	readonly instructions: string;
}

export interface TodoFile {
	readonly kind: "todo";
	readonly id: string;
	readonly title: string;
	readonly status: "open" | "blocked" | "done" | "cancelled";
	readonly requestedBy: string | null;
	/** The body: what to do and what done looks like. */
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

/** Where a structured file sits: its kind and the names its path carries. */
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

/** The kind of structured file a path holds, or null for an ordinary file. Paths compare
 * without regard to case, as the folder's keys do; the names themselves are checked by
 * {@link parseCompanyStateFile}. */
export function companyStatePath(path: string): CompanyStatePath | null {
	const parts = path.toLowerCase().split("/");
	const none = { agent: null, group: null, name: null, todo: null, worker: null };
	const stem = (part: string | undefined) => (part?.endsWith(".md") ? part.slice(0, -3) : null);
	const [a, b, c, d, e, f] = parts;
	if (parts.length === 2 && a === "vision" && b === "vision.md") return { kind: "vision", ...none };
	if (parts.length === 2 && a === "agents" && b === "sections.md") return { kind: "sections", ...none };
	if (parts.length === 2 && a === "connections" && stem(b)) return { kind: "connection", ...none, name: stem(b) };
	if (parts.length === 2 && a === "rules" && stem(b)) return { kind: "rule", ...none, name: stem(b) };
	if (a !== "agents" || b === undefined || b === "sections.md") return null;
	if (b === "groups")
		return parts.length === 4 && d === "group.md" ? { kind: "group", ...none, group: c ?? null } : null;
	if (parts.length === 3 && c === "agent.md") return { kind: "agent", ...none, agent: b };
	if (parts.length === 4 && c === "routines" && stem(d)) return { kind: "routine", ...none, agent: b, name: stem(d) };
	if (parts.length === 4 && c === "todos" && stem(d)) return { kind: "todo", ...none, agent: b, name: stem(d) };
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
	const latin = [...display.toLowerCase()].map((character) => PLAIN_LATIN[character] ?? character).join("");
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

/** A fresh id for a new file. */
export function newCompanyStateId(): string {
	return globalThis.crypto.randomUUID();
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
	readonly body: string;
	/** The body's first line number. */
	readonly bodyLine: number;
}

class Problems {
	readonly list: CompanyStateProblem[] = [];
	add(code: CompanyStateProblemCode, line: number | null, key: string | null, message: string): void {
		this.list.push({ line, key, code, message });
	}
}

/** A YAML 1.2 plain scalar the core schema reads as something other than text. */
function ambiguousPlain(text: string): boolean {
	return /^(?:~|null|Null|NULL|true|True|TRUE|false|False|FALSE|[-+]?(?:\.inf|\.Inf|\.INF)|\.nan|\.NaN|\.NAN|[-+]?[0-9]+|0o[0-7]+|0x[0-9a-fA-F]+|[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?)$/.test(
		text,
	);
}

/** One scalar at the start of `rest`: double-quoted, single-quoted or plain. Returns the value
 * and what follows it, or a message. `inList` stops a plain scalar at `,` and `]`. */
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
			const simple: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", n: "\n", t: "\t" };
			if (simple[code] !== undefined) text += simple[code];
			else if (code === "u" && /^[0-9a-fA-F]{4}$/.test(rest.slice(index + 1, index + 5))) {
				text += String.fromCharCode(Number.parseInt(rest.slice(index + 1, index + 5), 16));
				index += 4;
			} else return `the escape \\${code} is not supported here`;
		}
		return "a double quote is not closed";
	}
	if (rest.startsWith("'")) {
		let text = "";
		for (let index = 1; index < rest.length; index++) {
			if (rest[index] !== "'") text += rest[index];
			else if (rest[index + 1] === "'") text += rest[index++];
			else return { item: { text, quoted: true }, after: rest.slice(index + 1) };
		}
		return "a single quote is not closed";
	}
	if (/^[[\]{}&*!|>%@`]/.test(rest)) return "this kind of value is not supported; put it in double quotes";
	if (/^[-?:](?:\s|$)/.test(rest)) return "a value cannot start with this character; put it in double quotes";
	const stop = inList ? /(?:\s#|[,\]])/ : /\s#/;
	const end = rest.search(stop);
	const raw = (end < 0 ? rest : rest.slice(0, end)).trimEnd();
	if (/: |:$/.test(raw)) return 'a value with ": " in it goes in double quotes';
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
	let open: { key: string; line: number; items: Item[] } | null = null;
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
		if (!line.trim() || /^\s*#/.test(line)) continue;
		const item = /^\s+-(?:\s+(.*))?$/.exec(line);
		if (item) {
			if (!open) {
				problems.add("syntax", number, null, "a list item must follow a setting that has no value on its line");
				continue;
			}
			const parsed = scalar(item[1] ?? "", false);
			if (typeof parsed === "string") problems.add("syntax", number, open.key, parsed);
			else if (parsed.after.trim() && !/^\s+#/.test(parsed.after))
				problems.add("syntax", number, open.key, "unexpected text after the list item");
			else if (!parsed.item.quoted && !parsed.item.text)
				problems.add("syntax", number, open.key, "a list item is empty");
			else open.items.push({ ...parsed.item, line: number });
			continue;
		}
		finish();
		const match = /^([^\s:#][^:]*):(?:\s+(.*))?$/.exec(line);
		if (!match || /^\s/.test(line)) {
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
			open = { key, line: number, items: [] };
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

	private one(key: string, required: boolean): Item | null {
		this.used.add(key);
		const value = this.values.get(key);
		if (!value) {
			if (required) this.problems.add("missing", null, key, `${key} is required`);
			return null;
		}
		if (!value.item) {
			if (value.items?.length === 0) {
				if (required) this.problems.add("missing", value.line, key, `${key} is empty`);
				return null;
			}
			this.problems.add("value", value.line, key, `${key} takes one value, not a list`);
			return null;
		}
		return value.item;
	}

	text(key: string, required: boolean, max: number, min = 1): string | null {
		const item = this.one(key, required);
		if (!item) return null;
		const text = item.text.trim();
		if (!item.quoted && ambiguousPlain(text)) {
			this.problems.add("quote", item.line, key, `put the value of ${key} in double quotes`);
			return null;
		}
		if (CONTROL.test(text) || text.includes("\n")) {
			this.problems.add("value", item.line, key, `${key} must be one line of text`);
			return null;
		}
		if ([...text].length < min || [...text].length > max) {
			this.problems.add(
				"value",
				item.line,
				key,
				min > 0 && !text ? `${key} is empty` : `${key} must be ${min}–${max} characters`,
			);
			return null;
		}
		return text;
	}

	choice<const T extends string>(key: string, required: boolean, allowed: readonly T[]): T | null {
		const item = this.one(key, required);
		if (!item) return null;
		const text = item.text.trim();
		if ((allowed as readonly string[]).includes(text)) return text as T;
		this.problems.add("value", item.line, key, `${key} must be one of: ${allowed.join(", ")} (found "${text}")`);
		return null;
	}

	id(key: string, required: boolean): string | null {
		const item = this.one(key, required);
		if (!item) return null;
		const text = item.text.trim();
		if (UUID.test(text)) return text;
		this.problems.add(
			"value",
			item.line,
			key,
			key === "id"
				? `id must be a lowercase id like ${newCompanyStateId()} (a fresh one you can use)`
				: `${key} must be an id`,
		);
		return null;
	}

	whole(key: string, required: boolean, min: number, max: number): number | null {
		const item = this.one(key, required);
		if (!item) return null;
		const text = item.text.trim();
		const number = /^[0-9]{1,9}$/.test(text) ? Number(text) : Number.NaN;
		if (Number.isInteger(number) && number >= min && number <= max) return number;
		this.problems.add("value", item.line, key, `${key} must be a whole number from ${min} to ${max}`);
		return null;
	}

	instant(key: string, required: boolean): string | null {
		const item = this.one(key, required);
		if (!item) return null;
		const text = item.text.trim();
		if (validInstant(text)) return text;
		this.problems.add("value", item.line, key, `${key} must be a UTC time like 2026-09-30T07:00:00Z`);
		return null;
	}

	clock(key: string, required: boolean): string | null {
		const item = this.one(key, required);
		if (!item) return null;
		const text = item.text.trim();
		if (CLOCK.test(text)) return text;
		this.problems.add("value", item.line, key, `${key} must be a time of day like "08:00"`);
		return null;
	}

	/** A list; `null` when absent. */
	list(key: string, required: boolean): Item[] | null {
		this.used.add(key);
		const value = this.values.get(key);
		if (!value) {
			if (required) this.problems.add("missing", null, key, `${key} is required`);
			return null;
		}
		if (value.items) return [...value.items];
		if (value.item) {
			this.problems.add("value", value.line, key, `${key} is a list: [a, b] or one "- item" per line`);
			return null;
		}
		return [];
	}

	ids(key: string, required: boolean): string[] | null {
		const items = this.list(key, required);
		if (!items) return items;
		const ids: string[] = [];
		for (const item of items) {
			const text = item.text.trim();
			if (!UUID.test(text)) this.problems.add("value", item.line, key, `each entry of ${key} must be an id`);
			else if (ids.includes(text)) this.problems.add("value", item.line, key, `${text} is listed twice in ${key}`);
			else ids.push(text);
		}
		return ids;
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

function validInstant(text: string): boolean {
	const match = INSTANT.exec(text);
	if (!match) return false;
	const [, year, month, day, hour, minute, second] = match;
	const date = new Date(
		Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second ?? 0)),
	);
	return (
		date.getUTCFullYear() === Number(year) &&
		date.getUTCMonth() === Number(month) - 1 &&
		date.getUTCDate() === Number(day) &&
		date.getUTCHours() === Number(hour) &&
		date.getUTCMinutes() === Number(minute) &&
		Number(second ?? 0) < 60
	);
}

/** Whether the platform can run a routine in this IANA time zone. The database checks the
 * same name against its own list. */
export function isCompanyStateTimeZone(name: string): boolean {
	if (!/^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/.test(name)) return false;
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: name });
		return true;
	} catch {
		return false;
	}
}

function body(split: Split, problems: Problems, what: string, required: boolean, maxBytes: number): string | null {
	const text = split.body.replace(/^(?:\r?\n)/, "").trimEnd();
	if (required && !text.trim()) {
		problems.add("body", split.bodyLine, null, `write ${what} below the second --- line`);
		return null;
	}
	if (encoder.encode(text).byteLength > maxBytes) {
		problems.add("body", split.bodyLine, null, `${what} is longer than ${Math.floor(maxBytes / 1024)} KiB`);
		return null;
	}
	return text;
}

function days(fields: Fields, key: string, required: boolean): RoutineDay[] | null {
	const items = fields.list(key, required);
	if (!items) return null;
	const chosen: RoutineDay[] = [];
	for (const item of items) {
		const day = item.text.trim().toLowerCase() as RoutineDay;
		if (!DAYS.includes(day))
			fields.problems.add("value", item.line, key, `days are ${DAYS.join(", ")} (found "${item.text}")`);
		else if (chosen.includes(day)) fields.problems.add("value", item.line, key, `${day} is listed twice`);
		else chosen.push(day);
	}
	if (!chosen.length && !fields.problems.list.some((problem) => problem.key === key))
		fields.problems.add("value", fields.values.get(key)?.line ?? null, key, `${key} needs at least one day`);
	return chosen;
}

// ---------------------------------------------------------------------------------------------
// The kinds

function vision(split: Split, problems: Problems): VisionFile | null {
	const lines = split.body.split("\n");
	const index = lines.findIndex((line) => line.trim());
	const first = index < 0 ? "" : (lines[index] ?? "").replace(/\r$/, "");
	const match = /^# +(.+?)\s*$/.exec(first);
	const name = match?.[1]?.trim() ?? "";
	if (!match || !name || CONTROL.test(name)) {
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
	const figure = fields.choice("figure", false, AGENT_FIGURES);
	const model = fields.choice("model", false, AGENT_MODELS);
	const effort = fields.choice("effort", false, AGENT_EFFORTS);
	const instructions = body(split, problems, "the agent's instructions", true, 32 * 1024);
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
		const heading = /^##(?!#)\s*(.*?)\s*$/.exec(line);
		if (heading) {
			const name = heading[1] ?? "";
			if (!name || CONTROL.test(name) || [...name].length > 60)
				problems.add("value", number, null, "a section's name must be 1–60 characters");
			else if (names.has(name.toLowerCase()))
				problems.add("value", number, null, `there are two sections named "${name}"`);
			names.add(name.toLowerCase());
			found.push({ name, line: number, members: [] });
			return;
		}
		const entry = /^\s*[-*]\s+(\S+)(?:\s.*)?$/.exec(line);
		const section = found.at(-1);
		if (!section) {
			if (entry && UUID.test(entry[1] ?? ""))
				problems.add("syntax", number, null, "put this line under a ## section");
			return;
		}
		if (!line.trim()) return;
		if (!entry || !UUID.test(entry[1] ?? "")) {
			problems.add("syntax", number, null, 'under a section, each line is "- " and an id');
			return;
		}
		const id = entry[1] ?? "";
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
	const subtitle = fields.has("subtitle") ? fields.text("subtitle", false, 256, 0) || null : null;
	const agents = fields.ids("agents", true);
	const people = fields.ids("people", false) ?? [];
	if (agents && agents.length < 2 && !problems.list.some((problem) => problem.key === "agents"))
		problems.add(
			"value",
			fields.values.get("agents")?.line ?? null,
			"agents",
			"a group chat needs at least two agents",
		);
	const purpose = body(split, problems, "what the group is for", true, 32 * 1024);
	fields.close("a group chat");
	if (problems.list.length || !id || !name || !agents || purpose === null) return null;
	return { kind: "group", id, name, subtitle, agents, people, purpose };
}

function connection(split: Split, fields: Fields, problems: Problems): ConnectionFile | null {
	const id = fields.id("id", true);
	const service = fields.text("service", true, 64);
	if (service && !/^[a-z][a-z0-9_-]{0,63}$/.test(service))
		problems.add(
			"value",
			fields.values.get("service")?.line ?? null,
			"service",
			"service is a connector id like gmail",
		);
	const account = fields.text("account", true, 254);
	const status = fields.choice("status", true, ["connected", "broken"] as const);
	const actions: string[] = [];
	for (const item of fields.list("actions", true) ?? []) {
		const action = item.text.trim();
		if (!/^[a-z][a-z0-9_]{0,63}$/.test(action))
			problems.add("value", item.line, "actions", `"${action}" is not an action name`);
		else if (actions.includes(action)) problems.add("value", item.line, "actions", `${action} is listed twice`);
		else actions.push(action);
	}
	const connectedBy = fields.id("connected_by", true);
	const connectedAt = fields.instant("connected_at", true);
	const purpose = body(split, problems, "what the account is for", false, 32 * 1024);
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
	const text = body(split, problems, "the rule", true, 4 * 1024);
	if (text !== null && (text.includes("\n") || CONTROL.test(text) || [...text].length > 280))
		problems.add("body", split.bodyLine, null, "the rule is one sentence of at most 280 characters, on one line");
	fields.close("a rule");
	if (problems.list.length || !id || !outcome || text === null) return null;
	return { kind: "rule", id, outcome, text };
}

function routine(split: Split, fields: Fields, problems: Problems): RoutineFile | null {
	const id = fields.id("id", true);
	const title = fields.text("title", true, 160);
	const status = fields.choice("status", true, ["active", "paused", "concluded"] as const);
	const when = fields.choice("when", true, ROUTINE_WHEN);
	// Every key any trigger uses is known to this kind; keys that belong to another trigger
	// are refused below by name.
	const keys = {
		every: ["minutes", "starts"],
		weekly: ["days", "time", "starts"],
		window: ["minutes", "from", "to", "days", "months"],
		once: ["at"],
		"file-change": ["watch", "match"],
	} as const;
	const allKeys = new Set<string>(Object.values(keys).flat());
	const own = new Set<string>(when ? keys[when] : []);
	for (const key of allKeys)
		if (!own.has(key) && fields.has(key))
			problems.add(
				"unknown_key",
				fields.values.get(key)?.line ?? null,
				key,
				when ? `${key} is not used when "when: ${when}"` : `${key} needs a valid "when"`,
			);
	let trigger: RoutineTrigger | null = null;
	if (when === "every") {
		const minutes = fields.whole("minutes", true, 5, 10080);
		const starts = fields.instant("starts", false);
		if (minutes !== null) trigger = { when, minutes, starts };
	} else if (when === "weekly") {
		const chosen = days(fields, "days", true);
		const time = fields.clock("time", true);
		const starts = fields.instant("starts", false);
		if (chosen?.length && time) trigger = { when, days: chosen, time, starts };
	} else if (when === "window") {
		const minutes = fields.whole("minutes", true, 5, 10080);
		const from = fields.clock("from", true);
		const to = fields.clock("to", true);
		const chosen = fields.has("days") ? days(fields, "days", false) : null;
		let months: number[] | null = null;
		const monthItems = fields.list("months", false);
		if (monthItems) {
			months = [];
			for (const item of monthItems) {
				const month = /^[0-9]{1,2}$/.test(item.text.trim()) ? Number(item.text.trim()) : 0;
				if (month < 1 || month > 12) problems.add("value", item.line, "months", "months are numbers from 1 to 12");
				else if (months.includes(month))
					problems.add("value", item.line, "months", `month ${month} is listed twice`);
				else months.push(month);
			}
		}
		if (from && to && from > to)
			problems.add("value", fields.values.get("to")?.line ?? null, "to", "to must not be earlier than from");
		if (minutes !== null && from && to) trigger = { when, minutes, from, to, days: chosen, months };
	} else if (when === "once") {
		const at = fields.instant("at", true);
		if (at) trigger = { when, at };
	} else if (when === "file-change") {
		const watchItem = fields.values.get("watch")?.item;
		const watch = fields.text("watch", true, 4096)?.replace(/\/+$/, "") ?? null;
		if (
			watch !== null &&
			(!watch || watch.startsWith("/") || watch.split("/").some((part) => !part || part === "." || part === ".."))
		)
			problems.add(
				"value",
				watchItem?.line ?? null,
				"watch",
				"watch is a folder or file path inside the company, like sales/leads",
			);
		const match = fields.has("match") ? fields.choice("match", false, ["exact", "subtree"] as const) : "subtree";
		if (watch && match) trigger = { when, watch, match };
	}
	const zoneItem = fields.values.get("timezone")?.item;
	const timezone = fields.text("timezone", false, 64);
	if (timezone && !isCompanyStateTimeZone(timezone))
		problems.add(
			"value",
			zoneItem?.line ?? null,
			"timezone",
			`unknown time zone "${timezone}"; use a name like Europe/Copenhagen`,
		);
	const ends = fields.instant("ends", false);
	const runs = fields.whole("runs", false, 1, 100000);
	if (runs !== null && when === "once")
		problems.add("value", fields.values.get("runs")?.line ?? null, "runs", "runs is not used with when: once");
	const quietItem = fields.values.get("quiet")?.item;
	const quietText = fields.text("quiet", false, 11);
	let quiet: RoutineFile["quiet"] = null;
	if (quietText !== null) {
		const match = /^(\d{2}:\d{2})-(\d{2}:\d{2})$/.exec(quietText);
		if (!match || !CLOCK.test(match[1] ?? "") || !CLOCK.test(match[2] ?? "") || match[1] === match[2])
			problems.add("value", quietItem?.line ?? null, "quiet", 'quiet hours look like "22:00-07:00"');
		else quiet = { start: match[1] ?? "", end: match[2] ?? "" };
	}
	const needsZone = when !== null && when !== "every" ? `when: ${when}` : quietText !== null ? "quiet hours" : null;
	if (needsZone && !fields.values.has("timezone"))
		problems.add("missing", null, "timezone", `timezone is required for ${needsZone}`);
	if (trigger?.when === "once" && ends && Date.parse(trigger.at) >= Date.parse(ends))
		problems.add("value", fields.values.get("at")?.line ?? null, "at", "at must be before ends");
	const effort = fields.has("effort") ? fields.choice("effort", false, ROUTINE_EFFORTS) : "medium";
	const reply = fields.has("reply")
		? fields.choice("reply", false, ["optional", "required", "silent"] as const)
		: "optional";
	const conclusionItem = fields.values.get("conclusion");
	const conclusion = fields.text("conclusion", status === "concluded", 2000);
	if (status && status !== "concluded" && conclusionItem)
		problems.add("value", conclusionItem.line, "conclusion", "conclusion is only written when status is concluded");
	const instructions = body(split, problems, "what the routine does", true, 32 * 1024);
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
	const title = fields.text("title", true, 200);
	const status = fields.choice("status", true, ["open", "blocked", "done", "cancelled"] as const);
	const requestedBy = fields.id("requested_by", false);
	const detail = body(split, problems, "the todo", false, 4000);
	fields.close("a todo");
	if (problems.list.length || !id || !title || !status || detail === null) return null;
	return { kind: "todo", id, title, status, requestedBy, detail };
}

function workerBrief(split: Split, fields: Fields, problems: Problems): WorkerBriefFile | null {
	const id = fields.id("id", true);
	const title = fields.text("title", true, 200);
	const species = fields.choice("species", true, ["in-house", "coding"] as const);
	const access = fields.choice("access", true, ["read", "write"] as const);
	const revival = fields.choice("revival", true, ["each", "batch"] as const);
	const dispatchedAt = fields.instant("dispatched_at", true);
	const brief = body(split, problems, "the brief", true, 32 * 1024);
	fields.close("a worker's brief");
	if (problems.list.length || !id || !title || !species || !access || !revival || !dispatchedAt || brief === null)
		return null;
	return { kind: "worker-brief", id, title, species, access, revival, dispatchedAt, brief };
}

function workerResults(split: Split, fields: Fields, problems: Problems): WorkerResultsFile | null {
	const outcome = fields.choice("outcome", true, ["succeeded", "blocked", "failed", "cancelled"] as const);
	const reportedAt = fields.instant("reported_at", true);
	const decision = fields.choice("decision", false, ["accepted", "rejected"] as const);
	const note = fields.text("note", false, 1000);
	if (note !== null && !decision)
		problems.add("value", fields.values.get("note")?.line ?? null, "note", "a note goes with a decision");
	const report = body(split, problems, "the report", true, 32 * 1024);
	fields.close("a worker's results");
	if (problems.list.length || !outcome || !reportedAt || report === null) return null;
	return { kind: "worker-results", outcome, reportedAt, decision, note, report };
}

/** Reads a structured file. Returns null for an ordinary file. Checks everything the file
 * says by itself; the database adds the rules that need its state (ids that exist, names that
 * are taken, who may write, the Co-Founder). */
export function parseCompanyStateFile(path: string, text: string): CompanyStateFileResult | null {
	const where = companyStatePath(path);
	if (!where) return null;
	const problems = new Problems();
	const refused = () => ({ ok: false as const, path: where, problems: problems.list });
	if (encoder.encode(text).byteLength > COMPANY_STATE_FILE_MAX_BYTES) {
		problems.add("too_large", null, null, `the file is larger than ${COMPANY_STATE_FILE_MAX_BYTES / 1024} KiB`);
		return refused();
	}
	if (text.includes("\u0000") || text.includes("�")) {
		problems.add("encoding", null, null, "the file must be plain UTF-8 text");
		return refused();
	}
	const unmarked = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
	// Names the path carries follow the naming rule of contract 5.6, as written.
	const written = path.split("/");
	const named: [string | undefined, string][] = [];
	if (where.kind === "group") named.push([written[2], "a group chat's folder"]);
	else if (where.agent !== null) named.push([written[1], "an agent's folder"]);
	if (where.kind === "routine" || where.kind === "todo") named.push([written[3]?.replace(/\.md$/i, ""), "the file"]);
	if (where.kind === "rule" || where.kind === "connection")
		named.push([written[1]?.replace(/\.md$/i, ""), "the file"]);
	if (where.kind === "worker-brief" || where.kind === "worker-results")
		named.push([written[3], "the todo's folder"], [written[4], "the worker's folder"]);
	for (const [name, what] of named)
		if (name === undefined || !isCompanyStateName(name))
			problems.add(
				"name",
				null,
				null,
				`the name of ${what} (${name ?? ""}) must be lowercase letters a–z, digits and hyphens, at most ${COMPANY_STATE_NAME_MAX_CHARS} characters${
					name ? `, for example ${companyStateName(name) || "agent"}` : ""
				}`,
			);
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
// are kept as written; only these writers produce files from scratch.

/** A value as it is written after `key: `: plain when that reads back the same, else quoted. */
export function companyStateValue(text: string): string {
	const plain =
		text === text.trim() &&
		text.length > 0 &&
		!/^[[\]{}&*!|>%@`"'#,?:-]/.test(text) &&
		!/: |:$| #/.test(text) &&
		!ambiguousPlain(text) &&
		!CONTROL.test(text) &&
		!text.includes("\n");
	return plain ? text : JSON.stringify(text);
}

function listValue(items: readonly string[]): string {
	return `[${items.map((item) => (/[,[\]]/.test(item) ? JSON.stringify(item) : companyStateValue(item))).join(", ")}]`;
}

function document(lines: readonly (readonly [string, string | null])[], text: string): string {
	const front = lines
		.filter(([, value]) => value !== null)
		.map(([key, value]) => (value === "" ? `${key}:` : `${key}: ${value}`));
	return `---\n${front.join("\n")}\n---\n${text.trim() ? `${text.trim()}\n` : ""}`;
}

function idList(key: string, ids: readonly string[], names?: ReadonlyMap<string, string>): string {
	return [
		`${key}:`,
		...ids.map((id) => {
			const name = names?.get(id);
			return `  - ${id}${name ? ` # ${name.replace(/\s+/g, " ")}` : ""}`;
		}),
	].join("\n");
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
			out.push(`- ${member.id}${name ? ` ${name.replace(/\s+/g, " ")}` : ""}`);
		}
	}
	return `${out.join("\n")}\n`;
}

export function writeGroupFile(file: Omit<GroupFile, "kind">, names?: ReadonlyMap<string, string>): string {
	const front = [
		"---",
		`id: ${file.id}`,
		`name: ${companyStateValue(file.name)}`,
		...(file.subtitle ? [`subtitle: ${companyStateValue(file.subtitle)}`] : []),
		idList("agents", file.agents, names),
		file.people.length ? idList("people", file.people, names) : "people: []",
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
		lines.push(["days", listValue(trigger.days)], ["time", JSON.stringify(trigger.time)], ["starts", trigger.starts]);
	if (trigger.when === "window")
		lines.push(
			["minutes", String(trigger.minutes)],
			["from", JSON.stringify(trigger.from)],
			["to", JSON.stringify(trigger.to)],
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
		["quiet", file.quiet ? JSON.stringify(`${file.quiet.start}-${file.quiet.end}`) : null],
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
			[
				"requested_by",
				file.requestedBy
					? `${file.requestedBy}${requesterName ? ` # ${requesterName.replace(/\s+/g, " ")}` : ""}`
					: null,
			],
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

/** Changes single-value settings of a file with front matter and keeps every other byte as it
 * was, so a member's or an agent's own layout, notes and body survive a status change made
 * from the app. A null value removes the key. New keys go last in the settings. */
export function setCompanyStateSettings(text: string, changes: Readonly<Record<string, string | null>>): string {
	const newline = text.includes("\r\n") ? "\r\n" : "\n";
	const lines = text.split(/\r?\n/);
	const close = lines[0] === "---" ? lines.findIndex((line, index) => index > 0 && line === "---") : -1;
	if (close < 0) throw new Error("The file has no settings block");
	const pending = new Map(Object.entries(changes));
	const out: string[] = [lines[0] ?? "---"];
	for (let index = 1; index < close; index++) {
		const line = lines[index] ?? "";
		const key = /^([a-z][a-z0-9_]*):/.exec(line)?.[1];
		if (key && pending.has(key)) {
			const value = pending.get(key);
			pending.delete(key);
			// The key's own list lines, if any, go with it.
			while (index + 1 < close && /^\s+-/.test(lines[index + 1] ?? "")) index++;
			if (value !== null && value !== undefined) out.push(`${key}: ${value}`);
			continue;
		}
		out.push(line);
	}
	for (const [key, value] of pending) if (value !== null) out.push(`${key}: ${value}`);
	return [...out, ...lines.slice(close)].join(newline);
}
