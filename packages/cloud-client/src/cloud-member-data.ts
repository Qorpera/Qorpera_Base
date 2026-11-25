import { isUuid } from "@qorpera/contracts";
import { cloudFileBytesSha256 } from "./cloud-file-bytes.ts";
import { readBoundedCloudResponse, withCloudDeadline } from "./cloud-request.ts";

/*
 * A member's questions to the company's databases (deploy/first-node/RUNTIME-COMPANY-DATABASES.md §3 and §5): named
 * reads kept as files, `data/<database>/queries/<question>.sql`, asked through the member gateway with the member's own
 * token. The data gateway reads each question's entry as the member, so the member's rights decide. When it does not
 * hold a question's text yet it names the file and its hash (`need`): the file is read here as the member, checked
 * against that hash, and the call is sent once more with it. Every answer is parsed with closed key sets. A watch is
 * held by the gateway until an answer differs from the one the caller holds, or for 20 s. Browser-safe.
 */

export const CLOUD_MEMBER_DATA_DATABASE = /^[a-z][a-z0-9_]{0,39}$/;
export const CLOUD_MEMBER_DATA_QUESTION = /^(?=.{1,60}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Questions one watch call holds, at most: the gateway's limit. */
export const CLOUD_MEMBER_DATA_WATCHES = 24;
/** A question's file, at most. */
export const CLOUD_MEMBER_DATA_TEXT_BYTES = 16 * 1024;
/** How long the gateway holds a watch call, in seconds, and how long the client waits for it: past the 30 s the member
 * gateway gives the route. */
const WATCH_WAIT_S = 20;
const WATCH_DEADLINE_MS = 35_000;
const QUERY_DEADLINE_MS = 15_000;
/** A question's answer, at most; a watch call's answers together, at most (each question's rows are at most 256 KiB at
 * the gateway and a call holds up to 24, and the member gateway passes at most 8 MiB); a refusal's body, at most. */
const MAX_ANSWER_BYTES = 1024 * 1024;
const MAX_WATCH_BYTES = 8 * 1024 * 1024;
const MAX_REFUSAL_BYTES = 16 * 1024;
/** Calls sent again with the texts the gateway asked for, at most. */
const NEED_ROUNDS = 2;
const SHA = /^[0-9a-f]{64}$/;
const ETAG = /^[A-Za-z0-9_-]{1,128}$/;

export class CloudMemberDataError extends Error {
	/** The HTTP status that refused the call, or null when no answer did. */
	readonly status: number | null;
	readonly code: string | undefined;
	readonly row: CloudMemberDataRow | null | undefined;
	constructor(
		message: string,
		status: number | null = null,
		refused: { readonly code?: string; readonly row?: CloudMemberDataRow | null } = {},
	) {
		super(message);
		this.status = status;
		this.code = refused.code;
		this.row = refused.row;
	}
}

export const CLOUD_MEMBER_DATA_PAGE_ROWS = 200;
const DESCRIBE_DEADLINE_MS = 20_000;
const ROWS_DEADLINE_MS = 15_000;
const CHANGES_DEADLINE_MS = 15_000;
const EDIT_DEADLINE_MS = 20_000;
const MAX_DESCRIBE_BYTES = 4 * 1024 * 1024;
const MAX_EDIT_BYTES = 1024 * 1024;
const MAX_FOLDER_NEED = 4096;
const FOLDER_ROUNDS = 16;
const FOLDER_BODY_BYTES: Readonly<Record<string, number>> = {
	describe: 56 * 1024,
	rows: 900 * 1024,
	edit: 900 * 1024,
	watch: 448 * 1024,
	changes: 900 * 1024,
};
const CHANGE_OPS: ReadonlySet<unknown> = new Set(["add", "change", "remove"]);
const ACTORS: ReadonlySet<unknown> = new Set(["member", "agent", "machine", "step", "public", "hook"]);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const AFTER = /^[1-9][0-9]{0,18}$/;
export const CLOUD_MEMBER_DATA_ZONE = /^[A-Za-z][A-Za-z0-9_+-]{0,30}(?:\/[A-Za-z0-9_+-]{1,30}){0,2}$/;
const FOLDER_FILE = /^data\/([a-z][a-z0-9_]{0,39})\/(?:database\.toml|(queries|actions)\/[^/\0\\]{1,1024}\.sql)$/;
const UTF8 = new TextEncoder();

export interface CloudMemberDataColumn {
	readonly name: string;
	readonly type: string;
	readonly settable: boolean;
}

export interface CloudMemberDataReference {
	readonly columns: readonly string[];
	readonly table: string;
	readonly to: readonly string[];
}

export interface CloudMemberDataTable {
	readonly name: string;
	readonly kind: "table" | "view";
	readonly key: readonly string[];
	readonly rows?: number;
	readonly rowsAbout?: number;
	readonly columns: readonly CloudMemberDataColumn[];
	readonly references?: readonly CloudMemberDataReference[];
}

export interface CloudMemberDataNamed {
	readonly name: string;
	readonly words: string | null;
	readonly parameters: readonly string[] | null;
	readonly problem?: string;
}

export interface CloudMemberDatabase {
	readonly database: string;
	readonly name: string | null;
	readonly about: string | null;
	readonly write: boolean;
	readonly list: boolean;
	readonly applied?: readonly { readonly name: string; readonly at: string }[];
	readonly tables?: readonly CloudMemberDataTable[];
	readonly questions: readonly CloudMemberDataNamed[];
	readonly changes: readonly CloudMemberDataNamed[];
}

export interface CloudMemberDataDescription {
	readonly databases: readonly CloudMemberDatabase[];
	readonly companyBytes: number;
	readonly limitBytes: number;
	readonly can?: readonly string[];
}

export interface CloudMemberDataRow {
	readonly values: readonly unknown[] | null;
	readonly seen: string;
	readonly tooLarge?: true;
}

export interface CloudMemberDataPage {
	readonly columns: readonly string[];
	readonly key: readonly string[];
	readonly rows: readonly CloudMemberDataRow[];
	readonly more: boolean;
	readonly next?: readonly unknown[];
	readonly tooLarge?: true;
	readonly etag: string;
	readonly asOf: string;
}

export interface CloudMemberDataTableAsked {
	readonly database: string;
	readonly table: string;
	readonly order?: string;
	readonly desc?: boolean;
	readonly limit?: number;
	readonly find?: string;
}

export interface CloudMemberDataTableWatch extends CloudMemberDataTableAsked {
	readonly etag: string;
}

export const CLOUD_MEMBER_DATA_FIND_MAX = 200;
export const CLOUD_MEMBER_DATA_AT_LIST = 200;
export type CloudMemberDataAtValue = string | number | boolean;
export type CloudMemberDataAt = Readonly<Record<string, CloudMemberDataAtValue | null | readonly CloudMemberDataAtValue[]>>;

export type CloudMemberDataValues = Readonly<Record<string, unknown>>;
export type CloudMemberDataKey = Readonly<Record<string, unknown>>;

export type CloudMemberDataEdit =
	| { readonly database: string; readonly table: string; readonly op: "add"; readonly values: CloudMemberDataValues }
	| {
			readonly database: string;
			readonly table: string;
			readonly op: "change";
			readonly key: CloudMemberDataKey;
			readonly seen: string;
			readonly values: CloudMemberDataValues;
	  }
	| {
			readonly database: string;
			readonly table: string;
			readonly op: "remove";
			readonly key: CloudMemberDataKey;
			readonly seen: string;
	  };

export interface CloudMemberDataEdited {
	readonly columns: readonly string[];
	readonly key: readonly string[];
	readonly row: CloudMemberDataRow | null;
	readonly asOf: string;
}

export type CloudMemberDataChangeOp = "add" | "change" | "remove";
export type CloudMemberDataActor = "member" | "agent" | "machine" | "step" | "public" | "hook";
export type CloudMemberDataRecordValues = Readonly<Record<string, unknown>>;

export interface CloudMemberDataChangedTable {
	readonly table: string;
	readonly op: CloudMemberDataChangeOp;
	readonly rows: number;
}

export interface CloudMemberDataChangedLine extends CloudMemberDataChangedTable {
	readonly key: CloudMemberDataRecordValues | null;
	readonly before: CloudMemberDataRecordValues | null;
	readonly after: CloudMemberDataRecordValues | null;
	readonly columns: readonly string[] | null;
}

export interface CloudMemberDataWrite {
	readonly at: string | null;
	readonly by: CloudMemberDataActor | null;
	readonly id: string | null;
	readonly via: string | null;
	readonly tables: readonly CloudMemberDataChangedTable[];
	readonly lines: readonly CloudMemberDataChangedLine[];
	readonly more?: true;
	readonly many?: true;
}

export interface CloudMemberDataChangedDay {
	readonly day: string;
	readonly by: CloudMemberDataActor;
	readonly id: string | null;
	readonly rows: number;
}

export interface CloudMemberDataChanges {
	readonly writes: readonly CloudMemberDataWrite[];
	readonly more: boolean;
	readonly next?: string;
	readonly days?: readonly CloudMemberDataChangedDay[] | null;
	readonly asOf: string;
}

export interface CloudMemberDataChangesAsked {
	readonly database: string;
	readonly after?: string;
	readonly zone?: string;
}

export type CloudMemberDataParamValue =
	| string
	| number
	| boolean
	| null
	| readonly CloudMemberDataParamValue[]
	| { readonly [key: string]: CloudMemberDataParamValue };

export interface CloudMemberDataQuestion {
	readonly database: string;
	readonly question: string;
	readonly params: Readonly<Record<string, CloudMemberDataParamValue>>;
}

export interface CloudMemberDataChangeRequest {
	readonly database: string;
	readonly change: string;
	readonly params: Readonly<Record<string, CloudMemberDataParamValue>>;
	readonly sha256?: string;
}

export type CloudMemberDataPreviewPart = string | { readonly name: string; readonly value: string | null };

export interface CloudMemberDataChangePreview {
	readonly words: readonly CloudMemberDataPreviewPart[];
	readonly values: readonly { readonly name: string; readonly value: string | null }[];
	readonly sha256: string;
}

export interface CloudMemberDataChanged {
	readonly changed?: number;
	readonly columns?: readonly string[];
	readonly rows?: readonly (readonly unknown[])[];
	readonly more?: boolean;
	readonly asOf: string;
}

/** A question with the answer's etag the caller holds. */
export interface CloudMemberDataWatch extends CloudMemberDataQuestion {
	readonly etag: string;
}

/** An answer: rows are arrays in the columns' order. */
export interface CloudMemberDataAnswer {
	readonly columns: readonly string[];
	readonly rows: readonly (readonly unknown[])[];
	readonly more: boolean;
	readonly etag: string;
	readonly asOf: string;
}

/** `partial`: the call reached its deadline before it asked every question; the answers it has are good, and the next
 * call for the same questions goes on from the first one it did not reach. */
export type CloudMemberDataWatchAnswer =
	| {
			readonly changed: readonly { readonly index: number; readonly answer: CloudMemberDataAnswer }[];
			readonly partial?: true;
	  }
	| { readonly same: true; readonly partial?: true };

export type CloudMemberDataWatched = CloudMemberDataWatch | CloudMemberDataTableWatch;

export type CloudMemberDataWatchedAnswer =
	| {
			readonly changed: readonly {
				readonly index: number;
				readonly answer: CloudMemberDataAnswer | CloudMemberDataPage;
			}[];
			readonly partial?: true;
	  }
	| { readonly same: true; readonly partial?: true };

/** A company file's text, read as the member, with the sha256 of its bytes; null when the member may not read it or
 * it is not there or not text. */
export type CloudMemberDataTextReader = (
	path: string,
	maximumBytes: number,
	signal: AbortSignal,
) => Promise<{ readonly text: string; readonly sha256: string } | null>;

function invalid(): never {
	throw new CloudMemberDataError("The company's databases gave an answer this page does not know");
}

/** Exactly `keys`. */
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
	const own = Object.keys(value);
	if (own.length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) invalid();
	return value as Record<string, unknown>;
}

