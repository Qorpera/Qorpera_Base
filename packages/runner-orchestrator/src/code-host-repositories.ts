import { isDeepStrictEqual } from "node:util";
import type { CloudCodingRepository } from "@qorpera/contracts";
import { withTimeoutScope } from "./abort-scope.ts";
import {
	answeredBefore,
	type CodeChangeRecords,
	type CodeChangeTarget,
	codeChangeDiffOf,
	codeChangeDiffReported,
	codeChangeRefusalPaths,
} from "./code-change-records.ts";
import {
	CODE_CHECKS_MAIN_MOVED,
	type CodeChecksRun,
	type CodeSiteRecipe,
	codeChecksFailedSummary,
	codeChecksGate,
	codeChecksNotRunSummary,
	codeChecksPassed,
	readCodeChecks,
	surfaceStageChecksGate,
} from "./code-checks.ts";
import {
	addCodeWorktree,
	CODE_LAND_BATCH_MAX,
	type CodeBranchBatchPreparedStep,
	type CodeBranchLanded,
	type CodeBranchToCheck,
	type CodeHostJob,
	CodeHostJobFailure,
	CodeHostRefusal,
	CodeWorktreeNamesRefused,
	codeAreaPath,
	commitCodeBranchBatch,
	diffCodeArea,
	exportCodeBranch,
	landCodeBranch,
	landCodeBranchBatch,
	listCodeBranches,
	logCodeArea,
	previewCodeMerge,
	pruneCodeArea,
	type Run,
	showCodeFile,
	startCodeArea,
	tagCodeArea,
	tail,
	treeRecords,
	undoCodeChange,
	withJob,
} from "./code-host-jobs.ts";
import { attachCodeSession, type CodeAreaBroker } from "./code-host-seed.ts";
import { pinCodeSiteTree } from "./code-host-sites.ts";
import { ensureSurfaceStarterRepository, verifyStagedSurfaceBranch } from "./code-host-surfaces.ts";
import type { CodeHostJobs } from "./code-host-views.ts";
import { codeImportShown } from "./code-import.ts";
import {
	CODE_CHECKS_DRILL,
	CODE_DRILL_WORDS,
	CODE_SITE_DRILL_FOLDER,
	type CodeSiteCollected,
	codeSiteRefusedSummary,
	codeSiteReported,
} from "./code-site.ts";
import { CodingLandConflict, CodingLandRefused, CodingWorkspaceFailed, landRefusal } from "./coding-executor.ts";
import {
	CODING_FOLDER_COMPANY_ROOT,
	type CodeChangeReport,
	type CodeChangeReportV2,
	type CodeChecksSwitched,
	type CodingFolderRepositories,
	type CodingFolderRepositorySession,
	type CodingFolderStart,
	type CodingLanded,
	type CodingStaged,
} from "./coding-folder-repositories.ts";
import {
	type CodingSetupSource,
	EMPTY_CODING_SETUP,
	EMPTY_CODING_SETUP_DIGEST,
	type ParsedCodingSetup,
	parseCodingSetup,
} from "./coding-setup.ts";

/** The largest bundle a session's export hands the broker's push: the NAS path's cap (coding-git-transfer.ts). */
export const CODE_HOST_EXPORT_MAXIMUM_BYTES = 64 * 1024 ** 2;
/** What the member and the agent read when the code host could not make the session's worktree (its code follows). */
const CODE_COPY_FAILED =
	"Making the session's copy of the code failed. The workspace is kept; a follow-up tries again.";
/** The code host's refusal of a file too large for a repository it keeps; its refusals of names are `CODE_HOST_NAMES_*`. */
const TOO_LARGE = "CODE_HOST_FILE_TOO_LARGE";
/** What they read when the code host could not make or read a repository kept in Qorpera. */
const CODE_START_FAILED = "Opening the company's repository failed. Nothing was changed; a follow-up tries again.";
/** And when its folder already holds a copy of a GitHub repository. */
const CODE_AREA_TAKEN =
	"The company folder already holds a copy of a GitHub repository at this repository's place under code/. Nothing was changed; start the work again with another owner or name.";
/** What they read when a turn cannot start because its repository is being put back from its stored copy: every job on
 * it is refused until then. A landing that meets it has its words with the other refusals (`landRefusal`). */
export const CODE_RESTORING =
	"The repository is being restored from its copy. Nothing was changed; a follow-up in a few minutes works.";
const RESTORING = "CODE_HOST_RESTORE_IN_PROGRESS";
/** How long the change record may hold a landing's job, which holds its company's line: the report to the kernel and
 * the record's files together. A call made once the job has ended gets half of it. */
export const CODE_CHANGE_RECORD_MS = 10_000;
const SHA = /^[0-9a-f]{40}$/;

export interface CodeHostRepositoriesOptions {
	/** The change record's files (`code-change-records.ts`): what is due is written inside the landing's own job, so
	 * the record is in the company folder when the agent reads the turn's result. Absent: the record's own pass writes
	 * them. */
	records?: Pick<CodeChangeRecords, "inJob">;
	/** The log lines `code-change` and `code-change-error` (whose `error` is the error itself, for the log to redact), and
	 * `code-checks`: how each landing's checks ended (never a check's output). */
	report?: (event: Record<string, unknown>) => void;
	/** `CODE_CHANGE_RECORD_MS`, for tests. */
	recordMs?: number;
	sites?: { wake(): void };
	batchCoalesceMs?: number;
	batchMaxSize?: number;
}

const DEFAULT_BATCH_COALESCE_MS = 150;

interface LandingWaiter {
	readonly session: CodingFolderRepositorySession;
	readonly headSha: string;
	readonly signal: AbortSignal;
	readonly options: { picture?: string };
	readonly scopeKey: string;
	readonly canBatch: boolean;
	prefetchedSwitch?: CodeChecksSwitched;
	staleTries: 1 | 2;
	checkAttempts: number;
	settled: boolean;
	resolve(value: CodingLanded): void;
	reject(error: unknown): void;
	cleanup(): void;
}

interface RepoLandingQueue {
	running: boolean;
	completedOne: boolean;
	waiters: LandingWaiter[];
	wakeCoalesce?: () => void;
}

interface BatchChainStep {
	readonly waiter: LandingWaiter;
	readonly step: CodeBranchBatchPreparedStep;
}

type CodeChecksGateRun = Extract<ReturnType<typeof codeChecksGate>, { gate: "run" }>;

class BatchAbortOrAuthDropped extends Error {
	readonly survivors: LandingWaiter[];
	constructor(survivors: LandingWaiter[]) {
		super("BATCH_MEMBER_DROPPED");
		this.survivors = survivors;
	}
}

function sessionScopeKey(session: CodingFolderRepositorySession): string {
	return `${session.claim.ownerUserId}\0${session.claim.agentId}\0${session.machine.machineId}`;
}

function sameChecksSwitch(a: CodeChecksSwitched, b: CodeChecksSwitched): boolean {
	return a.checks === b.checks && a.site === b.site && (a.rootLinks === true) === (b.rootLinks === true);
}

function settleResolve(waiter: LandingWaiter, value: CodingLanded): void {
	if (waiter.settled) return;
	waiter.settled = true;
	waiter.cleanup();
	waiter.resolve(value);
}

function settleReject(waiter: LandingWaiter, error: unknown): void {
	if (waiter.settled) return;
	waiter.settled = true;
	waiter.cleanup();
	waiter.reject(error);
}

/** What the repository's checks said of a landing that moved main: its report's `checks` (step 3), and for a run that
 * passed, what became of the site it left (step 4; null when there was none to take), which a v3 report carries. */
type LandingChecks =
	| Exclude<NonNullable<CodeChangeReportV2["checks"]>, { state: "passed" }>
	| { state: "passed"; result: Record<string, unknown>; site: CodeSiteCollected | null };

/** What a landing's job left of the change record. */
interface LandingRecord {
	/** The job's landing answered: main moved, or already held the commit. */
	landed: boolean;
	filesChanged: number;
	/** The change's number, once the kernel gave one. */
	change: number | null;
	/** A report the kernel did not confirm inside the job: it is made once more after it. */
	owed: CodeChangeReport | undefined;
	/** What tells the kernel that the record's files are written, once the job has saved them. */
	confirm: (() => Promise<void>) | undefined;
}

/** The coding sessions' repositories on the folder path (F3 step 5g-6b). A session works in its own locked worktree
 * of its company's code area, `/company/code/<owner>/<name>/worktrees/<workerId>` (lower-case, `codeAreaPath`) on
 * branch `qorpera/coding/<workerId>`: the code host seeds the area from GitHub when the session's base is not in it yet
 * and adds the worktree, in one job. At publish the code host exports what the session's branch has beyond its base,
 * and the host's broker pushes that. The repository token never reaches the code host or the machine. */
export class CodeHostRepositories implements CodingFolderRepositories {
	readonly #jobs: Pick<CodeHostJobs, "run">;
	readonly #records: Pick<CodeChangeRecords, "inJob"> | undefined;
	readonly #report: (event: Record<string, unknown>) => void;
	readonly #recordMs: number;
	readonly #sites: { wake(): void } | undefined;
	readonly #batchCoalesceMs: number;
	readonly #batchMaxSize: number;
	readonly #landingQueues = new Map<string, RepoLandingQueue>();

