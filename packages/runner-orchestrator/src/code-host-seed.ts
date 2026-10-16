import { createReadStream } from "node:fs";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { type CloudCodingRepository, isUuid, parseCloudCodingRepository } from "@qorpera/contracts";
import {
	addCodeWorktree,
	type CodeAreaSeeded,
	type CodeHostJob,
	CodeHostJobFailure,
	CodeHostRefusal,
	type CodeWorktree,
	type CodeWorktreeAdded,
	codeAreaPath,
	inspectCodeArea,
	seedCodeArea,
} from "./code-host-jobs.ts";
import { type CodingBrokerGitRunner, runCodingBrokerGit } from "./coding-git.ts";
import { checkDirectory } from "./lxd-office-journal-files.ts";

/** The code area's seed from GitHub, and a session's attach (5e-4): the coding broker fetches the repository's base
 * branch on the executor's own disk, as for a coding machine's seed (`coding-git-seed.ts`), never in the code host.
 * The token reaches only the fetch's environment; the bundle holds no credential, remote or config. */

/** The broker's GitHub access for one repository. */
export interface CodeAreaBroker {
	/** The executor's private directory (0700, its own): each seed fetches into a fresh directory under it. */
	journalRoot: string;
	assertAuthorized(repository: CloudCodingRepository, signal: AbortSignal): Promise<void>;
	withRepositoryToken<T>(
		repository: CloudCodingRepository,
		use: (token: string) => Promise<T>,
		signal: AbortSignal,
	): Promise<T>;
	/** Tests only; production runs git in the broker's sandbox (`coding-git.ts`). */
	runGit?: CodingBrokerGitRunner;
}

export interface CodeAreaSeedRequest {
	repository: CloudCodingRepository;
	/** The session's base: the base branch must still reach it. */
	baseSha: string;
	/** The code area's base, or null before its first seed: the bundle leaves out what it reaches, when the base branch
	 * still reaches it. */
	have: string | null;
}
export interface CodeAreaSeedSource {
	/** The base branch's commit on GitHub now. */
	headSha: string;
	/** The bundle of exactly `refs/heads/<baseBranch>` at headSha, read once from the broker's disk. */
	bundle: AsyncIterable<Uint8Array>;
}

const SHA = /^[0-9a-f]{40}$/;

/** Fetch the base branch into a fresh bare repository, check it, and hand its bundle to `use`; the fetch is gone when
 * `use` ends. A base branch that no longer reaches the session's base is refused (`CODE_HOST_SEED_BASE_GONE`): the
 * session starts again from the base as it is now. */