export function parseCloudMemberDataAnswer(value: unknown): CloudMemberDataAnswer {
	const answer = closed(value, ["columns", "rows", "more", "etag", "asOf"]);
	const { columns, rows, more, etag, asOf } = answer;
	if (
		!Array.isArray(columns) ||
		columns.some((column) => typeof column !== "string" || column.length > 1024) ||
		!Array.isArray(rows) ||
		rows.some((row) => !Array.isArray(row) || row.length !== columns.length) ||
		typeof more !== "boolean" ||
		typeof etag !== "string" ||
		!ETAG.test(etag) ||
		typeof asOf !== "string" ||
		!Number.isFinite(Date.parse(asOf))
	)
		invalid();
	return { columns: columns as string[], rows: rows as unknown[][], more, etag, asOf };
}

function parseWatchAnswer(value: unknown, count: number): CloudMemberDataWatchAnswer {
	const partial = !!value && typeof value === "object" && Object.hasOwn(value, "partial");
	if (partial && (value as Record<string, unknown>).partial !== true) invalid();
	const more = partial ? (["partial"] as const) : ([] as const);
	if (value && typeof value === "object" && Object.hasOwn(value, "same")) {
		if (closed(value, ["same", ...more]).same !== true) invalid();
		return partial ? { same: true, partial: true } : { same: true };
	}
	const changed = closed(value, ["changed", ...more]).changed;
	if (!Array.isArray(changed) || changed.length === 0 || changed.length > count) invalid();
	const seen = new Set<number>();
	return {
		changed: changed.map((item) => {
			const one = closed(item, ["index", "answer"]);
			const index = one.index;
			if (
				!Number.isSafeInteger(index) ||
				(index as number) < 0 ||
				(index as number) >= count ||
				seen.has(index as number)
			)
				invalid();
			seen.add(index as number);
			return { index: index as number, answer: parseCloudMemberDataAnswer(one.answer) };
		}),
		...(partial ? { partial: true as const } : {}),
	};
}