	constructor(jobs: Pick<CodeHostJobs, "run">, options: CodeHostRepositoriesOptions = {}) {
		const recordMs = options.recordMs ?? CODE_CHANGE_RECORD_MS;
		const batchCoalesceMs = options.batchCoalesceMs ?? DEFAULT_BATCH_COALESCE_MS;
		const batchMaxSize = options.batchMaxSize ?? CODE_LAND_BATCH_MAX;
		if (
			!Number.isSafeInteger(recordMs) ||
			recordMs < 1 ||
			!Number.isSafeInteger(batchCoalesceMs) ||
			batchCoalesceMs < 0 ||
			batchCoalesceMs > 5000 ||
			!Number.isSafeInteger(batchMaxSize) ||
			batchMaxSize < 1 ||
			batchMaxSize > CODE_LAND_BATCH_MAX
		)
			throw new Error("INVALID_CODE_HOST_REPOSITORIES");
		this.#jobs = jobs;
		this.#records = options.records;
		this.#sites = options.sites;
		const report = options.report;
		this.#report = (event) => {
			try {
				report?.(event);
			} catch {
				undefined;
			}
		};
		this.#recordMs = recordMs;
		this.#batchCoalesceMs = batchCoalesceMs;
		this.#batchMaxSize = batchMaxSize;
	}

	/** A job that failed at one of its steps or was refused by rule (the code host's own error, which names its code)
	 * fails the turn at once with that code (CodingWorkspaceFailed): what the code host said stays with it, as its cause,
	 * for the executor's log. Names the code host or the company folder refuses, and a file too large, are refused the
	 * same way at every follow-up: their words say so, and what to do instead (`namesRefused`). */
	async prepare(session: CodingFolderRepositorySession, signal: AbortSignal): Promise<{ cwd: string }> {
		const { repository, workerId } = session.claim;
		try {
			await this.#job(session, signal, async (job) => {
				// A repository kept in Qorpera holds its sessions' bases (start made it): only the worktree is added.
				if (repository.host === "qorpera") {
					const added = await addCodeWorktree(job, {
						repository,
						workerId,
						baseSha: session.baseSha,
						...(session.claim.sequence > 1 ? { preferCurrentBase: true } : {}),
					});
					if (!added.headSha)
						throw new CodeHostRefusal("CODE_HOST_WORKTREE_NO_BRANCH", [
							`${codeAreaPath(repository)}/worktrees/${workerId}`,
						]);
					return;
				}
				await attachCodeSession(job, { repository, workerId, baseSha: session.baseSha }, codeAreaBroker(session));
			});
		} catch (error) {
			if (signal.aborted || !(error instanceof CodeHostJobFailure || error instanceof CodeHostRefusal)) throw error;
			throw new CodingWorkspaceFailed(
				error.code,
				error.code === RESTORING ? CODE_RESTORING : (namesRefused(session, error) ?? CODE_COPY_FAILED),
				{ cause: error },
			);
		}
		return { cwd: `${CODING_FOLDER_COMPANY_ROOT}/${codeAreaPath(repository)}/worktrees/${workerId}` };
	}

	/** The session's branch at `headSha` as a thin bundle over its base, or null when the branch is still at its base. */
	async export(session: CodingFolderRepositorySession, headSha: string, signal: AbortSignal): Promise<Buffer | null> {
		const { repository, workerId } = session.claim;
		const exported = await this.#job(session, signal, (job) =>
			exportCodeBranch(
				job,
				{ repository, workerId, baseSha: session.baseSha, headSha },
				{ maximumBytes: CODE_HOST_EXPORT_MAXIMUM_BYTES },
			),
		);
		// The push sends exactly the submitted commit, and objects only when there is something beyond the base.
		if (exported.headSha !== headSha || (exported.bundle === null) !== (headSha === session.baseSha))
			throw new Error("CODE_HOST_EXPORT_DIFFERS");
		return exported.bundle;
	}

	/** A repository kept in Qorpera, made empty when it is not there yet, and its default branch's commit. A code host
	 * refusal or failure fails the turn with its code, as a prepare's does. */
	async start(session: CodingFolderStart, signal: AbortSignal): Promise<{ baseSha: string }> {
		const { repository, surfaceSession } = session.claim;
		if (repository.host !== "qorpera") throw new Error("CODE_HOST_REPOSITORY_NOT_HERE");
		try {
			const started = await this.#job(session, signal, async (job) => {
				if (surfaceSession) {
					const surface = await ensureSurfaceStarterRepository(job, {
						repository,
						title: surfaceSession.title,
						slug: surfaceSession.slug,
					});
					return { baseSha: surface.mainSha };
				}
				return await startCodeArea(job, { repository });
			});
			return { baseSha: started.baseSha };
		} catch (error) {
			if (signal.aborted || !(error instanceof CodeHostJobFailure || error instanceof CodeHostRefusal)) throw error;
			const startSummary =
				error.code === "CODE_HOST_AREA_FROM_GITHUB"
					? CODE_AREA_TAKEN
					: error.code === RESTORING
						? CODE_RESTORING
						: (namesRefused(session, error) ?? formatStartFailure(error));
			throw new CodingWorkspaceFailed(error.code, startSummary, { cause: error });
		}
	}

	async readSetup(session: CodingFolderStart, baseSha: string, signal: AbortSignal): Promise<ParsedCodingSetup> {
		if (!SHA.test(baseSha)) {
			return {
				file: null,
				refused: false,
				setupDigest: EMPTY_CODING_SETUP_DIGEST,
				setupSpec: EMPTY_CODING_SETUP,
				dockerfiles: [],
				problems: [],
			};
		}
		const { repository } = session.claim;
		return this.#job(session, signal, (job) =>
			withJob(job, repository, async (run) => {
				if ((await run.types([run.repo]))[0] !== "directory") {
					return {
						file: null,
						refused: false,
						setupDigest: EMPTY_CODING_SETUP_DIGEST,
						setupSpec: EMPTY_CODING_SETUP,
						dockerfiles: [],
						problems: [],
					};
				}
				const verified = await run.git(run.repo, ["rev-parse", "--verify", "--quiet", `${baseSha}^{commit}`]);
				if (verified.status !== 0) {
					return {
						file: null,
						refused: false,
						setupDigest: EMPTY_CODING_SETUP_DIGEST,
						setupSpec: EMPTY_CODING_SETUP,
						dockerfiles: [],
						problems: [],
					};
				}
				const source: CodingSetupSource = {
					read: async (path, maxBytes) => readCommitSetupFile(run, baseSha, path, maxBytes),
				};
				return parseCodingSetup(source);
			}),
		);
	}

	async archiveCommit(
		session: CodingFolderStart,
		commitSha: string,
		signal: AbortSignal,
		options?: { maximumBytes?: number },
	): Promise<Buffer> {
		if (!SHA.test(commitSha)) throw new CodeHostJobFailure("CODE_HOST_COMMIT_INVALID");
		const { repository } = session.claim;
		const maximumBytes = options?.maximumBytes ?? CODE_HOST_EXPORT_MAXIMUM_BYTES;
		return this.#job(session, signal, (job) =>
			withJob(job, repository, async (run) => {
				const result = await run.git(run.repo, ["archive", "--format=tar", commitSha], {
					maximumOutputBytes: maximumBytes,
				});
				if (result.status !== 0) throw new CodeHostJobFailure("CODE_HOST_ARCHIVE_FAILED", tail(result.stderr));
				return result.stdout;
			}),
		);
	}

	async verifyStaged(
		session: CodingFolderRepositorySession,
		headSha: string,
		signal: AbortSignal,
	): Promise<CodingStaged> {
		const { repository, workerId } = session.claim;
		if (repository.host !== "qorpera") throw new Error("CODE_HOST_REPOSITORY_NOT_HERE");
		let verified: Awaited<ReturnType<typeof verifyStagedSurfaceBranch>>;
		try {
			verified = await this.#job(session, signal, (job) =>
				verifyStagedSurfaceBranch(job, {
					repository,
					workerId,
					baseSha: session.baseSha,
					headSha,
				}),
			);
		} catch (error) {
			if (signal.aborted) throw error;
			if (error instanceof CodeHostRefusal) {
				const summary = landRefusal(repository.baseBranch, error.code, error.paths, { staged: true });
				if (summary) throw new CodingLandRefused(error.code, summary, { cause: error });
			} else if (error instanceof CodeHostJobFailure && error.code === "CODE_HOST_REF_UNREADABLE") {
				const summary = landRefusal(repository.baseBranch, error.code, [], { staged: true });
				if (summary) throw new CodingLandRefused(error.code, summary, { cause: error });
			}
			throw error;
		}
		if (
			verified.changed &&
			verified.checksFile &&
			verified.baseChecksFile &&
			session.checksSwitch &&
			session.runChecks
		) {
			const gate = surfaceStageChecksGate(
				readCodeChecks(verified.baseChecksFile),
				readCodeChecks(verified.checksFile),
				verified.checksFile,
			);
			if (gate.gate !== "skip") {
				const switched = await session.checksSwitch(signal);
				if (switched.checks) {
					const told = (step: string, extra: Record<string, unknown> = {}) =>
						this.#report({ event: "code-checks", step, staged: true, ...named(session), ...extra });
					// WHY: checksSwitch consumes any one-shot operator drill; staging logs it with staged: true and runs "check" drills ("site" drills collect no site here).
					const drill = switched.drill;
					if (drill !== undefined) told("drill", { drill });
					if (gate.gate === "refused") {
						told("refused");
						throw new CodingLandRefused("CODING_CHECKS_REFUSED", gate.summary);
					}
					const checks = drill === "check" ? [...gate.checks, CODE_CHECKS_DRILL] : gate.checks;
					const input = { commit: verified.headSha, checks, site: null };
					let run = await session.runChecks({ ...input, attempt: 1 }, signal);
					if (run.state === "not_run") {
						told("not-run", { why: run.why, code: run.code, attempt: 1 });
						run = await session.runChecks({ ...input, attempt: 2 }, signal);
					}
					if (run.state === "not_run") {
						told("not-run", { why: run.why, code: run.code, attempt: 2 });
						throw new CodingLandRefused(
							"CODING_CHECKS_DID_NOT_RUN",
							codeChecksNotRunSummary(run, { staged: true }),
						);
					}
					if (run.state === "failed") {
						const drilled =
							drill === "check" && run.notRun.length === 0 && run.failed.name === CODE_CHECKS_DRILL.name;
						told("failed", {
							exitCode: run.failed.exitCode,
							atLimit: run.failed.atLimit,
							...(drilled ? { drill } : {}),
						});
						throw new CodingLandRefused(
							"CODING_CHECKS_FAILED",
							codeChecksFailedSummary(run, "fast-forward", drilled ? `${CODE_DRILL_WORDS} ` : "", {
								staged: true,
							}),
						);
					}
					if (run.state === "site_refused") throw new Error("CODE_HOST_LANDING_INVALID");
					told("passed", { ms: run.ms });
				}
			}
		}
		return {
			branch: verified.branch,
			baseSha: verified.baseSha,
			headSha: verified.headSha,
			changed: verified.changed,
			filesChanged: verified.filesChanged,
		};
	}

	/** The session's submitted commit landed on the default branch of its repository kept in Qorpera. A landing that
	 * lost the default branch to another one (the move's compare-and-swap, `CODE_HOST_BASE_MOVED`) wrote nothing and is
	 * made once more, from the branch as it stands then. A refusal by rule, and refs that could not be read, say what to
	 * do (CodingLandConflict, CodingLandRefused), since the same work would be refused again.
	 *
	 * The landing is reported to the repository's change record (own code storage, step 2b) inside its own job, while
	 * the company's line is held, so the record's rows are in the order main moved; then the record's files that are
	 * due are written, and the job's one save carries them with main/. A report the kernel did not confirm there is made
	 * once more after the job, and then left: the kernel finds a main its record does not know at the next movement. A
	 * conflict and a refusal are reported before they are thrown on. Nothing of the record fails a landing or holds its
	 * job longer than `CODE_CHANGE_RECORD_MS`: every error of it is reported (`code-change-error`) and nothing more.
	 *
	 * The repository's checks gate the landing (own code storage, step 3): main only moves to a candidate whose every
	 * check passed. Job A finds the candidate and reads the checks file at it and at main, moving nothing; the checks
	 * run in the session's machine, outside the company's line; job B moves main only to that candidate, and only while
	 * main is still where job A saw it. When main moved meanwhile (`CODE_HOST_LAND_STALE`), job A is made again and the
	 * new candidate checked once more. Checks that could not run are run once more. A refused checks file, a failed
	 * check, checks that could not run twice and main moving twice each fail the turn with their words
	 * (CodingLandRefused) and make no row of the change record: the session's commit was not ready, and met no main. A
	 * repository with no checks file lands in job A as before, its row saying `none`; one whose checks are switched off,
	 * or a host that runs none, too, saying `off`.
	 *
	 * The candidate's checks file may say where its checks leave the repository's website (step 4): the run then takes it
	 * once every check passed, unless the switch says sites are off. A site the code made wrong fails the turn as a failed
	 * check does (`CODING_CHECKS_SITE_REFUSED`, no row). A run that passed is reported as v3, with what became of its
	 * site; after a landing whose report says the site was made, the upload pass is woken (`sites`).
	 *
	 * From step 5 the switch may say that sites have hosts of their own (`rootLinks`): the run then lets a site's links
	 * from `/` through. And it may hand over an operator's drill, once: a `check` drill runs one more check after the
	 * repository's own (`CODE_CHECKS_DRILL`), which fails; a `site` drill takes no site, and once every check passed the
	 * host itself refuses the site as not there, naming `CODE_SITE_DRILL_FOLDER`, whatever the repository holds (the
	 * review of #1774, F3: a repository may hold a folder of that name). Either way the turn fails on the platform's own
	 * refusal path, with its usual code, and its words start with `CODE_DRILL_WORDS`. */
	async land(
		session: CodingFolderRepositorySession,
		headSha: string,
		signal: AbortSignal,
		options: { picture?: string } = {},
	): Promise<CodingLanded> {
		const { profileId, environmentId, repository } = session.claim;
		if (repository.host !== "qorpera") throw new Error("CODE_HOST_REPOSITORY_NOT_HERE");
		if (signal.aborted) throw signal.reason;
		const key = `${profileId}:${environmentId}:${repository.owner.toLowerCase()}/${repository.name.toLowerCase()}:${repository.baseBranch}`;
		let queue = this.#landingQueues.get(key);
		if (!queue) {
			queue = { running: false, completedOne: false, waiters: [] };
			this.#landingQueues.set(key, queue);
		}
		const activeQueue = queue;
		return await new Promise<CodingLanded>((resolve, reject) => {
			const onAbort = () => {
				if (waiter.settled) return;
				const index = activeQueue.waiters.indexOf(waiter);
				if (index >= 0) {
					activeQueue.waiters.splice(index, 1);
					settleReject(waiter, signal.reason);
					if (activeQueue.waiters.length === 0) activeQueue.wakeCoalesce?.();
				}
			};
			const waiter: LandingWaiter = {
				session,
				headSha,
				signal,
				options,
				scopeKey: sessionScopeKey(session),
				canBatch: session.checksSwitch !== undefined && session.runChecks !== undefined,
				staleTries: 1,
				checkAttempts: 0,
				settled: false,
				resolve,
				reject,
				cleanup: () => signal.removeEventListener("abort", onAbort),
			};
			signal.addEventListener("abort", onAbort, { once: true });
			activeQueue.waiters.push(waiter);
			if (activeQueue.waiters.length >= this.#batchMaxSize) activeQueue.wakeCoalesce?.();
			if (!activeQueue.running) {
				activeQueue.running = true;
				void this.#drainLandingQueue(key, activeQueue);
			}
		});
	}

	async #drainLandingQueue(key: string, queue: RepoLandingQueue): Promise<void> {
		try {
			await Promise.resolve();
			while (queue.waiters.length > 0) {
				if (queue.completedOne && this.#batchCoalesceMs > 0 && queue.waiters.length < this.#batchMaxSize) {
					await this.#waitCoalesce(queue);
				}
				const picked = await this.#takeNextTurn(queue);
				if (!picked) continue;
				if (picked.mode === "solo") {
					await this.#runSoloWaiter(picked.waiter);
				} else {
					await this.#runBatchWaiters(queue, picked.waiters, picked.switched);
				}
				queue.completedOne = true;
			}
		} finally {
			queue.running = false;
			if (queue.waiters.length === 0) {
				if (this.#landingQueues.get(key) === queue) this.#landingQueues.delete(key);
			} else {
				queue.running = true;
				void this.#drainLandingQueue(key, queue);
			}
		}
	}

	#waitCoalesce(queue: RepoLandingQueue): Promise<void> {
		return new Promise<void>((resolve) => {
			if (queue.waiters.length === 0 || queue.waiters.length >= this.#batchMaxSize) {
				resolve();
				return;
			}
			const done = () => {
				clearTimeout(timer);
				if (queue.wakeCoalesce === done) queue.wakeCoalesce = undefined;
				resolve();
			};
			const timer = setTimeout(done, this.#batchCoalesceMs);
			queue.wakeCoalesce = done;
		});
	}

	async #takeNextTurn(
		queue: RepoLandingQueue,
	): Promise<
		| { mode: "solo"; waiter: LandingWaiter }
		| { mode: "batch"; waiters: LandingWaiter[]; switched: CodeChecksSwitched }
		| null
	> {
		while (queue.waiters.length > 0) {
			const first = queue.waiters.shift() as LandingWaiter;
			if (first.settled) continue;
			if (first.signal.aborted) {
				settleReject(first, first.signal.reason);
				continue;
			}
			if (!first.canBatch || this.#batchMaxSize <= 1) return { mode: "solo", waiter: first };
			if (!first.prefetchedSwitch) {
				try {
					first.prefetchedSwitch = await (
						first.session.checksSwitch as NonNullable<CodingFolderRepositorySession["checksSwitch"]>
					)(first.signal);
				} catch (error) {
					settleReject(first, error);
					continue;
				}
				if (first.signal.aborted) {
					settleReject(first, first.signal.reason);
					continue;
				}
			}
			const firstSwitch = first.prefetchedSwitch;
			if (!firstSwitch.checks || firstSwitch.drill !== undefined) return { mode: "solo", waiter: first };
			const batch: LandingWaiter[] = [first];
			const workers = new Set<string>([first.session.claim.workerId]);
			const remaining: LandingWaiter[] = [];
			const queued = queue.waiters.splice(0, queue.waiters.length);
			for (const candidate of queued) {
				if (candidate.settled) continue;
				if (candidate.signal.aborted) {
					settleReject(candidate, candidate.signal.reason);
					continue;
				}
				if (
					batch.length >= this.#batchMaxSize ||
					!candidate.canBatch ||
					candidate.scopeKey !== first.scopeKey ||
					workers.has(candidate.session.claim.workerId)
				) {
					remaining.push(candidate);
					continue;
				}
				if (!candidate.prefetchedSwitch) {
					try {
						candidate.prefetchedSwitch = await (
							candidate.session.checksSwitch as NonNullable<CodingFolderRepositorySession["checksSwitch"]>
						)(candidate.signal);
					} catch (error) {
						settleReject(candidate, error);
						continue;
					}
					if (candidate.signal.aborted) {
						settleReject(candidate, candidate.signal.reason);
						continue;
					}
				}
				const candidateSwitch = candidate.prefetchedSwitch;
				if (candidateSwitch.drill !== undefined || !sameChecksSwitch(firstSwitch, candidateSwitch)) {
					remaining.push(candidate);
					continue;
				}
				batch.push(candidate);
				workers.add(candidate.session.claim.workerId);
			}
			if (remaining.length > 0) queue.waiters.unshift(...remaining);
			if (batch.length === 1) return { mode: "solo", waiter: first };
			return { mode: "batch", waiters: batch, switched: firstSwitch };
		}
		return null;
	}

	async #runSoloWaiter(waiter: LandingWaiter): Promise<void> {
		if (waiter.settled) return;
		if (waiter.signal.aborted) {
			settleReject(waiter, waiter.signal.reason);
			return;
		}
		try {
			const landed = await this.#landSerialized(
				waiter.session,
				waiter.headSha,
				waiter.signal,
				waiter.options,
				waiter.prefetchedSwitch,
				waiter.staleTries,
				waiter.checkAttempts,
			);
			settleResolve(waiter, landed);
		} catch (error) {
			settleReject(waiter, error);
		}
	}

	async #landSerialized(
		session: CodingFolderRepositorySession,
		headSha: string,
		signal: AbortSignal,
		options: { picture?: string },
		prefetchedSwitch?: CodeChecksSwitched,
		initialTries: 1 | 2 = 1,
		initialRuns = 0,
	): Promise<CodingLanded> {
		const { checksSwitch, runChecks } = session;
		const switched: CodeChecksSwitched =
			prefetchedSwitch !== undefined
				? prefetchedSwitch
				: checksSwitch !== undefined && runChecks !== undefined
					? await checksSwitch(signal)
					: { checks: false, site: false };
		const enabled = switched.checks;
		const told = (step: string, extra: Record<string, unknown> = {}) =>
			this.#report({ event: "code-checks", step, ...named(session), ...extra });
		const drill = switched.drill;
		if (drill !== undefined) told("drill", { drill });
		let runs = initialRuns;
		for (let tries: 1 | 2 = initialTries; ; tries = 2) {
			const found = await this.#landing(
				session,
				headSha,
				signal,
				options,
				enabled ? { checks: true } : {},
				enabled ? { state: "none" } : { state: "off" },
			);
			if (found.state !== "to-check") return found;
			// Only a job that was asked to read the checks answers a candidate to check.
			if (!enabled || !runChecks) throw new Error("CODE_HOST_LANDING_INVALID");
			const gate = codeChecksGate(readCodeChecks(found.mainChecks), readCodeChecks(found.checks));
			if (gate.gate === "refused") {
				told("refused", { tries });
				throw new CodingLandRefused("CODING_CHECKS_REFUSED", gate.summary);
			}
			// The candidate's site is taken only while the switch says sites are on. A site drill takes none: the host refuses
			// the site itself once every check passed (below), so nothing the repository holds decides it; a check drill runs
			// one more check after the repository's own, which says it is a drill and fails (step 5, D17). Links from / are
			// let through only while the switch says sites have hosts of their own (step 5, D15); else the input is as before.
			const recipe = switched.site ? gate.site : null;
			const siteDrill = recipe !== null && drill === "site";
			const site = siteDrill ? null : recipe;
			const checks = drill === "check" ? [...gate.checks, CODE_CHECKS_DRILL] : gate.checks;
			const input = {
				commit: found.mainAfter,
				checks,
				site,
				...(switched.rootLinks === true ? { rootLinks: true } : {}),
			};
			let run = await runChecks({ ...input, attempt: ++runs }, signal);
			// Checks that could not run are the machine's or Qorpera's fault, never the code's: once more.
			if (run.state === "not_run") {
				told("not-run", { why: run.why, code: run.code, attempt: runs });
				run = await runChecks({ ...input, attempt: ++runs }, signal);
			}
			if (run.state === "not_run") {
				told("not-run", { why: run.why, code: run.code, attempt: runs });
				throw new CodingLandRefused("CODING_CHECKS_DID_NOT_RUN", codeChecksNotRunSummary(run));
			}
			if (run.state === "failed") {
				// The drill's own check failed, the last of the run: its words say first that it was a drill.
				const drilled = drill === "check" && run.notRun.length === 0 && run.failed.name === CODE_CHECKS_DRILL.name;
				told("failed", {
					attempt: runs,
					exitCode: run.failed.exitCode,
					atLimit: run.failed.atLimit,
					...(drilled ? { drill } : {}),
				});
				throw new CodingLandRefused(
					"CODING_CHECKS_FAILED",
					drilled
						? codeChecksFailedSummary(run, found.how, `${CODE_DRILL_WORDS} `)
						: codeChecksFailedSummary(run, found.how),
				);
			}
			// Every check passed, but the site the code left cannot go: nothing goes in, as for a failed check.
			if (run.state === "site_refused") {
				if (site === null) throw new Error("CODE_HOST_LANDING_INVALID");
				told("site-refused", { attempt: runs, problem: run.problem.code, variable: run.problem.variable });
				throw new CodingLandRefused("CODING_CHECKS_SITE_REFUSED", codeSiteRefusedSummary(run.problem, site.folder));
			}
			// A site drill: every check passed, and the host refuses the site as not there, on the same path and in the same
			// words as a site the code did not leave, its words first saying it was a drill. Nothing goes in.
			if (siteDrill) {
				const problem = { code: "SITE_FOLDER_MISSING", path: null, variable: null } as const;
				told("site-refused", { attempt: runs, problem: problem.code, variable: problem.variable, drill });
				throw new CodingLandRefused(
					"CODING_CHECKS_SITE_REFUSED",
					codeSiteRefusedSummary(problem, CODE_SITE_DRILL_FOLDER, `${CODE_DRILL_WORDS} `),
				);
			}
			const result = codeChecksPassed({
				commit: found.mainAfter,
				how: found.how,
				blob: gate.blob,
				run,
				changed: gate.changed,
				tries,
			});
			try {
				const landed = await this.#landing(
					session,
					headSha,
					signal,
					options,
					{ expect: { how: found.how, mainBefore: found.mainBefore, mainAfter: found.mainAfter } },
					{ state: "passed", result, site: run.site },
				);
				if (landed.state === "to-check") throw new Error("CODE_HOST_LANDING_INVALID");
				const made = landed.state !== "unchanged" && run.site?.state === "made";
				told("landed", {
					checks: landed.state === "unchanged" ? null : "passed",
					attempt: runs,
					tries,
					site: landed.state === "unchanged" ? null : (run.site?.state ?? null),
				});
				// Its report says the site was made: the upload need not wait for its pass's next turn. A wake that throws
				// is the pass's own, and changes nothing of the landing.
				if (made)
					try {
						this.#sites?.wake();
					} catch (error) {
						this.#failed(session, "wake", error);
					}
				return landed;
			} catch (error) {
				if (signal.aborted || !(error instanceof CodeHostJobFailure && error.code === "CODE_HOST_LAND_STALE"))
					throw error;
				told("stale", { attempt: runs, tries });
				// Main moved twice while its checks ran: they never ran on what would go in.
				if (tries === 2)
					throw new CodingLandRefused("CODING_CHECKS_MAIN_MOVED", CODE_CHECKS_MAIN_MOVED, { cause: error });
			}
		}
	}

	/** One landing's job, made once more when it lost main to another one (`CODE_HOST_BASE_MOVED`): job A of a
	 * repository's checks (`checks`), or job B (`expect`), or the one landing of a repository without them. A job that
	 * moved main is reported to the change record with `checks`; a candidate to check moves nothing and reports nothing. A
	 * conflict and a refusal are reported and thrown on with their words. */
	async #landing(
		session: CodingFolderRepositorySession,
		headSha: string,
		signal: AbortSignal,
		options: { picture?: string },
		step: { checks?: true; expect?: { how: "fast-forward" | "merged"; mainBefore: string; mainAfter: string } },
		checks: LandingChecks,
	): Promise<CodingLanded | CodeBranchToCheck> {
		const { repository, workerId } = session.claim;
		for (let again = true; ; again = false) {
			const record: LandingRecord = {
				landed: false,
				filesChanged: 0,
				change: null,
				owed: undefined,
				confirm: undefined,
			};
			try {
				const landed = await this.#job(session, signal, async (job) => {
					const landed = await landCodeBranch(job, {
						repository,
						workerId,
						headSha,
						...(options.picture === undefined ? {} : { picture: options.picture }),
						...step,
					});
					// A candidate to check: nothing moved, and nothing is reported.
					if (landed.state === "to-check") return landed;
					// Main has moved, and a ref is saved where git commits it: from here on nothing may fail the job.
					record.landed = true;
					await this.#recordInJob(session, job, landed, headSha, record, checks);
					return landed;
				});
				if (landed.state === "to-check") return landed;
				// The job saved: a report it could not make is made now, and the kernel is told of the files it wrote.
				await this.#reportOwed(session, record);
				const confirm = record.confirm;
				if (confirm)
					try {
						await withTimeoutScope(undefined, Math.ceil(this.#recordMs / 2), (confirmSignal) =>
							answeredBefore(confirm, confirmSignal),
						);
					} catch (error) {
						this.#failed(session, "written", error);
					}
				return {
					state: landed.state,
					mainSha: landed.mainSha,
					filesChanged: record.filesChanged,
					change: record.change,
				};
			} catch (error) {
				if (signal.aborted) throw error;
				if (again && error instanceof CodeHostJobFailure && error.code === "CODE_HOST_BASE_MOVED") continue;
				// A job that failed after its landing saved the ref all the same: the report is still owed. Its files were
				// not saved, so nothing of them is confirmed.
				if (record.landed) {
					await this.#reportOwed(session, record);
					throw error;
				}
				if (error instanceof CodeHostRefusal && error.code === "CODE_HOST_LAND_CONFLICT") {
					await this.#reportRefused(session, headSha, "conflict", error.code, error.paths);
					throw new CodingLandConflict(error.paths);
				}
				// A refusal by rule, and refs git could not read (a failed command, `Run.ref`): both have their own words.
				let code: string | undefined;
				let paths: readonly string[] = [];
				if (error instanceof CodeHostRefusal) {
					code = error.code;
					paths = error.paths;
				} else if (error instanceof CodeHostJobFailure && error.code === "CODE_HOST_REF_UNREADABLE")
					code = error.code;
				// The names the company folder refuses are named as the import's look shows a path (`codeImportShown`): one
				// over 200 bytes, key-like or with a control character is only counted.
				const summary =
					code === undefined
						? undefined
						: landRefusal(
								repository.baseBranch,
								code,
								code === "CODE_HOST_NAMES_FOLDER_REFUSES" ? paths.map((path) => codeImportShown(path)) : paths,
							);
				if (code === undefined || summary === undefined) throw error;
				await this.#reportRefused(session, headSha, "refused", code, paths);
				throw new CodingLandRefused(code, summary, { cause: error });
			}
		}
	}

	/** Inside the landing's job, after the landing: the report to the kernel, then the record's files that are due,
	 * under one deadline for both. It never throws. */
	async #recordInJob(
		session: CodingFolderRepositorySession,
		job: CodeHostJob,
		landed: CodeBranchLanded,
		headSha: string,
		record: LandingRecord,
		checks: LandingChecks,
	): Promise<void> {
		let report: CodeChangeReport;
		try {
			const diff = landed.state === "unchanged" ? undefined : codeChangeDiffOf(landed.diff);
			record.filesChanged = diff?.filesChanged ?? 0;
			if (!session.recordChange) return;
			report = landingReport(landed, headSha, diff, checks);
		} catch (error) {
			this.#failed(session, "report", error);
			return;
		}
		// One deadline for the report and the files: the company's line is held meanwhile.
		await withTimeoutScope(job.signal, this.#recordMs, async (bounded) => {
			try {
				record.change = await this.#reported(session, report, bounded);
			} catch (error) {
				// The kernel may have the row all the same: the same report again answers it.
				record.owed = report;
				this.#failed(session, "report", error);
				return;
			}
			if (record.change !== null && checks.state === "passed" && checks.site?.state === "made") {
				await pinCodeSiteTree(
					{
						shell: job.shell,
						layout: job.layout,
						signal: bounded,
						preparedKeptArea: codeAreaPath(session.claim.repository),
					},
					{ repository: session.claim.repository, change: record.change, tree: checks.site.tree },
				).catch(() => undefined);
			}
			const records = this.#records;
			if (!records) return;
			try {
				record.confirm = await answeredBefore(
					() =>
						records.inJob(
							{
								shell: job.shell,
								layout: job.layout,
								signal: bounded,
								preparedKeptArea: codeAreaPath(session.claim.repository),
							},
							targetOf(session),
							bounded,
						),
					bounded,
				);
			} catch (error) {
				this.#failed(session, "files", error);
			}
		});
	}

	/** A report the job could not make, made once more now that the job has ended: not in line any more. It never
	 * throws; a second failure is left to the kernel, which finds the movement at the next one it records. */
	async #reportOwed(session: CodingFolderRepositorySession, record: LandingRecord): Promise<void> {
		const owed = record.owed;
		if (!owed) return;
		record.owed = undefined;
		try {
			record.change = await withTimeoutScope(undefined, Math.ceil(this.#recordMs / 2), (reportSignal) =>
				this.#reported(session, { ...owed, inLine: false }, reportSignal),
			);
		} catch (error) {
			this.#failed(session, "report-again", error);
		}
	}

	/** A landing that never went in, reported before it is thrown on. It never throws. */
	async #reportRefused(
		session: CodingFolderRepositorySession,
		headSha: string,
		state: "conflict" | "refused",
		code: string,
		paths: readonly string[],
	): Promise<void> {
		if (!session.recordChange) return;
		try {
			await withTimeoutScope(undefined, Math.ceil(this.#recordMs / 2), (reportSignal) =>
				this.#reported(
					session,
					{
						schema: "qorpera.code-change-report/v2",
						state,
						inLine: false,
						how: null,
						headSha,
						mainBefore: null,
						mainAfter: null,
						filesChanged: null,
						paths: null,
						pathsMore: 0,
						picture: null,
						refusal: { code, paths: codeChangeRefusalPaths(paths) },
						checks: null,
					},
					reportSignal,
				),
			);
		} catch (error) {
			this.#failed(session, "report", error);
		}
	}

	/** One report to the kernel, answered within `signal` or not at all, and the change's number when it gave one. */
	async #reported(
		session: CodingFolderRepositorySession,
		report: CodeChangeReport,
		signal: AbortSignal,
	): Promise<number | null> {
		const answer = await answeredBefore(async () => {
			if (!session.recordChange) throw new Error("CODE_CHANGE_RECORD_UNAVAILABLE");
			return await session.recordChange(report, signal);
		}, signal);
		const change = answer?.change;
		if (typeof answer?.state !== "string" || !(change === null || (Number.isSafeInteger(change) && change >= 1)))
			throw new Error("CODE_CHANGE_RECORD_UNCONFIRMED");
		this.#report({
			event: "code-change",
			step: "reported",
			...named(session),
			reported: report.state,
			inLine: report.inLine,
			state: answer.state,
			change,
		});
		return change;
	}

	#failed(session: CodingFolderRepositorySession, step: string, error: unknown): void {
		this.#report({ event: "code-change-error", step, ...named(session), error });
	}

	async #runBatchWaiters(
		queue: RepoLandingQueue,
		initialWaiters: LandingWaiter[],
		switched: CodeChecksSwitched,
	): Promise<void> {
		const live = this.#filterLiveWaiters(initialWaiters);
		if (live.length === 0) return;
		if (live.length === 1) {
			await this.#runSoloWaiter(live[0] as LandingWaiter);
			return;
		}
		const repository = (live[0] as LandingWaiter).session.claim.repository;
		const batchWaiters = [...live];
		try {
			let authorized: LandingWaiter[] = [];
			const prepared = await this.#withBatchSignal(batchWaiters, async (batchSignal) => {
				return await this.#jobs.run(
					(batchWaiters[0] as LandingWaiter).session.claim.profileId,
					(batchWaiters[0] as LandingWaiter).session.claim.environmentId,
					batchSignal,
					async (job) => {
						authorized = await this.#authorizeBatchMembers(batchWaiters);
						if (authorized.length === 0) return null;
						const result = await landCodeBranchBatch(job, {
							repository,
							candidates: authorized.map((waiter) => ({
								workerId: waiter.session.claim.workerId,
								headSha: waiter.headSha,
							})),
						});
						const unchangedRecords: { waiter: LandingWaiter; mainSha: string; record: LandingRecord }[] = [];
						for (const item of result.unchanged) {
							const waiter = authorized[item.index] as LandingWaiter;
							if (waiter.settled || waiter.signal.aborted) {
								settleReject(waiter, waiter.signal.reason);
								continue;
							}
							const record: LandingRecord = {
								landed: true,
								filesChanged: 0,
								change: null,
								owed: undefined,
								confirm: undefined,
							};
							await this.#recordInJob(
								waiter.session,
								job,
								{
									state: "unchanged",
									mainSha: item.mainSha,
									mainBefore: item.mainSha,
									containedAt: item.containedAt,
									diff: { filesChanged: 0, paths: [], pathsMore: 0 },
									picture: null,
									restored: result.restored,
								},
								waiter.headSha,
								record,
								{ state: "none" },
							);
							unchangedRecords.push({ waiter, mainSha: item.mainSha, record });
						}
						return { result, unchangedRecords };
					},
				);
			});
			if (!prepared) return;
			const { result, unchangedRecords } = prepared;
			for (const entry of unchangedRecords) {
				await this.#reportOwed(entry.waiter.session, entry.record);
				if (entry.record.confirm) {
					const confirm = entry.record.confirm;
					try {
						await withTimeoutScope(undefined, Math.ceil(this.#recordMs / 2), (confirmSignal) =>
							answeredBefore(confirm, confirmSignal),
						);
					} catch (error) {
						this.#failed(entry.waiter.session, "written", error);
					}
				}
				settleResolve(entry.waiter, {
					state: "unchanged",
					mainSha: entry.mainSha,
					filesChanged: 0,
					change: entry.record.change,
				});
			}
			for (const rejected of result.rejected) {
				const waiter = authorized[rejected.index] as LandingWaiter;
				await this.#rejectRefusal(waiter, rejected.error);
			}
			const deferredWaiters = this.#filterLiveWaiters(
				result.deferred.map((index) => authorized[index] as LandingWaiter),
			);
			const chain: BatchChainStep[] = result.accepted
				.map((step) => ({ waiter: authorized[step.index] as LandingWaiter, step }))
				.filter(({ waiter }) => {
					if (waiter.settled) return false;
					if (waiter.signal.aborted) {
						settleReject(waiter, waiter.signal.reason);
						return false;
					}
					return true;
				});
			if (chain.length !== result.accepted.length) {
				const survivors = [...chain.map((entry) => entry.waiter), ...deferredWaiters];
				if (survivors.length > 0) queue.waiters.unshift(...survivors);
				return;
			}
			if (chain.length === 0) {
				if (deferredWaiters.length > 0) queue.waiters.unshift(...deferredWaiters);
				return;
			}
			const hasChecks = result.mainChecks.entry.kind !== "missing" || result.tipChecks.entry.kind !== "missing";
			if (!hasChecks) {
				const committed = await this.#commitBatch(chain, null, null);
				const requeue = [...committed.requeue, ...deferredWaiters];
				if (requeue.length > 0) queue.waiters.unshift(...requeue);
				return;
			}
			const gate = codeChecksGate(readCodeChecks(result.mainChecks), readCodeChecks(result.tipChecks));
			if (gate.gate === "refused") {
				for (const { waiter } of chain) {
					this.#report({
						event: "code-checks",
						step: "refused",
						...named(waiter.session),
						tries: waiter.staleTries,
					});
					settleReject(waiter, new CodingLandRefused("CODING_CHECKS_REFUSED", gate.summary));
				}
				if (deferredWaiters.length > 0) queue.waiters.unshift(...deferredWaiters);
				return;
			}
			const outcome = await this.#checkAndLandChain(chain, gate, switched, undefined);
			const requeue = [...outcome.requeue, ...deferredWaiters];
			if (requeue.length > 0) queue.waiters.unshift(...requeue);
		} catch (error) {
			for (const waiter of batchWaiters) {
				if (!waiter.settled) await this.#rejectJobError(waiter, error);
			}
		}
	}

	async #checkAndLandChain(
		chain: readonly BatchChainStep[],
		gate: CodeChecksGateRun,
		switched: CodeChecksSwitched,
		knownTipFailure: Extract<CodeChecksRun, { state: "failed" | "site_refused" }> | undefined,
	): Promise<{ allLanded: boolean; requeue: LandingWaiter[] }> {
		const live = this.#filterLiveChain(chain);
		if (live.length !== chain.length) {
			return { allLanded: false, requeue: live.map((entry) => entry.waiter) };
		}
		const tip = chain[chain.length - 1] as BatchChainStep;
		const site: CodeSiteRecipe | null = switched.site ? gate.site : null;
		let failure: Extract<CodeChecksRun, { state: "failed" | "site_refused" }> | undefined = knownTipFailure;
		if (failure === undefined) {
			const runChecks = tip.waiter.session.runChecks;
			if (!runChecks) throw new Error("CODE_HOST_LANDING_INVALID");
			const input = {
				commit: tip.step.mainAfter,
				checks: gate.checks,
				site,
				...(switched.rootLinks === true ? { rootLinks: true } : {}),
			};
			let run: CodeChecksRun;
			try {
				tip.waiter.checkAttempts += 1;
				run = await runChecks({ ...input, attempt: tip.waiter.checkAttempts }, tip.waiter.signal);
				if (run.state === "not_run") {
					this.#report({
						event: "code-checks",
						step: "not-run",
						...named(tip.waiter.session),
						why: run.why,
						code: run.code,
						attempt: tip.waiter.checkAttempts,
					});
					tip.waiter.checkAttempts += 1;
					run = await runChecks({ ...input, attempt: tip.waiter.checkAttempts }, tip.waiter.signal);
				}
			} catch (error) {
				settleReject(tip.waiter, error);
				const others = this.#filterLiveWaiters(chain.slice(0, -1).map((entry) => entry.waiter));
				return { allLanded: false, requeue: others };
			}
			const afterCheckLive = this.#filterLiveChain(chain);
			if (afterCheckLive.length !== chain.length) {
				return { allLanded: false, requeue: afterCheckLive.map((entry) => entry.waiter) };
			}
			if (run.state === "not_run") {
				this.#report({
					event: "code-checks",
					step: "not-run",
					...named(tip.waiter.session),
					why: run.why,
					code: run.code,
					attempt: tip.waiter.checkAttempts,
				});
				settleReject(tip.waiter, new CodingLandRefused("CODING_CHECKS_DID_NOT_RUN", codeChecksNotRunSummary(run)));
				const others = this.#filterLiveWaiters(chain.slice(0, -1).map((entry) => entry.waiter));
				return { allLanded: false, requeue: others };
			}
			if (run.state === "passed") {
				const committed = await this.#commitBatch(chain, gate, run);
				return { allLanded: committed.allLanded, requeue: committed.requeue };
			}
			failure = run;
		}
		if (chain.length === 1) {
			const only = chain[0] as BatchChainStep;
			if (failure.state === "failed") {
				this.#report({
					event: "code-checks",
					step: "failed",
					...named(only.waiter.session),
					attempt: only.waiter.checkAttempts,
					exitCode: failure.failed.exitCode,
					atLimit: failure.failed.atLimit,
				});
				settleReject(
					only.waiter,
					new CodingLandRefused("CODING_CHECKS_FAILED", codeChecksFailedSummary(failure, only.step.how)),
				);
			} else {
				if (site === null) throw new Error("CODE_HOST_LANDING_INVALID");
				this.#report({
					event: "code-checks",
					step: "site-refused",
					...named(only.waiter.session),
					attempt: only.waiter.checkAttempts,
					problem: failure.problem.code,
					variable: failure.problem.variable,
				});
				settleReject(
					only.waiter,
					new CodingLandRefused(
						"CODING_CHECKS_SITE_REFUSED",
						codeSiteRefusedSummary(failure.problem, site.folder),
					),
				);
			}
			return { allLanded: false, requeue: [] };
		}
		const mid = Math.floor(chain.length / 2);
		const left = chain.slice(0, mid);
		const right = chain.slice(mid);
		const leftOutcome = await this.#checkAndLandChain(left, gate, switched, undefined);
		if (leftOutcome.allLanded) {
			return await this.#checkAndLandChain(right, gate, switched, failure);
		}
		const liveRight = this.#filterLiveWaiters(right.map((entry) => entry.waiter));
		return { allLanded: false, requeue: [...leftOutcome.requeue, ...liveRight] };
	}

	async #commitBatch(
		chain: readonly BatchChainStep[],
		gate: CodeChecksGateRun | null,
		passedRun: Extract<CodeChecksRun, { state: "passed" }> | null,
	): Promise<{ allLanded: boolean; requeue: LandingWaiter[] }> {
		const waiters = chain.map((entry) => entry.waiter);
		const live = this.#filterLiveWaiters(waiters);
		if (live.length !== waiters.length) return { allLanded: false, requeue: live };
		const first = waiters[0] as LandingWaiter;
		const last = waiters[waiters.length - 1] as LandingWaiter;
		const repository = first.session.claim.repository;
		const records: LandingRecord[] = chain.map(() => ({
			landed: false,
			filesChanged: 0,
			change: null,
			owed: undefined,
			confirm: undefined,
		}));
		let batchConfirm: (() => Promise<void>) | undefined;
		try {
			const committed = await this.#withBatchSignal(waiters, async (batchSignal) => {
				return await this.#jobs.run(
					first.session.claim.profileId,
					first.session.claim.environmentId,
					batchSignal,
					async (job) => {
						const authorized = await this.#authorizeBatchMembers(waiters);
						if (authorized.length !== waiters.length) throw new BatchAbortOrAuthDropped(authorized);
						const landed = await commitCodeBranchBatch(job, {
							repository,
							steps: chain.map(({ waiter, step }) => ({
								workerId: step.workerId,
								headSha: step.headSha,
								how: step.how,
								mainBefore: step.mainBefore,
								mainAfter: step.mainAfter,
								...(waiter.options.picture === undefined ? {} : { picture: waiter.options.picture }),
							})),
						});
						await withTimeoutScope(job.signal, this.#recordMs, async (bounded) => {
							for (let i = 0; i < landed.steps.length; i += 1) {
								const step = landed.steps[i] as (typeof landed.steps)[number];
								const waiter = (chain[i] as BatchChainStep).waiter;
								const record = records[i] as LandingRecord;
								record.landed = true;
								const isTip = i === landed.steps.length - 1;
								const stepChecks: LandingChecks =
									gate !== null && passedRun !== null
										? isTip
											? {
													state: "passed",
													result: codeChecksPassed({
														commit: step.mainSha,
														how: step.state,
														blob: gate.blob,
														run: passedRun,
														changed: chain.length === 1 ? gate.changed : null,
														tries: waiter.staleTries,
													}),
													site: passedRun.site,
												}
											: { state: "not_run" }
										: { state: "none" };
								let report: CodeChangeReport | undefined;
								try {
									const diff = codeChangeDiffOf(step.diff);
									record.filesChanged = diff?.filesChanged ?? 0;
									if (waiter.session.recordChange) {
										report = landingReport(
											{
												state: step.state,
												mainSha: step.mainSha,
												mainBefore: step.mainBefore,
												containedAt: null,
												diff: step.diff,
												picture: step.picture,
												restored: landed.restored,
											},
											step.headSha,
											diff,
											stepChecks,
										);
									}
								} catch (error) {
									this.#failed(waiter.session, "report", error);
								}
								if (report) {
									try {
										record.change = await this.#reported(waiter.session, report, bounded);
									} catch (error) {
										record.owed = report;
										this.#failed(waiter.session, "report", error);
									}
								}
								if (isTip && record.change !== null && passedRun?.site?.state === "made") {
									await pinCodeSiteTree(
										{
											shell: job.shell,
											layout: job.layout,
											signal: bounded,
											preparedKeptArea: codeAreaPath(repository),
										},
										{ repository, change: record.change, tree: passedRun.site.tree },
									).catch(() => undefined);
								}
							}
							const changeRecords = this.#records;
							if (changeRecords) {
								try {
									batchConfirm = await answeredBefore(
										() =>
											changeRecords.inJob(
												{
													shell: job.shell,
													layout: job.layout,
													signal: bounded,
													preparedKeptArea: codeAreaPath(repository),
												},
												targetOf(last.session),
												bounded,
											),
										bounded,
									);
								} catch (error) {
									this.#failed(last.session, "files", error);
								}
							}
						});
						return landed;
					},
				);
			});
			for (let i = 0; i < chain.length; i += 1) {
				await this.#reportOwed((chain[i] as BatchChainStep).waiter.session, records[i] as LandingRecord);
			}
			if (batchConfirm) {
				const confirm = batchConfirm;
				try {
					await withTimeoutScope(undefined, Math.ceil(this.#recordMs / 2), (confirmSignal) =>
						answeredBefore(confirm, confirmSignal),
					);
				} catch (error) {
					this.#failed(last.session, "written", error);
				}
			}
			const madeSite = passedRun?.site?.state === "made";
			for (let i = 0; i < committed.steps.length; i += 1) {
				const step = committed.steps[i] as (typeof committed.steps)[number];
				const waiter = (chain[i] as BatchChainStep).waiter;
				const record = records[i] as LandingRecord;
				const isTip = i === committed.steps.length - 1;
				if (passedRun !== null) {
					this.#report({
						event: "code-checks",
						step: "landed",
						...named(waiter.session),
						checks: "passed",
						attempt: waiter.checkAttempts,
						tries: waiter.staleTries,
						site: isTip ? (passedRun.site?.state ?? null) : null,
					});
				}
				settleResolve(waiter, {
					state: step.state,
					mainSha: step.mainSha,
					filesChanged: record.filesChanged,
					change: record.change,
				});
			}
			if (madeSite) {
				try {
					this.#sites?.wake();
				} catch (error) {
					this.#failed(last.session, "wake", error);
				}
			}
			return { allLanded: true, requeue: [] };
		} catch (error) {
			if (error instanceof BatchAbortOrAuthDropped) {
				return { allLanded: false, requeue: this.#filterLiveWaiters(error.survivors) };
			}
			if (
				error instanceof CodeHostJobFailure &&
				(error.code === "CODE_HOST_LAND_STALE" || error.code === "CODE_HOST_BASE_MOVED")
			) {
				const retryable: LandingWaiter[] = [];
				for (const { waiter } of chain) {
					if (waiter.settled) continue;
					if (waiter.signal.aborted) {
						settleReject(waiter, waiter.signal.reason);
						continue;
					}
					this.#report({
						event: "code-checks",
						step: "stale",
						...named(waiter.session),
						attempt: waiter.checkAttempts,
						tries: waiter.staleTries,
					});
					if (waiter.staleTries >= 2) {
						settleReject(
							waiter,
							new CodingLandRefused("CODING_CHECKS_MAIN_MOVED", CODE_CHECKS_MAIN_MOVED, { cause: error }),
						);
					} else {
						waiter.staleTries = 2;
						retryable.push(waiter);
					}
				}
				return { allLanded: false, requeue: retryable };
			}
			for (let i = 0; i < chain.length; i += 1) {
				const waiter = (chain[i] as BatchChainStep).waiter;
				const record = records[i] as LandingRecord;
				if (record.landed) await this.#reportOwed(waiter.session, record);
				if (!waiter.settled) await this.#rejectJobError(waiter, error);
			}
			return { allLanded: false, requeue: [] };
		}
	}

	async #authorizeBatchMembers(waiters: readonly LandingWaiter[]): Promise<LandingWaiter[]> {
		const authorized: LandingWaiter[] = [];
		for (const waiter of waiters) {
			if (waiter.settled) continue;
			if (waiter.signal.aborted) {
				settleReject(waiter, waiter.signal.reason);
				continue;
			}
			try {
				await waiter.session.assertAuthorized(waiter.signal);
				if (waiter.signal.aborted) {
					settleReject(waiter, waiter.signal.reason);
					continue;
				}
				authorized.push(waiter);
			} catch (error) {
				settleReject(waiter, error);
			}
		}
		return authorized;
	}

	#filterLiveWaiters(waiters: readonly LandingWaiter[]): LandingWaiter[] {
		const live: LandingWaiter[] = [];
		for (const waiter of waiters) {
			if (waiter.settled) continue;
			if (waiter.signal.aborted) {
				settleReject(waiter, waiter.signal.reason);
				continue;
			}
			live.push(waiter);
		}
		return live;
	}

	#filterLiveChain(chain: readonly BatchChainStep[]): BatchChainStep[] {
		const live: BatchChainStep[] = [];
		for (const entry of chain) {
			if (entry.waiter.settled) continue;
			if (entry.waiter.signal.aborted) {
				settleReject(entry.waiter, entry.waiter.signal.reason);
				continue;
			}
			live.push(entry);
		}
		return live;
	}

	async #withBatchSignal<T>(waiters: readonly LandingWaiter[], run: (signal: AbortSignal) => Promise<T>): Promise<T> {
		const controller = new AbortController();
		const cleanups: (() => void)[] = [];
		const checkAllAborted = () => {
			if (controller.signal.aborted) return;
			if (waiters.every((waiter) => waiter.settled || waiter.signal.aborted)) {
				const reason = waiters.find((waiter) => waiter.signal.aborted)?.signal.reason;
				controller.abort(reason);
			}
		};
		for (const waiter of waiters) {
			if (waiter.signal.aborted) continue;
			const listener = () => checkAllAborted();
			waiter.signal.addEventListener("abort", listener, { once: true });
			cleanups.push(() => waiter.signal.removeEventListener("abort", listener));
		}
		checkAllAborted();
		try {
			return await run(controller.signal);
		} finally {
			for (const cleanup of cleanups) cleanup();
		}
	}

	async #rejectRefusal(waiter: LandingWaiter, error: CodeHostRefusal): Promise<void> {
		if (waiter.settled) return;
		if (error.code === "CODE_HOST_LAND_CONFLICT") {
			await this.#reportRefused(waiter.session, waiter.headSha, "conflict", error.code, error.paths);
			settleReject(waiter, new CodingLandConflict(error.paths, error.messages));
			return;
		}
		const summary = landRefusal(
			waiter.session.claim.repository.baseBranch,
			error.code,
			error.code === "CODE_HOST_NAMES_FOLDER_REFUSES"
				? error.paths.map((path) => codeImportShown(path))
				: error.paths,
		);
		if (summary === undefined) {
			settleReject(waiter, error);
			return;
		}
		await this.#reportRefused(waiter.session, waiter.headSha, "refused", error.code, error.paths);
		settleReject(waiter, new CodingLandRefused(error.code, summary, { cause: error }));
	}

	async #rejectJobError(waiter: LandingWaiter, error: unknown): Promise<void> {
		if (waiter.settled) return;
		if (waiter.signal.aborted) {
			settleReject(waiter, waiter.signal.reason);
			return;
		}
		if (error instanceof CodeHostRefusal) {
			await this.#rejectRefusal(waiter, error);
			return;
		}
		if (error instanceof CodeHostJobFailure && error.code === "CODE_HOST_REF_UNREADABLE") {
			const summary = landRefusal(waiter.session.claim.repository.baseBranch, error.code, []);
			if (summary !== undefined) {
				await this.#reportRefused(waiter.session, waiter.headSha, "refused", error.code, []);
				settleReject(waiter, new CodingLandRefused(error.code, summary, { cause: error }));
				return;
			}
		}
		settleReject(waiter, error);
	}

	/** One job on the code host of the session's company, in that company's line. The session's run authority is asked
	 * again once the job's turn comes, before its first step, and once its steps are done, before the job publishes:
	 * a session whose authority ended while its job waited, or while it ran, writes and publishes nothing. */
	async #job<T>(
		session: Pick<CodingFolderRepositorySession, "claim" | "assertAuthorized">,
		signal: AbortSignal,
		steps: (job: CodeHostJob) => Promise<T>,
	): Promise<T> {
		const { profileId, environmentId } = session.claim;
		return await this.#jobs.run(profileId, environmentId, signal, async (job) => {
			await session.assertAuthorized(signal);
			const result = await steps(job);
			await session.assertAuthorized(signal);
			return result;
		});
	}

	async runReadOnly<T>(
		companyId: string,
		environmentId: string,
		signal: AbortSignal,
		steps: (job: CodeHostJob) => Promise<T>,
	): Promise<T> {
		return await this.#jobs.run(companyId, environmentId, signal, steps, { readOnly: true });
	}

	async log(
		companyId: string,
		environmentId: string,
		value: Parameters<typeof logCodeArea>[1],
		signal: AbortSignal,
	): Promise<ReturnType<typeof logCodeArea>> {
		return await this.runReadOnly(companyId, environmentId, signal, (job) => logCodeArea(job, value));
	}

	async diff(
		companyId: string,
		environmentId: string,
		value: Parameters<typeof diffCodeArea>[1],
		signal: AbortSignal,
	): Promise<ReturnType<typeof diffCodeArea>> {
		return await this.runReadOnly(companyId, environmentId, signal, (job) => diffCodeArea(job, value));
	}

	async show(
		companyId: string,
		environmentId: string,
		value: Parameters<typeof showCodeFile>[1],
		signal: AbortSignal,
	): Promise<ReturnType<typeof showCodeFile>> {
		return await this.runReadOnly(companyId, environmentId, signal, (job) => showCodeFile(job, value));
	}

	async branches(
		companyId: string,
		environmentId: string,
		value: Parameters<typeof listCodeBranches>[1],
		signal: AbortSignal,
	): Promise<ReturnType<typeof listCodeBranches>> {
		return await this.runReadOnly(companyId, environmentId, signal, (job) => listCodeBranches(job, value));
	}

	async mergePreview(
		companyId: string,
		environmentId: string,
		value: Parameters<typeof previewCodeMerge>[1],
		signal: AbortSignal,
	): Promise<ReturnType<typeof previewCodeMerge>> {
		return await this.runReadOnly(companyId, environmentId, signal, (job) => previewCodeMerge(job, value));
	}

	async tag(
		companyId: string,
		environmentId: string,
		value: Parameters<typeof tagCodeArea>[1],
		signal: AbortSignal,
	): Promise<ReturnType<typeof tagCodeArea>> {
		return await this.#jobs.run(companyId, environmentId, signal, (job) => tagCodeArea(job, value), {
			readOnly: value.mode === "list",
		});
	}

	async prune(
		companyId: string,
		environmentId: string,
		value: Parameters<typeof pruneCodeArea>[1],
		signal: AbortSignal,
	): Promise<ReturnType<typeof pruneCodeArea>> {
		return await this.#jobs.run(companyId, environmentId, signal, (job) => pruneCodeArea(job, value));
	}

	async undo(
		companyId: string,
		environmentId: string,
		value: Parameters<typeof undoCodeChange>[1],
		signal: AbortSignal,
	): Promise<ReturnType<typeof undoCodeChange>> {
		return await this.#jobs.run(companyId, environmentId, signal, (job) => undoCodeChange(job, value), {
			readOnly: value.dryRun === true,
		});
	}
}

