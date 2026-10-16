import { connect } from "node:net";
import { isUuid } from "@qorpera/contracts";

// The coding executor's side of the folder service's control socket (F3 step 5g-3b; the socket is 5c's,
// object-gateway's folder-service/control.ts, the plan's "Boundaries"). It asks for a coding machine's boundary before
// any of the machine's output reaches a model, and says when it restarted the machine. Each request goes on a
// connection of its own: one JSON line, then our side ends, and the service answers with one JSON line and ends its
// own. The service is the host's, but its answer is still read whole and checked against the request before use.

/** Where the socket unit (qorpera-folder-control.socket) puts the socket, for the executor's uid alone. */
export const CODING_FOLDER_CONTROL_SOCKET = "/run/qorpera-folder-control/control.sock";

/** What came of releasing every read the machine was served before the answer: `released`, so its output may reach a
 * model; `unanswered`, none yet; the core's refusal (`denied`, `unreadable`, `run_ended`, `stopped`, `invalid`); or
 * `unproven`, a read went unreleased or the machine restarted under the boundary, so it must restart (again). Only
 * `released` lets output go. */
export type CodingFolderReads =
	| "released"
	| "unanswered"
	| "denied"
	| "unreadable"
	| "run_ended"
	| "stopped"
	| "invalid"
	| "unproven";
const READS: readonly string[] = [
	"released",
	"unanswered",
	"denied",
	"unreadable",
	"run_ended",
	"stopped",
	"invalid",
	"unproven",
];

/** A coding machine's boundary: each open view of the machine, and each view named final, with the code of the error
 * it had instead of a report, or what its report says of the save. The reports are 5g-4's, which opens and closes the
 * views. */
export interface CodingFolderBoundary {
	readonly machine: string;
	readonly reads: CodingFolderReads;
	readonly views: readonly CodingFolderBoundaryView[];
}

/** One view at a boundary: the code of the error it had instead of a report; or, from its report, how many of its
 * changed paths are not saved (`unsaved`: a commit with no answer yet, waiting on an open file, refused, denied, a
 * conflict, parked for review; a final boundary keeps none of them pending), and why the core refused the change set
 * whole (`refused`). */
export interface CodingFolderBoundaryView {
	readonly viewId: string;
	readonly error?: string;
	readonly unsaved?: number;
	readonly refused?: string;
}

/** Whether a view's boundary saved all it had: a report, with every changed path saved and nothing refused whole. */
export function codingFolderViewSaved(view: CodingFolderBoundaryView | undefined): boolean {
	return view !== undefined && view.error === undefined && view.unsaved === 0 && view.refused === undefined;
}

/** The service answered with an error, such as VIEW_REFUSED (this uid may not connect), UNAVAILABLE or BAD_REQUEST.
 * Its message is not kept. */
export class CodingFolderControlRefused extends Error {
	readonly code: string;
	constructor(code: string) {
		super(`CODING_FOLDER_CONTROL_REFUSED:${code}`);
		this.code = code;
	}
}

/** A path's outcome in a report (the service's ReportEntry), and why the core may refuse a change set whole. */
const OUTCOMES: readonly string[] = [
	"saved",
	"conflict",
	"refused",
	"denied",
	"waiting_for_review",
	"not_applied",
	"waiting",
];
const REFUSALS: readonly string[] = READS.filter((reads) => reads !== "released" && reads !== "unanswered");
const REPORT_KEYS: readonly string[] = ["closed", "commitId", "paths", "refused", "seq"];
/** `target`: a conflicting link's target (the service's protocol 4), not kept like the rest of the entry. */
const ENTRY_KEYS: readonly string[] = ["kept", "outcome", "path", "reason", "receipt", "target"];

