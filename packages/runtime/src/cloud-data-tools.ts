import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { type JsonValue, parseRecord } from "@qorpera/contracts";
import { withAbortScopes } from "./abort-scope.ts";
import type { CloudCompanyDataPass, CloudCompanyFolderClient } from "./cloud-company-folder-client.ts";
import { CloudCompanyPathNotText } from "./cloud-company-path-gateway.ts";
import {
	type CloudNativeTool,
	CloudToolArgumentRefusal,
	type CloudToolContent,
	CloudToolRefusal,
} from "./cloud-native-tool-boundary.ts";
import { CloudRuntimeDiagnosticError, type CloudRuntimeToolOperation } from "./cloud-runtime-observability.ts";
import { fitsOneResult } from "./cloud-worker-tools.ts";

/*
 * Company databases, slice 5 (deploy/first-node/RUNTIME-COMPANY-DATABASES.md §3 and §6; SLICE5-AGENTS.md): agents make,
 * change and ask the company's databases. A database is a folder data/<name>/ of the company folder, which agents write
 * with the file tools; its rows live in the company data store, which only the data gateway reaches.
 *
 * - data_describe: the databases the run may read (or the one it names), as the folder and the store hold them.
 * - data_apply: applies a database's waiting steps and says how each went. A step that would destroy data is held, and
 *   its answer carries an `allow`. Called again with that `allow`, data_apply asks a member on a card (always: never
 *   the reviewer and never a rule, cloud-action-review.ts) and, on their yes, applies exactly that step (slice 7,
 *   migration 20260930764000): the platform keeps the `allow` in the run's data pass only for a member's Allow that
 *   this run used, and the gateway applies the step only while its text and what it destroys are what was shown.
 * - data_query: a question by name, or one read of the run's own.
 * - data_change (slice 7, §8; migration 20260930763000): a named change, data/<name>/actions/<change>.sql, which
 *   writes rows as the database folder's write login.
 *
 * Each call asks the platform, as the run, for a data pass (`qorpera_run_data_pass`, migration 20260930750000, through
 * the native host's entry point): the platform keeps each file the run may read under the database's folder, with its
 * hash, and answers 32 random bytes. The tool sends the pass to the gateway's run door with the node's private token;
 * the gateway redeems it once, and works only from what it kept. When the gateway asks for a file's text it does not
 * hold yet (`need`), the tool reads the file with the run's own folder client and asks again with a new pass. No tool
 * holds a database login, and no file's text is used unless its hash is the kept one.
 *
 * The tools are registered only where the execution service names the run door (QORPERA_COMPANY_DATA_URL), so a
 * company never sees a tool that cannot work. None is reviewed (`cloudActionEffect`): describe and query read, and
 * apply only makes the store match steps someone the folder let write them put there; a step that would destroy data is
 * held until a member says yes. A change writes the company's own rows through a file someone the folder let write put
 * there, as company_write writes a file; it may delete rows (the change's own defined act) and may never drop or empty a
 * table, which the gateway rolls back.
 */

export type CloudCompanyDataVerb = "describe" | "apply" | "query" | "change";

/** The gateway's run door: one call, its status and its JSON answer. */
export interface CloudCompanyDataDoor {
	call(
		verb: CloudCompanyDataVerb,
		body: Record<string, JsonValue>,
		signal: AbortSignal,
	): Promise<{ status: number; value: unknown }>;
}

const DATABASE = /^[a-z][a-z0-9_]{0,39}$/;
const QUESTION = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** A held step's allow: the step, the hash of its text, the hash of what it would destroy. */
const ALLOW = /^([0-9]{3}-[a-z0-9]+(?:-[a-z0-9]+)*)\.[0-9a-f]{64}\.[0-9a-f]{64}$/;
const PARAMETER = /^[a-z_][a-z0-9_]{0,39}$/;
/** A read of the agent's own, at most a question file's size. */
const SQL_BYTES = 16 * 1024;
const PARAMETERS = 64;
const PARAMETER_BYTES = 64 * 1024;
/** Rounds of `need` a call answers before it gives up, and the most one round's whole body may hold as JSON (escaping
 * counted): the gateway takes 1 MiB a body. */
const ROUNDS = 8;
const BODY_BYTES = 1024 * 1024;
/** A step's file at most (the gateway's limit); a question's is 16 KiB. */
const FILE_BYTES = 64 * 1024;
/** How long one call to the run door may take: an agent's read takes 15 s at most. An apply call takes longer: the
 * gateway starts no step once 45 s have passed, and a step takes 60 s at most, so it answers within about 105 s. */
