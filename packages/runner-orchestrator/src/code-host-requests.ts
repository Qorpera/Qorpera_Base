import { type CloudCodingRepository, isUuid, parseCloudCodingRepository, SHA256_HEX_PATTERN } from "@qorpera/contracts";
import { withAbortScope } from "./abort-scope.ts";
import {
	answeredBefore,
	type CodeChangeRecords,
	type CodeChangeTarget,
	codeChangeDiffOf,
	codeChangeDiffReported,
	codeChangeErrorCode,
	codeChangeRefusalPaths,
} from "./code-change-records.ts";
import {
	type archiveCodeArea,
	type CodeChangePath,
	type CodeHostJob,
	CodeHostJobFailure,
	CodeHostRefusal,
	type removeCodeDownloads,
	type undoCodeChange,
} from "./code-host-jobs.ts";
import type { CodeHostJobs } from "./code-host-views.ts";
import { CodingControlBusy, withinBytes } from "./coding-executor.ts";

/** The work on a repository kept in Qorpera that no coding turn carries (own code storage, step 2b): the coding
 * executor's side. An agent asks for an undo, a member for a download of the code, an operator for a restore from a
 * stored copy; each is a row of `qorpera_code_requests` (migration `20260930720000`), and this is the one loop that
 * does them. A pass claims what this executor may do now (`qorpera_code_requests_claim`, which leases each request),
 * and every request it claimed ends with `qorpera_code_request_finish`:
 *
 *   undo       a code host job in the company's line, which does not give way: as urgent as a landing. Inside the job,
 *              once main has moved, the finish (the kernel writes the undo's row while the line is held) and then the
 *              record's files that are due. A pass runs its undos to their finish, one after another.
 *   download   a job that yields to a turn's: the kernel is asked first (`qorpera_code_request_step`), then the file
 *              is made under `code/<owner>/<name>/downloads/`, or an expired one removed. The finish comes after the
 *              job, since the file is there only once the job has saved. The step is more than a look at the lease:
 *              it is where the kernel ends the made download whose file this job replaces, and gives the request the
 *              repository's artifact generation, in which its file is made. So no download reads ready with its file
 *              gone, whatever becomes of this job or of its finish, and a finish that comes after a restore's job was
 *              let go to move the place is not taken as made.
 *   restore    part R's `CodeRestore` runs its steps; without one the request is finished failed (`NOT_BUILT`). A
 *              restore that put the repository back was recorded by the job that opened its place
 *              (`qorpera_code_restore_record`), as an undo's row is written inside its job: the finish here, after
 *              that job has saved, only ends the request. The sessions whose work it took away are archived around
 *              that finish (`qorpera_code_restore_strand`), and nothing of that changes how the restore ended.
 *
 * A download and a restore may take minutes: they run on beside the passes, so that an undo never waits behind one.
 * What they came to is counted in the pass after they ended, and `settled` waits for them. */

export const CODE_REQUEST_RPCS = [
	"qorpera_code_requests_claim",
	"qorpera_code_request_step",
	"qorpera_code_request_finish",
	// A restore's own: `CodeRestore` makes it (`CODE_RESTORE_RPCS`). It is named here because this list is the one the
	// executor's control allows the requests.
	"qorpera_code_restore_record",
	// The sessions a restore stranded, archived around its finish (`#strand`).
	"qorpera_code_restore_strand",
] as const;

/** How many stranded sessions one `qorpera_code_restore_strand` names at most. */
export const CODE_RESTORE_STRAND_IDS = 200;

/** The code host jobs the requests run: `code-host-jobs.ts`'s functions, given by the caller. */
export interface CodeRequestJobs {
	undo: typeof undoCodeChange;
	archive: typeof archiveCodeArea;
	removeDownloads: typeof removeCodeDownloads;
}

/** What every claimed request carries: its lease, and the repository it is about. */
interface Claimed {
	requestId: string;
	token: string;
	companyId: string;
	environmentId: string;
	owner: string;
	name: string;
}
export interface CodeUndoRequest extends Claimed {
	kind: "undo";
	/** The change to take out, by its row's two ends of main. */
	change: { n: number; mainBefore: string; mainAfter: string };
	andLater: boolean;
	/** The new commit's message. */
	message: string;
}
export interface CodeDownloadRequest extends Claimed {
	kind: "download";
	/** `remove`: the request's file is past its time. */
	work: "make" | "remove";
	file: "files" | "history";
	fileName: string;
	/** `code/<owner>/<name>/downloads/<fileName>`. */
	path: string;
}
/** A restore, as the kernel hands it out: part R's `CodeRestore` takes it as it is, and asks the request's steps
 * itself, with `requestId` and `token`. */