function shapedKeys(value: unknown, required: readonly string[], optional: readonly string[]): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
	for (const key of Object.keys(value)) if (!required.includes(key) && !optional.includes(key)) invalid();
	if (required.some((key) => !Object.hasOwn(value, key))) invalid();
	return value as Record<string, unknown>;
}

const isText = (value: unknown, max = 1024): value is string => typeof value === "string" && value.length <= max;
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const texts = (value: unknown, max = 1024): string[] => {
	if (!Array.isArray(value) || value.some((item) => !isText(item, max))) invalid();
	return value as string[];
};

function parseNamed(value: unknown): CloudMemberDataNamed {
	const named = shapedKeys(value, ["name", "words", "parameters"], ["problem"]);
	if (!isText(named.name, 1024) || (named.words !== null && !isText(named.words, 16 * 1024))) invalid();
	if (named.problem !== undefined && !isText(named.problem, 1000)) invalid();
	const parameters = named.parameters === null ? null : texts(named.parameters, 200);
	return {
		name: named.name,
		words: named.words,
		parameters,
		...(named.problem === undefined ? {} : { problem: named.problem }),
	};
}

const isNames = (value: unknown): value is string[] =>
	Array.isArray(value) && value.length > 0 && value.every((item) => isText(item, 200));

function referenceOf(item: unknown, columns: readonly CloudMemberDataColumn[]): CloudMemberDataReference[] {
	if (!item || typeof item !== "object") return [];
	const { type, columns: from, references } = item as Record<string, unknown>;
	if (type !== "foreign_key" || !references || typeof references !== "object") return [];
	const { table, schema, columns: to } = references as Record<string, unknown>;
	if (schema !== undefined || !isText(table, 200) || !isNames(from) || !isNames(to)) return [];
	if (from.length !== to.length || from.some((name) => !columns.some((column) => column.name === name))) return [];
	return [{ columns: from, table, to }];
}

function parseTable(value: unknown): CloudMemberDataTable {
	const table = shapedKeys(
		value,
		["name", "kind", "key", "columns"],
		["rows", "rowsAbout", "constraints", "indexes", "viewDefinition"],
	);
	if (!isText(table.name, 200) || (table.kind !== "table" && table.kind !== "view")) invalid();
	if (
		(table.rows !== undefined && !isCount(table.rows)) ||
		(table.rowsAbout !== undefined && !isCount(table.rowsAbout))
	)
		invalid();
	if (!Array.isArray(table.columns)) invalid();
	const columns = table.columns.map((item) => {
		const column = shapedKeys(item, ["name", "type", "settable"], ["nullable", "default"]);
		if (!isText(column.name, 200) || !isText(column.type, 1024) || typeof column.settable !== "boolean") invalid();
		if (column.nullable !== undefined && typeof column.nullable !== "boolean") invalid();
		if (column.default !== undefined && column.default !== null && !isText(column.default, 4096)) invalid();
		return { name: column.name, type: column.type, settable: column.settable };
	});
	const key = texts(table.key, 200);
	if (key.some((name) => !columns.some((column) => column.name === name))) invalid();
	if (table.constraints !== undefined && !Array.isArray(table.constraints)) invalid();
	if (table.indexes !== undefined && !Array.isArray(table.indexes)) invalid();
	if (table.viewDefinition !== undefined && typeof table.viewDefinition !== "string") invalid();
	const references = ((table.constraints as unknown[] | undefined) ?? []).flatMap((item) =>
		referenceOf(item, columns),
	);
	return {
		name: table.name,
		kind: table.kind,
		key,
		...(table.rows === undefined ? {} : { rows: table.rows as number }),
		...(table.rowsAbout === undefined ? {} : { rowsAbout: table.rowsAbout as number }),
		columns,
		...(references.length > 0 ? { references } : {}),
	};
}

export function parseCloudMemberDataDescription(value: unknown): CloudMemberDataDescription {
	const described = shapedKeys(value, ["databases", "companyBytes", "limitBytes"], ["can"]);
	if (!Array.isArray(described.databases) || !isCount(described.companyBytes) || !isCount(described.limitBytes))
		invalid();
	const can = described.can === undefined ? undefined : texts(described.can, 40);
	if (can && can.length > 32) invalid();
	const databases = described.databases.map((item): CloudMemberDatabase => {
		const one = shapedKeys(
			item,
			["database", "name", "about", "write", "list", "questions", "changes"],
			["applied", "tables", "enums", "extensions", "ddlTruncated"],
		);
		if (typeof one.database !== "string" || !CLOUD_MEMBER_DATA_DATABASE.test(one.database)) invalid();
		if ((one.name !== null && !isText(one.name, 16 * 1024)) || (one.about !== null && !isText(one.about, 16 * 1024)))
			invalid();
		if (typeof one.write !== "boolean" || typeof one.list !== "boolean") invalid();
		if (!Array.isArray(one.questions) || !Array.isArray(one.changes)) invalid();
		if (!one.list && (one.tables !== undefined || one.applied !== undefined)) invalid();
		if (one.enums !== undefined && !Array.isArray(one.enums)) invalid();
		if (one.extensions !== undefined && !Array.isArray(one.extensions)) invalid();
		if (one.ddlTruncated !== undefined && one.ddlTruncated !== true) invalid();
		const applied =
			one.applied === undefined
				? undefined
				: (() => {
						if (!Array.isArray(one.applied)) invalid();
						return one.applied.map((step) => {
							const done = closed(step, ["name", "at"]);
							if (!isText(done.name, 1024) || !isText(done.at, 64) || !Number.isFinite(Date.parse(done.at)))
								invalid();
							return { name: done.name, at: done.at };
						});
					})();
		const tables =
			one.tables === undefined
				? undefined
				: (() => {
						if (!Array.isArray(one.tables)) invalid();
						return one.tables.map(parseTable);
					})();
		return {
			database: one.database,
			name: one.name,
			about: one.about,
			write: one.write,
			list: one.list,
			...(applied ? { applied } : {}),
			...(tables ? { tables } : {}),
			questions: one.questions.map(parseNamed),
			changes: one.changes.map(parseNamed),
		};
	});
	if (new Set(databases.map((one) => one.database)).size !== databases.length) invalid();
	return {
		databases,
		companyBytes: described.companyBytes,
		limitBytes: described.limitBytes,
		...(can ? { can } : {}),
	};
}

