import { request as httpsRequest } from "node:https";
import type { JsonValue } from "@qorpera/contracts";
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
 * - data_apply: applies a database's waiting steps and says how each went.
 * - data_query: a question by name, or one read of the run's own.
 *
 * Each call asks the platform, as the run, for a data pass (`qorpera_run_data_pass`, migration 20260930750000, through
 * the native host's entry point): the platform keeps each file the run may read under the database's folder, with its
 * hash, and answers 32 random bytes. The tool sends the pass to the gateway's run door with the node's private token;
 * the gateway redeems it once, and works only from what it kept. When the gateway asks for a file's text it does not
 * hold yet (`need`), the tool reads the file with the run's own folder client and asks again with a new pass. No tool
 * holds a database login, and no file's text is used unless its hash is the kept one.
 *
 * The three tools are registered only where the execution service names the run door (QORPERA_COMPANY_DATA_URL), so a
 * company never sees a tool that cannot work. None is reviewed (`cloudActionEffect`): describe and query read, and
 * apply only makes the store match steps someone the folder let write them put there; a step that would destroy data is
 * held until a member says yes.
 */

export type CloudCompanyDataVerb = "describe" | "apply" | "query";

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
const PARAMETER = /^[a-z_][a-z0-9_]{0,39}$/;
/** A read of the agent's own, at most a question file's size. */
const SQL_BYTES = 16 * 1024;
/** Parameters, as a question file takes them: 16 at most, 4 KiB together. */
const PARAMETERS = 16;
const PARAMETER_BYTES = 4096;
/** Rounds of `need` a call answers before it gives up, and the texts one round sends: the gateway takes 1 MiB a body. */
const ROUNDS = 8;
const TEXT_BYTES = 768 * 1024;
/** A step's file at most (the gateway's limit); a question's is 16 KiB. */
const FILE_BYTES = 64 * 1024;
/** How long one call to the run door may take: an agent's read takes 15 s at most. */
const DOOR_MS = 30_000;
/** The most an answer of the run door may hold. */
const ANSWER_BYTES = 4 * 1024 * 1024;
/** Printable ASCII and Latin-1 letters: what a refusal may carry to the model (the boundary drops anything else). */
const PLAIN = /[^ -~À-ÿ]/g;

export const DATA_DESCRIBE_DESCRIPTION =
	"Show the company's databases: for each, its tables and columns, its steps (applied, waiting, changed after they were applied, or missing) and its questions with their words, and how much room the company's data takes. Name database to see one; without it you see every database you may read.";
export const DATA_APPLY_DESCRIPTION =
	"Apply a database's waiting steps now, in number order, and see how each went: applied, failed with PostgreSQL's words, or held. A held step would destroy data (drop a table or column, delete or empty rows): it waits for a member to say yes, and nothing changes until then. Write the files first with the file tools: data/<database>/database.toml and tables/NNN-<name>.sql.";
export const DATA_QUERY_DESCRIPTION =
	"Read a database: a question by name (data/<database>/queries/<question>.sql) with its params, or one read of your own in sql (one select; :name in it takes params.name). params.viewer is the member a question that names :viewer asks for; without it, the member who asked you. You get columns and rows, at most 200 rows and 24 KiB; more: true means there was more, so narrow the read or page it.";

interface DescribeRequest {
	database?: string;
}
interface ApplyRequest {
	database: string;
}
interface QueryRequest {
	database: string;
	question?: string;
	sql?: string;
	params?: Record<string, string | number | boolean | null>;
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
	return { database: database(object(value, ["database"]).database) };
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
	if (input.params !== undefined && input.params !== null) {
		const params = input.params;
		if (typeof params !== "object" || Array.isArray(params))
			throw new CloudToolArgumentRefusal("params are named values");
		const entries = Object.entries(params);
		if (entries.length > PARAMETERS) throw new CloudToolArgumentRefusal(`At most ${PARAMETERS} params`);
		for (const [name, given] of entries) {
			if (!PARAMETER.test(name)) throw new CloudToolArgumentRefusal("A param's name is a-z, 0-9 and _");
			if (
				!(given === null || typeof given === "string" || typeof given === "boolean") &&
				!(typeof given === "number" && Number.isFinite(given))
			)
				throw new CloudToolArgumentRefusal("A param is text, a number, true, false or null");
		}
		if (Buffer.byteLength(JSON.stringify(params)) > PARAMETER_BYTES)
			throw new CloudToolArgumentRefusal("params take at most 4 KiB together");
		request.params = params as unknown as QueryRequest["params"];
	}
	return request;
}

/** A refusal's words as the model may get them: plain characters, at most about 900 bytes. */
function plain(text: string): string {
	const words = text.replace(PLAIN, "?");
	return words.length > 900 ? `${words.slice(0, 900)}...` : words;
}

function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** A gateway's answer that is not one: a refusal for the model when it says why, else the door is unavailable. */
function refusal(status: number, value: unknown): never {
	const answer = record(value);
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

/** The three tools, for one run. `apply`: whether the run may apply steps (a worker only reads). */
export function cloudDataTools(options: {
	folder: Pick<CloudCompanyFolderClient, "dataPass" | "readText">;
	door: CloudCompanyDataDoor;
	apply: boolean;
}): readonly CloudNativeTool[] {
	const { folder, door } = options;

	/** One call: a pass for the database (or for every database), the door, and the texts it asks for. */
	const ask = async (
		verb: CloudCompanyDataVerb,
		name: string | null,
		body: Record<string, JsonValue>,
		signal: AbortSignal,
	): Promise<unknown> => {
		let texts: Record<string, string> | null = null;
		for (let round = 0; round < ROUNDS; round++) {
			const passed: CloudCompanyDataPass = await folder.dataPass(name, signal);
			if (passed.state === "no_database")
				throw new CloudToolRefusal(
					`No database ${name} that you may read: it needs data/${name}/database.toml (format = "qorpera.database/v1")`,
				);
			if (passed.state === "too_many_files")
				throw new CloudToolRefusal(
					name === null
						? "The company's databases hold more than 1,000 files together: name one database"
						: `data/${name}/ holds more than 1,000 files in database.toml, tables/, queries/ and actions/`,
				);
			const answer = await door.call(verb, { ...body, pass: passed.pass, ...(texts ? { texts } : {}) }, signal);
			if (answer.status !== 200) refusal(answer.status, answer.value);
			const need = record(answer.value)?.need;
			if (need === undefined) return answer.value;
			if (!Array.isArray(need) || need.length === 0) refusal(502, answer.value);
			// The files the gateway asks for, read as the run: a file changed since the pass is left for the next pass.
			texts = {};
			let bytes = 0;
			for (const wanted of need) {
				const path = record(wanted)?.path;
				const hash = record(wanted)?.sha256;
				if (typeof path !== "string" || typeof hash !== "string") refusal(502, answer.value);
				let read: Awaited<ReturnType<typeof folder.readText>> = null;
				try {
					read = await folder.readText(path, FILE_BYTES, signal);
				} catch (error) {
					if (!(error instanceof CloudCompanyPathNotText)) throw error;
				}
				if (!read || read.entry.file.fileSha256 !== hash) continue;
				const size = Buffer.byteLength(read.text);
				if (bytes > 0 && bytes + size > TEXT_BYTES) break;
				texts[hash] = read.text;
				bytes += size;
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
			const answer = record(
				await ask(
					"describe",
					request.database ?? null,
					request.database ? { database: request.database } : {},
					context.signal,
				),
			);
			const databases = Array.isArray(answer?.databases) ? (answer.databases as Record<string, unknown>[]) : null;
			if (!answer || !databases) refusal(502, answer);
			const room = { companyBytes: answer.companyBytes, limitBytes: answer.limitBytes };
			return shown([
				() => answer,
				// Shorter: each table's columns without their types, each question by name.
				() => ({
					databases: databases.map((one) => ({
						...one,
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
					})),
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
			properties: { database: { type: "string", pattern: DATABASE.source } },
		},
		parseArguments: (value) => parseApply(value) as unknown as JsonValue,
		async execute(value, context) {
			const request = value as unknown as ApplyRequest;
			const answer = record(await ask("apply", request.database, { database: request.database }, context.signal));
			const results = Array.isArray(answer?.results) ? (answer.results as Record<string, unknown>[]) : null;
			if (!answer || !results || typeof answer.applied !== "boolean") refusal(502, answer);
			// A held step says what it would destroy and that a member must say yes.
			const told = results
				.filter((result) => result.state !== "already")
				.map((result) =>
					result.state === "held"
						? {
								...result,
								detail:
									"It would destroy data, so it waits for a member to say yes; nothing changed. Tell the member what it would destroy.",
							}
						: result,
				);
			const already = results.length - told.length;
			const summary = {
				database: request.database,
				applied: answer.applied,
				...(already > 0 ? { alreadyApplied: already } : {}),
				steps: told,
			};
			return shown([
				() => summary,
				() => ({ ...summary, steps: told.slice(0, 20), note: "Cut short: the first 20 steps" }),
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
					additionalProperties: { type: ["string", "number", "boolean", "null"] },
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
			const answer = record(await ask("query", request.database, body, context.signal));
			const rows = Array.isArray(answer?.rows) ? (answer.rows as unknown[]) : null;
			if (!answer || !rows || !Array.isArray(answer.columns) || typeof answer.more !== "boolean")
				refusal(502, answer);
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

	return options.apply ? [describe, apply, query] : [describe, query];
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
	return {
		call: (verb, body, signal) =>
			new Promise((resolve, reject) => {
				const stop = AbortSignal.any([signal, AbortSignal.timeout(DOOR_MS)]);
				if (stop.aborted)
					return reject(new CloudRuntimeDiagnosticError("cancelled", "Company data door call ended"));
				const text = Buffer.from(JSON.stringify(body));
				/** Why the answer was cut off, when the tool cut it: the request then ends with this, not a transport error. */
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
						agent: false,
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
								value = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
							} catch {
								reject(new CloudRuntimeDiagnosticError("invalid_response", "Company data answer is not JSON"));
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
								: new CloudRuntimeDiagnosticError("transport_unavailable", "Company data door unavailable")),
					),
				);
				outgoing.end(text);
			}),
	};
}