export interface CodeRestoreRequest extends Claimed {
	kind: "restore";
	mode: "verify" | "restore" | "discard";
	/** A stored bundle's name, or `fresh`; null for a discard. */
	bundle: string | null;
	damaged: "keep" | "remove" | null;
	/** What an earlier run of the request saved of how far it got. */
	progress: Record<string, unknown> | null;
	/** A discard's set-aside path. */
	path: string | null;
	/** The repository's sessions that are not archived. */
	sessions: { workerId: string; baseSha: string }[];
}
export type CodeRequest = CodeUndoRequest | CodeDownloadRequest | CodeRestoreRequest;

/** What `qorpera_code_request_finish` records of one request (`qorpera.code-request-outcome/v1`), by kind. */
export type CodeRequestOutcome = { schema: "qorpera.code-request-outcome/v1" } & (
	| {
			state: "done";
			result: "undone";
			mainBefore: string;
			mainAfter: string;
			filesChanged: number;
			paths: CodeChangePath[];
			pathsMore: number;
	  }
	| { state: "done"; result: "nothing"; mainSha: string }
	| { state: "done"; result: "made"; path: string; bytes: number; sha256: string; mainSha: string }
	| { state: "done"; result: "removed" }
	| { state: "done"; result: "verified"; mainSha: string; refsSha256: string; refs: number }
	| {
			state: "done";
			result: "restored";
			bundle: string;
			mainSha: string;
			previousMainSha: string | null;
			refsSha256: string;
			refs: number;
			stranded: string[];
			movedTo: string | null;
	  }
	| { state: "done"; result: "discarded" }
	| { state: "refused"; code: string; paths?: string[] }
	| { state: "busy" }
	| { state: "failed"; code: string }
);

