/** Interfaces (contract, 2026-10-02 amendment "interfaces project company state from the company folder";
 * deploy/first-node/RUNTIME-INTERFACES.md): pages the company keeps as TOML files in its folder, and the tables
 * they read. Every writer and every reader (the web client's blocks, the runtime's interface tools, the folder's
 * save check) reads them through this one parser, so a file means the same thing wherever it is opened.
 *
 * A file is a strict subset of TOML 1.0 (./toml-subset.ts) with a closed set of keys per table: a key that isn't listed is refused, so a typo
 * never silently changes a page. Nothing here runs code from a file; the blocks and verbs are fixed lists.
 * Browser-safe, and the same bytes always give the same result, problems included. */

import { UUID_PATTERN } from "@qorpera/contracts";
import { AGENT_COLOURS, type AgentColour, companyPathKey } from "./company-state-shared.ts";
import { parseTomlSubset, TomlSubsetError } from "./toml-subset.ts";

export const INTERFACE_FORMAT = "qorpera.interface/v0";
export const TABLE_FORMAT = "qorpera.table/v0";

/** The folder core's bound for a checked file (RUNTIME-COMPANY-FOLDER-CORE.md §5). */
export const INTERFACE_FILE_MAX_BYTES = 64 * 1024;
export const INTERFACE_ORDER_MAX_BYTES = 16 * 1024;
export const TABLE_FILE_MAX_BYTES = 16 * 1024;
/** Every rows file is checked at save, inside the core's bound; a bigger table waits for the table store. */
export const TABLE_ROWS_MAX_BYTES = 64 * 1024;
export const INTERFACE_MAX_PROBLEMS = 50;
const NAME_MAX_CHARS = 64;

export const INTERFACE_BLOCKS = Object.freeze([
	"text",
	"numbers",
	"chart",
	"list",
	"table",
	"board",
	"calendar",
	"detail",
	"form",
	"mail",
] as const);
export const INTERFACE_VERBS = Object.freeze([
	"open",
	"message",
	"add",
	"set",
	"take",
	"offer",
	"release",
	"answer",
] as const);
/** Verbs a block may list without defining a button for them. */
export const INTERFACE_BUILT_IN_BUTTONS = Object.freeze(["answer", "take", "offer", "release"] as const);
export const INTERFACE_EMBLEMS = Object.freeze([
	"pulse",
	"mail",
	"members",
	"coin",
	"board",
	"queue",
	"calendar",
	"hire",
	"chart",
	"page",
] as const);
export const INTERFACE_WIDTHS = Object.freeze(["full", "half", "third", "two-thirds"] as const);

/** The sources a block may read, with the columns each one has (RUNTIME-INTERFACES.md §4). `table:<name>` and
 * `file:<path>` are not listed: a table's columns live in its own file, and a file is text. */
export const INTERFACE_SOURCE_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.freeze(
	Object.fromEntries(
		Object.entries({
			vision: ["text"],
			agents: ["id", "name", "role", "figure", "colour", "status", "section"],
			groups: ["id", "name", "agents", "people"],
			todos: ["id", "agent", "title", "status", "requested_by", "updated"],
			routines: ["id", "agent", "title", "when", "next", "status"],
			connections: ["id", "service", "account", "status"],
			contacts: ["id", "name", "organization"],
			human_tasks: ["id", "title", "status", "person", "from", "due"],
			interfaces: ["id", "name", "about", "emblem", "status"],
			mail: [
				"thread",
				"address",
				"from_name",
				"from_address",
				"subject",
				"last_at",
				"state",
				"handled_by",
				"direction",
				"unread",
			],
			mail_addresses: ["address", "handled_by", "routine", "last_7_days"],
			members: ["id", "name", "picture", "role", "here"],
			working: ["agent", "what", "since"],
			activity: ["at", "kind", "agent", "member", "line"],
			waiting: ["id", "kind", "title", "from", "due"],
		}).map(([source, columns]) => [source, Object.freeze(columns)]),
	),
);

export const TABLE_COLUMN_TYPES = Object.freeze([
	"text",
	"number",
	"money",
	"percent",
	"time",
	"date",
	"choice",
	"yes-no",
	"member",
	"agent",
	"agents",
	"id",
	"link",
] as const);

export type InterfaceBlockKind = (typeof INTERFACE_BLOCKS)[number];
export type InterfaceVerb = (typeof INTERFACE_VERBS)[number];
export type InterfaceEmblem = (typeof INTERFACE_EMBLEMS)[number];
export type InterfaceWidth = (typeof INTERFACE_WIDTHS)[number];
export type TableColumnType = (typeof TABLE_COLUMN_TYPES)[number];
export type InterfaceScalar = string | number | boolean;

export type InterfaceProblemCode =
	| "too_large"
	| "encoding"
	| "toml"
	| "format"
	| "unknown_key"
	| "missing_key"
	| "bad_value"
	| "duplicate"
	| "unknown_source"
	| "unknown_column"
	| "unknown_button"
	| "unknown_target"
	| "outside_value"
	| "row"
	| "claim"
	/** The save check's own codes (RUNTIME-INTERFACES.md §6.1): a file the format doesn't place or keep; no main
	 * interface or two; an owners-only interface changed by someone else; `[write]`; `tables/areas/`'s rules. */
	| "placement"
	| "main"
	| "owners"
	| "write"
	| "areas";

/** One reason a file can't be saved, or a row can't be read. Lines count from 1 over the whole file; `key` is
 * the dotted place in the file, `view[1].block[0].from`. */
export interface InterfaceProblem {
	readonly line: number | null;
	readonly key: string | null;
	readonly code: InterfaceProblemCode;
	readonly message: string;
}

export interface InterfaceQuery {
	readonly where: Readonly<Record<string, InterfaceScalar | readonly InterfaceScalar[]>> | null;
	readonly since: string | null;
	readonly order: { readonly column: string; readonly descending: boolean } | null;
	readonly limit: number | null;
	readonly latestBy: string | null;
}

export interface InterfaceCardTemplate {
	readonly title: string;
	readonly line: string | null;
	readonly figures: string | null;
	readonly note: string | null;
}

export interface InterfaceBoardPart {
	readonly title: string | null;
	readonly from: string;
	readonly card: InterfaceCardTemplate;
	readonly opens: string | null;
}

export interface InterfaceLookup {
	readonly from: string;
	readonly match: string;
	readonly show: string | null;
	readonly count: boolean;
}

export interface InterfaceBlock {
	readonly kind: InterfaceBlockKind;
	readonly id: string | null;
	readonly title: string | null;
	/** The sources, in order; one except for a calendar, and none for a text block with inline text or a board
	 * (whose parts name theirs). */
	readonly from: readonly string[];
	readonly width: InterfaceWidth;
	readonly query: InterfaceQuery;
	readonly buttons: readonly string[];
	readonly opens: string | null;
	/** text */
	readonly show: "all" | "first-paragraph" | null;
	readonly text: string | null;
	/** numbers, chart, detail */
	readonly value: string | null;
	readonly target: string | null;
	readonly trend: { readonly over: string; readonly weeks: number } | null;
	readonly chart: {
		readonly type: "line" | "bar";
		readonly x: string;
		readonly y: string | null;
		readonly by: string | null;
		readonly every: "day" | "week" | "month" | null;
		readonly total: "sum" | "count" | null;
		readonly target: string | null;
		readonly weeks: number | null;
	} | null;
	/** list */
	readonly line: string | null;
	readonly sub: string | null;
	readonly figure: string | null;
	readonly status: string | null;
	readonly chips: string | null;
	readonly layout: "rows" | "cards";
	/** table, detail, form */
	readonly columns: readonly string[];
	readonly lookups: Readonly<Record<string, InterfaceLookup>>;
	readonly fields: readonly string[];
	/** board */
	readonly lanes: string | null;
	readonly shared: string | null;
	readonly openPile: boolean;
	readonly parts: readonly InterfaceBoardPart[];
	/** calendar */
	readonly days: number | null;
}

export interface InterfaceView {
	readonly name: string;
	readonly fromView: string | null;
	readonly where: InterfaceQuery["where"];
	readonly blocks: readonly InterfaceBlock[];
}

export interface InterfaceButton {
	readonly id: string;
	readonly verb: InterfaceVerb;
	readonly label: string;
	readonly who: "all" | "members" | "agents";
	readonly target: string | null;
	readonly to: string | null;
	readonly text: string | null;
	readonly table: string | null;
	readonly column: string | null;
	readonly value: InterfaceScalar | null;
	readonly fields: readonly string[];
}

export type InterfaceNeed = "mail" | "team" | `connection:${string}` | `table:${string}`;

export interface InterfaceAccess {
	readonly members: "all" | "owners" | readonly string[];
	readonly agents: "all" | readonly string[];
	readonly edit: "anyone" | "owners";
}

export interface InterfaceFile {
	readonly kind: "interface";
	readonly id: string;
	readonly name: string;
	readonly about: string | null;
	readonly emblem: InterfaceEmblem | null;
	readonly colour: AgentColour | null;
	readonly main: boolean;
	readonly status: "active" | "off";
	readonly needs: readonly InterfaceNeed[];
	readonly badge: { readonly from: string; readonly query: InterfaceQuery } | null;
	readonly template: { readonly from: string; readonly version: string } | null;
	readonly access: InterfaceAccess;
	readonly views: readonly InterfaceView[];
	readonly buttons: readonly InterfaceButton[];
}

export interface TableColumn {
	readonly name: string;
	readonly type: TableColumnType;
	readonly optional: boolean;
	readonly needsYes: boolean;
	readonly max: number | null;
	readonly choices: readonly string[];
	readonly currency: string | null;
	readonly to: string | null;
}

export interface TableFile {
	readonly kind: "table";
	readonly id: string;
	readonly name: string;
	readonly about: string | null;
	readonly rows: "file";
	readonly key: readonly string[];
	readonly holder: string | null;
	readonly time: string | null;
	readonly columns: readonly TableColumn[];
	readonly write: {
		readonly agents: "all" | "none" | readonly string[];
		readonly members: "all" | "owners" | "none";
	};
}

export interface InterfaceOrderFile {
	readonly kind: "interface-order";
	readonly ids: readonly string[];
}

export type InterfaceParseResult<T> =
	| { readonly ok: true; readonly file: T; readonly problems: readonly [] }
	| { readonly ok: false; readonly file: null; readonly problems: readonly InterfaceProblem[] };

export type InterfaceStatePathKind = "interface" | "interface-order" | "table" | "table-rows";

export interface InterfaceStatePath {
	readonly kind: InterfaceStatePathKind;
	/** The interface's folder name, or the table's stem; null for `interfaces/order.md`. */
	readonly name: string | null;
}