const INVALID = "CODING_FOLDER_CONTROL_ANSWER_INVALID";
/** Views one boundary may name final, as the service takes them. */
const MAX_FINAL = 256;
/** The answer line, newline included: every open view's report, with room. */
const MAX_ANSWER_BYTES = 16 * 1024 * 1024;
const CODE = /^[A-Z][A-Z_]{0,63}$/;
/** A boundary publishes what each open view of the machine has pending and releases its reads first. */
const TIMEOUT_MS = 20_000;
/** The longest delay Node's timers keep; a longer one fires after 1 ms. */
const MAX_TIMEOUT_MS = 2_147_483_647;

export interface CodingFolderControlOptions {
	readonly path?: string;
	readonly timeoutMs?: number;
}

/** The control socket's client. A request that is not well formed rejects with CODING_FOLDER_CONTROL_REQUEST_INVALID
 * before anything connects; no socket, or a connection that ends without an answer, with
 * CODING_FOLDER_CONTROL_UNAVAILABLE; no answer in time with CODING_FOLDER_CONTROL_TIMEOUT; the caller's abort with its
 * reason; an error answer with CodingFolderControlRefused; any other answer with CODING_FOLDER_CONTROL_ANSWER_INVALID.
 * No error quotes the answer. Either request may be sent again. */
export class CodingFolderControl {
	readonly #path: string;
	readonly #timeoutMs: number;
	constructor(options: CodingFolderControlOptions = {}) {
		const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS)
			throw new Error("Invalid folder control timeout");
		this.#path = options.path ?? CODING_FOLDER_CONTROL_SOCKET;
		this.#timeoutMs = timeoutMs;
	}

	/** Releases the reads of every open view of the machine, publishes what each has pending, and answers once the reads
	 * served meanwhile are released too. `final` names the views whose last boundary this is, before they close. */
	async boundary(machine: string, final: readonly string[], signal: AbortSignal): Promise<CodingFolderBoundary> {
		if (
			!isUuid(machine) ||
			!Array.isArray(final) ||
			final.length > MAX_FINAL ||
			!final.every((id) => isUuid(id)) ||
			new Set(final).size !== final.length
		)
			throw new Error("CODING_FOLDER_CONTROL_REQUEST_INVALID");
		const answer = objectOf(await this.#ask({ op: "boundary", machine, final: [...final] }, "boundary", signal));
		if (
			!answer ||
			Object.keys(answer).sort().join() !== "machine,reads,views" ||
			answer.machine !== machine ||
			!READS.includes(answer.reads as string) ||
			!Array.isArray(answer.views)
		)
			throw new Error(INVALID);
		const views = answer.views.map((value: unknown) => {
			const view = objectOf(value);
			const keys = view ? Object.keys(view).sort().join() : "";
			if (!view || !isUuid(view.viewId)) throw new Error(INVALID);
			if (keys === "report,viewId") return Object.freeze({ viewId: view.viewId, ...reportOf(view.report) });
			if (keys !== "error,viewId") throw new Error(INVALID);
			return Object.freeze({ viewId: view.viewId, error: errorCode(view.error) });
		});
		if (new Set(views.map((view) => view.viewId)).size !== views.length) throw new Error(INVALID);
		return Object.freeze({ machine, reads: answer.reads as CodingFolderReads, views: Object.freeze(views) });
	}

	/** Says the machine is stopped and starts again, so a read it lost no longer leaves the views it opens from now on
	 * unproven. Sent once the machine is stopped and before it starts. */
	async restarted(machine: string, signal: AbortSignal): Promise<void> {
		if (!isUuid(machine)) throw new Error("CODING_FOLDER_CONTROL_REQUEST_INVALID");
		const answer = objectOf(await this.#ask({ op: "restarted", machine }, "restarted", signal));
		if (!answer || Object.keys(answer).join() !== "machine" || answer.machine !== machine) throw new Error(INVALID);
	}

	/** One request on a connection of its own, and what the answer holds under `key`. */
	async #ask(request: Record<string, unknown>, key: string, signal: AbortSignal): Promise<unknown> {
		signal.throwIfAborted();
		const bytes = await new Promise<Buffer>((resolve, reject) => {
			// Half open: our side ends after the request, and the service still answers.
			const socket = connect({ path: this.#path, allowHalfOpen: true });
			const chunks: Buffer[] = [];
			let length = 0;
			let settled = false;
			const finish = (settle: () => void) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal.removeEventListener("abort", aborted);
				socket.destroy();
				settle();
			};
			const fail = (message: string) => finish(() => reject(new Error(message)));
			const aborted = () => finish(() => reject(signal.reason));
			// The service ends its side after its answer, so what came until then is all of it. One that refuses this uid
			// answers and closes without reading the request, which may reach us as a reset after the answer. Without a
			// whole line, nothing was answered.
			const ended = () => {
				const bytes = Buffer.concat(chunks, length);
				if (bytes.includes(0x0a)) finish(() => resolve(bytes));
				else fail("CODING_FOLDER_CONTROL_UNAVAILABLE");
			};
			const timer = setTimeout(() => fail("CODING_FOLDER_CONTROL_TIMEOUT"), this.#timeoutMs);
			signal.addEventListener("abort", aborted, { once: true });
			socket.on("data", (chunk: Buffer) => {
				chunks.push(chunk);
				length += chunk.length;
				if (length > MAX_ANSWER_BYTES) fail(INVALID);
			});
			socket.on("end", ended);
			socket.on("error", ended);
			socket.on("close", ended);
			socket.end(`${JSON.stringify(request)}\n`);
		});
		// One line, and nothing after it.
		if (bytes.indexOf(0x0a) !== bytes.length - 1) throw new Error(INVALID);
		let answer: Record<string, unknown> | undefined;
		try {
			// Strict UTF-8, and a byte order mark is not JSON.
			answer = objectOf(
				JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, -1))),
			);
		} catch {
			throw new Error(INVALID);
		}
		if (!answer || Object.keys(answer).length !== 1) throw new Error(INVALID);
		if (Object.hasOwn(answer, key)) return answer[key];
		if (!Object.hasOwn(answer, "error")) throw new Error(INVALID);
		throw new CodingFolderControlRefused(errorCode(answer.error));
	}
}

