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
	codeChecksFailedSummary,
	codeChecksGate,
	codeChecksNotRunSummary,
	codeChecksPassed,
	readCodeChecks,
} from "./code-checks.ts";
import {
	addCodeWorktree,
	type CodeBranchLanded,
	type CodeBranchToCheck,
	type CodeHostJob,
	CodeHostJobFailure,
	CodeHostRefusal,
	CodeWorktreeNamesRefused,
	codeAreaPath,
	exportCodeBranch,
	landCodeBranch,
	startCodeArea,
} from "./code-host-jobs.ts";
import { attachCodeSession, type CodeAreaBroker } from "./code-host-seed.ts";
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
} from "./coding-folder-repositories.ts";

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
	/** The pass that uploads a repository's site (`code-site-uploads.ts`, own code storage step 4): woken after a
	 * landing whose report says its site was made, so the upload starts now. */
	sites?: { wake(): void };
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

	constructor(jobs: Pick<CodeHostJobs, "run">, options: CodeHostRepositoriesOptions = {}) {
		const recordMs = options.recordMs ?? CODE_CHANGE_RECORD_MS;
		if (!Number.isSafeInteger(recordMs) || recordMs < 1) throw new Error("INVALID_CODE_HOST_REPOSITORIES");
		this.#jobs = jobs;
		this.#records = options.records;
		this.#sites = options.sites;
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
	 * for the executor's log. Names the code host or the company folder refuses, and a file too large, are refused the
	 * same way at every follow-up: their words say so, and what to do instead (`namesRefused`). */
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
	 * or a host that runs none, too, saying `off`.
	 *
	 * The candidate's checks file may say where its checks leave the repository's website (step 4): the run then takes it
	 * once every check passed, unless the switch says sites are off. A site the code made wrong fails the turn as a failed
	 * check does (`CODING_CHECKS_SITE_REFUSED`, no row). A run that passed is reported as v3, with what became of its
	 * site; after a landing whose report says the site was made, the upload pass is woken (`sites`).
	 *
	 * From step 5 the switch may say that sites have hosts of their own (`rootLinks`): the run then lets a site's links
	 * from `/` through. And it may hand over an operator's drill, once: a `check` drill runs one more check after the
	 * repository's own (`CODE_CHECKS_DRILL`), which fails; a `site` drill takes the site from a folder no repository has
	 * (`CODE_SITE_DRILL_FOLDER`). Either way the turn fails on the platform's own refusal path, with its usual code, and
	 * its words start with `CODE_DRILL_WORDS`. */
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
		const switched: CodeChecksSwitched =
			checksSwitch !== undefined && runChecks !== undefined
				? await checksSwitch(signal)
				: { checks: false, site: false };
		const enabled = switched.checks;
		const told = (step: string, extra: Record<string, unknown> = {}) =>
			this.#report({ event: "code-checks", step, ...named(session), ...extra });
		// An operator's drill the switch handed over (step 5): the kernel hands it to no other answer, so it acts on this
		// landing's run or on none (no checks file, nothing to check, no site to take: spent, and the operator sets it
		// again). The log says it was taken.
		const drill = switched.drill;
		if (drill !== undefined) told("drill", { drill });
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
			// The candidate's site is taken only while the switch says sites are on. A site drill puts a folder no repository
			// has in the recipe's place, so the collect says the site is not there; a check drill runs one more check after
			// the repository's own, which says it is a drill and fails (step 5, D17). Links from / are let through only
			// while the switch says sites have hosts of their own (step 5, D15); else the input is as before.
			const recipe = switched.site ? gate.site : null;
			const site = recipe !== null && drill === "site" ? { ...recipe, folder: CODE_SITE_DRILL_FOLDER } : recipe;
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
				// The drill's folder is not there: its words say first that it was a drill.
				const drilled = drill === "site" && run.problem.code === "SITE_FOLDER_MISSING";
				told("site-refused", {
					attempt: runs,
					problem: run.problem.code,
					variable: run.problem.variable,
					...(drilled ? { drill } : {}),
				});
				throw new CodingLandRefused(
					"CODING_CHECKS_SITE_REFUSED",
					drilled
						? codeSiteRefusedSummary(run.problem, site.folder, `${CODE_DRILL_WORDS} `)
						: codeSiteRefusedSummary(run.problem, site.folder),
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

/** The words of a session's workspace refused for the names of what it would hold, or for a file too large (the code
 * host's `CODE_HOST_NAMES_*`, `CODE_HOST_FILE_TOO_LARGE`), or undefined for any other failure. The same names are
 * refused the same way at every follow-up, so the words never say one tries again. Whose names they are says what to
 * do: the session's own branch (its worktree made again, `CodeWorktreeNamesRefused`) is carried into a new session;
 * GitHub's default branch (a seed, or a new worktree at GitHub's base) is a member's to fix on GitHub; the default
 * branch of a repository kept in Qorpera can be fixed by no session. */
function namesRefused(
	session: CodingFolderRepositorySession,
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