export async function withCodeAreaSeed<T>(
	value: CodeAreaSeedRequest,
	broker: CodeAreaBroker,
	signal: AbortSignal,
	use: (seed: CodeAreaSeedSource) => Promise<T>,
): Promise<T> {
	if (
		!value ||
		typeof value !== "object" ||
		Object.keys(value).sort().join() !== "baseSha,have,repository" ||
		typeof value.baseSha !== "string" ||
		!SHA.test(value.baseSha) ||
		(value.have !== null && (typeof value.have !== "string" || !SHA.test(value.have)))
	)
		throw new Error("INVALID_CODE_HOST_JOB");
	const repository = parseCloudCodingRepository(value.repository),
		{ baseSha, have } = value;
	const authorize = async (): Promise<void> => {
		signal.throwIfAborted();
		try {
			await broker.assertAuthorized(repository, signal);
		} catch {
			signal.throwIfAborted();
			throw new CodeHostJobFailure("CODE_HOST_SEED_AUTHORITY_UNAVAILABLE");
		}
		signal.throwIfAborted();
	};
	await authorize();
	await checkDirectory(broker.journalRoot);
	const scratch = await mkdtemp(join(broker.journalRoot, ".code-seed-"));
	try {
		await checkDirectory(scratch);
		const cwd = join(scratch, "repo.git"),
			file = join(scratch, "seed.bundle");
		const remote = `https://github.com/${repository.owner}/${repository.name}.git`,
			base = `refs/heads/${repository.baseBranch}`;
		const env: Record<string, string> = {
			PATH: "/usr/bin:/bin",
			HOME: scratch,
			XDG_CONFIG_HOME: scratch,
			LANG: "C",
			LC_ALL: "C",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_SYSTEM: "/dev/null",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_TERMINAL_PROMPT: "0",
			GIT_ASKPASS: "/bin/false",
			GIT_NO_REPLACE_OBJECTS: "1",
			GIT_ALLOW_PROTOCOL: "https",
			GIT_OPTIONAL_LOCKS: "0",
		};
		const prefix = [
			"--no-replace-objects",
			...[
				"core.hooksPath=/dev/null",
				"credential.helper=",
				"credential.interactive=false",
				"http.followRedirects=false",
				"http.sslVerify=true",
				"protocol.allow=never",
				"protocol.https.allow=always",
				"submodule.recurse=false",
				"fetch.recurseSubmodules=false",
				"gc.auto=0",
				"maintenance.auto=false",
				"transfer.fsckObjects=true",
				"fetch.fsckObjects=true",
			].flatMap((config) => ["-c", config]),
		];
		const git = async (args: string[], network = false, directory = cwd): Promise<string> => {
			const invoke = async (token?: string): Promise<string> => {
				const environment = { ...env };
				if (token !== undefined) {
					if (!/^[A-Za-z0-9_]{20,512}$/.test(token))
						throw new CodeHostJobFailure("CODE_HOST_SEED_CREDENTIAL_UNAVAILABLE");
					environment.GIT_CONFIG_COUNT = "1";
					environment.GIT_CONFIG_KEY_0 = `http.${remote}.extraHeader`;
					environment.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
				}
				return (broker.runGit ?? runCodingBrokerGit)({
					cwd: directory,
					scratchRoot: scratch,
					network,
					args: [...prefix, ...args],
					env: environment,
					signal,
				});
			};
			await authorize();
			let output: string;
			try {
				output = network ? await broker.withRepositoryToken(repository, invoke, signal) : await invoke();
			} catch (error) {
				signal.throwIfAborted();
				if (error instanceof CodeHostJobFailure) throw error;
				throw new CodeHostJobFailure("CODE_HOST_SEED_UNCONFIRMED");
			}
			await authorize();
			return output;
		};
		await git(["init", "--bare", "--template=", cwd], false, scratch);
		await git(
			[
				"fetch",
				"--quiet",
				"--no-tags",
				"--no-recurse-submodules",
				"--no-write-fetch-head",
				remote,
				`${base}:${base}`,
			],
			true,
		);
		const headSha = (await git(["rev-parse", "--verify", `${base}^{commit}`])).trim();
		if (!SHA.test(headSha)) throw new CodeHostJobFailure("CODE_HOST_SEED_UNCONFIRMED");
		// A commit is here only when the base branch reaches it: the repository holds nothing but this fetch.
		const reached = async (commit: string) =>
			(await git(["rev-list", "--ignore-missing", "--no-walk", commit])) === `${commit}\n` &&
			(await git(["rev-list", "--count", commit, `^${headSha}`])) === "0\n";
		if (!(await reached(baseSha))) throw new CodeHostRefusal("CODE_HOST_SEED_BASE_GONE", [baseSha]);
		await git(["fsck", "--strict", "--no-reflogs", headSha]);
		const thin = have !== null && have !== headSha && (await reached(have));
		await git(["bundle", "create", "--quiet", file, base, ...(thin ? [`^${have}`] : [])]);
		const stat = await lstat(file);
		if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1)
			throw new CodeHostJobFailure("CODE_HOST_SEED_UNCONFIRMED");
		await authorize();
		const bundle = createReadStream(file);
		try {
			return await use({ headSha, bundle });
		} finally {
			bundle.destroy();
		}
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

export interface CodeSessionAttached {
	/** What the seed did, or null when the code area already held the session's base and main/ was at its own. */
	seeded: CodeAreaSeeded["state"] | null;
	/** `present`: the session's worktree was already there, as when a session attaches again. */
	state: CodeWorktreeAdded["state"];
	/** The session's branch. */
	headSha: string;
	/** Files the jobs found changed and put back. */
	restored: string[];
}

/** A coding session's worktree on the code area, in one code host job. The code area is seeded first when it does not
 * hold the session's base yet, or main/ is not at its base. A seed takes the base branch as GitHub has it now, never
 * the session's baseSha, so an older session never takes the code area's base back. A present worktree whose branch
 * is gone is refused (`CODE_HOST_WORKTREE_NO_BRANCH`). */
export async function attachCodeSession(
	job: CodeHostJob,
	value: CodeWorktree,
	broker: CodeAreaBroker,
): Promise<CodeSessionAttached> {
	if (
		!value ||
		typeof value !== "object" ||
		Object.keys(value).sort().join() !== "baseSha,repository,workerId" ||
		!isUuid(value.workerId) ||
		typeof value.baseSha !== "string" ||
		!SHA.test(value.baseSha)
	)
		throw new Error("INVALID_CODE_HOST_JOB");
	const repository = parseCloudCodingRepository(value.repository),
		{ workerId, baseSha } = value;
	const area = await inspectCodeArea(job, { repository, commit: baseSha });
	const seeded =
		area.ready && area.holds
			? null
			: await withCodeAreaSeed({ repository, baseSha, have: area.base }, broker, job.signal, (seed) =>
					seedCodeArea(job, { repository, baseSha: seed.headSha, bundle: seed.bundle }),
				);
	const added = await addCodeWorktree(job, { repository, workerId, baseSha });
	if (!added.headSha)
		throw new CodeHostRefusal("CODE_HOST_WORKTREE_NO_BRANCH", [`${codeAreaPath(repository)}/worktrees/${workerId}`]);
	return {
		seeded: seeded?.state ?? null,
		state: added.state,
		headSha: added.headSha,
		restored: [...area.restored, ...(seeded?.restored ?? []), ...added.restored],
	};
}
