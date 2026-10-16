/*
 * The Interfaces write tools of a folder-v2 run (RUNTIME-INTERFACES.md §7, step I8b): `save_interface` saves an
 * interface's or a table's settings, a README, or the order of the interfaces, as one change set; `table_write` sets
 * and removes rows of a table. Both write through the folder core with the run's own authority, under the call's
 * receipt, and the folder core's save check (§6.1) decides each unit.
 *
 * - `save_interface` reads what it changes before its review (`prepare`): its card says what changes, never the files,
 *   and its effect class is the database's (migration 20260928469290): creating an interface or a table, a button, an
 *   access, columns or `[write]` is a delegation, which runs only with the review's approval, recorded on the change
 *   set; anything else applies at once.
 * - A refusal says nothing a file holds. Whatever depends on a file is an answer, released with the entries it read
 *   before the model sees it; such answers (a stale version, a blocked file, nothing to save) come before the receipt.
 *   A committed answer is the commit's outcome, unit by unit, with the ids `table_write` made. A file that already
 *   holds the call's text is left out and named as unchanged, which shows nothing the call did not give.
 * - Units go in the order the folder core needs: an interface that stops being main before one that becomes main
 *   (§6.1 rule 3), and a rows file a column leaves before the definition without it (§5).
 * - `table_write` edits the rows file in place: the fields it changes, the rows it adds or removes, and every other
 *   byte as it was.
 * - An agent changes a claim (a needs_yes cell) only for its area's supervisor (§5.1, I9b), named in `tables/areas`:
 *   `table_write` reads them there for a change that touches a claim, and the folder core checks their consent at the
 *   commit.
 * - A replay of a call whose change was saved finds the files or rows holding it and answers that nothing changed (an
 *   id `table_write` made is made again, so it finds its own row and names the id once more); a call that waits for a
 *   review or failed at its commit replays from its receipt.
 */

import { createHash } from "node:crypto";
import {
	csvField,
	INTERFACE_FILE_MAX_BYTES,
	INTERFACE_ORDER_MAX_BYTES,
	type InterfaceFile,
	type InterfaceOrderFile,
	type InterfaceProblem,
	isInterfaceName,
	parseInterfaceFile,
	parseInterfaceOrderFile,
	parseTableFile,
	parseTableRows,
	TABLE_FILE_MAX_BYTES,
	TABLE_ROWS_MAX_BYTES,
	type TableColumn,
	type TableFile,
	type TableRow,
	type TableValue,
	tableClaimProblems,
	tableDefinitionProblems,
	tableFieldValue,
	tableNumberText,
	tableRowKey,
	writeTableRows,
} from "@qorpera/cloud-client/interfaces";
import { type JsonValue, UUID_PATTERN } from "@qorpera/contracts";
import {
	type CloudCompanyFolderClient,
	type CloudCompanyFolderEntry,
	type CloudCompanyFolderUnit,
	type CloudCompanyFolderUnitResult,
	cloudCompanyFolderRelease,
} from "./cloud-company-folder-client.ts";
import {
	args,
	cloudFolderRefusal,
	OPERATION_KEY,
	operationKey,
	released,
	releaseId,
	TOOL_VERSION,
	unavailable,
	version,
} from "./cloud-folder-file-tools.ts";
import { hashedId, invalidMessage } from "./cloud-folder-hiring.ts";
import { type FileRead, problemText, readFile, readTable } from "./cloud-folder-interface-tools.ts";
import type { CloudNativeToolIdentity } from "./cloud-native-tool-authority.ts";
import {
	type CloudNativeTool,
	CloudToolArgumentRefusal,
	type CloudToolContext,
	CloudToolRefusal,
	cloudToolJsonText,
} from "./cloud-native-tool-boundary.ts";
import type { CloudNativeToolOperations } from "./cloud-native-tool-operations.ts";
import type { CloudRuntimeToolOperation } from "./cloud-runtime-observability.ts";
import { fitsOneResult } from "./cloud-worker-tools.ts";

/** At most eight files a save, whose texts together fit the boundary's argument bound with room for the rest. */
const SAVE_FILES = 8;
const SAVE_TEXT_BYTES = 56 * 1024;
const README_MAX_BYTES = 16 * 1024;
/** At most 50 rows set and 50 removed a call, each of at most 40 cells, a list cell of at most 50 items. */
const ROWS_PER_CALL = 50;
const COLUMNS_PER_ROW = 40;
const LIST_ITEMS = 50;
const STRING_CHARS = 4000;
/** The card: at most 12 facts, each cut to its bound, the whole within 6 KiB. */
const CARD_DETAILS = 12;
const CARD_BYTES = 6 * 1024;
const DETAIL_BYTES = 600;
const QUOTE_BYTES = 1200;
/** The problems an answer names, before it says how many more there are. */
const PROBLEMS_SHOWN = 5;
const BOM = String.fromCharCode(0xfeff);
const NUL = String.fromCharCode(0);
/** The namespace of the ids `table_write` makes for a new row's id columns. */
const ROW_ID = "qorpera.table-write-row/v1";
const ORDER_PATH = "interfaces/order.md";
const COLUMN = /^[a-z][a-z0-9_]*$/;

type Kind = "interface" | "table" | "readme" | "order";
type Parsed = InterfaceFile | TableFile | InterfaceOrderFile;

/** Where a saved path is: the kind of file, and the interface's or table's folder it is in (none for the order). */
interface Place {
	readonly kind: Kind;
	readonly of: "interfaces" | "tables" | null;
	readonly name: string | null;
}

interface SaveFile {
	readonly path: string;
	readonly expectedVersion: string | null;
	readonly text: string;
}

const MAX_BYTES: Readonly<Record<Kind, number>> = {
	interface: INTERFACE_FILE_MAX_BYTES,
	table: TABLE_FILE_MAX_BYTES,
	order: INTERFACE_ORDER_MAX_BYTES,
	readme: README_MAX_BYTES,
};

const sha256hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** A value as JSON with its object keys sorted, so two parses compare by what they hold. */
function canonical(value: unknown): string {
	const sorted = (item: unknown): unknown => {
		if (Array.isArray(item)) return item.map(sorted);
		if (item === null || typeof item !== "object") return item;
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(item).sort()) {
			const field = (item as Record<string, unknown>)[key];
			if (field !== undefined) out[key] = sorted(field);
		}
		return out;
	};
	return JSON.stringify(sorted(value)) ?? "null";
}

/** A text as the boundary's plain one-line refusal takes it: curly quotes and dashes straightened, anything else
 * replaced. */
const plain = (text: string): string =>
	text
		.replace(/\s+/g, " ")
		.replace(/[“”]/g, '"')
		.replace(/[‘’]/g, "'")
		.replace(/[–—]/g, "-")
		.replace(/[^\x20-\x7e\xc0-\xff]/g, "?");

/** A text cut to `bytes` UTF-8 bytes, marked when cut. */
function head(text: string, bytes: number): string {
	if (Buffer.byteLength(text) <= bytes) return text;
	let used = 0;
	let end = 0;
	for (const character of text) {
		used += Buffer.byteLength(character);
		if (used > bytes - 3) break;
		end += character.length;
	}
	return `${text.slice(0, end)}...`;
}

/** A name as one line of at most 120 bytes, or the fallback. */
function named(value: unknown, fallback: string): string {
	return typeof value === "string" && value.trim() ? head(value.replace(/\s+/g, " ").trim(), 120) : fallback;
}

/** The answer `render` gives with as many problems (up to five) and then items as fit one tool result. */
function fitted(render: (problems: number, items: number) => string, problems: number, items: number): string {
	for (let shown = Math.min(problems, PROBLEMS_SHOWN); shown >= 0; shown--) {
		const text = render(shown, items);
		if (fitsOneResult(text)) return text;
	}
	for (let shown = items - 1; shown >= 0; shown--) {
		const text = render(0, shown);
		if (fitsOneResult(text)) return text;
	}
	return render(0, 0);
}

const mediaTypeOf = (path: string): string =>
	path.endsWith(".csv") ? "text/csv" : path.endsWith(".toml") ? "application/toml" : "text/markdown";

/** One record of a rows file: its fields, each field's text as written, and the line end after it. */
interface RawRecord {
	readonly fields: string[];
	readonly raw: string[];
	readonly end: string;
}

/** The records of a rows file's text, as the shared reader splits them (`splitCsv`), with every byte kept: only called
 * on a text that reader read. */
