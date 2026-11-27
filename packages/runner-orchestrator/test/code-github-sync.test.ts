import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CodeGitHubSync,
	type CodeGitHubSyncRequest,
	codeGitHubSyncOutcomeOf,
	codeGitHubSyncRequestOf,
} from "../src/code-github-sync.ts";
import {
	CODE_AREA_IN_QORPERA_REF,
	type CodeHostCommand,
	type CodeHostGcBlock,
	type CodeHostLayout,
	startCodeArea,
} from "../src/code-host-jobs.ts";
import type { CodeHostJobs } from "../src/code-host-views.ts";
import type { CodingRepositoryCredentials } from "../src/coding-executor-host.ts";
import type { CodingBrokerGitCommand } from "../src/coding-git.ts";
import { localShell } from "./helpers/code-host-shell.ts";

const exec = promisify(execFile);
const GIT = "/usr/bin/git";
const COMPANY = "11111111-1111-4111-8111-111111111111";
const ENVIRONMENT = "22222222-2222-4222-8222-222222222222";
const REQUEST = "33333333-3333-4333-8333-333333333333";
const TOKEN = "44444444-4444-4444-8444-444444444444";
const GH_TOKEN = "ghp_1234567890abcdef1234567890abcdef1234";
const BLOCK: CodeHostGcBlock = {
	begin: async () => ({ state: "blocking", held: 0 }),
	end: async () => undefined,
};
const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function gitEnv(home: string): Record<string, string> {
	return {
		PATH: "/usr/bin:/bin",
		HOME: home,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_SYSTEM: "/dev/null",
		GIT_AUTHOR_NAME: "Test",
		GIT_AUTHOR_EMAIL: "test@example.invalid",
		GIT_COMMITTER_NAME: "Test",
		GIT_COMMITTER_EMAIL: "test@example.invalid",
	};
}

async function runBrokerGitLocally(remoteBareDir: string, command: CodingBrokerGitCommand): Promise<string> {
	const args = command.args.map((arg) =>
		arg === "https://github.com/acme/shop.git" ? `file://${remoteBareDir}` : arg,
	);
	const env = command.network ? { ...command.env, GIT_ALLOW_PROTOCOL: "file" } : command.env;
	return new Promise<string>((resolve, reject) => {
		const child = spawn(GIT, args, {
			cwd: command.cwd,
			env,
			stdio: [command.input ? "pipe" : "ignore", "pipe", "pipe"],
			signal: command.signal,
		});
		const out: Buffer[] = [];
		let errText = "";
		let failed = false;
		child.stdout?.on("data", (chunk: Buffer) => {
			if (command.output) {
				try {
					command.output.write(chunk);
				} catch {
					failed = true;
					child.kill("SIGKILL");
				}
				return;
			}
			out.push(chunk);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			errText += chunk.toString("utf8");
		});
		child.stdin?.on("error", () => undefined);
		child.stdin?.end(command.input);
		child.once("error", reject);
		child.once("close", (status) => {
			if (failed || status !== 0) reject(new Error(errText.trim() || `git exited ${status ?? 1}`));
			else resolve(Buffer.concat(out).toString("utf8"));
		});
	});
}

