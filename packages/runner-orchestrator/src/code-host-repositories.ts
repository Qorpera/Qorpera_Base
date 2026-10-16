import { isDeepStrictEqual } from "node:util";
import type { CloudCodingRepository } from "@qorpera/contracts";
import { codeAreaPath } from "./code-host-jobs.ts";
import type { CodeAreaBroker } from "./code-host-seed.ts";
import type { CodeHostJobs, CodeHostSession } from "./code-host-views.ts";
import type { CodingFolderRepositories, CodingFolderRepositorySession } from "./coding-folder-repositories.ts";

/** The largest bundle a session's export hands the broker's push: the NAS path's cap (coding-git-transfer.ts). */
export const CODE_HOST_EXPORT_MAXIMUM_BYTES = 64 * 1024 ** 2;

/** Where a coding machine mounts its session's view of the company folder. */
const GUEST_COMPANY_ROOT = "/company";

/** The coding sessions' repositories on the folder path (F3 step 5g-6b). A session works in its own locked worktree
 * of its company's code area, `/company/code/<owner>/<name>/worktrees/<workerId>` (lower-case, `codeAreaPath`) on
 * branch `qorpera/coding/<workerId>`: the code host seeds the area from GitHub when the session's base is not in it yet
 * and adds the worktree, in one job. At publish the code host exports what the session's branch has beyond its base,
 * and the host's broker pushes that. The repository token never reaches the code host or the machine. */
export class CodeHostRepositories implements CodingFolderRepositories {
	readonly #jobs: Pick<CodeHostJobs, "attach" | "export">;

	constructor(jobs: Pick<CodeHostJobs, "attach" | "export">) {
		this.#jobs = jobs;
	}

	async prepare(session: CodingFolderRepositorySession, signal: AbortSignal): Promise<{ cwd: string }> {
		const value = codeHostSession(session);
		await this.#jobs.attach(value, codeAreaBroker(session), signal);
		return { cwd: `${GUEST_COMPANY_ROOT}/${codeAreaPath(value.repository)}/worktrees/${value.workerId}` };
	}

	/** The session's branch at `headSha` as a thin bundle over its base, or null when the branch is still at its base. */
	async export(session: CodingFolderRepositorySession, headSha: string, signal: AbortSignal): Promise<Buffer | null> {
		const exported = await this.#jobs.export(
			{ ...codeHostSession(session), headSha },
			{ maximumBytes: CODE_HOST_EXPORT_MAXIMUM_BYTES },
			signal,
		);
		// The push sends exactly the submitted commit, and objects only when there is something beyond the base.
		if (exported.headSha !== headSha || (exported.bundle === null) !== (headSha === session.baseSha))
			throw new Error("CODE_HOST_EXPORT_DIFFERS");
		return exported.bundle;
	}
}

function codeHostSession(session: CodingFolderRepositorySession): CodeHostSession {
	const { claim } = session;
	return {
		companyId: claim.profileId,
		environmentId: claim.environmentId,
		repository: claim.repository,
		workerId: claim.workerId,
		baseSha: session.baseSha,
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