function rawRecords(body: string): RawRecord[] {
	const records: RawRecord[] = [];
	let fields: string[] = [];
	let raw: string[] = [];
	let field = "";
	let start = 0;
	let quoted = false;
	let wasQuoted = false;
	let i = 0;
	while (i < body.length) {
		const ch = body[i];
		if (quoted) {
			if (ch === '"' && body[i + 1] === '"') {
				field += '"';
				i += 2;
				continue;
			}
			if (ch === '"') quoted = false;
			else field += ch;
			i++;
			continue;
		}
		if (ch === '"') {
			quoted = true;
			wasQuoted = true;
			i++;
			continue;
		}
		if (ch === ",") {
			fields.push(field);
			raw.push(body.slice(start, i));
			field = "";
			wasQuoted = false;
			i++;
			start = i;
			continue;
		}
		if (ch === "\n" || (ch === "\r" && body[i + 1] === "\n")) {
			const end = ch === "\n" ? "\n" : "\r\n";
			fields.push(field);
			raw.push(body.slice(start, i));
			records.push({ fields, raw, end });
			fields = [];
			raw = [];
			field = "";
			wasQuoted = false;
			i += end.length;
			start = i;
			continue;
		}
		field += ch;
		i++;
	}
	if (field.length > 0 || fields.length > 0 || wasQuoted) {
		fields.push(field);
		raw.push(body.slice(start));
		records.push({ fields, raw, end: "" });
	}
	return records;
}

const isBlank = (record: RawRecord): boolean => record.fields.length === 1 && record.fields[0] === "";

/** Where a path a save names is, or a refusal that says which paths it takes. */
function place(path: string): Place {
	if (path === ORDER_PATH) return { kind: "order", of: null, name: null };
	const parts = path.split("/");
	const [of, name, file] = parts;
	if (parts.length === 3 && (of === "interfaces" || of === "tables") && name && file && isInterfaceName(name)) {
		if (of === "tables" && file.toLowerCase() === "rows.csv")
			throw new CloudToolArgumentRefusal("A table's rows are written with table_write, not save_interface");
		if (of === "interfaces" && file === "interface.toml") return { kind: "interface", of, name };
		if (of === "tables" && file === "table.toml") return { kind: "table", of, name };
		if (file === "README.md" || file === "readme.md") return { kind: "readme", of, name };
	}
	throw new CloudToolArgumentRefusal(
		"each path is interfaces/<name>/interface.toml, tables/<name>/table.toml, a README.md in either folder, or interfaces/order.md; <name> is lowercase letters, digits and single hyphens",
	);
}

type Parse = { ok: true; file: Parsed | null } | { ok: false; problems: InterfaceProblem[] };

/** A structured file's parse, or null for a README. */
function parse(kind: Kind, text: string): Parse {
	if (kind === "readme") return { ok: true, file: null };
	const result =
		kind === "interface"
			? parseInterfaceFile(text)
			: kind === "table"
				? parseTableFile(text)
				: parseInterfaceOrderFile(text);
	return result.ok ? { ok: true, file: result.file } : { ok: false, problems: [...result.problems] };
}

/** A save's arguments: its files, each placed and parsed, refused whole when one cannot be saved. */
function parseSave(value: JsonValue): { operationKey: string; files: SaveFile[] } {
	const request = args(value, "save_interface", ["operationKey", "files"]);
	const key = operationKey(request.operationKey);
	const list = request.files;
	if (!Array.isArray(list) || list.length === 0 || list.length > SAVE_FILES)
		throw new CloudToolArgumentRefusal(`files must be a list of 1 to ${SAVE_FILES} files`);
	const seen = new Set<string>();
	const files = list.map((item): SaveFile => {
		const file = args(item, "each file", ["path", "expectedVersion", "text"]);
		if (typeof file.path !== "string" || file.path.length > 200)
			throw new CloudToolArgumentRefusal("each file's path must be a path of at most 200 characters");
		const at = place(file.path);
		if (seen.has(file.path.toLowerCase())) throw new CloudToolArgumentRefusal("files names the same path twice");
		seen.add(file.path.toLowerCase());
		const expectedVersion = version(file.expectedVersion, true);
		const limit = MAX_BYTES[at.kind];
		if (typeof file.text !== "string" || Buffer.byteLength(file.text) > limit)
			throw new CloudToolArgumentRefusal(`the text of ${file.path} must be a text of at most ${limit / 1024} KiB`);
		const parsed = parse(at.kind, file.text);
		if (!parsed.ok) {
			const name = file.path.slice(file.path.lastIndexOf("/") + 1);
			throw new CloudToolArgumentRefusal(
				plain(
					invalidMessage(
						parsed.problems.map((problem) => ({ message: problemText(name, problem) })),
						`${file.path} cannot be saved`,
					),
				),
			);
		}
		return { path: file.path, expectedVersion, text: file.text };
	});
	try {
		cloudToolJsonText(files as unknown as JsonValue, SAVE_TEXT_BYTES);
	} catch {
		throw new CloudToolArgumentRefusal(`the files' texts together must fit in ${SAVE_TEXT_BYTES / 1024} KiB`);
	}
	return { operationKey: key, files };
}

type Cells = Record<string, JsonValue>;

/** A row write's arguments: the rows to set and the rows to remove, each an object of column names and values. */
function parseTableWrite(value: JsonValue): { table: string; operationKey: string; set: Cells[]; remove: Cells[] } {
	const request = args(value, "table_write", ["table", "operationKey", "set", "remove"]);
	if (typeof request.table !== "string" || !isInterfaceName(request.table))
		throw new CloudToolArgumentRefusal(
			"table must be a folder name of lowercase letters, digits and single hyphens, like cards",
		);
	const key = operationKey(request.operationKey);
	const text = (cell: JsonValue | undefined): boolean =>
		typeof cell === "string" && Array.from(cell).length <= STRING_CHARS;
	const rows = (list: JsonValue | undefined, label: "set" | "remove"): Cells[] => {
		if (!Array.isArray(list) || list.length > ROWS_PER_CALL)
			throw new CloudToolArgumentRefusal(`${label} must be a list of at most ${ROWS_PER_CALL} rows`);
		return list.map((item) => {
			if (item === null || typeof item !== "object" || Array.isArray(item))
				throw new CloudToolArgumentRefusal(`each row in ${label} must be an object of column names and values`);
			const columns = Object.keys(item);
			if (columns.length === 0 || columns.length > COLUMNS_PER_ROW)
				throw new CloudToolArgumentRefusal(`each row in ${label} names 1 to ${COLUMNS_PER_ROW} columns`);
			for (const column of columns) {
				if (column.length > 40 || !COLUMN.test(column))
					throw new CloudToolArgumentRefusal(
						"a column name is lowercase letters, digits and underscores, starting with a letter, like due_date",
					);
				const cell = item[column];
				const fits =
					text(cell) ||
					typeof cell === "boolean" ||
					(typeof cell === "number" && Number.isFinite(cell)) ||
					(label === "set" &&
						(cell === null || (Array.isArray(cell) && cell.length <= LIST_ITEMS && cell.every(text))));
				if (!fits)
					throw new CloudToolArgumentRefusal(
						label === "set"
							? `each value in set is a text of at most ${STRING_CHARS} characters, a number, true or false, null, or a list of at most ${LIST_ITEMS} texts`
							: "each value in remove is a row's key value: a text, a number, true or false",
					);
			}
			return item as Cells;
		});
	};
	const set = rows(request.set, "set");
	const remove = rows(request.remove, "remove");
	if (set.length + remove.length === 0)
		throw new CloudToolArgumentRefusal("table_write needs at least one row in set or remove");
	return { table: request.table, operationKey: key, set, remove };
}

/** Why a save changes nothing, decided on the files before the receipt. */
type Blocked =
	| "exists"
	| "missing"
	| "version_changed"
	| "not_a_file"
	| "not_a_folder"
	| "folder_missing"
	| "owners_only"
	| "rows_do_not_fit"
	| "rows_not_writable"
	| "claim";

/** One file of a save, as the folder holds it now. */
interface Planned {
	readonly file: SaveFile;
	readonly place: Place;
	/** The call's text, parsed; null for a README. */
	readonly next: Parsed | null;
	/** The file now; null when there is none. */
	entry: CloudCompanyFolderEntry | null;
	/** The file's text now, parsed, when it parses. */
	base: Parsed | null;
	state: "create" | "change" | "unchanged" | "blocked";
	/** Made with its folder: the interface's or table's folder does not exist yet. */
	inNewFolder: boolean;
	blocked?: Blocked;
	problems?: string[];
	/** A table's rows file without the columns its new definition drops, saved before it. */
	rows?: CloudCompanyFolderUnit;
}