/** An error's code, of `{code, message}`. */
function errorCode(value: unknown): string {
	const error = objectOf(value);
	if (
		!error ||
		Object.keys(error).sort().join() !== "code,message" ||
		typeof error.code !== "string" ||
		!CODE.test(error.code) ||
		typeof error.message !== "string"
	)
		throw new Error(INVALID);
	return error.code;
}

/** What a view's report (the service's Report) says of the save: how many paths are not saved, and a whole refusal.
 * Its paths, reasons and receipts are checked for shape and not kept. */
function reportOf(value: unknown): { unsaved: number; refused?: string } {
	const report = objectOf(value);
	if (
		!report ||
		!Object.keys(report).every((key) => REPORT_KEYS.includes(key)) ||
		!(report.commitId === null || typeof report.commitId === "string") ||
		!(report.seq === null || (Number.isSafeInteger(report.seq) && (report.seq as number) >= 0)) ||
		!(report.closed === undefined || report.closed === true) ||
		!(report.refused === undefined || REFUSALS.includes(report.refused as string)) ||
		!Array.isArray(report.paths)
	)
		throw new Error(INVALID);
	let unsaved = 0;
	for (const value of report.paths) {
		const entry = objectOf(value);
		if (
			!entry ||
			!Object.keys(entry).every((key) => ENTRY_KEYS.includes(key)) ||
			typeof entry.path !== "string" ||
			!OUTCOMES.includes(entry.outcome as string) ||
			!(entry.reason === undefined || typeof entry.reason === "string") ||
			!(entry.receipt === undefined || typeof entry.receipt === "string") ||
			!(entry.kept === undefined || entry.kept === true) ||
			!(entry.target === undefined || typeof entry.target === "string")
		)
			throw new Error(INVALID);
		if (entry.outcome !== "saved") unsaved++;
	}
	return report.refused === undefined ? { unsaved } : { unsaved, refused: report.refused as string };
}

function objectOf(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
