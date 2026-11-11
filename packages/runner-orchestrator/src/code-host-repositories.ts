import { isDeepStrictEqual } from "node:util";
import type { CloudCodingRepository } from "@qorpera/contracts";
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
	type CodeBranchToCheck,
	codeChecksFailedSummary,
	codeChecksGate,
	codeChecksNotRunSummary,
	codeChecksPassed,
	type LandCodeBranch,
	readCodeChecks,
} from "./code-checks-stand-in.ts";
import {
	addCodeWorktree,
	type CodeBranchLanded,
	type CodeHostJob,
	CodeHostJobFailure,
	CodeHostRefusal,
	codeAreaPath,
	exportCodeBranch,
	landCodeBranch,
	startCodeArea,
} from "./code-host-jobs.ts";
import { attachCodeSession, type CodeAreaBroker } from "./code-host-seed.ts";
import type { CodeHostJobs } from "./code-host-views.ts";
import { CodingLandConflict, CodingLandRefused, CodingWorkspaceFailed, landRefusal } from "./coding-executor.ts";
import {
	CODING_FOLDER_COMPANY_ROOT,
	type CodeChangeReport,
	type CodeChangeReportV2,
	type CodingFolderRepositories,
	type CodingFolderRepositorySession,
	type CodingFolderStart,
	type CodingLanded,
} from "./coding-folder-repositories.ts";

/** The largest bundle a session's export hands the broker's push: the NAS path's cap (coding-git-transfer.ts). */
export const CODE_HOST_EXPORT_MAXIMUM_BYTES = 64 * 1024 ** 2;
/** What the member and the agent read when the code host could not make the session's worktree (its code follows). */
const CODE_COPY_FAILED =
	"Making the session's copy of the code failed. The workspace is kept; a follow-up tries again.";
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
}

