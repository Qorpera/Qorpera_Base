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
	type RunBoxErrorCode,
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
import { fitsOneResult } from "./cloud-worker-tools.ts";

/**
 * The run box's tools (F3 step 2b-3; deploy/first-node/RUNTIME-FOLDER-SERVICE.md, "Step 2b"): `exec_command` and
 * `write_stdin`, shaped like Codex's own, run by the native host in the run's box on the shared execution host. The
 * box (2b-1) has the company folder read-only at /company, no network and no credentials; its folder program (2b-2)
 * logs what each command opens or lists. Every answer releases those reads with the run's own authority before the
 * model sees it, so the next model request's context view can cite them, and a read the run may no longer make
 * withholds that answer and everything the box would show after it in the run.
 *
 * Nothing the box sends is trusted: each line is checked (`parseRunBoxReply`), bounded and fitted here.
 */

/** How long the run's first call waits for the box to appear: it starts beside the run, and the shared execution
 * service tries to open it for up to 60 s. Once a wait ran out, later calls look once. */
const BOX_WAIT_MS = 60_000;
/** Past the yield the box was asked for, how long its answer may take before the call gives up on it. */
const ANSWER_GRACE_MS = 5_000;
/** Output asked of the box per answer. The tool result envelope is 8 KiB and cut head-only, so the shown text is fitted
 * to what one result holds whole (`fitsOneResult`: its JSON escapes and the envelope's provenance counted). */
const OUTPUT_BYTES = 4_096;
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
			// The run's signal outlives every connection: its listener goes once the connection is decided.
			const done = (value: boolean): void => {
				signal.removeEventListener("abort", aborted);
				resolve(value);
			};
			const aborted = (): void => done(false);
			socket.once("connect", () => done(true));
			socket.once("error", () => done(false));
			signal.addEventListener("abort", aborted, { once: true });
			if (signal.aborted) done(false);
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

/** What the box read for one answer: the reads, the number to acknowledge once they are released, and whether the box's
 * read log restarted since the last answer (its earlier reads are gone, so this answer cannot be accounted for). */
export interface CloudRunBoxReads {
	readonly reads: CloudCompanyFolderRelease[];
	readonly upTo: number;
	readonly restarted: boolean;
}

/** The run's box: one connection, opened when first needed and again after the box restarted. */
export class CloudRunBox {
	readonly #paths: CloudRunBoxPaths;
	#waitMs: number;
	#connection: LineSocket | undefined;
	/** The box's read log as last seen, and the reads it holds up to `#acked` are released. */
	#log: string | undefined;
	#acked = 0;

	/** `waitMs`: how long the first call waits for the box to appear (tests shorten it). */
	constructor(paths: CloudRunBoxPaths, waitMs = BOX_WAIT_MS) {
		this.#paths = paths;
		this.#waitMs = waitMs;
	}