const DOOR_MS = 30_000;
const APPLY_MS = 120_000;
/** What data_apply says when its call ended without an answer: the gateway may still be applying. */
const APPLY_UNKNOWN =
	"No answer came from the company's data store, so the steps may still be applying. Call data_describe to see which steps landed, then data_apply again for any still waiting.";
/** What data_change says when its call ended without an answer: the change may have been committed. */
const CHANGE_UNKNOWN =
	"No answer came from the company's data store, so the change may or may not have run. Read the rows with data_query before you run it again, so it does not run twice.";
/** A call whose outcome no one knows when it ends without an answer: never "failed". */
const UNKNOWN: Partial<Record<CloudCompanyDataVerb, string>> = { apply: APPLY_UNKNOWN, change: CHANGE_UNKNOWN };
/** The most an answer of the run door may hold. */
const ANSWER_BYTES = 4 * 1024 * 1024;
/** Printable ASCII and Latin-1 letters: what a refusal may carry to the model (the boundary drops anything else). */
const PLAIN = /[^ -~À-ÿ]/g;

export const DATA_DESCRIBE_DESCRIPTION =
	"Show the company's databases: for each, its tables and views (columns with nullability and defaults, constraints, indexes, view definitions), custom enums and extensions, its steps (applied, waiting, changed after they were applied, or missing) and its questions with their words, and how much room the company's data takes. Name database to see one; without it you see every database you may read.";
export const DATA_APPLY_DESCRIPTION =
	"Apply a database's waiting steps now, in number order, and see how each went: applied, failed with PostgreSQL's words, or held. A held step would destroy data (drop a table or column, delete or empty rows): it waits for a member to say yes, and nothing changes until then. Its answer carries allow: call data_apply again with that allow to ask a member on a card, and on their yes the step is applied. Write the files first with the file tools: data/<database>/database.toml and tables/NNN-<name>.sql.";
export const DATA_CHANGE_DESCRIPTION =
	"Write rows through a database's named change: data/<database>/actions/<change>.sql, one insert, update, delete or merge with :name for each value and -- lines at the top that say what it does, written with the file tools. Give its values in params; params.viewer is the member a change that names :viewer acts for, else the member who asked you. You get changed, the rows it wrote, and what it returns (returning), at most 200 rows and 24 KiB. A change that fails changes nothing.";
export const DATA_QUERY_DESCRIPTION =
	"Read a database: a question by name (data/<database>/queries/<question>.sql) with its params, or one read of your own in sql (one select; :name in it takes params.name). params.viewer is the member a question that names :viewer asks for; without it, the member who asked you. You get columns and rows, at most 200 rows and 24 KiB; more: true means there was more, so narrow the read or page it.";

interface DescribeRequest {
	database?: string;
}
interface Destroyed {
	what: string;
	object: string;
	rows?: number;
}
interface ApplyRequest {
	database: string;
	/** A held step's allow, as its answer gave it: the call asks a member and, on their yes, applies that step. */
	allow?: string;
	/** What the data gateway said that step is and would destroy now (`prepare`): what the member's card shows. */
	step?: string;
	destroys?: Destroyed[];
}
type Params = Record<string, JsonValue>;
interface QueryRequest {
	database: string;
	question?: string;
	sql?: string;
	params?: Params;
}
interface ChangeRequest {
	database: string;
	change: string;
	params?: Params;
}

function object(value: JsonValue, keys: readonly string[]): Record<string, JsonValue> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new CloudToolArgumentRefusal("Arguments must be an object");
	for (const key of Object.keys(value))
		if (!keys.includes(key)) throw new CloudToolArgumentRefusal(`Unknown argument: ${keys.join(", ")} only`);
	return value;
}

function database(value: JsonValue | undefined): string {
	if (typeof value !== "string" || !DATABASE.test(value))
		throw new CloudToolArgumentRefusal(
			"database is the folder's name under data/: a-z, 0-9 and _, starting with a letter, at most 40",
		);
	return value;
}

function parseDescribe(value: JsonValue): DescribeRequest {
	const input = object(value, ["database"]);
	return input.database === undefined || input.database === null ? {} : { database: database(input.database) };
}

