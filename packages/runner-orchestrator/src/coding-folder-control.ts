import { connect } from "node:net";
import { isUuid } from "@qorpera/contracts";
import {
	CODING_FOLDER_SECRET_MAX_BYTES,
	CODING_FOLDER_SECRET_MIN_BYTES,
	CODING_FOLDER_SECRET_VALUES_MAX,
	type CodingFolderSecretSet,
} from "./coding-folder-secrets.ts";

// The coding executor's side of the folder service's control socket (F3 step 5g-3b; the socket is 5c's,
// object-gateway's folder-service/control.ts, the plan's "Boundaries"). It asks for a coding machine's boundary before
// any of the machine's output reaches a model, says when it restarted the machine, and gives the service the machine's
// secret values as keyed hashes for its save check (5j-5 (a)). Each request goes on a
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
 * conflict, parked for review; a final boundary keeps none of them pending), the outcome of the first of them
 * (`unsavedOutcome`, such as `not_applied` or `waiting`), and why the core refused the change set whole (`refused`). */
export interface CodingFolderBoundaryView {
	readonly viewId: string;
	readonly error?: string;
	readonly unsaved?: number;
	readonly unsavedOutcome?: string;
	readonly refused?: string;
}

/** Whether a view's boundary saved all it had: a report, with every changed path saved and nothing refused whole. */
export function codingFolderViewSaved(view: CodingFolderBoundaryView | undefined): boolean {
	return view !== undefined && view.error === undefined && view.unsaved === 0 && view.refused === undefined;
}

/** Why a boundary holds the machine's output back, as a code's reason (`[A-Z][A-Z0-9_]{0,63}`), or undefined when it
 * released every read and saved every view: `READS_<reads>` unless the reads were released; otherwise, for the first
 * view not saved, the code of its error, `REFUSED_<refusal>` for a change set refused whole, `UNSAVED_<outcome>` with
 * the outcome of its first changed path not saved, or `UNREPORTED`. Its paths are not named. */
export function codingFolderBoundaryHeld(boundary: CodingFolderBoundary): string | undefined {
	if (boundary.reads !== "released") return `READS_${boundary.reads.toUpperCase()}`;
	const view = boundary.views.find((each) => !codingFolderViewSaved(each));
	if (view === undefined) return undefined;
	if (view.error !== undefined) return view.error;
	if (view.refused !== undefined) return `REFUSED_${view.refused.toUpperCase()}`;
	if (view.unsaved !== undefined && view.unsaved > 0)
		return view.unsavedOutcome === undefined ? "UNSAVED" : `UNSAVED_${view.unsavedOutcome.toUpperCase()}`;
	return "UNREPORTED";
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
	/** A machine's secret values for the service's save check (5j-5 (a)), as keyed hashes, or undefined while they are
	 * not known here. Sent before each boundary, so none saves under an older set. Absent, none is sent. */
	readonly secrets?: (machine: string) => CodingFolderSecretSet | undefined;
}

/** The control socket's client. A request that is not well formed rejects with CODING_FOLDER_CONTROL_REQUEST_INVALID
 * before anything connects; no socket, or a connection that ends without an answer, with
 * CODING_FOLDER_CONTROL_UNAVAILABLE; no answer in time with CODING_FOLDER_CONTROL_TIMEOUT; the caller's abort with its
 * reason; an error answer with CodingFolderControlRefused; any other answer with CODING_FOLDER_CONTROL_ANSWER_INVALID.
 * No error quotes the answer. Each request may be sent again. */
