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
	type CodeChangeUndoInput,
	type CodeChangeUndone,
	type CodeHostJob,
	CodeHostJobFailure,
	CodeHostRefusal,
	type diffCodeArea,
	type listCodeBranches,
	type logCodeArea,
	type previewCodeMerge,
	type pruneCodeArea,
	type removeCodeDownloads,
	type showCodeFile,
	type startCodeArea,
	type tagCodeArea,
} from "./code-host-jobs.ts";
import type { pinCodeSiteTree } from "./code-host-sites.ts";
import type { CodeHostJobs } from "./code-host-views.ts";
import {
	CODE_IMPORT_RPCS,
	type CodeImportOutcome,
	type CodeImportRequest,
	codeImportOutcomeOf,
	codeImportRequestOf,
} from "./code-import.ts";
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
 *   import     existing code brought in (step 6): part C3's `CodeImport` runs its steps (`options.imports`), and
 *              its outcome is finished when the run ends. One at a time: while one runs, a claim does not ask for
 *              another (`p_kinds`), and without `options.imports` it never asks for one. An import the claim did not
 *              ask for is put back (`busy`) at once.
 *
 * A download, a restore and an import may take minutes (an import up to about an hour): they run on beside the
 * passes, so that an undo never waits behind one, nor does a pass. What they came to is counted in the pass after they
 * ended, and `settled` waits for them. */

export const CODE_REQUEST_RPCS = [
	"qorpera_code_requests_claim",
	"qorpera_code_request_step",
	"qorpera_code_request_finish",
	// A restore's own: `CodeRestore` makes it (`CODE_RESTORE_RPCS`). It is named here because this list is the one the
	// executor's control allows the requests.
	"qorpera_code_restore_record",
	// The sessions a restore stranded, archived around its finish (`#strand`).
	"qorpera_code_restore_strand",
	// An import's own: `CodeImport` makes them (the look, and the record inside the job that opens the place).
	...CODE_IMPORT_RPCS,
] as const;

/** The kinds a claim asks for (`p_kinds` of `qorpera_code_requests_claim`); `import` with them only while this executor
 * can take one. */
const KINDS = ["undo", "download", "restore"] as const;

/** How many stranded sessions one `qorpera_code_restore_strand` names at most. */
export const CODE_RESTORE_STRAND_IDS = 200;

export interface CodeRequestJobs {
	undo: (job: CodeHostJob, value: CodeChangeUndoInput) => Promise<CodeChangeUndone>;
	archive: typeof archiveCodeArea;
	removeDownloads: typeof removeCodeDownloads;
	start?: typeof startCodeArea;
	log?: typeof logCodeArea;
	diff?: typeof diffCodeArea;
	show?: typeof showCodeFile;
	branches?: typeof listCodeBranches;
	mergePreview?: typeof previewCodeMerge;
	tag?: typeof tagCodeArea;
	prune?: typeof pruneCodeArea;
	pinSite?: typeof pinCodeSiteTree;
}

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
	change: { n: number; mainBefore: string; mainAfter: string };
	andLater: boolean;
	message: string;
	dryRun?: boolean;
	runChecks?: boolean;
	force?: boolean;
	checksEnabled?: boolean;
	priorVerifiedChange?: number | null;
	siteConfigured?: boolean;
	priorSite?: { change: number; tree: string } | null;
	targets?: { n: number; mainBefore: string; mainAfter: string }[];
}
export interface CodeQueryRequest extends Claimed {
	kind: "query";
	op: "log" | "diff" | "show" | "branches" | "merge_preview";
	query: Record<string, unknown>;
}
export interface CodeLifecycleRequest extends Claimed {
	kind: "lifecycle";
	op: "create" | "tag" | "prune";
	lifecycle: Record<string, unknown>;
}
export interface CodeDownloadRequest extends Claimed {
	kind: "download";
	work: "make" | "remove";
	file: "files" | "history";
	fileName: string;
	path: string;
}
export interface CodeRestoreRequest extends Claimed {
	kind: "restore";
	mode: "verify" | "restore" | "discard";
	bundle: string | null;
	damaged: "keep" | "remove" | null;
	progress: Record<string, unknown> | null;
	path: string | null;
	sessions: { workerId: string; baseSha: string }[];
}
export type CodeRequest =
	| CodeUndoRequest
	| CodeQueryRequest
	| CodeLifecycleRequest
	| CodeDownloadRequest
	| CodeRestoreRequest
	| CodeImportRequest;