interface SavePlan {
	readonly files: readonly Planned[];
	readonly reads: readonly CloudCompanyFolderEntry[];
	readonly blocked: boolean;
	readonly effect: "internal" | "delegation";
	readonly units: readonly CloudCompanyFolderUnit[];
	/** Each existing interface's or table's settings, parsed, for its name on the card. */
	readonly settings: ReadonlyMap<string, Parsed | null>;
}

const settingsPath = (of: "interfaces" | "tables", name: string): string =>
	of === "interfaces" ? `interfaces/${name}/interface.toml` : `tables/${name}/table.toml`;

/** Whether the agent may write a table's rows (its `[write] agents`). */
const mayWrite = (table: TableFile, agent: string): boolean =>
	table.write.agents === "all" ||
	(Array.isArray(table.write.agents) && table.write.agents.some((id: string) => id.toLowerCase() === agent));

/** A file's new text under its current entry: its media type and executable bit kept, at its version. */
function rewrite(entry: CloudCompanyFolderEntry, text: string): CloudCompanyFolderUnit {
	if (entry.kind !== "file") throw new Error("Only a file is rewritten");
	return {
		op: "write",
		path: entry.path,
		content: { text, mediaType: entry.file.mediaType, executable: entry.file.executable },
		expectedVersion: entry.version,
	};
}

/** Whether a file's change is a delegation, as the database classes it (migration 20260928469290). */
function delegates(item: Planned): boolean {
	if (item.state !== "create" && item.state !== "change") return false;
	if (item.place.kind === "interface") {
		const next = item.next as InterfaceFile;
		const base = item.base as InterfaceFile | null;
		if (!base) return true;
		if (canonical(next.buttons) !== canonical(base.buttons) || canonical(next.access) !== canonical(base.access))
			return true;
		const shown = new Set(base.views.flatMap((view) => view.blocks.flatMap((block) => block.buttons)));
		return next.views.some((view) => view.blocks.some((block) => block.buttons.some((id) => !shown.has(id))));
	}
	if (item.place.kind === "table") {
		const next = item.next as TableFile;
		const base = item.base as TableFile | null;
		return (
			!base || canonical(next.columns) !== canonical(base.columns) || canonical(next.write) !== canonical(base.write)
		);
	}
	return false;
}

/** What a save would do on the folder as it is now: each file's state, what was read to decide it, and the units. */
async function planSave(
	folder: CloudCompanyFolderClient,
	agent: string,
	files: readonly SaveFile[],
	signal: AbortSignal,
): Promise<SavePlan> {
	const reads = new Map<string, CloudCompanyFolderEntry>();
	const saw = (entry: CloudCompanyFolderEntry) => reads.set(`${entry.path}${NUL}${entry.version}`, entry);
	const read = async (path: string, maxBytes: number): Promise<FileRead> => {
		const found = await readFile(folder, path, maxBytes, signal);
		if (found.kind !== "absent") saw(found.entry);
		return found;
	};
	const entryAt = async (path: string): Promise<CloudCompanyFolderEntry | null> => {
		try {
			return (await folder.read(path, signal)).entry;
		} catch (error) {
			return unavailable(error, "read");
		}
	};

	// Each interface's or table's folder, and its settings file when the folder exists.
	const holders = new Map<string, { entry: CloudCompanyFolderEntry | null; settings: FileRead | null }>();
	const settings = new Map<string, Parsed | null>();
	for (const file of files) {
		const at = place(file.path);
		if (!at.of || !at.name || holders.has(`${at.of}/${at.name}`)) continue;
		const key = `${at.of}/${at.name}`;
		const entry = await entryAt(key);
		if (entry) saw(entry);
		const cap = at.of === "interfaces" ? INTERFACE_FILE_MAX_BYTES : TABLE_FILE_MAX_BYTES;
		const current = entry?.kind === "folder" ? await read(settingsPath(at.of, at.name), cap) : null;
		holders.set(key, { entry, settings: current });
		if (current?.kind === "text") {
			const parsed = parse(at.of === "interfaces" ? "interface" : "table", current.text);
			settings.set(key, parsed.ok ? parsed.file : null);
		}
	}

	const planned: Planned[] = [];
	const block = (item: Planned, reason: Blocked, problems?: readonly string[]) => {
		item.state = "blocked";
		item.blocked = reason;
		if (problems?.length) item.problems = [...problems];
	};
	for (const file of files) {
		const at = place(file.path);
		const parsed = parse(at.kind, file.text);
		const item: Planned = {
			file,
			place: at,
			next: parsed.ok ? parsed.file : null,
			entry: null,
			base: null,
			state: "create",
			inNewFolder: false,
		};
		planned.push(item);
		const holder = at.of && at.name ? holders.get(`${at.of}/${at.name}`) : undefined;
		let ownersOnly = false;
		if (at.of && at.name && holder) {
			if (holder.entry && holder.entry.kind !== "folder") {
				block(item, "not_a_folder");
				continue;
			}
			if (!holder.entry) {
				const own = settingsPath(at.of, at.name);
				if (file.expectedVersion !== null) block(item, "missing");
				else if (at.kind === "readme" && !files.some((other) => other.path === own)) block(item, "folder_missing");
				else item.inNewFolder = true;
				continue;
			}
			// An interface only its owners edit is never changed by an agent (§6.1 rule 4), though a file that already holds
			// the call's text is unchanged, as a replay of the call that made it finds it.
			const live = settings.get(`${at.of}/${at.name}`) as InterfaceFile | null | undefined;
			ownersOnly = at.of === "interfaces" && live?.access.edit === "owners";
		}
		const current =
			at.kind === "interface" || at.kind === "table"
				? (holder?.settings ?? { kind: "absent" as const })
				: await read(file.path, at.kind === "order" ? INTERFACE_ORDER_MAX_BYTES : README_MAX_BYTES);
		if (current.kind !== "absent") item.entry = current.entry;
		if (current.kind === "text" && current.text === file.text) item.state = "unchanged";
		else if (ownersOnly) block(item, "owners_only");
		else if (current.kind === "absent") {
			if (file.expectedVersion !== null) block(item, "missing");
		} else if (current.entry.kind !== "file") block(item, "not_a_file");
		else if (file.expectedVersion === null) block(item, "exists");
		else if (current.entry.version !== file.expectedVersion) block(item, "version_changed");
		else {
			item.state = "change";
			if (current.kind === "text") {
				const was = parse(at.kind, current.text);
				item.base = was.ok ? was.file : null;
			}
		}
	}

	// A table's definition lands only over rows that fit it (§5): a column it drops leaves the rows first, once it is
	// optional and empty in every row; anything else that doesn't fit is the rows' to fix, with table_write.
	for (const item of planned) {
		if (item.place.kind !== "table" || (item.state !== "create" && item.state !== "change") || item.inNewFolder)
			continue;
		const next = item.next as TableFile;
		const base = item.base as TableFile | null;
		const found = await read(`tables/${item.place.name}/rows.csv`, TABLE_ROWS_MAX_BYTES);
		if (found.kind === "absent") continue;
		if (found.kind === "not_text") {
			block(item, "rows_do_not_fit", [`rows.csv ${found.why}`]);
			continue;
		}
		let text = found.text;
		const before = base ? parseTableRows(base, text) : null;
		if (base && before?.readable && before.problems.length === 0) {
			const bom = text.startsWith(BOM) ? BOM : "";
			const records = rawRecords(text.slice(bom.length));
			const dropped = (records[0]?.fields ?? [])
				.map((column, index) => ({ column, index }))
				.filter(({ column }) => !next.columns.some((kept) => kept.name === column));
			if (dropped.length > 0) {
				const held = dropped.filter(
					({ column }) =>
						!base.columns.find((was) => was.name === column)?.optional ||
						before.rows.some((row) => row[column] !== null && row[column] !== undefined),
				);
				if (held.length > 0) {
					block(
						item,
						"rows_do_not_fit",
						held.map(
							({ column }) =>
								`${column} is still in the rows: make it optional and empty it in every row with table_write first`,
						),
					);
					continue;
				}
				if (!mayWrite(base, agent)) {
					block(item, "rows_not_writable");
					continue;
				}
				const drop = new Set(dropped.map(({ index }) => index));
				text =
					bom +
					records
						.map(
							(record, index) =>
								(index > 0 && isBlank(record) ? "" : record.raw.filter((_, at) => !drop.has(at)).join(",")) +
								record.end,
						)
						.join("");
				const again = parseTableRows(base, text);
				if (!again.readable || again.problems.length > 0 || canonical(again.rows) !== canonical(before.rows))
					throw new Error("A rows file without its dropped columns did not read back as the same rows");
				item.rows = rewrite(found.entry, text);
			}
		}
		const now = parseTableRows(next, text);
		if (!now.readable || now.problems.length > 0) {
			block(
				item,
				"rows_do_not_fit",
				now.problems.map((problem) => problemText("rows.csv", problem)),
			);
			continue;
		}
		const claims = tableDefinitionProblems(base ?? { ...next, columns: [] }, next, now.rows);
		if (claims.length > 0)
			block(
				item,
				"claim",
				claims.map((problem) => problemText("table.toml", problem)),
			);
	}

	const blocked = planned.some((item) => item.state === "blocked");
	const units: CloudCompanyFolderUnit[] = [];
	if (!blocked) {
		const live = planned.filter((item) => item.state === "create" || item.state === "change");
		const made = new Set<string>();
		const add = (item: Planned) => {
			if (!item.inNewFolder) {
				if (item.rows) units.push(item.rows);
				units.push(
					item.entry
						? rewrite(item.entry, item.file.text)
						: {
								op: "write",
								path: item.file.path,
								content: { text: item.file.text, mediaType: mediaTypeOf(item.file.path) },
							},
				);
				return;
			}
			const root = `${item.place.of}/${item.place.name}`;
			if (made.has(root)) return;
			made.add(root);
			units.push({
				op: "new_folder",
				path: root,
				contents: live
					.filter((other) => other.inNewFolder && `${other.place.of}/${other.place.name}` === root)
					.sort((a, b) => Number(a.place.kind === "readme") - Number(b.place.kind === "readme"))
					.map((other) => {
						const path = other.file.path.slice(root.length + 1);
						const content = { text: other.file.text, mediaType: mediaTypeOf(path) };
						return { path, kind: "file" as const, content };
					}),
			});
		};
		const demoted = (item: Planned) =>
			item.place.kind === "interface" &&
			(item.base as InterfaceFile | null)?.main === true &&
			(item.next as InterfaceFile).main === false;
		for (const item of [
			...live.filter(demoted),
			...live.filter((item) => item.place.kind === "table"),
			...live.filter((item) => item.place.kind === "interface" && !demoted(item)),
			...live.filter((item) => item.place.kind === "order" || item.place.kind === "readme"),
		])
			add(item);
	}
	return {
		files: planned,
		reads: [...reads.values()],
		blocked,
		effect: !blocked && planned.some(delegates) ? "delegation" : "internal",
		units,
		settings,
	};
}