async function setupFixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "code-github-sync-test-")));
	roots.push(root);
	const companyRoot = join(root, "company");
	const scratchRoot = join(root, "scratch");
	const journalRoot = join(root, "journal");
	const remoteBare = join(root, "remote.git");
	const workDir = join(root, "work");
	await Promise.all([mkdir(companyRoot), mkdir(scratchRoot), mkdir(journalRoot, { mode: 0o700 }), mkdir(workDir)]);
	const env = gitEnv(root);
	const layout: CodeHostLayout = { companyRoot, scratchRoot, git: GIT };
	const shellLog: CodeHostCommand[] = [];
	const shell = localShell(shellLog);

	const hosts: Pick<CodeHostJobs, "run"> = {
		run: async (_companyId, _environmentId, signal, fn) => fn({ shell, layout, signal }, BLOCK),
	};

	await startCodeArea(
		{ shell, layout, signal: new AbortController().signal },
		{ repository: { host: "qorpera", owner: "company", name: "shop", baseBranch: "main" } },
	);

	const localRepo = join(companyRoot, "code/company/shop/repo.git");
	const initClone = await mkdtemp(join(root, "local-init-"));
	await exec(GIT, ["clone", "--quiet", `file://${localRepo}`, initClone], {
		cwd: root,
		env: { ...env, GIT_ALLOW_PROTOCOL: "file" },
	});
	await writeFile(join(initClone, "README.md"), "initial\n", "utf8");
	await exec(GIT, ["-C", initClone, "add", "README.md"], { cwd: root, env });
	await exec(GIT, ["-C", initClone, "commit", "--quiet", "-m", "Initial commit"], { cwd: root, env });
	const initialMain = (await exec(GIT, ["-C", initClone, "rev-parse", "HEAD"], { cwd: root, env })).stdout.trim();
	await exec(GIT, ["-C", initClone, "push", "--quiet", `file://${localRepo}`, "main:refs/heads/main"], {
		cwd: root,
		env: { ...env, GIT_ALLOW_PROTOCOL: "file" },
	});

	await exec(GIT, ["init", "--bare", "--template=", "--initial-branch=main", remoteBare], { cwd: root, env });
	await exec(
		GIT,
		["--git-dir", localRepo, "push", "--quiet", `file://${remoteBare}`, "refs/heads/main:refs/heads/main"],
		{
			cwd: root,
			env: { ...env, GIT_ALLOW_PROTOCOL: "file" },
		},
	);
	await exec(GIT, ["clone", "--quiet", `file://${remoteBare}`, workDir], {
		cwd: root,
		env: { ...env, GIT_ALLOW_PROTOCOL: "file" },
	});

	const commitOnRemote = async (branch: string, files: Record<string, string>, message: string): Promise<string> => {
		await exec(GIT, ["-C", workDir, "fetch", "--quiet", "origin"], {
			cwd: root,
			env: { ...env, GIT_ALLOW_PROTOCOL: "file" },
		});
		const remoteExists = await exec(GIT, ["-C", workDir, "show-ref", "--verify", `refs/remotes/origin/${branch}`], {
			cwd: root,
			env,
		}).catch(() => null);
		if (remoteExists) {
			await exec(GIT, ["-C", workDir, "checkout", "--quiet", "-B", branch, `origin/${branch}`], { cwd: root, env });
		} else {
			await exec(GIT, ["-C", workDir, "checkout", "--quiet", "-B", branch], { cwd: root, env });
		}
		for (const [rel, content] of Object.entries(files)) {
			const full = join(workDir, rel);
			await mkdir(join(full, ".."), { recursive: true });
			await writeFile(full, content, "utf8");
		}
		await exec(GIT, ["-C", workDir, "add", "-A"], { cwd: root, env });
		await exec(GIT, ["-C", workDir, "commit", "--quiet", "-m", message], { cwd: root, env });
		await exec(GIT, ["-C", workDir, "push", "--quiet", "origin", `${branch}:${branch}`], {
			cwd: root,
			env: { ...env, GIT_ALLOW_PROTOCOL: "file" },
		});
		return (await exec(GIT, ["-C", workDir, "rev-parse", "HEAD"], { cwd: root, env })).stdout.trim();
	};

	const commitOnLocal = async (branch: string, files: Record<string, string>, message: string): Promise<string> => {
		const scratchClone = await mkdtemp(join(root, "local-edit-"));
		await exec(GIT, ["clone", "--quiet", `file://${localRepo}`, scratchClone], {
			cwd: root,
			env: { ...env, GIT_ALLOW_PROTOCOL: "file" },
		});
		const exists = await exec(GIT, ["-C", scratchClone, "show-ref", "--verify", `refs/heads/${branch}`], {
			cwd: root,
			env,
		}).catch(() => null);
		if (exists) {
			await exec(GIT, ["-C", scratchClone, "checkout", "--quiet", branch], { cwd: root, env });
		} else {
			await exec(GIT, ["-C", scratchClone, "checkout", "--quiet", "-b", branch], { cwd: root, env });
		}
		for (const [rel, content] of Object.entries(files)) {
			const full = join(scratchClone, rel);
			await mkdir(join(full, ".."), { recursive: true });
			await writeFile(full, content, "utf8");
		}
		await exec(GIT, ["-C", scratchClone, "add", "-A"], { cwd: root, env });
		await exec(GIT, ["-C", scratchClone, "commit", "--quiet", "-m", message], { cwd: root, env });
		const sha = (await exec(GIT, ["-C", scratchClone, "rev-parse", "HEAD"], { cwd: root, env })).stdout.trim();
		await exec(
			GIT,
			["-C", scratchClone, "push", "--quiet", `file://${localRepo}`, `${branch}:refs/heads/${branch}`],
			{
				cwd: root,
				env: { ...env, GIT_ALLOW_PROTOCOL: "file" },
			},
		);
		return sha;
	};

	const credentials: CodingRepositoryCredentials = {
		withRepositoryToken: vi.fn(async (_scope, _repo, use) => use(GH_TOKEN)),
	};

	const fetchMock = vi.fn<typeof fetch>();
	const syncer = new CodeGitHubSync({
		hosts,
		credentials,
		journalRoot,
		runGit: (command) => runBrokerGitLocally(remoteBare, command),
		fetch: fetchMock,
	});

	const baseRequest = {
		kind: "github_sync" as const,
		requestId: REQUEST,
		token: TOKEN,
		companyId: COMPANY,
		environmentId: ENVIRONMENT,
		owner: "company",
		name: "shop",
		githubRepo: "acme/shop",
		githubOwner: "acme",
		githubName: "shop",
	};

	return {
		syncer,
		localRepo,
		remoteBare,
		initialMain,
		commitOnRemote,
		commitOnLocal,
		credentials,
		fetchMock,
		baseRequest,
		inQorperaRef: CODE_AREA_IN_QORPERA_REF,
	};
}