	async request(request: RunBoxRequest, signal: AbortSignal): Promise<RunBoxReply> {
		const connection = await this.#connect(signal);
		if (this.#log === undefined) {
			// Learn the read log before the first command, so a folder restart during it shows as a new log.
			try {
				await this.#learnLog(signal);
			} catch {
				throw new CloudToolRefusal("RUN_BOX_UNAVAILABLE: the run box's read log did not answer; try again");
			}
		}
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

	/** Everything the box read that is not released yet. Nothing leaves the log until `ackReads`. */
	async takeReads(signal: AbortSignal): Promise<CloudRunBoxReads> {
		const log = await LineSocket.open(this.#paths.reads, signal);
		if (!log) throw new Error("The run box's read log is unavailable");
		try {
			const reads: CloudCompanyFolderRelease[] = [];
			let after = this.#acked;
			let id: string | undefined;
			for (;;) {
				log.send(JSON.stringify({ t: "take", after, max: READS_PAGE }));
				const line = await log.next(READS_PAGE_MS, signal);
				if (line === undefined) throw new Error("The run box's read log did not answer");
				const answer = parseReads(line, after);
				if (id !== undefined && answer.log !== id)
					throw new Error("The run box's read log changed while it was read");
				id = answer.log;
				if (answer.log !== this.#log && (this.#log !== undefined || after > 0)) {
					// A new log: the program restarted, and what it held before is gone. Start over with this one.
					this.#log = answer.log;
					this.#acked = 0;
					return { reads: [], upTo: 0, restarted: true };
				}
				this.#log = answer.log;
				if (answer.more && answer.reads.length === 0)
					throw new Error("The run box's read log said more and gave none");
				reads.push(...answer.reads);
				after = answer.last ?? after;
				if (!answer.more) return { reads, upTo: after, restarted: false };
			}
		} finally {
			log.close();
		}
	}

	/** The read log's id, from a take that leaves the log as it was. */
	async #learnLog(signal: AbortSignal): Promise<void> {
		const log = await LineSocket.open(this.#paths.reads, signal);
		if (!log) throw new Error("The run box's read log is unavailable");
		try {
			log.send(JSON.stringify({ t: "take", after: 0, max: 1 }));
			const line = await log.next(READS_PAGE_MS, signal);
			if (line === undefined) throw new Error("The run box's read log did not answer");
			this.#log = parseReads(line, 0).log;
		} finally {
			log.close();
		}
	}

	/** The reads up to `upTo` are released: they leave the box's log. */
	async ackReads(upTo: number, signal: AbortSignal): Promise<void> {
		if (upTo <= this.#acked) return;
		const log = await LineSocket.open(this.#paths.reads, signal);
		if (!log) throw new Error("The run box's read log is unavailable");
		try {
			log.send(JSON.stringify({ t: "ack", log: this.#log, upTo }));
			const line = await log.next(READS_PAGE_MS, signal);
			const answer =
				line === undefined ? undefined : (JSON.parse(line) as { t?: unknown; log?: unknown; upTo?: unknown });
			if (answer?.t !== "acked" || answer.log !== this.#log || answer.upTo !== upTo)
				throw new Error("The run box's read log did not take the acknowledgement");
			this.#acked = upTo;
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
			if (Date.now() - started >= this.#waitMs) {
				this.#waitMs = 0;
				throw new CloudToolRefusal(
					"RUN_BOX_UNAVAILABLE: this run has no run box (it starts beside the run, on the shared execution host only); read with company_read and company_list instead",
				);
			}
			await delay(250, undefined, { signal });
		}
	}
}

function parseReads(
	line: string,
	after: number,
): { log: string; reads: CloudCompanyFolderRelease[]; last: number | undefined; more: boolean } {
	const value = JSON.parse(line) as { t?: unknown; log?: unknown; reads?: unknown; more?: unknown };
	if (
		value.t !== "reads" ||
		typeof value.log !== "string" ||
		!/^[0-9a-f]{32}$/.test(value.log) ||
		!Array.isArray(value.reads) ||
		typeof value.more !== "boolean" ||
		value.reads.length > READS_PAGE
	)
		throw new Error("The run box's read log answered something else");
	let last: number | undefined;
	const reads = value.reads.map((item: unknown): CloudCompanyFolderRelease => {
		const read = item as { seq?: unknown; path?: unknown; version?: unknown; authority?: unknown };
		// Numbered after what was asked for, in order.
		if (typeof read.seq !== "number" || !Number.isSafeInteger(read.seq) || read.seq <= (last ?? after))
			throw new Error("The run box's read log numbered a read out of order");
		last = read.seq;
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
	});
	return { log: value.log, reads, last, more: value.more };
}

/** The release ids of one answer: derived from the run and the call, so a replay of the call reuses them. */
function releaseId(runId: string, callId: string, part: number): string {
	const hex = createHash("sha256").update(`qorpera.run-box-release/v1:${runId}:${callId}:${part}`).digest("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${((Number.parseInt(hex[16] as string, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
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
 * keeps it whole, tail included (the envelope escapes `<`, `>` and `&` again and is cut head-only past 8 KiB). */
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
				? `\n[${skipped} bytes not shown${reply.logPath ? `; the whole output is in ${reply.logPath}` : "; narrow it with head, tail or rg"}]\n`
				: "";
		return `${status}\nWall time: ${(reply.wallMs / 1000).toFixed(1)} s\nOutput:\n${head}${note}${tail}`;
	};
	let text = render();
	if (!fitsOneResult(text) && tail.length === 0) {
		// The box sent all of the output as its head: keep its end too, cutting from the middle.
		const chars = Array.from(head);
		const cut = Math.floor(chars.length / 4);
		tail = chars.slice(cut).join("");
		head = chars.slice(0, cut).join("");
	}
	while (!fitsOneResult(text) && (head.length > 0 || tail.length > 0)) {
		const before = Buffer.byteLength(head) + Buffer.byteLength(tail);
		// A fifth smaller each time: the head alone until it is at most a quarter of what is kept, then both, so the
		// end of the output is the last to go.
		const headChars = Array.from(head).length;
		const tailChars = Array.from(tail).length;
		head = firstChars(head, Math.floor(headChars * 0.8));
		if (headChars <= (headChars + tailChars) / 4) tail = lastChars(tail, Math.floor(tailChars * 0.8));
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
		await folder.release(id, reads.slice(part * MAX_RELEASED, (part + 1) * MAX_RELEASED), outputSha256, signal);
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

/** A box error in the native host's own words, from the request: the box's message is not shown. */
function boxErrorText(code: RunBoxErrorCode, request: RunBoxRequest): string {
	switch (code) {
		case "WORKDIR_UNAVAILABLE":
			return `WORKDIR_UNAVAILABLE: the run box has no directory ${request.t === "exec" ? (request.workdir ?? RUN_BOX_COMPANY) : ""}`.slice(
				0,
				600,
			);
		case "SESSION_UNKNOWN":
			return `SESSION_UNKNOWN: no command is running as session ${request.t === "write" ? request.session : ""}; start it with exec_command`;
		case "STDIN_CLOSED":
			return "STDIN_CLOSED: this command's input is closed; start it with tty to write to it";
		case "SPAWN_FAILED":
			return "SPAWN_FAILED: the run box could not start the command; try again";
		case "INVALID_REQUEST":
			return "INVALID_REQUEST: the run box refused the request";
	}
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
	// Set once a read was refused as revoked: what the box read may sit anywhere in it now (a copy in /tmp shows
	// without a new read), so nothing more from it is shown in this run, and no command runs.
	let revoked = false;
	const answer = async (request: RunBoxRequest, callId: string, signal: AbortSignal): Promise<CloudToolContent> => {
		if (revoked)
			throw new CloudToolRefusal(
				"READ_REVOKED: this run's box read something you may no longer read, so nothing more from it is shown in this run and this command was not run; read with company_read and company_list instead",
			);
		const reply = await box.request(request, signal);
		// The box's own words never reach the model: its message is not released.
		if (reply.t === "error") throw new CloudToolRefusal(boxErrorText(reply.code, request));
		if (reply.t !== "result") throw new CloudToolRefusal("RUN_BOX_UNAVAILABLE: the run box answered something else");
		const ran =
			reply.session === null
				? "the command ran"
				: `the command ran and is still running as session ${reply.session}`;
		const text = runBoxAnswerText(reply);
		let taken: CloudRunBoxReads;
		try {
			taken = await box.takeReads(signal);
		} catch {
			throw new CloudToolRefusal(
				`RUN_BOX_UNAVAILABLE: ${ran}, but the run box's read log did not answer, so its output is not shown; try again`,
			);
		}
		if (taken.restarted)
			throw new CloudToolRefusal(
				`RUN_BOX_UNAVAILABLE: ${ran}, but the run box's folder restarted, so what it read cannot be accounted for and its output is not shown; run it again`,
			);
		let companyReadId: string | undefined;
		try {
			companyReadId = await releaseAnswer(folder, runId, callId, taken.reads, text, signal);
		} catch (error) {
			if (error instanceof CloudCompanyFolderError && error.failure === "read_revoked") {
				revoked = true;
				throw new CloudToolRefusal(
					`READ_REVOKED: ${ran}, but something it read may no longer be read by you, so its output is not shown; the box may hold what it read, so nothing more from it is shown in this run. Read with company_read and company_list instead`,
				);
			}
			// Not recorded: nothing was acknowledged, so the next answer releases these reads with its own.
			if (error instanceof CloudCompanyFolderError)
				throw new CloudToolRefusal(
					`COMPANY_FOLDER_UNAVAILABLE: ${ran}, but what it read could not be recorded (${error.failure}), so its output is not shown; try again`,
				);
			throw error;
		}
		// Released: the reads leave the box's log. Should this fail, the next answer releases them again.
		await box.ackReads(taken.upTo, signal).catch(() => undefined);
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