function parseRow(value: unknown, width: number | null): CloudMemberDataRow {
	const row = shapedKeys(value, ["values", "seen"], ["tooLarge"]);
	if (typeof row.seen !== "string" || !SHA.test(row.seen)) invalid();
	if (row.tooLarge !== undefined && row.tooLarge !== true) invalid();
	if (row.values === null) {
		if (row.tooLarge !== true) invalid();
		return { values: null, seen: row.seen, tooLarge: true };
	}
	if (!Array.isArray(row.values) || (width !== null && row.values.length !== width)) invalid();
	return row.tooLarge
		? { values: row.values, seen: row.seen, tooLarge: true }
		: { values: row.values, seen: row.seen };
}

export function parseCloudMemberDataPage(value: unknown): CloudMemberDataPage {
	const page = shapedKeys(value, ["columns", "key", "rows", "more", "etag", "asOf"], ["next", "tooLarge"]);
	const columns = texts(page.columns);
	const key = texts(page.key);
	if (key.some((name) => !columns.includes(name)) || !Array.isArray(page.rows) || typeof page.more !== "boolean")
		invalid();
	if (typeof page.etag !== "string" || !ETAG.test(page.etag)) invalid();
	if (typeof page.asOf !== "string" || !Number.isFinite(Date.parse(page.asOf))) invalid();
	if (page.next !== undefined && (!Array.isArray(page.next) || page.next.length === 0 || page.next.length > 33))
		invalid();
	if (page.tooLarge !== undefined && page.tooLarge !== true) invalid();
	const rows = page.rows.map((row) => {
		const parsed = parseRow(row, columns.length);
		if (parsed.values === null) invalid();
		return parsed;
	});
	return {
		columns,
		key,
		rows,
		more: page.more,
		...(page.next === undefined ? {} : { next: page.next as unknown[] }),
		...(page.tooLarge ? { tooLarge: true as const } : {}),
		etag: page.etag,
		asOf: page.asOf,
	};
}

function recordValues(value: unknown): CloudMemberDataRecordValues | null {
	if (value === null) return null;
	if (!plainObject(value)) invalid();
	return value;
}

function parseChangedTable(value: unknown): CloudMemberDataChangedTable {
	const one = closed(value, ["table", "op", "rows"]);
	if (!isText(one.table, 200) || !CHANGE_OPS.has(one.op) || !isCount(one.rows)) invalid();
	return { table: one.table, op: one.op as CloudMemberDataChangeOp, rows: one.rows };
}

function parseWrite(value: unknown): CloudMemberDataWrite {
	const write = shapedKeys(value, ["at", "by", "id", "via", "tables", "lines"], ["more", "many"]);
	if (write.at !== null && (!isText(write.at, 64) || !Number.isFinite(Date.parse(write.at)))) invalid();
	if (write.by !== null && !ACTORS.has(write.by)) invalid();
	if ((write.id !== null && !isText(write.id, 200)) || (write.via !== null && !isText(write.via, 1024))) invalid();
	if ((write.more !== undefined && write.more !== true) || (write.many !== undefined && write.many !== true))
		invalid();
	if (!Array.isArray(write.tables) || !Array.isArray(write.lines)) invalid();
	const lines = write.lines.map((item): CloudMemberDataChangedLine => {
		const line = closed(item, ["table", "op", "rows", "key", "before", "after", "columns"]);
		return {
			...parseChangedTable({ table: line.table, op: line.op, rows: line.rows }),
			key: recordValues(line.key),
			before: recordValues(line.before),
			after: recordValues(line.after),
			columns: line.columns === null ? null : texts(line.columns, 200),
		};
	});
	return {
		at: write.at as string | null,
		by: write.by as CloudMemberDataActor | null,
		id: write.id as string | null,
		via: write.via as string | null,
		tables: write.tables.map(parseChangedTable),
		lines,
		...(write.more ? { more: true as const } : {}),
		...(write.many ? { many: true as const } : {}),
	};
}

export function parseCloudMemberDataChanges(value: unknown): CloudMemberDataChanges {
	const changes = shapedKeys(value, ["writes", "more", "asOf"], ["next", "days"]);
	if (!Array.isArray(changes.writes) || typeof changes.more !== "boolean") invalid();
	if (typeof changes.asOf !== "string" || !Number.isFinite(Date.parse(changes.asOf))) invalid();
	if (changes.next !== undefined && (typeof changes.next !== "string" || !AFTER.test(changes.next))) invalid();
	if ((changes.next !== undefined) !== changes.more) invalid();
	const days =
		changes.days === undefined || changes.days === null
			? changes.days
			: (() => {
					if (!Array.isArray(changes.days)) invalid();
					return changes.days.map((item): CloudMemberDataChangedDay => {
						const day = closed(item, ["day", "by", "id", "rows"]);
						if (typeof day.day !== "string" || !DAY.test(day.day) || !ACTORS.has(day.by) || !isCount(day.rows))
							invalid();
						if (day.id !== null && !isText(day.id, 200)) invalid();
						return {
							day: day.day,
							by: day.by as CloudMemberDataActor,
							id: day.id as string | null,
							rows: day.rows,
						};
					});
				})();
	return {
		writes: changes.writes.map(parseWrite),
		more: changes.more,
		...(changes.next === undefined ? {} : { next: changes.next as string }),
		...(days === undefined ? {} : { days }),
		asOf: changes.asOf,
	};
}

