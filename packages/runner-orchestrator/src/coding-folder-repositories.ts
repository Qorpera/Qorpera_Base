import type { CloudCodingRepository } from "@qorpera/contracts";
import type { CodeCheck, CodeChecksRun, CodeSiteRecipe } from "./code-checks.ts";
import type { CodeChangePath, CodePictureChecked } from "./code-host-jobs.ts";
import type { CodingSessionClaim } from "./coding-executor.ts";
import type { CodingBrokerGitRunner } from "./coding-git.ts";
import type { LxdCodingMachineBinding } from "./coding-machine.ts";
import type { ParsedCodingSetup } from "./coding-setup.ts";

// Where a coding session's repository lives on the folder model (F3 step 5g-6a; the plan's "Repositories"). On the
// NAS model the executor seeds a checkout into the session's own volume and exports a bundle from it; on the folder
// model the repository is part of the company folder, and the session works in its own worktree there. This is the
// seam between the executor and that code (5g-6b): on each turn the executor calls `prepare` before it attaches the
// session and mounts its view, so a view mounted after it lists the session's worktree from its first listing, and
// `export` when the turn finishes (after the machine's boundary has saved what the session wrote), and it pushes and
// publishes the bundle itself, as on the NAS model. A later turn of the same attachment keeps the session's view: what
// its `prepare` puts back in a worktree that is already there reaches that view when the view's feed brings the change.

/** The session as the executor prepared it for this turn, with the authority each repository step needs. */
export interface CodingFolderRepositorySession {
	readonly claim: CodingSessionClaim;
	readonly machine: Readonly<LxdCodingMachineBinding>;
	/** The session's own user in the machine; its group has the same id. */
	readonly uid: number;
	/** The commit the session started from, pinned by its first turn. */
	readonly baseSha: string;
	/** The executor's Git journal folder on the host (its NAS control path). */
	readonly journalRoot: string;
	/** Fresh run authority for the session on its machine: call it before each step that has an effect. */
	assertAuthorized(signal: AbortSignal): Promise<void>;
	/** Lends the session's repository token to `use` for one Git broker or GitHub API step. */
	withRepositoryToken<T>(
		repository: CloudCodingRepository,
		use: (token: string) => Promise<T>,
		signal: AbortSignal,
	): Promise<T>;
	readonly runGit?: CodingBrokerGitRunner;
	/** Reports one landing of the session's turn, or one that was refused, to the repository's change record
	 * (`qorpera_record_code_change`, with the claim's worker and lease), and answers what the kernel made of it and the
	 * change's number when it has one. Absent: this host records no changes. */
	recordChange?(report: CodeChangeReport, signal: AbortSignal): Promise<{ state: string; change: number | null }>;
	/** qorpera_code_checks_switch under the turn's lease: whether Qorpera's checks run for this repository, and whether
	 * the site its checks leave is kept (own code storage, step 4). Both true when the answer was lost, and `site` true
	 * when the kernel's answer does not say it; a refusal is thrown. From step 5 (migration 20260930756000), and only when
	 * the kernel's answer says so: `rootLinks`, sites have hosts of their own, so a site's links from `/` are its own; and
	 * `drill`, an operator's drill this answer took (once: the kernel hands it to no other answer). Absent: this host runs
	 * no checks. */
	checksSwitch?(signal: AbortSignal): Promise<CodeChecksSwitched>;
	/** One run of `checks` on a clean copy of `commit` in the session's machine (own code storage, step 3). When `site`
	 * is a recipe and every check passed, the run then takes the site the checks left (step 4): a site the code made
	 * wrong is `site_refused`, and a run that passed says what became of it. `rootLinks` true lets the site's links from
	 * `/` through (step 5); absent, they are refused as before. Never throws for a check's, the site's or the machine's
	 * sake (`not_run`, a missed site); throws only the turn's abort. Absent: this host runs no checks. */
	runChecks?(
		input: {
			commit: string;
			checks: readonly CodeCheck[];
			attempt: number;
			site: CodeSiteRecipe | null;
			rootLinks?: boolean;
		},
		signal: AbortSignal,
	): Promise<CodeChecksRun>;
}

/** What the checks switch said (`qorpera.code-checks-switch/v1`): `rootLinks` and `drill` only when the kernel said
 * them (own code storage, step 5), so that with a kernel before that, or sites' hosts off, it is as before. */
export interface CodeChecksSwitched {
	checks: boolean;
	site: boolean;
	rootLinks?: true;
	drill?: "check" | "site";
}