export interface CodeHostRequestsOptions {
	control: { call(method: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> };
	/** The executor's code host jobs, with the `yields` option. */
	hosts: Pick<CodeHostJobs, "run">;
	jobs: CodeRequestJobs;
	/** The change record's files: an undo's are written inside its own job. */
	records: Pick<CodeChangeRecords, "inJob">;
	/** Part R's `CodeRestore`. Without it a restore request is finished failed (`NOT_BUILT`). */
	restore?: { run(request: CodeRestoreRequest, signal: AbortSignal): Promise<CodeRequestOutcome> };
	owner: string;
	machineIdSha256: string;
	/** The log lines `code-request` and `code-request-error` (whose `error` is the error itself, for the log to
	 * redact). */
	report?: (event: Record<string, unknown>) => void;
	/** How many requests one pass claims, 1 to 20. Default 10. */
	limit?: number;
	/** How long the finish and the record's files may hold an undo's job, which holds its company's line. Default
	 * 10 s. */
	recordMs?: number;
	/** How long each call that archives a restore's stranded sessions may take, before the restore's finish and after
	 * it. Default 5 s. */
	strandMs?: number;
}

type Ended = "done" | "refused" | "failed" | "busy";
type Counts = Record<Ended, number>;

const SCHEMA = "qorpera.code-request-outcome/v1";
const STRAND = "qorpera.code-restore-strand/v1";
const CALL_MS = 10_000;
const SHA = /^[0-9a-f]{40}$/;
const YIELDED = "CODE_HOST_JOB_YIELDED";
/** The refusals of an undo that the kernel takes as refusals, for the agent to act on; any other is a failure. */
const UNDO_REFUSALS = /^CODE_HOST_(?:UNDO_CONFLICT|UNDO_NOT_IN_MAIN|UNDO_UNKNOWN_COMMIT|NAMES_[A-Z0-9_]{1,60})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
const sha = (value: unknown): value is string => typeof value === "string" && SHA.test(value);
const whole = (value: unknown, least = 0): value is number => Number.isSafeInteger(value) && (value as number) >= least;
const zero = (): Counts => ({ done: 0, refused: 0, failed: 0, busy: 0 });

/** The kernel did not let a job go on: the request's lease is gone, or the company is busy. */
class RequestStopped extends Error {
	readonly stop: "busy" | "lost";
	constructor(stop: "busy" | "lost") {
		super(`CODE_REQUEST_STOPPED:${stop}`);
		this.stop = stop;
	}
}

/** A claimed request, checked field by field. It throws for one that is not a request this executor knows. */
function requestOf(value: unknown): CodeRequest {
	const entry = isRecord(value) ? value : {};
	const { requestId, token, companyId, environmentId } = entry;
	if (![requestId, token, companyId, environmentId].every((id) => isUuid(id))) throw new Error("CODE_REQUEST_INVALID");
	const repository = parseCloudCodingRepository({
		host: "qorpera",
		owner: entry.owner,
		name: entry.name,
		baseBranch: "main",
	});
	const claimed: Claimed = {
		requestId: requestId as string,
		token: token as string,
		companyId: companyId as string,
		environmentId: environmentId as string,
		owner: repository.owner,
		name: repository.name,
	};
	if (entry.kind === "undo") {
		const change = isRecord(entry.change) ? entry.change : {};
		if (
			!whole(change.n, 1) ||
			!sha(change.mainBefore) ||
			!sha(change.mainAfter) ||
			typeof entry.andLater !== "boolean" ||
			typeof entry.message !== "string" ||
			!entry.message.trim()
		)
			throw new Error("CODE_REQUEST_INVALID");
		return {
			...claimed,
			kind: "undo",
			change: { n: change.n, mainBefore: change.mainBefore, mainAfter: change.mainAfter },
			andLater: entry.andLater,
			// The job takes a commit message of at most 4096 bytes.
			message: withinBytes(entry.message, 4096),
		};
	}
	if (entry.kind === "download") {
		const { work, file, fileName, path } = entry;
		if (
			(work !== "make" && work !== "remove") ||
			(file !== "files" && file !== "history") ||
			typeof fileName !== "string" ||
			// The kernel names the file, and the finish takes no other path: a name the job takes, with its kind's ending.
			!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,190}\.(?:zip|bundle)$/.test(fileName) ||
			fileName.endsWith(file === "files" ? ".bundle" : ".zip") ||
			path !== `code/${claimed.owner}/${claimed.name}/downloads/${fileName}`
		)
			throw new Error("CODE_REQUEST_INVALID");
		return { ...claimed, kind: "download", work, file, fileName, path };
	}
	if (entry.kind === "restore") {
		const { mode, bundle, damaged, progress, path } = entry;
		const sessions = entry.sessions ?? [];
		if (
			(mode !== "verify" && mode !== "restore" && mode !== "discard") ||
			!(bundle === null || bundle === undefined || typeof bundle === "string") ||
			!(damaged === null || damaged === undefined || damaged === "keep" || damaged === "remove") ||
			!(progress === null || progress === undefined || isRecord(progress)) ||
			!(path === null || path === undefined || typeof path === "string") ||
			!Array.isArray(sessions) ||
			!sessions.every((session) => isRecord(session) && isUuid(session.workerId) && sha(session.baseSha))
		)
			throw new Error("CODE_REQUEST_INVALID");
		return {
			...claimed,
			kind: "restore",
			mode,
			bundle: bundle ?? null,
			damaged: damaged ?? null,
			progress: progress ?? null,
			path: path ?? null,
			sessions: (sessions as { workerId: string; baseSha: string }[]).map(({ workerId, baseSha }) => ({
				workerId,
				baseSha,
			})),
		};
	}
	throw new Error("CODE_REQUEST_INVALID");
}

export class CodeHostRequests {
	readonly #control: CodeHostRequestsOptions["control"];
	readonly #hosts: Pick<CodeHostJobs, "run">;
	readonly #jobs: CodeRequestJobs;
	readonly #records: Pick<CodeChangeRecords, "inJob">;
	readonly #restore: CodeHostRequestsOptions["restore"];
	readonly #owner: string;
	readonly #machineIdSha256: string;
	readonly #report: (event: Record<string, unknown>) => void;
	readonly #limit: number;
	readonly #recordMs: number;
	readonly #strandMs: number;
	/** The downloads and restores that run on beside the passes. */
	readonly #beside = new Set<Promise<void>>();
	/** What those that ended since the last pass came to. */
	#ended: Counts = zero();