interface CardDetail {
	readonly key: string;
	readonly value: string;
	readonly quoted?: true;
}

interface Card {
	readonly title: string;
	readonly target: string | null;
	readonly details: readonly CardDetail[];
}

const BUILT_IN_BUTTONS: ReadonlySet<string> = new Set(["answer", "take", "offer", "release"]);

const counted = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

function seenText(access: InterfaceFile["access"]): string {
	const members =
		access.members === "all"
			? "all members"
			: access.members === "owners"
				? "the owners"
				: counted(access.members.length, "member", "members");
	const agents = access.agents === "all" ? "all agents" : counted(access.agents.length, "agent", "agents");
	return `seen by ${members} and ${agents}; ${access.edit === "owners" ? "only owners edit it" : "anyone may edit it"}`;
}

function writersText(write: TableFile["write"]): string {
	const agents =
		write.agents === "all"
			? "all agents"
			: write.agents === "none"
				? "no agent"
				: counted(write.agents.length, "agent", "agents");
	const members = write.members === "all" ? "all members" : write.members === "owners" ? "the owners" : "no member";
	return `${agents} and ${members}`;
}

function columnText(column: TableColumn): string {
	const words: string[] = [column.type];
	if (column.optional) words.push("optional");
	if (column.needsYes) words.push("needs yes");
	return `${column.name} (${words.join(", ")})`;
}

type Add = (rank: number, key: string, value: string, quoted?: true) => void;

/** A settings file without the fields the card names on their own, to tell whether anything else changed. */
function rest(file: object, named: readonly string[]): string {
	return canonical(Object.fromEntries(Object.entries(file).filter(([key]) => !named.includes(key))));
}

/** What changes in one interface, as the card says it: its buttons first, then who sees it, never its files. */
function interfaceDetails(next: InterfaceFile, base: InterfaceFile | null, add: Add) {
	const label = (button: InterfaceFile["buttons"][number]) => `“${named(button.label, button.id)}” (${button.verb})`;
	const buttons: string[] = [];
	for (const button of next.buttons) {
		const was = base?.buttons.find((other) => other.id === button.id);
		if (!was) buttons.push(`adds the button ${label(button)}`);
		else if (canonical(was) !== canonical(button)) buttons.push(`changes the button ${label(button)}`);
	}
	for (const button of base?.buttons ?? [])
		if (!next.buttons.some((other) => other.id === button.id))
			buttons.push(`removes the button “${named(button.label, button.id)}”`);
	const shown = new Set(base?.views.flatMap((view) => view.blocks.flatMap((block) => block.buttons)) ?? []);
	for (const id of new Set(next.views.flatMap((view) => view.blocks.flatMap((block) => block.buttons)))) {
		if (shown.has(id)) continue;
		if (BUILT_IN_BUTTONS.has(id)) buttons.push(`shows the built-in button “${id}”`);
		else if (base) buttons.push(`shows the button “${named(next.buttons.find((b) => b.id === id)?.label, id)}”`);
	}
	if (buttons.length > 0) add(1, "buttons", buttons.join("; "));
	if (!base || canonical(base.access) !== canonical(next.access))
		add(2, "who sees and edits", `${seenText(next.access)}${base ? ` (was: ${seenText(base.access)})` : ""}`);
	if ((base?.main ?? false) !== next.main)
		add(5, "main", next.main ? "becomes the main interface" : "stops being the main interface");
	if (!base && next.status === "off") add(6, "status", "starts switched off");
	else if (base && base.status !== next.status)
		add(6, "status", next.status === "off" ? "switched off" : "switched on");
	if (base && base.name !== next.name) add(7, "also", `renamed from “${named(base.name, "")}”`);
	const own = ["buttons", "access", "main", "status", "name", "about"];
	if (base && rest(base, own) !== rest(next, own)) add(7, "also", "changes the layout or wording");
	if (!base) add(7, "views", next.views.map((view) => named(view.name, "")).join(", "));
	if (typeof next.about === "string" && next.about.trim() && next.about !== base?.about) add(9, "about", next.about);
}

/** What changes in one table: its columns, then who writes its rows. */
function tableDetails(next: TableFile, base: TableFile | null, add: Add) {
	if (!base) add(3, "columns", `has ${next.columns.map(columnText).join(", ")}`);
	else {
		const changes: string[] = [];
		for (const column of next.columns) {
			const was = base.columns.find((other) => other.name === column.name);
			if (!was) changes.push(`adds ${columnText(column)}`);
			else if (canonical(was) !== canonical(column)) changes.push(`changes ${columnText(column)}`);
		}
		for (const column of base.columns)
			if (!next.columns.some((other) => other.name === column.name)) changes.push(`removes ${column.name}`);
		if (changes.length > 0) add(3, "columns", changes.join("; "));
	}
	if (!base || canonical(base.write) !== canonical(next.write))
		add(4, "who writes rows", `${writersText(next.write)}${base ? ` (was: ${writersText(base.write)})` : ""}`);
	if (base && base.name !== next.name) add(7, "also", `renamed from “${named(base.name, "")}”`);
	const own = ["columns", "write", "name", "about"];
	if (base && rest(base, own) !== rest(next, own)) add(7, "also", "changes its settings");
	if (typeof next.about === "string" && next.about.trim() && next.about !== base?.about) add(9, "about", next.about);
}