function parseChangePreview(value: unknown): CloudMemberDataChangePreview {
	const preview = closed(value, ["words", "values", "sha256"]);
	if (typeof preview.sha256 !== "string" || !SHA.test(preview.sha256)) invalid();
	if (!Array.isArray(preview.words) || !Array.isArray(preview.values)) invalid();
	const words = preview.words.map((part): CloudMemberDataPreviewPart => {
		if (typeof part === "string") return part;
		const item = closed(part, ["name", "value"]);
		if (!isText(item.name, 200) || (item.value !== null && typeof item.value !== "string")) invalid();
		return { name: item.name, value: item.value };
	});
	const values = preview.values.map((item) => {
		const one = closed(item, ["name", "value"]);
		if (!isText(one.name, 200) || (one.value !== null && typeof one.value !== "string")) invalid();
		return { name: one.name, value: one.value };
	});
	return { words, values, sha256: preview.sha256 };
}

function parseChanged(value: unknown): CloudMemberDataChanged {
	const done = shapedKeys(value, ["asOf"], ["changed", "columns", "rows", "more"]);
	if (typeof done.asOf !== "string" || !Number.isFinite(Date.parse(done.asOf))) invalid();
	if (done.changed !== undefined && !isCount(done.changed)) invalid();
	const hasRows = done.rows !== undefined || done.columns !== undefined || done.more !== undefined;
	if (hasRows) {
		const columns = texts(done.columns);
		if (
			!Array.isArray(done.rows) ||
			done.rows.some((row) => !Array.isArray(row) || row.length !== columns.length) ||
			typeof done.more !== "boolean"
		)
			invalid();
		return {
			...(done.changed === undefined ? {} : { changed: done.changed as number }),
			columns,
			rows: done.rows as unknown[][],
			more: done.more,
			asOf: done.asOf,
		};
	}
	return {
		...(done.changed === undefined ? {} : { changed: done.changed as number }),
		asOf: done.asOf,
	};
}

function parseEdited(value: unknown): CloudMemberDataEdited {
	const edited = closed(value, ["columns", "key", "row", "asOf"]);
	const columns = texts(edited.columns);
	const key = texts(edited.key);
	if (typeof edited.asOf !== "string" || !Number.isFinite(Date.parse(edited.asOf))) invalid();
	return { columns, key, row: edited.row === null ? null : parseRow(edited.row, columns.length), asOf: edited.asOf };
}

function parseWatchedAnswer(value: unknown, watches: readonly CloudMemberDataWatched[]): CloudMemberDataWatchedAnswer {
	const partial = !!value && typeof value === "object" && Object.hasOwn(value, "partial");
	if (partial && (value as Record<string, unknown>).partial !== true) invalid();
	const more = partial ? (["partial"] as const) : ([] as const);
	if (value && typeof value === "object" && Object.hasOwn(value, "same")) {
		if (closed(value, ["same", ...more]).same !== true) invalid();
		return partial ? { same: true, partial: true } : { same: true };
	}
	const changed = closed(value, ["changed", ...more]).changed;
	if (!Array.isArray(changed) || changed.length === 0 || changed.length > watches.length) invalid();
	const seen = new Set<number>();
	return {
		changed: changed.map((item) => {
			const one = closed(item, ["index", "answer"]);
			const index = one.index;
			if (
				!Number.isSafeInteger(index) ||
				(index as number) < 0 ||
				(index as number) >= watches.length ||
				seen.has(index as number)
			)
				invalid();
			seen.add(index as number);
			const watched = watches[index as number];
			return {
				index: index as number,
				answer:
					watched && "table" in watched
						? parseCloudMemberDataPage(one.answer)
						: parseCloudMemberDataAnswer(one.answer),
			};
		}),
		...(partial ? { partial: true as const } : {}),
	};
}

/** The files the gateway asked for, each a question of this call: `{ path, sha256 }`. */
function parseNeed(value: unknown, paths: ReadonlySet<string>): { path: string; sha256: string }[] {
	const need = closed(value, ["need"]).need;
	if (!Array.isArray(need) || need.length === 0 || need.length > CLOUD_MEMBER_DATA_WATCHES) invalid();
	return need.map((item) => {
		const one = closed(item, ["path", "sha256"]);
		if (typeof one.sha256 !== "string" || !SHA.test(one.sha256)) invalid();
		// Only a question's own file of this call is read and sent: never another path the gateway names.
		if (typeof one.path !== "string" || !paths.has(one.path))
			throw new CloudMemberDataError("The company's databases asked for a file that is not this call's question");
		return { path: one.path, sha256: one.sha256 };
	});
}

const isNeed = (value: unknown) => !!value && typeof value === "object" && Object.hasOwn(value, "need");

function origin(value: string): string {
	const url = new URL(value);
	if (
		(url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "127.0.0.1")) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	)
		throw new CloudMemberDataError("Invalid company data endpoint");
	return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

function checkQuestion(asked: CloudMemberDataQuestion): void {
	if (
		!asked ||
		typeof asked.database !== "string" ||
		!CLOUD_MEMBER_DATA_DATABASE.test(asked.database) ||
		typeof asked.question !== "string" ||
		!CLOUD_MEMBER_DATA_QUESTION.test(asked.question) ||
		!asked.params ||
		typeof asked.params !== "object" ||
		Array.isArray(asked.params)
	)
		throw new CloudMemberDataError("Name a question as <database>/<question>");
}

function checkChange(asked: CloudMemberDataChangeRequest): void {
	if (
		!asked ||
		typeof asked.database !== "string" ||
		!CLOUD_MEMBER_DATA_DATABASE.test(asked.database) ||
		typeof asked.change !== "string" ||
		!CLOUD_MEMBER_DATA_QUESTION.test(asked.change) ||
		!asked.params ||
		typeof asked.params !== "object" ||
		Array.isArray(asked.params) ||
		(asked.sha256 !== undefined && (typeof asked.sha256 !== "string" || !SHA.test(asked.sha256)))
	)
		throw new CloudMemberDataError("Name a change as <database>/<change>");
}

const pathOf = (asked: CloudMemberDataQuestion) => `data/${asked.database}/queries/${asked.question}.sql`;
const changePathOf = (asked: CloudMemberDataChangeRequest) => `data/${asked.database}/actions/${asked.change}.sql`;

const isName = (value: unknown): value is string =>
	typeof value === "string" && value !== "" && UTF8.encode(value).byteLength <= 63 && !value.includes("\0");

function checkDatabase(database: unknown): asserts database is string {
	if (typeof database !== "string" || !CLOUD_MEMBER_DATA_DATABASE.test(database))
		throw new CloudMemberDataError("Name a database");
}