/** The repository of a session, as the change record names it. */
function targetOf(session: CodingFolderRepositorySession): CodeChangeTarget {
	const { profileId, environmentId, repository } = session.claim;
	return { companyId: profileId, environmentId, owner: repository.owner, name: repository.name };
}

function named(session: CodingFolderRepositorySession): Record<string, unknown> {
	const { profileId, environmentId, repository, workerId, sequence } = session.claim;
	return {
		companyId: profileId,
		environmentId,
		repository: `${repository.owner}/${repository.name}`,
		workerId,
		sequence,
	};
}

/** Paths as the words of a refused workspace name them: as the import's look shows a path (`codeImportShown`: one over
 * 200 bytes, key-like or with a control character is only counted), quoted, the first twenty within 2,000 bytes, then
 * how many more, as a landing's refusal names them. */
function namedPaths(paths: readonly string[]): string {
	const shown: string[] = [];
	let used = 0;
	for (const path of paths
		.map((path) => codeImportShown(path))
		.filter((path) => path !== null)
		.slice(0, 20)) {
		const quoted = JSON.stringify(path);
		used += Buffer.byteLength(quoted) + 2;
		if (used > 2000) break;
		shown.push(quoted);
	}
	const more = paths.length - shown.length;
	if (!shown.length) return `${more} ${more === 1 ? "path" : "paths"} not named here`;
	return `${shown.join(", ")}${more ? ` and ${more} more` : ""}`;
}

