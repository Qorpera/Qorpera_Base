import { isDeepStrictEqual } from "node:util";
import type { CloudCodingRepository } from "@qorpera/contracts";
import { type CodeHostJob, codeAreaPath, exportCodeBranch } from "./code-host-jobs.ts";
import { attachCodeSession, type CodeAreaBroker } from "./code-host-seed.ts";
import type { CodeHostJobs } from "./code-host-views.ts";
import {
	CODING_FOLDER_COMPANY_ROOT,
	type CodingFolderRepositories,
	type CodingFolderRepositorySession,
} from "./coding-folder-repositories.ts";

/** The largest bundle a session's export hands the broker's push: the NAS path's cap (coding-git-transfer.ts). */
export const CODE_HOST_EXPORT_MAXIMUM_BYTES = 64 * 1024 ** 2;

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

	async prepare(session: CodingFolderRepositorySession, signal: AbortSignal): Promise<{ cwd: string }> {
		const { repository, workerId } = session.claim;
		const broker = codeAreaBroker(session);
		await this.#job(session, signal, (job) =>
			attachCodeSession(job, { repository, workerId, baseSha: session.baseSha }, broker),
		);
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