const UUID = UUID_PATTERN;
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const COLUMN = /^[a-z][a-z0-9_]*$/;
const SINCE = /^(?:today|-[1-9][0-9]{0,2}[dwm])$/;
const TEMPLATE_PUBLISHER = /^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SEMVER = /^(?:0|[1-9][0-9]{0,5})\.(?:0|[1-9][0-9]{0,5})\.(?:0|[1-9][0-9]{0,5})$/;
const CURRENCY = /^[A-Z]{3}$/;
const NOT_ONE_LINE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
/** Controls a multi-line text never holds: everything but tab and line feed. */
const NOT_TEXT = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
/** Direction controls, which can make a text read differently from what it says. */
const BIDI = /[\u202a-\u202e\u2066-\u2069]/;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const encoder = new TextEncoder();

/** Decodes a file's bytes the way the save path must: strict UTF-8 that keeps a leading byte order mark, so the
 * text's sha256 matches the saved bytes (the commit compares them). A default TextDecoder drops the mark, which
 * would make a `rows.csv` exported from a spreadsheet fail that comparison. The parsers drop the mark themselves
 * where the format allows one (rows and order.md) and refuse it in TOML. Null when the bytes aren't UTF-8. */
export function decodeInterfaceFile(bytes: Uint8Array): string | null {
	try {
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch {
		return null;
	}
}

/** Which interface file a path is, decided on the folder's key like the state files. */
export function interfaceStatePath(path: string): InterfaceStatePath | null {
	const key = companyPathKey(path);
	const parts = key.split("/");
	if (parts[0] === "interfaces") {
		if (parts.length === 2 && parts[1] === "order.md") return { kind: "interface-order", name: null };
		if (parts.length === 3 && parts[2] === "interface.toml" && isInterfaceName(parts[1] ?? "")) {
			return { kind: "interface", name: parts[1] ?? null };
		}
		return null;
	}
	if (parts[0] === "tables" && parts.length === 3 && isInterfaceName(parts[1] ?? "")) {
		if (parts[2] === "table.toml") return { kind: "table", name: parts[1] ?? null };
		if (parts[2] === "rows.csv") return { kind: "table-rows", name: parts[1] ?? null };
	}
	return null;
}

/** A folder or table name: lowercase a–z, digits and single hyphens, at most 64 characters. */
export function isInterfaceName(value: string): boolean {
	return value.length > 0 && value.length <= NAME_MAX_CHARS && NAME.test(value);
}

/** Problems with the path itself: a file under `interfaces/` or `tables/` that the format doesn't place. */
export function interfacePathProblems(path: string): InterfaceProblem[] {
	if (encoder.encode(path).length > 4096) {
		// Too long to be anywhere in the folder; only this format's own paths are refused here.
		const head = path.replace(/^\/+/, "").slice(0, 11).toLowerCase();
		return head.startsWith("interfaces/") || head.startsWith("tables/") || head === "interfaces" || head === "tables"
			? [problem(null, null, "too_large", "The path is longer than the folder allows (4,096 bytes).")]
			: [];
	}
	let start = 0;
	let end = path.length;
	while (start < end && path[start] === "/") start++;
	while (end > start && path[end - 1] === "/") end--;
	const written = path.slice(start, end);
	const key = companyPathKey(written);
	const parts = key.split("/");
	if (parts[0] !== "interfaces" && parts[0] !== "tables") return [];
	// Names are written as the format names them, like the state files: `interfaces/Pulse/` is refused, not read.
	if (written !== key && written.replace(/README\.md$/, "readme.md") !== key) {
		return [
			problem(
				null,
				null,
				"bad_value",
				"Folders and files here are named in lowercase plain letters, digits and hyphens.",
			),
		];
	}
	if (parts.length === 1) return [];
	if (interfaceStatePath(written)) return [];
	if (parts.length === 3 && parts[2] === "readme.md" && isInterfaceName(parts[1] ?? "")) {
		return [];
	}
	if (parts.length === 2 && isInterfaceName(parts[1] ?? "")) return [];
	return [
		problem(
			null,
			null,
			"bad_value",
			parts[0] === "interfaces"
				? "Under interfaces/ go order.md and one folder per interface, with interface.toml and an optional README.md."
				: "Under tables/ goes one folder per table, named with lowercase letters, digits and hyphens, holding table.toml and rows.csv.",
		),
	];
}

function problem(
	line: number | null,
	key: string | null,
	code: InterfaceProblemCode,
	message: string,
): InterfaceProblem {
	return { line, key, code, message };
}

/* ---------------- reading TOML ---------------- */

/** The dotted key a reader sees, `view[1].block[0].from`, from the scanner's `view.1.block.0.from`. */
function displayKey(path: string): string {
	return path.replace(/\.(\d+)(?=\.|$)/g, "[$1]");
}

type Bag = Record<string, unknown>;

class Reader {
	readonly problems: InterfaceProblem[] = [];
	private readonly lines: ReadonlyMap<string, number>;

	constructor(lines: ReadonlyMap<string, number>) {
		this.lines = lines;
	}

	lineOf(path: string): number | null {
		let p = path;
		while (p) {
			const line = this.lines.get(p);
			if (line !== undefined) return line;
			const dot = p.lastIndexOf(".");
			if (dot < 0) break;
			p = p.slice(0, dot);
		}
		return null;
	}

	/** Problems past the cap, counted for the closing "and K more problems", with the first one's code. */
	dropped = 0;
	droppedCode: InterfaceProblemCode | null = null;

	add(path: string | null, code: InterfaceProblemCode, message: string): void {
		if (this.problems.length >= INTERFACE_MAX_PROBLEMS) {
			this.dropped++;
			this.droppedCode ??= code;
			return;
		}
		this.problems.push(
			problem(path ? this.lineOf(path) : null, path ? shown(displayKey(path)) : null, code, message),
		);
	}

	/** Refuses every key not in `allowed`. */
	keys(bag: Bag, path: string, allowed: readonly string[]): void {
		for (const key of Object.keys(bag)) {
			if (!allowed.includes(key)) {
				const at = path ? `${path}.${key}` : key;
				this.add(at, "unknown_key", `"${clip(key)}" is not a key here. Allowed: ${allowed.join(", ")}.`);
			}
		}
	}

	table(bag: Bag, key: string, path: string, required: boolean): Bag | null {
		const value = bag[key];
		const at = join(path, key);
		if (value === undefined) {
			if (required) this.add(at, "missing_key", `[${displayKey(at)}] is required.`);
			return null;
		}
		if (!isBag(value)) {
			this.add(at, "bad_value", `${displayKey(at)} must be a table.`);
			return null;
		}
		return value;
	}

	tables(bag: Bag, key: string, path: string, min: number, max: number): Bag[] {
		const value = bag[key];
		const at = join(path, key);
		if (value === undefined) {
			if (min > 0)
				this.add(at, "missing_key", `At least ${min} [[${displayKey(at)}]] ${min === 1 ? "is" : "are"} required.`);
			return [];
		}
		if (!Array.isArray(value) || !value.every(isBag)) {
			this.add(at, "bad_value", `${displayKey(at)} must be written as [[${key}]] tables.`);
			return [];
		}
		if (value.length < min || value.length > max) {
			this.add(
				at,
				value.length > max ? "too_large" : "missing_key",
				`${displayKey(at)} takes ${min}–${max} entries, not ${value.length}.`,
			);
		}
		return value.slice(0, max) as Bag[];
	}

	text(
		bag: Bag,
		key: string,
		path: string,
		opts: { required?: boolean; max: number; min?: number; multiline?: boolean },
	): string | null {
		const value = bag[key];
		const at = join(path, key);
		if (value === undefined) {
			if (opts.required) this.add(at, "missing_key", `${displayKey(at)} is required.`);
			return null;
		}
		if (typeof value !== "string") {
			this.add(at, "bad_value", `${displayKey(at)} must be text in quotes.`);
			return null;
		}
		const min = opts.min ?? (opts.required ? 1 : 0);
		const length = [...value].length;
		if (length < min || length > opts.max) {
			this.add(
				at,
				length > opts.max ? "too_large" : "bad_value",
				`${displayKey(at)} takes ${min}–${opts.max} characters.`,
			);
			return null;
		}
		if (LONE_SURROGATE.test(value)) {
			this.add(at, "encoding", `${displayKey(at)} holds a broken character.`);
			return null;
		}
		if (!opts.multiline && NOT_ONE_LINE.test(value)) {
			this.add(at, "bad_value", `${displayKey(at)} must be one line.`);
			return null;
		}
		if ((opts.multiline && NOT_TEXT.test(value)) || BIDI.test(value)) {
			this.add(at, "bad_value", `${displayKey(at)} holds a control or direction character.`);
			return null;
		}
		return value;
	}

	choice<T extends string>(
		bag: Bag,
		key: string,
		path: string,
		choices: readonly T[],
		fallback: T | null,
		required = false,
	): T | null {
		const value = bag[key];
		const at = join(path, key);
		if (value === undefined) {
			if (required) this.add(at, "missing_key", `${displayKey(at)} is required.`);
			return fallback;
		}
		if (typeof value !== "string" || !(choices as readonly string[]).includes(value)) {
			this.add(at, "bad_value", `${displayKey(at)} must be one of: ${choices.join(", ")}.`);
			return fallback;
		}
		return value as T;
	}

	bool(bag: Bag, key: string, path: string, fallback: boolean): boolean {
		const value = bag[key];
		if (value === undefined) return fallback;
		if (typeof value !== "boolean") {
			this.add(join(path, key), "bad_value", `${displayKey(join(path, key))} must be true or false.`);
			return fallback;
		}
		return value;
	}

	whole(bag: Bag, key: string, path: string, min: number, max: number): number | null {
		const value = bag[key];
		const at = join(path, key);
		if (value === undefined) return null;
		if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
			this.add(at, "bad_value", `${displayKey(at)} must be a whole number from ${min} to ${max}.`);
			return null;
		}
		return value;
	}

	list(
		bag: Bag,
		key: string,
		path: string,
		opts: { max: number; item: (value: string) => boolean; what: string },
	): string[] {
		const value = bag[key];
		const at = join(path, key);
		if (value === undefined) return [];
		const items = typeof value === "string" ? [value] : value;
		if (!Array.isArray(items) || !items.every((item) => typeof item === "string")) {
			this.add(at, "bad_value", `${displayKey(at)} must be a list of texts.`);
			return [];
		}
		if (items.length > opts.max) {
			this.add(at, "too_large", `${displayKey(at)} takes at most ${opts.max} entries.`);
			return [];
		}
		const seen = new Set<string>();
		for (const item of items as string[]) {
			if (!opts.item(item)) {
				this.add(at, "bad_value", `${displayKey(at)}: "${clip(item)}" is not ${opts.what}.`);
				return [];
			}
			if (seen.has(item)) {
				this.add(at, "duplicate", `${displayKey(at)} lists "${clip(item)}" twice.`);
				return [];
			}
			seen.add(item);
		}
		return items as string[];
	}
}

