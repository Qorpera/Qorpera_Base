import { createConnection } from "node:net";
import { isUuid } from "@qorpera/contracts";

/** The folder service's control socket (F3 5c and 6b, deploy/folder-service): host-local, for the executor of the
 * coding and test machines alone. A machine is named by its id: a coding machine's, or a test machine's placement's. */
export const FOLDER_CONTROL_SOCKET = "/run/qorpera-folder-control/control.sock";

/** Views named final in one boundary (the service's own bound). */
const MAX_FINAL = 256;
/** A boundary's reports list each changed path of each view: an answer longer than this is refused. */
const MAX_ANSWER_BYTES = 4 * 1024 * 1024;
const MAX_VIEWS = 1024;

/** The service's error codes (deploy/folder-service protocol.ts). */
const ERROR_CODES = [
	"NOT_FOUND",
	"NOT_A_FOLDER",
	"NOT_A_FILE",
	"STALE",
	"DENIED",
	"BAD_REQUEST",
	"UNAVAILABLE",
	"VIEW_CLOSED",
	"VIEW_REFUSED",
	"EXISTS",
	"NOT_EMPTY",
	"NOT_PERMITTED",
	"TOO_LARGE",
	"READ_ONLY",
	"NOT_HERE",
	"BUSY",
] as const;
export type FolderControlErrorCode = (typeof ERROR_CODES)[number];

const READS = [
	"released",
	"unanswered",
	"denied",
	"unreadable",
	"run_ended",
	"stopped",
	"invalid",
	"unproven",
] as const;
/** What came of releasing every read the machine was served before the answer. Only `released` lets output go:
 * `unanswered`, none yet; the core's refusal; or `unproven`, a read went unreleased or the machine restarted while the
 * boundary was out. */
export type FolderReads = (typeof READS)[number];

/** One open view of the machine at its boundary: its report (as the service gives it), or why it had none. */
export interface FolderViewBoundary {
	readonly viewId: string;
	readonly report?: Readonly<Record<string, unknown>>;
	readonly error?: { readonly code: FolderControlErrorCode; readonly message: string };
}
/** A machine's boundary, as the service answers it (its `MachineBoundary`). */
export interface MachineBoundary {
	readonly machine: string;
	readonly reads: FolderReads;
	readonly views: readonly FolderViewBoundary[];
}
/** A test machine's command, from its start: what the machine changes until the window closes is credited to it. */
export interface FolderCommandWindow {
	readonly commandId: string;
	readonly runId: string;
	readonly staffAgentId: string;
	readonly requestedByUserId: string;
}

/** The control socket's four requests. */
export interface FolderControl {
	/** Every open view of the machine publishes; `final` names the views whose last boundary this is (a test
	 * machine's final closes its view in the core). */
	boundary(machine: string, final: readonly string[], signal: AbortSignal): Promise<MachineBoundary>;
	/** The machine stopped and starts again: a read it lost no longer makes its views unproven, and its command windows
	 * end. Whether a read it was served before may have gone unreleased (the answer's `dropped`, F3 5g-5) is not read
	 * here: a test machine's commands end with its boot. */
	restarted(machine: string, signal: AbortSignal): Promise<void>;
	/** A test machine's command started (said again, it changes nothing). */
	openWindow(machine: string, window: FolderCommandWindow, signal: AbortSignal): Promise<void>;
	/** The command ended: its window closes, and the machine has a boundary (said again, one more boundary). */
	closeWindow(machine: string, commandId: string, signal: AbortSignal): Promise<MachineBoundary>;
}

/** The service answered with an error: an answer, unlike a request that got none. */
export class FolderControlError extends Error {
	readonly code: FolderControlErrorCode;
	constructor(code: FolderControlErrorCode) {
		super(`FOLDER_CONTROL_${code}`);
		this.code = code;
	}
}

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("FOLDER_CONTROL_ANSWER_INVALID");
	return value as Record<string, unknown>;
}
function errorOf(value: unknown): { code: FolderControlErrorCode; message: string } {
	const error = object(value);
	if (
		Object.keys(error).sort().join() !== "code,message" ||
		!ERROR_CODES.includes(error.code as FolderControlErrorCode) ||
		typeof error.message !== "string"
	)
		throw new Error("FOLDER_CONTROL_ANSWER_INVALID");
	return { code: error.code as FolderControlErrorCode, message: error.message as string };
}

/** The fields the executor acts on, checked: the machine asked about, the reads and each view's id or error. */
export function parseMachineBoundary(value: unknown, machine: string): MachineBoundary {
	const boundary = object(value);
	if (
		Object.keys(boundary).sort().join() !== "machine,reads,views" ||
		boundary.machine !== machine ||
		!READS.includes(boundary.reads as FolderReads) ||
		!Array.isArray(boundary.views) ||
		boundary.views.length > MAX_VIEWS
	)
		throw new Error("FOLDER_CONTROL_ANSWER_INVALID");
	const views = boundary.views.map((item): FolderViewBoundary => {
		const view = object(item);
		const keys = Object.keys(view).sort().join();
		if (!isUuid(view.viewId) || (keys !== "report,viewId" && keys !== "error,viewId"))
			throw new Error("FOLDER_CONTROL_ANSWER_INVALID");
		const viewId = view.viewId as string;
		if (keys === "report,viewId") return { viewId, report: object(view.report) };
		return { viewId, error: errorOf(view.error) };
	});
	return { machine, reads: boundary.reads as FolderReads, views };
}

