import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { type CodeHostCommand, type CodeHostJob, readCodeAreaBase, seedCodeArea } from "../src/code-host-jobs.ts";
import { attachCodeSession, type CodeAreaBroker, withCodeAreaSeed } from "../src/code-host-seed.ts";
import { type CodingBrokerGitCommand, createCodingBrokerGitRunner } from "../src/coding-git.ts";
import { localShell } from "./helpers/code-host-shell.ts";

const exec = promisify(execFile),
	roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const GIT = "/usr/bin/git";
const TOKEN = "github_pat_fixture_token_1234567890";
const exists = (path: string) =>
	lstat(path).then(
		() => true,
		() => false,
	);
const signal = () => new AbortController().signal;
const isFetch = (call: CodingBrokerGitCommand) => call.args.includes("fetch");
const isBundle = (call: CodingBrokerGitCommand) => call.args.includes("bundle");

async function bytesOf(bundle: AsyncIterable<Uint8Array>): Promise<Buffer> {
	const parts: Buffer[] = [];
	for await (const part of bundle) parts.push(Buffer.from(part));
	return Buffer.concat(parts);
}
/** The commits a bundle needs the receiver to have already: its header's `-<sha>` lines. */
function prerequisites(bytes: Buffer): string[] {
	return bytes
		.subarray(0, bytes.indexOf("\n\n"))
		.toString("utf8")
		.split("\n")
		.filter((line) => line.startsWith("-"))
		.map((line) => line.slice(1, 41));
}

/** GitHub is a local repository, `source`: the broker's fetch of its main is the same git process unbundling it. */
async function fixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "code-host-seed-test-")));
	roots.push(root);
	const source = join(root, "source"),
		journalRoot = join(root, "journal");
	await mkdir(source);
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
	const src = (...args: string[]) => git(source, ...args);
	const commit = async (content: string) => {
		await writeFile(join(source, "README.md"), content);
		await src("add", "--all");
		await src("commit", "--quiet", "-m", content.trim());
		return src("rev-parse", "HEAD");
	};
	await src("init", "--quiet", "--template=", "--initial-branch=main", ".");
	const baseSha = await commit("one\n");
	const repository = { host: "github.com" as const, owner: "qorpera", name: "example", baseBranch: "main" };

	const calls: CodingBrokerGitCommand[] = [];
	const real = (command: CodingBrokerGitCommand): Promise<string> =>
		process.platform === "linux"
			? createCodingBrokerGitRunner({ bubblewrapPath: process.env.QORPERA_TEST_BWRAP })(command)
			: exec(GIT, [...command.args], { cwd: command.cwd, env: command.env }).then((result) => result.stdout);
	const state = {
		revoked: () => false,
		token: TOKEN,
		authorizations: 0,
		tokens: 0,
		fetch: async (command: CodingBrokerGitCommand): Promise<string> => {
			const incoming = join(command.scratchRoot, "github.bundle");
			await src("bundle", "create", "--quiet", incoming, "refs/heads/main");
			const local = { ...command, network: false, env: { ...command.env } };
			delete local.env.GIT_CONFIG_COUNT;
			delete local.env.GIT_CONFIG_KEY_0;
			delete local.env.GIT_CONFIG_VALUE_0;
			await real({ ...local, args: ["bundle", "unbundle", incoming] });
			return real({ ...local, args: ["update-ref", "refs/heads/main", await src("rev-parse", "main")] });
		},
	};
	const broker: CodeAreaBroker = {
		journalRoot,
		assertAuthorized: async () => {
			state.authorizations += 1;
			if (state.revoked()) throw new Error("revoked");
		},
		withRepositoryToken: async (_repository, use) => {
			state.tokens += 1;
			return use(state.token);
		},
		runGit: async (command) => {
			calls.push(command);
			if (!isFetch(command)) return real(command);
			expect(command.args.slice(-2)).toEqual([
				"https://github.com/qorpera/example.git",
				"refs/heads/main:refs/heads/main",
			]);
			return state.fetch(command);
		},
	};
	/** A company's code host: its own folder view and scratch disk. */
	const company = async () => {
		const companyRoot = join(root, "company", "folder"),
			scratchRoot = join(root, "company", "scratch");
		await mkdir(companyRoot, { recursive: true });
		await mkdir(scratchRoot, { recursive: true });
		const log: CodeHostCommand[] = [];
		const job: CodeHostJob = {
			shell: localShell(log),
			layout: { companyRoot, scratchRoot, git: GIT },
			signal: signal(),
		};
		const code = join(companyRoot, "code/qorpera/example");
		return { job, log, scratchRoot, code, repo: join(code, "repo.git") };
	};
	const heads = async (bytes: Buffer) => {
		const file = join(root, `${randomUUID()}.bundle`);
		await writeFile(file, bytes);
		return src("bundle", "list-heads", file);
	};
	return { root, journalRoot, git, src, commit, baseSha, repository, calls, state, broker, company, heads };
}

