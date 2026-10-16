import type { CloudCodingRepository } from "@qorpera/contracts";
import type { CodingSessionClaim } from "./coding-executor.ts";
import type { CodingBrokerGitRunner } from "./coding-git.ts";
import type { LxdCodingMachineBinding } from "./coding-machine.ts";

// Where a coding session's repository lives on the folder model (F3 step 5g-6a; the plan's "Repositories"). On the
// NAS model the executor seeds a checkout into the session's own volume and exports a bundle from it; on the folder
// model the repository is part of the company folder, and the session works in its own worktree there. This is the
// seam between the executor and that code (5g-6b): on each turn the executor calls `prepare` once the session's view is
// mounted and before its first command, and `export` when the turn finishes (after the machine's boundary has saved
// what the session wrote), and it pushes and publishes the bundle itself, as on the NAS model.

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
}

export interface CodingFolderRepositories {
	/** Makes the session's worktree ready and answers where its commands start, a path in the machine. The same call
	 * again answers the same: each turn calls it. */
	prepare(session: CodingFolderRepositorySession, signal: AbortSignal): Promise<{ cwd: string }>;
	/** The bundle of the session's work from its base to `headSha`, or null when there is none. It may reject with
	 * CODE_HOST_EXPORT_DIFFERS when the worktree's head is not `headSha`. */
	export(session: CodingFolderRepositorySession, headSha: string, signal: AbortSignal): Promise<Buffer | null>;
}

/** Where a session's commands start until 5g-6b: the company folder itself. */
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