/** The save's card: what changes, by interface or table, in the order a member weighs it, never a path or an id. */
function saveCard(plan: SavePlan): Card {
	const subjects = new Map<string, Planned[]>();
	for (const item of plan.files) {
		if (item.state !== "create" && item.state !== "change") continue;
		const key = item.place.of ? `${item.place.of}/${item.place.name}` : "order";
		subjects.set(key, [...(subjects.get(key) ?? []), item]);
	}
	const several = subjects.size > 1;
	const labels: string[] = [];
	const kinds = new Set<"interfaces" | "tables">();
	const ranked: { rank: number; key: string; value: string; quoted?: true }[] = [];
	let title = "Change an interface";
	for (const [key, items] of subjects) {
		if (key === "order") {
			kinds.add("interfaces");
			title = "Change the order of interfaces";
			const count = (items[0]?.next as InterfaceOrderFile | null)?.ids.length ?? 0;
			ranked.push({ rank: 8, key: "order", value: `${counted(count, "interface", "interfaces")}, in a new order` });
			continue;
		}
		const tables = key.startsWith("tables/");
		kinds.add(tables ? "tables" : "interfaces");
		const own = items.find((item) => item.place.kind !== "readme");
		const label = named(
			(own?.next as { name?: unknown } | null)?.name ??
				(own?.base as { name?: unknown } | null)?.name ??
				(plan.settings.get(key) as { name?: unknown } | null | undefined)?.name,
			key.slice(key.indexOf("/") + 1),
		);
		labels.push(label);
		const made = own?.state === "create" || own?.inNewFolder === true;
		if (tables) title = made ? "Make a new table" : "Change a table";
		else title = made ? "Make a new interface" : "Change an interface";
		const add: Add = (rank, detail, value, quoted) =>
			ranked.push({ rank, key: several ? `${label}: ${detail}` : detail, value, ...(quoted ? { quoted } : {}) });
		if (own && tables) tableDetails(own.next as TableFile, own.base as TableFile | null, add);
		else if (own) interfaceDetails(own.next as InterfaceFile, own.base as InterfaceFile | null, add);
		const readme = items.find((item) => item.place.kind === "readme");
		if (readme?.file.text.trim()) add(10, "what it is for", readme.file.text, true);
	}
	if (several)
		title =
			kinds.size > 1 ? "Change interfaces and tables" : kinds.has("tables") ? "Change tables" : "Change interfaces";
	const details: CardDetail[] = [];
	for (const item of ranked.sort((a, b) => a.rank - b.rank)) {
		const value = head(item.value, item.quoted ? QUOTE_BYTES : DETAIL_BYTES);
		const at = details.findIndex((detail) => detail.key === item.key);
		if (at >= 0) {
			const was = details[at] as CardDetail;
			details[at] = { ...was, value: head(`${was.value}; ${value}`, was.quoted ? QUOTE_BYTES : DETAIL_BYTES) };
		} else if (details.length < CARD_DETAILS)
			details.push({ key: item.key, value, ...(item.quoted ? { quoted: true as const } : {}) });
	}
	const target = labels.length > 0 ? head(labels.join(", "), 200) : null;
	const card = () => cloudToolJsonText({ title, target, details: details as unknown as JsonValue });
	while (details.length > 0 && Buffer.byteLength(card()) > CARD_BYTES) details.pop();
	return { title, target, details };
}

type Answer = { [key: string]: JsonValue };

const WAITING =
	"The change waits for a member's approval: do not make it again; tell the member it is waiting for them.";
const READ_AGAIN = "read it again and make your change on its current version, with a new operationKey";

const BLOCKED_NEXT: Readonly<Record<Blocked, string>> = {
	exists: `Nothing was saved. A file is already at a path you gave no version for: ${READ_AGAIN}.`,
	missing: "Nothing was saved. A path you gave a version for is gone: read again, and save with a new operationKey.",
	version_changed: `Nothing was saved. A file changed since your version: ${READ_AGAIN}.`,
	not_a_file: "Nothing was saved. A path you gave is a folder or a link, not a file.",
	not_a_folder:
		"Nothing was saved. Something at an interface's or table's folder is a file or a link, not a folder: choose another name.",
	folder_missing:
		"Nothing was saved. A README goes in an interface's or table's folder that exists, or in the same call as the interface.toml or table.toml that makes it.",
	owners_only:
		"Nothing was saved. Only the owners edit this interface (access edit = owners): tell the member what you would change.",
	rows_do_not_fit:
		"Nothing was saved. The table's rows do not fit the new definition. Change it in steps: add a required column as optional, fill it in every row with table_write, then make it required; to remove a column, make it optional and empty it in every row with table_write, then remove it.",
	rows_not_writable:
		"Nothing was saved. Removing the column changes the table's rows, which you may not write ([write] agents): tell the member.",
	claim: "Nothing was saved. The change would take the claim protection (needs_yes) off a column, or put it on one, while a row holds someone in it: leave it as it is, or tell the member.",
};

const problemLine = (problem: { line: number | null; message: string }): string =>
	`${typeof problem.line === "number" ? `line ${problem.line}: ` : ""}${problem.message}`;

/** What to do after a commit, once per kind of outcome. */
function committedNext(units: readonly CloudCompanyFolderUnitResult[]): string[] {
	const notes = new Set<string>();
	for (const unit of units) {
		if (unit.outcome === "saved") continue;
		if (unit.outcome === "waiting_for_review") notes.add(WAITING);
		else if (unit.reason === "review_required")
			notes.add(
				"Nothing was saved: this change needs the automatic review's approval of this call. Call again, and if this repeats tell the member.",
			);
		else if (unit.problems.some((problem) => (problem.code as string) === "main"))
			notes.add(
				"Another interface is the main one: include its interface.toml with main = false in the same call, with a new operationKey.",
			);
		else if (unit.outcome === "conflict") notes.add(`A file changed since you read it: ${READ_AGAIN}.`);
		else if (unit.outcome === "denied")
			notes.add("You may not change this file: tell the member what you would change.");
		else if (unit.reason === "parent_missing")
			notes.add("The company has no interfaces or tables folder to save in: tell the member.");
		else notes.add("Fix the problems listed and call again with a new operationKey.");
	}
	const saved = units.filter((unit) => unit.outcome === "saved").length;
	const waiting = units.filter((unit) => unit.outcome === "waiting_for_review").length;
	if (saved > 0 && saved + waiting < units.length)
		notes.add("Only part of the change was saved: read the files again before you change them further.");
	return [...notes];
}

/** A save's answer: each file's outcome, the files that already held their text, and what to do next. A unit's
 * problems are shown only for the call's own files: a rows file the save rewrote is named, never quoted. */
function saveText(
	request: { operationKey: string; files: readonly SaveFile[] },
	plan: SavePlan,
	committed: { receiptId: string; units: readonly CloudCompanyFolderUnitResult[] } | null,
): string {
	// A new folder holds only the call's files.
	const made = plan.files.filter((item) => item.inNewFolder).map((item) => `${item.place.of}/${item.place.name}`);
	const own = new Set([...request.files.map((file) => file.path), ...made].map((path) => path.toLowerCase()));
	const unchanged = plan.files.filter((item) => item.state === "unchanged").map((item) => item.file.path);
	let state: string;
	let rows: { answer: Answer; problems: readonly string[] }[];
	let next: string[];
	if (!committed) {
		const blocked = plan.files.filter((item) => item.state === "blocked");
		state = blocked.length > 0 ? "not_applied" : "unchanged";
		rows = blocked.map((item) => ({
			answer: { path: item.file.path, outcome: "blocked", reason: item.blocked ?? "blocked" },
			problems: item.problems ?? [],
		}));
		next =
			blocked.length > 0
				? [...new Set(blocked.map((item) => BLOCKED_NEXT[item.blocked as Blocked]))]
				: ["The files already hold this text, so there was nothing to save."];
	} else {
		const saved = committed.units.filter((unit) => unit.outcome === "saved").length;
		const waiting = committed.units.filter((unit) => unit.outcome === "waiting_for_review").length;
		state =
			saved === committed.units.length
				? "applied"
				: waiting > 0 && saved + waiting === committed.units.length
					? "proposed"
					: saved + waiting === 0
						? "not_applied"
						: "partly_applied";
		rows = committed.units.map((unit) => ({
			answer: {
				path: unit.path,
				outcome: unit.outcome,
				...(unit.outcome === "saved" && unit.version ? { version: unit.version } : {}),
				...(unit.reason ? { reason: unit.reason } : {}),
			},
			problems: own.has(unit.path.toLowerCase()) ? unit.problems.map(problemLine) : [],
		}));
		next = committedNext(committed.units);
	}
	const most = Math.max(0, ...rows.map((row) => row.problems.length));
	return fitted(
		(problems, items) =>
			cloudToolJsonText({
				schema: "qorpera.interface-save-result/v1",
				state,
				operationKey: request.operationKey,
				receiptId: committed?.receiptId ?? null,
				files: rows.slice(0, items).map(({ answer, problems: all }) => ({
					...answer,
					...(all.length > 0 && problems > 0 ? { problems: all.slice(0, problems) } : {}),
					...(all.length > problems ? { moreProblems: all.length - problems } : {}),
				})),
				...(rows.length > items ? { moreFiles: rows.length - items } : {}),
				...(unchanged.length > 0 ? { unchanged } : {}),
				next,
			}),
		most,
		rows.length,
	);
}