function formatStartFailure(error: CodeHostJobFailure | CodeHostRefusal): string {
	if (!(error instanceof CodeHostJobFailure) || error.code !== "CODE_HOST_PUBLISH_REFUSED" || !error.detail) {
		return CODE_START_FAILED;
	}
	// WHY: Surface a sanitized, bounded refusal diagnostic (excluding key-like paths) so publish refusals during repo open are actionable instead of opaque.
	const parts: string[] = [];
	for (const rawPart of error.detail.split(", ").slice(0, 3)) {
		const trimmed = rawPart.trim();
		if (!trimmed) continue;
		if (trimmed.startsWith("refused: ")) {
			const reason = trimmed
				.slice("refused: ".length)
				.replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
				.slice(0, 80);
			if (reason) parts.push(`refused: ${reason}`);
			continue;
		}
		const colon = trimmed.indexOf(": ");
		if (colon > 0) {
			const path = codeImportShown(trimmed.slice(0, colon));
			const rest = trimmed
				.slice(colon + 2)
				.replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
				.slice(0, 80);
			parts.push(`${path ?? "<path>"}: ${rest}`);
		}
	}
	return parts.length > 0 ? `${CODE_START_FAILED} (${parts.join("; ").slice(0, 240)})` : CODE_START_FAILED;
}