describe("the code area's seed from GitHub", () => {
	it("fetches the base branch on the broker's disk and hands over a complete bundle of exactly it; the token reaches only the fetch", async () => {
		const f = await fixture();
		const second = await f.commit("two\n");
		let during: string[] = [];
		const result = await withCodeAreaSeed(
			{ repository: f.repository, baseSha: f.baseSha, have: null },
			f.broker,
			signal(),
			async (seed) => {
				during = await readdir(f.journalRoot);
				return { headSha: seed.headSha, bytes: await bytesOf(seed.bundle) };
			},
		);
		expect(result.headSha).toBe(second);
		expect(await f.heads(result.bytes)).toBe(`${second} refs/heads/main`);
		expect(prerequisites(result.bytes)).toEqual([]);
		expect(result.bytes.includes(TOKEN)).toBe(false);
		expect(result.bytes.includes(Buffer.from(`x-access-token:${TOKEN}`).toString("base64"))).toBe(false);

		expect(during).toHaveLength(1);
		expect(during[0]).toMatch(/^\.code-seed-/);
		expect(await readdir(f.journalRoot)).toEqual([]);
		const scratch = join(f.journalRoot, during[0] ?? "");
		expect(f.calls.map((call) => call.args.slice(27).join(" "))).toEqual([
			`init --bare --template= ${scratch}/repo.git`,
			"fetch --quiet --no-tags --no-recurse-submodules --no-write-fetch-head https://github.com/qorpera/example.git refs/heads/main:refs/heads/main",
			"rev-parse --verify refs/heads/main^{commit}",
			`rev-list --ignore-missing --no-walk ${f.baseSha}`,
			`rev-list --count ${f.baseSha} ^${second}`,
			`fsck --strict --no-reflogs ${second}`,
			`bundle create --quiet ${scratch}/seed.bundle refs/heads/main`,
		]);
		for (const call of f.calls) {
			expect(call.args.slice(0, 3)).toEqual(["--no-replace-objects", "-c", "core.hooksPath=/dev/null"]);
			expect(call.scratchRoot).toBe(scratch);
			expect(call.env.HOME).toBe(scratch);
			expect(call.env.XDG_CONFIG_HOME).toBe(scratch);
			expect(call.network).toBe(isFetch(call));
			if (isFetch(call)) {
				expect(call.env.GIT_CONFIG_KEY_0).toBe("http.https://github.com/qorpera/example.git.extraHeader");
				expect(call.env.GIT_CONFIG_VALUE_0).toBe(
					`Authorization: Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString("base64")}`,
				);
			} else {
				expect(
					Object.keys(call.env).filter((key) => key.startsWith("GIT_CONFIG_") && key !== "GIT_CONFIG_NOSYSTEM"),
				).toEqual(["GIT_CONFIG_SYSTEM", "GIT_CONFIG_GLOBAL"]);
				expect(JSON.stringify(call)).not.toContain(TOKEN);
			}
		}
		expect(f.state.tokens).toBe(1);
		// Before the first process, around each one, before the token is taken, and before the bundle is handed over.
		expect(f.state.authorizations).toBe(1 + 2 * f.calls.length + 1 + 1);
	});

	it("leaves out what the code area has while the base branch reaches it, and sends it all otherwise", async () => {
		const f = await fixture();
		const second = await f.commit("two\n"),
			third = await f.commit("three\n");
		const seed = async (have: string | null) =>
			withCodeAreaSeed(
				{ repository: f.repository, baseSha: f.baseSha, have },
				f.broker,
				signal(),
				async (source) => ({
					headSha: source.headSha,
					bytes: await bytesOf(source.bundle),
				}),
			);
		expect(prerequisites((await seed(f.baseSha)).bytes)).toEqual([f.baseSha]);
		const thin = await seed(second);
		expect(prerequisites(thin.bytes)).toEqual([second]);
		expect(await f.heads(thin.bytes)).toBe(`${third} refs/heads/main`);
		// At the base branch already, or a commit GitHub does not have: the whole branch.
		expect(prerequisites((await seed(third)).bytes)).toEqual([]);
		expect(prerequisites((await seed("e".repeat(40))).bytes)).toEqual([]);
		// A base branch pushed back past the code area's base.
		await f.src("reset", "--quiet", "--hard", second);
		const back = await seed(third);
		expect(back.headSha).toBe(second);
		expect(prerequisites(back.bytes)).toEqual([]);

		// A code area at second takes the thin bundle of third.
		const c = await f.company();
		await seedCodeArea(c.job, { repository: f.repository, baseSha: second, bundle: back.bytes });
		await f.src("reset", "--quiet", "--hard", third);
		const updated = await withCodeAreaSeed(
			{ repository: f.repository, baseSha: f.baseSha, have: second },
			f.broker,
			signal(),
			(seed) => seedCodeArea(c.job, { repository: f.repository, baseSha: seed.headSha, bundle: seed.bundle }),
		);
		expect(updated).toEqual({ state: "updated", baseSha: third, restored: [] });
		expect(await readFile(join(c.code, "main/README.md"), "utf8")).toBe("three\n");
		expect(await readdir(f.journalRoot)).toEqual([]);
	});

	it("refuses a session base the base branch no longer reaches, and bundles nothing", async () => {
		const f = await fixture();
		const second = await f.commit("two\n");
		await f.src("reset", "--quiet", "--hard", f.baseSha);
		let used = false;
		const use = async () => {
			used = true;
		};
		for (const baseSha of [second, "f".repeat(40)])
			await expect(
				withCodeAreaSeed({ repository: f.repository, baseSha, have: null }, f.broker, signal(), use),
			).rejects.toMatchObject({ name: "CodeHostRefusal", code: "CODE_HOST_SEED_BASE_GONE", paths: [baseSha] });
		expect(used).toBe(false);
		expect(f.calls.some(isBundle)).toBe(false);
		expect(await readdir(f.journalRoot)).toEqual([]);
	});

	it("stops before any git process when authority is revoked, before the fetch when it ends while the token comes, and before handing over a bundle when it ends meanwhile", async () => {
		const f = await fixture();
		let used = false;
		const use = async () => {
			used = true;
		};
		const request = { repository: f.repository, baseSha: f.baseSha, have: null };
		f.state.revoked = () => true;
		await expect(withCodeAreaSeed(request, f.broker, signal(), use)).rejects.toMatchObject({
			name: "CodeHostJobFailure",
			code: "CODE_HOST_SEED_AUTHORITY_UNAVAILABLE",
		});
		expect(f.calls).toEqual([]);

		f.state.revoked = () => f.state.tokens > 0;
		await expect(withCodeAreaSeed(request, f.broker, signal(), use)).rejects.toMatchObject({
			name: "CodeHostJobFailure",
			code: "CODE_HOST_SEED_AUTHORITY_UNAVAILABLE",
		});
		expect(f.state.tokens).toBe(1);
		expect(f.calls.map((call) => call.args[27])).toEqual(["init"]);

		f.state.revoked = () => f.calls.some(isFetch);
		await expect(withCodeAreaSeed(request, f.broker, signal(), use)).rejects.toThrow(
			"CODE_HOST_SEED_AUTHORITY_UNAVAILABLE",
		);
		expect(f.calls.at(-1)?.args).toContain("fetch");

		f.calls.length = 0;
		f.state.revoked = () => f.calls.some(isBundle);
		await expect(withCodeAreaSeed(request, f.broker, signal(), use)).rejects.toThrow(
			"CODE_HOST_SEED_AUTHORITY_UNAVAILABLE",
		);
		expect(f.calls.at(-1)?.args).toContain("bundle");
		expect(used).toBe(false);
		expect(await readdir(f.journalRoot)).toEqual([]);
	});

	it("refuses a token that is not one before the fetch runs, and calls a failed git process unconfirmed", async () => {
		const f = await fixture();
		const request = { repository: f.repository, baseSha: f.baseSha, have: null };
		const use = async () => undefined;
		f.state.token = "short";
		await expect(withCodeAreaSeed(request, f.broker, signal(), use)).rejects.toThrow(
			"CODE_HOST_SEED_CREDENTIAL_UNAVAILABLE",
		);
		expect(f.calls.some(isFetch)).toBe(false);

		f.state.token = TOKEN;
		f.state.fetch = async () => {
			throw new Error(`CODING_GIT_PROCESS_UNCONFIRMED: fatal: could not read from ${TOKEN}`);
		};
		const failure = await withCodeAreaSeed(request, f.broker, signal(), use).catch((error: unknown) => error);
		expect(failure).toMatchObject({ name: "CodeHostJobFailure", code: "CODE_HOST_SEED_UNCONFIRMED", detail: "" });
		expect(String(failure)).not.toContain(TOKEN);
		expect(await readdir(f.journalRoot)).toEqual([]);
	});

	it("ends with its signal, not as a failed process, and removes the fetch", async () => {
		const f = await fixture();
		const request = { repository: f.repository, baseSha: f.baseSha, have: null };
		const before = new AbortController();
		before.abort(new Error("cancelled before"));
		await expect(withCodeAreaSeed(request, f.broker, before.signal, async () => undefined)).rejects.toThrow(
			"cancelled before",
		);
		expect(f.calls).toEqual([]);

		const during = new AbortController();
		f.state.fetch = async () => {
			during.abort(new Error("cancelled during"));
			throw new Error("CODING_GIT_PROCESS_UNCONFIRMED");
		};
		await expect(withCodeAreaSeed(request, f.broker, during.signal, async () => undefined)).rejects.toThrow(
			"cancelled during",
		);
		expect(await readdir(f.journalRoot)).toEqual([]);
	});

	it("takes only its own request, and a private broker directory", async () => {
		const f = await fixture();
		const use = async () => undefined;
		const request = { repository: f.repository, baseSha: f.baseSha, have: null };
		for (const bad of [
			{ ...request, extra: 1 },
			{ repository: f.repository, baseSha: f.baseSha },
			{ ...request, baseSha: "main" },
			{ ...request, baseSha: f.baseSha.toUpperCase() },
			{ ...request, have: "" },
			{ ...request, have: 1 },
		])
			await expect(withCodeAreaSeed(bad as unknown as typeof request, f.broker, signal(), use)).rejects.toThrow(
				"INVALID_CODE_HOST_JOB",
			);
		await expect(
			withCodeAreaSeed({ ...request, repository: { ...f.repository, owner: "../x" } }, f.broker, signal(), use),
		).rejects.toThrow("INVALID_CODING_REPOSITORY");
		await chmod(f.journalRoot, 0o750);
		await expect(withCodeAreaSeed(request, f.broker, signal(), use)).rejects.toThrow(
			"LXD_OFFICE_JOURNAL_DIRECTORY_UNSAFE",
		);
		expect(f.calls).toEqual([]);
		expect(f.state.tokens).toBe(0);
	});
});