function join(path: string, key: string): string {
	return path ? `${path}.${key}` : key;
}

function isBag(value: unknown): value is Bag {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clip(value: string): string {
	return [...value].length > 60 ? `${[...value].slice(0, 57).join("")}…` : value;
}

/** Input quoted in a problem's key, at most 100 characters. */
function shown(text: string): string {
	return [...text].length > 100 ? `${[...text].slice(0, 100).join("")}…` : text;
}

/** The list a refusal carries: at most 50 problems, then "and K more problems", like the state files. */
function withMore(
	problems: readonly InterfaceProblem[],
	dropped = 0,
	droppedCode: InterfaceProblemCode | null = null,
): InterfaceProblem[] {
	const first = problems.slice(0, INTERFACE_MAX_PROBLEMS);
	const more = problems.length - first.length + dropped;
	// The code of the first problem left out, as the state files report it.
	const code = problems[INTERFACE_MAX_PROBLEMS]?.code ?? droppedCode;
	if (more > 0 && code)
		first.push(problem(null, null, code, `and ${more} more ${more === 1 ? "problem" : "problems"}`));
	return first;
}

/** Reads the TOML, or returns why it can't. Size and encoding are checked before parsing. */
function readToml(text: string, maxBytes: number): { bag: Bag; reader: Reader } | InterfaceProblem[] {
	if (encoder.encode(text).length > maxBytes) {
		return [problem(null, null, "too_large", `The file is larger than ${Math.round(maxBytes / 1024)} KiB.`)];
	}
	if (LONE_SURROGATE.test(text) || text.includes("\ufeff")) {
		return [problem(null, null, "encoding", "The file must be UTF-8 text without a byte order mark.")];
	}
	try {
		const document = parseTomlSubset(text);
		return { bag: document.value, reader: new Reader(document.lines) };
	} catch (error) {
		if (error instanceof TomlSubsetError) return [problem(error.line, null, "toml", error.message)];
		throw error;
	}
}

function done<T>(reader: Reader, file: T): InterfaceParseResult<T> {
	if (reader.problems.length > 0)
		return { ok: false, file: null, problems: withMore(reader.problems, reader.dropped, reader.droppedCode) };
	return { ok: true, file, problems: [] };
}

/* ---------------- sources and queries ---------------- */

/** True for a source a block may name: a listed source, `table:<name>` or `file:<path>`. */
export function isInterfaceSource(source: string): boolean {
	if (Object.hasOwn(INTERFACE_SOURCE_COLUMNS, source)) return true;
	if (source.startsWith("table:")) return isInterfaceName(source.slice(6));
	if (source.startsWith("file:")) return isFolderFilePath(source.slice(5));
	return false;
}

/** The columns a source is known to have, or null when they live elsewhere (a table) or it is text (a file). */
export function interfaceSourceColumns(source: string): readonly string[] | null {
	if (Object.hasOwn(INTERFACE_SOURCE_COLUMNS, source)) return INTERFACE_SOURCE_COLUMNS[source] ?? null;
	if (source.startsWith("file:")) return ["text"];
	return null;
}

function isFolderFilePath(path: string): boolean {
	if (path.length === 0 || path.length > 512 || path.startsWith("/") || path.endsWith("/")) return false;
	if (NOT_ONE_LINE.test(path) || path.includes("\\")) return false;
	return path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

const QUERY_KEYS = ["where", "since", "order", "limit", "latest_by"] as const;
/** Keys a table block takes for itself, so a column of that name can't also be a lookup. */
const RESERVED_BLOCK_KEYS: ReadonlySet<string> = new Set([
	"kind",
	"id",
	"title",
	"from",
	"width",
	"buttons",
	"columns",
	"opens",
	...QUERY_KEYS,
]);

function readWhere(reader: Reader, value: unknown, at: string): InterfaceQuery["where"] {
	if (value === undefined) return null;
	if (!isBag(value)) {
		reader.add(at, "bad_value", `${displayKey(at)} must be an inline table, like { status = "open" }.`);
		return null;
	}
	const out: Record<string, InterfaceScalar | readonly InterfaceScalar[]> = {};
	for (const [column, item] of Object.entries(value)) {
		if (!COLUMN.test(column)) {
			reader.add(at, "bad_value", `${displayKey(at)}: "${clip(column)}" is not a column name.`);
			continue;
		}
		if (isScalar(item)) out[column] = item;
		else if (Array.isArray(item) && item.length > 0 && item.length <= 50 && item.every(isScalar)) out[column] = item;
		else reader.add(at, "bad_value", `${displayKey(at)}.${clip(column)} must be a value or a list of values.`);
	}
	return out;
}

function isScalar(value: unknown): value is InterfaceScalar {
	return (
		typeof value === "boolean" ||
		(typeof value === "number" && Number.isFinite(value)) ||
		(typeof value === "string" && value.length <= 200 && !NOT_ONE_LINE.test(value))
	);
}

function readQuery(reader: Reader, bag: Bag, path: string): InterfaceQuery {
	const where = readWhere(reader, bag.where, join(path, "where"));
	let since: string | null = null;
	if (bag.since !== undefined) {
		if (typeof bag.since === "string" && SINCE.test(bag.since)) since = bag.since;
		else reader.add(join(path, "since"), "bad_value", `since is "today" or like "-7d", "-12w", "-3m".`);
	}
	let order: InterfaceQuery["order"] = null;
	if (bag.order !== undefined) {
		const text = typeof bag.order === "string" ? bag.order : "";
		const descending = text.startsWith("-");
		const column = descending ? text.slice(1) : text;
		if (COLUMN.test(column)) order = { column, descending };
		else
			reader.add(
				join(path, "order"),
				"bad_value",
				`order names a column, with a leading "-" for newest or largest first.`,
			);
	}
	const limit = reader.whole(bag, "limit", path, 1, 200);
	let latestBy: string | null = null;
	if (bag.latest_by !== undefined) {
		if (typeof bag.latest_by === "string" && COLUMN.test(bag.latest_by)) latestBy = bag.latest_by;
		else reader.add(join(path, "latest_by"), "bad_value", "latest_by names a column.");
	}
	return { where, since, order, limit, latestBy };
}

/** The columns of each source that carry outside content (RUNTIME-INTERFACES.md §4; contract 11.1), apart from a
 * `file:` source's text under `hooks/` or `human-tasks/`, which `interfaceOutsideColumns` adds. */
export const INTERFACE_OUTSIDE_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
	mail: Object.freeze(["from_name", "from_address", "subject"]),
});

/** The sources whose outside values can travel as a quote (the contract's closed quote list: the 2026-10-02
 * amendment "quoted outside content in a member's message", item 1). */
export const INTERFACE_QUOTE_SOURCES: readonly string[] = Object.freeze(["mail"]);

/** At most this many outside values in one message button's text (RUNTIME-INTERFACES.md §3.3). */
export const INTERFACE_OUTSIDE_VALUES_MAX = 16;

/** A client cuts each outside value to this many characters before it fills it in, the longest a quote may be
 * (RUNTIME-INTERFACES.md §3.3; the quote provenance amendment, item 1). */
export const INTERFACE_OUTSIDE_VALUE_MAX_CHARS = 2000;

/** The columns of a source that carry outside content. A `file:` source's text is outside content under `hooks/`
 * (saved events) or `human-tasks/` (what a contact sent back), found by folder key as the folder finds files. */
export function interfaceOutsideColumns(source: string): readonly string[] {
	if (source.startsWith("file:")) {
		const key = companyPathKey(source.slice("file:".length));
		return key.startsWith("hooks/") || key.startsWith("human-tasks/") ? ["text"] : [];
	}
	return Object.hasOwn(INTERFACE_OUTSIDE_COLUMNS, source) ? (INTERFACE_OUTSIDE_COLUMNS[source] ?? []) : [];
}

/** The `{column}` names a text uses; null when its braces are malformed. */
export function interfaceTemplateColumns(text: string): string[] | null {
	const out: string[] = [];
	let i = 0;
	while (i < text.length) {
		const open = text.indexOf("{", i);
		const close = text.indexOf("}", i);
		if (open < 0) return close < 0 ? out : null;
		if (close >= 0 && close < open) return null;
		const end = text.indexOf("}", open + 1);
		if (end < 0) return null;
		const name = text.slice(open + 1, end);
		if (!COLUMN.test(name) || name.length > 40) return null;
		out.push(name);
		i = end + 1;
	}
	return out;
}

/* ---------------- interface.toml ---------------- */

const TOP_KEYS = ["format", "interface", "template", "access", "view", "button"];
const INTERFACE_KEYS = ["id", "name", "about", "emblem", "colour", "main", "status", "needs", "badge"];
const VIEW_KEYS = ["name", "from_view", "where", "block"];
const COMMON_BLOCK_KEYS = ["kind", "id", "title", "from", "width", "buttons", ...QUERY_KEYS];
const BLOCK_KEYS: Readonly<Record<InterfaceBlockKind, readonly string[]>> = {
	text: ["show", "text"],
	numbers: ["value", "target", "trend", "opens"],
	chart: ["type", "x", "y", "by", "every", "sum", "count", "target", "weeks"],
	list: ["line", "sub", "figure", "status", "chips", "layout", "opens"],
	table: ["columns", "opens"],
	board: ["lanes", "shared", "open_pile", "part"],
	calendar: ["days"],
	detail: ["fields", "chart"],
	form: ["fields"],
	mail: [],
};
const BUTTON_KEYS: Readonly<Record<InterfaceVerb, readonly string[]>> = {
	open: ["target"],
	message: ["to", "text"],
	add: ["table", "fields"],
	set: ["table", "column", "value"],
	take: ["table", "column"],
	offer: ["table", "column"],
	release: ["table", "column"],
	answer: [],
};

