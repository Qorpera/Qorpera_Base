import { createHash, randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import {
	isUuid,
	type JsonValue,
	parseRunBoxReply,
	RUN_BOX_COMPANY,
	RUN_BOX_LINE_LIMIT,
	RUN_BOX_MAX_SESSION,
	RUN_BOX_MAX_TEXT_LENGTH,
	RUN_BOX_MAX_YIELD_MS,
	type RunBoxReply,
	type RunBoxRequest,
} from "@qorpera/contracts";
import {
	type CloudCompanyFolderAuthority,
	type CloudCompanyFolderClient,
	CloudCompanyFolderError,
	type CloudCompanyFolderRelease,
} from "./cloud-company-folder-client.ts";
import { type CloudNativeTool, type CloudToolContent, CloudToolRefusal } from "./cloud-native-tool-boundary.ts";

/**
 * The run box's tools (F3 step 2b-3; deploy/first-node/RUNTIME-FOLDER-SERVICE.md, "Step 2b"): `exec_command` and
 * `write_stdin`, shaped like Codex's own, run by the native host in the run's box on the shared execution host. The
 * box (2b-1) has the company folder read-only at /company, no network and no credentials; its folder program (2b-2)
 * logs what each command opens or lists. Every answer releases those reads with the run's own authority before the
 * model sees it, so the next model request's context view can cite them, and a read the run may no longer make
 * withholds the answer.
 *
 * Nothing the box sends is trusted: each line is checked (`parseRunBoxReply`), bounded and fitted here.
 */

/** How long a call waits for the box to appear (it starts beside the run). */
const BOX_WAIT_MS = 10_000;
/** Past the yield the box was asked for, how long its answer may take before the call gives up on it. */
const ANSWER_GRACE_MS = 5_000;
/** Output asked of the box per answer. The tool result envelope is 8 KiB and cut head-only, so the shown text, escaped
 * as JSON, must fit its own head and tail in about 6 KiB. */
const OUTPUT_BYTES = 4_096;
const SHOWN_JSON_BYTES = 6_000;
const DEFAULT_EXEC_YIELD_MS = 10_000;
const DEFAULT_WRITE_YIELD_MS = 250;
/** What the core records in one release; more reads go in several, all with the answer's hash. */
const MAX_RELEASED = 10_000;
/** Reads taken from the box's log per request, and how long one page may take. */
const READS_PAGE = 2_000;
const READS_PAGE_MS = 30_000;
/** A read whose receipt the box's folder program did not have: the core checks such a path again at release. */
const NO_RECEIPT: CloudCompanyFolderAuthority = {
	resourceId: "00000000-0000-0000-0000-000000000000",
	resourceRevision: 0,
	grantId: null,
	grantRevision: null,
};

export interface CloudRunBoxPaths {
	/** The box host's socket (`/run/qorpera-shared-box/N.sock`). */
	readonly socket: string;
	/** The box folder program's read log (`/run/qorpera-shared-box/N.reads`). */
	readonly reads: string;
}

/** One line at a time over a Unix socket; any fault ends the connection. */
class LineSocket {
	readonly #socket: Socket;
	#buffer = "";
	#lines: string[] = [];
	#waiting: ((line: string | undefined) => void) | undefined;
	#closed = false;

	private constructor(socket: Socket) {
		this.#socket = socket;
		socket.setEncoding("utf8");
		socket.on("data", (text: string) => {
			this.#buffer += text;
			for (let newline = this.#buffer.indexOf("\n"); newline >= 0; newline = this.#buffer.indexOf("\n")) {
				const line = this.#buffer.slice(0, newline);
				this.#buffer = this.#buffer.slice(newline + 1);
				this.#deliver(line);
			}
			if (this.#buffer.length > RUN_BOX_LINE_LIMIT * 64) this.close();
		});
		socket.on("error", () => this.close());
		socket.on("close", () => this.close());
	}

	static async open(path: string, signal: AbortSignal): Promise<LineSocket | undefined> {
		const socket = connect(path);
		const opened = await new Promise<boolean>((resolve) => {
			socket.once("connect", () => resolve(true));
			socket.once("error", () => resolve(false));
			signal.addEventListener("abort", () => resolve(false), { once: true });
		});
		if (!opened) {
			socket.destroy();
			return undefined;
		}
		return new LineSocket(socket);
	}

	get closed(): boolean {
		return this.#closed;
	}

	send(line: string): void {
		this.#socket.write(`${line}\n`);
	}

	/** The next line, or undefined once closed, aborted or past `ms`. */
	next(ms: number, signal: AbortSignal): Promise<string | undefined> {
		const line = this.#lines.shift();
		if (line !== undefined) return Promise.resolve(line);
		if (this.#closed) return Promise.resolve(undefined);
		return new Promise((resolve) => {
			const timer = setTimeout(() => finish(undefined), ms);
			const abort = (): void => finish(undefined);
			const finish = (value: string | undefined): void => {
				clearTimeout(timer);
				signal.removeEventListener("abort", abort);
				this.#waiting = undefined;
				resolve(value);
			};
			signal.addEventListener("abort", abort, { once: true });
			this.#waiting = finish;
		});
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#socket.destroy();
		this.#waiting?.(undefined);
	}

	#deliver(line: string): void {
		if (this.#waiting) this.#waiting(line);
		else this.#lines.push(line);
	}
}

/** The run's box: one connection, opened when first needed and again after the box restarted. */
export class CloudRunBox {
	readonly #paths: CloudRunBoxPaths;
	readonly #waitMs: number;
	#connection: LineSocket | undefined;

	/** `waitMs`: how long a call waits for the box to appear (tests shorten it). */
	constructor(paths: CloudRunBoxPaths, waitMs = BOX_WAIT_MS) {
		this.#paths = paths;
		this.#waitMs = waitMs;
	}

	async request(request: RunBoxRequest, signal: AbortSignal): Promise<RunBoxReply> {
		const connection = await this.#connect(signal);
		connection.send(JSON.stringify(request));
		const line = await connection.next(request.yieldMs + ANSWER_GRACE_MS, signal);
		if (line === undefined) {
			connection.close();
			throw new CloudToolRefusal(
				"RUN_BOX_UNAVAILABLE: the run box did not answer; its commands may have ended. Try again, or read with company_read",
			);
		}
		let reply: RunBoxReply;
		try {
			reply = parseRunBoxReply(line, request.maxOutputBytes);
		} catch {
			connection.close();
			throw new CloudToolRefusal(
				"RUN_BOX_UNAVAILABLE: the run box answered something it should not have; try again",
			);
		}
		if (reply.t === "ready" || reply.id !== request.id) {
			connection.close();
			throw new CloudToolRefusal("RUN_BOX_UNAVAILABLE: the run box answered another request; try again");
		}
		return reply;
	}

	/** Everything the box read since the last take. */
	async takeReads(signal: AbortSignal): Promise<CloudCompanyFolderRelease[]> {
		const log = await LineSocket.open(this.#paths.reads, signal);
		if (!log) throw new Error("The run box's read log is unavailable");
		try {
			const reads: CloudCompanyFolderRelease[] = [];
			for (;;) {
				log.send(JSON.stringify({ t: "take", max: READS_PAGE }));
				const line = await log.next(READS_PAGE_MS, signal);
				if (line === undefined) throw new Error("The run box's read log did not answer");
				const answer = parseReads(line);
				reads.push(...answer.reads);
				if (!answer.more) return reads;
			}
		} finally {
			log.close();
		}
	}

	async #connect(signal: AbortSignal): Promise<LineSocket> {
		if (this.#connection && !this.#connection.closed) return this.#connection;
		const started = Date.now();
		for (;;) {
			const connection = await LineSocket.open(this.#paths.socket, signal);
			if (connection) {
				const ready = await connection.next(5_000, signal);
				try {
					if (ready !== undefined && parseRunBoxReply(ready).t === "ready") {
						this.#connection = connection;
						return connection;
					}
				} catch {}
				connection.close();
			}
			signal.throwIfAborted();
			if (Date.now() - started > this.#waitMs)
				throw new CloudToolRefusal(
					"RUN_BOX_UNAVAILABLE: this run has no run box (it starts beside the run, on the shared execution host only); read with company_read and company_list instead",
				);
			await delay(250, undefined, { signal });
		}
	}
}

function parseReads(line: string): { reads: CloudCompanyFolderRelease[]; more: boolean } {
	const value = JSON.parse(line) as { t?: unknown; reads?: unknown; more?: unknown };
	if (
		value.t !== "reads" ||
		!Array.isArray(value.reads) ||
		typeof value.more !== "boolean" ||
		value.reads.length > READS_PAGE
	)
		throw new Error("The run box's read log answered something else");
	return {
		more: value.more,
		reads: value.reads.map((item: unknown) => {
			const read = item as { path?: unknown; kind?: unknown; version?: unknown; authority?: unknown };
			if (typeof read.path !== "string" || typeof read.version !== "string" || !isUuid(read.version))
				throw new Error("The run box's read log named a read it should not");
			const authority = read.authority as Partial<CloudCompanyFolderAuthority> | undefined;
			const receipt =
				authority &&
				typeof authority.resourceId === "string" &&
				isUuid(authority.resourceId) &&
				Number.isSafeInteger(authority.resourceRevision) &&
				(authority.grantId === null
					? authority.grantRevision === null
					: typeof authority.grantId === "string" &&
						isUuid(authority.grantId) &&
						Number.isSafeInteger(authority.grantRevision))
					? (authority as CloudCompanyFolderAuthority)
					: NO_RECEIPT;
			return { path: read.path, version: read.version, authority: receipt };
		}),
	};
}

/** The release ids of one answer: derived from the run and the call, so a replay of the call reuses them. */
function releaseId(runId: string, callId: string, part: number): string {
	const hex = createHash("sha256").update(`qorpera.run-box-release/v1:${runId}:${callId}:${part}`).digest("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${((Number.parseInt(hex[16] as string, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function jsonBytes(text: string): number {
	return Buffer.byteLength(JSON.stringify(text));
}

/** Code points `[0, n)` or the last `n`, without cutting a character. */
function firstChars(text: string, n: number): string {
	return Array.from(text).slice(0, n).join("");
}
function lastChars(text: string, n: number): string {
	const chars = Array.from(text);
	return chars.slice(Math.max(0, chars.length - n)).join("");
}

/** What the model is shown of one answer: how the command stands, then its output, fitted so the result's envelope
 * keeps its tail (it is cut head-only past 8 KiB). */
export function runBoxAnswerText(reply: Extract<RunBoxReply, { t: "result" }>): string {
	const status =
		reply.session !== null
			? `Process running with session ID ${reply.session}`
			: reply.signal !== null
				? `Process ended by ${reply.signal}`
				: `Process exited with code ${reply.exitCode}`;
	let head = reply.output.head;
	let tail = reply.output.tail;
	let skipped = reply.output.skippedBytes;
	const render = (): string => {
		const note =
			skipped > 0
				? `\n[${skipped} bytes not shown${reply.logPath ? `; the whole output is in ${reply.logPath}` : ""}]\n`
				: "";
		return `${status}\nWall time: ${(reply.wallMs / 1000).toFixed(1)} s\nOutput:\n${head}${note}${tail}`;
	};
	let text = render();
	while (jsonBytes(text) > SHOWN_JSON_BYTES && (head.length > 0 || tail.length > 0)) {
		const before = Buffer.byteLength(head) + Buffer.byteLength(tail);
		// Keep a quarter of what remains for the head and the rest for the tail, a fifth smaller each time.
		const headChars = Array.from(head).length;
		const tailChars = Array.from(tail).length;
		head = firstChars(head, Math.floor(headChars * 0.8));
		tail = lastChars(tail, Math.floor(tailChars * 0.8));
		skipped += before - Buffer.byteLength(head) - Buffer.byteLength(tail);
		text = render();
	}
	return text;
}

/**
 * Releases what the box read for one answer, with the run's own authority, under the hash of the exact text the model
 * is shown. More than one release's worth goes in several, all with that hash; the answer cites the first. No reads,
 * no release and no citation.
 */
async function releaseAnswer(
	folder: CloudCompanyFolderClient,
	runId: string,
	callId: string,
	reads: readonly CloudCompanyFolderRelease[],
	text: string,
	signal: AbortSignal,
): Promise<string | undefined> {
	if (reads.length === 0) return undefined;
	const outputSha256 = createHash("sha256").update(text, "utf8").digest("hex");
	let first: string | undefined;
	for (let part = 0; part * MAX_RELEASED < reads.length; part++) {
		const id = releaseId(runId, callId, part);
		try {
			await folder.release(id, reads.slice(part * MAX_RELEASED, (part + 1) * MAX_RELEASED), outputSha256, signal);
		} catch (error) {
			if (error instanceof CloudCompanyFolderError && error.failure === "read_revoked")
				throw new CloudToolRefusal(
					"READ_REVOKED: something this command read may no longer be read by you, so its output is not shown",
				);
			if (error instanceof CloudCompanyFolderError)
				throw new CloudToolRefusal(
					`COMPANY_FOLDER_UNAVAILABLE: the command ran, but what it read could not be recorded (${error.failure}), so its output is not shown; try again`,
				);
			throw error;
		}
		first ??= id;
	}
	return first;
}

function closedArguments(value: JsonValue, keys: readonly string[], label: string): Record<string, JsonValue> {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new Error(`${label} must be an object`);
	for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`${label} does not take ${key}`);
	return value as Record<string, JsonValue>;
}

function yieldOf(value: JsonValue | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > RUN_BOX_MAX_YIELD_MS)
		throw new Error(`yield_time_ms must be a whole number from 0 to ${RUN_BOX_MAX_YIELD_MS}`);
	return value;
}

const BOX_DESCRIPTION =
	`Your run box: a Linux machine of your own for this run, with the company folder read-only at ${RUN_BOX_COMPANY} (where commands start), ` +
	"no network, and rg, fd, jq, python3 (pandas, openpyxl, python-docx, pypdf), sqlite3, pandoc, pdftotext, ImageMagick (convert), " +
	"soffice (LibreOffice, --headless --convert-to) and zip. Your home and /tmp are yours for this run and go with it; " +
	"nothing here changes the company folder (save with company_write). ";

/** `exec_command` and `write_stdin`, for a run whose box is `box`. */
export function cloudRunBoxTools(options: {
	box: CloudRunBox;
	folder: CloudCompanyFolderClient;
	runId: string;
}): CloudNativeTool[] {
	const { box, folder, runId } = options;
	const answer = async (request: RunBoxRequest, callId: string, signal: AbortSignal): Promise<CloudToolContent> => {
		const reply = await box.request(request, signal);
		if (reply.t === "error") throw new CloudToolRefusal(`${reply.code}: ${reply.message}`.slice(0, 600));
		if (reply.t !== "result") throw new CloudToolRefusal("RUN_BOX_UNAVAILABLE: the run box answered something else");
		const text = runBoxAnswerText(reply);
		let reads: CloudCompanyFolderRelease[];
		try {
			reads = await box.takeReads(signal);
		} catch {
			throw new CloudToolRefusal(
				"RUN_BOX_UNAVAILABLE: the run box's read log did not answer, so this output is not shown; try again",
			);
		}
		const companyReadId = await releaseAnswer(folder, runId, callId, reads, text, signal);
		return { kind: "text", value: text, ...(companyReadId ? { companyReadId } : {}) };
	};
	return [
		{
			name: "exec_command",
			description:
				`${BOX_DESCRIPTION}Runs a command there with bash. Answers when it ends or when yield_time_ms has passed; ` +
				"a command still running keeps going, under the session ID the answer gives: read on with write_stdin. " +
				"Long output shows its start and end, and the whole of it stays in the box at the path the answer gives.",
			source: "company_file",
			inputSchema: {
				type: "object",
				additionalProperties: false,
				required: ["cmd"],
				properties: {
					cmd: { type: "string", description: "The command, run with bash." },
					workdir: {
						type: "string",
						description: `Where to run it: an absolute path in the box, or one relative to ${RUN_BOX_COMPANY} (the default).`,
					},
					yield_time_ms: {
						type: "integer",
						minimum: 0,
						maximum: RUN_BOX_MAX_YIELD_MS,
						description: `How long to wait for the command before answering (default ${DEFAULT_EXEC_YIELD_MS}).`,
					},
					tty: {
						type: "boolean",
						description: "Give the command a terminal, so write_stdin can answer it later (default false).",
					},
				},
			},
			parseArguments(value) {
				const input = closedArguments(value, ["cmd", "workdir", "yield_time_ms", "tty"], "exec_command");
				if (
					typeof input.cmd !== "string" ||
					input.cmd.trim().length === 0 ||
					input.cmd.length > RUN_BOX_MAX_TEXT_LENGTH ||
					input.cmd.includes("\0")
				)
					throw new Error("cmd must be a command");
				if (
					input.workdir !== undefined &&
					(typeof input.workdir !== "string" ||
						input.workdir.length === 0 ||
						input.workdir.length > 4096 ||
						input.workdir.includes("\0"))
				)
					throw new Error("workdir must be a path");
				if (input.tty !== undefined && typeof input.tty !== "boolean") throw new Error("tty must be true or false");
				return {
					cmd: input.cmd,
					workdir: input.workdir ?? null,
					yield_time_ms: yieldOf(input.yield_time_ms, DEFAULT_EXEC_YIELD_MS),
					tty: input.tty ?? false,
				};
			},
			async execute(value, context) {
				const input = value as { cmd: string; workdir: string | null; yield_time_ms: number; tty: boolean };
				return answer(
					{
						t: "exec",
						id: randomUUID(),
						cmd: input.cmd,
						workdir: input.workdir,
						tty: input.tty,
						yieldMs: input.yield_time_ms,
						maxOutputBytes: OUTPUT_BYTES,
					},
					context.callId,
					context.signal,
				);
			},
		},
		{
			name: "write_stdin",
			description:
				"Writes to a command exec_command left running in your run box (only one started with tty can take input), " +
				"then answers like exec_command with its output since the last answer. Pass empty chars to only read on.",
			source: "company_file",
			inputSchema: {
				type: "object",
				additionalProperties: false,
				required: ["session_id"],
				properties: {
					session_id: { type: "integer", minimum: 1, description: "The session ID exec_command answered with." },
					chars: { type: "string", description: "What to type, such as a line ending in \\n (default: nothing)." },
					yield_time_ms: {
						type: "integer",
						minimum: 0,
						maximum: RUN_BOX_MAX_YIELD_MS,
						description: `How long to wait for output before answering (default ${DEFAULT_WRITE_YIELD_MS}).`,
					},
				},
			},
			parseArguments(value) {
				const input = closedArguments(value, ["session_id", "chars", "yield_time_ms"], "write_stdin");
				if (
					typeof input.session_id !== "number" ||
					!Number.isSafeInteger(input.session_id) ||
					input.session_id < 1 ||
					input.session_id > RUN_BOX_MAX_SESSION
				)
					throw new Error("session_id must be a session ID");
				if (
					input.chars !== undefined &&
					(typeof input.chars !== "string" ||
						input.chars.length > RUN_BOX_MAX_TEXT_LENGTH ||
						input.chars.includes("\0"))
				)
					throw new Error("chars must be text");
				return {
					session_id: input.session_id,
					chars: input.chars ?? "",
					yield_time_ms: yieldOf(input.yield_time_ms, DEFAULT_WRITE_YIELD_MS),
				};
			},
			async execute(value, context) {
				const input = value as { session_id: number; chars: string; yield_time_ms: number };
				return answer(
					{
						t: "write",
						id: randomUUID(),
						session: input.session_id,
						chars: input.chars,
						yieldMs: input.yield_time_ms,
						maxOutputBytes: OUTPUT_BYTES,
					},
					context.callId,
					context.signal,
				);
			},
		},
	];
}
