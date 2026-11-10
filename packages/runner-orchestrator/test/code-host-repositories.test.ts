import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { CloudCodingRepository } from "@qorpera/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	addCodeWorktree,
	type CodeHostCommand,
	type CodeHostGcBlock,
	type CodeHostJob,
	CodeHostJobFailure,
	CodeHostRefusal,
	exportCodeBranch,
	landCodeBranch,
	retireCodeWorktrees,
	startCodeArea,
} from "../src/code-host-jobs.ts";
import {
	CODE_CHANGE_RECORD_MS,
	CODE_HOST_EXPORT_MAXIMUM_BYTES,
	CODE_RESTORING,
	CodeHostRepositories,
	type CodeHostRepositoriesOptions,
} from "../src/code-host-repositories.ts";
import { attachCodeSession, type CodeAreaBroker } from "../src/code-host-seed.ts";
import type { CodeHostJobs } from "../src/code-host-views.ts";
import {
	CodingLandConflict,
	CodingLandRefused,
	type CodingSessionClaim,
	CodingWorkspaceFailed,
} from "../src/coding-executor.ts";
import type { CodeChangeReport, CodingFolderRepositorySession } from "../src/coding-folder-repositories.ts";
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
			/^The change was not landed, and nothing changed on main: it holds names in one folder that differ only by upper and lower case: .*"Cart\.js".*Rename them so that each is its own name, commit and finish again\.$/,
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
		expect(CODE_HOST_EXPORT_MAXIMUM_BYTES).toBe(64 * 1024 ** 2);
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
	const SCHEMA = "qorpera.code-change-report/v1";

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
		});
		// Exactly the keys the kernel takes.
		expect(Object.keys(report ?? {}).sort()).toEqual([
			"filesChanged",
			"headSha",
			"how",
			"inLine",
			"mainAfter",
			"mainBefore",
			"paths",
			"pathsMore",
			"picture",
			"refusal",
			"schema",
			"state",
		]);
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