/** What a row write changes: by the index of each row the rows file holds now, the cells it changes and the rows it
 * removes, then the rows it adds, with the ids it made for them. */
interface RowsChange {
	readonly after: readonly TableRow[];
	readonly updates: ReadonlyMap<number, ReadonlyMap<string, TableValue>>;
	readonly removed: ReadonlySet<number>;
	readonly added: readonly TableRow[];
	readonly ids: readonly { set: number; column: string; id: string }[];
	readonly notFound: number;
	readonly problems: readonly string[];
}

/** A cell's value as a rows file writes it, for the shared reader to check. */
function rawCell(value: JsonValue | undefined): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "boolean") return value ? "yes" : "no";
	if (typeof value === "number") return tableNumberText(value);
	return Array.isArray(value) ? value.join(" ") : String(value);
}

function changeRows(
	table: TableFile,
	before: readonly TableRow[],
	request: { operationKey: string; set: readonly Cells[]; remove: readonly Cells[] },
	runId: string,
): RowsChange {
	const columns = new Map(table.columns.map((column) => [column.name, column]));
	const problems: string[] = [];
	const cells = (where: string, item: Cells): Record<string, TableValue> | null => {
		const out: Record<string, TableValue> = {};
		let fits = true;
		for (const [name, value] of Object.entries(item)) {
			const column = columns.get(name);
			const read = column
				? tableFieldValue(column, rawCell(value))
				: { problem: `${name} is not a column of this table` };
			if ("problem" in read) {
				problems.push(`${where}: ${read.problem}`);
				fits = false;
			} else out[name] = read.value;
		}
		return fits ? out : null;
	};
	const index = new Map(before.map((row, at) => [tableRowKey(table, row), at]));
	const updates = new Map<number, Map<string, TableValue>>();
	const added: TableRow[] = [];
	const ids: { set: number; column: string; id: string }[] = [];
	const touched = new Set<string>();
	request.set.forEach((item, at) => {
		const where = `set ${at + 1}`;
		const given = cells(where, item);
		if (!given) return;
		const unnamed = table.key.filter((name) => given[name] === undefined || given[name] === null);
		if (unnamed.some((name) => columns.get(name)?.type !== "id")) {
			problems.push(`${where}: name the row's key (${table.key.join(", ")}); only an id is made for a new row`);
			return;
		}
		// An id is made from the call, so a replay of the call makes the same one and finds the row it added: a key id
		// names that row, and another id the row holds is still the one this call made.
		const made = (column: string) => hashedId(ROW_ID, runId, `${request.operationKey}:${at}:${column}`);
		const filled: Record<string, TableValue> = { ...given };
		for (const name of unnamed) filled[name] = made(name);
		const key = tableRowKey(table, filled);
		if (touched.has(key)) {
			problems.push(`${where}: another row in set has the same key`);
			return;
		}
		touched.add(key);
		const existing = index.get(key);
		const was = existing === undefined ? null : (before[existing] as TableRow);
		for (const column of table.columns) {
			if (column.type !== "id" || (given[column.name] ?? null) !== null) continue;
			const id = made(column.name);
			if (was && was[column.name] !== id) continue;
			filled[column.name] = id;
			ids.push({ set: at, column: column.name, id });
		}
		if (existing === undefined || !was) {
			const row: TableRow = Object.fromEntries(
				table.columns.map((column) => [column.name, filled[column.name] ?? null]),
			);
			const lacking = table.columns.filter((column) => !column.optional && row[column.name] === null);
			if (lacking.length > 0) {
				problems.push(`${where}: a new row needs ${lacking.map((column) => column.name).join(", ")}`);
				return;
			}
			added.push(row);
			return;
		}
		const changed = new Map(
			Object.entries(filled).filter(([name, value]) => canonical(was[name] ?? null) !== canonical(value)),
		);
		if (changed.size > 0) updates.set(existing, changed);
	});
	const removed = new Set<number>();
	let notFound = 0;
	const key = [...table.key].sort().join(",");
	request.remove.forEach((item, at) => {
		const where = `remove ${at + 1}`;
		if (Object.keys(item).sort().join(",") !== key) {
			problems.push(`${where}: a row to remove is named by exactly its key columns: ${table.key.join(", ")}`);
			return;
		}
		const given = cells(where, item);
		if (!given) return;
		const row = tableRowKey(table, given);
		if (touched.has(row)) {
			problems.push(`${where}: the same row is set and removed`);
			return;
		}
		const found = index.get(row);
		if (found === undefined) notFound++;
		else if (removed.has(found)) problems.push(`${where}: the same row is removed twice`);
		else removed.add(found);
	});
	const after: TableRow[] = [];
	before.forEach((row, at) => {
		if (removed.has(at)) return;
		const update = updates.get(at);
		after.push(update ? { ...row, ...Object.fromEntries(update) } : row);
	});
	after.push(...added);
	return { after, updates, removed, added, ids, notFound, problems };
}

/** The rows file with a change made in place: the fields it changes, the rows it removes, the rows it adds after the
 * last row, and a column a cell needs added to the header; every other byte, line end and blank line as it was. */
function editRows(table: TableFile, text: string | null, change: RowsChange): string {
	const bom = text?.startsWith(BOM) ? BOM : "";
	const records = text === null ? [] : rawRecords(text.slice(bom.length));
	const header = records[0];
	if (!header) return writeTableRows(table, change.after);
	const needed = table.columns
		.map((column) => column.name)
		.filter(
			(name) =>
				!header.fields.includes(name) && change.after.some((row) => row[name] !== null && row[name] !== undefined),
		);
	const names = [...header.fields, ...needed];
	const lines: { text: string; end: string; row: boolean }[] = [
		{ text: [...header.raw, ...needed].join(","), end: header.end, row: false },
	];
	let row = 0;
	for (const record of records.slice(1)) {
		if (isBlank(record)) {
			lines.push({ text: "", end: record.end, row: false });
			continue;
		}
		const at = row++;
		if (change.removed.has(at)) continue;
		const fields = [...record.raw, ...needed.map(() => "")];
		for (const [name, value] of change.updates.get(at) ?? []) {
			const column = names.indexOf(name);
			if (column >= 0) fields[column] = csvField(value);
		}
		lines.push({ text: fields.join(","), end: record.end, row: true });
	}
	const last = lines.reduce((found, line, at) => (line.row ? at : found), 0);
	const added = change.added.map((cells) => ({
		text: names.map((name) => csvField(cells[name] ?? null)).join(","),
		end: "",
		row: true,
	}));
	lines.splice(last + 1, 0, ...added);
	const lineEnd = header.end || "\n";
	const finalEnd = records[records.length - 1]?.end ?? "";
	return (
		bom + lines.map((line, at) => line.text + (at === lines.length - 1 ? finalEnd : line.end || lineEnd)).join("")
	);
}

/** A row write's answer, its problems and new ids cut to fit one tool result. */
function rowsText(
	request: { table: string; operationKey: string },
	answer: {
		state: "applied" | "proposed" | "not_applied" | "unchanged";
		version?: string | null;
		receiptId?: string;
		outcome?: string;
		reason?: string;
		problems?: readonly string[];
		change?: RowsChange;
		next?: string;
	},
): string {
	const problems = answer.problems ?? [];
	const change = answer.change;
	const ids = change?.ids ?? [];
	return fitted(
		(shown, items) =>
			cloudToolJsonText({
				schema: "qorpera.table-write-result/v1",
				state: answer.state,
				operationKey: request.operationKey,
				table: request.table,
				version: answer.version ?? null,
				receiptId: answer.receiptId ?? null,
				...(answer.outcome ? { outcome: answer.outcome } : {}),
				...(answer.reason ? { reason: answer.reason } : {}),
				...(problems.length > 0 && shown > 0 ? { problems: problems.slice(0, shown) } : {}),
				...(problems.length > shown ? { moreProblems: problems.length - shown } : {}),
				...(change
					? { changed: { updated: change.updates.size, added: change.added.length, removed: change.removed.size } }
					: {}),
				...(change?.notFound ? { notFound: change.notFound } : {}),
				...(ids.length > 0 && items > 0 ? { ids: ids.slice(0, items) } : {}),
				...(ids.length > items ? { moreIds: ids.length - items } : {}),
				...(answer.next ? { next: answer.next } : {}),
			}),
		problems.length,
		ids.length,
	);
}