export class CodingFolderControl {
	readonly #path: string;
	readonly #timeoutMs: number;
	readonly #secrets: CodingFolderControlOptions["secrets"];
	constructor(options: CodingFolderControlOptions = {}) {
		const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS)
			throw new Error("Invalid folder control timeout");
		this.#path = options.path ?? CODING_FOLDER_CONTROL_SOCKET;
		this.#timeoutMs = timeoutMs;
		this.#secrets = options.secrets;
	}

	/** Releases the reads of every open view of the machine, publishes what each has pending, and answers once the reads
	 * served meanwhile are released too. `final` names the views whose last boundary this is, before they close. The
	 * machine's secret values go first (`secrets`); a failure to send them fails the boundary. */
	async boundary(machine: string, final: readonly string[], signal: AbortSignal): Promise<CodingFolderBoundary> {
		if (
			!isUuid(machine) ||
			!Array.isArray(final) ||
			final.length > MAX_FINAL ||
			!final.every((id) => isUuid(id)) ||
			new Set(final).size !== final.length
		)
			throw new Error("CODING_FOLDER_CONTROL_REQUEST_INVALID");
		await this.secrets(machine, signal);
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
	 * unproven. Sent once the machine is stopped and before it starts. Answers whether a read the machine was served
	 * before may have gone unreleased (F3 5g-5, the service's `dropped`): what it left on its disk then is not to be
	 * kept. A service from before 5g-5 does not say, which is the same as yes. */
	async restarted(machine: string, signal: AbortSignal): Promise<boolean> {
		if (!isUuid(machine)) throw new Error("CODING_FOLDER_CONTROL_REQUEST_INVALID");
		const answer = objectOf(await this.#ask({ op: "restarted", machine }, "restarted", signal));
		const keys = answer ? Object.keys(answer).sort().join() : "";
		if (
			!answer ||
			(keys !== "machine" && keys !== "dropped,machine") ||
			answer.machine !== machine ||
			(keys !== "machine" && typeof answer.dropped !== "boolean")
		)
			throw new Error(INVALID);
		return answer.dropped !== false;
	}

	/** Gives the service the machine's secret values (5j-5 (a)) in place of what it was given before: what the machine's
	 * views save is checked against them, and none saves before the first. The service holds them in memory only, so they
	 * are sent again before each boundary and while the machine has sessions, never one this process does not know (a
	 * restarted executor's would replace the set its predecessor sent). Answers how many values the service holds, null
	 * when nothing was sent, or "unsupported" when the service is from before the check (it answers BAD_REQUEST, and
	 * checks no save). */
	async secrets(machine: string, signal: AbortSignal): Promise<number | null | "unsupported"> {
		if (!isUuid(machine)) throw new Error("CODING_FOLDER_CONTROL_REQUEST_INVALID");
		const set = this.#secrets?.(machine);
		if (set === undefined) return null;
		if (!secretSetValid(set)) throw new Error("CODING_FOLDER_CONTROL_REQUEST_INVALID");
		const values = set.values.map(({ length, start, whole }) => ({ length, start, whole }));
		const request = { op: "secrets", machine, key: set.key, values };
		let answer: Record<string, unknown> | undefined;
		try {
			answer = objectOf(await this.#ask(request, "secrets", signal));
		} catch (error) {
			if (error instanceof CodingFolderControlRefused && error.code === "BAD_REQUEST") return "unsupported";
			throw error;
		}
		if (
			!answer ||
			Object.keys(answer).sort().join() !== "machine,values" ||
			answer.machine !== machine ||
			!Number.isSafeInteger(answer.values) ||
			(answer.values as number) < 0 ||
			(answer.values as number) > set.values.length
		)
			throw new Error(INVALID);
		return answer.values as number;
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

/** What a view's report (the service's Report) says of the save: how many paths are not saved, the outcome of the first
 * of them, and a whole refusal. Its paths, reasons and receipts are checked for shape and not kept. */
function reportOf(value: unknown): { unsaved: number; unsavedOutcome?: string; refused?: string } {
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
	let unsavedOutcome: string | undefined;
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
		if (entry.outcome === "saved") continue;
		unsaved++;
		unsavedOutcome ??= entry.outcome as string;
	}
	return {
		unsaved,
		...(unsavedOutcome === undefined ? {} : { unsavedOutcome }),
		...(report.refused === undefined ? {} : { refused: report.refused as string }),
	};
}

/** A set as the service takes it: a key of 32 bytes and at most 4096 values, each a length it checks, a 20-bit start
 * and 16 bytes, all base64url written the one way. */
function secretSetValid(set: CodingFolderSecretSet): boolean {
	return (
		canonical(set.key, 32) &&
		Array.isArray(set.values) &&
		set.values.length <= CODING_FOLDER_SECRET_VALUES_MAX &&
		set.values.every(
			(value) =>
				Number.isSafeInteger(value.length) &&
				value.length >= CODING_FOLDER_SECRET_MIN_BYTES &&
				value.length <= CODING_FOLDER_SECRET_MAX_BYTES &&
				Number.isSafeInteger(value.start) &&
				value.start >= 0 &&
				value.start < 2 ** 20 &&
				canonical(value.whole, 16),
		)
	);
}

/** Whether `value` is the one unpadded base64url writing of `bytes` bytes. */
function canonical(value: unknown, bytes: number): boolean {
	return (
		typeof value === "string" &&
		/^[A-Za-z0-9_-]*$/.test(value) &&
		Buffer.from(value, "base64url").byteLength === bytes &&
		Buffer.from(value, "base64url").toString("base64url") === value
	);
}

function objectOf(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