/** The words of a session's workspace refused for the names of what it would hold, or for a file too large (the code
 * host's `CODE_HOST_NAMES_*`, `CODE_HOST_FILE_TOO_LARGE`), or undefined for any other failure. The same names are
 * refused the same way at every follow-up, so the words never say one tries again. Whose names they are says what to
 * do: the session's own branch (its worktree made again, `CodeWorktreeNamesRefused`) is carried into a new session;
 * GitHub's default branch (a seed, or a new worktree at GitHub's base) is a member's to fix on GitHub; the default
 * branch of a repository kept in Qorpera can be fixed by no session. */
function namesRefused(
	session: Pick<CodingFolderRepositorySession, "claim">,
	error: CodeHostJobFailure | CodeHostRefusal,
): string | undefined {
	if (!(error instanceof CodeHostRefusal) || !(error.code.startsWith("CODE_HOST_NAMES_") || error.code === TOO_LARGE))
		return undefined;
	const { repository, workerId } = session.claim;
	const large = error.code === TOO_LARGE;
	const what = large
		? "files larger than 256 MiB, which Qorpera does not take"
		: error.code === "CODE_HOST_NAMES_DIFFER_BY_CASE"
			? "names in one folder that differ only by upper and lower case"
			: error.code === "CODE_HOST_NAMES_NOT_UTF8" || error.code === "CODE_HOST_NAMES_NOT_NFC"
				? "file names that are not plain Unicode text (UTF-8, in its composed form NFC)"
				: "file or folder names the company folder does not take";
	const held = `${what}${error.paths.length ? ` (${namedPaths(error.paths)})` : ""}`;
	if (error instanceof CodeWorktreeNamesRefused && error.of === "branch") {
		const branch = `qorpera/coding/${workerId}`;
		return `The session's workspace could not be made again: its branch holds ${held}, so a follow-up will not help. Archive this session with manage_worker, action archive, and start a new one on the repository: the work stays on branch ${branch}, where the new session reads each file with git show ${branch}:<path> and ${large ? "leaves the files over 256 MiB out" : "saves it under a name the folder takes"}.`;
	}
	if (repository.host === "github.com")
		return `GitHub's ${repository.baseBranch} of ${repository.owner}/${repository.name} holds ${held}, so no coding session can open it here and a follow-up will not help. A member must ${large ? "take them out" : "rename them"} on GitHub first.`;
	return `The session's workspace could not be made: where a session's workspace holds them, ${repository.baseBranch} holds ${held}, so no coding session can open this repository and a follow-up will not help. Say so in your report.`;
}