function parseApply(value: JsonValue): ApplyRequest {
	const input = object(value, ["database", "allow"]);
	const request: ApplyRequest = { database: database(input.database) };
	if (input.allow !== undefined && input.allow !== null) {
		if (typeof input.allow !== "string" || !ALLOW.test(input.allow))
			throw new CloudToolArgumentRefusal("allow is a held step's allow, as data_apply's answer gave it");
		request.allow = input.allow;
	}
	return request;
}

function isJsonParam(value: unknown, depth = 0): value is JsonValue {
	if (depth > 16) return false;
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every((item) => isJsonParam(item, depth + 1));
	if (typeof value === "object") return Object.values(value).every((item) => isJsonParam(item, depth + 1));
	return false;
}

function parameters(value: JsonValue | undefined): Params | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "object" || Array.isArray(value)) throw new CloudToolArgumentRefusal("params are named values");
	const entries = Object.entries(value);
	if (entries.length > PARAMETERS) throw new CloudToolArgumentRefusal(`At most ${PARAMETERS} params`);
	for (const [name, given] of entries) {
		if (!PARAMETER.test(name)) throw new CloudToolArgumentRefusal("A param's name is a-z, 0-9 and _");
		if (!isJsonParam(given)) throw new CloudToolArgumentRefusal("A param must be a JSON value");
	}
	if (Buffer.byteLength(JSON.stringify(value)) > PARAMETER_BYTES)
		throw new CloudToolArgumentRefusal("params take at most 64 KiB together");
	return value as unknown as Params;
}

function parseChange(value: JsonValue): ChangeRequest {
	const input = object(value, ["database", "change", "params"]);
	if (typeof input.change !== "string" || !QUESTION.test(input.change) || input.change.length > 60)
		throw new CloudToolArgumentRefusal(
			"change is a file's name in actions/ without .sql: a-z, 0-9 and -, at most 60",
		);
	const request: ChangeRequest = { database: database(input.database), change: input.change };
	const params = parameters(input.params);
	if (params) request.params = params;
	return request;
}

function parseQuery(value: JsonValue): QueryRequest {
	const input = object(value, ["database", "question", "sql", "params"]);
	const request: QueryRequest = { database: database(input.database) };
	const hasQuestion = input.question !== undefined && input.question !== null;
	const hasSql = input.sql !== undefined && input.sql !== null;
	if (hasQuestion === hasSql) throw new CloudToolArgumentRefusal("Give question or sql, one of them");
	if (hasQuestion) {
		if (typeof input.question !== "string" || !QUESTION.test(input.question) || input.question.length > 60)
			throw new CloudToolArgumentRefusal(
				"question is a file's name in queries/ without .sql: a-z, 0-9 and -, at most 60",
			);
		request.question = input.question;
	} else {
		if (typeof input.sql !== "string" || input.sql.trim() === "" || Buffer.byteLength(input.sql) > SQL_BYTES)
			throw new CloudToolArgumentRefusal("sql is one read statement of at most 16 KiB");
		request.sql = input.sql;
	}
	const params = parameters(input.params);
	if (params) request.params = params;
	return request;
}

/** A refusal's words as the model may get them: plain characters, at most about 900 bytes. */
function plain(text: string): string {
	const words = text.replace(PLAIN, "?");
	return words.length > 900 ? `${words.slice(0, 900)}...` : words;
}

/** The run door's answer as an object, else the door is unavailable. */
function answerOf(value: unknown): Record<string, unknown> {
	try {
		return parseRecord(value, "Company data answer");
	} catch {
		return refusal(502, value);
	}
}

/** A gateway's answer that is not one: a refusal for the model when it says why, else the door is unavailable. */
function refusal(status: number, value: unknown): never {
	const object = typeof value === "object" && !Array.isArray(value);
	const answer = object ? (value as Record<string, unknown> | null) : null;
	if (status === 401)
		throw new CloudRuntimeDiagnosticError("authority_unavailable", "Company data door refused the run");
	if (status >= 400 && status < 500 && answer && typeof answer.error === "string" && status !== 413) {
		const where = typeof answer.position === "number" ? ` (at character ${answer.position})` : "";
		throw new CloudToolRefusal(plain(`${answer.error}${where}`));
	}
	if (status === 507 && answer && typeof answer.error === "string") throw new CloudToolRefusal(plain(answer.error));
	throw new CloudRuntimeDiagnosticError("transport_unavailable", "Company data door unavailable");
}