function checkTable(asked: CloudMemberDataTableAsked): void {
	if (!asked || typeof asked !== "object") throw new CloudMemberDataError("Name a table");
	checkDatabase(asked.database);
	if (!isName(asked.table)) throw new CloudMemberDataError("Name a table");
	if (asked.order !== undefined && !isName(asked.order)) throw new CloudMemberDataError("order names a column");
	if (asked.desc !== undefined && typeof asked.desc !== "boolean")
		throw new CloudMemberDataError("desc is true or false");
	if (
		asked.limit !== undefined &&
		(!Number.isSafeInteger(asked.limit) || asked.limit < 1 || asked.limit > CLOUD_MEMBER_DATA_PAGE_ROWS)
	)
		throw new CloudMemberDataError(`A page holds 1 to ${CLOUD_MEMBER_DATA_PAGE_ROWS} rows`);
	if (
		asked.find !== undefined &&
		(typeof asked.find !== "string" ||
			asked.find.trim() === "" ||
			asked.find.length > CLOUD_MEMBER_DATA_FIND_MAX ||
			asked.find.includes("\0"))
	)
		throw new CloudMemberDataError(`find is 1 to ${CLOUD_MEMBER_DATA_FIND_MAX} characters`);
}

function tableBody(asked: CloudMemberDataTableAsked): Record<string, unknown> {
	return {
		database: asked.database,
		table: asked.table,
		...(asked.order === undefined ? {} : { order: asked.order }),
		...(asked.desc === undefined ? {} : { desc: asked.desc }),
		...(asked.limit === undefined ? {} : { limit: asked.limit }),
		...(asked.find === undefined ? {} : { find: asked.find }),
	};
}

function checkAt(at: CloudMemberDataAt): void {
	const named = at && typeof at === "object" && !Array.isArray(at) ? Object.entries(at) : [];
	const plain = (value: unknown) =>
		typeof value === "boolean" ||
		(typeof value === "string" && !value.includes("\0")) ||
		(typeof value === "number" && Number.isFinite(value));
	const given = (value: unknown) =>
		value === null ||
		plain(value) ||
		(Array.isArray(value) && value.length >= 1 && value.length <= CLOUD_MEMBER_DATA_AT_LIST && value.every(plain));
	if (named.length < 1 || named.length > 32 || named.some(([column, value]) => !isName(column) || !given(value)))
		throw new CloudMemberDataError("at names 1 to 32 columns, each with a value, null or a list of values");
}

const plainObject = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value);

function editBody(edit: CloudMemberDataEdit): Record<string, unknown> {
	if (!edit || typeof edit !== "object") throw new CloudMemberDataError("Name a table");
	checkDatabase(edit.database);
	if (!isName(edit.table)) throw new CloudMemberDataError("Name a table");
	if (edit.op !== "add" && edit.op !== "change" && edit.op !== "remove")
		throw new CloudMemberDataError("op is add, change or remove");
	const base = { database: edit.database, table: edit.table, op: edit.op };
	if (edit.op === "add") {
		if (!plainObject(edit.values)) throw new CloudMemberDataError("values are the columns to set, by name");
		return { ...base, values: { ...edit.values } };
	}
	if (!plainObject(edit.key) || typeof edit.seen !== "string" || !SHA.test(edit.seen))
		throw new CloudMemberDataError(`A ${edit.op} names the row's whole key and the seen it was read with`);
	if (edit.op === "remove") return { ...base, key: { ...edit.key }, seen: edit.seen };
	if (!plainObject(edit.values) || Object.keys(edit.values).length === 0)
		throw new CloudMemberDataError("A change sets at least one column");
	return { ...base, key: { ...edit.key }, seen: edit.seen, values: { ...edit.values } };
}

function parseFolderNeed(value: unknown, mayRead: (path: string) => boolean): { path: string; sha256: string }[] {
	const need = closed(value, ["need"]).need;
	if (!Array.isArray(need) || need.length === 0 || need.length > MAX_FOLDER_NEED) invalid();
	return need.map((item) => {
		const one = closed(item, ["path", "sha256"]);
		if (typeof one.sha256 !== "string" || !SHA.test(one.sha256)) invalid();
		if (typeof one.path !== "string" || !mayRead(one.path))
			throw new CloudMemberDataError("The company's databases asked for a file that is not this call's");
		return { path: one.path, sha256: one.sha256 };
	});
}

function folderFileOf(databases: ReadonlySet<string> | null): (path: string) => boolean {
	return (path) => {
		const found = FOLDER_FILE.exec(path);
		return found !== null && (databases === null || databases.has(found[1] ?? ""));
	};
}

export class CloudMemberData {
	readonly #environmentId: string;
	readonly #gateway: string;
	readonly #accessToken: (signal: AbortSignal) => Promise<string>;
	readonly #fetch: typeof fetch;
	readonly #readText: CloudMemberDataTextReader;

	/** `gatewayUrl`: the member gateway, an origin or the URL of the member gateway's function; calls go to
	 * `<gatewayUrl>/v1/company-data/<environmentId>/…`. `readText` reads a question's file as the member. */
	constructor(options: {
		environmentId: string;
		gatewayUrl: string;
		accessToken: (signal: AbortSignal) => Promise<string>;
		readText: CloudMemberDataTextReader;
		fetch?: typeof fetch;
	}) {
		if (!isUuid(options.environmentId)) throw new CloudMemberDataError("Invalid company data configuration");
		this.#environmentId = options.environmentId;
		this.#gateway = origin(options.gatewayUrl);
		this.#accessToken = options.accessToken;
		this.#readText = options.readText;
		this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
	}

