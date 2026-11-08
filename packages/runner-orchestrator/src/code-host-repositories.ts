import { isDeepStrictEqual } from "node:util";
import type { CloudCodingRepository } from "@qorpera/contracts";
import {
	addCodeWorktree,
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
import { CodingLandConflict, CodingWorkspaceFailed } from "./coding-executor.ts";
import {
	CODING_FOLDER_COMPANY_ROOT,
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

/** The coding sessions' repositories on the folder path (F3 step 5g-6b). A session works in its own locked worktree
 * of its company's code area, `/company/code/<owner>/<name>/worktrees/<workerId>` (lower-case, `codeAreaPath`) on
 * branch `qorpera/coding/<workerId>`: the code host seeds the area from GitHub when the session's base is not in it yet
 * and adds the worktree, in one job. At publish the code host exports what the session's branch has beyond its base,
 * and the host's broker pushes that. The repository token never reaches the code host or the machine. */
export class CodeHostRepositories implements CodingFolderRepositories {
	readonly #jobs: Pick<CodeHostJobs, "run">;

	constructor(jobs: Pick<CodeHostJobs, "run">) {
		this.#jobs = jobs;
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
			throw new CodingWorkspaceFailed(error.code, CODE_COPY_FAILED, { cause: error });
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
				error.code === "CODE_HOST_AREA_FROM_GITHUB" ? CODE_AREA_TAKEN : CODE_START_FAILED,
				{ cause: error },
			);
		}
	}

	/** The session's submitted commit landed on the default branch of its repository kept in Qorpera. */
	async land(session: CodingFolderRepositorySession, headSha: string, signal: AbortSignal): Promise<CodingLanded> {
		const { repository, workerId } = session.claim;
		if (repository.host !== "qorpera") throw new Error("CODE_HOST_REPOSITORY_NOT_HERE");
		try {
			const landed = await this.#job(session, signal, (job) =>
				landCodeBranch(job, { repository, workerId, headSha }),
			);
			return { state: landed.state, mainSha: landed.mainSha };
		} catch (error) {
			if (error instanceof CodeHostRefusal && error.code === "CODE_HOST_LAND_CONFLICT")
				throw new CodingLandConflict(error.paths);
			throw error;
		}
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
