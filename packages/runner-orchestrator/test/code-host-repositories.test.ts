import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { CloudCodingRepository } from "@qorpera/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CODE_CHECKS_MAIN_MOVED,
	type CodeCheck,
	type CodeChecksRun,
	type CodeSiteRecipe,
	codeChecksFailedSummary,
	codeChecksGate,
	codeChecksNotRunSummary,
	codeChecksPassed,
	readCodeChecks,
} from "../src/code-checks.ts";
import {
	addCodeWorktree,
	type CodeCommitFile,
	type CodeHostCommand,
	type CodeHostGcBlock,
	type CodeHostJob,
	CodeHostJobFailure,
	CodeHostRefusal,
	CodeWorktreeNamesRefused,
	exportCodeBranch,
	landCodeBranch,
	retireCodeWorktrees,
	startCodeArea,
} from "../src/code-host-jobs.ts";
import {
	CODE_CHANGE_RECORD_MS,
	CODE_RESTORING,
	CodeHostRepositories,
	type CodeHostRepositoriesOptions,
} from "../src/code-host-repositories.ts";
import { attachCodeSession, type CodeAreaBroker } from "../src/code-host-seed.ts";
import type { CodeHostJobs } from "../src/code-host-views.ts";
import {
	CODE_CHECKS_DRILL,
	CODE_DRILL_WORDS,
	CODE_SITE_DRILL_FOLDER,
	type CodeSiteCollected,
	codeSiteRefusedSummary,
} from "../src/code-site.ts";
import {
	CodingLandConflict,
	CodingLandRefused,
	type CodingSessionClaim,
	CodingWorkspaceFailed,
} from "../src/coding-executor.ts";
import type {
	CodeChangeReport,
	CodeChecksSwitched,
	CodingFolderRepositorySession,
} from "../src/coding-folder-repositories.ts";
import { type CodingBrokerGitCommand, createCodingBrokerGitRunner, pushCloudCodingBundle } from "../src/coding-git.ts";
import type { LxdCodingMachineBinding } from "../src/coding-machine.ts";
import { localShell } from "./helpers/code-host-shell.ts";

// The real steps, watched: a test reads the broker and the cap the adapter gave them.
vi.mock("../src/code-host-seed.ts", async (original) => {
	const real = await original<typeof import("../src/code-host-seed.ts")>();
	return { ...real, attachCodeSession: vi.fn(real.attachCodeSession) };
});
vi.mock("../src/code-host-jobs.ts", async (original) => {
	const real = await original<typeof import("../src/code-host-jobs.ts")>();
	return {
		...real,
		addCodeWorktree: vi.fn(real.addCodeWorktree),
		exportCodeBranch: vi.fn(real.exportCodeBranch),
		landCodeBranch: vi.fn(real.landCodeBranch),
		startCodeArea: vi.fn(real.startCodeArea),
	};
});
// The checks file's reader, the gate and the words (part C1), watched: each test says what they answer.
vi.mock("../src/code-checks.ts", async (original) => {
	const real = await original<typeof import("../src/code-checks.ts")>();
	return {
		...real,
		readCodeChecks: vi.fn(real.readCodeChecks),
		codeChecksGate: vi.fn(real.codeChecksGate),
		codeChecksPassed: vi.fn(real.codeChecksPassed),
		codeChecksFailedSummary: vi.fn(real.codeChecksFailedSummary),
		codeChecksNotRunSummary: vi.fn(real.codeChecksNotRunSummary),
	};
});

const exec = promisify(execFile),
	roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const COMPANY = "11111111-1111-4111-8111-111111111111";
const ENVIRONMENT = "33333333-3333-4333-8333-333333333333";
const GIT = "/usr/bin/git";
const TOKEN = "github_pat_fixture_token_1234567890";
const GITHUB = "https://github.com/qorpera/example.git";
const REPOSITORY: CloudCodingRepository = { host: "github.com", owner: "qorpera", name: "example", baseBranch: "main" };
const signal = () => new AbortController().signal;
const exists = (path: string) =>
	lstat(path).then(
		() => true,
		() => false,
	);

/** GitHub is a local bare repository, `remote`: the broker's network git reaches it over file://, and its other git
 * runs as in production (in the broker's sandbox on Linux). The company's code host is a folder and a scratch disk
 * here, its commands local processes; its jobs wait for `hold`, and only a job that ends publishes. */
async function fixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "code-host-repositories-test-")));
	roots.push(root);
	const source = join(root, "source"),
		remote = join(root, "remote.git"),
		journalRoot = join(root, "journal"),
		companyRoot = join(root, "folder"),
		scratchRoot = join(root, "scratch");
	for (const directory of [source, companyRoot, scratchRoot]) await mkdir(directory);
	await mkdir(journalRoot, { mode: 0o700 });
	const env = {
		PATH: "/usr/bin:/bin",
		HOME: root,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_AUTHOR_NAME: "Test",
		GIT_AUTHOR_EMAIL: "test@example.invalid",
		GIT_COMMITTER_NAME: "Test",
		GIT_COMMITTER_EMAIL: "test@example.invalid",
	};
	const git = async (cwd: string, ...args: string[]) => (await exec(GIT, args, { cwd, env })).stdout.trim();
	const commit = async (cwd: string, file: string) => {
		await writeFile(join(cwd, file), `${file}\n`);
		await git(cwd, "add", file);
		await git(cwd, "commit", "--quiet", "-m", file);
		return git(cwd, "rev-parse", "HEAD");
	};
	await git(source, "init", "--quiet", "--template=", "--initial-branch=main", ".");
	const baseSha = await commit(source, "README.md");
	await git(root, "init", "--quiet", "--bare", "--template=", remote);
	await git(source, "push", "--quiet", remote, "main");
	/** GitHub's main moves on. */
	const upstream = async (file: string) => {
		const head = await commit(source, file);
		await git(source, "push", "--quiet", remote, "main");
		return head;
	};

	const calls: CodingBrokerGitCommand[] = [];
	const runGit = async (command: CodingBrokerGitCommand): Promise<string> => {
		calls.push(command);
		if (command.network)
			return (
				await exec(
					GIT,
					[...command.args].map((arg) => (arg.toLowerCase() === GITHUB ? `file://${remote}` : arg)),
					{ cwd: command.cwd, env: { ...command.env, GIT_ALLOW_PROTOCOL: "file" }, signal: command.signal },
				)
			).stdout;
		if (process.platform === "linux")
			return createCodingBrokerGitRunner({ bubblewrapPath: process.env.QORPERA_TEST_BWRAP })(command);
		return (await exec(GIT, [...command.args], { cwd: command.cwd, env: command.env, signal: command.signal }))
			.stdout;
	};

	// What the session's jobs did, in order: each turn, authority check, code host command and publish.
	const events: string[] = [];
	let refuseAfter = Number.POSITIVE_INFINITY;
	const authorized = vi.fn(async (_signal: AbortSignal) => {
		if (refuseAfter <= 0) {
			events.push("refused");
			throw new Error("CODING_SESSION_REVOKED");
		}
		refuseAfter -= 1;
		events.push("authorized");
	});
	const lent = vi.fn();
	const workerId = randomUUID();
	const claim: CodingSessionClaim = {
		workerId,
		leaseToken: "lease-token",
		leaseUntil: "2026-10-16T12:00:00.000Z",
		sequence: 1,
		profileId: COMPANY,
		environmentId: ENVIRONMENT,
		agentId: "55555555-5555-4555-8555-555555555555",
		ownerUserId: "66666666-6666-4666-8666-666666666666",
		harness: "claude-code",
		model: null,
		repository: REPOSITORY,
		branch: `qorpera/coding/${workerId}`,
		baseSha,
		harnessSessionRef: null,
		pullRequest: null,
		title: "Fix the build",
		goal: "The build passes.",
		definitionOfDone: "CI is green.",
		context: "",
		followUp: null,
	};
	const session: CodingFolderRepositorySession = {
		claim,
		machine: { machineId: "machine" } as LxdCodingMachineBinding,
		uid: 1000,
		baseSha,
		journalRoot,
		assertAuthorized: authorized,
		async withRepositoryToken(repository, use) {
			lent(repository);
			return await use(TOKEN);
		},
		runGit,
	};

	const runs: [string, string, AbortSignal][] = [];
	let hold: Promise<void> = Promise.resolve();
	/** What the next job's save fails with, once its steps are done. */
	let saveFailure: Error | undefined;
	const commands: CodeHostCommand[] = [];
	const shell = localShell(commands);
	const unused = async (): Promise<never> => {
		throw new Error("CODE_HOST_GC_UNUSED");
	};
	const gc: CodeHostGcBlock = { begin: unused, end: unused };
	const jobs: Pick<CodeHostJobs, "run"> = {
		async run(companyId, environmentId, given, job) {
			runs.push([companyId, environmentId, given]);
			await hold;
			events.push("turn");
			const result = await job(
				{
					shell: {
						run: (command, checked) => {
							events.push("command");
							return shell.run(command, checked);
						},
					},
					layout: { companyRoot, scratchRoot, git: GIT },
					signal: given,
				},
				gc,
			);
			if (saveFailure) {
				const failure = saveFailure;
				saveFailure = undefined;
				throw failure;
			}
			events.push("publish");
			return result;
		},
	};
	const code = join(companyRoot, "code/qorpera/example");
	return {
		root,
		remote,
		journalRoot,
		companyRoot,
		tree: join(code, "worktrees", workerId),
		git,
		commit,
		upstream,
		baseSha,
		workerId,
		calls,
		runGit,
		events,
		runs,
		authorized,
		lent,
		session,
		jobs,
		repositories: new CodeHostRepositories(jobs),
		hold: (until: Promise<void>) => {
			hold = until;
		},
		failSave: (failure: Error) => {
			saveFailure = failure;
		},
		refuseAfter: (checks: number) => {
			refuseAfter = checks;
		},
	};
}

/** A turn that comes only when the test gives it. */
function held() {
	let give!: () => void;
	const turn = new Promise<void>((resolve) => {
		give = resolve;
	});
	return { turn, give };
}