	async query(asked: CloudMemberDataQuestion, signal: AbortSignal): Promise<CloudMemberDataAnswer> {
		checkQuestion(asked);
		const body = { database: asked.database, question: asked.question, params: asked.params };
		return parseCloudMemberDataAnswer(await this.#ask("query", body, [pathOf(asked)], QUERY_DEADLINE_MS, signal));
	}

	async previewChange(
		asked: Omit<CloudMemberDataChangeRequest, "sha256">,
		signal: AbortSignal,
	): Promise<CloudMemberDataChangePreview> {
		checkChange(asked);
		const body = { database: asked.database, change: asked.change, params: asked.params, preview: true };
		return parseChangePreview(await this.#ask("change", body, [changePathOf(asked)], QUERY_DEADLINE_MS, signal));
	}

	async change(asked: CloudMemberDataChangeRequest, signal: AbortSignal): Promise<CloudMemberDataChanged> {
		checkChange(asked);
		const body = {
			database: asked.database,
			change: asked.change,
			params: asked.params,
			...(asked.sha256 === undefined ? {} : { sha256: asked.sha256 }),
		};
		return parseChanged(await this.#ask("change", body, [changePathOf(asked)], EDIT_DEADLINE_MS, signal));
	}

	async watch(watches: readonly CloudMemberDataWatch[], signal: AbortSignal): Promise<CloudMemberDataWatchAnswer> {
		if (!Array.isArray(watches) || watches.length < 1 || watches.length > CLOUD_MEMBER_DATA_WATCHES)
			throw new CloudMemberDataError(`A watch holds 1 to ${CLOUD_MEMBER_DATA_WATCHES} questions`);
		for (const watch of watches) {
			checkQuestion(watch);
			if (typeof watch.etag !== "string" || watch.etag.length > 128)
				throw new CloudMemberDataError("A watch holds the answer's etag");
		}
		const body = {
			watches: watches.map((watch) => ({
				database: watch.database,
				question: watch.question,
				params: watch.params,
				etag: watch.etag,
			})),
			wait: WATCH_WAIT_S,
		};
		return parseWatchAnswer(
			await this.#ask("watch", body, watches.map(pathOf), WATCH_DEADLINE_MS, signal),
			watches.length,
		);
	}

	async describe(database: string | null, signal: AbortSignal): Promise<CloudMemberDataDescription> {
		if (database !== null) checkDatabase(database);
		const answer = await this.#askFolder(
			"describe",
			database === null ? {} : { database },
			folderFileOf(database === null ? null : new Set([database])),
			DESCRIBE_DEADLINE_MS,
			MAX_DESCRIBE_BYTES,
			signal,
		);
		return parseCloudMemberDataDescription(answer);
	}

	async rows(
		asked: CloudMemberDataTableAsked & { readonly after?: readonly unknown[]; readonly at?: CloudMemberDataAt },
		signal: AbortSignal,
	): Promise<CloudMemberDataPage> {
		checkTable(asked);
		if (asked.at !== undefined) {
			checkAt(asked.at);
			if (asked.after !== undefined)
				throw new CloudMemberDataError("at reads rows by their values: it takes no after");
		}
		if (
			asked.after !== undefined &&
			(!Array.isArray(asked.after) || asked.after.length === 0 || asked.after.length > 33)
		)
			throw new CloudMemberDataError("after is the next a page gave");
		const body = {
			...tableBody(asked),
			...(asked.after === undefined ? {} : { after: asked.after }),
			...(asked.at === undefined ? {} : { at: asked.at }),
		};
		const answer = await this.#askFolder(
			"rows",
			body,
			folderFileOf(new Set([asked.database])),
			ROWS_DEADLINE_MS,
			MAX_ANSWER_BYTES,
			signal,
		);
		return parseCloudMemberDataPage(answer);
	}

	async edit(edit: CloudMemberDataEdit, signal: AbortSignal): Promise<CloudMemberDataEdited> {
		const body = editBody(edit);
		const answer = await this.#askFolder(
			"edit",
			body,
			folderFileOf(new Set([edit.database])),
			EDIT_DEADLINE_MS,
			MAX_EDIT_BYTES,
			signal,
		);
		return parseEdited(answer);
	}