/** What the repository's checks said of a landing that moved main: its report's `checks` (step 3). */
type LandingChecks = NonNullable<CodeChangeReportV2["checks"]>;

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

	constructor(jobs: Pick<CodeHostJobs, "run">, options: CodeHostRepositoriesOptions = {}) {
		const recordMs = options.recordMs ?? CODE_CHANGE_RECORD_MS;
		if (!Number.isSafeInteger(recordMs) || recordMs < 1) throw new Error("INVALID_CODE_HOST_REPOSITORIES");
		this.#jobs = jobs;
		this.#records = options.records;
		const report = options.report;
		// The log must never change what happens: a reporter that throws is not heard.
		this.#report = (event) => {
			try {
				report?.(event);
			} catch {
				/* not heard */
			}
		};
		this.#recordMs = recordMs;
	}

	/** A job that failed at one of its steps or was refused by rule (the code host's own error, which names its code)
	 * fails the turn at once with that code (CodingWorkspaceFailed): what the code host said stays with it, as its cause,
	 * for the executor's log. */
	async prepare(session: CodingFolderRepositorySession, signal: AbortSignal): Promise<{ cwd: string }> {
		const { repository, workerId } = session.claim;
		try {
			await this.#job(session, signal, async (job) => {
				// A repository kept in Qorpera holds its sessions' bases (start made it): only the worktree is added.
				if (repository.host === "qorpera") {
					const added = await addCodeWorktree(job, { repository, workerId, baseSha: session.baseSha });
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
			throw new CodingWorkspaceFailed(error.code, error.code === RESTORING ? CODE_RESTORING : CODE_COPY_FAILED, {
				cause: error,
			});
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
		const { repository } = session.claim;
		if (repository.host !== "qorpera") throw new Error("CODE_HOST_REPOSITORY_NOT_HERE");
		try {
			const started = await this.#job(session, signal, (job) => startCodeArea(job, { repository }));
			return { baseSha: started.baseSha };
		} catch (error) {
			if (signal.aborted || !(error instanceof CodeHostJobFailure || error instanceof CodeHostRefusal)) throw error;
			throw new CodingWorkspaceFailed(
				error.code,
				error.code === "CODE_HOST_AREA_FROM_GITHUB"
					? CODE_AREA_TAKEN
					: error.code === RESTORING
						? CODE_RESTORING
						: CODE_START_FAILED,
				{ cause: error },
			);
		}
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
	 * or a host that runs none, too, saying `off`. */
	async land(
		session: CodingFolderRepositorySession,
		headSha: string,
		signal: AbortSignal,
		options: { picture?: string } = {},
	): Promise<CodingLanded> {
		const { repository } = session.claim;
		if (repository.host !== "qorpera") throw new Error("CODE_HOST_REPOSITORY_NOT_HERE");
		const { checksSwitch, runChecks } = session;
		// The switch's answer lost is read as on: a landing never goes in unchecked for want of an answer.
		const enabled = checksSwitch !== undefined && runChecks !== undefined && (await checksSwitch(signal));
		const told = (step: string, extra: Record<string, unknown> = {}) =>
			this.#report({ event: "code-checks", step, ...named(session), ...extra });
		let runs = 0;
		for (let tries: 1 | 2 = 1; ; tries = 2) {
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
			const input = { commit: found.mainAfter, checks: gate.checks };
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
				told("failed", { attempt: runs, exitCode: run.failed.exitCode, atLimit: run.failed.atLimit });
				throw new CodingLandRefused("CODING_CHECKS_FAILED", codeChecksFailedSummary(run, found.how));
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
					{ state: "passed", result },
				);
				if (landed.state === "to-check") throw new Error("CODE_HOST_LANDING_INVALID");
				told("landed", { checks: landed.state === "unchanged" ? null : "passed", attempt: runs, tries });
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
					// STAND-IN (code-checks-stand-in.ts): with part B's types this cast goes.
					const landed = await (landCodeBranch as LandCodeBranch)(job, {
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
						await answeredBefore(confirm, AbortSignal.timeout(Math.ceil(this.#recordMs / 2)));
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
				const summary = code === undefined ? undefined : landRefusal(repository.baseBranch, code, paths);
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
		const bounded = AbortSignal.any([job.signal, AbortSignal.timeout(this.#recordMs)]);
		try {
			record.change = await this.#reported(session, report, bounded);
		} catch (error) {
			// The kernel may have the row all the same: the same report again answers it.
			record.owed = report;
			this.#failed(session, "report", error);
			return;
		}
		const records = this.#records;
		if (!records) return;
		try {
			record.confirm = await answeredBefore(
				() => records.inJob({ shell: job.shell, layout: job.layout, signal: bounded }, targetOf(session), bounded),
				bounded,
			);
		} catch (error) {
			this.#failed(session, "files", error);
		}
	}

	/** A report the job could not make, made once more now that the job has ended: not in line any more. It never
	 * throws; a second failure is left to the kernel, which finds the movement at the next one it records. */
	async #reportOwed(session: CodingFolderRepositorySession, record: LandingRecord): Promise<void> {
		const owed = record.owed;
		if (!owed) return;
		record.owed = undefined;
		try {
			record.change = await this.#reported(
				session,
				{ ...owed, inLine: false },
				AbortSignal.timeout(Math.ceil(this.#recordMs / 2)),
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
			await this.#reported(
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
				AbortSignal.timeout(Math.ceil(this.#recordMs / 2)),
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

/** What the kernel is told of a landing, from what the job answered, with what the repository's checks said of a
 * landing that moved main (`checks`; an unchanged main says nothing of them). It throws when the answer is not a
 * landing's, or a passed run's result is not of the commit that went in: its caller reports that, and the landing
 * stands. */
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
	return {
		...report,
		state: "landed",
		how: landed.state,
		mainBefore: landed.mainBefore,
		mainAfter: landed.mainSha,
		...codeChangeDiffReported(diff),
		picture:
			picture === null
				? null
				: picture.state === "ok"
					? { state: "ok", blob: picture.blob, bytes: picture.bytes, type: picture.type }
					: { state: picture.state },
		checks,
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