describe("CodeHostRepositories", () => {
	it("a repository kept in Qorpera: starts it, adds the worktree and lands, with no GitHub and no token", async () => {
		const f = await fixture();
		const kept: CloudCodingRepository = { host: "qorpera", owner: "qorpera", name: "example", baseBranch: "main" };
		const claim = { ...f.session.claim, repository: kept, baseSha: null };
		const { baseSha } = await f.repositories.start({ claim, assertAuthorized: f.authorized }, signal());
		const session = { ...f.session, claim, baseSha };
		expect(await f.repositories.prepare(session, signal())).toEqual({
			cwd: `/company/code/qorpera/example/worktrees/${f.workerId}`,
		});
		const head = await f.commit(f.tree, "cart.js");
		// The session's host records no changes here: the landing says how many files it changed, and names no change.
		expect(await f.repositories.land(session, head, signal())).toEqual({
			state: "fast-forward",
			mainSha: head,
			filesChanged: 1,
			change: null,
		});
		expect(f.calls).toEqual([]);
		expect(f.lent).not.toHaveBeenCalled();
		expect(vi.mocked(attachCodeSession)).not.toHaveBeenCalled();
		// A start of a GitHub repository, or a landing in one, is not this repository's.
		await expect(
			f.repositories.start({ claim: f.session.claim, assertAuthorized: f.authorized }, signal()),
		).rejects.toThrow("CODE_HOST_REPOSITORY_NOT_HERE");
		await expect(f.repositories.land(f.session, head, signal())).rejects.toThrow("CODE_HOST_REPOSITORY_NOT_HERE");
	});
	it("a follow-up after nightly care retired the session's worktree gets it back from its branch, with the same head and files", async () => {
		const f = await fixture();
		const kept: CloudCodingRepository = { host: "qorpera", owner: "qorpera", name: "example", baseBranch: "main" };
		const claim = { ...f.session.claim, repository: kept, baseSha: null };
		const { baseSha } = await f.repositories.start({ claim, assertAuthorized: f.authorized }, signal());
		const session = { ...f.session, claim, baseSha },
			cwd = `/company/code/qorpera/example/worktrees/${f.workerId}`,
			admin = join(f.companyRoot, "code/qorpera/example/repo.git/worktrees", f.workerId);
		await f.repositories.prepare(session, signal());
		const landed = await f.commit(f.tree, "cart.js");
		await f.repositories.land(session, landed, signal());
		// Work the session committed after its landing is on its branch only.
		const head = await f.commit(f.tree, "more.js");
		// Care's jobs, as its loop runs them: on the company's code host, between the session's turns.
		const care: CodeHostJob = {
			shell: localShell([]),
			layout: { companyRoot: f.companyRoot, scratchRoot: join(f.root, "scratch"), git: GIT },
			signal: signal(),
		};
		const retire = (phase: "files" | "git-folder") =>
			retireCodeWorktrees(care, { repository: kept, workerIds: [f.workerId] }, { phase });
		const back = async () => {
			await expect(f.repositories.prepare(session, signal())).resolves.toEqual({ cwd });
			expect(await f.git(f.tree, "rev-parse", "HEAD")).toBe(head);
			expect(await f.git(f.tree, "symbolic-ref", "HEAD")).toBe(`refs/heads/qorpera/coding/${f.workerId}`);
			expect(await f.git(f.tree, "status", "--porcelain", "--ignored")).toBe("");
			expect((await readdir(f.tree)).sort()).toEqual([".git", "cart.js", "more.js"]);
			expect(await readFile(join(f.tree, "more.js"), "utf8")).toBe("more.js\n");
		};
		// A follow-up between care's two jobs: the files are gone and git's folder for the worktree is left.
		expect(await retire("files")).toEqual({ retired: [f.workerId], kept: [] });
		expect(await exists(f.tree)).toBe(false);
		expect(await exists(admin)).toBe(true);
		await back();
		// And one after both.
		expect(await retire("files")).toEqual({ retired: [f.workerId], kept: [] });
		expect(await retire("git-folder")).toEqual({ retired: [f.workerId], kept: [] });
		expect(await exists(f.tree)).toBe(false);
		expect(await exists(admin)).toBe(false);
		await back();
		// The session works on and lands, as before it was retired.
		const next = await f.commit(f.tree, "last.js");
		expect(await f.repositories.land(session, next, signal())).toEqual({
			state: "fast-forward",
			mainSha: next,
			filesChanged: 2,
			change: null,
		});
		expect(f.calls).toEqual([]);
		expect(f.lent).not.toHaveBeenCalled();
	});
	it("a landing the code host refuses by rule says what to change, never to finish again as it is", async () => {
		const f = await fixture();
		const kept: CloudCodingRepository = { host: "qorpera", owner: "qorpera", name: "example", baseBranch: "main" };
		const claim = { ...f.session.claim, repository: kept, baseSha: null };
		const { baseSha } = await f.repositories.start({ claim, assertAuthorized: f.authorized }, signal());
		const session = { ...f.session, claim, baseSha };
		await f.repositories.prepare(session, signal());
		// A commit the session's branch does not hold.
		const elsewhere = await f.repositories.land(session, "f".repeat(40), signal()).catch((e) => e);
		expect(elsewhere).toBeInstanceOf(CodingLandRefused);
		expect(elsewhere.message).toBe("CODE_HOST_EXPORT_MOVED");
		expect(elsewhere.summary).toBe(
			"The change was not landed, and nothing changed on main: the commit handed in is not on this session's own branch. Commit the work on the branch the session's workspace has checked out, and finish with that commit.",
		);
		// Two names in one folder that differ only by case: main's files could not hold both.
		await f.commit(f.tree, "cart.js");
		const head = await f.commit(f.tree, "Cart.js");
		const names = await f.repositories.land(session, head, signal()).catch((e) => e);
		expect(names).toBeInstanceOf(CodingLandRefused);
		expect(names.message).toBe("CODE_HOST_NAMES_DIFFER_BY_CASE");
		expect(names.cause).toBeInstanceOf(CodeHostRefusal);
		expect(names.summary).toMatch(
			/^The change was not landed, and nothing changed on main: it holds names in one folder that differ only by upper and lower case: .*"Cart\.js".*Rename them so that each is its own name, commit and finish again\. \[code=CODING_LAND_NAMES_REFUSED\]$/,
		);
		expect(names.summary).toContain('"cart.js"');
		// Nothing landed: main is where the start left it.
		const repo = join(f.companyRoot, "code/qorpera/example/repo.git");
		expect(await f.git(repo, "rev-parse", "refs/heads/main")).toBe(baseSha);
		// Refs git cannot read (a packed-refs file that is not git's) fail a command, not a rule: they have words too,
		// and never a plain "finishing again hands it in".
		await writeFile(join(repo, "packed-refs"), "not a packed-refs file\n");
		const unread = await f.repositories.land(session, head, signal()).catch((e) => e);
		expect(unread).toBeInstanceOf(CodingLandRefused);
		expect(unread.message).toBe("CODE_HOST_REF_UNREADABLE");
		expect(unread.cause).toBeInstanceOf(CodeHostJobFailure);
		expect(unread.summary).toBe(
			"The change was not landed, and nothing changed on main: the repository's own record of its branches could not be read. Finish again once; if that fails the same way, nothing can go into main until Qorpera has repaired the repository, so say so in your report. The work is kept on the session's branch.",
		);
	});
	it("a landing with names the company folder does not take says to rename them, naming each as the import's look shows a path", async () => {
		const f = await fixture();
		const kept: CloudCodingRepository = { host: "qorpera", owner: "qorpera", name: "example", baseBranch: "main" };
		const claim = { ...f.session.claim, repository: kept, baseSha: null };
		const { baseSha } = await f.repositories.start({ claim, assertAuthorized: f.authorized }, signal());
		const session = { ...f.session, claim, baseSha };
		await f.repositories.prepare(session, signal());
		// Committed as git takes them, a name too long for a disk too; one looks like a key.
		const blob = await f.git(f.tree, "rev-parse", `${await f.commit(f.tree, "ok.txt")}:ok.txt`);
		for (const path of ["bad.", "x /file", "a/b/c./d.txt", "a\\b.txt", "n".repeat(256), "AKIAQORPERATESTKEY01."])
			await f.git(f.tree, "update-index", "--add", "--cacheinfo", `100644,${blob},${path}`);
		await f.git(f.tree, "commit", "--quiet", "-m", "names");
		const head = await f.git(f.tree, "rev-parse", "HEAD");
		const refused = await f.repositories.land(session, head, signal()).catch((e) => e);
		expect(refused).toBeInstanceOf(CodingLandRefused);
		expect(refused.message).toBe("CODE_HOST_NAMES_FOLDER_REFUSES");
		expect(refused.cause).toMatchObject({
			paths: ["AKIAQORPERATESTKEY01.", "a/b/c.", "a\\b.txt", "bad.", "n".repeat(256), "x "],
		});
		// The 256-byte name (over 200 bytes) and the key are counted, never named.
		expect(refused.summary).toBe(
			'The change was not landed, and nothing changed on main: it holds file or folder names the company folder does not take (one that ends in a dot or a space, holds a backslash or a control character, or is longer than 255 bytes, or a path longer than 4,096 bytes where a session\'s workspace holds it): "a/b/c.", "a\\\\b.txt", "bad.", "x " and 2 more. Rename them, commit and finish again. [code=CODING_LAND_NAMES_REFUSED]',
		);
		const repo = join(f.companyRoot, "code/qorpera/example/repo.git");
		expect(await f.git(repo, "rev-parse", "refs/heads/main")).toBe(baseSha);
		expect(await readdir(join(f.companyRoot, "code/qorpera/example/main"))).toEqual([".git"]);
	});
	it("a landing that lost main to another one is made once more, and no more than that", async () => {
		const f = await fixture();
		const kept: CloudCodingRepository = { host: "qorpera", owner: "qorpera", name: "example", baseBranch: "main" };
		const claim = { ...f.session.claim, repository: kept, baseSha: null };
		const { baseSha } = await f.repositories.start({ claim, assertAuthorized: f.authorized }, signal());
		const session = { ...f.session, claim, baseSha };
		await f.repositories.prepare(session, signal());
		const head = await f.commit(f.tree, "cart.js");
		const moved = () => new CodeHostJobFailure("CODE_HOST_BASE_MOVED", "main moved");
		vi.mocked(landCodeBranch).mockClear();
		vi.mocked(landCodeBranch).mockRejectedValueOnce(moved()).mockRejectedValueOnce(moved());
		await expect(f.repositories.land(session, head, signal())).rejects.toThrow("CODE_HOST_BASE_MOVED");
		expect(vi.mocked(landCodeBranch)).toHaveBeenCalledTimes(2);
		vi.mocked(landCodeBranch).mockClear();
		vi.mocked(landCodeBranch).mockRejectedValueOnce(moved());
		expect(await f.repositories.land(session, head, signal())).toEqual({
			state: "fast-forward",
			mainSha: head,
			filesChanged: 1,
			change: null,
		});
		expect(vi.mocked(landCodeBranch)).toHaveBeenCalledTimes(2);
	});
	it("a start where a GitHub copy is fails the turn, saying the place is taken", async () => {
		const f = await fixture();
		const kept: CloudCodingRepository = { host: "qorpera", owner: "qorpera", name: "example", baseBranch: "main" };
		// The GitHub repository at the same place is seeded first: a start there fails the turn, saying so.
		await f.repositories.prepare(f.session, signal());
		const claim = { ...f.session.claim, repository: kept, baseSha: null };
		const refused = await f.repositories.start({ claim, assertAuthorized: f.authorized }, signal()).catch((e) => e);
		expect(refused).toBeInstanceOf(CodingWorkspaceFailed);
		expect(refused.message).toBe("CODE_HOST_AREA_FROM_GITHUB");
		expect(refused.summary).toMatch(
			/already holds a copy of a GitHub repository.+\[code=CODE_HOST_AREA_FROM_GITHUB\]$/,
		);
	});
	it("seeds the company's code area from GitHub and adds the session's worktree in one job, and gives the machine its path", async () => {
		const f = await fixture(),
			given = signal(),
			cwd = `/company/code/qorpera/example/worktrees/${f.workerId}`;
		await expect(f.repositories.prepare(f.session, given)).resolves.toEqual({ cwd });
		expect(f.runs).toEqual([[COMPANY, ENVIRONMENT, given]]);
		expect(f.runs[0]?.[2]).toBe(given);
		for (const [checked] of f.authorized.mock.calls) expect(checked).toBe(given);
		expect(await f.git(f.tree, "rev-parse", "HEAD")).toBe(f.baseSha);
		expect(await f.git(f.tree, "symbolic-ref", "HEAD")).toBe(`refs/heads/qorpera/coding/${f.workerId}`);
		expect(f.calls.filter((call) => call.network)).toHaveLength(1);
		expect(f.lent).toHaveBeenCalledTimes(1);
		expect(f.lent).toHaveBeenCalledWith(REPOSITORY);
		// A later turn attaches again: the same path, and nothing fetched.
		await expect(f.repositories.prepare(f.session, signal())).resolves.toEqual({ cwd });
		expect(f.calls.filter((call) => call.network)).toHaveLength(1);
		expect(f.lent).toHaveBeenCalledTimes(1);
	});

	it("gives every spelling of a repository the one lower-case code area, and GitHub the claimed spelling", async () => {
		const f = await fixture();
		const repository = { ...REPOSITORY, owner: "Qorpera", name: "Example" };
		const spelled = { ...f.session, claim: { ...f.session.claim, repository } };
		await expect(f.repositories.prepare(spelled, signal())).resolves.toEqual({
			cwd: `/company/code/qorpera/example/worktrees/${f.workerId}`,
		});
		expect(f.lent).toHaveBeenCalledWith(repository);
		expect(f.calls.find((call) => call.network)?.args).toContain("https://github.com/Qorpera/Example.git");
		const broker = vi.mocked(attachCodeSession).mock.calls.at(-1)?.[2] as CodeAreaBroker;
		await expect(broker.withRepositoryToken(REPOSITORY, async () => undefined, signal())).rejects.toThrow(
			"CODE_HOST_REPOSITORY_DIFFERS",
		);
	});

	it("lends the broker the session's authority and token for the claimed repository only", async () => {
		const f = await fixture();
		await f.repositories.prepare(f.session, signal());
		const broker = vi.mocked(attachCodeSession).mock.calls.at(-1)?.[2] as CodeAreaBroker;
		expect(broker.journalRoot).toBe(f.journalRoot);
		expect(broker.runGit).toBe(f.runGit);
		f.authorized.mockClear();
		f.lent.mockClear();
		const checked = signal();
		await broker.assertAuthorized({ ...REPOSITORY }, checked);
		expect(f.authorized).toHaveBeenCalledTimes(1);
		expect(f.authorized.mock.calls[0]?.[0]).toBe(checked);
		await expect(
			broker.withRepositoryToken({ ...REPOSITORY }, async (token) => `used ${token}`, signal()),
		).resolves.toBe(`used ${TOKEN}`);
		expect(f.lent).toHaveBeenCalledWith(REPOSITORY);
		for (const other of [
			{ ...REPOSITORY, owner: "other" },
			{ ...REPOSITORY, name: "other" },
			{ ...REPOSITORY, baseBranch: "release" },
		]) {
			await expect(broker.assertAuthorized(other, signal())).rejects.toThrow("CODE_HOST_REPOSITORY_DIFFERS");
			await expect(broker.withRepositoryToken(other, async () => "used", signal())).rejects.toThrow(
				"CODE_HOST_REPOSITORY_DIFFERS",
			);
		}
		expect(f.authorized).toHaveBeenCalledTimes(1);
		expect(f.lent).toHaveBeenCalledTimes(1);
	});

	it("fails the turn with the code host's own code when its job fails a step or is refused, keeping what it said (C8 C4-1)", async () => {
		const f = await fixture();
		const summary = (code: string) =>
			`Making the session's copy of the code failed. The workspace is kept; a follow-up tries again. [code=${code}]`;
		// As the job of 26 Oct 2026 06:53:43Z may have ended: git's worktree add failed while it wrote the worktree.
		const failure = new CodeHostJobFailure(
			"CODE_HOST_WORKTREE_FAILED",
			"fatal: could not create work tree dir '/company/code/qorpera/example/worktrees/x': Input/output error",
		);
		const refusal = new CodeHostRefusal("CODE_HOST_WORKTREE_INCOMPLETE", ["code/qorpera/example/worktrees/x"]);
		for (const error of [failure, refusal]) {
			vi.mocked(attachCodeSession).mockRejectedValueOnce(error);
			const failed = await f.repositories.prepare(f.session, signal()).catch((caught: unknown) => caught);
			expect(failed).toBeInstanceOf(CodingWorkspaceFailed);
			expect(failed).toMatchObject({ message: error.code, summary: summary(error.code), cause: error });
		}
		// Anything else, and a job whose caller gave up, fail as they are.
		const other = new Error("CODING_HOST_MACHINE_REFUSED:MACHINE_REMOVING");
		vi.mocked(attachCodeSession).mockRejectedValueOnce(other);
		await expect(f.repositories.prepare(f.session, signal())).rejects.toBe(other);
		const gaveUp = new AbortController();
		vi.mocked(attachCodeSession).mockImplementationOnce(async () => {
			gaveUp.abort();
			throw failure;
		});
		await expect(f.repositories.prepare(f.session, gaveUp.signal)).rejects.toBe(failure);
		// The next attach makes the worktree.
		await expect(f.repositories.prepare(f.session, signal())).resolves.toEqual({
			cwd: `/company/code/qorpera/example/worktrees/${f.workerId}`,
		});
	});

	it("a follow-up whose branch holds names the company folder does not take says a follow-up will not help and how a new session carries the work, having written nothing (item 5)", async () => {
		const f = await fixture();
		const kept: CloudCodingRepository = { host: "qorpera", owner: "qorpera", name: "example", baseBranch: "main" };
		const claim = { ...f.session.claim, repository: kept, baseSha: null };
		const { baseSha } = await f.repositories.start({ claim, assertAuthorized: f.authorized }, signal());
		const session = { ...f.session, claim, baseSha },
			admin = join(f.companyRoot, "code/qorpera/example/repo.git/worktrees", f.workerId),
			branch = `qorpera/coding/${f.workerId}`;
		await f.repositories.prepare(session, signal());
		// The session's branch gets names as git takes them (by plumbing, or a merge of a line of work that held them), a
		// name too long for a disk among them, and one that looks like a key; then its worktree's files go.
		const blob = await f.git(f.tree, "rev-parse", `${await f.commit(f.tree, "ok.txt")}:ok.txt`);
		for (const path of ["bad.", "x /file", "n".repeat(256), "AKIAQORPERATESTKEY01."])
			await f.git(f.tree, "update-index", "--add", "--cacheinfo", `100644,${blob},${path}`);
		await f.git(f.tree, "commit", "--quiet", "-m", "names");
		const head = await f.git(f.tree, "rev-parse", "HEAD");
		await rm(f.tree, { recursive: true });
		const left = (await readdir(admin)).sort();
		const failed = await f.repositories.prepare(session, signal()).catch((caught: unknown) => caught);
		expect(failed).toBeInstanceOf(CodingWorkspaceFailed);
		expect(failed).toMatchObject({ message: "CODE_HOST_NAMES_FOLDER_REFUSES" });
		expect((failed as CodingWorkspaceFailed).cause).toBeInstanceOf(CodeWorktreeNamesRefused);
		expect((failed as CodingWorkspaceFailed).cause).toMatchObject({
			code: "CODE_HOST_NAMES_FOLDER_REFUSES",
			paths: ["AKIAQORPERATESTKEY01.", "bad.", "n".repeat(256), "x "],
			of: "branch",
		});
		// The 256-byte name (over 200 bytes) and the key are counted, never named.
		expect((failed as CodingWorkspaceFailed).summary).toBe(
			`The session's workspace could not be made again: its branch holds file or folder names the company folder does not take ("bad.", "x " and 2 more), so a follow-up will not help. Archive this session with manage_worker, action archive, and start a new one on the repository: the work stays on branch ${branch}, where the new session reads each file with git show ${branch}:<path> and saves it under a name the folder takes. [code=CODE_HOST_NAMES_FOLDER_REFUSES]`,
		);
		expect((failed as CodingWorkspaceFailed).summary).not.toContain("tries again");
		// Nothing written: no worktree, git's folder for it as it was, and the work on the branch.
		expect(await exists(f.tree)).toBe(false);
		expect((await readdir(admin)).sort()).toEqual(left);
		const repo = join(f.companyRoot, "code/qorpera/example/repo.git");
		expect(await f.git(repo, "rev-parse", `refs/heads/${branch}`)).toBe(head);
		expect(await f.git(repo, "show", `${branch}:bad.`)).toBe("ok.txt");
		// And the same at every follow-up.
		await expect(f.repositories.prepare(session, signal())).rejects.toMatchObject({
			message: "CODE_HOST_NAMES_FOLDER_REFUSES",
		});
	});

	it("a session whose GitHub base branch holds names the company folder does not take says a member must rename them on GitHub (item 6)", async () => {
		const f = await fixture();
		const head = await f.upstream("bad.");
		const session = { ...f.session, baseSha: head, claim: { ...f.session.claim, baseSha: head } };
		const failed = await f.repositories.prepare(session, signal()).catch((caught: unknown) => caught);
		expect(failed).toBeInstanceOf(CodingWorkspaceFailed);
		expect(failed).toMatchObject({ message: "CODE_HOST_NAMES_FOLDER_REFUSES" });
		expect((failed as CodingWorkspaceFailed).cause).toMatchObject({ paths: ["bad."] });
		expect((failed as CodingWorkspaceFailed).cause).not.toBeInstanceOf(CodeWorktreeNamesRefused);
		expect((failed as CodingWorkspaceFailed).summary).toBe(
			`GitHub's main of qorpera/example holds file or folder names the company folder does not take ("bad."), so no coding session can open it here and a follow-up will not help. A member must rename them on GitHub first. [code=CODE_HOST_NAMES_FOLDER_REFUSES]`,
		);
		expect(await exists(join(f.companyRoot, "code/qorpera/example/repo.git"))).toBe(false);
		expect(await exists(f.tree)).toBe(false);
	});

	it("says in words of their own what every names refusal and a file too large ask, and keeps a follow-up's try for every other failure", async () => {
		const f = await fixture();
		const kept: CloudCodingRepository = { host: "qorpera", owner: "qorpera", name: "Example", baseBranch: "main" };
		const own = { ...f.session, claim: { ...f.session.claim, repository: kept } };
		const github = {
			...f.session,
			claim: { ...f.session.claim, repository: { ...REPOSITORY, owner: "Qorpera", name: "Example" } },
		};
		const branch = `qorpera/coding/${f.workerId}`;
		const words = async (session: CodingFolderRepositorySession, error: Error) => {
			if (session.claim.repository.host === "qorpera") vi.mocked(addCodeWorktree).mockRejectedValueOnce(error);
			else vi.mocked(attachCodeSession).mockRejectedValueOnce(error);
			const failed = await f.repositories.prepare(session, signal()).catch((caught: unknown) => caught);
			expect(failed).toBeInstanceOf(CodingWorkspaceFailed);
			expect((failed as CodingWorkspaceFailed).cause).toBe(error);
			return (failed as CodingWorkspaceFailed).summary;
		};
		const again = (held: string, then: string, code: string) =>
			`The session's workspace could not be made again: its branch holds ${held}, so a follow-up will not help. Archive this session with manage_worker, action archive, and start a new one on the repository: the work stays on branch ${branch}, where the new session reads each file with git show ${branch}:<path> and ${then}. [code=${code}]`;
		const onGitHub = (held: string, fix: string, code: string) =>
			`GitHub's main of Qorpera/Example holds ${held}, so no coding session can open it here and a follow-up will not help. A member must ${fix} on GitHub first. [code=${code}]`;
		const renamed = "saves it under a name the folder takes";
		for (const session of [own, github]) {
			// The session's own branch, on either host.
			expect(
				await words(session, new CodeWorktreeNamesRefused("CODE_HOST_FILE_TOO_LARGE", ["big.bin"], "branch")),
			).toBe(
				again(
					'files larger than 256 MiB, which Qorpera does not take ("big.bin")',
					"leaves the files over 256 MiB out",
					"CODE_HOST_FILE_TOO_LARGE",
				),
			);
			expect(
				await words(
					session,
					new CodeWorktreeNamesRefused("CODE_HOST_NAMES_DIFFER_BY_CASE", ["Cart.js", "cart.js"], "branch"),
				),
			).toBe(
				again(
					'names in one folder that differ only by upper and lower case ("Cart.js", "cart.js")',
					renamed,
					"CODE_HOST_NAMES_DIFFER_BY_CASE",
				),
			);
			for (const code of ["CODE_HOST_NAMES_NOT_UTF8", "CODE_HOST_NAMES_NOT_NFC"])
				expect(await words(session, new CodeWorktreeNamesRefused(code, ["café.txt"], "branch"))).toBe(
					again(
						'file names that are not plain Unicode text (UTF-8, in its composed form NFC) ("café.txt")',
						renamed,
						code,
					),
				);
		}
		// GitHub's base branch: the seed's refusal, or a new worktree's at GitHub's base.
		for (const error of [
			new CodeHostRefusal("CODE_HOST_FILE_TOO_LARGE", ["big.bin"]),
			new CodeWorktreeNamesRefused("CODE_HOST_FILE_TOO_LARGE", ["big.bin"], "base"),
		])
			expect(await words(github, error)).toBe(
				onGitHub(
					'files larger than 256 MiB, which Qorpera does not take ("big.bin")',
					"take them out",
					"CODE_HOST_FILE_TOO_LARGE",
				),
			);
		expect(await words(github, new CodeHostRefusal("CODE_HOST_NAMES_DIFFER_BY_CASE", ["A.ts", "a.ts"]))).toBe(
			onGitHub(
				'names in one folder that differ only by upper and lower case ("A.ts", "a.ts")',
				"rename them",
				"CODE_HOST_NAMES_DIFFER_BY_CASE",
			),
		);
		// Paths named as a landing's refusal names them: twenty at most, the rest counted; none shown, counted alone.
		const many = Array.from({ length: 25 }, (_, at) => `f${at}.`);
		expect(await words(github, new CodeHostRefusal("CODE_HOST_NAMES_FOLDER_REFUSES", many))).toBe(
			onGitHub(
				`file or folder names the company folder does not take (${many
					.slice(0, 20)
					.map((path) => `"${path}"`)
					.join(", ")} and 5 more)`,
				"rename them",
				"CODE_HOST_NAMES_FOLDER_REFUSES",
			),
		);
		expect(await words(github, new CodeHostRefusal("CODE_HOST_NAMES_FOLDER_REFUSES", ["n".repeat(256)]))).toContain(
			"names the company folder does not take (1 path not named here), so",
		);
		// A new worktree at the default branch of a repository kept in Qorpera: no session can open it.
		expect(
			await words(own, new CodeWorktreeNamesRefused("CODE_HOST_NAMES_FOLDER_REFUSES", ["deep/path"], "base")),
		).toBe(
			"The session's workspace could not be made: where a session's workspace holds them, main holds file or folder names the company folder does not take (\"deep/path\"), so no coding session can open this repository and a follow-up will not help. Say so in your report. [code=CODE_HOST_NAMES_FOLDER_REFUSES]",
		);
		// Every other refusal and failure: a follow-up tries again, as before.
		for (const error of [
			new CodeHostRefusal("CODE_HOST_SEED_HEADS", ["refs/heads/main"]),
			new CodeHostRefusal("CODE_HOST_LINK", ["code/qorpera"]),
			new CodeHostRefusal("CODE_HOST_WORKTREE_INCOMPLETE", ["code/qorpera/example/worktrees/x"]),
			new CodeHostJobFailure("CODE_HOST_NAMES_LISTING", "not a refusal"),
			new CodeHostJobFailure("CODE_HOST_TREE_UNREADABLE"),
		])
			for (const session of [own, github])
				expect(await words(session, error)).toBe(
					`Making the session's copy of the code failed. The workspace is kept; a follow-up tries again. [code=${error.code}]`,
				);
	});

	it("asks the session's authority once its job's turn comes and once its steps are done, before the job publishes", async () => {
		const f = await fixture();
		const job = async (step: () => Promise<unknown>) => {
			f.events.length = 0;
			await step();
			expect(f.events.slice(0, 2)).toEqual(["turn", "authorized"]);
			expect(f.events.slice(-2)).toEqual(["authorized", "publish"]);
			return f.events.slice(2, -2);
		};
		// The first attach seeds the area, and the seed asks the authority again around each git command of its own.
		expect(await job(() => f.repositories.prepare(f.session, signal()))).toContain("command");
		const head = await f.commit(f.tree, "work.txt");
		for (const step of [
			() => f.repositories.prepare(f.session, signal()),
			() => f.repositories.export(f.session, head, signal()),
		])
			expect(new Set(await job(step))).toEqual(new Set(["command"]));
	});

	it("writes and publishes nothing for a session whose authority ended while its job waited for its turn", async () => {
		const f = await fixture();
		const first = held();
		f.hold(first.turn);
		const prepared = f.repositories.prepare(f.session, signal());
		expect(f.runs).toHaveLength(1);
		expect(f.authorized).not.toHaveBeenCalled();
		f.refuseAfter(0);
		first.give();
		await expect(prepared).rejects.toThrow("CODING_SESSION_REVOKED");
		expect(f.events).toEqual(["turn", "refused"]);
		expect(await readdir(f.companyRoot)).toEqual([]);
		expect(f.calls).toEqual([]);
		expect(f.lent).not.toHaveBeenCalled();

		// An export the same: its turn comes after the authority ended, and nothing is read or bundled.
		f.refuseAfter(Number.POSITIVE_INFINITY);
		f.hold(Promise.resolve());
		await f.repositories.prepare(f.session, signal());
		const head = await f.commit(f.tree, "work.txt");
		const exports = vi.mocked(exportCodeBranch).mock.calls.length;
		const second = held();
		f.hold(second.turn);
		f.events.length = 0;
		const exported = f.repositories.export(f.session, head, signal());
		f.refuseAfter(0);
		second.give();
		await expect(exported).rejects.toThrow("CODING_SESSION_REVOKED");
		expect(f.events).toEqual(["turn", "refused"]);
		expect(vi.mocked(exportCodeBranch).mock.calls.length).toBe(exports);
	});

	it("publishes nothing when the session's authority ends while its job runs", async () => {
		const f = await fixture();
		await f.repositories.prepare(f.session, signal());
		const head = await f.commit(f.tree, "work.txt");
		for (const step of [
			() => f.repositories.prepare(f.session, signal()),
			() => f.repositories.export(f.session, head, signal()),
		]) {
			f.events.length = 0;
			f.refuseAfter(1);
			await expect(step()).rejects.toThrow("CODING_SESSION_REVOKED");
			expect(f.events.slice(0, 3)).toEqual(["turn", "authorized", "command"]);
			expect(f.events.at(-1)).toBe("refused");
			expect(f.events).not.toContain("publish");
		}
	});

	it("gives no worktree when the attach fails", async () => {
		const f = await fixture();
		// GitHub's main no longer reaches the session's base: the session starts again from the base as it is now.
		const gone = "c".repeat(40);
		const session = { ...f.session, baseSha: gone, claim: { ...f.session.claim, baseSha: gone } };
		// The turn fails at once with the code host's code (CodingWorkspaceFailed), the refusal its cause.
		await expect(f.repositories.prepare(session, signal())).rejects.toMatchObject({
			message: "CODE_HOST_SEED_BASE_GONE",
			cause: { code: "CODE_HOST_SEED_BASE_GONE" },
		});
		expect(await exists(f.tree)).toBe(false);
		expect(f.events).not.toContain("publish");
	});

	it("exports the submitted commit as a thin bundle over the session's base, under the NAS path's cap", async () => {
		const f = await fixture();
		await f.repositories.prepare(f.session, signal());
		await expect(f.repositories.export(f.session, f.baseSha, signal())).resolves.toBeNull();
		const head = await f.commit(f.tree, "work.txt");
		const bundle = await f.repositories.export(f.session, head, signal());
		expect(vi.mocked(exportCodeBranch).mock.calls.at(-1)?.slice(1)).toEqual([
			{ repository: REPOSITORY, workerId: f.workerId, baseSha: f.baseSha, headSha: head },
			{ maximumBytes: 64 * 1024 ** 2 },
		]);
		if (!bundle) throw new Error("no bundle");
		const file = join(f.root, "export.bundle");
		await writeFile(file, bundle);
		expect(await f.git(f.remote, "bundle", "list-heads", file)).toBe(
			`${head} refs/heads/qorpera/coding/${f.workerId}`,
		);
		expect(bundle.toString("latin1")).toContain(`\n-${f.baseSha}`);
	});

	it("refuses an export that is not exactly the submitted commit", async () => {
		const f = await fixture();
		const head = "b".repeat(40),
			other = "c".repeat(40);
		const cases: [string, { headSha: string; bundle: Buffer | null }][] = [
			[head, { headSha: other, bundle: Buffer.from("x") }],
			[head, { headSha: head, bundle: null }],
			[f.baseSha, { headSha: f.baseSha, bundle: Buffer.from("x") }],
		];
		for (const [headSha, answer] of cases) {
			vi.mocked(exportCodeBranch).mockResolvedValueOnce(answer);
			await expect(f.repositories.export(f.session, headSha, signal())).rejects.toThrow("CODE_HOST_EXPORT_DIFFERS");
		}
	});

	it("hands the broker's push a bundle it pushes as is: GitHub's branch is the submitted commit, and a follow-up's", async () => {
		const f = await fixture();
		await f.repositories.prepare(f.session, signal());
		const first = await f.commit(f.tree, "work.txt");
		// GitHub's main moved on after the session started: the push fetches the new tip it lacks.
		await f.upstream("upstream.txt");
		const branch = `qorpera/coding/${f.workerId}`,
			ref = `refs/heads/${branch}`;
		const push = async (headSha: string, expectedRemoteHeadSha: string | null) => {
			const bundle = await f.repositories.export(f.session, headSha, signal());
			if (!bundle) throw new Error("no bundle");
			return await pushCloudCodingBundle(
				{ repository: REPOSITORY, workerId: f.workerId, headSha, baseSha: f.baseSha, expectedRemoteHeadSha },
				bundle,
				{
					journalRoot: f.journalRoot,
					signal: signal(),
					assertAuthorized: (_input, checked) => f.session.assertAuthorized(checked),
					withRepositoryToken: f.session.withRepositoryToken,
					runGit: f.runGit,
				},
			);
		};
		expect(await push(first, null)).toEqual({ branch, headSha: first });
		expect(await f.git(f.root, "ls-remote", f.remote, ref)).toBe(`${first}\t${ref}`);
		const next = await f.commit(f.tree, "more.txt");
		expect(await push(next, first)).toEqual({ branch, headSha: next });
		expect(await f.git(f.root, "ls-remote", f.remote, ref)).toBe(`${next}\t${ref}`);
		expect(await f.git(f.remote, "show", `${ref}:more.txt`)).toBe("more.txt");
	});
});