export function parseInterfaceFile(text: string): InterfaceParseResult<InterfaceFile> {
	const read = readToml(text, INTERFACE_FILE_MAX_BYTES);
	if (Array.isArray(read)) return { ok: false, file: null, problems: read };
	const { bag, reader } = read;
	reader.keys(bag, "", TOP_KEYS);
	if (bag.format !== INTERFACE_FORMAT) reader.add("format", "format", `format must be "${INTERFACE_FORMAT}".`);

	const head = reader.table(bag, "interface", "", true) ?? {};
	reader.keys(head, "interface", INTERFACE_KEYS);
	const id = reader.text(head, "id", "interface", { required: true, max: 36 });
	if (id !== null && !UUID.test(id)) reader.add("interface.id", "bad_value", "interface.id must be a lowercase uuid.");
	const name = reader.text(head, "name", "interface", { required: true, max: 60 });
	const about = reader.text(head, "about", "interface", { max: 280 });
	const emblem = reader.choice(head, "emblem", "interface", INTERFACE_EMBLEMS, null);
	const colour = reader.choice(head, "colour", "interface", AGENT_COLOURS, null);
	const main = reader.bool(head, "main", "interface", false);
	const status = reader.choice(head, "status", "interface", ["active", "off"] as const, "active") ?? "active";
	const needs = reader.list(head, "needs", "interface", {
		max: 8,
		what: 'mail, team, "connection:<service>" or "table:<name>"',
		item: (need) =>
			need === "mail" ||
			need === "team" ||
			(need.startsWith("connection:") && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(need.slice(11))) ||
			(need.startsWith("table:") && isInterfaceName(need.slice(6))),
	}) as InterfaceNeed[];
	let badge: InterfaceFile["badge"] = null;
	if (head.badge !== undefined) {
		if (!isBag(head.badge))
			reader.add(
				"interface.badge",
				"bad_value",
				'interface.badge must be an inline table, like { from = "waiting" }.',
			);
		else {
			reader.keys(head.badge, "interface.badge", ["from", ...QUERY_KEYS]);
			const from = reader.text(head.badge, "from", "interface.badge", { required: true, max: 600 });
			if (from !== null && !isInterfaceSource(from))
				reader.add("interface.badge.from", "unknown_source", `"${clip(from)}" is not a source.`);
			const query = readQuery(reader, head.badge, "interface.badge");
			const known = from === null ? null : interfaceSourceColumns(from);
			for (const column of [...Object.keys(query.where ?? {}), query.order?.column, query.latestBy]) {
				if (known && column && !known.includes(column))
					reader.add("interface.badge", "unknown_column", `${clip(from ?? "")} has no column "${clip(column)}".`);
			}
			badge = from === null ? null : { from, query };
		}
	}

	let template: InterfaceFile["template"] = null;
	const tpl = reader.table(bag, "template", "", false);
	if (tpl) {
		reader.keys(tpl, "template", ["from", "version"]);
		const from = reader.text(tpl, "from", "template", { required: true, max: 81 });
		const version = reader.text(tpl, "version", "template", { required: true, max: 20 });
		if (from !== null && (!TEMPLATE_PUBLISHER.test(from) || from.split("/").some((part) => part.length > 40)))
			reader.add("template.from", "bad_value", 'template.from is "<publisher>/<name>", each at most 40 characters.');
		if (version !== null && !SEMVER.test(version))
			reader.add("template.version", "bad_value", 'template.version is like "1.0.0".');
		if (from !== null && version !== null) template = { from, version };
	}

	const access = readAccess(reader, reader.table(bag, "access", "", false));

	const buttonBags = reader.tables(bag, "button", "", 0, 32);
	const buttons: InterfaceButton[] = [];
	const buttonIds = new Set<string>();
	buttonBags.forEach((b, n) => {
		const path = `button.${n}`;
		const button = readButton(reader, b, path);
		if (!button) return;
		if (buttonIds.has(button.id)) reader.add(`${path}.id`, "duplicate", `Two buttons have the id "${button.id}".`);
		buttonIds.add(button.id);
		buttons.push(button);
	});

	const viewBags = reader.tables(bag, "view", "", 1, 8);
	const views: InterfaceView[] = [];
	const viewNames = new Set<string>();
	const blockIds = new Set<string>();
	viewBags.forEach((v, n) => {
		const path = `view.${n}`;
		reader.keys(v, path, VIEW_KEYS);
		const viewName = reader.text(v, "name", path, { required: true, max: 40 });
		if (viewName !== null) {
			if (viewNames.has(viewName)) reader.add(`${path}.name`, "duplicate", `Two views are called "${viewName}".`);
			viewNames.add(viewName);
		}
		const fromView = reader.text(v, "from_view", path, { max: 40 });
		if (fromView !== null && !viewNames.has(fromView)) {
			reader.add(`${path}.from_view`, "unknown_target", `from_view must name a view above this one.`);
		}
		const where = readWhere(reader, v.where, `${path}.where`);
		if (where && fromView === null)
			reader.add(`${path}.where`, "unknown_key", "A view takes where only together with from_view.");
		const blockBags = reader.tables(v, "block", path, fromView === null ? 1 : 0, 24);
		if (fromView !== null && blockBags.length > 0)
			reader.add(`${path}.block`, "unknown_key", "A view with from_view has no blocks of its own.");
		const blocks: InterfaceBlock[] = [];
		blockBags.forEach((bb, m) => {
			const block = readBlock(reader, bb, `${path}.block.${m}`);
			if (!block) return;
			if (block.id !== null) {
				if (blockIds.has(block.id))
					reader.add(`${path}.block.${m}.id`, "duplicate", `Two blocks have the id "${block.id}".`);
				blockIds.add(block.id);
			}
			blocks.push(block);
		});
		views.push({ name: viewName ?? "", fromView, where, blocks });
	});

	// References inside the file: buttons a block lists, the detail or mail block a block opens, and the columns
	// of sources whose columns are known.
	views.forEach((view, n) => {
		const detailIds = new Set(
			view.blocks
				.filter((b) => (b.kind === "detail" || b.kind === "mail") && b.id !== null)
				.map((b) => b.id as string),
		);
		view.blocks.forEach((block, m) => {
			const path = `view.${n}.block.${m}`;
			for (const id of block.buttons) {
				if (!buttonIds.has(id) && !(INTERFACE_BUILT_IN_BUTTONS as readonly string[]).includes(id)) {
					reader.add(`${path}.buttons`, "unknown_button", `No button has the id "${clip(id)}".`);
				}
			}
			// A message button fills its text from the block's rows. A value from outside content must travel as a
			// quote, which only the quote list's sources can do, and at most 16 of them (RUNTIME-INTERFACES.md §3.3).
			for (const source of block.from) {
				const outside = interfaceOutsideColumns(source);
				if (outside.length === 0) continue;
				for (const id of block.buttons) {
					const button = buttons.find((candidate) => candidate.id === id);
					if (button?.verb !== "message" || button.text === null) continue;
					const named = (interfaceTemplateColumns(button.text) ?? []).filter((column) => outside.includes(column));
					if (named.length > 0 && !INTERFACE_QUOTE_SOURCES.includes(source))
						reader.add(
							`${path}.buttons`,
							"outside_value",
							`The button "${clip(id)}" fills in ${clip(source)}'s outside content, which can't travel as a quote.`,
						);
					else if (named.length > INTERFACE_OUTSIDE_VALUES_MAX)
						reader.add(
							`${path}.buttons`,
							"outside_value",
							`The button "${clip(id)}" fills in more than ${INTERFACE_OUTSIDE_VALUES_MAX} values from outside content.`,
						);
				}
			}
			const opens = [block.opens, ...block.parts.map((part) => part.opens)].filter(
				(id): id is string => id !== null,
			);
			for (const id of opens) {
				if (!detailIds.has(id))
					reader.add(
						`${path}.opens`,
						"unknown_target",
						`opens must name a detail or mail block in the same view, not "${clip(id)}".`,
					);
			}
			const known = block.from.length === 1 ? interfaceSourceColumns(block.from[0] ?? "") : null;
			if (known) {
				for (const column of blockColumns(block)) {
					if (!known.includes(column))
						reader.add(
							path,
							"unknown_column",
							`${clip(block.from[0] ?? "")} has no column "${clip(column)}". It has: ${known.join(", ")}.`,
						);
				}
			}
		});
	});

	return done(reader, {
		kind: "interface",
		id: id ?? "",
		name: name ?? "",
		about,
		emblem,
		colour,
		main,
		status,
		needs,
		badge,
		template,
		access,
		views,
		buttons,
	});
}

function readAccess(reader: Reader, bag: Bag | null): InterfaceAccess {
	if (!bag) return { members: "all", agents: "all", edit: "anyone" };
	reader.keys(bag, "access", ["members", "agents", "edit"]);
	const people = (key: "members" | "agents", words: readonly string[]): "all" | "owners" | readonly string[] => {
		const value = bag[key];
		if (value === undefined) return "all";
		if (typeof value === "string") {
			if (words.includes(value)) return value as "all" | "owners";
			reader.add(`access.${key}`, "bad_value", `access.${key} is ${words.join(" or ")}, or a list of ids.`);
			return "all";
		}
		const ids = reader.list(bag, key, "access", {
			max: 100,
			what: "a lowercase uuid",
			item: (item) => UUID.test(item),
		});
		if (Array.isArray(value) && value.length === 0)
			reader.add(`access.${key}`, "bad_value", `access.${key} lists at least one id.`);
		return ids;
	};
	const members = people("members", ["all", "owners"]);
	const agents = people("agents", ["all"]) as "all" | readonly string[];
	const edit = reader.choice(bag, "edit", "access", ["anyone", "owners"] as const, "anyone") ?? "anyone";
	return { members, agents, edit };
}

function readButton(reader: Reader, bag: Bag, path: string): InterfaceButton | null {
	const id = reader.text(bag, "id", path, { required: true, max: 40 });
	if (id !== null && !ID.test(id))
		reader.add(`${path}.id`, "bad_value", "A button's id uses lowercase letters, digits and hyphens.");
	const verb = reader.choice(bag, "verb", path, INTERFACE_VERBS, null, true);
	const label = reader.text(bag, "label", path, { required: true, max: 40 });
	if (label !== null && interfaceTemplateColumns(label) === null)
		reader.add(`${path}.label`, "bad_value", "A {column} in the label is not closed or not a column name.");
	if (!verb) {
		reader.keys(bag, path, ["id", "verb", "label", "who"]);
		return null;
	}
	reader.keys(bag, path, ["id", "verb", "label", "who", ...BUTTON_KEYS[verb]]);
	const who = reader.choice(bag, "who", path, ["all", "members", "agents"] as const, "all") ?? "all";
	let target: string | null = null;
	let to: string | null = null;
	let text: string | null = null;
	let table: string | null = null;
	let column: string | null = null;
	let value: InterfaceScalar | null = null;
	let fields: string[] = [];
	if (verb === "open") {
		target = reader.text(bag, "target", path, { required: true, max: 600 });
		if (target !== null && !isOpenTarget(target)) {
			reader.add(
				`${path}.target`,
				"bad_value",
				'target is "agent:{column}", "interface:<name>", "file:<path>" or "row".',
			);
		}
	}
	if (verb === "message") {
		to = reader.text(bag, "to", path, { required: true, max: 60 });
		if (to !== null && !(to === "co-founder" || UUID.test(to) || /^\{[a-z][a-z0-9_]*\}$/.test(to))) {
			reader.add(`${path}.to`, "bad_value", 'to is an agent id, "{column}" or "co-founder".');
		}
		text = reader.text(bag, "text", path, { max: 500, multiline: true });
		if (text !== null && interfaceTemplateColumns(text) === null)
			reader.add(`${path}.text`, "bad_value", "A {column} in the text is not closed or not a column name.");
	}
	if (verb === "add" || verb === "set" || verb === "take" || verb === "offer" || verb === "release") {
		table = reader.text(bag, "table", path, { required: true, max: NAME_MAX_CHARS });
		if (table !== null && !isInterfaceName(table))
			reader.add(`${path}.table`, "bad_value", "table names a table: lowercase letters, digits and hyphens.");
	}
	if (verb === "set" || verb === "take" || verb === "offer" || verb === "release") {
		column = reader.text(bag, "column", path, { required: true, max: 40 });
		if (column !== null && !COLUMN.test(column)) reader.add(`${path}.column`, "bad_value", "column names a column.");
	}
	if (verb === "set") {
		const raw = bag.value;
		if (raw === undefined) reader.add(`${path}.value`, "missing_key", "A set button needs a value.");
		else if (isScalar(raw)) value = raw;
		else reader.add(`${path}.value`, "bad_value", 'value is a value, "{column}" or "me".');
	}
	if (verb === "add") {
		fields = reader.list(bag, "fields", path, { max: 40, what: "a column name", item: (f) => COLUMN.test(f) });
	}
	if (id === null || label === null) return null;
	return { id, verb, label, who, target, to, text, table, column, value, fields };
}