	constructor(options: CodeHostRequestsOptions) {
		const limit = options.limit ?? 10,
			recordMs = options.recordMs ?? 10_000,
			strandMs = options.strandMs ?? CALL_MS / 2;
		if (
			typeof options.owner !== "string" ||
			!options.owner ||
			typeof options.machineIdSha256 !== "string" ||
			!SHA256_HEX_PATTERN.test(options.machineIdSha256) ||
			!whole(limit, 1) ||
			limit > 20 ||
			!whole(recordMs, 1) ||
			!whole(strandMs, 1)
		)
			throw new Error("INVALID_CODE_HOST_REQUESTS");
		this.#control = options.control;
		this.#hosts = options.hosts;
		this.#jobs = options.jobs;
		this.#records = options.records;
		this.#restore = options.restore;
		this.#owner = options.owner;
		this.#machineIdSha256 = options.machineIdSha256;
		const report = options.report;
		// The log must never change what happens: a reporter that throws is not heard.
		this.#report = (event) => {
			try {
				report?.(event);
			} catch {
				/* not heard */
			}
		};
		this.#limit = limit;
		this.#recordMs = recordMs;
		this.#strandMs = strandMs;
	}

	/** One pass: the requests this executor may do now. Each undo is run to its finish before the pass ends; a download
	 * or a restore is started and runs on beside the passes. It never throws for one request, nor for a kernel that does
	 * not answer: those are reported (`code-request-error`). The counts are of the requests that ended since the last
	 * pass began to count, by how they ended: this pass's undos, and the downloads and restores that finished meanwhile.
	 * A request whose finish the kernel did not take counts as failed; its lease ends, and it is claimed again. */
	async pass(signal: AbortSignal): Promise<Counts> {
		const counts = this.#ended;
		this.#ended = zero();
		// The pass's signal may live as long as the process: it is handed to no `AbortSignal.any` (abort-scope.ts).
		await withAbortScope(signal, async (scoped) => {
			let claimed: CodeRequest[];
			try {
				claimed = await this.#claim(scoped);
			} catch (error) {
				if (!scoped.aborted) this.#report({ event: "code-request-error", step: "claim", error });
				return;
			}
			// An undo is as urgent as a landing: before anything that may take long.
			for (const request of claimed)
				if (request.kind === "undo") counts[await this.#guarded(request, () => this.#undo(request, scoped))] += 1;
			for (const request of claimed) if (request.kind !== "undo") this.#start(request, signal);
		});
		return counts;
	}

	/** Every download and restore that runs beside the passes has ended (after a stop, each ends as busy). */
	async settled(): Promise<void> {
		while (this.#beside.size) await Promise.allSettled([...this.#beside]);
	}

	/** A download or a restore, on beside the passes, under a signal of its own that ends with the executor's. */
	#start(request: CodeDownloadRequest | CodeRestoreRequest, signal: AbortSignal): void {
		const work: Promise<void> = withAbortScope(signal, (scoped) =>
			this.#guarded(request, () =>
				request.kind === "download" ? this.#download(request, scoped) : this.#restoring(request, scoped),
			),
		)
			.then((ended) => {
				this.#ended[ended] += 1;
			})
			.finally(() => this.#beside.delete(work));
		this.#beside.add(work);
	}

	/** One request to its end, whatever it throws. */
	async #guarded(request: CodeRequest, run: () => Promise<Ended>): Promise<Ended> {
		try {
			return await run();
		} catch (error) {
			this.#report({ event: "code-request-error", step: "request", ...named(request), error });
			return "failed";
		}
	}

	async #claim(signal: AbortSignal): Promise<CodeRequest[]> {
		const answer = await this.#call(
			CODE_REQUEST_RPCS[0],
			{ p_owner: this.#owner, p_machine_id_sha256: this.#machineIdSha256, p_limit: this.#limit },
			signal,
		);
		if (!isRecord(answer) || answer.schema !== "qorpera.code-requests/v1" || !Array.isArray(answer.requests))
			throw new Error("CODE_REQUESTS_UNCONFIRMED");
		const claimed: CodeRequest[] = [];
		for (const entry of answer.requests) {
			try {
				claimed.push(requestOf(entry));
			} catch (error) {
				this.#report({ event: "code-request-error", step: "claim", error });
				// A request this executor cannot read is not left to be claimed again and again: it ends failed, when it
				// names its lease.
				const { requestId, token } = isRecord(entry) ? entry : {};
				if (isUuid(requestId) && isUuid(token))
					await this.#finish(
						{ requestId, token },
						{ schema: SCHEMA, state: "failed", code: "REQUEST_INVALID" },
						signal,
						1,
					);
			}
		}
		return claimed;
	}

	/** An undo: one new commit on main that takes the change out, in a job that does not yield. A landing that won main
	 * meanwhile (`CODE_HOST_BASE_MOVED`) wrote nothing, and the undo is made once more from the new main. */
	async #undo(request: CodeUndoRequest, signal: AbortSignal): Promise<Ended> {
		const repository = repositoryOf(request);
		// What the job left: the undo's outcome, whether the kernel took it inside the job, and the files to confirm.
		const left: {
			outcome?: CodeRequestOutcome;
			finished?: "recorded" | "lost";
			confirm?: () => Promise<void>;
		} = {};
		let failure: { error: unknown } | undefined;
		for (let again = true; ; again = false) {
			try {
				await this.#hosts.run(request.companyId, request.environmentId, signal, async (job) => {
					const undone = await this.#jobs.undo(job, {
						repository,
						requestId: request.requestId,
						change: request.change,
						andLater: request.andLater,
						message: request.message,
					});
					// Main has moved, and a ref is saved where git commits it: from here on nothing may fail the job.
					await this.#undoneInJob(request, job, undone, left);
				});
			} catch (error) {
				if (
					again &&
					!signal.aborted &&
					left.outcome === undefined &&
					error instanceof CodeHostJobFailure &&
					error.code === "CODE_HOST_BASE_MOVED"
				)
					continue;
				failure = { error };
			}
			break;
		}
		if (left.outcome !== undefined) {
			// The undo answered: main is where it says, also when the job failed afterwards (its files were not saved then,
			// and nothing of them is confirmed).
			if (failure)
				this.#report({ event: "code-request-error", step: "job", ...named(request), error: failure.error });
			const finished = left.finished ?? (await this.#finish(request, left.outcome, signal, 2));
			if (!failure && left.confirm)
				try {
					await answeredBefore(left.confirm, AbortSignal.timeout(Math.ceil(this.#recordMs / 2)));
				} catch (error) {
					this.#report({ event: "code-request-error", step: "files", ...named(request), error });
				}
			return this.#said(request, left.outcome, finished);
		}
		let outcome: CodeRequestOutcome;
		const error = failure?.error;
		if (signal.aborted) outcome = { schema: SCHEMA, state: "busy" };
		else if (error instanceof CodeHostRefusal && UNDO_REFUSALS.test(error.code))
			outcome = {
				schema: SCHEMA,
				state: "refused",
				code: error.code,
				// The files the refusal named, as many as the outcome takes. A commit that is not here names no file.
				paths: error.code === "CODE_HOST_UNDO_UNKNOWN_COMMIT" ? [] : codeChangeRefusalPaths(error.paths),
			};
		else {
			outcome = {
				schema: SCHEMA,
				state: "failed",
				code: failure ? codeChangeErrorCode(error) : "CODE_REQUEST_ANSWER_INVALID",
			};
			if (failure) this.#report({ event: "code-request-error", step: "job", ...named(request), error });
		}
		return this.#said(request, outcome, await this.#finish(request, outcome, signal, 2));
	}

	/** Inside an undo's job, once the undo answered: the finish, so the kernel writes the undo's row while the company's
	 * line is held, and then the record's files that are due (the undo's own, its targets', the list), under one
	 * deadline for both. It never throws. */
	async #undoneInJob(
		request: CodeUndoRequest,
		job: CodeHostJob,
		undone: Awaited<ReturnType<typeof undoCodeChange>>,
		left: { outcome?: CodeRequestOutcome; finished?: "recorded" | "lost"; confirm?: () => Promise<void> },
	): Promise<void> {
		try {
			if (undone?.state === "nothing" && sha(undone.mainSha))
				left.outcome = { schema: SCHEMA, state: "done", result: "nothing", mainSha: undone.mainSha };
			else {
				const diff = undone?.state === "undone" ? codeChangeDiffOf(undone.diff) : undefined;
				if (undone?.state !== "undone" || !sha(undone.mainBefore) || !sha(undone.mainAfter) || !diff) return;
				left.outcome = {
					schema: SCHEMA,
					state: "done",
					result: "undone",
					mainBefore: undone.mainBefore,
					mainAfter: undone.mainAfter,
					...codeChangeDiffReported(diff),
				};
			}
			const bounded = AbortSignal.any([job.signal, AbortSignal.timeout(this.#recordMs)]);
			const outcome = left.outcome;
			left.finished = await answeredBefore(() => this.#finish(request, outcome, bounded, 1), bounded);
			// Only a row the kernel wrote has files.
			if (left.finished !== "recorded" || outcome.state !== "done" || outcome.result !== "undone") return;
			left.confirm = await answeredBefore(
				() =>
					this.#records.inJob(
						{ shell: job.shell, layout: job.layout, signal: bounded },
						targetOf(request),
						bounded,
					),
				bounded,
			);
		} catch (error) {
			this.#report({ event: "code-request-error", step: "record", ...named(request), error });
		}
	}

	/** A download: the file made, or an expired one removed, in a job that yields to a turn's. With its place in the
	 * company's line, before its first command, the job asks the kernel whether the request is still this executor's.
	 * That step must stay the first thing the job does: on `go` the kernel has ended the made download whose file the
	 * job is about to replace (`qorpera_code_request_step`), and a job whose step was not answered `go` writes
	 * nothing. */
	async #download(request: CodeDownloadRequest, signal: AbortSignal): Promise<Ended> {
		const repository = repositoryOf(request);
		let outcome: CodeRequestOutcome;
		try {
			outcome = await this.#hosts.run(
				request.companyId,
				request.environmentId,
				signal,
				async (job): Promise<CodeRequestOutcome> => {
					const step = await this.#step(request, job.signal);
					if (step !== "go") throw new RequestStopped(step);
					if (request.work === "remove") {
						await this.#jobs.removeDownloads(job, { repository, fileNames: [request.fileName] });
						return { schema: SCHEMA, state: "done", result: "removed" };
					}
					const made = await this.#jobs.archive(job, {
						repository,
						file: request.file,
						fileName: request.fileName,
					});
					if (
						made?.path !== request.path ||
						!whole(made.bytes) ||
						typeof made.sha256 !== "string" ||
						!SHA256_HEX_PATTERN.test(made.sha256) ||
						!sha(made.mainSha)
					)
						throw new Error("CODE_REQUEST_ANSWER_INVALID");
					return {
						schema: SCHEMA,
						state: "done",
						result: "made",
						path: made.path,
						bytes: made.bytes,
						sha256: made.sha256,
						mainSha: made.mainSha,
					};
				},
				{ yields: true },
			);
		} catch (error) {
			if (error instanceof RequestStopped && error.stop === "lost") {
				// The lease is another's, or gone: nothing is this executor's to finish.
				this.#report({
					event: "code-request-error",
					step: "step",
					...named(request),
					error: new Error("CODE_REQUEST_LEASE_LOST"),
				});
				return "failed";
			}
			// A turn's job joined the line, the kernel's rows were busy, or the executor is stopping: the job saved nothing,
			// and the request is asked again.
			if (
				signal.aborted ||
				error instanceof RequestStopped ||
				(error instanceof CodeHostJobFailure && error.code === YIELDED) ||
				error instanceof CodingControlBusy
			)
				outcome = { schema: SCHEMA, state: "busy" };
			else if (error instanceof CodeHostRefusal && error.code === "CODE_HOST_DOWNLOAD_TOO_LARGE")
				outcome = { schema: SCHEMA, state: "refused", code: error.code };
			else {
				outcome = { schema: SCHEMA, state: "failed", code: codeChangeErrorCode(error) };
				this.#report({ event: "code-request-error", step: "job", ...named(request), error });
			}
		}
		// The file is in the folder only once its job has saved: the finish comes after it.
		return this.#said(request, outcome, await this.#finish(request, outcome, signal, 2));
	}

	/** A restore: part R's steps, and their outcome finished. A restore that put the repository back and names sessions
	 * it stranded has them archived before the finish and, for what that left, once more after it (`#strand`). */
	async #restoring(request: CodeRestoreRequest, signal: AbortSignal): Promise<Ended> {
		let outcome: CodeRequestOutcome;
		const restore = this.#restore;
		if (!restore) outcome = { schema: SCHEMA, state: "failed", code: "NOT_BUILT" };
		else
			try {
				const ended: unknown = await restore.run(request, signal);
				if (!isRecord(ended) || !["done", "refused", "busy", "failed"].includes(ended.state as string))
					throw new Error("CODE_REQUEST_ANSWER_INVALID");
				outcome = { ...ended, schema: SCHEMA } as CodeRequestOutcome;
			} catch (error) {
				if (signal.aborted || (error instanceof CodeHostJobFailure && error.code === YIELDED))
					outcome = { schema: SCHEMA, state: "busy" };
				else {
					outcome = { schema: SCHEMA, state: "failed", code: codeChangeErrorCode(error) };
					this.#report({ event: "code-request-error", step: "job", ...named(request), error });
				}
			}
		const stranded = strandedOf(outcome);
		const left = stranded.length ? await this.#strand(request, stranded, "before", signal) : [];
		const ended = this.#said(request, outcome, await this.#finish(request, outcome, signal, 2));
		if (left.length) await this.#strand(request, left, "after", signal);
		return ended;
	}

	/** The sessions a restore stranded, archived (`qorpera_code_restore_strand`, at most 200 a call): the repository's
	 * sessions whose branch and base commit the restored repository does not hold, whose next turn could not start.
	 * The kernel archives those whose worker is not active and counts the others, and leaves a request whose restore it
	 * has not recorded alone (`lost`). Asked before the finish, so that the sessions are archived as soon as can be; and
	 * once more after it for what that left: the ids of a call that was not heard, or that found a session at work (its
	 * turn began after the open, and may have ended by now). What the second call leaves is left: such a session's next
	 * turn fails at its start. Each call is tried once and given `strandMs` (5 s) at most, also when the control does not
	 * heed its signal, and none is made once the executor is stopping: so nothing of it holds the finish up, and how the
	 * restore ended never depends on it. (A restore whose finish the kernel did not take is claimed again, and its next
	 * run names the sessions still stranded.) Answers the ids to ask again. */
	async #strand(
		request: CodeRestoreRequest,
		ids: readonly string[],
		at: "before" | "after",
		signal: AbortSignal,
	): Promise<string[]> {
		const again: string[] = [];
		for (let first = 0; first < ids.length; first += CODE_RESTORE_STRAND_IDS) {
			const part = ids.slice(first, first + CODE_RESTORE_STRAND_IDS);
			const bounded = AbortSignal.any([signal, AbortSignal.timeout(this.#strandMs)]);
			try {
				const answer = await answeredBefore(
					() =>
						this.#call(
							CODE_REQUEST_RPCS[4],
							{
								p_owner: this.#owner,
								p_machine_id_sha256: this.#machineIdSha256,
								p_request_id: request.requestId,
								p_stranded: part,
							},
							bounded,
						),
					bounded,
				);
				if (isRecord(answer) && answer.schema === STRAND) {
					if (answer.state === "lost") {
						// Not this executor's, or no restore the kernel recorded: asking again would change nothing.
						this.#report({
							event: "code-request-error",
							step: "strand",
							...named(request),
							at,
							error: new Error("CODE_RESTORE_STRAND_LOST"),
						});
						continue;
					}
					if (answer.state === "done" && whole(answer.archived) && whole(answer.active)) {
						this.#report({
							event: "code-request",
							step: "stranded",
							...named(request),
							at,
							sessions: part.length,
							archived: answer.archived,
							active: answer.active,
						});
						if (answer.active > 0) again.push(...part);
						continue;
					}
				}
				throw new Error("CODE_RESTORE_STRAND_UNCONFIRMED");
			} catch (error) {
				// The executor is stopping: this call was cut off, or never made (`answeredBefore` makes none under a signal
				// that has ended), and none follows it.
				if (signal.aborted) return [];
				this.#report({ event: "code-request-error", step: "strand", ...named(request), at, error });
				again.push(...part);
			}
		}
		return again;
	}

	/** Renews the request's lease and asks whether it is still this executor's to do. */
	async #step(request: CodeRequest, signal: AbortSignal): Promise<"go" | "busy" | "lost"> {
		const answer = await this.#call(
			CODE_REQUEST_RPCS[1],
			{
				p_owner: this.#owner,
				p_machine_id_sha256: this.#machineIdSha256,
				p_request_id: request.requestId,
				p_token: request.token,
				p_progress: null,
			},
			signal,
		);
		if (
			isRecord(answer) &&
			answer.schema === "qorpera.code-request-step/v1" &&
			(answer.state === "go" || answer.state === "busy" || answer.state === "lost")
		)
			return answer.state;
		throw new Error("CODE_REQUEST_STEP_UNCONFIRMED");
	}

	/** Records a request's outcome, asked `tries` times while no answer comes; an executor that is stopping still gets a
	 * few seconds for it. Answers what the kernel said, or undefined when it was not heard (which is reported): the
	 * request's lease then ends, and it is claimed again. */
	async #finish(
		request: Pick<Claimed, "requestId" | "token">,
		outcome: CodeRequestOutcome,
		signal: AbortSignal,
		tries: number,
	): Promise<"recorded" | "lost" | undefined> {
		let failure: unknown;
		for (let tried = 0; tried < tries; tried++) {
			try {
				const answer = await this.#call(
					CODE_REQUEST_RPCS[2],
					{
						p_owner: this.#owner,
						p_machine_id_sha256: this.#machineIdSha256,
						p_request_id: request.requestId,
						p_token: request.token,
						p_outcome: outcome,
					},
					signal.aborted ? AbortSignal.timeout(CALL_MS / 2) : signal,
				);
				if (isRecord(answer) && answer.schema === "qorpera.code-request-finish/v1") {
					if (answer.state === "recorded") return "recorded";
					// The lease ended, or another claim has the request: nothing was recorded, and asking again would
					// change nothing.
					if (answer.state === "lost") return "lost";
				}
				failure = new Error("CODE_REQUEST_FINISH_UNCONFIRMED");
			} catch (error) {
				failure = error;
			}
		}
		this.#report({ event: "code-request-error", step: "finish", requestId: request.requestId, error: failure });
		return undefined;
	}

	/** The log line of a request that ended, and how it counts. */
	#said(request: CodeRequest, outcome: CodeRequestOutcome, finished: "recorded" | "lost" | undefined): Ended {
		if (finished === "lost")
			this.#report({
				event: "code-request-error",
				step: "finish",
				...named(request),
				error: new Error("CODE_REQUEST_FINISH_LOST"),
			});
		this.#report({
			event: "code-request",
			step: "finished",
			...named(request),
			state: outcome.state,
			...("result" in outcome ? { result: outcome.result } : {}),
			...("code" in outcome ? { code: outcome.code } : {}),
			recorded: finished === "recorded",
		});
		return finished === "recorded" ? outcome.state : "failed";
	}

	#call(method: (typeof CODE_REQUEST_RPCS)[number], args: Record<string, unknown>, signal: AbortSignal) {
		return this.#control.call(method, args, AbortSignal.any([signal, AbortSignal.timeout(CALL_MS)]));
	}
}

/** The sessions a restore that put the repository back says it stranded, each once; none for any other outcome. */
function strandedOf(outcome: CodeRequestOutcome): string[] {
	if (outcome.state !== "done" || outcome.result !== "restored" || !Array.isArray(outcome.stranded)) return [];
	return [...new Set(outcome.stranded.filter((id) => isUuid(id)))];
}
function repositoryOf(request: Claimed): CloudCodingRepository {
	return parseCloudCodingRepository({ host: "qorpera", owner: request.owner, name: request.name, baseBranch: "main" });
}
function targetOf(request: Claimed): CodeChangeTarget {
	return {
		companyId: request.companyId,
		environmentId: request.environmentId,
		owner: request.owner,
		name: request.name,
	};
}
function named(request: CodeRequest): Record<string, unknown> {
	return {
		requestId: request.requestId,
		kind: request.kind,
		companyId: request.companyId,
		environmentId: request.environmentId,
		repository: `${request.owner}/${request.name}`,
	};
}