describe("codeGitHubSyncRequestOf / codeGitHubSyncOutcomeOf", () => {
	it("parses valid requests for all four ops and rejects invalid shapes", () => {
		const common = {
			kind: "github_sync",
			requestId: REQUEST,
			token: TOKEN,
			companyId: COMPANY,
			environmentId: ENVIRONMENT,
			owner: "company",
			name: "shop",
		};
		expect(
			codeGitHubSyncRequestOf({
				...common,
				op: "sync",
				githubSync: { githubRepo: "acme/shop", remoteBranch: "main" },
			}),
		).toMatchObject({ op: "sync", githubRepo: "acme/shop", remoteBranch: "main" });
		expect(
			codeGitHubSyncRequestOf({
				...common,
				op: "push",
				githubSync: { githubRepo: "acme/shop", remoteBranch: "feat/a", localRef: "refs/heads/main" },
			}),
		).toMatchObject({ op: "push", allowDefaultBranch: false });
		expect(
			codeGitHubSyncRequestOf({
				...common,
				op: "create_pr",
				githubSync: { githubRepo: "acme/shop", headBranch: "feat/a", baseBranch: "main", title: "Ship feature" },
			}),
		).toMatchObject({ op: "create_pr", draft: false });
		expect(() =>
			codeGitHubSyncRequestOf({ ...common, op: "sync", githubSync: { githubRepo: "bad", remoteBranch: "main" } }),
		).toThrow("CODE_REQUEST_INVALID");
		expect(() => codeGitHubSyncOutcomeOf({ schema: "bad", state: "busy" })).toThrow(
			"CODE_GITHUB_SYNC_OUTCOME_INVALID",
		);
	});
});