/** The source columns a block names (not its lookups, which name their own tables). */
function blockColumns(block: InterfaceBlock): string[] {
	const out = new Set<string>();
	const add = (value: string | null) => {
		if (value) out.add(value);
	};
	const addText = (value: string | null) => {
		for (const column of value ? (interfaceTemplateColumns(value) ?? []) : []) out.add(column);
	};
	for (const column of Object.keys(block.query.where ?? {})) out.add(column);
	add(block.query.order?.column ?? null);
	add(block.query.latestBy);
	for (const value of [block.value, block.target, block.figure, block.status, block.chips, block.trend?.over ?? null])
		add(value);
	for (const value of [block.chart?.x, block.chart?.y, block.chart?.by, block.chart?.target]) add(value ?? null);
	addText(block.title);
	addText(block.line);
	addText(block.sub);
	for (const column of block.columns) if (!Object.hasOwn(block.lookups, column)) out.add(column);
	for (const column of block.fields) out.add(column);
	return [...out];
}

function isOpenTarget(target: string): boolean {
	if (target === "row") return true;
	if (target.startsWith("agent:")) return /^\{[a-z][a-z0-9_]*\}$/.test(target.slice(6)) || UUID.test(target.slice(6));
	if (target.startsWith("interface:")) return isInterfaceName(target.slice(10));
	if (target.startsWith("file:")) return isFolderFilePath(target.slice(5));
	return false;
}

function readBlock(reader: Reader, bag: Bag, path: string): InterfaceBlock | null {
	const kind = reader.choice(bag, "kind", path, INTERFACE_BLOCKS, null, true);
	if (!kind) return null;
	// A table block's lookup columns are keys named after entries of its columns list.
	const lookupKeys =
		kind === "table" && Array.isArray(bag.columns)
			? bag.columns.filter(
					(c): c is string => typeof c === "string" && COLUMN.test(c) && !RESERVED_BLOCK_KEYS.has(c),
				)
			: [];
	reader.keys(bag, path, [...COMMON_BLOCK_KEYS, ...BLOCK_KEYS[kind], ...lookupKeys]);
	const id = reader.text(bag, "id", path, { max: 40 });
	if (id !== null && !ID.test(id))
		reader.add(`${path}.id`, "bad_value", "A block's id uses lowercase letters, digits and hyphens.");
	const title = reader.text(bag, "title", path, { max: 60 });
	if (title !== null && interfaceTemplateColumns(title) === null)
		reader.add(`${path}.title`, "bad_value", "A {column} in the title is not closed or not a column name.");
	const width = reader.choice(bag, "width", path, INTERFACE_WIDTHS, "full") ?? "full";
	const query = readQuery(reader, bag, path);
	const buttons = reader.list(bag, "buttons", path, { max: 12, what: "a button id", item: (b) => ID.test(b) });

	// from: one source, or a list for a calendar; a board's parts and an inline text block name none.
	let from: string[] = [];
	if (bag.from !== undefined) {
		if (kind === "calendar")
			from = reader.list(bag, "from", path, { max: 6, what: "a source", item: (s) => s.length <= 600 });
		else {
			const one = reader.text(bag, "from", path, { max: 600 });
			if (one !== null) from = [one];
		}
		for (const source of from) {
			if (!isInterfaceSource(source))
				reader.add(`${path}.from`, "unknown_source", `"${clip(source)}" is not a source.`);
		}
	}
	const text = kind === "text" ? reader.text(bag, "text", path, { max: 2000, multiline: true }) : null;
	if (kind === "board" && from.length > 0)
		reader.add(`${path}.from`, "unknown_key", "A board's parts name their tables; the board itself takes no from.");
	if (kind !== "board" && from.length === 0 && !(kind === "text" && text !== null)) {
		reader.add(
			`${path}.from`,
			"missing_key",
			kind === "text" ? "A text block needs from or text." : "This block needs from.",
		);
	}
	if (kind === "text" && text !== null && from.length > 0)
		reader.add(`${path}.text`, "unknown_key", "A text block takes from or text, not both.");

	const column = (key: string): string | null => {
		const value = bag[key];
		if (value === undefined) return null;
		if (typeof value === "string" && COLUMN.test(value)) return value;
		reader.add(`${path}.${key}`, "bad_value", `${key} names a column.`);
		return null;
	};
	const template = (key: string, max = 120): string | null => {
		const value = reader.text(bag, key, path, { max });
		if (value !== null && interfaceTemplateColumns(value) === null)
			reader.add(`${path}.${key}`, "bad_value", `A {column} in ${key} is not closed or not a column name.`);
		return value;
	};

	let trend: InterfaceBlock["trend"] = null;
	if (bag.trend !== undefined) {
		if (!isBag(bag.trend))
			reader.add(`${path}.trend`, "bad_value", 'trend is an inline table, like { over = "at", weeks = 12 }.');
		else {
			reader.keys(bag.trend, `${path}.trend`, ["over", "weeks"]);
			const over = typeof bag.trend.over === "string" && COLUMN.test(bag.trend.over) ? bag.trend.over : null;
			const weeks = reader.whole(bag.trend, "weeks", `${path}.trend`, 1, 104) ?? 12;
			if (!over) reader.add(`${path}.trend.over`, "missing_key", "trend.over names the time column.");
			else trend = { over, weeks };
		}
	}

	let chart: InterfaceBlock["chart"] = null;
	if (kind === "chart") chart = readChart(reader, bag, path, true);
	if (kind === "detail" && bag.chart !== undefined) {
		if (!isBag(bag.chart))
			reader.add(`${path}.chart`, "bad_value", 'chart is an inline table, like { x = "at", y = "value" }.');
		else chart = readChart(reader, bag.chart, `${path}.chart`, false);
	}

	// Own keys only: a column named like an object built-in is never taken for a lookup.
	const lookups: Record<string, InterfaceLookup> = Object.create(null);
	let columns: string[] = [];
	if (kind === "table") {
		columns = reader.list(bag, "columns", path, { max: 24, what: "a column name", item: (c) => COLUMN.test(c) });
		for (const name of columns) {
			if (RESERVED_BLOCK_KEYS.has(name)) continue;
			const spec = Object.hasOwn(bag, name) ? bag[name] : undefined;
			if (spec === undefined) continue;
			if (!isBag(spec)) {
				reader.add(
					`${path}.${name}`,
					"bad_value",
					`${clip(name)} is a lookup: { from = "table:<t>", match = "<column>", show = "<column>" }.`,
				);
				continue;
			}
			reader.keys(spec, `${path}.${name}`, ["from", "match", "show", "count"]);
			const lookFrom =
				typeof spec.from === "string" && spec.from.startsWith("table:") && isInterfaceName(spec.from.slice(6))
					? spec.from
					: null;
			const match = typeof spec.match === "string" && COLUMN.test(spec.match) ? spec.match : null;
			const show =
				spec.show === undefined
					? null
					: typeof spec.show === "string" && COLUMN.test(spec.show)
						? spec.show
						: undefined;
			const count = spec.count === true;
			if (!lookFrom || !match || show === undefined || (show === null) === !count) {
				reader.add(
					`${path}.${name}`,
					"bad_value",
					`${clip(name)} needs from = "table:<t>", match, and either show or count = true.`,
				);
				continue;
			}
			lookups[name] = { from: lookFrom, match, show, count };
		}
	}

	const parts: InterfaceBoardPart[] = [];
	if (kind === "board") {
		const partBags = reader.tables(bag, "part", path, 1, 4);
		partBags.forEach((pb, n) => {
			const at = `${path}.part.${n}`;
			reader.keys(pb, at, ["title", "from", "card", "opens"]);
			const partFrom = reader.text(pb, "from", at, { required: true, max: 70 });
			if (partFrom !== null && !(partFrom.startsWith("table:") && isInterfaceName(partFrom.slice(6)))) {
				reader.add(`${at}.from`, "unknown_source", 'A board part reads a table: "table:<name>".');
			}
			const card = isBag(pb.card) ? pb.card : null;
			if (!card) reader.add(`${at}.card`, "missing_key", 'A board part needs card = { title = "{column}" }.');
			else reader.keys(card, `${at}.card`, ["title", "line", "figures", "note"]);
			const cardText = (key: string): string | null => {
				const value = card?.[key];
				if (value === undefined) return null;
				if (
					typeof value !== "string" ||
					value.length > 120 ||
					NOT_ONE_LINE.test(value) ||
					BIDI.test(value) ||
					interfaceTemplateColumns(value) === null
				) {
					reader.add(`${at}.card.${key}`, "bad_value", `card.${key} is a short text with {column} names.`);
					return null;
				}
				return value;
			};
			const cardTitle = cardText("title");
			if (card && card.title === undefined)
				reader.add(`${at}.card.title`, "missing_key", 'A board card needs a title, like title = "{column}".');
			const figures =
				card?.figures === undefined
					? null
					: typeof card.figures === "string" && COLUMN.test(card.figures)
						? card.figures
						: null;
			if (card?.figures !== undefined && figures === null)
				reader.add(`${at}.card.figures`, "bad_value", "card.figures names an agents column.");
			const opens = reader.text(pb, "opens", at, { max: 40 });
			if (partFrom !== null && cardTitle !== null) {
				parts.push({
					title: reader.text(pb, "title", at, { max: 60 }),
					from: partFrom,
					card: { title: cardTitle, line: cardText("line"), figures, note: cardText("note") },
					opens,
				});
			}
		});
	}

	return {
		kind,
		id,
		title,
		from,
		width,
		query,
		buttons,
		opens:
			kind === "numbers" || kind === "list" || kind === "table"
				? reader.text(bag, "opens", path, { max: 40 })
				: null,
		show: kind === "text" ? reader.choice(bag, "show", path, ["all", "first-paragraph"] as const, null) : null,
		text,
		value: kind === "numbers" ? column("value") : null,
		target: kind === "numbers" ? column("target") : null,
		trend,
		chart,
		line: kind === "list" ? template("line") : null,
		sub: kind === "list" ? template("sub") : null,
		figure: kind === "list" ? column("figure") : null,
		status: kind === "list" ? column("status") : null,
		chips: kind === "list" ? column("chips") : null,
		layout:
			kind === "list" ? (reader.choice(bag, "layout", path, ["rows", "cards"] as const, "rows") ?? "rows") : "rows",
		columns,
		lookups,
		fields:
			kind === "detail" || kind === "form"
				? reader.list(bag, "fields", path, { max: 40, what: "a column name", item: (f) => COLUMN.test(f) })
				: [],
		lanes: kind === "board" ? (bag.lanes === undefined ? "members" : column("lanes")) : null,
		shared: kind === "board" ? column("shared") : null,
		openPile: kind === "board" ? reader.bool(bag, "open_pile", path, false) : false,
		parts,
		days: kind === "calendar" ? reader.whole(bag, "days", path, 1, 60) : null,
	};
}