describe("the change record of a landing (own code storage, step 2b)", () => {
	const KEPT: CloudCodingRepository = { host: "qorpera", owner: "qorpera", name: "example", baseBranch: "main" };
	const TARGET = { companyId: COMPANY, environmentId: ENVIRONMENT, owner: "qorpera", name: "example" };
	const SCHEMA = "qorpera.code-change-report/v2";

	/** A session on a repository kept in Qorpera, started and with its worktree, whose host records its landings, and
	 * the repositories with the record's files. `steps` is what happened in a landing, without the code host's
	 * commands. */
	async function kept(options: CodeHostRepositoriesOptions = {}) {
		const f = await fixture();
		const claim = { ...f.session.claim, repository: KEPT, baseSha: null };
		const { baseSha } = await f.repositories.start({ claim, assertAuthorized: f.authorized }, signal());
		const recordChange = vi.fn(
			async (_report: CodeChangeReport, _signal: AbortSignal): Promise<{ state: string; change: number | null }> => {
				f.events.push("report");
				return { state: "recorded", change: 7 };
			},
		);
		const session: CodingFolderRepositorySession = { ...f.session, claim, baseSha, recordChange };
		await f.repositories.prepare(session, signal());
		const confirm = vi.fn(async () => {
			f.events.push("confirm");
		});
		const inJob = vi.fn<NonNullable<CodeHostRepositoriesOptions["records"]>["inJob"]>(async () => {
			f.events.push("files");
			return confirm;
		});
		const logged: Record<string, unknown>[] = [];
		const repositories = new CodeHostRepositories(f.jobs, {
			records: { inJob },
			report: (event) => logged.push(event),
			...options,
		});
		let files = 0;
		return {
			f,
			session,
			baseSha,
			recordChange,
			confirm,
			inJob,
			logged,
			repositories,
			/** One more commit on the session's branch. */
			commit: () => f.commit(f.tree, `file-${++files}.js`),
			land: (headSha: string, picture?: { picture: string }) =>
				repositories.land(session, headSha, signal(), picture),
			steps: () => f.events.filter((event) => event !== "command"),
			reports: () => recordChange.mock.calls.map(([report]) => report),
			errors: () =>
				logged
					.filter((event) => event.event === "code-change-error")
					.map((event) => `${event.step}:${(event.error as Error).message}`),
		};
	}

	it("reports a landing inside its job, writes the record's files there and confirms them once the job has saved", async () => {
		const t = await kept();
		const head = await t.f.commit(t.f.tree, "cart.js");
		t.f.events.length = 0;
		expect(await t.land(head)).toEqual({ state: "fast-forward", mainSha: head, filesChanged: 1, change: 7 });
		// The report is made while the company's line is held, after main moved and before the job's save; then the
		// files; and the kernel is told of them only once the job has saved.
		expect(t.steps()).toEqual(["turn", "authorized", "report", "files", "authorized", "publish", "confirm"]);
		const [report, reportedUnder] = t.recordChange.mock.calls[0] ?? [];
		expect(report).toEqual({
			schema: SCHEMA,
			state: "landed",
			inLine: true,
			how: "fast-forward",
			headSha: head,
			mainBefore: t.baseSha,
			mainAfter: head,
			filesChanged: 1,
			paths: [{ path: "cart.js", change: "added" }],
			pathsMore: 0,
			picture: null,
			refusal: null,
			// The session's host runs no checks.
			checks: { state: "off" },
		});
		// The files are written for this repository, in the job, under the one deadline the report had.
		expect(t.inJob).toHaveBeenCalledTimes(1);
		const [job, target, bounded] = t.inJob.mock.calls[0] ?? [];
		expect(target).toEqual(TARGET);
		expect(job?.layout).toEqual({ companyRoot: t.f.companyRoot, scratchRoot: join(t.f.root, "scratch"), git: GIT });
		expect(job?.signal).toBe(bounded);
		expect(reportedUnder).toBe(bounded);
		expect(bounded?.aborted).toBe(false);
		expect(CODE_CHANGE_RECORD_MS).toBe(10_000);
		expect(t.logged).toEqual([
			{
				event: "code-change",
				step: "reported",
				companyId: COMPANY,
				environmentId: ENVIRONMENT,
				repository: "qorpera/example",
				workerId: t.f.workerId,
				sequence: 1,
				reported: "landed",
				inLine: true,
				state: "recorded",
				change: 7,
			},
		]);
	});

	it("reports how the commit went in and the picture the landing checked, and a commit main held already as unchanged", async () => {
		const t = await kept();
		const head = await t.commit();
		const merge = "d".repeat(40),
			was = "e".repeat(40),
			blob = "b".repeat(40);
		const paths = [
			{ path: "src/price.tsx", change: "changed" },
			{ path: "docs/changes/free-returns.png", change: "added" },
		];
		const merged = {
			state: "merged",
			mainSha: merge,
			restored: [],
			mainBefore: was,
			containedAt: null,
			diff: { filesChanged: 3, paths, pathsMore: 1 },
			picture: { state: "ok", blob, bytes: 51_234, type: "png" },
		};
		vi.mocked(landCodeBranch).mockClear();
		vi.mocked(landCodeBranch).mockResolvedValueOnce(merged as never);
		// The picture the session named is handed to the landing, which checks it in the commit that lands.
		expect(await t.land(head, { picture: "docs/changes/free-returns.png" })).toEqual({
			state: "merged",
			mainSha: merge,
			filesChanged: 3,
			change: 7,
		});
		expect(vi.mocked(landCodeBranch).mock.calls[0]?.[1]).toEqual({
			repository: KEPT,
			workerId: t.f.workerId,
			headSha: head,
			picture: "docs/changes/free-returns.png",
		});
		const landed = {
			schema: SCHEMA,
			state: "landed",
			inLine: true,
			how: "merged",
			headSha: head,
			mainBefore: was,
			mainAfter: merge,
			filesChanged: 3,
			paths,
			pathsMore: 1,
			picture: { state: "ok", blob, bytes: 51_234, type: "png" },
			refusal: null,
			checks: { state: "off" },
		};
		expect(t.reports()).toEqual([landed]);
		// A picture that did not pass is reported as it was found, and the landing goes on; none given, none named.
		for (const state of ["missing", "not_a_file", "too_large", "not_a_picture"]) {
			vi.mocked(landCodeBranch).mockResolvedValueOnce({ ...merged, picture: { state } } as never);
			await t.land(head, { picture: "docs/changes/free-returns.png" });
			expect(t.reports().at(-1)).toEqual({ ...landed, picture: { state } });
		}
		vi.mocked(landCodeBranch).mockResolvedValueOnce({ ...merged, picture: null } as never);
		await t.land(head);
		expect(vi.mocked(landCodeBranch).mock.calls.at(-1)?.[1]).toEqual({
			repository: KEPT,
			workerId: t.f.workerId,
			headSha: head,
		});
		expect(t.reports().at(-1)).toEqual({ ...landed, picture: null });

		// Main held the commit already: where main is, and the commit of main that first held it. No files, no picture.
		const unchanged = {
			state: "unchanged",
			mainSha: merge,
			restored: [],
			mainBefore: merge,
			containedAt: was,
			diff: { filesChanged: 0, paths: [], pathsMore: 0 },
			picture: null,
		};
		vi.mocked(landCodeBranch).mockResolvedValueOnce(unchanged as never);
		t.recordChange.mockResolvedValueOnce({ state: "known", change: 3 });
		expect(await t.land(head)).toEqual({ state: "unchanged", mainSha: merge, filesChanged: 0, change: 3 });
		expect(t.reports().at(-1)).toEqual({
			schema: SCHEMA,
			state: "unchanged",
			inLine: true,
			how: null,
			headSha: head,
			mainBefore: merge,
			mainAfter: was,
			filesChanged: null,
			paths: null,
			pathsMore: 0,
			picture: null,
			refusal: null,
			checks: null,
		});
		// The kernel may have no row for it: then the landing names no change.
		vi.mocked(landCodeBranch).mockResolvedValueOnce(unchanged as never);
		t.recordChange.mockResolvedValueOnce({ state: "nothing", change: null });
		expect(await t.land(head)).toEqual({ state: "unchanged", mainSha: merge, filesChanged: 0, change: null });
		// More paths than a row holds are cut here, and counted.
		const many = Array.from({ length: 60 }, (_, at) => ({ path: `src/${at}.ts`, change: "added" }));
		vi.mocked(landCodeBranch).mockResolvedValueOnce({
			...merged,
			diff: { filesChanged: 60, paths: many, pathsMore: 0 },
		} as never);
		await t.land(head);
		expect(t.reports().at(-1)).toMatchObject({ filesChanged: 60, paths: many.slice(0, 50), pathsMore: 10 });
	});

	it("makes a report the kernel did not confirm in the job once more after it, not in line, and then leaves it", async () => {
		const t = await kept();
		const head = await t.commit();
		t.f.events.length = 0;
		t.recordChange.mockRejectedValueOnce(new Error("CODING_CONTROL_UNCONFIRMED"));
		expect(await t.land(head)).toEqual({ state: "fast-forward", mainSha: head, filesChanged: 1, change: 7 });
		// The second report comes once the job has saved; no files were written for a row nobody heard of.
		expect(t.steps()).toEqual(["turn", "authorized", "authorized", "publish", "report"]);
		expect(t.reports()).toHaveLength(2);
		expect(t.reports()[0]).toMatchObject({ state: "landed", inLine: true, headSha: head });
		expect(t.reports()[1]).toEqual({ ...t.reports()[0], inLine: false });
		expect(t.inJob).not.toHaveBeenCalled();
		expect(t.confirm).not.toHaveBeenCalled();
		expect(t.errors()).toEqual(["report:CODING_CONTROL_UNCONFIRMED"]);

		// An answer that is none counts as not heard.
		const second = await t.commit();
		t.recordChange.mockResolvedValueOnce({ change: 9 } as never);
		expect(await t.land(second)).toMatchObject({ mainSha: second, change: 7 });
		expect(t.reports()).toHaveLength(4);
		expect(t.errors().at(-1)).toBe("report:CODE_CHANGE_RECORD_UNCONFIRMED");

		// Not heard twice: the landing stands, names no change, and the kernel is not asked a third time.
		const third = await t.commit();
		t.recordChange.mockClear();
		t.recordChange.mockRejectedValue(new Error("CODING_CONTROL_UNCONFIRMED"));
		expect(await t.land(third)).toEqual({ state: "fast-forward", mainSha: third, filesChanged: 1, change: null });
		expect(t.recordChange).toHaveBeenCalledTimes(2);
		expect(t.errors().slice(-2)).toEqual([
			"report:CODING_CONTROL_UNCONFIRMED",
			"report-again:CODING_CONTROL_UNCONFIRMED",
		]);
		expect(t.inJob).not.toHaveBeenCalled();
	});

	it("reports a conflict and a refusal before it throws them on, and nothing for an error that is neither", async () => {
		const t = await kept();
		const head = await t.f.commit(t.f.tree, "cart.js");
		const paths = Array.from({ length: 30 }, (_, at) => `src/${at}.js`);
		vi.mocked(landCodeBranch).mockRejectedValueOnce(new CodeHostRefusal("CODE_HOST_LAND_CONFLICT", paths));
		t.f.events.length = 0;
		const conflict = await t.land(head).catch((e) => e);
		expect(conflict).toBeInstanceOf(CodingLandConflict);
		expect(conflict.paths).toEqual(paths);
		// Nothing landed, so nothing of main is named; at most twenty of the paths.
		const never = {
			schema: SCHEMA,
			inLine: false,
			how: null,
			mainBefore: null,
			mainAfter: null,
			filesChanged: null,
			paths: null,
			pathsMore: 0,
			picture: null,
			checks: null,
		};
		expect(t.reports()).toEqual([
			{
				...never,
				state: "conflict",
				headSha: head,
				refusal: { code: "CODE_HOST_LAND_CONFLICT", paths: paths.slice(0, 20) },
			},
		]);
		// Its job saved nothing: the record's pass writes its file.
		expect(t.steps()).toEqual(["turn", "authorized", "report"]);
		expect(t.inJob).not.toHaveBeenCalled();

		// A refusal by rule, from the real landing: two names in one folder that differ only by case.
		const cased = await t.f.commit(t.f.tree, "Cart.js");
		const names = await t.land(cased).catch((e) => e);
		expect(names).toBeInstanceOf(CodingLandRefused);
		expect(names.message).toBe("CODE_HOST_NAMES_DIFFER_BY_CASE");
		const refused = t.reports().at(-1);
		expect(refused).toMatchObject({ ...never, state: "refused", headSha: cased });
		expect(refused?.refusal?.code).toBe("CODE_HOST_NAMES_DIFFER_BY_CASE");
		expect([...(refused?.refusal?.paths ?? [])].sort()).toEqual(["Cart.js", "cart.js"]);

		// A report that fails changes nothing of what is thrown.
		t.recordChange.mockRejectedValueOnce(new Error("CODING_CONTROL_UNCONFIRMED"));
		const again = await t.land(cased).catch((e) => e);
		expect(again).toBeInstanceOf(CodingLandRefused);
		expect(again.summary).toBe(names.summary);
		expect(t.errors()).toEqual(["report:CODING_CONTROL_UNCONFIRMED"]);

		// A repository that is being restored refuses every job: plain words, and a row like any refusal.
		vi.mocked(landCodeBranch).mockRejectedValueOnce(
			new CodeHostRefusal("CODE_HOST_RESTORE_IN_PROGRESS", ["code/qorpera/example"]),
		);
		const restoring = await t.land(cased).catch((e) => e);
		expect(restoring).toBeInstanceOf(CodingLandRefused);
		expect(restoring.summary).toBe(
			"The change was not landed, and nothing changed on main: the repository is being restored from its copy. A follow-up in a few minutes works.",
		);
		expect(t.reports().at(-1)).toEqual({
			...never,
			state: "refused",
			headSha: cased,
			refusal: { code: "CODE_HOST_RESTORE_IN_PROGRESS", paths: ["code/qorpera/example"] },
		});

		// A failure that is no refusal is thrown as it is, and is no row.
		const reported = t.recordChange.mock.calls.length;
		vi.mocked(landCodeBranch).mockRejectedValueOnce(new CodeHostJobFailure("CODE_HOST_LAND_FAILED", "merge-tree"));
		await expect(t.land(cased)).rejects.toThrow("CODE_HOST_LAND_FAILED");
		// A landing that lost main once reports only the landing that went in.
		vi.mocked(landCodeBranch).mockRejectedValueOnce(new CodeHostJobFailure("CODE_HOST_BASE_MOVED", "main moved"));
		await t.land(head);
		expect(t.recordChange.mock.calls.length).toBe(reported + 1);
		expect(t.reports().at(-1)).toMatchObject({ state: "landed", inLine: true, headSha: head });
		// A turn that was stopped reports nothing.
		const stopped = new AbortController();
		vi.mocked(landCodeBranch).mockImplementationOnce(async () => {
			stopped.abort(new Error("CODING_EXECUTOR_LEASE_LOST"));
			throw new CodeHostRefusal("CODE_HOST_LAND_CONFLICT", ["cart.js"]);
		});
		await expect(t.repositories.land(t.session, cased, stopped.signal)).rejects.toBeInstanceOf(CodeHostRefusal);
		expect(t.recordChange.mock.calls.length).toBe(reported + 1);
	});

	it("lets nothing of the record fail a landing, or hold its job past the record's time", async () => {
		// The record's files fail in the job, their confirmation fails after it, and a stand-in throws outright.
		const t = await kept();
		t.inJob.mockRejectedValueOnce(new Error("CODE_HOST_WRITE_FAILED"));
		let head = await t.commit();
		expect(await t.land(head)).toEqual({ state: "fast-forward", mainSha: head, filesChanged: 1, change: 7 });
		expect(t.confirm).not.toHaveBeenCalled();
		t.confirm.mockRejectedValueOnce(new Error("CODING_CONTROL_UNCONFIRMED"));
		head = await t.commit();
		expect(await t.land(head)).toMatchObject({ mainSha: head, change: 7 });
		t.inJob.mockImplementationOnce(() => {
			throw new Error("THREW");
		});
		head = await t.commit();
		expect(await t.land(head)).toMatchObject({ mainSha: head, change: 7 });
		expect(t.errors()).toEqual(["files:CODE_HOST_WRITE_FAILED", "written:CODING_CONTROL_UNCONFIRMED", "files:THREW"]);

		// A kernel that never answers, through a control that does not heed its signal: the job goes on at the end of
		// the record's time and saves main, and the report made again after it gets half that time.
		const slow = await kept({ recordMs: 40 });
		slow.recordChange.mockImplementation(() => new Promise(() => undefined));
		head = await slow.commit();
		slow.f.events.length = 0;
		const began = Date.now();
		expect(await slow.land(head)).toEqual({ state: "fast-forward", mainSha: head, filesChanged: 1, change: null });
		expect(Date.now() - began).toBeLessThan(5000);
		expect(slow.steps()).toEqual(["turn", "authorized", "authorized", "publish"]);
		expect(slow.recordChange).toHaveBeenCalledTimes(2);
		expect(slow.inJob).not.toHaveBeenCalled();
		expect(slow.errors().map((error) => error.split(":")[0])).toEqual(["report", "report-again"]);

		// Files that never finish, the same.
		const stuck = await kept({ recordMs: 40 });
		stuck.inJob.mockImplementation(() => new Promise(() => undefined));
		head = await stuck.commit();
		expect(await stuck.land(head)).toEqual({ state: "fast-forward", mainSha: head, filesChanged: 1, change: 7 });
		expect(stuck.confirm).not.toHaveBeenCalled();
		expect(stuck.errors().map((error) => error.split(":")[0])).toEqual(["files"]);
		// And a confirmation that never finishes.
		const unconfirmed = await kept({ recordMs: 40 });
		unconfirmed.confirm.mockImplementation(() => new Promise(() => undefined));
		head = await unconfirmed.commit();
		expect(await unconfirmed.land(head)).toMatchObject({ mainSha: head, change: 7 });
		expect(unconfirmed.errors().map((error) => error.split(":")[0])).toEqual(["written"]);

		// A job's answer that says nothing of main before or of what differs: the landing stands, with no count of
		// files, and nothing is reported to the kernel.
		const bare = await kept();
		head = await bare.commit();
		vi.mocked(landCodeBranch).mockResolvedValueOnce({ state: "fast-forward", mainSha: head, restored: [] } as never);
		expect(await bare.land(head)).toEqual({ state: "fast-forward", mainSha: head, filesChanged: 0, change: null });
		expect(bare.recordChange).not.toHaveBeenCalled();
		expect(bare.inJob).not.toHaveBeenCalled();
		expect(bare.errors()).toEqual(["report:CODE_CHANGE_LANDING_INVALID"]);

		// A log that throws changes nothing.
		const loud = await kept({
			report: () => {
				throw new Error("the log is full");
			},
		});
		loud.recordChange.mockRejectedValueOnce(new Error("CODING_CONTROL_UNCONFIRMED"));
		head = await loud.commit();
		expect(await loud.land(head)).toEqual({ state: "fast-forward", mainSha: head, filesChanged: 1, change: 7 });
		expect(() => new CodeHostRepositories(loud.f.jobs, { recordMs: 0 })).toThrow("INVALID_CODE_HOST_REPOSITORIES");
	});

	it("still reports a landing whose job failed after main moved, and confirms no files that were not saved", async () => {
		const t = await kept();
		const failure = new CodeHostJobFailure("CODE_HOST_PUBLISH_REFUSED", "code/qorpera/example/main/a.js: refused");
		const head = await t.commit();
		t.f.failSave(failure);
		await expect(t.land(head)).rejects.toBe(failure);
		// The report was made in the job, and the kernel has the row: main did move. The files were not saved.
		expect(t.reports()).toHaveLength(1);
		expect(t.reports()[0]).toMatchObject({ state: "landed", inLine: true, headSha: head });
		expect(t.inJob).toHaveBeenCalledTimes(1);
		expect(t.confirm).not.toHaveBeenCalled();
		// A report the job could not make is still made once more.
		const next = await t.commit();
		t.recordChange.mockClear();
		t.recordChange.mockRejectedValueOnce(new Error("CODING_CONTROL_UNCONFIRMED"));
		t.f.failSave(failure);
		await expect(t.land(next)).rejects.toBe(failure);
		expect(t.reports()).toHaveLength(2);
		expect(t.reports()[1]).toMatchObject({ state: "landed", inLine: false, headSha: next, mainBefore: head });
		expect(t.confirm).not.toHaveBeenCalled();
	});

	it("records nothing for a host that records no changes, and reports without files when it was given no record", async () => {
		const t = await kept();
		const { recordChange: _none, ...plain } = t.session;
		let head = await t.commit();
		expect(await t.repositories.land(plain, head, signal())).toEqual({
			state: "fast-forward",
			mainSha: head,
			filesChanged: 1,
			change: null,
		});
		expect(t.recordChange).not.toHaveBeenCalled();
		expect(t.inJob).not.toHaveBeenCalled();
		// A refusal of such a session is thrown as before, with nothing reported.
		vi.mocked(landCodeBranch).mockRejectedValueOnce(new CodeHostRefusal("CODE_HOST_LAND_CONFLICT", ["a.js"]));
		await expect(t.repositories.land(plain, head, signal())).rejects.toBeInstanceOf(CodingLandConflict);
		expect(t.logged).toEqual([]);
		// Without the record's files the landing is reported all the same: the record's own pass writes them.
		head = await t.commit();
		expect(await t.f.repositories.land(t.session, head, signal())).toEqual({
			state: "fast-forward",
			mainSha: head,
			filesChanged: 1,
			change: 7,
		});
		expect(t.recordChange).toHaveBeenCalledTimes(1);
		expect(t.inJob).not.toHaveBeenCalled();
	});

	it("says in plain words that a repository is being restored, where a turn meets it", async () => {
		const t = await kept();
		expect(CODE_RESTORING).toBe(
			"The repository is being restored from its copy. Nothing was changed; a follow-up in a few minutes works.",
		);
		const restoring = () => new CodeHostRefusal("CODE_HOST_RESTORE_IN_PROGRESS", ["code/qorpera/example"]);
		vi.mocked(addCodeWorktree).mockRejectedValueOnce(restoring());
		const prepared = await t.f.repositories.prepare(t.session, signal()).catch((e) => e);
		expect(prepared).toBeInstanceOf(CodingWorkspaceFailed);
		expect(prepared.message).toBe("CODE_HOST_RESTORE_IN_PROGRESS");
		expect(prepared.summary).toBe(`${CODE_RESTORING} [code=CODE_HOST_RESTORE_IN_PROGRESS]`);
		vi.mocked(startCodeArea).mockRejectedValueOnce(restoring());
		const started = await t.f.repositories
			.start({ claim: t.session.claim, assertAuthorized: t.f.authorized }, signal())
			.catch((e) => e);
		expect(started).toBeInstanceOf(CodingWorkspaceFailed);
		expect(started.summary).toBe(`${CODE_RESTORING} [code=CODE_HOST_RESTORE_IN_PROGRESS]`);
	});
});

