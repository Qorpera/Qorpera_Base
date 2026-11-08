import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { CloudCodingRepository } from "@qorpera/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type CodeHostCommand,
	type CodeHostGcBlock,
	CodeHostJobFailure,
	CodeHostRefusal,
	exportCodeBranch,
} from "../src/code-host-jobs.ts";
import { CODE_HOST_EXPORT_MAXIMUM_BYTES, CodeHostRepositories } from "../src/code-host-repositories.ts";
import { attachCodeSession, type CodeAreaBroker } from "../src/code-host-seed.ts";
import type { CodeHostJobs } from "../src/code-host-views.ts";
import { type CodingSessionClaim, CodingWorkspaceFailed } from "../src/coding-executor.ts";
import type { CodingFolderRepositorySession } from "../src/coding-folder-repositories.ts";
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
	return { ...real, exportCodeBranch: vi.fn(real.exportCodeBranch) };
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
		repositories: new CodeHostRepositories(jobs),
		hold: (until: Promise<void>) => {
			hold = until;
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
		expect(await f.repositories.land(session, head, signal())).toEqual({ state: "fast-forward", mainSha: head });
		expect(f.calls).toEqual([]);
		expect(f.lent).not.toHaveBeenCalled();
		expect(vi.mocked(attachCodeSession)).not.toHaveBeenCalled();
		// A start of a GitHub repository, or a landing in one, is not this repository's.
		await expect(
			f.repositories.start({ claim: f.session.claim, assertAuthorized: f.authorized }, signal()),
		).rejects.toThrow("CODE_HOST_REPOSITORY_NOT_HERE");
		await expect(f.repositories.land(f.session, head, signal())).rejects.toThrow("CODE_HOST_REPOSITORY_NOT_HERE");
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