/** What to do when a row write saves nothing before its receipt, by why. */
const ROWS_NEXT = {
	broken: "Nothing was saved. The table's table.toml cannot be read (the problems): tell the member.",
	rows_do_not_fit:
		"Nothing was saved. Some of the table's rows do not fit its definition (the problems), and table_write changes only a table whose rows all fit: tell the member.",
	not_a_writer:
		"Nothing was saved. You may not write this table's rows (its [write] agents do not name you): tell the member what you would change.",
	invalid: "Nothing was saved. Fix the problems listed and call again with a new operationKey.",
	claim: "Nothing was saved. You change a needs_yes cell (a claim) only for the member who supervises your area, taking an empty one for them or letting theirs go, and never an area's owner, supervisor or agents: leave it as it is, or tell the member.",
	too_large:
		"Nothing was saved. The rows would be larger than 64 KiB, the most a table holds for now: remove rows first, or tell the member.",
} as const;

/** The member an agent acts for (§5.1): the `supervisor` of the areas row whose `agents` name it (one area per agent,
 * rule 9). Whether their consent is live is the folder core's to say at the commit, which refuses a claim without it. */
function areaSupervisor(areas: readonly TableRow[], agent: string): string | null {
	const supervisor = areas.find((row) => Array.isArray(row.agents) && row.agents.includes(agent))?.supervisor;
	return typeof supervisor === "string" ? supervisor : null;
}

/** A row write's answer after its commit, by its one unit's outcome. */
function rowsCommitted(
	request: { table: string; operationKey: string },
	receiptId: string,
	unit: CloudCompanyFolderUnitResult,
	change: RowsChange,
): string {
	const state =
		unit.outcome === "saved" ? "applied" : unit.outcome === "waiting_for_review" ? "proposed" : "not_applied";
	// The folder core's claim rule refused it: the supervisor named has no live consent, or the areas changed.
	const claim = unit.problems.some((problem) => (problem.code as string) === "claim");
	const next =
		state === "applied"
			? undefined
			: unit.outcome === "conflict"
				? "Nothing was saved: the rows changed while this call wrote them. Call again with a new operationKey."
				: claim
					? ROWS_NEXT.claim
					: committedNext([unit])[0];
	return rowsText(request, {
		state,
		version: unit.outcome === "saved" ? unit.version : null,
		receiptId,
		outcome: unit.outcome,
		...(unit.reason ? { reason: unit.reason } : {}),
		problems: unit.problems.map(problemLine),
		...(state === "not_applied" ? {} : { change }),
		...(next ? { next } : {}),
	});
}