/** The answer as one tool result: the JSON as it is when it fits, else each shorter form in turn. */
function shown(forms: readonly (() => unknown)[]): CloudToolContent {
	for (const form of forms) {
		const text = JSON.stringify(form());
		if (fitsOneResult(text)) return { kind: "text", value: text };
	}
	throw new CloudToolRefusal("The answer is too large to show: name one database");
}

export interface CloudDataChangeWakeEvent {
	readonly database: string;
	readonly payload: Readonly<Record<string, unknown>>;
}

function inferDataChangeMeta(
	sqlText: string | null,
	answer: Record<string, unknown>,
	rows: readonly unknown[] | null,
): {
	readonly table?: string;
	readonly tables?: readonly string[];
	readonly operation?: "insert" | "update" | "delete";
	readonly rowId?: string | number;
} {
	const tables = new Set<string>();
	let operation: "insert" | "update" | "delete" | undefined;
	if (typeof answer.table === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(answer.table)) tables.add(answer.table);
	if (Array.isArray(answer.tables)) {
		for (const item of answer.tables) {
			if (typeof item === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(item)) tables.add(item);
		}
	}
	if (answer.operation === "insert" || answer.operation === "update" || answer.operation === "delete") {
		operation = answer.operation;
	}
	if (sqlText) {
		const stripped = sqlText.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
		const insertMatch = /\binsert\s+into\s+(?:"?([a-z][a-z0-9_]{0,63})"?)/i.exec(stripped);
		const updateMatch = /\bupdate\s+(?:"?([a-z][a-z0-9_]{0,63})"?)/i.exec(stripped);
		const deleteMatch = /\bdelete\s+from\s+(?:"?([a-z][a-z0-9_]{0,63})"?)/i.exec(stripped);
		if (!operation) {
			if (insertMatch) operation = "insert";
			else if (updateMatch) operation = "update";
			else if (deleteMatch) operation = "delete";
		}
		for (const match of [insertMatch, updateMatch, deleteMatch]) {
			const tableName = match?.[1]?.toLowerCase();
			if (tableName && /^[a-z][a-z0-9_]{0,63}$/.test(tableName)) tables.add(tableName);
		}
	}
	let rowId: string | number | undefined;
	if (typeof answer.rowId === "string" || typeof answer.rowId === "number") {
		rowId = answer.rowId;
	} else if (rows && rows.length === 1 && Array.isArray(answer.columns)) {
		const idIndex = answer.columns.indexOf("id");
		const firstRow = rows[0];
		if (idIndex >= 0 && Array.isArray(firstRow)) {
			const candidate = firstRow[idIndex];
			if (typeof candidate === "string" || typeof candidate === "number") rowId = candidate;
		} else if (firstRow && typeof firstRow === "object" && !Array.isArray(firstRow)) {
			const candidate = (firstRow as Record<string, unknown>).id;
			if (typeof candidate === "string" || typeof candidate === "number") rowId = candidate;
		}
	}
	const tableList = [...tables];
	return {
		...(tableList.length === 1 ? { table: tableList[0] } : {}),
		...(tableList.length > 0 ? { tables: tableList } : {}),
		...(operation ? { operation } : {}),
		...(rowId !== undefined ? { rowId } : {}),
	};
}

/** The tools, for one run. `apply`: whether the run may write a database, that is apply its steps and run its
 * changes (a worker only reads). */