/** One connection a request: one JSON line out, one line back, then the connection ends. An error answer throws
 * FolderControlError; no answer (the service down, the signal), FOLDER_CONTROL_UNANSWERED. */
export class UnixFolderControl implements FolderControl {
	readonly #path: string;
	constructor(path: string = FOLDER_CONTROL_SOCKET) {
		if (!path.startsWith("/")) throw new Error("FOLDER_CONTROL_CONFIGURATION_INVALID");
		this.#path = path;
	}

	async boundary(machine: string, final: readonly string[], signal: AbortSignal): Promise<MachineBoundary> {
		if (!isUuid(machine) || final.length > MAX_FINAL || !final.every((id) => isUuid(id)))
			throw new Error("FOLDER_CONTROL_REQUEST_INVALID");
		const answer = await this.#ask({ op: "boundary", machine, final: [...final] }, "boundary", signal);
		return parseMachineBoundary(answer, machine);
	}
	async restarted(machine: string, signal: AbortSignal): Promise<void> {
		if (!isUuid(machine)) throw new Error("FOLDER_CONTROL_REQUEST_INVALID");
		const answer = object(await this.#ask({ op: "restarted", machine }, "restarted", signal));
		const keys = Object.keys(answer).sort().join();
		if (
			(keys !== "machine" && keys !== "dropped,machine") ||
			answer.machine !== machine ||
			(keys !== "machine" && typeof answer.dropped !== "boolean")
		)
			throw new Error("FOLDER_CONTROL_ANSWER_INVALID");
	}
	async openWindow(machine: string, window: FolderCommandWindow, signal: AbortSignal): Promise<void> {
		const { commandId, runId, staffAgentId, requestedByUserId } = window;
		if (![machine, commandId, runId, staffAgentId, requestedByUserId].every((id) => isUuid(id)))
			throw new Error("FOLDER_CONTROL_REQUEST_INVALID");
		const request = { op: "open", machine, commandId, runId, staffAgentId, requestedByUserId };
		const answer = object(await this.#ask(request, "opened", signal));
		if (
			Object.keys(answer).sort().join() !== "commandId,machine" ||
			answer.machine !== machine ||
			answer.commandId !== commandId
		)
			throw new Error("FOLDER_CONTROL_ANSWER_INVALID");
	}
	async closeWindow(machine: string, commandId: string, signal: AbortSignal): Promise<MachineBoundary> {
		if (!isUuid(machine) || !isUuid(commandId)) throw new Error("FOLDER_CONTROL_REQUEST_INVALID");
		const answer = await this.#ask({ op: "close", machine, commandId }, "boundary", signal);
		return parseMachineBoundary(answer, machine);
	}

	/** The answer's one key's value: `expected`, or an error. */
	#ask(request: Record<string, unknown>, expected: string, signal: AbortSignal): Promise<unknown> {
		if (signal.aborted) return Promise.reject(new Error("FOLDER_CONTROL_UNANSWERED"));
		return new Promise((resolve, reject) => {
			const socket = createConnection({ path: this.#path, allowHalfOpen: true });
			const chunks: Buffer[] = [];
			let size = 0;
			let settled = false;
			const end = (error: Error | undefined, value?: unknown) => {
				if (settled) return;
				settled = true;
				signal.removeEventListener("abort", abort);
				socket.destroy();
				if (error) reject(error);
				else resolve(value);
			};
			const abort = () => end(new Error("FOLDER_CONTROL_UNANSWERED"));
			signal.addEventListener("abort", abort, { once: true });
			socket.on("error", () => end(new Error("FOLDER_CONTROL_UNANSWERED")));
			socket.on("end", () => end(new Error("FOLDER_CONTROL_UNANSWERED")));
			socket.on("close", () => end(new Error("FOLDER_CONTROL_UNANSWERED")));
			socket.on("data", (chunk: Buffer) => {
				const newline = chunk.indexOf(10);
				const part = newline === -1 ? chunk : chunk.subarray(0, newline);
				size += part.length;
				if (size > MAX_ANSWER_BYTES) return end(new Error("FOLDER_CONTROL_ANSWER_INVALID"));
				chunks.push(part);
				if (newline === -1) return;
				try {
					end(undefined, answerOf(Buffer.concat(chunks), expected));
				} catch (error) {
					end(error as Error);
				}
			});
			socket.end(`${JSON.stringify(request)}\n`);
		});
	}
}

function answerOf(line: Buffer, expected: string): unknown {
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(line));
	} catch {
		throw new Error("FOLDER_CONTROL_ANSWER_INVALID");
	}
	const answer = object(value);
	const keys = Object.keys(answer);
	if (keys.length !== 1) throw new Error("FOLDER_CONTROL_ANSWER_INVALID");
	if (keys[0] === "error") throw new FolderControlError(errorOf(answer.error).code);
	if (keys[0] !== expected) throw new Error("FOLDER_CONTROL_ANSWER_INVALID");
	return answer[expected];
}