/** The two Interfaces write tools of a folder-v2 run. `operations` takes the receipts of their changes. */
export function cloudInterfaceWriteTools(options: {
	folder: CloudCompanyFolderClient;
	operations: CloudNativeToolOperations;
	identity: CloudNativeToolIdentity;
}): CloudNativeTool[] {
	const { folder, operations, identity } = options;
	const agent = identity.staffAgentId.toLowerCase();
	const show = (context: CloudToolContext, text: string, reads: readonly CloudCompanyFolderEntry[]) =>
		released(folder, identity.runId, context, text, reads.map(cloudCompanyFolderRelease));
	// After the receipt the change is made or settled, so an answer that cannot be released is unconfirmed, never a
	// refusal (which says nothing happened): the model repeats the same call, and its replay answers.
	const showCommitted = async (context: CloudToolContext, text: string, reads: readonly CloudCompanyFolderEntry[]) => {
		try {
			return await show(context, text, reads);
		} catch (error) {
			if (error instanceof CloudToolRefusal)
				throw new Error("A committed answer could not be released", { cause: error });
			throw error;
		}
	};
	// A commit no one can complete would fence this run's later operations: refuse before writing anything.
	const writable = () => {
		if (!operations.completesFolderCommits) throw new Error("This run cannot complete folder writes");
	};

	const saveInterface: CloudNativeTool = {
		name: "save_interface" satisfies CloudRuntimeToolOperation,
		source: "company_file",
		description: `Save interfaces and tables: up to ${SAVE_FILES} files as one change. A file is an interface's interfaces/<name>/interface.toml, a table's tables/<name>/table.toml, a README.md in either folder, or interfaces/order.md. Give each file's whole new text, with its version from your read as expectedVersion, or null for a file that does not exist yet. A new interface or table is a new folder; its id is a new random lowercase UUID (version 4) you make. An interface.toml has format = "qorpera.interface/v0", an [interface] with its id and name, and one or more [[view]]s, each with a name and its [[view.block]]s: a block of kind "text" can hold its own text, and most other kinds show the source named in from, like "table:<name>"; company_read of an existing interface.toml shows the rest. The files are strict TOML: a text is one line in double quotes, with \\n for each line break, and there are no multi-line strings, dotted keys or bare dates. A table's rows are written with table_write, never here, and a new table starts with no rows. To make another interface the main one, include the old main's interface.toml with main = false. Change a table's columns in steps its rows fit: add a required column as optional, fill it with table_write, then make it required; to remove a column, make it optional and empty it in every row with table_write, then remove it. A change of buttons, of who sees or edits an interface, of a table's columns or of who writes its rows runs only with the automatic review's approval. Keep operationKey for the same change, and use a new one for any other change. The result's state is applied only when everything was saved.`,
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["operationKey", "files"],
			properties: {
				operationKey: { type: "string", pattern: OPERATION_KEY.source },
				files: {
					type: "array",
					minItems: 1,
					maxItems: SAVE_FILES,
					items: {
						type: "object",
						additionalProperties: false,
						required: ["path", "expectedVersion", "text"],
						properties: {
							path: { type: "string", maxLength: 200 },
							expectedVersion: { type: ["string", "null"], pattern: UUID_PATTERN.source },
							text: { type: "string", maxLength: INTERFACE_FILE_MAX_BYTES },
						},
					},
				},
			},
		},
		parseArguments: (value) => parseSave(value) as unknown as JsonValue,
		refused: cloudFolderRefusal,
		// The review's card says what the call changes, from the files it replaces: released with them before it is shown.
		async prepare(value, context) {
			const request = value as unknown as { operationKey: string; files: SaveFile[] };
			const plan = await planSave(folder, agent, request.files, context.signal);
			const card = saveCard(plan);
			if (plan.reads.length > 0) {
				const sha = sha256hex(cloudToolJsonText(card as unknown as JsonValue));
				try {
					const id = releaseId(identity.runId, context.callId, sha);
					await folder.release(id, plan.reads.map(cloudCompanyFolderRelease), sha, context.signal);
				} catch (error) {
					unavailable(error, "read");
				}
			}
			return {
				operationKey: request.operationKey,
				files: request.files as unknown as JsonValue,
				effect: plan.effect,
				title: card.title,
				target: card.target,
				details: card.details as unknown as JsonValue,
			};
		},
		async execute(value, context) {
			const request = value as unknown as { operationKey: string; files: SaveFile[] };
			writable();
			const bytes = request.files.reduce((sum, file) => sum + Buffer.byteLength(file.text), 0);
			context.observation?.update({ inputBytes: bytes });
			// Planned again on the folder as it is now: it may have changed since the review.
			const plan = await planSave(folder, agent, request.files, context.signal);
			if (plan.blocked || plan.units.length === 0) {
				// A repeat of a call that saved but could not note its change finds the files saved, or changed since: the
				// run's changes with no note get theirs now (I10). This call changed nothing, so a failure is a refusal.
				try {
					await folder.noteInterfaceChanges(context.signal);
				} catch (error) {
					unavailable(error, "shown");
				}
				return show(context, saveText(request, plan, null), plan.reads);
			}
			const review = context.actionReviewId;
			if (plan.effect === "delegation" && review === undefined)
				throw new CloudToolRefusal(
					"This change needs the automatic review's approval of this call, and it has none: call again, and if this repeats tell the member",
				);
			const content = await operations.execute({
				operation: {
					tool: "save_interface",
					toolVersion: TOOL_VERSION,
					logicalOperationKey: request.operationKey,
					arguments: {
						files: request.files.map((file) => ({
							path: file.path,
							expectedVersion: file.expectedVersion,
							textSha256: sha256hex(file.text),
						})),
					},
					target: { paths: request.files.map((file) => file.path) },
					requiresCompanyRevision: true,
				},
				// The folder core decides at the commit, under this call's receipt.
				authorize: async () => {},
				refused: cloudFolderRefusal,
				perform: async (_operation, { receiptId, signal }) => {
					// The commit's operation key for the model's: fixed length, and distinct per tool.
					const key = `save_interface:${sha256hex(request.operationKey)}`;
					let committed: Awaited<ReturnType<CloudCompanyFolderClient["commit"]>>;
					if (review === undefined) committed = await folder.commit(key, plan.units, { receiptId }, signal);
					else {
						const staged = await folder.stage(plan.units, signal);
						const reviewId = await folder.recordReview(
							{ actionReviewId: review, tool: "save_interface", argumentSha256: context.argumentSha256 },
							staged,
							signal,
						);
						committed = await folder.commitStaged(key, staged, { reviewId, receiptId }, signal);
					}
					const waiting = committed.units.some((unit) => unit.outcome === "waiting_for_review");
					return {
						content: { kind: "text", value: saveText(request, plan, { receiptId, units: committed.units }) },
						folderCommitId: committed.commitId,
						...(waiting ? { proposed: true as const } : {}),
					};
				},
				signal: context.signal,
				...(context.observation ? { observation: context.observation } : {}),
			});
			if (content.kind !== "text") throw new Error("A save answered no text");
			// The change in the run's conversation, with Undo (I10): SQL notes each of the run's commits there once. Its
			// failure is a folder error, never a refusal, so the call is unconfirmed: the same call again notes it.
			await folder.noteInterfaceChanges(context.signal);
			// The commit's answer can quote what the save read, a table's rows in its problems: released with it.
			return showCommitted(context, content.value, plan.reads);
		},
	};

	const tableWrite: CloudNativeTool = {
		name: "table_write" satisfies CloudRuntimeToolOperation,
		source: "company_file",
		description: `Set and remove rows of a table (tables/<table>/rows.csv, as tables/<table>/table.toml defines it). set lists rows to add or change, each an object of column names and values: a row whose key columns match a row of the table changes in the cells you name, and any other row is added. A new row may leave out an id column to get a new id; the result's ids give it, with the row's place in set (from 0). A value is text, a number, true or false, a list of texts for a list column, or null to empty an optional cell. remove lists rows to remove, each named by exactly its key columns; one that is not in the table is counted in notFound. At most ${ROWS_PER_CALL} rows in each list. You write a table only when its [write] agents names you or is all. You change a needs_yes column (a claim) only for the member who supervises your area (tables/areas): put their id in an empty cell, or empty a cell that holds them; an area's owner, supervisor and agents are the members' to change. Keep operationKey for the same change, and use a new one for any other change. The result's state is applied only when the rows were saved.`,
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["table", "operationKey", "set", "remove"],
			properties: {
				table: { type: "string", maxLength: 64 },
				operationKey: { type: "string", pattern: OPERATION_KEY.source },
				set: {
					type: "array",
					maxItems: ROWS_PER_CALL,
					items: {
						type: "object",
						maxProperties: COLUMNS_PER_ROW,
						additionalProperties: {
							anyOf: [
								{ type: ["string", "number", "boolean", "null"] },
								{ type: "array", maxItems: LIST_ITEMS, items: { type: "string" } },
							],
						},
					},
				},
				remove: {
					type: "array",
					maxItems: ROWS_PER_CALL,
					items: {
						type: "object",
						maxProperties: COLUMNS_PER_ROW,
						additionalProperties: { type: ["string", "number", "boolean"] },
					},
				},
			},
		},
		parseArguments: (value) => parseTableWrite(value),
		refused: cloudFolderRefusal,
		async execute(value, context) {
			const request = value as { table: string; operationKey: string; set: Cells[]; remove: Cells[] };
			writable();
			const changes = { set: request.set, remove: request.remove };
			context.observation?.update({ inputBytes: Buffer.byteLength(cloudToolJsonText(changes)) });
			const table = await readTable(folder, request.table, context.signal);
			if (table.kind === "absent")
				throw new CloudToolRefusal("TABLE_NOT_FOUND: no table has that name; company_list tables lists them");
			if (table.kind === "broken") {
				const answer = { state: "not_applied" as const, reason: "broken", problems: table.problems };
				return show(context, rowsText(request, { ...answer, next: ROWS_NEXT.broken }), [table.entry]);
			}
			// Every answer from here says what the rows hold (a row not found, a problem quoting a row): released with them.
			const reads = table.rowsEntry ? [table.entry, table.rowsEntry] : [table.entry];
			const version = table.rowsEntry?.version ?? null;
			const refused = (reason: Exclude<keyof typeof ROWS_NEXT, "broken">, problems: readonly string[] = []) => {
				const answer = { state: "not_applied" as const, version, reason, problems, next: ROWS_NEXT[reason] };
				return show(context, rowsText(request, answer), reads);
			};
			const { definition } = table;
			if (table.problems.length > 0) return refused("rows_do_not_fit", table.problems);
			if (!mayWrite(definition, agent)) return refused("not_a_writer");
			const change = changeRows(definition, table.rows, request, identity.runId);
			if (change.problems.length > 0) return refused("invalid", change.problems);
			if (change.updates.size + change.added.length + change.removed.size === 0) {
				const gone =
					change.notFound > 0 ? ", and the rows to remove that are not in the table (notFound) are gone" : "";
				const next = `Nothing changed: the rows already hold these values${gone}.`;
				return show(context, rowsText(request, { state: "unchanged", version, change, next }), reads);
			}
			// An agent changes a claim only for its area's supervisor (§5.1): said before the folder core refuses it. The
			// areas are read only for a change that touches a claim, and every answer from then on is released with them.
			const claimsFor = (supervisorId: string | null) =>
				tableClaimProblems(
					definition,
					table.rows,
					change.after,
					{ kind: "agent", agentId: agent, supervisorId },
					{ folder: request.table },
				);
			let claims = claimsFor(null);
			if (claims.length > 0) {
				let areas = table.rows;
				if (request.table !== "areas") {
					const read = await readTable(folder, "areas", context.signal);
					if (read.kind !== "absent") reads.push(read.entry);
					if (read.kind === "ok" && read.rowsEntry) reads.push(read.rowsEntry);
					areas = read.kind === "ok" ? read.rows : [];
				}
				claims = claimsFor(areaSupervisor(areas, agent));
			}
			if (claims.length > 0)
				return refused(
					"claim",
					claims.map((problem) => problem.message),
				);
			const text = editRows(definition, table.rowsText, change);
			if (Buffer.byteLength(text) > TABLE_ROWS_MAX_BYTES) return refused("too_large");
			const check = parseTableRows(definition, text);
			if (!check.readable || check.problems.length > 0 || canonical(check.rows) !== canonical(change.after))
				throw new Error("A rows file with a row write made in place did not read back as the rows written");
			const path = `tables/${request.table}/rows.csv`;
			const unit: CloudCompanyFolderUnit = table.rowsEntry
				? rewrite(table.rowsEntry, text)
				: { op: "write", path, content: { text, mediaType: "text/csv" } };
			const content = await operations.execute({
				operation: {
					tool: "table_write",
					toolVersion: TOOL_VERSION,
					logicalOperationKey: request.operationKey,
					arguments: { table: request.table, changesSha256: sha256hex(canonical(changes)) },
					target: { path },
					requiresCompanyRevision: true,
				},
				// The folder core decides at the commit, under this call's receipt.
				authorize: async () => {},
				refused: cloudFolderRefusal,
				perform: async (_operation, { receiptId, signal }) => {
					// The commit's operation key for the model's: fixed length, and distinct per tool.
					const key = `table_write:${sha256hex(request.operationKey)}`;
					const committed = await folder.commit(key, [unit], { receiptId }, signal);
					const saved = committed.units[0];
					if (!saved) throw new Error("Company folder commit answered no unit");
					return {
						content: { kind: "text", value: rowsCommitted(request, receiptId, saved, change) },
						folderCommitId: committed.commitId,
						...(saved.outcome === "waiting_for_review" ? { proposed: true as const } : {}),
					};
				},
				signal: context.signal,
				...(context.observation ? { observation: context.observation } : {}),
			});
			if (content.kind !== "text") throw new Error("A row write answered no text");
			return showCommitted(context, content.value, reads);
		},
	};

	return [saveInterface, tableWrite];
}