export interface CodingFolderRepositories {
	/** Makes the session's worktree ready and answers where its commands start, a path in the machine. The same call
	 * again answers the same: each turn calls it. */
	prepare(session: CodingFolderRepositorySession, signal: AbortSignal): Promise<{ cwd: string }>;
	/** The bundle of the session's work from its base to `headSha`, or null when there is none. It may reject with
	 * CODE_HOST_EXPORT_DIFFERS when the worktree's head is not `headSha`. */
	export(session: CodingFolderRepositorySession, headSha: string, signal: AbortSignal): Promise<Buffer | null>;
	/** A repository kept in Qorpera (host `qorpera`, own code storage slice 1): made empty when it is not there yet, and
	 * its default branch's commit, which a session's first turn pins as its base. Absent: no repository is kept here. */
	start?(session: CodingFolderStart, signal: AbortSignal): Promise<{ baseSha: string }>;
	/** The session's submitted commit landed on the default branch of a repository kept in Qorpera. Rejects with
	 * CodingLandConflict (coding-executor.ts) when it conflicts with the default branch. `picture` is the screenshot the
	 * session named with its hand-in, by its path in the repository: the landing checks it in the commit that lands. */
	land?(
		session: CodingFolderRepositorySession,
		headSha: string,
		signal: AbortSignal,
		options?: { picture?: string },
	): Promise<CodingLanded>;
	readSetup?(session: CodingFolderStart, baseSha: string, signal: AbortSignal): Promise<ParsedCodingSetup>;
	archiveCommit?(
		session: CodingFolderStart,
		commitSha: string,
		signal: AbortSignal,
		options?: { maximumBytes?: number },
	): Promise<Buffer>;
}

/** What a start needs: the claim, and its run authority (no base yet, no worktree, no token). */
export interface CodingFolderStart {
	readonly claim: CodingSessionClaim;
	assertAuthorized(signal: AbortSignal): Promise<void>;
}

/** Where a session's work landed in a repository kept in Qorpera. */
export interface CodingLanded {
	readonly state: "fast-forward" | "merged" | "unchanged";
	/** The default branch's commit after the landing. */
	readonly mainSha: string;
	/** How many paths differ between the default branch before and after the landing; 0 when nothing changed. */
	readonly filesChanged: number;
	/** The landing's number in the repository's change record, or null when the kernel gave it none or was not heard. */
	readonly change: number | null;
}

/** What the executor reports of one landing (`qorpera.code-change-report/v1`, own code storage step 2b), with exactly
 * these keys. `inLine`: made inside the landing's own job, while the company's line of code host jobs was held, so the
 * default branch cannot have moved again. `landed`: `mainBefore` and `mainAfter` are the default branch before and
 * after. `unchanged`: `mainBefore` is the default branch now, `mainAfter` the commit of it that first held `headSha`.
 * `conflict` and `refused` never went in: they name no commit of the default branch, and say why in `refusal`. */
export type CodeChangeReport = CodeChangeReportV1 | CodeChangeReportV2 | CodeChangeReportV3;
export interface CodeChangeReportV1 {
	schema: "qorpera.code-change-report/v1";
	state: "landed" | "unchanged" | "conflict" | "refused";
	inLine: boolean;
	how: "fast-forward" | "merged" | null;
	headSha: string;
	mainBefore: string | null;
	mainAfter: string | null;
	filesChanged: number | null;
	/** The first paths that differ, at most 50; `pathsMore` counts the rest. */
	paths: CodeChangePath[] | null;
	pathsMore: number;
	picture: CodePictureChecked | null;
	/** The code host's own code and the paths it named, at most 20. */
	refusal: { code: string; paths: string[] } | null;
}
// WHY: v2 reports record what checks did for a landing: `none`, `off`, `passed` (every check passed
// on `mainAfter`), or `not_run` (intermediate batch commit whose checks ran only on the batch tip,
// so it is not release-ready). Non-landed states carry `null`.
export interface CodeChangeReportV2 extends Omit<CodeChangeReportV1, "schema"> {
	schema: "qorpera.code-change-report/v2";
	checks:
		| { state: "none" }
		| { state: "off" }
		| { state: "not_run" }
		| { state: "passed"; result: Record<string, unknown> }
		| null;
}
/** The same report with what became of the site the checks left (`qorpera.code-change-report/v3`, own code storage step
 * 4), made only for a landing whose checks passed: `site` is null when there was none to take (no recipe, or sites
 * switched off), else `codeSiteReported`'s `made` or `missed`. Every other report is v2. */
export interface CodeChangeReportV3 extends Omit<CodeChangeReportV2, "schema"> {
	schema: "qorpera.code-change-report/v3";
	site: Record<string, unknown> | null;
}

/** Where a coding machine mounts its session's view of the company folder, and where the session's commands start
 * when the executor has no code hosts. */
export const CODING_FOLDER_COMPANY_ROOT = "/company";

/** Phase A's repositories: none. Commands start at the company folder, and a finished turn has nothing to push. */
export const codingFolderNoRepositories: CodingFolderRepositories = Object.freeze({
	prepare: async (_session: CodingFolderRepositorySession, signal: AbortSignal) => {
		signal.throwIfAborted();
		return { cwd: CODING_FOLDER_COMPANY_ROOT };
	},
	export: async (_session: CodingFolderRepositorySession, _headSha: string, signal: AbortSignal) => {
		signal.throwIfAborted();
		return null;
	},
});