export function cloudDataTools(options: {
	folder: Pick<CloudCompanyFolderClient, "dataPass" | "readText">;
	door: CloudCompanyDataDoor;
	apply: boolean;
	onDataChanged?: (event: CloudDataChangeWakeEvent, signal: AbortSignal) => Promise<void>;
}): readonly CloudNativeTool[] {
	const { folder, door } = options;

	/** One call: a pass for the database (or for every database), the door, and the texts it asks for. `reviewId`: the
	 * approval of this call, for a pass that carries a member's yes to a held step. */
	const ask = async (
		verb: CloudCompanyDataVerb,
		name: string | null,
		body: Record<string, JsonValue>,
		signal: AbortSignal,
		reviewId?: string,
	): Promise<unknown> => {
		let texts: Record<string, string> | null = null;
		// An apply that only checks a held step applies nothing: when it ends without an answer, nothing may have run.
		const unknown = body.check === undefined ? UNKNOWN[verb] : undefined;
		for (let round = 0; round < ROUNDS; round++) {
			const passed: CloudCompanyDataPass = await folder.dataPass(name, signal, reviewId);
			if (passed.state !== "pass")
				throw new CloudToolRefusal(
					passed.state === "not_approved"
						? "No member has said yes to this step on a card, so nothing changed. Call data_apply with the step's allow again: it asks them."
						: passed.state === "no_database"
							? `No database ${name} that you may read: it needs data/${name}/database.toml (format = "qorpera.database/v1")`
							: passed.state === "too_many_folders"
								? "data/ holds more than 5,000 folders to look through: name one database"
								: name === null
									? "The company's databases hold more than 1,000 files together: name one database"
									: `data/${name}/ holds more than 1,000 files in database.toml, tables/, queries/ and actions/`,
				);
			let answer: Awaited<ReturnType<CloudCompanyDataDoor["call"]>>;
			try {
				answer = await door.call(verb, { ...body, pass: passed.pass, ...(texts ? { texts } : {}) }, signal);
			} catch (error) {
				// An apply or a change whose call ended without an answer has an outcome no one knows: never "failed".
				if (unknown && error instanceof CloudRuntimeDiagnosticError && !signal.aborted)
					throw new CloudToolRefusal(unknown);
				throw error;
			}
			if (unknown && answer.status >= 500 && answer.status !== 507) throw new CloudToolRefusal(unknown);
			if (answer.status !== 200) refusal(answer.status, answer.value);
			const need = answerOf(answer.value).need;
			if (need === undefined) return answer.value;
			if (!Array.isArray(need) || need.length === 0) refusal(502, answer.value);
			// The files the gateway asks for, read as the run: a file changed since the pass is left for the next pass.
			const entries: { path: string; hash: string }[] = [];
			for (const wanted of need) {
				const { path, sha256: hash } = answerOf(wanted);
				if (typeof path !== "string" || typeof hash !== "string") refusal(502, answer.value);
				entries.push({ path, hash });
			}
			texts = {};
			// The next body as the door sends it, each text as JSON escapes it (a hash and its text add `"hash":"text",`).
			let bytes = Buffer.byteLength(JSON.stringify({ ...body, pass: passed.pass, texts: {} }));
			let sent = 0;
			const batchSize = 6;
			for (let offset = 0; offset < entries.length; offset += batchSize) {
				const slice = entries.slice(offset, offset + batchSize);
				const reads = await Promise.all(
					slice.map(async ({ path }) => {
						try {
							return await folder.readText(path, FILE_BYTES, signal);
						} catch (error) {
							if (!(error instanceof CloudCompanyPathNotText)) throw error;
							return null;
						}
					}),
				);
				let full = false;
				for (let i = 0; i < slice.length; i++) {
					const read = reads[i];
					const { hash } = slice[i]!;
					if (!read || read.entry.file.fileSha256 !== hash) continue;
					const size = Buffer.byteLength(JSON.stringify(hash)) + Buffer.byteLength(JSON.stringify(read.text)) + 2;
					if (sent > 0 && bytes + size > BODY_BYTES) {
						full = true;
						break;
					}
					texts[hash] = read.text;
					bytes += size;
					sent++;
				}
				if (full) break;
			}
		}
		throw new CloudToolRefusal("The database's files kept changing while they were read: try again");
	};

	const describe: CloudNativeTool = {
		name: "data_describe" satisfies CloudRuntimeToolOperation,
		source: "runtime",
		description: DATA_DESCRIBE_DESCRIPTION,
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: { database: { type: "string", pattern: DATABASE.source } },
		},
		parseArguments: (value) => parseDescribe(value) as unknown as JsonValue,
		async execute(value, context) {
			const request = value as unknown as DescribeRequest;
			const answer = answerOf(
				await ask(
					"describe",
					request.database ?? null,
					request.database ? { database: request.database } : {},
					context.signal,
				),
			);
			const databases = Array.isArray(answer.databases) ? (answer.databases as Record<string, unknown>[]) : null;
			if (!databases) refusal(502, answer);
			const room = { companyBytes: answer.companyBytes, limitBytes: answer.limitBytes };
			return shown([
				() => answer,
				() => ({
					databases: databases.map((one) => {
						const { enums: _enums, extensions: _extensions, ddlTruncated: _ddlTruncated, ...rest } = one;
						return {
							...rest,
							tables: (Array.isArray(one.tables) ? one.tables : []).map((table: Record<string, unknown>) => ({
								name: table.name,
								kind: table.kind,
								key: table.key,
								...(table.rows !== undefined ? { rows: table.rows } : {}),
								...(table.rowsAbout !== undefined ? { rowsAbout: table.rowsAbout } : {}),
								columns: (Array.isArray(table.columns) ? table.columns : []).map(
									(column: Record<string, unknown>) => ({
										name: column.name,
										type: column.type,
										settable: column.settable,
										...(column.nullable !== undefined ? { nullable: column.nullable } : {}),
									}),
								),
							})),
						};
					}),
					...room,
					note: "Cut short: name one database to see constraints, indexes, view definitions, enums and extensions",
				}),
				// Shorter: each table's columns without their types, each question by name.
				() => ({
					databases: databases.map((one) => {
						const { enums: _enums, extensions: _extensions, ddlTruncated: _ddlTruncated, ...rest } = one;
						return {
							...rest,
							tables: (Array.isArray(one.tables) ? one.tables : []).map((table: Record<string, unknown>) => ({
								name: table.name,
								rows: table.rows,
								columns: (Array.isArray(table.columns) ? table.columns : []).map(
									(column: Record<string, unknown>) => column.name,
								),
							})),
							questions: (Array.isArray(one.questions) ? one.questions : []).map(
								(question: Record<string, unknown>) => question.name,
							),
						};
					}),
					...room,
					note: "Cut short: name one database to see its column types and its questions' words",
				}),
				() => ({
					databases: databases.map((one) => one.database),
					...room,
					note: "Too many to show: name one database",
				}),
			]);
		},
	};

	const apply: CloudNativeTool = {
		name: "data_apply" satisfies CloudRuntimeToolOperation,
		source: "runtime",
		description: DATA_APPLY_DESCRIPTION,
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["database"],
			properties: {
				database: { type: "string", pattern: DATABASE.source },
				// No length is given: an allow is as long as its step's name and two hashes, and a step's name has no
				// bound of its own here (parseApply checks its shape).
				allow: { type: "string" },
			},
		},
		parseArguments: (value) => parseApply(value) as unknown as JsonValue,
		// A call with a held step's allow asks a member (cloudActionEffect: destructive; dataDestroyCheck: always a
		// card). What the card shows is read here from the data gateway, which runs the step and keeps nothing: never
		// from the agent's own words. A step that is no longer held as the allow says is refused before any card.
		async prepare(value, context) {
			const request = value as unknown as ApplyRequest;
			if (request.allow === undefined) return value;
			const answer = answerOf(
				await ask("apply", request.database, { database: request.database, check: request.allow }, context.signal),
			);
			const destroys = Array.isArray(answer.destroys) ? (answer.destroys as Record<string, unknown>[]) : null;
			if (
				typeof answer.step !== "string" ||
				answer.step !== ALLOW.exec(request.allow)?.[1] ||
				!destroys ||
				destroys.length === 0 ||
				destroys.length > 200 ||
				!destroys.every(
					(one) =>
						typeof one.what === "string" &&
						typeof one.object === "string" &&
						(one.rows === undefined || Number.isSafeInteger(one.rows)),
				)
			)
				refusal(502, answer);
			return {
				database: request.database,
				allow: request.allow,
				step: answer.step,
				destroys: destroys.map((one) => ({
					what: one.what as string,
					object: one.object as string,
					...(one.rows === undefined ? {} : { rows: one.rows as number }),
				})),
			};
		},
		async execute(value, context) {
			const request = value as unknown as ApplyRequest;
			// A step is applied on a member's yes only: the review's approval of this very call, which the platform
			// checks when it makes the pass.
			if (request.allow !== undefined && context.actionReviewId === undefined)
				throw new CloudToolRefusal(
					"A step that destroys data is applied only after a member says yes on a card, and no card can be raised here. Nothing changed.",
				);
			const answer = answerOf(
				await ask(
					"apply",
					request.database,
					{ database: request.database },
					context.signal,
					request.allow === undefined ? undefined : context.actionReviewId,
				),
			);
			const results = Array.isArray(answer.results) ? (answer.results as Record<string, unknown>[]) : null;
			if (!results || typeof answer.applied !== "boolean") refusal(502, answer);
			// A held step says what it would destroy and how a member is asked: with its allow.
			const told = results
				.filter((result) => result.state !== "already")
				.map((result) =>
					result.state === "held"
						? {
								...result,
								detail:
									typeof result.detail === "string" && result.detail.includes("not what a member said yes to")
										? "What it would destroy is no longer what the member said yes to, so nothing changed. To ask them again, call data_apply with this step's new allow."
										: "It would destroy data, so it waits for a member to say yes; nothing changed. To ask them, call data_apply again with this step's allow.",
							}
						: result,
				);
			const already = results.length - told.length;
			const summary = {
				database: request.database,
				applied: answer.applied,
				...(already > 0 ? { alreadyApplied: already } : {}),
				steps: told,
				// The gateway starts no step after 45 s: the rest wait for the next call.
				...(answer.more === true
					? { more: true, note: "Steps are still waiting: call data_apply again to apply them" }
					: {}),
			};
			return shown([
				() => summary,
				() => ({
					...summary,
					steps: told.slice(0, 20),
					note: `Cut short: the first 20 steps${answer.more === true ? "; steps are still waiting: call data_apply again" : ""}`,
				}),
			]);
		},
	};

	const query: CloudNativeTool = {
		name: "data_query" satisfies CloudRuntimeToolOperation,
		source: "runtime",
		description: DATA_QUERY_DESCRIPTION,
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["database"],
			properties: {
				database: { type: "string", pattern: DATABASE.source },
				question: { type: "string", maxLength: 60 },
				sql: { type: "string", maxLength: SQL_BYTES },
				params: {
					type: "object",
					additionalProperties: true,
				},
			},
		},
		parseArguments: (value) => parseQuery(value) as unknown as JsonValue,
		async execute(value, context) {
			const request = value as unknown as QueryRequest;
			const body: Record<string, JsonValue> = {
				database: request.database,
				...(request.question !== undefined ? { question: request.question } : { sql: request.sql ?? "" }),
				...(request.params ? { params: request.params } : {}),
			};
			const answer = answerOf(await ask("query", request.database, body, context.signal));
			const rows = Array.isArray(answer.rows) ? (answer.rows as unknown[]) : null;
			if (!rows || !Array.isArray(answer.columns) || typeof answer.more !== "boolean") refusal(502, answer);
			// The answer whole when it fits one result; else as many rows as fit, with more.
			const page = (count: number) => ({
				columns: answer.columns,
				rows: rows.slice(0, count),
				more: answer.more === true || count < rows.length,
				asOf: answer.asOf,
			});
			const forms: (() => unknown)[] = [() => page(rows.length)];
			for (let count = rows.length >> 1; count > 0; count >>= 1) forms.push(() => page(count));
			forms.push(() => page(0));
			return shown(forms);
		},
	};

	const change: CloudNativeTool = {
		name: "data_change" satisfies CloudRuntimeToolOperation,
		source: "runtime",
		description: DATA_CHANGE_DESCRIPTION,
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["database", "change"],
			properties: {
				database: { type: "string", pattern: DATABASE.source },
				change: { type: "string", maxLength: 60 },
				params: {
					type: "object",
					additionalProperties: true,
				},
			},
		},
		parseArguments: (value) => parseChange(value) as unknown as JsonValue,
		async execute(value, context) {
			const request = value as unknown as ChangeRequest;
			const body: Record<string, JsonValue> = {
				database: request.database,
				change: request.change,
				...(request.params ? { params: request.params } : {}),
			};
			const answer = answerOf(await ask("change", request.database, body, context.signal));
			// A statement that gives rows back has columns, rows and more; one that does not has none of them.
			const rows =
				answer.rows === undefined ? null : Array.isArray(answer.rows) ? (answer.rows as unknown[]) : undefined;
			if (
				rows === undefined ||
				(answer.changed !== undefined && !Number.isSafeInteger(answer.changed)) ||
				(rows !== null && (!Array.isArray(answer.columns) || typeof answer.more !== "boolean"))
			)
				refusal(502, answer);
			const done = {
				database: request.database,
				change: request.change,
				...(answer.changed === undefined ? {} : { changed: answer.changed }),
			};
			if (options.onDataChanged && (answer.changed === undefined || (answer.changed as number) > 0)) {
				let actionSql: string | null = null;
				try {
					const read = await folder.readText(
						`data/${request.database}/actions/${request.change}.sql`,
						FILE_BYTES,
						context.signal,
					);
					actionSql = read?.text ?? null;
				} catch {
					actionSql = null;
				}
				const meta = inferDataChangeMeta(actionSql, answer, rows);
				const eventKey = `${request.database}:${request.change}:${String(answer.asOf ?? Date.now())}:${String(meta.rowId ?? "")}`;
				await options
					.onDataChanged(
						{
							database: request.database,
							payload: {
								eventKey,
								change: request.change,
								...meta,
								...(typeof answer.asOf === "string" ? { at: answer.asOf } : {}),
							},
						},
						context.signal,
					)
					.catch(() => undefined);
			}
			if (rows === null) return shown([() => ({ ...done, asOf: answer.asOf })]);
			// The change ran whole; what it gave back is shown whole when it fits one result, else as many rows as fit.
			const page = (count: number) => ({
				...done,
				columns: answer.columns,
				rows: rows.slice(0, count),
				more: answer.more === true || count < rows.length,
				asOf: answer.asOf,
			});
			const forms: (() => unknown)[] = [() => page(rows.length)];
			for (let count = rows.length >> 1; count > 0; count >>= 1) forms.push(() => page(count));
			forms.push(() => page(0));
			return shown(forms);
		},
	};

	return options.apply ? [describe, apply, query, change] : [describe, query];
}