export type CodeRequestOutcome = CodeImportOutcome | CodeOtherOutcome;
type CodeOtherOutcome = { schema: "qorpera.code-request-outcome/v1" } & (
	| {
			state: "done";
			result: "undone";
			mainBefore: string;
			mainAfter: string;
			filesChanged: number;
			paths: CodeChangePath[];
			pathsMore: number;
			matchesBeforeTree?: boolean;
			checksVerified?: "passed" | "inherited" | "none" | "off" | "not_run";
			siteReused?: boolean;
			siteNeedsRebuild?: boolean;
	  }
	| {
			state: "done";
			result: "dry_run";
			clean: boolean;
			mainBefore: string;
			filesChanged: number;
			paths: CodeChangePath[];
			pathsMore: number;
			wouldRevert: number[];
			matchesBeforeTree: boolean;
			checksFilePresent: boolean;
			conflictedPaths: string[];
			conflictMessages: string[];
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
	| { state: "done"; result: "ok"; data: Record<string, unknown> }
	| { state: "done"; result: "created"; mainSha: string; created: boolean }
	| { state: "done"; result: "tagged"; tag: string; kind: "annotated" | "lightweight"; sha: string; targetSha: string }
	| { state: "done"; result: "tags"; tags: Record<string, unknown>[] }
	| {
			state: "done";
			result: "pruned";
			retiredWorktrees: string[];
			deletedBranches: string[];
			skippedWorktrees: { workerId: string; reason: string }[];
	  }
	| { state: "refused"; code: string; paths?: string[]; messages?: string[] }
	| { state: "busy" }
	| { state: "failed"; code: string }
);

export interface CodeHostRequestsOptions {
	control: { call(method: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> };
	hosts: Pick<CodeHostJobs, "run">;
	jobs: CodeRequestJobs;
	records: Pick<CodeChangeRecords, "inJob">;
	sites?: { wake(): void };
	verifyUndoChecks?: (
		request: CodeUndoRequest,
		candidate: { commitSha: string; mainBefore: string; matchesBeforeTree: boolean; checksFilePresent: boolean },
		job: CodeHostJob,
	) => Promise<"passed" | "inherited" | "none" | "off" | "not_run">;
	restore?: { run(request: CodeRestoreRequest, signal: AbortSignal): Promise<CodeRequestOutcome> };
	imports?: { run(request: CodeImportRequest, signal: AbortSignal): Promise<CodeImportOutcome> };
	owner: string;
	machineIdSha256: string;
	report?: (event: Record<string, unknown>) => void;
	limit?: number;
	recordMs?: number;
	strandMs?: number;
}

type Ended = "done" | "refused" | "failed" | "busy";
type Counts = Record<Ended, number>;

const SCHEMA = "qorpera.code-request-outcome/v1";
const STRAND = "qorpera.code-restore-strand/v1";
const CALL_MS = 10_000;
const SHA = /^[0-9a-f]{40}$/;
const YIELDED = "CODE_HOST_JOB_YIELDED";
const UNDO_REFUSALS =
	/^CODE_HOST_(?:UNDO_CONFLICT|UNDO_NOT_IN_MAIN|UNDO_UNKNOWN_COMMIT|UNDO_CHECKS_[A-Z0-9_]{1,40}|NAMES_[A-Z0-9_]{1,60})$/;
const QUERY_REFUSALS =
	/^CODE_HOST_(?:REF_NOT_FOUND|FILE_NOT_FOUND|SYMLINK_REFUSED|NOT_A_FILE|BINARY_FILE|NOT_SEEDED|AREA_FROM_GITHUB|AREA_NO_BASE|RESTORE_IN_PROGRESS)$/;
const LIFECYCLE_REFUSALS =
	/^CODE_HOST_(?:TAG_EXISTS|REF_NOT_FOUND|NOT_SEEDED|AREA_FROM_GITHUB|AREA_NO_BASE|RESTORE_IN_PROGRESS)$/;

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
	// An import's item is part C1's to read, closed: its input, progress and look as well.
	if (entry.kind === "import") return codeImportRequestOf(value);
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
		const parsed: CodeUndoRequest = {
			...claimed,
			kind: "undo",
			change: { n: change.n, mainBefore: change.mainBefore, mainAfter: change.mainAfter },
			andLater: entry.andLater,
			message: withinBytes(entry.message, 4096),
		};
		if (entry.dryRun !== undefined) {
			if (typeof entry.dryRun !== "boolean") throw new Error("CODE_REQUEST_INVALID");
			parsed.dryRun = entry.dryRun;
		}
		if (entry.runChecks !== undefined) {
			if (typeof entry.runChecks !== "boolean") throw new Error("CODE_REQUEST_INVALID");
			parsed.runChecks = entry.runChecks;
		}
		if (entry.force !== undefined) {
			if (typeof entry.force !== "boolean") throw new Error("CODE_REQUEST_INVALID");
			parsed.force = entry.force;
		}
		if (entry.checksEnabled !== undefined) {
			if (typeof entry.checksEnabled !== "boolean") throw new Error("CODE_REQUEST_INVALID");
			parsed.checksEnabled = entry.checksEnabled;
		}
		if (entry.priorVerifiedChange !== undefined) {
			if (entry.priorVerifiedChange === null) parsed.priorVerifiedChange = null;
			else if (whole(entry.priorVerifiedChange, 1)) parsed.priorVerifiedChange = entry.priorVerifiedChange;
			else throw new Error("CODE_REQUEST_INVALID");
		}
		if (entry.siteConfigured !== undefined) {
			if (typeof entry.siteConfigured !== "boolean") throw new Error("CODE_REQUEST_INVALID");
			parsed.siteConfigured = entry.siteConfigured;
		}
		if (entry.priorSite !== undefined) {
			if (entry.priorSite === null) parsed.priorSite = null;
			else if (isRecord(entry.priorSite) && whole(entry.priorSite.change, 1) && sha(entry.priorSite.tree)) {
				parsed.priorSite = { change: entry.priorSite.change, tree: entry.priorSite.tree };
			} else throw new Error("CODE_REQUEST_INVALID");
		}
		if (entry.targets !== undefined) {
			if (!Array.isArray(entry.targets) || entry.targets.length < 1 || entry.targets.length > 50)
				throw new Error("CODE_REQUEST_INVALID");
			parsed.targets = entry.targets.map((item) => {
				if (!isRecord(item) || !whole(item.n, 1) || !sha(item.mainBefore) || !sha(item.mainAfter))
					throw new Error("CODE_REQUEST_INVALID");
				return { n: item.n, mainBefore: item.mainBefore, mainAfter: item.mainAfter };
			});
		}
		return parsed;
	}
	if (entry.kind === "query") {
		const op = entry.op;
		if (
			(op !== "log" && op !== "diff" && op !== "show" && op !== "branches" && op !== "merge_preview") ||
			!isRecord(entry.query)
		)
			throw new Error("CODE_REQUEST_INVALID");
		return { ...claimed, kind: "query", op, query: entry.query };
	}
	if (entry.kind === "lifecycle") {
		const op = entry.op;
		if ((op !== "create" && op !== "tag" && op !== "prune") || !isRecord(entry.lifecycle))
			throw new Error("CODE_REQUEST_INVALID");
		return { ...claimed, kind: "lifecycle", op, lifecycle: entry.lifecycle };
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
	readonly #sites: CodeHostRequestsOptions["sites"];
	readonly #verifyUndoChecks: CodeHostRequestsOptions["verifyUndoChecks"];
	readonly #restore: CodeHostRequestsOptions["restore"];
	readonly #imports: CodeHostRequestsOptions["imports"];
	readonly #owner: string;
	readonly #machineIdSha256: string;
	readonly #report: (event: Record<string, unknown>) => void;
	readonly #limit: number;
	readonly #recordMs: number;
	readonly #strandMs: number;
	readonly #beside = new Set<Promise<void>>();
	#importing: Promise<void> | undefined;
	#ended: Counts = zero();
	#woken = false;
	readonly #waiting = new Set<() => void>();

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
		this.#sites = options.sites;
		this.#verifyUndoChecks = options.verifyUndoChecks;
		this.#restore = options.restore;
		this.#imports = options.imports;
		this.#owner = options.owner;
		this.#machineIdSha256 = options.machineIdSha256;
		const report = options.report;
		this.#report = (event) => {
			try {
				report?.(event);
			} catch {
				undefined;
			}
		};
		this.#limit = limit;
		this.#recordMs = recordMs;
		this.#strandMs = strandMs;
	}

	wake(): void {
		this.#woken = true;
		for (const end of [...this.#waiting]) end();
	}

	wait(ms: number, signal: AbortSignal): Promise<void> {
		return new Promise<void>((resolve) => {
			if (this.#woken || signal.aborted) {
				this.#woken = false;
				resolve();
				return;
			}
			const end = () => {
				clearTimeout(timer);
				signal.removeEventListener("abort", end);
				this.#waiting.delete(end);
				this.#woken = false;
				resolve();
			};
			const timer = setTimeout(end, Math.max(0, ms));
			signal.addEventListener("abort", end, { once: true });
			this.#waiting.add(end);
		});
	}

	async pass(signal: AbortSignal): Promise<Counts> {
		const counts = this.#ended;
		this.#ended = zero();
		await withAbortScope(signal, async (scoped) => {
			let claimed: CodeRequest[];
			try {
				claimed = await this.#claim(scoped);
			} catch (error) {
				if (!scoped.aborted) this.#report({ event: "code-request-error", step: "claim", error });
				return;
			}
			for (const request of claimed) {
				if (request.kind === "undo") counts[await this.#guarded(request, () => this.#undo(request, scoped))] += 1;
				else if (request.kind === "query")
					counts[await this.#guarded(request, () => this.#query(request, scoped))] += 1;
				else if (request.kind === "lifecycle")
					counts[await this.#guarded(request, () => this.#lifecycle(request, scoped))] += 1;
			}
			for (const request of claimed) {
				if (request.kind === "download" || request.kind === "restore" || request.kind === "import")
					this.#start(request, signal);
			}
		});
		return counts;
	}

	/** Every download, restore and import that runs beside the passes has ended (after a stop, each ends as busy). */
	async settled(): Promise<void> {
		while (this.#beside.size) await Promise.allSettled([...this.#beside]);
	}

	/** A download, a restore or an import, on beside the passes, under a signal of its own that ends with the
	 * executor's. An import runs only when this executor has an import runner and runs no other: otherwise it was not
	 * asked for, and it is put back at once. */
	#start(request: CodeDownloadRequest | CodeRestoreRequest | CodeImportRequest, signal: AbortSignal): void {
		const runner = request.kind === "import" && this.#importing === undefined ? this.#imports : undefined;
		const work: Promise<void> = withAbortScope(signal, (scoped) =>
			this.#guarded(request, () => {
				if (request.kind === "download") return this.#download(request, scoped);
				if (request.kind === "restore") return this.#restoring(request, scoped);
				return runner ? this.#imported(runner, request, scoped) : this.#putBack(request, scoped);
			}),
		)
			.then((ended) => {
				this.#ended[ended] += 1;
			})
			.finally(() => {
				this.#beside.delete(work);
				if (this.#importing === work) this.#importing = undefined;
			});
		this.#beside.add(work);
		if (runner) this.#importing = work;
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

	#hasQueryJobs(): boolean {
		return Boolean(
			this.#jobs.log || this.#jobs.diff || this.#jobs.show || this.#jobs.branches || this.#jobs.mergePreview,
		);
	}

	#hasLifecycleJobs(): boolean {
		return Boolean(this.#jobs.start || this.#jobs.tag || this.#jobs.prune);
	}

	async #claim(signal: AbortSignal): Promise<CodeRequest[]> {
		const kinds: string[] = [...KINDS];
		if (this.#imports !== undefined && this.#importing === undefined) kinds.push("import");
		if (this.#hasQueryJobs()) kinds.push("query");
		if (this.#hasLifecycleJobs()) kinds.push("lifecycle");
		const answer = await this.#call(
			CODE_REQUEST_RPCS[0],
			{ p_owner: this.#owner, p_machine_id_sha256: this.#machineIdSha256, p_limit: this.#limit, p_kinds: kinds },
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

	async #undo(request: CodeUndoRequest, signal: AbortSignal): Promise<Ended> {
		const repository = repositoryOf(request);
		const isV2 =
			request.dryRun !== undefined ||
			request.runChecks !== undefined ||
			request.force !== undefined ||
			request.checksEnabled !== undefined ||
			request.siteConfigured !== undefined ||
			request.priorSite !== undefined ||
			request.targets !== undefined;
		if (request.dryRun === true) {
			let outcome: CodeRequestOutcome;
			try {
				const preview = await this.#hosts.run(
					request.companyId,
					request.environmentId,
					signal,
					(job) =>
						this.#jobs.undo(job, {
							repository,
							requestId: request.requestId,
							change: request.change,
							andLater: request.andLater,
							message: request.message,
							dryRun: true,
							...(request.targets ? { targets: request.targets } : {}),
						}),
					{ readOnly: true },
				);
				if (preview.state !== "dry_run") throw new Error("CODE_REQUEST_ANSWER_INVALID");
				const wouldRevert = request.targets
					? request.targets.map((t) => t.n).sort((a, b) => a - b)
					: [request.change.n];
				outcome = {
					schema: SCHEMA,
					state: "done",
					result: "dry_run",
					clean: preview.clean,
					mainBefore: preview.mainBefore,
					filesChanged: preview.filesChanged,
					paths: preview.paths,
					pathsMore: preview.pathsMore,
					wouldRevert,
					matchesBeforeTree: preview.matchesBeforeTree,
					checksFilePresent: preview.checksFilePresent,
					conflictedPaths: preview.conflictedPaths,
					conflictMessages: preview.conflictMessages,
				};
			} catch (error) {
				if (signal.aborted) outcome = { schema: SCHEMA, state: "busy" };
				else if (error instanceof CodeHostRefusal && UNDO_REFUSALS.test(error.code))
					outcome = {
						schema: SCHEMA,
						state: "refused",
						code: error.code,
						paths: error.code === "CODE_HOST_UNDO_UNKNOWN_COMMIT" ? [] : codeChangeRefusalPaths(error.paths),
						...(error.messages.length ? { messages: [...error.messages] } : {}),
					};
				else {
					outcome = { schema: SCHEMA, state: "failed", code: codeChangeErrorCode(error) };
					this.#report({ event: "code-request-error", step: "job", ...named(request), error });
				}
			}
			return this.#said(request, outcome, await this.#finish(request, outcome, signal, 2));
		}
		const left: {
			outcome?: CodeRequestOutcome;
			finished?: { state: "recorded"; change: number | null } | { state: "lost" };
			confirm?: () => Promise<void>;
			wakeSites?: boolean;
		} = {};
		let checksVerified: "passed" | "inherited" | "none" | "off" | "not_run" | undefined;
		let failure: { error: unknown } | undefined;
		for (let again = true; ; again = false) {
			try {
				await this.#hosts.run(request.companyId, request.environmentId, signal, async (job) => {
					const verifyChecks =
						request.runChecks === true && request.force !== true
							? async (candidate: {
									commitSha: string;
									mainBefore: string;
									matchesBeforeTree: boolean;
									checksFilePresent: boolean;
								}): Promise<void> => {
									if (!candidate.checksFilePresent) {
										checksVerified = "none";
										return;
									}
									if (request.checksEnabled === false) {
										checksVerified = "off";
										return;
									}
									if (candidate.matchesBeforeTree && request.priorVerifiedChange != null) {
										checksVerified = "inherited";
										return;
									}
									if (this.#verifyUndoChecks) {
										checksVerified = await this.#verifyUndoChecks(request, candidate, job);
										return;
									}
									throw new CodeHostRefusal(
										"CODE_HOST_UNDO_CHECKS_REQUIRED",
										[".qorpera/checks.json"],
										[
											candidate.matchesBeforeTree
												? "Repository has .qorpera/checks.json and the prior commit before this change has no passed checks record; pass force: true for an emergency unchecked revert or dispatch a coding worker to run checks."
												: "Repository has .qorpera/checks.json and reverting without later changes produces an unverified tree; use andLater: true to roll back to a prior checks-verified state, pass force: true for an emergency unchecked revert, or dispatch a coding worker to make a checked revert.",
										],
									);
								}
							: undefined;
					const undone = await this.#jobs.undo(job, {
						repository,
						requestId: request.requestId,
						change: request.change,
						andLater: request.andLater,
						message: request.message,
						...(request.targets ? { targets: request.targets } : {}),
						...(verifyChecks ? { verifyChecks } : {}),
					});
					await this.#undoneInJob(request, job, undone, left, isV2, checksVerified);
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
			if (failure)
				this.#report({ event: "code-request-error", step: "job", ...named(request), error: failure.error });
			const finished = left.finished ?? (await this.#finish(request, left.outcome, signal, 2));
			if (!failure && left.confirm)
				try {
					await answeredBefore(left.confirm, AbortSignal.timeout(Math.ceil(this.#recordMs / 2)));
				} catch (error) {
					this.#report({ event: "code-request-error", step: "files", ...named(request), error });
				}
			if (!failure && left.wakeSites) {
				try {
					this.#sites?.wake();
				} catch (error) {
					this.#report({ event: "code-request-error", step: "wake", ...named(request), error });
				}
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
				paths: error.code === "CODE_HOST_UNDO_UNKNOWN_COMMIT" ? [] : codeChangeRefusalPaths(error.paths),
				...(error.messages.length ? { messages: [...error.messages] } : {}),
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

	async #undoneInJob(
		request: CodeUndoRequest,
		job: CodeHostJob,
		undone: CodeChangeUndone,
		left: {
			outcome?: CodeRequestOutcome;
			finished?: { state: "recorded"; change: number | null } | { state: "lost" };
			confirm?: () => Promise<void>;
			wakeSites?: boolean;
		},
		isV2: boolean,
		checksVerified: "passed" | "inherited" | "none" | "off" | "not_run" | undefined,
	): Promise<void> {
		try {
			if (undone?.state === "nothing" && sha(undone.mainSha))
				left.outcome = { schema: SCHEMA, state: "done", result: "nothing", mainSha: undone.mainSha };
			else {
				const diff = undone?.state === "undone" ? codeChangeDiffOf(undone.diff) : undefined;
				if (undone?.state !== "undone" || !sha(undone.mainBefore) || !sha(undone.mainAfter) || !diff) return;
				const matchesBeforeTree = undone.matchesBeforeTree === true;
				const canReuseSite = Boolean(request.priorSite && matchesBeforeTree);
				const siteNeedsRebuild = Boolean(request.siteConfigured && !canReuseSite);
				const effectiveChecksVerified: "passed" | "inherited" | "none" | "off" | "not_run" =
					checksVerified ??
					(matchesBeforeTree && request.priorVerifiedChange != null
						? "inherited"
						: !undone.checksFilePresent
							? "none"
							: request.checksEnabled === false
								? "off"
								: "not_run");
				left.outcome = {
					schema: SCHEMA,
					state: "done",
					result: "undone",
					mainBefore: undone.mainBefore,
					mainAfter: undone.mainAfter,
					...codeChangeDiffReported(diff),
					...(isV2
						? {
								matchesBeforeTree,
								checksVerified: effectiveChecksVerified,
								...(canReuseSite ? { siteReused: true } : {}),
								...(siteNeedsRebuild ? { siteNeedsRebuild: true } : {}),
							}
						: {}),
				};
			}
			const bounded = AbortSignal.any([job.signal, AbortSignal.timeout(this.#recordMs)]);
			const outcome = left.outcome;
			left.finished = await answeredBefore(() => this.#finish(request, outcome, bounded, 1), bounded);
			if (left.finished?.state !== "recorded" || outcome.state !== "done" || outcome.result !== "undone") return;
			if (
				left.finished.change !== null &&
				request.priorSite &&
				undone.state === "undone" &&
				undone.matchesBeforeTree &&
				this.#jobs.pinSite
			) {
				const pinSite = this.#jobs.pinSite;
				const changeNumber = left.finished.change;
				const priorTree = request.priorSite.tree;
				const repository = repositoryOf(request);
				await answeredBefore(
					() =>
						pinSite(
							{ shell: job.shell, layout: job.layout, signal: bounded },
							{ repository, change: changeNumber, tree: priorTree },
						),
					bounded,
				);
				left.wakeSites = true;
			}
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

	async #query(request: CodeQueryRequest, signal: AbortSignal): Promise<Ended> {
		const repository = repositoryOf(request);
		let outcome: CodeRequestOutcome;
		try {
			const data = await this.#hosts.run(
				request.companyId,
				request.environmentId,
				signal,
				async (job): Promise<Record<string, unknown>> => {
					const q = request.query;
					if (request.op === "log") {
						if (!this.#jobs.log) throw new Error("NOT_BUILT");
						return await this.#jobs.log(job, {
							repository,
							...(typeof q.ref === "string" ? { ref: q.ref } : {}),
							...(typeof q.path === "string" ? { path: q.path } : {}),
							...(typeof q.limit === "number" ? { limit: q.limit } : {}),
							...(typeof q.since === "string" ? { since: q.since } : {}),
						});
					}
					if (request.op === "diff") {
						if (!this.#jobs.diff) throw new Error("NOT_BUILT");
						return await this.#jobs.diff(job, {
							repository,
							from: String(q.from ?? ""),
							to: String(q.to ?? ""),
							...(typeof q.statOnly === "boolean" ? { statOnly: q.statOnly } : {}),
							...(Array.isArray(q.paths) ? { paths: q.paths as string[] } : {}),
							...(typeof q.maxBytes === "number" ? { maxBytes: q.maxBytes } : {}),
						});
					}
					if (request.op === "show") {
						if (!this.#jobs.show) throw new Error("NOT_BUILT");
						return await this.#jobs.show(job, {
							repository,
							...(typeof q.ref === "string" ? { ref: q.ref } : {}),
							path: String(q.path ?? ""),
							...(typeof q.maxBytes === "number" ? { maxBytes: q.maxBytes } : {}),
						});
					}
					if (request.op === "branches") {
						if (!this.#jobs.branches) throw new Error("NOT_BUILT");
						return await this.#jobs.branches(job, { repository });
					}
					if (!this.#jobs.mergePreview) throw new Error("NOT_BUILT");
					return await this.#jobs.mergePreview(job, {
						repository,
						...(typeof q.base === "string" ? { base: q.base } : {}),
						head: String(q.head ?? ""),
					});
				},
				{ readOnly: true },
			);
			outcome = { schema: SCHEMA, state: "done", result: "ok", data };
		} catch (error) {
			if (signal.aborted) outcome = { schema: SCHEMA, state: "busy" };
			else if (error instanceof CodeHostRefusal && QUERY_REFUSALS.test(error.code))
				outcome = {
					schema: SCHEMA,
					state: "refused",
					code: error.code,
					paths: codeChangeRefusalPaths(error.paths),
					...(error.messages.length ? { messages: [...error.messages] } : {}),
				};
			else {
				outcome = { schema: SCHEMA, state: "failed", code: codeChangeErrorCode(error) };
				this.#report({ event: "code-request-error", step: "job", ...named(request), error });
			}
		}
		return this.#said(request, outcome, await this.#finish(request, outcome, signal, 2));
	}

	async #lifecycle(request: CodeLifecycleRequest, signal: AbortSignal): Promise<Ended> {
		const repository = repositoryOf(request);
		let outcome: CodeRequestOutcome;
		try {
			const life = request.lifecycle;
			if (request.op === "create") {
				if (!this.#jobs.start) throw new Error("NOT_BUILT");
				const startJob = this.#jobs.start;
				const started = await this.#hosts.run(request.companyId, request.environmentId, signal, (job) =>
					startJob(job, { repository }),
				);
				outcome = {
					schema: SCHEMA,
					state: "done",
					result: "created",
					mainSha: started.baseSha,
					created: started.state === "started",
				};
			} else if (request.op === "tag") {
				if (!this.#jobs.tag) throw new Error("NOT_BUILT");
				const tagJob = this.#jobs.tag;
				const mode = life.mode === "list" ? "list" : "create";
				const result = await this.#hosts.run(
					request.companyId,
					request.environmentId,
					signal,
					(job) =>
						mode === "list"
							? tagJob(job, { repository, mode: "list" })
							: tagJob(job, {
									repository,
									mode: "create",
									tag: String(life.tag ?? ""),
									...(typeof life.target === "string" ? { target: life.target } : {}),
									...(typeof life.message === "string" ? { message: life.message } : {}),
								}),
					{ readOnly: mode === "list" },
				);
				outcome =
					result.mode === "list"
						? {
								schema: SCHEMA,
								state: "done",
								result: "tags",
								tags: result.tags as unknown as Record<string, unknown>[],
							}
						: {
								schema: SCHEMA,
								state: "done",
								result: "tagged",
								tag: result.tag,
								kind: result.kind,
								sha: result.sha,
								targetSha: result.targetSha,
							};
			} else {
				if (!this.#jobs.prune) throw new Error("NOT_BUILT");
				const pruneJob = this.#jobs.prune;
				const deleteMergedBranches = life.deleteMergedBranches === true;
				const filesPhase = await this.#hosts.run(request.companyId, request.environmentId, signal, async (job) => {
					const step = await this.#stepPrune(request, "files", job.signal);
					if (step.state !== "go") throw new RequestStopped(step.state);
					if (step.candidates.length === 0)
						return {
							candidates: [] as string[],
							retiredWorktrees: [] as string[],
							skippedWorktrees: [] as { workerId: string; reason: string }[],
						};
					const res = await pruneJob(job, { repository, workerIds: step.candidates, phase: "files" });
					return {
						candidates: step.candidates,
						retiredWorktrees: res.retiredWorktrees,
						skippedWorktrees: res.skippedWorktrees,
					};
				});
				const needsGitFolderPass =
					filesPhase.candidates.length > 0 &&
					(filesPhase.retiredWorktrees.length > 0 ||
						filesPhase.skippedWorktrees.some((s) => s.reason === "NOT_THERE") ||
						deleteMergedBranches);
				let retiredWorktrees: string[] = [];
				let deletedBranches: string[] = [];
				const skippedMap = new Map<string, string>();
				for (const item of filesPhase.skippedWorktrees) {
					if (item.reason !== "NOT_THERE") skippedMap.set(item.workerId, item.reason);
				}
				if (needsGitFolderPass) {
					const gitPhase = await this.#hosts.run(request.companyId, request.environmentId, signal, async (job) => {
						const step = await this.#stepPrune(request, "git-folder", job.signal);
						if (step.state !== "go") throw new RequestStopped(step.state);
						if (step.candidates.length === 0)
							return {
								candidates: [] as string[],
								retiredWorktrees: [] as string[],
								deletedBranches: [] as string[],
								skippedWorktrees: [] as { workerId: string; reason: string }[],
							};
						const res = await pruneJob(job, {
							repository,
							workerIds: step.candidates,
							phase: "git-folder",
							deleteMergedBranches,
						});
						return { candidates: step.candidates, ...res };
					});
					for (const item of gitPhase.skippedWorktrees) skippedMap.set(item.workerId, item.reason);
					const candidateSet = new Set(gitPhase.candidates);
					const retiredSet = new Set(gitPhase.retiredWorktrees);
					for (const id of filesPhase.retiredWorktrees) {
						if (candidateSet.has(id) && !skippedMap.has(id)) retiredSet.add(id);
					}
					retiredWorktrees = [...retiredSet];
					deletedBranches = gitPhase.deletedBranches;
				}
				outcome = {
					schema: SCHEMA,
					state: "done",
					result: "pruned",
					retiredWorktrees,
					deletedBranches,
					skippedWorktrees: [...skippedMap.entries()].map(([workerId, reason]) => ({ workerId, reason })),
				};
			}
		} catch (error) {
			if (error instanceof RequestStopped && error.stop === "lost") {
				this.#report({ event: "code-request", ...named(request), state: "lost" });
				return "busy";
			}
			if (signal.aborted || (error instanceof RequestStopped && error.stop === "busy"))
				outcome = { schema: SCHEMA, state: "busy" };
			else if (error instanceof CodeHostRefusal && LIFECYCLE_REFUSALS.test(error.code))
				outcome = {
					schema: SCHEMA,
					state: "refused",
					code: error.code,
					paths: codeChangeRefusalPaths(error.paths),
					...(error.messages.length ? { messages: [...error.messages] } : {}),
				};
			else {
				outcome = { schema: SCHEMA, state: "failed", code: codeChangeErrorCode(error) };
				this.#report({ event: "code-request-error", step: "job", ...named(request), error });
			}
		}
		return this.#said(request, outcome, await this.#finish(request, outcome, signal, 2));
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

	/** An import: part C3's steps, beside the passes, and their outcome finished once the run has ended. The run keeps
	 * the request's lease itself and makes its own calls (the steps, the look, the record). An outcome not of the kernel's
	 * shape is finished failed (`CODE_REQUEST_ANSWER_INVALID`). A run that throws once the executor is stopping, or whose
	 * job gave way to a turn's, is put off (`busy`), as a restore's is; when stopping, the finish has the few seconds
	 * `#finish` gives it, and a finish not heard leaves the request leased until its lease runs out. A run that answered
	 * `busy` because the step that first names its look met a company that was not quiet finds its finish `lost`: the
	 * kernel put the import back in the queue there and gave its claim back (20260930736000). That is a wait, not a
	 * failure: one quiet line (`code-import-waiting`) and it counts as busy. */
	async #imported(
		runner: NonNullable<CodeHostRequestsOptions["imports"]>,
		request: CodeImportRequest,
		signal: AbortSignal,
	): Promise<Ended> {
		let outcome: CodeRequestOutcome;
		let answered = false;
		try {
			const ended: unknown = await runner.run(request, signal);
			try {
				outcome = codeImportOutcomeOf(ended);
				answered = true;
			} catch {
				throw new Error("CODE_REQUEST_ANSWER_INVALID");
			}
		} catch (error) {
			if (signal.aborted || (error instanceof CodeHostJobFailure && error.code === YIELDED))
				outcome = { schema: SCHEMA, state: "busy" };
			else {
				outcome = { schema: SCHEMA, state: "failed", code: codeChangeErrorCode(error) };
				this.#report({ event: "code-request-error", step: "job", ...named(request), error });
			}
		}
		const finished = await this.#finish(request, outcome, signal, 2);
		if (answered && outcome.state === "busy" && finished?.state === "lost") {
			this.#report({ event: "code-import-waiting", requestId: request.requestId });
			return "busy";
		}
		return this.#said(request, outcome, finished);
	}

	/** An import this executor did not ask for: it has no import runner, or one runs already. It is put back (`busy`)
	 * for a claim that asks for it. */
	async #putBack(request: CodeImportRequest, signal: AbortSignal): Promise<Ended> {
		this.#report({
			event: "code-request-error",
			step: "claim",
			...named(request),
			error: new Error("CODE_IMPORT_NOT_ASKED"),
		});
		const outcome: CodeRequestOutcome = { schema: SCHEMA, state: "busy" };
		return this.#said(request, outcome, await this.#finish(request, outcome, signal, 2));
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

	async #stepPrune(
		request: CodeLifecycleRequest,
		phase: "files" | "git-folder",
		signal: AbortSignal,
	): Promise<{ state: "go"; candidates: string[] } | { state: "busy" | "lost" }> {
		const answer = await this.#call(
			CODE_REQUEST_RPCS[1],
			{
				p_owner: this.#owner,
				p_machine_id_sha256: this.#machineIdSha256,
				p_request_id: request.requestId,
				p_token: request.token,
				p_progress: { step: phase },
			},
			signal,
		);
		if (isRecord(answer) && answer.schema === "qorpera.code-request-step/v1") {
			if (answer.state === "busy" || answer.state === "lost") return { state: answer.state };
			if (
				answer.state === "go" &&
				Array.isArray(answer.candidates) &&
				answer.candidates.length <= 200 &&
				answer.candidates.every((id) => isUuid(id))
			)
				return { state: "go", candidates: [...answer.candidates] };
		}
		throw new Error("CODE_REQUEST_STEP_UNCONFIRMED");
	}

	async #finish(
		request: Pick<Claimed, "requestId" | "token">,
		outcome: CodeRequestOutcome,
		signal: AbortSignal,
		tries: number,
	): Promise<{ state: "recorded"; change: number | null } | { state: "lost" } | undefined> {
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
					if (answer.state === "recorded")
						return { state: "recorded", change: whole(answer.change, 1) ? answer.change : null };
					if (answer.state === "lost") return { state: "lost" };
				}
				failure = new Error("CODE_REQUEST_FINISH_UNCONFIRMED");
			} catch (error) {
				failure = error;
			}
		}
		this.#report({ event: "code-request-error", step: "finish", requestId: request.requestId, error: failure });
		return undefined;
	}

	#said(
		request: CodeRequest,
		outcome: CodeRequestOutcome,
		finished: { state: "recorded"; change: number | null } | { state: "lost" } | undefined,
	): Ended {
		if (finished?.state === "lost")
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
			recorded: finished?.state === "recorded",
		});
		return finished?.state === "recorded" ? outcome.state : "failed";
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