/** What the kernel is told of a landing, from what the job answered, with what the repository's checks said of a
 * landing that moved main (`checks`; an unchanged main says nothing of them). A landing whose checks passed is v3, with
 * what became of its site (`codeSiteReported`); every other report is v2 as before. It throws when the answer is not a
 * landing's, a passed run's result is not of the commit that went in, or its site is not one the kernel takes: its
 * caller reports that, and the landing stands. */
function landingReport(
	landed: CodeBranchLanded,
	headSha: string,
	diff: ReturnType<typeof codeChangeDiffOf>,
	checks: LandingChecks,
): CodeChangeReport {
	const sha = (commit: unknown): commit is string => typeof commit === "string" && SHA.test(commit);
	const report = {
		schema: "qorpera.code-change-report/v2" as const,
		inLine: true,
		headSha,
		refusal: null,
	};
	if (landed.state === "unchanged") {
		// Main held the commit already: where main is, and the commit of main that first held it.
		if (!sha(landed.mainBefore) || !sha(landed.containedAt)) throw new Error("CODE_CHANGE_LANDING_INVALID");
		return {
			...report,
			state: "unchanged",
			how: null,
			mainBefore: landed.mainBefore,
			mainAfter: landed.containedAt,
			filesChanged: null,
			paths: null,
			pathsMore: 0,
			picture: null,
			checks: null,
		};
	}
	const picture = landed.picture;
	if (
		(landed.state !== "fast-forward" && landed.state !== "merged") ||
		!sha(landed.mainBefore) ||
		!sha(landed.mainSha) ||
		!diff ||
		!(
			picture === null ||
			(picture.state === "ok"
				? sha(picture.blob) &&
					Number.isSafeInteger(picture.bytes) &&
					picture.bytes >= 0 &&
					["png", "jpeg", "webp"].includes(picture.type)
				: ["missing", "not_a_file", "too_large", "not_a_picture"].includes(picture.state))
		) ||
		(checks.state === "passed" && (checks.result.commit !== landed.mainSha || checks.result.how !== landed.state))
	)
		throw new Error("CODE_CHANGE_LANDING_INVALID");
	const moved = {
		...report,
		state: "landed" as const,
		how: landed.state,
		mainBefore: landed.mainBefore,
		mainAfter: landed.mainSha,
		...codeChangeDiffReported(diff),
		picture:
			picture === null
				? null
				: picture.state === "ok"
					? { state: "ok" as const, blob: picture.blob, bytes: picture.bytes, type: picture.type }
					: { state: picture.state },
	};
	if (checks.state !== "passed") return { ...moved, checks };
	return {
		...moved,
		schema: "qorpera.code-change-report/v3",
		checks: { state: "passed", result: checks.result },
		site: codeSiteReported(checks.site),
	};
}