describe("CodeGitHubSync", () => {
	it("syncs remote branch status, reports ahead/behind/diverged, and handles missing remote branch", async () => {
		const f = await setupFixture();
		const remoteSha = await f.commitOnRemote("main", { "remote.txt": "from github\n" }, "Remote change");
		const localSha = await f.commitOnLocal("main", { "local.txt": "from qorpera\n" }, "Local change");

		const synced = await f.syncer.run(
			{ ...f.baseRequest, op: "sync", remoteBranch: "main" },
			new AbortController().signal,
		);
		expect(synced).toEqual({
			schema: "qorpera.code-request-outcome/v1",
			state: "done",
			result: "synced",
			githubRepo: "acme/shop",
			remoteBranch: "main",
			remoteSha,
			mainSha: localSha,
			ahead: 1,
			behind: 1,
			diverged: true,
		});

		const missing = await f.syncer.run(
			{ ...f.baseRequest, op: "sync", remoteBranch: "does-not-exist" },
			new AbortController().signal,
		);
		expect(missing).toMatchObject({
			state: "done",
			result: "synced",
			remoteBranch: "does-not-exist",
			remoteSha: null,
			behind: 0,
			diverged: false,
		});
	});

	it("pulls fast-forward, merges non-conflicting divergence, and refuses conflicting pulls", async () => {
		const f = await setupFixture();
		const remoteFf = await f.commitOnRemote("main", { "a.txt": "ff\n" }, "Remote FF");

		const ff = await f.syncer.run(
			{ ...f.baseRequest, op: "pull", remoteBranch: "main" },
			new AbortController().signal,
		);
		expect(ff).toEqual({
			schema: "qorpera.code-request-outcome/v1",
			state: "done",
			result: "pulled",
			githubRepo: "acme/shop",
			remoteBranch: "main",
			mainBefore: f.initialMain,
			mainAfter: remoteFf,
			remoteSha: remoteFf,
			mode: "fast-forward",
			commitsPulled: 1,
		});

		const unchanged = await f.syncer.run(
			{ ...f.baseRequest, op: "pull", remoteBranch: "main" },
			new AbortController().signal,
		);
		expect(unchanged).toMatchObject({ state: "done", result: "pulled", mode: "unchanged", commitsPulled: 0 });

		await f.commitOnLocal("main", { "local-only.txt": "local\n" }, "Local side");
		const remoteDiv = await f.commitOnRemote("main", { "remote-only.txt": "remote\n" }, "Remote side");
		const merged = await f.syncer.run(
			{ ...f.baseRequest, op: "pull", remoteBranch: "main" },
			new AbortController().signal,
		);
		expect(merged).toMatchObject({
			state: "done",
			result: "pulled",
			mode: "merged",
			remoteSha: remoteDiv,
			commitsPulled: 1,
		});

		await f.commitOnLocal("main", { "README.md": "local edit\n" }, "Local conflict");
		await f.commitOnRemote("main", { "README.md": "remote edit\n" }, "Remote conflict");
		const conflict = await f.syncer.run(
			{ ...f.baseRequest, op: "pull", remoteBranch: "main" },
			new AbortController().signal,
		);
		expect(conflict).toMatchObject({
			state: "refused",
			code: "GITHUB_SYNC_CONFLICT",
			paths: ["README.md"],
		});
	});

	it("guards default branch, enforces fast-forward, scans for secrets and .env files, and pushes clean branches", async () => {
		const f = await setupFixture();
		const featSha = await f.commitOnLocal("feat/clean", { "feature.ts": "export const ok = true;\n" }, "Add feature");

		const protectedDefault = await f.syncer.run(
			{
				...f.baseRequest,
				op: "push",
				localRef: "refs/heads/feat/clean",
				remoteBranch: "main",
				allowDefaultBranch: false,
			},
			new AbortController().signal,
		);
		expect(protectedDefault).toMatchObject({
			state: "refused",
			code: "GITHUB_SYNC_DEFAULT_BRANCH_PROTECTED",
		});

		const pushed = await f.syncer.run(
			{
				...f.baseRequest,
				op: "push",
				localRef: "refs/heads/feat/clean",
				remoteBranch: "feat/clean",
				allowDefaultBranch: false,
			},
			new AbortController().signal,
		);
		expect(pushed).toEqual({
			schema: "qorpera.code-request-outcome/v1",
			state: "done",
			result: "pushed",
			githubRepo: "acme/shop",
			localRef: "refs/heads/feat/clean",
			remoteBranch: "feat/clean",
			headSha: featSha,
			previousRemoteSha: null,
			created: true,
		});

		await f.commitOnRemote("feat/clean", { "remote-ahead.txt": "diverged\n" }, "Remote moved");
		const nonFf = await f.syncer.run(
			{
				...f.baseRequest,
				op: "push",
				localRef: "refs/heads/feat/clean",
				remoteBranch: "feat/clean",
				allowDefaultBranch: false,
			},
			new AbortController().signal,
		);
		expect(nonFf).toMatchObject({ state: "refused", code: "GITHUB_SYNC_NON_FAST_FORWARD" });

		await f.commitOnLocal("feat/env-leak", { ".env": "API_KEY=plain\n" }, "Accidentally commit env");
		const envLeak = await f.syncer.run(
			{
				...f.baseRequest,
				op: "push",
				localRef: "refs/heads/feat/env-leak",
				remoteBranch: "feat/env-leak",
				allowDefaultBranch: false,
			},
			new AbortController().signal,
		);
		expect(envLeak).toMatchObject({
			state: "refused",
			code: "GITHUB_SYNC_SECRET_DETECTED",
			paths: [".env"],
		});

		await f.commitOnLocal("feat/key-leak", { "config.ts": `export const k = "${GH_TOKEN}";\n` }, "Leak token");
		const keyLeak = await f.syncer.run(
			{
				...f.baseRequest,
				op: "push",
				localRef: "refs/heads/feat/key-leak",
				remoteBranch: "feat/key-leak",
				allowDefaultBranch: false,
			},
			new AbortController().signal,
		);
		expect(keyLeak).toMatchObject({
			state: "refused",
			code: "GITHUB_SYNC_SECRET_DETECTED",
			paths: ["config.ts"],
		});
	});

	it("creates GitHub pull requests, recovers idempotently on 422 already-exists, and surfaces other 422 refusals", async () => {
		const f = await setupFixture();
		f.fetchMock
			.mockResolvedValueOnce(
				Response.json(
					{
						number: 23,
						html_url: "https://github.com/acme/shop/pull/23",
						state: "open",
						title: "Ship billing",
						draft: true,
						head: { ref: "feat/billing", sha: "a".repeat(40) },
						base: { ref: "main" },
						updated_at: "2026-11-27T14:00:00Z",
					},
					{ status: 201 },
				),
			)
			.mockResolvedValueOnce(
				Response.json(
					{
						message: "Validation Failed",
						errors: [{ message: "A pull request already exists for acme:feat/billing." }],
					},
					{ status: 422 },
				),
			)
			.mockResolvedValueOnce(
				Response.json(
					[
						{
							number: 23,
							html_url: "https://github.com/acme/shop/pull/23",
							state: "open",
							title: "Ship billing",
							draft: true,
							head: { ref: "feat/billing", sha: "a".repeat(40) },
							base: { ref: "main" },
							updated_at: "2026-11-27T14:00:00Z",
						},
					],
					{ status: 200 },
				),
			)
			.mockResolvedValueOnce(
				Response.json(
					{ message: "Validation Failed", errors: [{ message: "No commits between main and feat/empty" }] },
					{ status: 422 },
				),
			);

		const req: CodeGitHubSyncRequest = {
			...f.baseRequest,
			op: "create_pr",
			headBranch: "feat/billing",
			baseBranch: "main",
			title: "Ship billing",
			body: "Details",
			draft: true,
			sessionId: "93800000-0000-4000-8000-000000000009",
		};
		const created = await f.syncer.run(req, new AbortController().signal);
		expect(created).toEqual({
			schema: "qorpera.code-request-outcome/v1",
			state: "done",
			result: "pr_created",
			githubRepo: "acme/shop",
			number: 23,
			url: "https://github.com/acme/shop/pull/23",
			prState: "open",
			headBranch: "feat/billing",
			baseBranch: "main",
			title: "Ship billing",
			headSha: "a".repeat(40),
			draft: true,
			updatedAt: "2026-11-27T14:00:00Z",
			sessionId: "93800000-0000-4000-8000-000000000009",
		});

		const retried = await f.syncer.run(req, new AbortController().signal);
		expect(retried).toEqual(created);

		const refused = await f.syncer.run(
			{ ...req, headBranch: "feat/empty", sessionId: undefined },
			new AbortController().signal,
		);
		expect(refused).toEqual({
			schema: "qorpera.code-request-outcome/v1",
			state: "refused",
			code: "GITHUB_SYNC_PR_REFUSED",
			messages: ["No commits between main and feat/empty"],
		});
	});
});