/** The run door over HTTPS: the CA pinned (the store's kit signs the gateway's certificate), the node's private token
 * as the bearer, never pooled or redirected, the answer bounded in bytes and time. */
export function httpsCompanyDataDoor(options: { url: string; ca: string; token: string }): CloudCompanyDataDoor {
	const url = new URL(options.url);
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname !== "/" ||
		!/^[A-Za-z0-9_-]{43}$/.test(options.token) ||
		!options.ca.includes("-----BEGIN CERTIFICATE-----")
	)
		throw new Error("Invalid company data door configuration");
	const host = url.hostname.replace(/^\[|\]$/g, "");
	const port = url.port ? Number(url.port) : 443;
	const agent = new HttpsAgent({
		keepAlive: true,
		keepAliveMsecs: 30_000,
		maxSockets: 8,
		maxFreeSockets: 4,
		ca: options.ca,
		minVersion: "TLSv1.2",
	});
	return {
		call: (verb, body, signal) =>
			withAbortScopes(
				[signal],
				(stop) =>
					new Promise((resolve, reject) => {
						if (stop.aborted)
							return reject(new CloudRuntimeDiagnosticError("cancelled", "Company data door call ended"));
						const text = Buffer.from(JSON.stringify(body));
						let failure: CloudRuntimeDiagnosticError | undefined;
						const outgoing = httpsRequest(
							{
								host,
								port,
								ca: options.ca,
								minVersion: "TLSv1.2",
								method: "POST",
								path: `/v1/run-data/${verb}`,
								headers: {
									authorization: `Bearer ${options.token}`,
									"content-type": "application/json",
									"content-length": String(text.byteLength),
								},
								agent,
							},
							(response) => {
								const chunks: Buffer[] = [];
								let bytes = 0;
								response.on("data", (chunk: Buffer) => {
									bytes += chunk.byteLength;
									if (bytes > ANSWER_BYTES) {
										failure ??= new CloudRuntimeDiagnosticError(
											"invalid_response",
											"Company data answer is too large",
										);
										reject(failure);
										response.destroy(failure);
									} else chunks.push(chunk);
								});
								response.once("error", (error) => reject(failure ?? error));
								response.once("end", () => {
									let value: unknown;
									try {
										const joined = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, bytes);
										value = JSON.parse(joined.toString("utf8"));
									} catch {
										reject(
											new CloudRuntimeDiagnosticError("invalid_response", "Company data answer is not JSON"),
										);
										return;
									}
									resolve({ status: response.statusCode ?? 0, value });
								});
							},
						);
						const end = (): void => {
							outgoing.destroy(
								new CloudRuntimeDiagnosticError("transport_unavailable", "Company data door call ended"),
							);
						};
						stop.addEventListener("abort", end, { once: true });
						outgoing.once("close", () => stop.removeEventListener("abort", end));
						outgoing.once("error", () =>
							reject(
								failure ??
									(signal.aborted
										? new CloudRuntimeDiagnosticError("cancelled", "Company data door call ended")
										: new CloudRuntimeDiagnosticError(
												"transport_unavailable",
												"Company data door unavailable",
											)),
							),
						);
						outgoing.end(text);
					}),
				verb === "apply" ? APPLY_MS : DOOR_MS,
			),
	};
}