/** The host's broker for this session only: its authority and its token, for the claimed repository and no other. */
function codeAreaBroker(session: CodingFolderRepositorySession): CodeAreaBroker {
	const claimed = (repository: CloudCodingRepository): void => {
		if (!isDeepStrictEqual(repository, session.claim.repository)) throw new Error("CODE_HOST_REPOSITORY_DIFFERS");
	};
	return {
		journalRoot: session.journalRoot,
		async assertAuthorized(repository, signal) {
			claimed(repository);
			await session.assertAuthorized(signal);
		},
		async withRepositoryToken<T>(
			repository: CloudCodingRepository,
			use: (token: string) => Promise<T>,
			signal: AbortSignal,
		): Promise<T> {
			claimed(repository);
			return await session.withRepositoryToken(repository, use, signal);
		},
		runGit: session.runGit,
	};
}

async function readCommitSetupFile(
	run: Run,
	commit: string,
	path: string,
	maxBytes: number,
): Promise<{ kind: "missing" } | { kind: "other" } | { kind: "file"; bytes: Uint8Array }> {
	if (!path || path.length > 4096 || /[\0\n\r]/.test(path)) return { kind: "missing" };
	if (path.split("/").some((part) => !part || part === "." || part === "..")) return { kind: "missing" };
	const listing = await run.gitOk(
		run.repo,
		["ls-tree", "-l", "-z", "--full-tree", commit, "--", path],
		"CODE_HOST_TREE_UNREADABLE",
	);
	const wantedPath = Buffer.from(path, "utf8");
	const entry = treeRecords(listing).find((record) => record.path.equals(wantedPath));
	if (!entry) return { kind: "missing" };
	if (entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755")) return { kind: "other" };
	const bytes = Number(entry.size);
	if (!SHA.test(entry.name) || !Number.isSafeInteger(bytes)) throw new CodeHostJobFailure("CODE_HOST_TREE_UNREADABLE");
	if (bytes > maxBytes) return { kind: "file", bytes: Buffer.alloc(maxBytes + 1) };
	const read = await run.git(run.repo, ["cat-file", "blob", entry.name], { maximumOutputBytes: maxBytes });
	if (read.status !== 0) throw new CodeHostJobFailure("CODE_HOST_FILE_UNREADABLE", tail(read.stderr));
	return { kind: "file", bytes: read.stdout };
}
