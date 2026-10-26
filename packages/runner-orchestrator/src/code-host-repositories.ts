import { isDeepStrictEqual } from "node:util";
import type { CloudCodingRepository } from "@qorpera/contracts";
import {
	type CodeHostJob,
	CodeHostJobFailure,
	CodeHostRefusal,
	codeAreaPath,
	exportCodeBranch,
} from "./code-host-jobs.ts";
import { attachCodeSession, type CodeAreaBroker } from "./code-host-seed.ts";
import type { CodeHostJobs } from "./code-host-views.ts";
import { CodingWorkspaceFailed } from "./coding-executor.ts";
import {
	CODING_FOLDER_COMPANY_ROOT,
	type CodingFolderRepositories,
	type CodingFolderRepositorySession,
} from "./coding-folder-repositories.ts";

/** The largest bundle a session's export hands the broker's push: the NAS path's cap (coding-git-transfer.ts). */
export const CODE_HOST_EXPORT_MAXIMUM_BYTES = 64 * 1024 ** 2;
/** What the member and the agent read when the code host could not make the session's worktree (its code follows). */
const CODE_COPY_FAILED =
	"Making the session's copy of the code failed. The workspace is kept; a follow-up tries again.";

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
		const broker = codeAreaBroker(session);
		try {
			await this.#job(session, signal, (job) =>
				attachCodeSession(job, { repository, workerId, baseSha: session.baseSha }, broker),
			);
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

	/** One job on the code host of the session's company, in that company's line. The session's run authority is asked
	 * again once the job's turn comes, before its first step, and once its steps are done, before the job publishes:
	 * a session whose authority ended while its job waited, or while it ran, writes and publishes nothing. */
	async #job<T>(
		session: CodingFolderRepositorySession,
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