describe("the repository's checks before a landing (own code storage, step 3)", () => {
	const KEPT: CloudCodingRepository = { host: "qorpera", owner: "qorpera", name: "example", baseBranch: "main" };
	const CHECKS: CodeCheck[] = [
		{ name: "install", run: "npm ci", timeoutSeconds: 600, cwd: "." },
		{ name: "test", run: "npm test", timeoutSeconds: 900, cwd: "." },
	];
	const BLOB = "1".repeat(40),
		MAIN_BLOB = "2".repeat(40);
	const FILE = { entry: { kind: "file" as const, bytes: Buffer.from('{"checks":[]}') }, blob: BLOB },
		MAIN_FILE = { entry: { kind: "file" as const, bytes: Buffer.from('{"checks":[]}') }, blob: MAIN_BLOB },
		NO_FILE = { entry: { kind: "missing" as const }, blob: null };
	const READ = { state: "ok" as const, blob: BLOB, checks: CHECKS, site: null },
		MAIN_READ = { state: "ok" as const, blob: MAIN_BLOB, checks: CHECKS.slice(0, 1), site: null };
	const CHANGED = { added: ["test"], removed: [], run: [] };
	const PASSED: Extract<CodeChecksRun, { state: "passed" }> = {
		state: "passed",
		ms: 99_000,
		copyMs: 2_000,
		checks: [
			{ name: "install", run: "npm ci", ms: 38_000 },
			{ name: "test", run: "npm test", ms: 59_000 },
		],
		site: null,
	};
	const FAILED: Extract<CodeChecksRun, { state: "failed" }> = {
		state: "failed",
		ms: 80_000,
		passed: [{ name: "install", ms: 38_000 }],
		failed: {
			name: "test",
			run: "npm test",
			ms: 41_000,
			exitCode: 1,
			atLimit: false,
			tail: "1 failing",
			log: "~/.qorpera-checks/out/2-test.log",
		},
		notRun: [],
	};
	const NOT_RUN = (code: string): Extract<CodeChecksRun, { state: "not_run" }> => ({
		state: "not_run",
		why: "machine",
		code,
	});
	const DIFF = { filesChanged: 1, paths: [{ path: "cart.js", change: "added" }], pathsMore: 0 };

	/** A session on a repository kept in Qorpera whose host runs checks: its switch answers `on`, `sites` and what step
	 * 5 adds (`more`: links from the root, a drill), and its runner is a stand-in that answers `runs` in turn (each run is
	 * a step of the session's). The landing's two jobs are stand-ins where a test says. */
	async function checked(on = true, sites = true, more: Pick<CodeChecksSwitched, "rootLinks" | "drill"> = {}) {
		const f = await fixture();
		const claim = { ...f.session.claim, repository: KEPT, baseSha: null };
		const { baseSha } = await f.repositories.start({ claim, assertAuthorized: f.authorized }, signal());
		const recordChange = vi.fn(
			async (_report: CodeChangeReport, _signal: AbortSignal): Promise<{ state: string; change: number | null }> => {
				f.events.push("report");
				return { state: "recorded", change: 7 };
			},
		);
		const runs: CodeChecksRun[] = [];
		const runChecks = vi.fn(
			async (
				_input: {
					commit: string;
					checks: readonly CodeCheck[];
					attempt: number;
					site: CodeSiteRecipe | null;
					rootLinks?: boolean;
				},
				_signal: AbortSignal,
			): Promise<CodeChecksRun> => {
				f.events.push("checks");
				const run = runs.shift();
				if (!run) throw new Error("NO_RUN");
				return run;
			},
		);
		const checksSwitch = vi.fn(async (_signal: AbortSignal): Promise<CodeChecksSwitched> => {
			f.events.push("switch");
			return { checks: on, site: sites, ...more };
		});
		const session: CodingFolderRepositorySession = {
			...f.session,
			claim,
			baseSha,
			recordChange,
			checksSwitch,
			runChecks,
		};
		await f.repositories.prepare(session, signal());
		const confirm = vi.fn(async () => {
			f.events.push("confirm");
		});
		const inJob = vi.fn<NonNullable<CodeHostRepositoriesOptions["records"]>["inJob"]>(async () => {
			f.events.push("files");
			return confirm;
		});
		const logged: Record<string, unknown>[] = [];
		// The upload pass of a repository's site (step 4), woken by a landing whose report says its site was made.
		const wake = vi.fn(() => {
			f.events.push("wake");
		});
		const repositories = new CodeHostRepositories(f.jobs, {
			records: { inJob },
			report: (event) => logged.push(event),
			sites: { wake },
		});
		let files = 0;
		// Each test says what the jobs and the gate answer: nothing an earlier test left is answered.
		vi.mocked(landCodeBranch).mockReset();
		for (const mock of [
			readCodeChecks,
			codeChecksGate,
			codeChecksPassed,
			codeChecksFailedSummary,
			codeChecksNotRunSummary,
		])
			vi.mocked(mock).mockReset();
		return {
			f,
			session,
			baseSha,
			recordChange,
			runChecks,
			checksSwitch,
			inJob,
			logged,
			repositories,
			wake,
			/** One more commit on the session's branch. */
			commit: () => f.commit(f.tree, `file-${++files}.js`),
			/** What the stand-in runner answers, in turn. */
			runs: (...answers: CodeChecksRun[]) => runs.push(...answers),
			land: (headSha: string, given = signal()) => repositories.land(session, headSha, given),
			steps: () => f.events.filter((event) => event !== "command"),
			reports: () => recordChange.mock.calls.map(([report]) => report),
			/** What each landing job was asked, without the repository and the worker. */
			asked: () =>
				vi.mocked(landCodeBranch).mock.calls.map(([, value]) => {
					const { repository: _repository, workerId: _workerId, ...rest } = value;
					return rest;
				}),
		};
	}
	/** Job A's answer: a candidate to check, having moved nothing. */
	const toCheck = (
		mainBefore: string,
		mainAfter: string,
		how: "fast-forward" | "merged" = "fast-forward",
		files: { checks: CodeCommitFile; mainChecks: CodeCommitFile } = { checks: FILE, mainChecks: MAIN_FILE },
	) => ({ state: "to-check", how, mainBefore, mainAfter, ...files, restored: [] });
	/** Job B's answer: main moved to the candidate. */
	const landed = (mainBefore: string, mainAfter: string, how: "fast-forward" | "merged" = "fast-forward") => ({
		state: how,
		mainSha: mainAfter,
		mainBefore,
		containedAt: null,
		diff: DIFF,
		picture: null,
		restored: [],
	});
	/** The row's `checks` for a passed run, as part C1 makes it. */
	const result = (commit: string, how: "fast-forward" | "merged", tries: 1 | 2) => ({
		schema: "qorpera.code-checks/v1",
		commit,
		how,
		file: BLOB,
		tries,
	});
	/** The gate runs the candidate's checks, and says the site they leave (`site`; none by default). */
	const gateRuns = (site: CodeSiteRecipe | null = null) => {
		vi.mocked(readCodeChecks)
			.mockReturnValueOnce(MAIN_READ)
			.mockReturnValueOnce({ ...READ, site });
		vi.mocked(codeChecksGate).mockReturnValueOnce({
			gate: "run",
			checks: CHECKS,
			blob: BLOB,
			changed: CHANGED,
			site,
		});
	};

	it("lands a repository with no checks file in one job, as before, its row saying none", async () => {
		const t = await checked();
		const head = await t.f.commit(t.f.tree, "cart.js");
		// Part B's job with nothing at the path at both ends lands as today.
		const real = await vi.importActual<typeof import("../src/code-host-jobs.ts")>("../src/code-host-jobs.ts");
		vi.mocked(landCodeBranch).mockImplementationOnce(async (job, value) => {
			const { checks: _checks, ...today } = value as typeof value & { checks?: true };
			return await real.landCodeBranch(job, today);
		});
		t.f.events.length = 0;
		expect(await t.land(head)).toEqual({ state: "fast-forward", mainSha: head, filesChanged: 1, change: 7 });
		// One job, asked to read the checks file; nothing run, nothing read here.
		expect(t.asked()).toEqual([{ headSha: head, checks: true }]);
		expect(t.steps()).toEqual([
			"switch",
			"turn",
			"authorized",
			"report",
			"files",
			"authorized",
			"publish",
			"confirm",
		]);
		expect(t.checksSwitch).toHaveBeenCalledTimes(1);
		expect(t.runChecks).not.toHaveBeenCalled();
		expect(readCodeChecks).not.toHaveBeenCalled();
		expect(t.reports()).toEqual([
			expect.objectContaining({
				schema: "qorpera.code-change-report/v2",
				state: "landed",
				inLine: true,
				how: "fast-forward",
				mainAfter: head,
				checks: { state: "none" },
			}),
		]);
		expect(await t.f.git(join(t.f.companyRoot, "code/qorpera/example/repo.git"), "rev-parse", "main")).toBe(head);
	});

	it("lands a repository whose checks are switched off as before, never reading its checks file, its row saying off", async () => {
		const t = await checked(false);
		const head = await t.f.commit(t.f.tree, "cart.js");
		t.f.events.length = 0;
		expect(await t.land(head)).toEqual({ state: "fast-forward", mainSha: head, filesChanged: 1, change: 7 });
		expect(t.asked()).toEqual([{ headSha: head }]);
		expect(t.runChecks).not.toHaveBeenCalled();
		expect(readCodeChecks).not.toHaveBeenCalled();
		expect(t.reports()).toEqual([expect.objectContaining({ state: "landed", checks: { state: "off" } })]);
		// A host that has no switch, or no runner, runs no checks either.
		const { checksSwitch: _switch, ...noSwitch } = t.session;
		const { runChecks: _runner, ...noRunner } = t.session;
		for (const without of [noSwitch, noRunner]) {
			const next = await t.commit();
			await t.repositories.land(without, next, signal());
			expect(t.asked().at(-1)).toEqual({ headSha: next });
			expect(t.reports().at(-1)).toMatchObject({ state: "landed", mainAfter: next, checks: { state: "off" } });
		}
		expect(t.runChecks).not.toHaveBeenCalled();
	});

	it.each(["fast-forward", "merged"] as const)(
		"checks the candidate outside the line and lands exactly it in job B, the passed run on its row (%s)",
		async (how) => {
			const t = await checked();
			const head = await t.f.commit(t.f.tree, "cart.js");
			const was = "e".repeat(40),
				candidate = how === "merged" ? "d".repeat(40) : head;
			vi.mocked(landCodeBranch)
				.mockResolvedValueOnce(toCheck(was, candidate, how) as never)
				.mockResolvedValueOnce(landed(was, candidate, how) as never);
			gateRuns();
			t.runs(PASSED);
			vi.mocked(codeChecksPassed).mockReturnValueOnce(result(candidate, how, 1));
			t.f.events.length = 0;
			expect(await t.land(head)).toEqual({ state: how, mainSha: candidate, filesChanged: 1, change: 7 });
			// Job A moves nothing and reports nothing; the checks run between the two jobs, while no job holds the line;
			// job B reports inside its job, as a landing does.
			expect(t.steps()).toEqual([
				"switch",
				"turn",
				"authorized",
				"authorized",
				"publish",
				"checks",
				"turn",
				"authorized",
				"report",
				"files",
				"authorized",
				"publish",
				"confirm",
			]);
			expect(t.asked()).toEqual([
				{ headSha: head, checks: true },
				{ headSha: head, expect: { how, mainBefore: was, mainAfter: candidate } },
			]);
			// The gate reads the file at main and at the candidate, and the checks run on the candidate.
			expect(vi.mocked(readCodeChecks).mock.calls).toEqual([[MAIN_FILE], [FILE]]);
			expect(vi.mocked(codeChecksGate).mock.calls).toEqual([[MAIN_READ, READ]]);
			expect(t.runChecks.mock.calls.map(([input]) => input)).toEqual([
				{ commit: candidate, checks: CHECKS, attempt: 1, site: null },
			]);
			expect(vi.mocked(codeChecksPassed).mock.calls).toEqual([
				[{ commit: candidate, how, blob: BLOB, run: PASSED, changed: CHANGED, tries: 1 }],
			]);
			// A run that passed is reported as v3: what became of its site, here none to take.
			expect(t.reports()).toEqual([
				{
					schema: "qorpera.code-change-report/v3",
					state: "landed",
					inLine: true,
					how,
					headSha: head,
					mainBefore: was,
					mainAfter: candidate,
					filesChanged: 1,
					paths: DIFF.paths,
					pathsMore: 0,
					picture: null,
					refusal: null,
					checks: { state: "passed", result: result(candidate, how, 1) },
					site: null,
				},
			]);
			expect(t.logged.filter((event) => event.event === "code-checks")).toEqual([
				expect.objectContaining({ step: "landed", checks: "passed", attempt: 1, tries: 1 }),
			]);
		},
	);

	it("lands nothing and reports no row when a check failed, and fails the turn with the check's words", async () => {
		const t = await checked();
		const head = await t.f.commit(t.f.tree, "cart.js");
		vi.mocked(landCodeBranch).mockResolvedValueOnce(toCheck(t.baseSha, head) as never);
		gateRuns();
		t.runs(FAILED);
		const words = 'Nothing went into main: the check "test" failed. [code=CODING_CHECKS_FAILED]';
		vi.mocked(codeChecksFailedSummary).mockReturnValueOnce(words);
		const failed = await t.land(head).catch((e) => e);
		expect(failed).toBeInstanceOf(CodingLandRefused);
		expect(failed.message).toBe("CODING_CHECKS_FAILED");
		expect(failed.summary).toBe(words);
		expect(vi.mocked(codeChecksFailedSummary).mock.calls).toEqual([[FAILED, "fast-forward"]]);
		// One job, one run, no job B, no row, no record files; main is where it was.
		expect(t.asked()).toHaveLength(1);
		expect(t.runChecks).toHaveBeenCalledTimes(1);
		expect(t.recordChange).not.toHaveBeenCalled();
		expect(t.inJob).not.toHaveBeenCalled();
		expect(codeChecksPassed).not.toHaveBeenCalled();
		expect(await t.f.git(join(t.f.companyRoot, "code/qorpera/example/repo.git"), "rev-parse", "main")).toBe(
			t.baseSha,
		);
	});

	it("runs nothing for a checks file the gate refuses, whether removed or broken, and reports no row", async () => {
		const t = await checked();
		const head = await t.f.commit(t.f.tree, "cart.js");
		const kinds = [
			{
				files: { checks: NO_FILE, mainChecks: MAIN_FILE },
				reads: [MAIN_READ, { state: "missing" as const }],
				words: "Nothing went into main: the checks file is gone in this change. [code=CODING_CHECKS_REFUSED]",
			},
			{
				files: { checks: FILE, mainChecks: NO_FILE },
				reads: [
					{ state: "missing" as const },
					{
						state: "refused" as const,
						blob: BLOB,
						problems: [{ at: "/checks/0/name", code: "INVALID", message: "is not a name" }],
					},
				],
				words: "Nothing went into main: the checks file is not as Qorpera reads it. [code=CODING_CHECKS_REFUSED]",
			},
		];
		for (const { files, reads, words } of kinds) {
			vi.mocked(landCodeBranch).mockResolvedValueOnce(toCheck(t.baseSha, head, "fast-forward", files) as never);
			vi.mocked(readCodeChecks)
				.mockReturnValueOnce(reads[0] as never)
				.mockReturnValueOnce(reads[1] as never);
			vi.mocked(codeChecksGate).mockReturnValueOnce({ gate: "refused", summary: words });
			const refused = await t.land(head).catch((e) => e);
			expect(refused).toBeInstanceOf(CodingLandRefused);
			expect(refused.message).toBe("CODING_CHECKS_REFUSED");
			expect(refused.summary).toBe(words);
			expect(vi.mocked(readCodeChecks).mock.calls.slice(-2)).toEqual([[files.mainChecks], [files.checks]]);
			expect(vi.mocked(codeChecksGate).mock.calls.at(-1)).toEqual(reads);
		}
		expect(t.asked()).toHaveLength(2);
		expect(t.runChecks).not.toHaveBeenCalled();
		expect(t.recordChange).not.toHaveBeenCalled();
	});

	it("runs checks that could not run once more, and lands when they pass then", async () => {
		const t = await checked();
		const head = await t.f.commit(t.f.tree, "cart.js");
		vi.mocked(landCodeBranch)
			.mockResolvedValueOnce(toCheck(t.baseSha, head) as never)
			.mockResolvedValueOnce(landed(t.baseSha, head) as never);
		gateRuns();
		t.runs(NOT_RUN("CODE_CHECKS_MACHINE_STOPPED"), PASSED);
		vi.mocked(codeChecksPassed).mockReturnValueOnce(result(head, "fast-forward", 1));
		expect(await t.land(head)).toMatchObject({ state: "fast-forward", mainSha: head, change: 7 });
		// The same candidate, its run a new attempt; main did not move, so it is the first try.
		expect(t.runChecks.mock.calls.map(([input]) => input)).toEqual([
			{ commit: head, checks: CHECKS, attempt: 1, site: null },
			{ commit: head, checks: CHECKS, attempt: 2, site: null },
		]);
		expect(t.asked()).toHaveLength(2);
		expect(vi.mocked(codeChecksPassed).mock.calls[0]?.[0]).toMatchObject({ run: PASSED, tries: 1 });
		expect(t.reports()).toEqual([
			expect.objectContaining({ checks: { state: "passed", result: result(head, "fast-forward", 1) } }),
		]);
	});

	it("never lands unchecked: checks that could not run twice fail the turn as no fault of the code, with no row", async () => {
		const t = await checked();
		const head = await t.f.commit(t.f.tree, "cart.js");
		vi.mocked(landCodeBranch).mockResolvedValueOnce(toCheck(t.baseSha, head) as never);
		gateRuns();
		const second = NOT_RUN("CODE_CHECKS_BUDGET");
		t.runs(NOT_RUN("CODE_CHECKS_MACHINE_STOPPED"), second);
		const words = "Nothing went into main: Qorpera could not run the checks. [code=CODING_CHECKS_DID_NOT_RUN]";
		vi.mocked(codeChecksNotRunSummary).mockReturnValueOnce(words);
		const failed = await t.land(head).catch((e) => e);
		expect(failed).toBeInstanceOf(CodingLandRefused);
		expect(failed.message).toBe("CODING_CHECKS_DID_NOT_RUN");
		expect(failed.summary).toBe(words);
		expect(vi.mocked(codeChecksNotRunSummary).mock.calls).toEqual([[second]]);
		expect(t.runChecks).toHaveBeenCalledTimes(2);
		expect(t.asked()).toHaveLength(1);
		expect(t.recordChange).not.toHaveBeenCalled();
	});

	it("makes job A again when main moved during the checks, and checks the new candidate once more", async () => {
		const t = await checked();
		const head = await t.f.commit(t.f.tree, "cart.js");
		const other = "c".repeat(40),
			merge = "d".repeat(40);
		vi.mocked(landCodeBranch)
			.mockResolvedValueOnce(toCheck(t.baseSha, head) as never)
			.mockRejectedValueOnce(new CodeHostJobFailure("CODE_HOST_LAND_STALE", "the default branch moved"))
			.mockResolvedValueOnce(toCheck(other, merge, "merged") as never)
			.mockResolvedValueOnce(landed(other, merge, "merged") as never);
		gateRuns();
		gateRuns();
		t.runs(PASSED, PASSED);
		vi.mocked(codeChecksPassed)
			.mockReturnValueOnce(result(head, "fast-forward", 1))
			.mockReturnValueOnce(result(merge, "merged", 2));
		expect(await t.land(head)).toMatchObject({ state: "merged", mainSha: merge, change: 7 });
		expect(t.asked()).toEqual([
			{ headSha: head, checks: true },
			{ headSha: head, expect: { how: "fast-forward", mainBefore: t.baseSha, mainAfter: head } },
			{ headSha: head, checks: true },
			{ headSha: head, expect: { how: "merged", mainBefore: other, mainAfter: merge } },
		]);
		// The second run is of the new candidate, its own attempt; the record says it was the second try.
		expect(t.runChecks.mock.calls.map(([input]) => input)).toEqual([
			{ commit: head, checks: CHECKS, attempt: 1, site: null },
			{ commit: merge, checks: CHECKS, attempt: 2, site: null },
		]);
		expect(vi.mocked(codeChecksPassed).mock.calls).toEqual([
			[{ commit: head, how: "fast-forward", blob: BLOB, run: PASSED, changed: CHANGED, tries: 1 }],
			[{ commit: merge, how: "merged", blob: BLOB, run: PASSED, changed: CHANGED, tries: 2 }],
		]);
		expect(t.reports()).toEqual([
			expect.objectContaining({
				how: "merged",
				mainAfter: merge,
				checks: { state: "passed", result: result(merge, "merged", 2) },
			}),
		]);
	});

	it("fails the turn as no fault of the code when main moved twice during the checks, with no row", async () => {
		const t = await checked();
		const head = await t.f.commit(t.f.tree, "cart.js");
		const stale = () => new CodeHostJobFailure("CODE_HOST_LAND_STALE", "the default branch moved");
		vi.mocked(landCodeBranch)
			.mockResolvedValueOnce(toCheck(t.baseSha, head) as never)
			.mockRejectedValueOnce(stale())
			.mockResolvedValueOnce(toCheck("c".repeat(40), "d".repeat(40), "merged") as never)
			.mockRejectedValueOnce(stale());
		gateRuns();
		gateRuns();
		t.runs(PASSED, PASSED);
		vi.mocked(codeChecksPassed)
			.mockReturnValueOnce(result(head, "fast-forward", 1))
			.mockReturnValueOnce(result("d".repeat(40), "merged", 2));
		const failed = await t.land(head).catch((e) => e);
		expect(failed).toBeInstanceOf(CodingLandRefused);
		expect(failed.message).toBe("CODING_CHECKS_MAIN_MOVED");
		expect(failed.summary).toBe(CODE_CHECKS_MAIN_MOVED);
		expect(failed.cause).toBeInstanceOf(CodeHostJobFailure);
		expect(t.asked()).toHaveLength(4);
		expect(t.runChecks).toHaveBeenCalledTimes(2);
		expect(t.recordChange).not.toHaveBeenCalled();
	});

	it("asks job B once more with the same candidate when it lost the move itself, without running the checks again", async () => {
		const t = await checked();
		const head = await t.f.commit(t.f.tree, "cart.js");
		vi.mocked(landCodeBranch)
			.mockResolvedValueOnce(toCheck(t.baseSha, head) as never)
			.mockRejectedValueOnce(new CodeHostJobFailure("CODE_HOST_BASE_MOVED", "main moved"))
			.mockResolvedValueOnce(landed(t.baseSha, head) as never);
		gateRuns();
		t.runs(PASSED);
		vi.mocked(codeChecksPassed).mockReturnValueOnce(result(head, "fast-forward", 1));
		expect(await t.land(head)).toMatchObject({ mainSha: head, change: 7 });
		const b = { headSha: head, expect: { how: "fast-forward", mainBefore: t.baseSha, mainAfter: head } };
		expect(t.asked()).toEqual([{ headSha: head, checks: true }, b, b]);
		expect(t.runChecks).toHaveBeenCalledTimes(1);
	});

	it("reports job B's refusals as a landing's, and a candidate main already holds as unchanged with no checks", async () => {
		const t = await checked();
		const head = await t.f.commit(t.f.tree, "cart.js");
		// A restore began while the checks ran: job B is refused like any landing, and its row says so.
		vi.mocked(landCodeBranch)
			.mockResolvedValueOnce(toCheck(t.baseSha, head) as never)
			.mockRejectedValueOnce(new CodeHostRefusal("CODE_HOST_RESTORE_IN_PROGRESS", ["code/qorpera/example"]));
		gateRuns();
		t.runs(PASSED);
		vi.mocked(codeChecksPassed).mockReturnValueOnce(result(head, "fast-forward", 1));
		const restoring = await t.land(head).catch((e) => e);
		expect(restoring).toBeInstanceOf(CodingLandRefused);
		expect(restoring.message).toBe("CODE_HOST_RESTORE_IN_PROGRESS");
		expect(t.reports()).toEqual([
			expect.objectContaining({ state: "refused", inLine: false, checks: null, refusal: expect.anything() }),
		]);
		// Main came to hold the commit while the checks ran: nothing moves, and the row says nothing of checks.
		const unchanged = {
			...landed(head, head),
			state: "unchanged",
			containedAt: head,
			diff: { filesChanged: 0, paths: [], pathsMore: 0 },
		};
		vi.mocked(landCodeBranch)
			.mockResolvedValueOnce(toCheck(t.baseSha, head) as never)
			.mockResolvedValueOnce(unchanged as never);
		gateRuns();
		t.runs(PASSED);
		vi.mocked(codeChecksPassed).mockReturnValueOnce(result(head, "fast-forward", 1));
		expect(await t.land(head)).toMatchObject({ state: "unchanged", mainSha: head });
		expect(t.reports().at(-1)).toMatchObject({ state: "unchanged", checks: null });
	});

	it("records nothing of a passed run whose result is not of the commit that went in", async () => {
		const t = await checked();
		const head = await t.f.commit(t.f.tree, "cart.js");
		vi.mocked(landCodeBranch)
			.mockResolvedValueOnce(toCheck(t.baseSha, head) as never)
			.mockResolvedValueOnce(landed(t.baseSha, head) as never);
		gateRuns();
		t.runs(PASSED);
		vi.mocked(codeChecksPassed).mockReturnValueOnce(result("f".repeat(40), "fast-forward", 1));
		// The landing stands; the record says why it has no row from it.
		expect(await t.land(head)).toEqual({ state: "fast-forward", mainSha: head, filesChanged: 1, change: null });
		expect(t.recordChange).not.toHaveBeenCalled();
		expect(t.logged).toContainEqual(
			expect.objectContaining({
				event: "code-change-error",
				step: "report",
				error: new Error("CODE_CHANGE_LANDING_INVALID"),
			}),
		);
	});

	it("ends the landing with the turn's abort during the checks: no job B, no row, the abort thrown on", async () => {
		const t = await checked();
		const head = await t.f.commit(t.f.tree, "cart.js");
		vi.mocked(landCodeBranch).mockResolvedValueOnce(toCheck(t.baseSha, head) as never);
		gateRuns();
		const stop = new AbortController();
		const reason = new Error("CODING_EXECUTOR_LEASE_LOST");
		t.runChecks.mockImplementationOnce(
			(_input, given) =>
				new Promise((_resolve, reject) => {
					given.addEventListener("abort", () => reject(given.reason), { once: true });
					stop.abort(reason);
				}),
		);
		await expect(t.land(head, stop.signal)).rejects.toBe(reason);
		expect(t.runChecks.mock.calls[0]?.[1]).toBe(stop.signal);
		expect(t.asked()).toHaveLength(1);
		expect(t.recordChange).not.toHaveBeenCalled();
		expect(codeChecksNotRunSummary).not.toHaveBeenCalled();
	});

	it("lands through part B's two real jobs and part C1's real reader, gate and result, the runner aside", async () => {
		const t = await checked();
		// The session's first change adds the checks file.
		const file = JSON.stringify({ checks: CHECKS.map(({ name, run }) => ({ name, run })) });
		await mkdir(join(t.f.tree, ".qorpera"));
		await writeFile(join(t.f.tree, ".qorpera/checks.json"), file);
		await t.f.git(t.f.tree, "add", ".qorpera/checks.json");
		const head = await t.f.commit(t.f.tree, "cart.js");
		t.runs({
			state: "passed",
			ms: 3_000,
			copyMs: 1_000,
			checks: CHECKS.map(({ name, run }) => ({ name, run, ms: 1_000 })),
			site: null,
		});
		expect(await t.land(head)).toEqual({ state: "fast-forward", mainSha: head, filesChanged: 2, change: 7 });
		const repo = join(t.f.companyRoot, "code/qorpera/example/repo.git");
		expect(await t.f.git(repo, "rev-parse", "main")).toBe(head);
		expect(t.asked()).toEqual([
			{ headSha: head, checks: true },
			{ headSha: head, expect: { how: "fast-forward", mainBefore: t.baseSha, mainAfter: head } },
		]);
		expect(t.runChecks.mock.calls[0]?.[0]).toEqual({
			commit: head,
			checks: CHECKS.map(({ name, run }) => ({ name, run, timeoutSeconds: 600, cwd: "." })),
			attempt: 1,
			site: null,
		});
		const blob = await t.f.git(repo, "rev-parse", `${head}:.qorpera/checks.json`);
		expect(t.reports().at(-1)).toMatchObject({
			schema: "qorpera.code-change-report/v3",
			site: null,
			state: "landed",
			mainAfter: head,
			checks: {
				state: "passed",
				result: { schema: "qorpera.code-checks/v1", commit: head, how: "fast-forward", file: blob, tries: 1 },
			},
		});
		// The next change removes the file: refused by the gate's own words, nothing moves, no row.
		await t.f.git(t.f.tree, "rm", "--quiet", ".qorpera/checks.json");
		const removed = await t.f.commit(t.f.tree, "more.js");
		const refused = await t.land(removed).catch((e) => e);
		expect(refused).toBeInstanceOf(CodingLandRefused);
		expect(refused.message).toBe("CODING_CHECKS_REFUSED");
		expect(refused.summary).toMatch(/\[code=CODING_CHECKS_REFUSED\]$/);
		expect(await t.f.git(repo, "rev-parse", "main")).toBe(head);
		expect(t.reports()).toHaveLength(1);
		expect(t.runChecks).toHaveBeenCalledTimes(1);
	});

	it("reads a refused switch as the end of the landing, before any job", async () => {
		const t = await checked();
		const head = await t.f.commit(t.f.tree, "cart.js");
		const refused = new Error("CODING_CONTROL_REFUSED");
		t.checksSwitch.mockRejectedValueOnce(refused);
		await expect(t.land(head)).rejects.toBe(refused);
		expect(t.asked()).toEqual([]);
	});

	describe("a repository's site at a landing (own code storage, step 4)", () => {
		const RECIPE: CodeSiteRecipe = { folder: "dist", name: "gift-message", title: "Gift message" };
		const MADE: CodeSiteCollected = { state: "made", tree: "a".repeat(40), files: 3, bytes: 4_096, ...RECIPE };
		const MISSED: CodeSiteCollected = { state: "missed", code: "CODE_SITE_BOUNDARY_UNCHECKED" };
		/** A run whose every check passed, with what became of its site. */
		const passed = (site: CodeSiteCollected | null): CodeChecksRun => ({ ...PASSED, site });
		/** Job A then job B, the gate with `site`, and one run's answer. */
		const lands = (t: Awaited<ReturnType<typeof checked>>, head: string, site: CodeSiteRecipe | null) => {
			vi.mocked(landCodeBranch)
				.mockResolvedValueOnce(toCheck(t.baseSha, head) as never)
				.mockResolvedValueOnce(landed(t.baseSha, head) as never);
			gateRuns(site);
			vi.mocked(codeChecksPassed).mockReturnValueOnce(result(head, "fast-forward", 1));
		};

		it("takes the candidate's site, reports it made as v3 exactly as the kernel takes it, and wakes the upload once", async () => {
			const t = await checked();
			const head = await t.f.commit(t.f.tree, "cart.js");
			lands(t, head, RECIPE);
			t.runs(passed(MADE));
			t.f.events.length = 0;
			expect(await t.land(head)).toEqual({ state: "fast-forward", mainSha: head, filesChanged: 1, change: 7 });
			// The gate's recipe goes to the run, the switch saying sites are on.
			expect(t.runChecks.mock.calls.map(([input]) => input)).toEqual([
				{ commit: head, checks: CHECKS, attempt: 1, site: RECIPE },
			]);
			expect(t.reports()).toEqual([
				{
					schema: "qorpera.code-change-report/v3",
					state: "landed",
					inLine: true,
					how: "fast-forward",
					headSha: head,
					mainBefore: t.baseSha,
					mainAfter: head,
					filesChanged: 1,
					paths: DIFF.paths,
					pathsMore: 0,
					picture: null,
					refusal: null,
					checks: { state: "passed", result: result(head, "fast-forward", 1) },
					site: {
						state: "made",
						site: {
							schema: "qorpera.code-site/v1",
							tree: "a".repeat(40),
							files: 3,
							bytes: 4_096,
							folder: "dist",
							name: "gift-message",
							title: "Gift message",
						},
					},
				},
			]);
			// Woken once, after the landing's job saved and the record's files were confirmed.
			expect(t.wake).toHaveBeenCalledTimes(1);
			expect(t.steps().slice(-3)).toEqual(["publish", "confirm", "wake"]);
			expect(t.logged.filter((event) => event.event === "code-checks")).toEqual([
				expect.objectContaining({ step: "landed", checks: "passed", attempt: 1, site: "made" }),
			]);
		});

		it("takes no site when the checks file has none, or the switch says sites are off, and reports v3 with none", async () => {
			for (const [sites, recipe] of [
				[true, null],
				[false, RECIPE],
			] as const) {
				const t = await checked(true, sites);
				const head = await t.f.commit(t.f.tree, "cart.js");
				lands(t, head, recipe);
				t.runs(passed(null));
				expect(await t.land(head)).toMatchObject({ state: "fast-forward", mainSha: head, change: 7 });
				expect(t.runChecks.mock.calls.map(([input]) => input.site)).toEqual([null]);
				expect(t.reports()).toEqual([
					expect.objectContaining({ schema: "qorpera.code-change-report/v3", site: null }),
				]);
				expect(t.wake).not.toHaveBeenCalled();
			}
		});

		it("lands a change whose site Qorpera missed, reports it missed with its code, and wakes nothing", async () => {
			const t = await checked();
			const head = await t.f.commit(t.f.tree, "cart.js");
			lands(t, head, RECIPE);
			t.runs(passed(MISSED));
			expect(await t.land(head)).toMatchObject({ state: "fast-forward", mainSha: head, change: 7 });
			expect(t.reports()).toEqual([
				expect.objectContaining({
					schema: "qorpera.code-change-report/v3",
					checks: { state: "passed", result: result(head, "fast-forward", 1) },
					site: { state: "missed", code: "CODE_SITE_BOUNDARY_UNCHECKED" },
				}),
			]);
			expect(t.wake).not.toHaveBeenCalled();
			expect(t.logged).toContainEqual(expect.objectContaining({ step: "landed", site: "missed" }));
		});

		it.each([
			{ code: "SITE_FOLDER_MISSING", path: null, variable: null },
			{ code: "SITE_NO_INDEX", path: null, variable: null },
			{ code: "SITE_TOO_MANY_FILES", path: null, variable: null },
			{ code: "SITE_TOO_MANY_FOLDERS", path: null, variable: null },
			{ code: "SITE_FILE_TOO_LARGE", path: "video/intro.mp4", variable: null },
			{ code: "SITE_TOO_LARGE", path: null, variable: null },
			{ code: "SITE_FILE_NAME", path: "img/My Photo.png", variable: null },
			{ code: "SITE_HOLDS_SECRET", path: "assets/app.js", variable: "STRIPE_KEY" },
			{ code: "SITE_HOLDS_SECRET", path: null, variable: null },
		] as const)(
			"lands nothing and reports no row when the site is refused ($code, $variable), and fails the turn with its words",
			async (problem) => {
				const t = await checked();
				const head = await t.f.commit(t.f.tree, "cart.js");
				vi.mocked(landCodeBranch).mockResolvedValueOnce(toCheck(t.baseSha, head) as never);
				gateRuns(RECIPE);
				t.runs({ state: "site_refused", ms: 99_000, checks: PASSED.checks, problem });
				const refused = await t.land(head).catch((e) => e);
				expect(refused).toBeInstanceOf(CodingLandRefused);
				expect(refused.message).toBe("CODING_CHECKS_SITE_REFUSED");
				// Part C1's words, of the problem and the recipe's folder.
				expect(refused.summary).toBe(codeSiteRefusedSummary(problem, "dist"));
				expect(refused.summary).toMatch(/\[code=CODING_CHECKS_SITE_REFUSED\]$/);
				// One job, one run, no job B, no row, no record files, nothing woken; main is where it was.
				expect(t.asked()).toHaveLength(1);
				expect(t.runChecks).toHaveBeenCalledTimes(1);
				expect(t.recordChange).not.toHaveBeenCalled();
				expect(t.inJob).not.toHaveBeenCalled();
				expect(codeChecksPassed).not.toHaveBeenCalled();
				expect(t.wake).not.toHaveBeenCalled();
				expect(await t.f.git(join(t.f.companyRoot, "code/qorpera/example/repo.git"), "rev-parse", "main")).toBe(
					t.baseSha,
				);
				expect(t.logged).toContainEqual(
					expect.objectContaining({
						event: "code-checks",
						step: "site-refused",
						attempt: 1,
						problem: problem.code,
						variable: problem.variable,
					}),
				);
			},
		);

		it("takes the site again in the run made again when main moved, and reports the second one", async () => {
			const t = await checked();
			const head = await t.f.commit(t.f.tree, "cart.js");
			const other = "c".repeat(40),
				merge = "d".repeat(40);
			vi.mocked(landCodeBranch)
				.mockResolvedValueOnce(toCheck(t.baseSha, head) as never)
				.mockRejectedValueOnce(new CodeHostJobFailure("CODE_HOST_LAND_STALE", "the default branch moved"))
				.mockResolvedValueOnce(toCheck(other, merge, "merged") as never)
				.mockResolvedValueOnce(landed(other, merge, "merged") as never);
			gateRuns(RECIPE);
			gateRuns(RECIPE);
			const again: CodeSiteCollected = { ...MADE, tree: "b".repeat(40), files: 4 };
			t.runs(passed(MADE), passed(again));
			vi.mocked(codeChecksPassed)
				.mockReturnValueOnce(result(head, "fast-forward", 1))
				.mockReturnValueOnce(result(merge, "merged", 2));
			expect(await t.land(head)).toMatchObject({ state: "merged", mainSha: merge, change: 7 });
			// Each run takes the site of its own candidate, as an attempt of its own.
			expect(t.runChecks.mock.calls.map(([input]) => [input.commit, input.attempt, input.site])).toEqual([
				[head, 1, RECIPE],
				[merge, 2, RECIPE],
			]);
			expect(t.reports()).toEqual([
				expect.objectContaining({
					mainAfter: merge,
					site: { state: "made", site: expect.objectContaining({ tree: "b".repeat(40), files: 4 }) },
				}),
			]);
			expect(t.wake).toHaveBeenCalledTimes(1);
		});

		it("takes the site in the run made again when the checks could not run, and wakes once", async () => {
			const t = await checked();
			const head = await t.f.commit(t.f.tree, "cart.js");
			lands(t, head, RECIPE);
			t.runs(NOT_RUN("CODE_CHECKS_MACHINE_STOPPED"), passed(MADE));
			expect(await t.land(head)).toMatchObject({ state: "fast-forward", change: 7 });
			expect(t.runChecks.mock.calls.map(([input]) => [input.attempt, input.site])).toEqual([
				[1, RECIPE],
				[2, RECIPE],
			]);
			expect(t.wake).toHaveBeenCalledTimes(1);
		});

		it("reports a candidate main already holds as unchanged, v2 with no checks, and wakes nothing for its site", async () => {
			const t = await checked();
			const head = await t.f.commit(t.f.tree, "cart.js");
			vi.mocked(landCodeBranch)
				.mockResolvedValueOnce(toCheck(t.baseSha, head) as never)
				.mockResolvedValueOnce({
					...landed(head, head),
					state: "unchanged",
					containedAt: head,
					diff: { filesChanged: 0, paths: [], pathsMore: 0 },
				} as never);
			gateRuns(RECIPE);
			t.runs(passed(MADE));
			vi.mocked(codeChecksPassed).mockReturnValueOnce(result(head, "fast-forward", 1));
			expect(await t.land(head)).toMatchObject({ state: "unchanged", mainSha: head });
			expect(t.reports()).toEqual([
				expect.objectContaining({ schema: "qorpera.code-change-report/v2", state: "unchanged", checks: null }),
			]);
			expect(t.reports()[0]).not.toHaveProperty("site");
			expect(t.wake).not.toHaveBeenCalled();
			expect(t.logged).toContainEqual(expect.objectContaining({ step: "landed", checks: null, site: null }));
		});

		it("lets a wake that throws change nothing of the landing", async () => {
			const t = await checked();
			const head = await t.f.commit(t.f.tree, "cart.js");
			lands(t, head, RECIPE);
			t.runs(passed(MADE));
			const thrown = new Error("CODE_SITE_PASS_GONE");
			t.wake.mockImplementationOnce(() => {
				throw thrown;
			});
			expect(await t.land(head)).toEqual({ state: "fast-forward", mainSha: head, filesChanged: 1, change: 7 });
			expect(t.wake).toHaveBeenCalledTimes(1);
			expect(t.logged).toContainEqual(
				expect.objectContaining({ event: "code-change-error", step: "wake", error: thrown }),
			);
		});

		it("lets a site the kernel would not take change nothing of the landing: the record says why it has no row", async () => {
			const t = await checked();
			const head = await t.f.commit(t.f.tree, "cart.js");
			lands(t, head, RECIPE);
			t.runs(passed({ ...MADE, tree: "not a tree" }));
			expect(await t.land(head)).toEqual({ state: "fast-forward", mainSha: head, filesChanged: 1, change: null });
			expect(t.recordChange).not.toHaveBeenCalled();
			expect(t.logged).toContainEqual(
				expect.objectContaining({
					event: "code-change-error",
					step: "report",
					error: new Error("INVALID_CODE_SITE"),
				}),
			);
		});

		it("gives the run the recipe part C1's real reader and gate read from the candidate's checks file", async () => {
			const t = await checked();
			const file = JSON.stringify({
				checks: CHECKS.map(({ name, run }) => ({ name, run })),
				site: { folder: "web/dist", title: "The shop" },
			});
			await mkdir(join(t.f.tree, ".qorpera"));
			await writeFile(join(t.f.tree, ".qorpera/checks.json"), file);
			await t.f.git(t.f.tree, "add", ".qorpera/checks.json");
			const head = await t.f.commit(t.f.tree, "cart.js");
			const recipe = { folder: "web/dist", name: null, title: "The shop" };
			t.runs(passed({ state: "made", tree: "e".repeat(40), files: 1, bytes: 12, ...recipe }));
			expect(await t.land(head)).toMatchObject({ state: "fast-forward", mainSha: head, change: 7 });
			expect(t.runChecks.mock.calls[0]?.[0].site).toEqual(recipe);
			expect(t.reports().at(-1)).toMatchObject({
				schema: "qorpera.code-change-report/v3",
				mainAfter: head,
				site: {
					state: "made",
					site: { schema: "qorpera.code-site/v1", tree: "e".repeat(40), files: 1, bytes: 12, ...recipe },
				},
			});
			expect(t.wake).toHaveBeenCalledTimes(1);
		});
	});

	describe("links from the root and an operator's drill, as the switch says them (own code storage, step 5)", () => {
		const RECIPE: CodeSiteRecipe = { folder: "dist", name: "gift-message", title: "Gift message" };
		const MADE: CodeSiteCollected = { state: "made", tree: "a".repeat(40), files: 3, bytes: 4_096, ...RECIPE };
		const OPENING = `${CODE_DRILL_WORDS} `;
		/** Job A then job B, the gate with `site`, and the row's checks for a run that passes. */
		const lands = (t: Awaited<ReturnType<typeof checked>>, head: string, site: CodeSiteRecipe | null) => {
			vi.mocked(landCodeBranch)
				.mockResolvedValueOnce(toCheck(t.baseSha, head) as never)
				.mockResolvedValueOnce(landed(t.baseSha, head) as never);
			gateRuns(site);
			vi.mocked(codeChecksPassed).mockReturnValueOnce(result(head, "fast-forward", 1));
		};
		/** The drill's own check failing, the last of the run, as the runner reports it. */
		const DRILL_FAILED: Extract<CodeChecksRun, { state: "failed" }> = {
			state: "failed",
			ms: 99_100,
			passed: [
				{ name: "install", ms: 38_000 },
				{ name: "test", ms: 59_000 },
			],
			failed: {
				name: CODE_CHECKS_DRILL.name,
				run: CODE_CHECKS_DRILL.run,
				ms: 100,
				exitCode: 1,
				atLimit: false,
				tail: "A drill by Qorpera's operator: this check fails on purpose, once.",
				log: "~/.qorpera-checks/0000000001-0001/out/3-qorpera-drill.log",
			},
			notRun: [],
		};

		it("lets the site's links from the root through only while the switch says so, in every run of the landing", async () => {
			const t = await checked(true, true, { rootLinks: true });
			const head = await t.f.commit(t.f.tree, "cart.js");
			lands(t, head, RECIPE);
			t.runs(NOT_RUN("CODE_CHECKS_MACHINE_STOPPED"), { ...PASSED, site: MADE });
			expect(await t.land(head)).toMatchObject({ state: "fast-forward", mainSha: head, change: 7 });
			expect(t.runChecks.mock.calls.map(([input]) => input)).toEqual([
				{ commit: head, checks: CHECKS, attempt: 1, site: RECIPE, rootLinks: true },
				{ commit: head, checks: CHECKS, attempt: 2, site: RECIPE, rootLinks: true },
			]);
			// Hosts off, a kernel before step 5 or an answer lost: no key at all, the input as before.
			const off = await checked(true, true);
			const next = await off.f.commit(off.f.tree, "cart.js");
			lands(off, next, RECIPE);
			off.runs({ ...PASSED, site: MADE });
			await off.land(next);
			expect(off.runChecks.mock.calls.map(([input]) => input)).toEqual([
				{ commit: next, checks: CHECKS, attempt: 1, site: RECIPE },
			]);
			expect(off.logged.filter((event) => event.step === "drill")).toEqual([]);
		});

		it("runs a check drill's check after the repository's own, and fails the turn on its own path with the drill's words first", async () => {
			const t = await checked(true, true, { drill: "check" });
			const head = await t.f.commit(t.f.tree, "cart.js");
			vi.mocked(landCodeBranch).mockResolvedValueOnce(toCheck(t.baseSha, head) as never);
			gateRuns(RECIPE);
			t.runs(DRILL_FAILED);
			const failed = await t.land(head).catch((e) => e);
			expect(failed).toBeInstanceOf(CodingLandRefused);
			expect(failed.message).toBe("CODING_CHECKS_FAILED");
			expect(t.runChecks.mock.calls.map(([input]) => input)).toEqual([
				{ commit: head, checks: [...CHECKS, CODE_CHECKS_DRILL], attempt: 1, site: RECIPE },
			]);
			// The failed check's words of part C1, the drill's first.
			expect(vi.mocked(codeChecksFailedSummary).mock.calls).toEqual([[DRILL_FAILED, "fast-forward", OPENING]]);
			expect(failed.summary.startsWith(`${OPENING}Nothing went into main: the check "qorpera-drill" failed`)).toBe(
				true,
			);
			expect(failed.summary).toMatch(/\[code=CODING_CHECKS_FAILED\]$/);
			// No job B, no row, main where it was; the log says the drill was taken and failed the run.
			expect(t.asked()).toHaveLength(1);
			expect(t.recordChange).not.toHaveBeenCalled();
			expect(t.logged.filter((event) => event.event === "code-checks")).toEqual([
				expect.objectContaining({ step: "drill", drill: "check" }),
				expect.objectContaining({ step: "failed", attempt: 1, exitCode: 1, drill: "check" }),
			]);
		});

		it("says nothing of a check drill when the repository's own check failed first, or one of its own has the drill's name", async () => {
			for (const ownFailed of [
				{
					...DRILL_FAILED,
					failed: { ...DRILL_FAILED.failed, name: "test", run: "npm test" },
					notRun: ["qorpera-drill"],
				},
				{ ...DRILL_FAILED, notRun: ["qorpera-drill"] },
				// A run that names no check after the failed one, which is not the drill's: not the drill's words either.
				{ ...DRILL_FAILED, failed: { ...DRILL_FAILED.failed, name: "test", run: "npm test" } },
			]) {
				const t = await checked(true, true, { drill: "check" });
				const head = await t.f.commit(t.f.tree, "cart.js");
				vi.mocked(landCodeBranch).mockResolvedValueOnce(toCheck(t.baseSha, head) as never);
				gateRuns();
				t.runs(ownFailed);
				const failed = await t.land(head).catch((e) => e);
				expect(failed.message).toBe("CODING_CHECKS_FAILED");
				expect(vi.mocked(codeChecksFailedSummary).mock.calls).toEqual([[ownFailed, "fast-forward"]]);
				expect(failed.summary.startsWith("Nothing went into main: the check")).toBe(true);
				expect(t.logged.at(-1)).not.toHaveProperty("drill");
			}
		});

		it("refuses a site drill's site itself once every check passed, on the site's path with the drill's words first", async () => {
			const t = await checked(true, true, { drill: "site" });
			const head = await t.f.commit(t.f.tree, "cart.js");
			vi.mocked(landCodeBranch).mockResolvedValueOnce(toCheck(t.baseSha, head) as never);
			gateRuns(RECIPE);
			t.runs({ ...PASSED, site: null });
			const refused = await t.land(head).catch((e) => e);
			expect(refused).toBeInstanceOf(CodingLandRefused);
			expect(refused.message).toBe("CODING_CHECKS_SITE_REFUSED");
			// The run takes no site: nothing the repository holds is collected for the drill.
			expect(t.runChecks.mock.calls.map(([input]) => input)).toEqual([
				{ commit: head, checks: CHECKS, attempt: 1, site: null },
			]);
			const problem = { code: "SITE_FOLDER_MISSING", path: null, variable: null } as const;
			expect(refused.summary).toBe(codeSiteRefusedSummary(problem, CODE_SITE_DRILL_FOLDER, OPENING));
			expect(refused.summary).toBe(
				`${CODE_DRILL_WORDS} Nothing went into main: every check passed, but the site in "qorpera-drill-missing" is not there (no folder of that name once the checks ran; a link is not followed). Fix it in the code or in the checks file's "site", and finish again. [code=CODING_CHECKS_SITE_REFUSED]`,
			);
			expect(t.recordChange).not.toHaveBeenCalled();
			expect(vi.mocked(landCodeBranch)).toHaveBeenCalledTimes(1);
			expect(t.logged.filter((event) => event.event === "code-checks")).toEqual([
				expect.objectContaining({ step: "drill", drill: "site" }),
				expect.objectContaining({ step: "site-refused", problem: "SITE_FOLDER_MISSING", drill: "site" }),
			]);
		});

		it("refuses a site drill even when the repository holds a folder of the drill's name with a site in it (review of #1774, F3)", async () => {
			// A repository with a qorpera-drill-missing/index.html of its own: the old drill's collect of that folder made a
			// site, and the change landed. The run answers so here (every check passed, a site made): the drill is still
			// refused, and nothing lands.
			const t = await checked(true, true, { drill: "site" });
			const head = await t.f.commit(t.f.tree, "cart.js");
			vi.mocked(landCodeBranch).mockResolvedValueOnce(toCheck(t.baseSha, head) as never);
			gateRuns(RECIPE);
			t.runs({ ...PASSED, site: MADE });
			const refused = await t.land(head).catch((e) => e);
			expect(refused).toBeInstanceOf(CodingLandRefused);
			expect(refused.message).toBe("CODING_CHECKS_SITE_REFUSED");
			expect(refused.summary.startsWith(`${CODE_DRILL_WORDS} `)).toBe(true);
			expect(t.runChecks.mock.calls.map(([input]) => input.site)).toEqual([null]);
			expect(vi.mocked(codeChecksPassed)).not.toHaveBeenCalled();
			expect(t.recordChange).not.toHaveBeenCalled();
			expect(vi.mocked(landCodeBranch)).toHaveBeenCalledTimes(1);
			expect(t.wake).not.toHaveBeenCalled();
			// A check that fails under a site drill is the code's own failure, in its own words: the drill acts on none.
			const failing = await checked(true, true, { drill: "site" });
			const next = await failing.f.commit(failing.f.tree, "cart.js");
			vi.mocked(landCodeBranch).mockResolvedValueOnce(toCheck(failing.baseSha, next) as never);
			gateRuns(RECIPE);
			failing.runs({ ...DRILL_FAILED, failed: { ...DRILL_FAILED.failed, name: "test", run: "npm test" } });
			const failed = await failing.land(next).catch((e) => e);
			expect(failed.message).toBe("CODING_CHECKS_FAILED");
			expect(failed.summary.startsWith(CODE_DRILL_WORDS)).toBe(false);
		});

		it("spends a drill that finds nothing to act on, and lands as before: no checks file, no site, sites off", async () => {
			// No checks file: one job, nothing run.
			const none = await checked(true, true, { drill: "check" });
			const head = await none.f.commit(none.f.tree, "cart.js");
			const real = await vi.importActual<typeof import("../src/code-host-jobs.ts")>("../src/code-host-jobs.ts");
			vi.mocked(landCodeBranch).mockImplementationOnce(async (job, value) => {
				const { checks: _checks, ...today } = value as typeof value & { checks?: true };
				return await real.landCodeBranch(job, today);
			});
			expect(await none.land(head)).toEqual({ state: "fast-forward", mainSha: head, filesChanged: 1, change: 7 });
			expect(none.runChecks).not.toHaveBeenCalled();
			expect(none.logged.filter((event) => event.event === "code-checks")).toEqual([
				expect.objectContaining({ step: "drill", drill: "check" }),
			]);
			// A site drill with no recipe, or with sites off: no site, the checks as they are; the change lands.
			for (const [sites, recipe] of [
				[true, null],
				[false, RECIPE],
			] as const) {
				const t = await checked(true, sites, { drill: "site" });
				const next = await t.f.commit(t.f.tree, "cart.js");
				lands(t, next, recipe);
				t.runs({ ...PASSED, site: null });
				expect(await t.land(next)).toMatchObject({ state: "fast-forward", mainSha: next, change: 7 });
				expect(t.runChecks.mock.calls.map(([input]) => input)).toEqual([
					{ commit: next, checks: CHECKS, attempt: 1, site: null },
				]);
			}
		});
	});
});