describe("a session's attach", () => {
	it("seeds a new code area from the base branch as it is now, adds the worktree at the session's base, and seeds only for a base it lacks", async () => {
		const f = await fixture(),
			c = await f.company();
		const second = await f.commit("two\n");
		const a = randomUUID(),
			b = randomUUID(),
			d = randomUUID();
		expect(
			await attachCodeSession(c.job, { repository: f.repository, workerId: a, baseSha: f.baseSha }, f.broker),
		).toEqual({ seeded: "seeded", state: "added", headSha: f.baseSha, restored: [] });
		// The code area takes GitHub's base, never the older session's.
		expect(await readCodeAreaBase(c.job, f.repository)).toBe(second);
		expect(await readFile(join(c.code, "main/README.md"), "utf8")).toBe("two\n");
		expect(await readFile(join(c.code, `worktrees/${a}/README.md`), "utf8")).toBe("one\n");
		expect(f.calls.filter(isFetch)).toHaveLength(1);

		expect(
			await attachCodeSession(c.job, { repository: f.repository, workerId: a, baseSha: f.baseSha }, f.broker),
		).toEqual({ seeded: null, state: "present", headSha: f.baseSha, restored: [] });
		expect(
			await attachCodeSession(c.job, { repository: f.repository, workerId: b, baseSha: second }, f.broker),
		).toEqual({ seeded: null, state: "added", headSha: second, restored: [] });
		expect(f.calls.filter(isFetch)).toHaveLength(1);

		const third = await f.commit("three\n");
		f.calls.length = 0;
		expect(
			await attachCodeSession(c.job, { repository: f.repository, workerId: d, baseSha: third }, f.broker),
		).toEqual({ seeded: "updated", state: "added", headSha: third, restored: [] });
		expect(f.calls.find(isBundle)?.args.slice(-2)).toEqual(["refs/heads/main", `^${second}`]);
		expect(await readCodeAreaBase(c.job, f.repository)).toBe(third);
		expect(await readFile(join(c.code, `worktrees/${b}/README.md`), "utf8")).toBe("two\n");
		expect(await readdir(c.scratchRoot)).toEqual([]);
		expect(await readdir(f.journalRoot)).toEqual([]);
	});

	it("seeds again while main/ is not at the base, and refuses a base the base branch no longer reaches", async () => {
		const f = await fixture(),
			c = await f.company();
		const a = randomUUID(),
			b = randomUUID(),
			e = randomUUID();
		await attachCodeSession(c.job, { repository: f.repository, workerId: a, baseSha: f.baseSha }, f.broker);
		await rm(join(c.code, "main"), { recursive: true, force: true });
		const again = await attachCodeSession(
			c.job,
			{ repository: f.repository, workerId: b, baseSha: f.baseSha },
			f.broker,
		);
		expect(again).toMatchObject({ seeded: "unchanged", state: "added", headSha: f.baseSha });
		expect(again.restored).toContain("code/qorpera/example/main");
		expect(await readFile(join(c.code, "main/README.md"), "utf8")).toBe("one\n");

		// A session's base that a force push took off the base branch, and the code area never held.
		const dropped = await f.commit("dropped\n");
		await f.src("reset", "--quiet", "--hard", f.baseSha);
		await expect(
			attachCodeSession(c.job, { repository: f.repository, workerId: e, baseSha: dropped }, f.broker),
		).rejects.toMatchObject({ code: "CODE_HOST_SEED_BASE_GONE", paths: [dropped] });
		expect(await exists(join(c.code, `worktrees/${e}`))).toBe(false);
		expect(await readCodeAreaBase(c.job, f.repository)).toBe(f.baseSha);
	});

	it("refuses a present worktree whose branch is gone", async () => {
		const f = await fixture(),
			c = await f.company();
		const a = randomUUID();
		await attachCodeSession(c.job, { repository: f.repository, workerId: a, baseSha: f.baseSha }, f.broker);
		await f.git(c.repo, "--git-dir=.", "update-ref", "-d", `refs/heads/qorpera/coding/${a}`);
		await expect(
			attachCodeSession(c.job, { repository: f.repository, workerId: a, baseSha: f.baseSha }, f.broker),
		).rejects.toMatchObject({
			name: "CodeHostRefusal",
			code: "CODE_HOST_WORKTREE_NO_BRANCH",
			paths: [`code/qorpera/example/worktrees/${a}`],
		});
	});

	it("takes only a session's own keys, before any command", async () => {
		const f = await fixture(),
			c = await f.company();
		const value = { repository: f.repository, workerId: randomUUID(), baseSha: f.baseSha };
		for (const bad of [
			{ ...value, extra: 1 },
			{ ...value, workerId: "worker" },
			{ ...value, baseSha: "main" },
			{ repository: f.repository, baseSha: f.baseSha },
		])
			await expect(attachCodeSession(c.job, bad as typeof value, f.broker)).rejects.toThrow("INVALID_CODE_HOST_JOB");
		expect(c.log).toEqual([]);
		expect(f.calls).toEqual([]);
	});
});