	async changes(asked: CloudMemberDataChangesAsked, signal: AbortSignal): Promise<CloudMemberDataChanges> {
		if (!asked || typeof asked !== "object") throw new CloudMemberDataError("Name a database");
		checkDatabase(asked.database);
		if (asked.after !== undefined && (typeof asked.after !== "string" || !AFTER.test(asked.after)))
			throw new CloudMemberDataError("after is the next a page gave");
		if (asked.zone !== undefined && (typeof asked.zone !== "string" || !CLOUD_MEMBER_DATA_ZONE.test(asked.zone)))
			throw new CloudMemberDataError("zone is a time zone's name");
		const body = {
			database: asked.database,
			...(asked.after === undefined ? {} : { after: asked.after }),
			...(asked.zone === undefined ? {} : { zone: asked.zone }),
		};
		const answer = await this.#askFolder(
			"changes",
			body,
			folderFileOf(new Set([asked.database])),
			CHANGES_DEADLINE_MS,
			MAX_ANSWER_BYTES,
			signal,
		);
		return parseCloudMemberDataChanges(answer);
	}

	async watchTables(
		watches: readonly CloudMemberDataWatched[],
		signal: AbortSignal,
	): Promise<CloudMemberDataWatchedAnswer> {
		if (!Array.isArray(watches) || watches.length < 1 || watches.length > CLOUD_MEMBER_DATA_WATCHES)
			throw new CloudMemberDataError(`A watch holds 1 to ${CLOUD_MEMBER_DATA_WATCHES} questions or tables`);
		const questions = new Set<string>();
		const databases = new Set<string>();
		const sent = watches.map((watch) => {
			if (!watch || typeof watch.etag !== "string" || watch.etag.length > 128)
				throw new CloudMemberDataError("A watch holds the answer's etag");
			if ("table" in watch) {
				checkTable(watch);
				databases.add(watch.database);
				return { ...tableBody(watch), etag: watch.etag };
			}
			checkQuestion(watch);
			questions.add(pathOf(watch));
			return { database: watch.database, question: watch.question, params: watch.params, etag: watch.etag };
		});
		const inTables = folderFileOf(databases);
		const answer = await this.#askFolder(
			"watch",
			{ watches: sent, wait: WATCH_WAIT_S },
			(path) => questions.has(path) || inTables(path),
			WATCH_DEADLINE_MS,
			MAX_WATCH_BYTES,
			signal,
		);
		return parseWatchedAnswer(answer, watches);
	}

	async #askFolder(
		verb: "describe" | "rows" | "edit" | "watch" | "changes",
		body: Record<string, unknown>,
		mayRead: (path: string) => boolean,
		deadlineMs: number,
		maximumBytes: number,
		signal: AbortSignal,
	): Promise<unknown> {
		const given = new Set<string>();
		const cached = new Map<string, string>();
		const room = (FOLDER_BODY_BYTES[verb] ?? 0) - UTF8.encode(JSON.stringify(body)).byteLength;
		let texts: Record<string, string> | undefined;
		for (let round = 0; ; round++) {
			const answer = await this.#post(maximumBytes, verb, texts ? { ...body, texts } : body, deadlineMs, signal);
			if (!isNeed(answer)) return answer;
			const wanted = parseFolderNeed(answer, mayRead).filter((one) => !given.has(one.sha256));
			if (round === FOLDER_ROUNDS || wanted.length === 0)
				throw new CloudMemberDataError("The company's databases could not take the files' texts");
			texts = {};
			let left = room;
			const unique: { path: string; sha256: string }[] = [];
			const seenHash = new Set<string>();
			for (const one of wanted) {
				if (seenHash.has(one.sha256)) continue;
				seenHash.add(one.sha256);
				unique.push(one);
			}
			let full = false;
			for (let offset = 0; offset < unique.length && !full; offset += 8) {
				const slice = unique.slice(offset, offset + 8);
				const loaded = await Promise.all(
					slice.map(async (one) => {
						const existing = cached.get(one.sha256);
						if (existing !== undefined) return { one, text: existing };
						const text = await this.#text(one, signal);
						cached.set(one.sha256, text);
						return { one, text };
					}),
				);
				for (const { one, text } of loaded) {
					const size = UTF8.encode(JSON.stringify(text)).byteLength + 72;
					if (size > left && Object.keys(texts).length > 0) {
						full = true;
						break;
					}
					if (size > left) throw new CloudMemberDataError(`${one.path} is too large to send`);
					texts[one.sha256] = text;
					given.add(one.sha256);
					left -= size;
				}
			}
		}
	}

	async #ask(
		verb: "query" | "watch" | "change",
		body: Record<string, unknown>,
		allowedPaths: readonly string[],
		deadlineMs: number,
		signal: AbortSignal,
	): Promise<unknown> {
		const paths = new Set(allowedPaths);
		const texts: Record<string, string> = {};
		for (let round = 0; ; round++) {
			const answer = await this.#post(
				verb === "watch" ? MAX_WATCH_BYTES : MAX_ANSWER_BYTES,
				verb,
				Object.keys(texts).length > 0 ? { ...body, texts } : body,
				deadlineMs,
				signal,
			);
			if (!isNeed(answer)) return answer;
			if (round === NEED_ROUNDS)
				throw new CloudMemberDataError("The company's databases could not take the question's text");
			const needed = parseNeed(answer, paths);
			const loaded = await Promise.all(
				needed.map(async (wanted) => [wanted.sha256, await this.#text(wanted, signal)] as const),
			);
			for (const [hash, text] of loaded) texts[hash] = text;
		}
	}

	/** A question's file, read as the member, when its bytes are the ones the gateway named. */
	async #text(wanted: { path: string; sha256: string }, signal: AbortSignal): Promise<string> {
		const read = await this.#readText(wanted.path, CLOUD_MEMBER_DATA_TEXT_BYTES, signal);
		signal.throwIfAborted();
		if (read === null) throw new CloudMemberDataError(`${wanted.path} can't be read`);
		const bytes = new TextEncoder().encode(read.text);
		if (bytes.byteLength > CLOUD_MEMBER_DATA_TEXT_BYTES)
			throw new CloudMemberDataError(`${wanted.path} is larger than 16 KiB`);
		// The reader's word and the bytes themselves: both must be the file the gateway named.
		if (read.sha256 !== wanted.sha256 || (await cloudFileBytesSha256(bytes)) !== wanted.sha256)
			throw new CloudMemberDataError(`${wanted.path} changed while it was asked: try again`);
		return read.text;
	}

	async #token(signal: AbortSignal): Promise<string> {
		let token: string;
		try {
			token = await this.#accessToken(signal);
		} catch {
			throw new CloudMemberDataError("Sign in again to ask the company's databases", 401);
		}
		signal.throwIfAborted();
		if (typeof token !== "string" || !/^[A-Za-z0-9._~-]{1,8192}$/.test(token))
			throw new CloudMemberDataError("Sign in again to ask the company's databases", 401);
		return token;
	}

	#post(
		maximumBytes: number,
		verb: string,
		body: Record<string, unknown>,
		deadlineMs: number,
		signal: AbortSignal,
	): Promise<unknown> {
		return withCloudDeadline(
			async (requestSignal) => {
				const token = await this.#token(requestSignal);
				const response = await this.#fetch(`${this.#gateway}/v1/company-data/${this.#environmentId}/${verb}`, {
					method: "POST",
					headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
					body: JSON.stringify(body),
					signal: requestSignal,
					redirect: "error",
					credentials: "omit",
				});
				if (response.status !== 200) throw await refusal(response, requestSignal);
				let bytes: Uint8Array;
				try {
					bytes = await readBoundedCloudResponse(response, maximumBytes, requestSignal);
				} catch (error) {
					requestSignal.throwIfAborted();
					if (error instanceof Error && /byte limit/.test(error.message))
						throw new CloudMemberDataError(`The answer is larger than ${maximumBytes / 1024 / 1024} MiB`);
					throw error;
				}
				try {
					return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
				} catch {
					invalid();
				}
			},
			deadlineMs,
			signal,
		);
	}
}

function refusedDetail(said: Record<string, unknown>): {
	code?: string;
	row?: CloudMemberDataRow | null;
} {
	const code = typeof said.code === "string" && /^[0-9A-Z]{5}$/.test(said.code) ? said.code : undefined;
	let row: CloudMemberDataRow | null | undefined;
	if (said.row === null) row = null;
	else if (said.row !== undefined)
		try {
			row = parseRow(said.row, null);
		} catch {
			row = undefined;
		}
	return { ...(code ? { code } : {}), ...(row !== undefined ? { row } : {}) };
}

/** A refusal in plain words: the gateway's own for a 4xx, sign in again for a 401. */
async function refusal(response: Response, signal: AbortSignal): Promise<CloudMemberDataError> {
	const status = response.status;
	if (status === 401) {
		void response.body?.cancel().catch(() => undefined);
		return new CloudMemberDataError("Sign in again to ask the company's databases", 401);
	}
	if (status >= 400 && status < 500) {
		try {
			const value = JSON.parse(
				new TextDecoder("utf-8", { fatal: true }).decode(
					await readBoundedCloudResponse(response, MAX_REFUSAL_BYTES, signal),
				),
			) as unknown;
			const said = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
			const error = said.error;
			if (
				typeof error === "string" &&
				error.length > 0 &&
				error.length <= 1000 &&
				!/[\0-\x08\x0b-\x1f\x7f]/.test(error)
			)
				return new CloudMemberDataError(error, status, refusedDetail(said));
		} catch {
			signal.throwIfAborted();
		}
		return new CloudMemberDataError(`The company's databases refused the question (${status})`, status);
	}
	void response.body?.cancel().catch(() => undefined);
	return new CloudMemberDataError(`The company's databases did not answer (${status})`, status);
}