function readChart(reader: Reader, bag: Bag, path: string, top: boolean): InterfaceBlock["chart"] {
	if (!top) reader.keys(bag, path, ["x", "y", "target", "weeks"]);
	const col = (key: string, required: boolean): string | null => {
		const value = bag[key];
		if (value === undefined) {
			if (required) reader.add(`${path}.${key}`, "missing_key", `A chart needs ${key}.`);
			return null;
		}
		if (typeof value === "string" && COLUMN.test(value)) return value;
		reader.add(`${path}.${key}`, "bad_value", `${key} names a column.`);
		return null;
	};
	const x = col("x", true);
	const y = col("y", false);
	const sum = top ? bag.sum : undefined;
	const count = top ? bag.count : undefined;
	let total: "sum" | "count" | null = null;
	if (sum !== undefined && count !== undefined)
		reader.add(`${path}.sum`, "bad_value", "A chart takes sum or count, not both.");
	else if (sum !== undefined) {
		if (sum === true) total = "sum";
		else reader.add(`${path}.sum`, "bad_value", "sum is true.");
	} else if (count !== undefined) {
		if (count === true) total = "count";
		else reader.add(`${path}.count`, "bad_value", "count is true.");
	}
	if (y === null && total !== "count")
		reader.add(`${path}.y`, "missing_key", "A chart needs y, unless it counts rows.");
	const every = top ? reader.choice(bag, "every", path, ["day", "week", "month"] as const, null) : null;
	if (total !== null && every === null)
		reader.add(`${path}.every`, "missing_key", "A chart that sums or counts needs every = day, week or month.");
	if (x === null) return null;
	return {
		type: top ? (reader.choice(bag, "type", path, ["line", "bar"] as const, "line") ?? "line") : "line",
		x,
		y,
		by: top ? col("by", false) : null,
		every,
		total,
		target: col("target", false),
		weeks: reader.whole(bag, "weeks", path, 1, 104),
	};
}

/* ---------------- tables ---------------- */

const TABLE_KEYS = ["id", "name", "about", "rows", "key", "holder", "time"];
const COLUMN_KEYS = ["name", "type", "optional", "needs_yes", "max", "choices", "currency", "to"];

export function parseTableFile(text: string): InterfaceParseResult<TableFile> {
	const read = readToml(text, TABLE_FILE_MAX_BYTES);
	if (Array.isArray(read)) return { ok: false, file: null, problems: read };
	const { bag, reader } = read;
	reader.keys(bag, "", ["format", "table", "column", "write"]);
	if (bag.format !== TABLE_FORMAT) reader.add("format", "format", `format must be "${TABLE_FORMAT}".`);
	const head = reader.table(bag, "table", "", true) ?? {};
	reader.keys(head, "table", TABLE_KEYS);
	const id = reader.text(head, "id", "table", { required: true, max: 36 });
	if (id !== null && !UUID.test(id)) reader.add("table.id", "bad_value", "table.id must be a lowercase uuid.");
	const name = reader.text(head, "name", "table", { required: true, max: 60 });
	const about = reader.text(head, "about", "table", { max: 280 });
	const rows = head.rows;
	if (rows === undefined) reader.add("table.rows", "missing_key", 'table.rows is required: "file".');
	else if (rows === "store")
		reader.add("table.rows", "bad_value", 'rows = "store" waits for the table store; use "file".');
	else if (rows !== "file") reader.add("table.rows", "bad_value", 'table.rows is "file".');

	const columns: TableColumn[] = [];
	const names = new Set<string>();
	reader.tables(bag, "column", "", 1, 40).forEach((cb, n) => {
		const path = `column.${n}`;
		reader.keys(cb, path, COLUMN_KEYS);
		const columnName = reader.text(cb, "name", path, { required: true, max: 40 });
		if (columnName !== null && !COLUMN.test(columnName))
			reader.add(
				`${path}.name`,
				"bad_value",
				"A column's name starts with a letter, then lowercase letters, digits and _.",
			);
		if (columnName !== null && names.has(columnName))
			reader.add(`${path}.name`, "duplicate", `Two columns are called "${columnName}".`);
		if (columnName !== null) names.add(columnName);
		const type = reader.choice(cb, "type", path, TABLE_COLUMN_TYPES, null, true);
		const optional = reader.bool(cb, "optional", path, false);
		const needsYes = reader.bool(cb, "needs_yes", path, false);
		if (needsYes && type !== "member")
			reader.add(`${path}.needs_yes`, "bad_value", "needs_yes is for member columns.");
		const max = cb.max === undefined ? null : reader.whole(cb, "max", path, 1, 4000);
		if (cb.max !== undefined && type !== "text") reader.add(`${path}.max`, "unknown_key", "max is for text columns.");
		let choices: string[] = [];
		if (type === "choice") {
			choices = reader.list(cb, "choices", path, {
				max: 50,
				what: "a short choice",
				item: (c) =>
					c.length > 0 && c.length <= 60 && !NOT_ONE_LINE.test(c) && !c.includes(",") && !c.includes('"'),
			});
			if (choices.length === 0) reader.add(`${path}.choices`, "missing_key", "A choice column needs 1–50 choices.");
		} else if (cb.choices !== undefined)
			reader.add(`${path}.choices`, "unknown_key", "choices is for choice columns.");
		let currency: string | null = null;
		if (type === "money") {
			currency = reader.text(cb, "currency", path, { required: true, max: 3 });
			if (currency !== null && !CURRENCY.test(currency))
				reader.add(`${path}.currency`, "bad_value", 'currency is a code like "EUR" or "DKK".');
		} else if (cb.currency !== undefined)
			reader.add(`${path}.currency`, "unknown_key", "currency is for money columns.");
		let to: string | null = null;
		if (type === "link") {
			to = reader.text(cb, "to", path, { required: true, max: 70 });
			if (
				to !== null &&
				!(
					to === "todos" ||
					to === "contacts" ||
					to === "human_tasks" ||
					(to.startsWith("table:") && isInterfaceName(to.slice(6)))
				)
			) {
				reader.add(`${path}.to`, "bad_value", 'to is "table:<name>", "todos", "contacts" or "human_tasks".');
			}
		} else if (cb.to !== undefined) reader.add(`${path}.to`, "unknown_key", "to is for link columns.");
		if (columnName !== null && type !== null) {
			columns.push({
				name: columnName,
				type,
				optional,
				needsYes,
				max: type === "text" ? (max ?? 500) : null,
				choices,
				currency,
				to,
			});
		}
	});

	const byName = new Map(columns.map((c) => [c.name, c]));
	const key = reader.list(head, "key", "table", { max: 3, what: "a column name", item: (k) => COLUMN.test(k) });
	if (key.length === 0) reader.add("table.key", "missing_key", "table.key names 1–3 columns that make a row unique.");
	for (const k of key) {
		const c = byName.get(k);
		if (!c) reader.add("table.key", "unknown_column", `table.key names "${clip(k)}", which is not a column.`);
		else if (c.optional) reader.add("table.key", "bad_value", `The key column "${k}" can't be optional.`);
	}
	const holder = reader.text(head, "holder", "table", { max: 40 });
	if (holder !== null && !byName.get(holder)?.needsYes)
		reader.add("table.holder", "bad_value", "table.holder names a member column with needs_yes = true.");
	const time = reader.text(head, "time", "table", { max: 40 });
	if (time !== null && !["time", "date"].includes(byName.get(time)?.type ?? ""))
		reader.add("table.time", "bad_value", "table.time names a time or date column.");

	const write = { agents: "all" as TableFile["write"]["agents"], members: "all" as TableFile["write"]["members"] };
	const wb = reader.table(bag, "write", "", false);
	if (wb) {
		reader.keys(wb, "write", ["agents", "members"]);
		if (wb.agents !== undefined) {
			if (wb.agents === "all" || wb.agents === "none") write.agents = wb.agents;
			else if (typeof wb.agents === "string")
				reader.add("write.agents", "bad_value", 'write.agents is "all", "none" or a list of agent ids.');
			else {
				write.agents = reader.list(wb, "agents", "write", {
					max: 100,
					what: "a lowercase uuid",
					item: (item) => UUID.test(item),
				});
				if (Array.isArray(wb.agents) && wb.agents.length === 0)
					reader.add("write.agents", "bad_value", 'write.agents lists at least one id; use "none" for no agent.');
			}
		}
		write.members = reader.choice(wb, "members", "write", ["all", "owners", "none"] as const, "all") ?? "all";
	}

	return done(reader, {
		kind: "table",
		id: id ?? "",
		name: name ?? "",
		about,
		rows: "file",
		key,
		holder,
		time,
		columns,
		write,
	});
}

/* ---------------- interfaces/order.md ---------------- */

export function parseInterfaceOrderFile(text: string): InterfaceParseResult<InterfaceOrderFile> {
	if (encoder.encode(text).length > INTERFACE_ORDER_MAX_BYTES) {
		return { ok: false, file: null, problems: [problem(null, null, "too_large", "order.md is larger than 16 KiB.")] };
	}
	if (LONE_SURROGATE.test(text)) {
		return { ok: false, file: null, problems: [problem(null, null, "encoding", "order.md must be UTF-8 text.")] };
	}
	// A leading byte order mark carries nothing, as in the state files.
	const body = text.startsWith("\ufeff") ? text.slice(1) : text;
	const problems: InterfaceProblem[] = [];
	const ids: string[] = [];
	const seen = new Set<string>();
	body.split("\n").forEach((raw, i) => {
		const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
		if (line.trim() === "") return;
		const match = /^- ([^ ]+)(?: [^\u0000-\u001f]*)?$/.exec(line.length <= 400 ? line : "");
		if (match?.[1] && !UUID.test(match[1])) match[1] = "";
		if (!match?.[1]) {
			problems.push(problem(i + 1, null, "bad_value", 'Each line is "- <id>", optionally followed by a name.'));
			return;
		}
		if (seen.has(match[1])) {
			problems.push(problem(i + 1, null, "duplicate", "This interface is listed twice."));
			return;
		}
		seen.add(match[1]);
		ids.push(match[1]);
	});
	if (problems.length > 0) return { ok: false, file: null, problems: withMore(problems) };
	return { ok: true, file: { kind: "interface-order", ids }, problems: [] };
}

