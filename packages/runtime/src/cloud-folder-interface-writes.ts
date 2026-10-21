/*
 * The Interfaces write tool of a folder-v2 run (RUNTIME-INTERFACES.md §7, step I8b): `table_write` sets and removes
 * rows of a table. It writes through the folder core with the run's own authority, under the call's receipt, and the
 * folder core's save check (§6.1) decides the unit. Since the scope reset (step C6b) a run has no `save_interface`:
 * the pages and the tables' definitions are the platform's and the members'.
 *
 * - A refusal says nothing a file holds. Whatever depends on a file is an answer, released with the entries it read
 *   before the model sees it; such answers (rows that do not fit, a claim it may not change, nothing to save) come
 *   before the receipt. A committed answer is the commit's outcome, with the ids `table_write` made.
 * - `table_write` edits the rows file in place: the fields it changes, the rows it adds or removes, and every other
 *   byte as it was.
 * - An agent changes a claim (a needs_yes cell) only for its area's supervisor (§5.1, I9b), named in
 *   `QorperaOS/tables/areas`: `table_write` reads them there for a change that touches a claim, and the folder core
 *   checks their consent at the commit.
 * - A replay of a call whose change was saved finds the rows holding it and answers that nothing changed (an id
 *   `table_write` made is made again, so it finds its own row and names the id once more); a call that waits for a
 *   review or failed at its commit replays from its receipt.
 */

import { createHash } from "node:crypto";
import { osPath } from "@qorpera/cloud-client/company-state-files";
import {
	csvField,
	isInterfaceName,
	parseTableRows,
	TABLE_ROWS_MAX_BYTES,
	type TableFile,
	type TableRow,
	type TableValue,
	tableClaimProblems,
	tableFieldValue,
	tableNumberText,
	tableRowKey,
	writeTableRows,
} from "@qorpera/cloud-client/interfaces";
import type { JsonValue } from "@qorpera/contracts";
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
	TOOL_VERSION,
} from "./cloud-folder-file-tools.ts";
import { hashedId } from "./cloud-folder-hiring.ts";
import { readTable } from "./cloud-folder-interface-tools.ts";
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

/** At most 50 rows set and 50 removed a call, each of at most 40 cells, a list cell of at most 50 items. */
const ROWS_PER_CALL = 50;
const COLUMNS_PER_ROW = 40;
const LIST_ITEMS = 50;
const STRING_CHARS = 4000;
/** The problems an answer names, before it says how many more there are. */
const PROBLEMS_SHOWN = 5;
const BOM = String.fromCharCode(0xfeff);
/** The namespace of the ids `table_write` makes for a new row's id columns. */
const ROW_ID = "qorpera.table-write-row/v1";
const COLUMN = /^[a-z][a-z0-9_]*$/;

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

const WAITING =
	"The change waits for a member's approval: do not make it again; tell the member it is waiting for them.";

const problemLine = (problem: { line: number | null; message: string }): string =>
	`${typeof problem.line === "number" ? `line ${problem.line}: ` : ""}${problem.message}`;

/** What to do after a row write's commit that saved nothing, by its unit's outcome. */
function committedNext(unit: CloudCompanyFolderUnitResult): string {
	if (unit.outcome === "waiting_for_review") return WAITING;
	if (unit.reason === "review_required")
		return "Nothing was saved: this change needs the automatic review's approval of this call. Call again, and if this repeats tell the member.";
	if (unit.outcome === "denied") return "You may not change this file: tell the member what you would change.";
	if (unit.reason === "parent_missing")
		return "The company has no interfaces or tables folder to save in: tell the member.";
	return "Fix the problems listed and call again with a new operationKey.";
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
					: committedNext(unit);
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

/** The Interfaces write tool of a folder-v2 run. `operations` takes the receipts of its changes. */
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

	const tableWrite: CloudNativeTool = {
		name: "table_write" satisfies CloudRuntimeToolOperation,
		source: "company_file",
		description: `Set and remove rows of a table (${osPath("tables")}/<table>/rows.csv, as ${osPath("tables")}/<table>/table.toml defines it). set lists rows to add or change, each an object of column names and values: a row whose key columns match a row of the table changes in the cells you name, and any other row is added. A new row may leave out an id column to get a new id; the result's ids give it, with the row's place in set (from 0). A value is text, a number, true or false, a list of texts for a list column, or null to empty an optional cell. remove lists rows to remove, each named by exactly its key columns; one that is not in the table is counted in notFound. At most ${ROWS_PER_CALL} rows in each list. You write a table only when its [write] agents names you or is all. You change a needs_yes column (a claim) only for the member who supervises your area (${osPath("tables/areas")}): put their id in an empty cell, or empty a cell that holds them; an area's owner, supervisor and agents are the members' to change. Keep operationKey for the same change, and use a new one for any other change. The result's state is applied only when the rows were saved.`,
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
				throw new CloudToolRefusal(
					`TABLE_NOT_FOUND: no table has that name; company_list ${osPath("tables")} lists them`,
				);
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
			const path = osPath(`tables/${request.table}/rows.csv`);
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

	return [tableWrite];
}