export function writeInterfaceOrderFile(ids: readonly string[], names?: ReadonlyMap<string, string>): string {
	return ids
		.map((id) => {
			const name = names?.get(id);
			const clean = name
				? Array.from(
						name
							.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, " ")
							.replace(new RegExp(LONE_SURROGATE.source, "g"), "")
							.trim(),
					)
						.slice(0, 120)
						.join("")
				: "";
			return clean ? `- ${id} ${clean}` : `- ${id}`;
		})
		.join("\n")
		.concat(ids.length > 0 ? "\n" : "");
}

/* ---------------- CSV rows ---------------- */

export type TableValue = string | number | boolean | readonly string[] | null;
export type TableRow = Readonly<Record<string, TableValue>>;

export interface TableRowsResult {
	/** The rows that fit, typed. A time is kept as its canonical text; compare with `interfaceInstant`. */
	readonly rows: readonly TableRow[];
	/** One problem per row that doesn't fit (it is left out), plus header and size problems. A save is refused when
	 * there is any; a reader shows the rows that fit and the problems. */
	readonly problems: readonly InterfaceProblem[];
	/** False when the file can't be read at all: a wrong header, too large, or not UTF-8. */
	readonly readable: boolean;
}

/** Splits RFC 4180 CSV into records, linear in the input. Each record carries the line it starts on. */
export function splitCsv(text: string): {
	records: { line: number; fields: string[] }[];
	error: { line: number; message: string } | null;
} {
	const records: { line: number; fields: string[] }[] = [];
	let fields: string[] = [];
	let field = "";
	let line = 1;
	let start = 1;
	let quoted = false;
	let wasQuoted = false;
	let i = 0;
	const n = text.length;
	while (i < n) {
		const ch = text[i];
		if (quoted) {
			if (ch === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i += 2;
					continue;
				}
				quoted = false;
				i++;
				continue;
			}
			if (ch === "\n") line++;
			field += ch;
			i++;
			continue;
		}
		if (ch === '"') {
			if (field.length > 0 || wasQuoted)
				return { records, error: { line, message: "A quote opens in the middle of a field." } };
			quoted = true;
			wasQuoted = true;
			i++;
			continue;
		}
		if (ch === ",") {
			fields.push(field);
			field = "";
			wasQuoted = false;
			i++;
			continue;
		}
		if (ch === "\r") {
			if (text[i + 1] !== "\n")
				return { records, error: { line, message: "A line ends with a lone carriage return." } };
			i++;
			continue;
		}
		if (ch === "\n") {
			fields.push(field);
			records.push({ line: start, fields });
			fields = [];
			field = "";
			wasQuoted = false;
			line++;
			start = line;
			i++;
			continue;
		}
		if (wasQuoted) return { records, error: { line, message: "Text follows a closing quote." } };
		field += ch;
		i++;
	}
	if (quoted) return { records, error: { line: start, message: "A quoted field never closes." } };
	if (field.length > 0 || fields.length > 0 || wasQuoted) {
		fields.push(field);
		records.push({ line: start, fields });
	}
	return { records, error: null };
}

const NUMBER_TEXT = /^-?(?:0|[1-9][0-9]{0,14})(?:\.[0-9]{1,8})?$/;
const DATE_TEXT = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_TEXT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?Z$/;

/** A time's epoch milliseconds, or null; accepts the CSV's `…T09:44Z` and `…T09:44:10Z`. */
export function interfaceInstant(text: string): number | null {
	const m = TIME_TEXT.exec(text) ?? (DATE_TEXT.test(text) ? DATE_TEXT.exec(text) : null);
	if (!m) return null;
	const [y, mo, d, h = "0", mi = "0", s = "0"] = m.slice(1);
	const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
	const back = new Date(ms);
	if (back.getUTCFullYear() !== Number(y) || back.getUTCMonth() !== Number(mo) - 1 || back.getUTCDate() !== Number(d))
		return null;
	if (Number(h) > 23 || Number(mi) > 59 || Number(s) > 59) return null;
	return ms;
}

function typedValue(column: TableColumn, raw: string): { value: TableValue } | { problem: string } {
	if (raw === "") return column.optional ? { value: null } : { problem: `${column.name} is empty` };
	switch (column.type) {
		case "text":
			if ([...raw].length > (column.max ?? 500))
				return { problem: `${column.name} is longer than ${column.max ?? 500} characters` };
			if (LONE_SURROGATE.test(raw) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(raw))
				return { problem: `${column.name} holds a control character` };
			return { value: raw };
		case "number":
		case "money":
		case "percent":
			return raw.length <= 30 && NUMBER_TEXT.test(raw)
				? { value: Number(raw) }
				: { problem: `${column.name} is not a number` };
		case "time":
			// One canonical form, seconds always, so two spellings of one time are one key.
			return raw.length <= 25 && TIME_TEXT.test(raw) && interfaceInstant(raw) !== null
				? { value: raw.length === 17 ? `${raw.slice(0, 16)}:00Z` : raw }
				: { problem: `${column.name} is not a time like 2026-10-02T09:44Z` };
		case "date":
			return raw.length === 10 && interfaceInstant(raw) !== null
				? { value: raw }
				: { problem: `${column.name} is not a date like 2026-10-02` };
		case "choice":
			return column.choices.includes(raw) ? { value: raw } : { problem: `${column.name} is not one of its choices` };
		case "yes-no":
			return raw === "yes"
				? { value: true }
				: raw === "no"
					? { value: false }
					: { problem: `${column.name} is yes or no` };
		case "member":
		case "agent":
		case "id":
			return UUID.test(raw) ? { value: raw } : { problem: `${column.name} is not an id` };
		case "agents": {
			const ids = raw.split(" ");
			return ids.length <= 50 && ids.every((id) => UUID.test(id)) && new Set(ids).size === ids.length
				? { value: ids }
				: { problem: `${column.name} is not a list of agent ids` };
		}
		case "link":
			return raw.length <= 200 && !NOT_ONE_LINE.test(raw)
				? { value: raw }
				: { problem: `${column.name} is not a row key` };
	}
}

/** Reads a table's rows against its definition (RUNTIME-INTERFACES.md §5). Rows that don't fit are left out with a
 * problem each; `readable` is false when the whole file must be refused (the header doesn't match, it is too large,
 * or it isn't UTF-8). The save check refuses a rows file with any problem. */
export function parseTableRows(table: TableFile, text: string): TableRowsResult {
	const fail = (p: InterfaceProblem): TableRowsResult => ({ rows: [], problems: [p], readable: false });
	if (encoder.encode(text).length > TABLE_ROWS_MAX_BYTES) {
		return fail(
			problem(null, null, "too_large", "The rows are larger than 64 KiB; a bigger table waits for the table store."),
		);
	}
	// Spreadsheet exports start CSV with a byte order mark; it carries nothing, so it is ignored.
	const body = text.startsWith("\ufeff") ? text.slice(1) : text;
	if (LONE_SURROGATE.test(body)) return fail(problem(null, null, "encoding", "The rows must be UTF-8 text."));
	const { records, error } = splitCsv(body);
	if (error) return fail(problem(error.line, null, "row", error.message));
	const header = records[0];
	const byName = new Map(table.columns.map((c) => [c.name, c]));
	const named = header?.fields ?? [];
	const headerProblem = ((): string | null => {
		if (!header) return `The first line names the columns: ${table.columns.map((c) => c.name).join(",")}`;
		const seen = new Set<string>();
		for (const name of named) {
			if (!byName.has(name)) return `The first line names "${clip(name)}", which is not a column of this table.`;
			if (seen.has(name)) return `The first line names "${clip(name)}" twice.`;
			seen.add(name);
		}
		const missing = table.columns.filter((c) => !c.optional && !seen.has(c.name)).map((c) => c.name);
		return missing.length > 0 ? `The first line leaves out ${missing.join(", ")}, which every row needs.` : null;
	})();
	if (headerProblem) return fail(problem(1, null, "row", headerProblem));
	const rows: TableRow[] = [];
	const problems: InterfaceProblem[] = [];
	const keys = new Set<string>();
	const note = (p: InterfaceProblem) => problems.push(p);
	for (const record of records.slice(1)) {
		if (record.fields.length === 1 && record.fields[0] === "") continue;
		if (record.fields.length !== named.length) {
			note(problem(record.line, null, "row", `This row has ${record.fields.length} fields, not ${named.length}.`));
			continue;
		}
		const row: Record<string, TableValue> = {};
		let bad: string | null = null;
		for (const column of table.columns) {
			const at = named.indexOf(column.name);
			const out = typedValue(column, at < 0 ? "" : (record.fields[at] ?? ""));
			if ("problem" in out) {
				bad = out.problem;
				break;
			}
			row[column.name] = out.value;
		}
		if (bad) {
			note(problem(record.line, null, "row", `This row doesn't fit: ${bad}.`));
			continue;
		}
		const key = JSON.stringify(table.key.map((k) => row[k] ?? null));
		if (keys.has(key)) {
			note(problem(record.line, null, "duplicate", "Another row has the same key."));
			continue;
		}
		keys.add(key);
		rows.push(row);
	}
	return { rows, problems: withMore(problems), readable: true };
}

function csvField(value: TableValue): string {
	if (value === null) return "";
	const text =
		typeof value === "boolean" ? (value ? "yes" : "no") : Array.isArray(value) ? value.join(" ") : String(value);
	return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Writes rows in the table's column order, with the header line; LF line ends. */
export function writeTableRows(table: TableFile, rows: readonly TableRow[]): string {
	const lines = [table.columns.map((c) => c.name).join(",")];
	for (const row of rows) lines.push(table.columns.map((c) => csvField(row[c.name] ?? null)).join(","));
	return `${lines.join("\n")}\n`;
}

/* ---------------- the folder hook's entry point (P16) ---------------- */

/** A rows file as the folder hook stores its parse: the header and each row's raw fields, before any definition. The
 * save check types them against the table's definition as it is at commit (RUNTIME-INTERFACES.md §6.1). */
export interface TableRowsFile {
	readonly kind: "table-rows";
	/** The column names the first line gives, in its order. */
	readonly header: readonly string[];
	/** Each row's fields as written, in the header's order, with the line the row starts on. Blank lines are left out. */
	readonly rows: readonly { readonly line: number; readonly fields: readonly string[] }[];
}

export type InterfaceStateFile = InterfaceFile | InterfaceOrderFile | TableFile | TableRowsFile;

/** Where an interface file sits, in the shape of the state files' `CompanyStatePath`. */
export interface InterfaceStateFilePath {
	readonly kind: InterfaceStatePathKind;
	readonly agent: null;
	readonly group: null;
	/** The interface's folder name or the table's name, as its key; null for `interfaces/order.md`. */
	readonly name: string | null;
	readonly todo: null;
	readonly worker: null;
}

export type InterfaceStateFileResult =
	| { readonly ok: true; readonly path: InterfaceStateFilePath; readonly file: InterfaceStateFile }
	| { readonly ok: false; readonly path: InterfaceStateFilePath; readonly problems: readonly InterfaceProblem[] };

/** The column names a rows file's first line may give: the definition's own rule. */
const TABLE_ROWS_MAX_COLUMNS = 40;

/** Reads a rows file without its definition: the size, the encoding, the CSV, a header of unique column names, and
 * rows of the header's width. What the values mean is the save check's, against the definition at commit. */
export function parseTableRowsText(text: string): InterfaceParseResult<TableRowsFile> {
	const refused = (problems: InterfaceProblem[]) => ({ ok: false as const, file: null, problems: withMore(problems) });
	if (encoder.encode(text).length > TABLE_ROWS_MAX_BYTES)
		return refused([
			problem(null, null, "too_large", "The rows are larger than 64 KiB; a bigger table waits for the table store."),
		]);
	const body = text.startsWith("\ufeff") ? text.slice(1) : text;
	if (LONE_SURROGATE.test(body) || body.includes("\u0000"))
		return refused([problem(null, null, "encoding", "The rows must be UTF-8 text.")]);
	const { records, error } = splitCsv(body);
	if (error) return refused([problem(error.line, null, "row", error.message)]);
	const header = records[0]?.fields ?? [];
	if (header.length === 0 || (header.length === 1 && header[0] === ""))
		return refused([problem(1, null, "row", "The first line names the columns.")]);
	if (header.length > TABLE_ROWS_MAX_COLUMNS)
		return refused([
			problem(1, null, "too_large", `The first line names more than ${TABLE_ROWS_MAX_COLUMNS} columns.`),
		]);
	const seen = new Set<string>();
	for (const name of header) {
		if (!COLUMN.test(name) || name.length > 40)
			return refused([
				problem(1, null, "row", `The first line names "${shown(name)}", which is not a column name.`),
			]);
		if (seen.has(name)) return refused([problem(1, null, "row", `The first line names "${shown(name)}" twice.`)]);
		seen.add(name);
	}
	const problems: InterfaceProblem[] = [];
	const rows: { line: number; fields: string[] }[] = [];
	for (const record of records.slice(1)) {
		if (record.fields.length === 1 && record.fields[0] === "") continue;
		if (record.fields.length !== header.length) {
			problems.push(
				problem(record.line, null, "row", `This row has ${record.fields.length} fields, not ${header.length}.`),
			);
			continue;
		}
		rows.push({ line: record.line, fields: record.fields });
	}
	if (problems.length) return refused(problems);
	return { ok: true, file: { kind: "table-rows", header, rows }, problems: [] };
}

/** An interface file's kind, decided on the path's shape like the state files: a badly named folder is still this
 * kind, and its name is one of the parse's problems, so no interface or table file is ever saved unchecked. */
function interfaceStateShape(path: string): InterfaceStateFilePath | null {
	const parts = companyPathKey(path).split("/");
	const at = (kind: InterfaceStatePathKind, name: string | null): InterfaceStateFilePath => ({
		kind,
		agent: null,
		group: null,
		name,
		todo: null,
		worker: null,
	});
	if (parts.length === 2 && parts[0] === "interfaces" && parts[1] === "order.md") return at("interface-order", null);
	if (parts.length !== 3) return null;
	const name = parts[1] ?? "";
	if (parts[0] === "interfaces" && parts[2] === "interface.toml") return at("interface", name);
	if (parts[0] === "tables" && parts[2] === "table.toml") return at("table", name);
	if (parts[0] === "tables" && parts[2] === "rows.csv") return at("table-rows", name);
	return null;
}

/**
 * The folder hook's one call for interface files (RUNTIME-INTERFACES.md §2, §6; F2's P16): the result of
 * `parseCompanyStateFile`'s shape for `interfaces/order.md`, `interfaces/<name>/interface.toml`,
 * `tables/<name>/table.toml` and `tables/<name>/rows.csv`, and null for every other path. The parse is what the
 * client sends with its unit; the database checks its shape and the rules that need other files (§6.1).
 */
export function parseInterfaceStateFile(path: string, text: string): InterfaceStateFileResult | null {
	const where = interfaceStateShape(path);
	if (!where) return null;
	const parsed: InterfaceParseResult<InterfaceStateFile> =
		where.kind === "interface"
			? parseInterfaceFile(text)
			: where.kind === "interface-order"
				? parseInterfaceOrderFile(text)
				: where.kind === "table"
					? parseTableFile(text)
					: parseTableRowsText(text);
	// A badly named folder is one of the path's problems (`interfacePathProblems` places only good names).
	const problems = [...interfacePathProblems(path), ...parsed.problems];
	if (problems.length || !parsed.ok) return { ok: false, path: where, problems: withMore(problems) };
	return { ok: true, path: where, file: parsed.file };
}

/* ---------------- the claim rule ---------------- */

export type InterfaceActor =
	| { readonly kind: "member"; readonly memberId: string }
	| { readonly kind: "agent"; readonly agentId: string; readonly supervisorId: string | null };

/** An open offer of one row's cell, kept by the platform with its request card. `row` is the row's key as
 * `tableRowKey` writes it; `from` is the member it was made by or for, `was` the cell's value when it was made. */
export interface InterfaceOffer {
	readonly row: string;
	readonly column: string;
	readonly to: string;
	readonly from: string;
	readonly was: string | null;
}

/** The columns of `tables/areas/` that agents never change: who owns an area, who supervises it, its agents. */
export const AREA_MEMBER_ONLY_COLUMNS = Object.freeze(["owner", "supervisor", "agents"] as const);

/** The key a row is matched on across versions of its file. */
export function tableRowKey(table: TableFile, row: TableRow): string {
	return JSON.stringify(table.key.map((k) => (Object.hasOwn(row, k) ? row[k] : null) ?? null));
}

/** The claim rule (RUNTIME-INTERFACES.md §5, contract amendment item 6) for a save that changes a rows file:
 * - take: a member puts their own id in an empty cell;
 * - release: a member clears a cell that names them;
 * - accept: the member an open offer names puts their own id in that cell, while the cell still holds what it held
 *   when the offer was made, and the offer came from that holder (or the cell was empty);
 * - an agent acts for its supervisor, taking for them and releasing what they hold, and never touches the
 *   member-only columns (by default those of `tables/areas/`), needs_yes or not.
 * A removed row counts as clearing its cells. Anything else that changes a needs_yes column is a problem; an offer
 * itself is a request card, never a save. */
export function tableClaimProblems(
	table: TableFile,
	before: readonly TableRow[],
	after: readonly TableRow[],
	actor: InterfaceActor,
	options: {
		/** The table's folder name, always given: `areas` brings its member-only columns. */
		readonly folder: string;
		readonly offers?: readonly InterfaceOffer[];
		readonly memberOnly?: readonly string[];
	},
): InterfaceProblem[] {
	const memberOnly =
		options.memberOnly ?? (companyPathKey(options.folder) === "areas" ? AREA_MEMBER_ONLY_COLUMNS : []);
	const claimed = table.columns.filter((c) => c.needsYes || (actor.kind === "agent" && memberOnly.includes(c.name)));
	if (claimed.length === 0) return [];
	const self = actor.kind === "member" ? actor.memberId : actor.supervisorId;
	const offers = options.offers ?? [];
	const problems: InterfaceProblem[] = [];
	const note = (column: string, message: string) => problems.push(problem(null, column, "claim", message));
	const cell = (row: TableRow | undefined, column: string): TableValue =>
		row && Object.hasOwn(row, column) ? (row[column] ?? null) : null;
	const check = (key: string, column: string, was: TableValue, now: TableValue) => {
		if (JSON.stringify(was) === JSON.stringify(now)) return;
		if (actor.kind === "agent" && memberOnly.includes(column)) {
			note(column, `Only members change ${column}; an agent can offer, never set it.`);
			return;
		}
		if (self === null) {
			note(column, `${column} is only changed for yourself; this agent has no supervisor to act for.`);
			return;
		}
		const take = was === null && now === self;
		const release = now === null && was !== null && was === self;
		const accept =
			now === self &&
			actor.kind === "member" &&
			offers.some(
				(offer) =>
					offer.row === key &&
					offer.column === column &&
					offer.to === self &&
					offer.was === was &&
					(offer.was === null || offer.from === offer.was),
			);
		if (!take && !release && !accept) {
			note(
				column,
				`${column} can only be taken for yourself or let go; giving it to someone else is an offer they say yes to.`,
			);
		}
	};
	const afterRows = new Map(after.map((row) => [tableRowKey(table, row), row]));
	const beforeRows = new Map(before.map((row) => [tableRowKey(table, row), row]));
	for (const [key, row] of afterRows) {
		const previous = beforeRows.get(key);
		for (const column of claimed) check(key, column.name, cell(previous, column.name), cell(row, column.name));
	}
	for (const [key, row] of beforeRows) {
		if (afterRows.has(key)) continue;
		for (const column of claimed) check(key, column.name, cell(row, column.name), null);
	}
	return withMore(problems);
}

/** The claim rule's other half: a definition change may not drop the protection from a cell someone holds. A
 * needs_yes column can lose `needs_yes`, be renamed or be removed only while no row holds anyone in it, so editing
 * `table.toml` never becomes a way to move a held cell. */
export function tableDefinitionProblems(
	before: TableFile,
	after: TableFile,
	rows: readonly TableRow[],
): InterfaceProblem[] {
	const problems: InterfaceProblem[] = [];
	const held = (name: string) =>
		rows.some((row) => Object.hasOwn(row, name) && row[name] !== null && row[name] !== undefined);
	for (const column of before.columns.filter((c) => c.needsYes)) {
		const kept = after.columns.find((c) => c.name === column.name);
		if (kept?.needsYes || !held(column.name)) continue;
		problems.push(
			problem(
				null,
				column.name,
				"claim",
				`${column.name} holds people's claims; it can stop needing a yes only once nobody holds anything in it.`,
			),
		);
	}
	// Turning needs_yes on over names already in the column would make them claims nobody agreed to.
	for (const column of after.columns.filter((c) => c.needsYes)) {
		const was = before.columns.find((c) => c.name === column.name);
		if (was?.needsYes || !held(column.name)) continue;
		problems.push(
			problem(
				null,
				column.name,
				"claim",
				`${column.name} can start needing a yes only while it is empty in every row; clear it first.`,
			),
		);
	}
	return problems;
}
