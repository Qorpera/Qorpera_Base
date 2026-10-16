import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
	addCodeWorktree,
	CODE_AREA_CONFIG,
	type CodeCommitSource,
	type CodeHostCommand,
	type CodeHostGcBlock,
	type CodeHostJob,
	codeAreaPath,
	collectCodeGarbage,
	exportCodeBranch,
	inspectCodeArea,
	readCodeAreaBase,
	seedCodeArea,
	withCodeCommit,
} from "../src/code-host-jobs.ts";
import { localShell } from "./helpers/code-host-shell.ts";

const exec = promisify(execFile),
	roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const GIT = "/usr/bin/git";
const exists = (path: string) =>
	lstat(path).then(
		() => true,
		() => false,
	);

async function fixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "code-host-test-")));
	roots.push(root);
	const source = join(root, "source");
	await mkdir(source);
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
	const commit = async (files: Record<string, string>, message = "change") => {
		for (const [path, content] of Object.entries(files)) {
			await mkdir(dirname(join(source, path)), { recursive: true });
			await writeFile(join(source, path), content);
		}
		await src("add", "--all");
		await src("commit", "--quiet", "-m", message);
		return src("rev-parse", "HEAD");
	};
	const bundle = async (...revs: string[]) => {
		const file = join(root, `${randomUUID()}.bundle`);
		await src("bundle", "create", "--quiet", file, ...revs);
		return readFile(file);
	};
	await src("init", "--quiet", "--template=", "--initial-branch=main", ".");
	const baseSha = await commit({ "README.md": "one\n" }, "one");
	/** A company's code host: its own folder view and scratch disk. */
	const company = async (name = "company") => {
		const companyRoot = join(root, name, "folder"),
			scratchRoot = join(root, name, "scratch");
		await mkdir(companyRoot, { recursive: true });
		await mkdir(scratchRoot, { recursive: true });
		const log: CodeHostCommand[] = [];
		const job: CodeHostJob = {
			shell: localShell(log),
			layout: { companyRoot, scratchRoot, git: GIT },
			signal: new AbortController().signal,
		};
		const code = join(companyRoot, "code/qorpera/example");
		return { job, log, companyRoot, scratchRoot, code, repo: join(code, "repo.git") };
	};
	const repository = { host: "github.com" as const, owner: "qorpera", name: "example", baseBranch: "main" };
	return { root, env, git, src, commit, bundle, baseSha, company, repository };
}

describe("code host seed", () => {
	it("seeds a code area and main/, updates it, and leaves an unchanged base alone", async () => {
		const f = await fixture(),
			c = await f.company();
		expect(await readCodeAreaBase(c.job, f.repository)).toBeNull();
		const seeded = await seedCodeArea(c.job, {
			repository: f.repository,
			baseSha: f.baseSha,
			bundle: await f.bundle("refs/heads/main"),
		});
		expect(seeded).toEqual({ state: "seeded", baseSha: f.baseSha, restored: [] });
		expect(await readFile(join(c.repo, "config"), "utf8")).toBe(CODE_AREA_CONFIG);
		expect(await f.git(c.repo, "--git-dir=.", "rev-parse", "refs/heads/main")).toBe(f.baseSha);
		expect(await readFile(join(c.code, "main/README.md"), "utf8")).toBe("one\n");
		expect(await readFile(join(c.code, "main/.git"), "utf8")).toBe(`gitdir: ${c.repo}/worktrees/main\n`);
		expect(await exists(join(c.repo, "worktrees/main/locked"))).toBe(true);
		expect(await exists(join(c.repo, "hooks"))).toBe(false);
		expect(await readdir(c.scratchRoot)).toEqual([]);

		const second = await f.commit({ "README.md": "two\n" }, "two");
		const updated = await seedCodeArea(c.job, {
			repository: f.repository,
			baseSha: second,
			bundle: await f.bundle("main", `^${f.baseSha}`),
		});
		expect(updated).toEqual({ state: "updated", baseSha: second, restored: [] });
		expect(await readFile(join(c.code, "main/README.md"), "utf8")).toBe("two\n");
		expect(await readCodeAreaBase(c.job, f.repository)).toBe(second);

		await writeFile(join(c.code, "main/.git"), "gitdir: /elsewhere\n");
		const again = await seedCodeArea(c.job, {
			repository: f.repository,
			baseSha: second,
			bundle: (async function* () {
				yield await f.bundle("refs/heads/main");
			})(),
		});
		expect(again).toEqual({ state: "unchanged", baseSha: second, restored: ["code/qorpera/example/main/.git"] });
		expect(await readFile(join(c.code, "main/.git"), "utf8")).toBe(`gitdir: ${c.repo}/worktrees/main\n`);
		expect(await readdir(c.scratchRoot)).toEqual([]);
	});

	it("inspects the code area: its base, main/ at it, and whether it holds a commit", async () => {
		const f = await fixture(),
			c = await f.company();
		const inspect = (commit: string) => inspectCodeArea(c.job, { repository: f.repository, commit });
		expect(await inspect(f.baseSha)).toEqual({ base: null, ready: false, holds: false, restored: [] });
		await seedCodeArea(c.job, { repository: f.repository, baseSha: f.baseSha, bundle: await f.bundle("main") });
		expect(await inspect(f.baseSha)).toEqual({ base: f.baseSha, ready: true, holds: true, restored: [] });
		const second = await f.commit({ "README.md": "two\n" }, "two");
		expect(await inspect(second)).toEqual({ base: f.baseSha, ready: true, holds: false, restored: [] });
		await writeFile(join(c.code, "main/.git"), "gitdir: /elsewhere\n");
		expect(await inspect(f.baseSha)).toEqual({
			base: f.baseSha,
			ready: true,
			holds: true,
			restored: ["code/qorpera/example/main/.git"],
		});
		await rm(join(c.code, "main"), { recursive: true });
		expect(await inspect(f.baseSha)).toEqual({ base: f.baseSha, ready: false, holds: true, restored: [] });
		await expect(inspectCodeArea(c.job, { repository: f.repository, commit: "main" })).rejects.toThrow(
			"INVALID_CODE_HOST_JOB",
		);
	});

	it("refuses a seed whose names are not NFC, naming the path, before anything reaches the folder", async () => {
		const f = await fixture(),
			c = await f.company();
		const name = "café.txt";
		const head = await f.commit({ [name]: "x\n" });
		await expect(
			seedCodeArea(c.job, { repository: f.repository, baseSha: head, bundle: await f.bundle("refs/heads/main") }),
		).rejects.toMatchObject({ code: "CODE_HOST_NAMES_NOT_NFC", paths: [name] });
		expect(await exists(c.repo)).toBe(false);
		expect(await readdir(c.scratchRoot)).toEqual([]);
	});

	it("refuses names in one folder that differ only by case, naming all of them", async () => {
		const f = await fixture(),
			c = await f.company();
		const head = await f.commit({ "Readme.md": "x\n", "src/A.ts": "a\n", "src/a.ts": "b\n", "src/b.ts": "c\n" });
		const refusal = seedCodeArea(c.job, {
			repository: f.repository,
			baseSha: head,
			bundle: await f.bundle("refs/heads/main"),
		});
		await expect(refusal).rejects.toMatchObject({ code: "CODE_HOST_NAMES_DIFFER_BY_CASE" });
		const paths = await refusal.catch((error) => error.paths);
		expect([...paths].sort()).toEqual(["README.md", "Readme.md", "src/A.ts", "src/a.ts"]);
		expect(await exists(c.repo)).toBe(false);
	});

	it("refuses a bundle of another branch or commit, an incomplete first seed, and a worker branch as base", async () => {
		const f = await fixture(),
			c = await f.company();
		await f.src("branch", "other");
		await expect(
			seedCodeArea(c.job, {
				repository: f.repository,
				baseSha: f.baseSha,
				bundle: await f.bundle("refs/heads/other"),
			}),
		).rejects.toMatchObject({ code: "CODE_HOST_SEED_HEADS" });
		await expect(
			seedCodeArea(c.job, {
				repository: f.repository,
				baseSha: "f".repeat(40),
				bundle: await f.bundle("refs/heads/main"),
			}),
		).rejects.toMatchObject({ code: "CODE_HOST_SEED_HEADS" });
		const second = await f.commit({ "b.txt": "b\n" });
		await expect(
			seedCodeArea(c.job, {
				repository: f.repository,
				baseSha: second,
				bundle: await f.bundle("main", `^${f.baseSha}`),
			}),
		).rejects.toMatchObject({ code: "CODE_HOST_SEED_INCOMPLETE" });
		expect(await exists(c.repo)).toBe(false);
		const commands = c.log.length;
		for (const baseBranch of [
			"qorpera",
			"qorpera/coding",
			`qorpera/coding/${randomUUID()}`,
			"QORPERA",
			"Qorpera/Coding",
			`QORPERA/coding/${randomUUID().toUpperCase()}`,
		])
			await expect(
				seedCodeArea(c.job, {
					repository: { ...f.repository, baseBranch },
					baseSha: f.baseSha,
					bundle: await f.bundle("refs/heads/main"),
				}),
			).rejects.toMatchObject({ code: "CODE_HOST_BASE_IS_A_WORKER_BRANCH" });
		expect(c.log).toHaveLength(commands);
	});

	it("moves the base and main/ together: a seed racing one that holds the base fails, and main/ ends at the base", async () => {
		const { f, c } = await seeded();
		const unchanged = await f.bundle("refs/heads/main"),
			second = await f.commit({ "README.md": "two\n" }, "two"),
			toSecond = await f.bundle("main", `^${f.baseSha}`),
			third = await f.commit({ "README.md": "three\n" }, "three"),
			toThird = await f.bundle("main", `^${f.baseSha}`);
		const paused = join(f.root, "paused"),
			release = join(f.root, "release"),
			slow = join(f.root, "slow-git"),
			quick = join(f.root, "quick-git");
		// A's git stops at main/'s checkout, inside its transaction, until the test lets it go.
		await writeFile(
			slow,
			`#!/bin/sh\nfor a do [ "$a" = checkout ] && { : >"${paused}"; while [ ! -e "${release}" ]; do sleep 0.05; done; break; }; done\nexec ${GIT} "$@"\n`,
		);
		// B's git gives up on a held lock at once rather than after the settings' 10 s.
		await writeFile(quick, `#!/bin/sh\nexec ${GIT} -c core.filesRefLockTimeout=0 "$@"\n`);
		await chmod(slow, 0o755);
		await chmod(quick, 0o755);
		const a = { ...c.job, layout: { ...c.job.layout, git: slow } },
			b = { ...c.job, layout: { ...c.job.layout, git: quick } };
		const first = seedCodeArea(a, { repository: f.repository, baseSha: second, bundle: toSecond });
		let settled = false;
		void first
			.catch(() => {})
			.finally(() => {
				settled = true;
			});
		try {
			while (!settled && !(await exists(paused))) await delay(20);
			// A seed that ended before its checkout fails here with its own error, not at the test's timeout.
			if (settled) await first;
			expect(await exists(paused)).toBe(true);
			await expect(
				seedCodeArea(b, { repository: f.repository, baseSha: third, bundle: toThird }),
			).rejects.toMatchObject({ code: "CODE_HOST_BASE_MOVED" });
			// An unchanged base takes the lock too.
			await expect(
				seedCodeArea(b, { repository: f.repository, baseSha: f.baseSha, bundle: unchanged }),
			).rejects.toMatchObject({ code: "CODE_HOST_BASE_MOVED" });
		} finally {
			await writeFile(release, "");
		}
		expect(await first).toEqual({ state: "updated", baseSha: second, restored: [] });
		expect(await readFile(join(c.code, "main/README.md"), "utf8")).toBe("two\n");
		expect(await readCodeAreaBase(c.job, f.repository)).toBe(second);
		expect(await seedCodeArea(b, { repository: f.repository, baseSha: third, bundle: toThird })).toEqual({
			state: "updated",
			baseSha: third,
			restored: [],
		});
		expect(await readFile(join(c.code, "main/README.md"), "utf8")).toBe("three\n");
		expect(await readdir(c.scratchRoot)).toEqual([]);

		// A seed stopped between the two: the base is not reported, and the next seed of it moves main/.
		await writeFile(join(c.repo, "worktrees/main/HEAD"), `${second}\n`);
		expect(await readCodeAreaBase(c.job, f.repository)).toBeNull();
		expect(
			await seedCodeArea(c.job, {
				repository: f.repository,
				baseSha: third,
				bundle: await f.bundle("refs/heads/main"),
			}),
		).toEqual({ state: "unchanged", baseSha: third, restored: [] });
		expect(await readFile(join(c.repo, "worktrees/main/HEAD"), "utf8")).toBe(`${third}\n`);
		expect(await readCodeAreaBase(c.job, f.repository)).toBe(third);

		// A half-made main/ is made again, under the same lock.
		await rm(join(c.repo, "worktrees/main"), { recursive: true });
		expect(await readCodeAreaBase(c.job, f.repository)).toBeNull();
		expect(
			await seedCodeArea(c.job, {
				repository: f.repository,
				baseSha: third,
				bundle: await f.bundle("refs/heads/main"),
			}),
		).toEqual({ state: "unchanged", baseSha: third, restored: ["code/qorpera/example/main"] });
		expect(await readFile(join(c.code, "main/.git"), "utf8")).toBe(`gitdir: ${c.repo}/worktrees/main\n`);
		expect(await readCodeAreaBase(c.job, f.repository)).toBe(third);
	});

	it("makes repo.git again when it has no HEAD, keeping its base ref and objects for the compare-and-swap", async () => {
		const { f, c } = await seeded();
		// A seed that stopped after the folder published its base ref (with the ref's lease) and before its HEAD (at the
		// job's end): git takes repo.git for no repository, and so does every job but a seed.
		await rm(join(c.repo, "HEAD"));
		expect(await readCodeAreaBase(c.job, f.repository)).toBeNull();
		expect(await inspectCodeArea(c.job, { repository: f.repository, commit: f.baseSha })).toEqual({
			base: null,
			ready: false,
			holds: false,
			restored: [],
		});
		await expect(
			addCodeWorktree(c.job, { repository: f.repository, workerId: randomUUID(), baseSha: f.baseSha }),
		).rejects.toMatchObject({ code: "CODE_HOST_NOT_SEEDED" });
		const second = await f.commit({ "README.md": "two\n" }, "two");
		expect(
			await seedCodeArea(c.job, {
				repository: f.repository,
				baseSha: second,
				bundle: await f.bundle("refs/heads/main"),
			}),
		).toEqual({ state: "updated", baseSha: second, restored: ["code/qorpera/example/repo.git/HEAD"] });
		expect(await readFile(join(c.repo, "HEAD"), "utf8")).toBe("ref: refs/heads/main\n");
		expect(await readFile(join(c.repo, "config"), "utf8")).toBe(CODE_AREA_CONFIG);
		expect(await readFile(join(c.code, "main/README.md"), "utf8")).toBe("two\n");
		expect(await readCodeAreaBase(c.job, f.repository)).toBe(second);

		// HEAD is a file the platform writes, never a link.
		await rm(join(c.repo, "HEAD"));
		await symlink("refs/heads/main", join(c.repo, "HEAD"));
		await expect(readCodeAreaBase(c.job, f.repository)).rejects.toMatchObject({
			code: "CODE_HOST_LINK",
			paths: ["code/qorpera/example/repo.git/HEAD"],
		});
	});

	it("reports git's own error when main/ fails, without git's advice, and leaves the base where it was", async () => {
		const { f, c } = await seeded();
		const second = await f.commit({ "README.md": "two\n" }, "two"),
			failing = join(f.root, "failing-git");
		// main/'s checkout reads the new base (with GIT_GRAFT_FILE at /dev/null, git's grafts advice is given for the first
		// commit a process reads), then fails.
		await writeFile(
			failing,
			`#!/bin/sh\nfor a do [ "$a" = checkout ] && { ${GIT} "$@"; echo "checkout refused" >&2; exit 1; }; done\nexec ${GIT} "$@"\n`,
		);
		await chmod(failing, 0o755);
		await expect(
			seedCodeArea(
				{ ...c.job, layout: { ...c.job.layout, git: failing } },
				{ repository: f.repository, baseSha: second, bundle: await f.bundle("main", `^${f.baseSha}`) },
			),
		).rejects.toMatchObject({ code: "CODE_HOST_MAIN_FAILED", detail: "checkout refused\n" });
		expect(await f.git(c.repo, "--git-dir=.", "rev-parse", "refs/heads/main")).toBe(f.baseSha);
	});

	it("refuses a link on the way to the code area", async () => {
		const f = await fixture(),
			c = await f.company();
		await mkdir(join(c.companyRoot, "code"));
		await mkdir(join(f.root, "elsewhere"));
		await symlink(join(f.root, "elsewhere"), join(c.companyRoot, "code/qorpera"));
		await expect(
			seedCodeArea(c.job, {
				repository: f.repository,
				baseSha: f.baseSha,
				bundle: await f.bundle("refs/heads/main"),
			}),
		).rejects.toMatchObject({ code: "CODE_HOST_LINK", paths: ["code/qorpera"] });
		expect(await readdir(join(f.root, "elsewhere"))).toEqual([]);
	});
});

async function seeded() {
	const f = await fixture(),
		c = await f.company();
	await seedCodeArea(c.job, {
		repository: f.repository,
		baseSha: f.baseSha,
		bundle: await f.bundle("refs/heads/main"),
	});
	return { f, c };
}

describe("code host worktrees", () => {
	it("adds and locks a session's worktree, finds it again, keeps its branch, and refuses a half one", async () => {
		const { f, c } = await seeded(),
			workerId = randomUUID(),
			tree = join(c.code, "worktrees", workerId),
			admin = join(c.repo, "worktrees", workerId);
		const input = { repository: f.repository, workerId, baseSha: f.baseSha };
		expect(await addCodeWorktree(c.job, input)).toEqual({ state: "added", headSha: f.baseSha, restored: [] });
		expect(await readFile(join(tree, "README.md"), "utf8")).toBe("one\n");
		expect(await readFile(join(tree, ".git"), "utf8")).toBe(`gitdir: ${admin}\n`);
		expect(await readFile(join(admin, "gitdir"), "utf8")).toBe(`${tree}/.git\n`);
		expect(await exists(join(admin, "locked"))).toBe(true);
		expect(await addCodeWorktree(c.job, input)).toEqual({ state: "present", headSha: f.baseSha, restored: [] });

		// The session commits, then its machine and both directories go; the branch stays.
		await writeFile(join(tree, "README.md"), "session\n");
		await f.git(tree, "commit", "--quiet", "-am", "session");
		const head = await f.git(tree, "rev-parse", "HEAD");
		await rm(tree, { recursive: true });
		await expect(addCodeWorktree(c.job, input)).rejects.toMatchObject({
			code: "CODE_HOST_WORKTREE_INCOMPLETE",
			paths: [`code/qorpera/example/repo.git/worktrees/${workerId}`],
		});
		await rm(admin, { recursive: true });
		expect(await addCodeWorktree(c.job, input)).toEqual({ state: "added", headSha: head, restored: [] });
		expect(await readFile(join(tree, "README.md"), "utf8")).toBe("session\n");

		await writeFile(join(tree, ".git"), "gitdir: /elsewhere\n");
		await expect(addCodeWorktree(c.job, input)).rejects.toMatchObject({ code: "CODE_HOST_WORKTREE_CHANGED" });
	});

	it("gives every spelling of a repository the one lower-case code area", async () => {
		const f = await fixture(),
			c = await f.company(),
			spelled = { ...f.repository, owner: "Qorpera", name: "Example.Web_1" },
			lower = { ...f.repository, name: "example.web_1" };
		expect(codeAreaPath(spelled)).toBe("code/qorpera/example.web_1");
		expect(codeAreaPath(f.repository)).toBe("code/qorpera/example");
		expect(() => codeAreaPath({ ...f.repository, owner: "-qorpera" })).toThrow();
		const code = join(c.companyRoot, "code/qorpera/example.web_1"),
			bundle = await f.bundle("refs/heads/main");
		expect(await seedCodeArea(c.job, { repository: spelled, baseSha: f.baseSha, bundle })).toMatchObject({
			state: "seeded",
		});
		expect(await readdir(join(c.companyRoot, "code"))).toEqual(["qorpera"]);
		expect(await readdir(join(c.companyRoot, "code/qorpera"))).toEqual(["example.web_1"]);
		expect(await inspectCodeArea(c.job, { repository: lower, commit: f.baseSha })).toMatchObject({
			base: f.baseSha,
			ready: true,
			holds: true,
		});
		const workerId = randomUUID();
		expect(await addCodeWorktree(c.job, { repository: lower, workerId, baseSha: f.baseSha })).toMatchObject({
			state: "added",
		});
		expect(
			await addCodeWorktree(c.job, { repository: { ...spelled, owner: "QORPERA" }, workerId, baseSha: f.baseSha }),
		).toMatchObject({ state: "present" });
		expect(await readFile(join(code, "worktrees", workerId, ".git"), "utf8")).toBe(
			`gitdir: ${code}/repo.git/worktrees/${workerId}\n`,
		);
	});

	it("refuses a worktree before the first seed", async () => {
		const f = await fixture(),
			c = await f.company();
		await expect(
			addCodeWorktree(c.job, { repository: f.repository, workerId: randomUUID(), baseSha: f.baseSha }),
		).rejects.toMatchObject({ code: "CODE_HOST_NOT_SEEDED" });
	});
});

describe("code host export", () => {
	it("exports the submitted commit without what the base reaches, and nothing for a commit with none beyond it", async () => {
		const { f, c } = await seeded(),
			workerId = randomUUID(),
			tree = join(c.code, "worktrees", workerId);
		await addCodeWorktree(c.job, { repository: f.repository, workerId, baseSha: f.baseSha });
		const input = { repository: f.repository, workerId, baseSha: f.baseSha };
		const options = { maximumBytes: 64 * 1024 ** 2 };
		expect(await exportCodeBranch(c.job, { ...input, headSha: f.baseSha }, options)).toEqual({
			headSha: f.baseSha,
			bundle: null,
		});
		await writeFile(join(tree, "work.txt"), "work\n");
		await f.git(tree, "add", "work.txt");
		await f.git(tree, "commit", "--quiet", "-m", "work");
		const submitted = await f.git(tree, "rev-parse", "HEAD");
		// The session goes on after it submitted: the export still holds what was submitted.
		await writeFile(join(tree, "more.txt"), "more\n");
		await f.git(tree, "add", "more.txt");
		await f.git(tree, "commit", "--quiet", "-m", "more");
		const later = await f.git(tree, "rev-parse", "HEAD");
		const branch = `refs/heads/qorpera/coding/${workerId}`;
		const exported = await exportCodeBranch(c.job, { ...input, headSha: submitted }, options);
		expect(exported.headSha).toBe(submitted);
		if (!exported.bundle) throw new Error("no bundle");
		const file = join(f.root, "export.bundle"),
			empty = join(f.root, "empty.git");
		await writeFile(file, exported.bundle);
		await f.git(f.root, "init", "--quiet", "--bare", "--template=", empty);
		expect(await f.git(empty, "bundle", "list-heads", file)).toBe(`${submitted} ${branch}`);
		// Thin: it needs the base, which GitHub holds, and carries nothing the base reaches.
		expect(exported.bundle.toString("latin1")).toContain(`\n-${f.baseSha}`);
		await expect(f.git(empty, "bundle", "verify", "--quiet", file)).rejects.toThrow();
		await f.git(empty, "fetch", "--quiet", await bundleFile(f, "refs/heads/main"), "refs/heads/main:refs/heads/main");
		await f.git(empty, "fetch", "--quiet", file, `${branch}:${branch}`);
		expect(await f.git(empty, "rev-parse", branch)).toBe(submitted);
		expect(await f.git(empty, "show", `${branch}:work.txt`)).toBe("work");
		await expect(f.git(empty, "cat-file", "-e", later)).rejects.toThrow();
		// The code area gets no ref of the export's, and the scratch is gone.
		expect((await f.git(c.repo, "for-each-ref", "--format=%(refname)")).split("\n")).toEqual([
			"refs/heads/main",
			branch,
		]);
		expect(await readdir(c.scratchRoot)).toEqual([]);

		await expect(
			exportCodeBranch(c.job, { ...input, headSha: submitted }, { maximumBytes: 10 }),
		).rejects.toMatchObject({ code: "CODE_HOST_EXPORT_TOO_LARGE" });
	});

	it("refuses another field, a missing or symbolic branch, an unknown base, and a commit the branch no longer holds", async () => {
		const { f, c } = await seeded(),
			workerId = randomUUID(),
			tree = join(c.code, "worktrees", workerId);
		const input = { repository: f.repository, workerId, baseSha: f.baseSha };
		const options = { maximumBytes: 1024 ** 2 };
		const commands = c.log.length;
		await expect(
			exportCodeBranch(
				c.job,
				{ ...input, headSha: f.baseSha, branch: `qorpera/coding/${workerId}` } as never,
				options,
			),
		).rejects.toThrow("INVALID_CODE_HOST_JOB");
		expect(c.log).toHaveLength(commands);
		await expect(exportCodeBranch(c.job, { ...input, headSha: f.baseSha }, options)).rejects.toMatchObject({
			code: "CODE_HOST_EXPORT_NO_BRANCH",
		});

		await addCodeWorktree(c.job, input);
		await writeFile(join(tree, "work.txt"), "work\n");
		await f.git(tree, "add", "work.txt");
		await f.git(tree, "commit", "--quiet", "-m", "work");
		const dropped = await f.git(tree, "rev-parse", "HEAD");
		await expect(
			exportCodeBranch(c.job, { ...input, baseSha: "e".repeat(40), headSha: dropped }, options),
		).rejects.toMatchObject({ code: "CODE_HOST_BASE_UNKNOWN", paths: ["e".repeat(40)] });
		await f.git(tree, "reset", "--quiet", "--hard", f.baseSha);
		for (const headSha of [dropped, "f".repeat(40)])
			await expect(exportCodeBranch(c.job, { ...input, headSha }, options)).rejects.toMatchObject({
				code: "CODE_HOST_EXPORT_MOVED",
				paths: [`refs/heads/qorpera/coding/${workerId}`],
			});

		const other = randomUUID();
		await mkdir(join(c.repo, "refs/heads/qorpera/coding"), { recursive: true });
		await writeFile(join(c.repo, "refs/heads/qorpera/coding", other), "ref: refs/heads/main\n");
		await expect(
			exportCodeBranch(c.job, { ...input, workerId: other, headSha: f.baseSha }, options),
		).rejects.toMatchObject({ code: "CODE_HOST_REF_IS_SYMBOLIC" });
	});
});

async function bundleFile(f: Awaited<ReturnType<typeof fixture>>, ...revs: string[]) {
	const file = join(f.root, `${randomUUID()}.bundle`);
	await writeFile(file, await f.bundle(...revs));
	return file;
}

describe("code host gc", () => {
	function block(answers: ({ state: "blocking"; held: number } | { state: "busy" })[]) {
		const calls: string[] = [];
		const gc: CodeHostGcBlock = {
			begin: async (repository) => {
				calls.push(`begin ${repository}`);
				return answers.length > 1 ? (answers.shift() as (typeof answers)[number]) : answers[0];
			},
			end: async (repository) => {
				calls.push(`end ${repository}`);
			},
		};
		return { gc, calls };
	}

	it("holds new leases in repo.git until none is held, packs every ref but the sessions', and releases them", async () => {
		const { f, c } = await seeded(),
			workerId = randomUUID();
		await addCodeWorktree(c.job, { repository: f.repository, workerId, baseSha: f.baseSha });
		const { gc, calls } = block([
			{ state: "blocking", held: 2 },
			{ state: "blocking", held: 1 },
			{ state: "blocking", held: 0 },
		]);
		const slept: number[] = [];
		const result = await collectCodeGarbage(c.job, { repository: f.repository }, gc, {
			pollMs: 7,
			sleep: async (ms) => {
				slept.push(ms);
			},
		});
		expect(result).toEqual({ state: "collected", restored: [] });
		const area = "code/qorpera/example";
		expect(calls).toEqual([`begin ${area}`, `begin ${area}`, `begin ${area}`, `end ${area}`]);
		expect(slept).toEqual([7, 7]);
		const packed = await readFile(join(c.repo, "packed-refs"), "utf8");
		expect(packed).toContain(`${f.baseSha} refs/heads/main`);
		expect(packed).not.toContain("qorpera/coding");
		expect(await exists(join(c.repo, "refs/heads/main"))).toBe(false);
		expect(await readFile(join(c.repo, "refs/heads/qorpera/coding", workerId), "utf8")).toBe(`${f.baseSha}\n`);
		expect(await f.git(c.repo, "--git-dir=.", "fsck", "--no-progress", "--no-dangling")).toBe("");
		expect(await readdir(c.scratchRoot)).toEqual([]);
	});

	it("skips with no end when another view holds the block, and ends a block whose wait ran out", async () => {
		const { f, c } = await seeded();
		const busy = block([{ state: "busy" }]);
		expect(await collectCodeGarbage(c.job, { repository: f.repository }, busy.gc)).toEqual({ state: "busy" });
		expect(busy.calls).toEqual(["begin code/qorpera/example"]);
		expect(await exists(join(c.repo, "packed-refs"))).toBe(false);

		const held = block([{ state: "blocking", held: 1 }]);
		let clock = 0;
		const result = await collectCodeGarbage(c.job, { repository: f.repository }, held.gc, {
			maximumWaitMs: 15,
			now: () => {
				clock += 10;
				return clock;
			},
			sleep: async () => {},
		});
		expect(result).toEqual({ state: "held", held: 1 });
		expect(held.calls).toEqual([
			"begin code/qorpera/example",
			"begin code/qorpera/example",
			"end code/qorpera/example",
		]);
		expect(await exists(join(c.repo, "packed-refs"))).toBe(false);
	});

	it("refuses gc while repo.git/shallow exists, and still ends the block", async () => {
		const { f, c } = await seeded();
		await writeFile(join(c.repo, "shallow"), `${f.baseSha}\n`);
		const { gc, calls } = block([{ state: "blocking", held: 0 }]);
		await expect(collectCodeGarbage(c.job, { repository: f.repository }, gc)).rejects.toMatchObject({
			code: "CODE_HOST_GC_SHALLOW",
		});
		expect(calls).toEqual(["begin code/qorpera/example", "end code/qorpera/example"]);
	});
});

describe("code host git ignores the repository's settings", () => {
	it("runs no hook, filter, include or worktree config set in the repository or a session's config.worktree", async () => {
		const { f, c } = await seeded(),
			workerId = randomUUID();
		await addCodeWorktree(c.job, { repository: f.repository, workerId, baseSha: f.baseSha });
		const markers = join(f.root, "markers"),
			evil = join(f.root, "evil-hooks");
		await mkdir(markers);
		await mkdir(evil);
		const hook = (name: string) => `#!/bin/sh\ntouch "${markers}/${name}"\ncat >/dev/null 2>&1 || true\n`;
		for (const name of ["post-checkout", "reference-transaction", "pre-auto-gc", "post-rewrite"]) {
			await writeFile(join(evil, name), hook(`included-${name}`));
			await chmod(join(evil, name), 0o755);
			await mkdir(join(c.repo, "hooks"), { recursive: true });
			await writeFile(join(c.repo, "hooks", name), hook(`repository-${name}`));
			await chmod(join(c.repo, "hooks", name), 0o755);
		}
		await writeFile(join(evil, "fsmonitor"), hook("fsmonitor"));
		await chmod(join(evil, "fsmonitor"), 0o755);
		await writeFile(join(f.root, "evil.cfg"), `[core]\n\thooksPath = ${evil}\n`);
		const filter = (name: string) => `[filter "x"]\n\tsmudge = "touch ${markers}/${name} && cat"\n\tclean = cat\n`;
		await writeFile(
			join(c.repo, "config"),
			`${CODE_AREA_CONFIG}[include]\n\tpath = ${f.root}/evil.cfg\n[extensions]\n\tworktreeConfig = true\n${filter("repository-filter")}[core]\n\tfsmonitor = ${evil}/fsmonitor\n\tworktree = ${f.root}/elsewhere\n`,
		);
		await writeFile(
			join(c.repo, "config.worktree"),
			`[core]\n\thooksPath = ${evil}\n${filter("bare-worktree-filter")}`,
		);
		await writeFile(
			join(c.repo, "worktrees/main/config.worktree"),
			`[core]\n\thooksPath = ${evil}\n${filter("main-filter")}`,
		);
		await writeFile(
			join(c.repo, "worktrees", workerId, "config.worktree"),
			`[core]\n\thooksPath = ${evil}\n${filter("session-filter")}`,
		);
		// What was planted is live for a git without the code host's settings.
		expect(await f.git(f.root, `--git-dir=${c.repo}`, "config", "--includes", "--get", "core.hooksPath")).toBe(evil);

		const second = await f.commit({ ".gitattributes": "* filter=x\n", "b.txt": "b\n" });
		const updated = await seedCodeArea(c.job, {
			repository: f.repository,
			baseSha: second,
			bundle: await f.bundle("main", `^${f.baseSha}`),
		});
		expect(updated.state).toBe("updated");
		expect([...updated.restored].sort()).toEqual([
			"code/qorpera/example/repo.git/config",
			"code/qorpera/example/repo.git/config.worktree",
			"code/qorpera/example/repo.git/worktrees/main/config.worktree",
		]);
		expect(await readFile(join(c.repo, "config"), "utf8")).toBe(CODE_AREA_CONFIG);
		expect(await readFile(join(c.code, "main/b.txt"), "utf8")).toBe("b\n");

		// Plant the repository's settings again for the other jobs.
		await writeFile(
			join(c.repo, "config"),
			`${CODE_AREA_CONFIG}[include]\n\tpath = ${f.root}/evil.cfg\n[extensions]\n\tworktreeConfig = true\n${filter("repository-filter")}`,
		);
		const other = randomUUID();
		const added = await addCodeWorktree(c.job, { repository: f.repository, workerId: other, baseSha: second });
		expect(added).toMatchObject({ state: "added", restored: ["code/qorpera/example/repo.git/config"] });
		expect(await readFile(join(c.code, "worktrees", other, "b.txt"), "utf8")).toBe("b\n");
		const exported = await exportCodeBranch(
			c.job,
			{ repository: f.repository, workerId: other, baseSha: f.baseSha, headSha: second },
			{ maximumBytes: 1024 ** 2 },
		);
		expect(exported.bundle).not.toBeNull();
		await collectCodeGarbage(
			c.job,
			{ repository: f.repository },
			{
				begin: async () => ({ state: "blocking", held: 0 }),
				end: async () => {},
			},
		);
		expect(await readdir(markers)).toEqual([]);
		for (const command of c.log) {
			expect(command.env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
			expect(command.argv.length).toBeLessThanOrEqual(64);
			if (command.argv[0] === GIT) expect(command.argv[2]).toMatch(/^--git-dir=\//);
		}
	});
});

describe("code host commit reads", () => {
	it("reads one commit's files by path: a file, something else, nothing, and a file cut after maxBytes + 1", async () => {
		const f = await fixture(),
			c = await f.company();
		const files: Record<string, string> = {
			".qorpera/environment.json": '{"install":"make"}\n',
			".devcontainer/devcontainer.json/inside": "x\n",
			"docker/Dockerfile": "FROM scratch\n",
			"big.txt": "0123456789".repeat(10),
			// Names git would quote in --format output: a space, a quote, a tab and a character outside ASCII (NFC).
			'set up/a"b\tc.json': "odd\n",
			"docs/été.md": "summer\n",
		};
		for (const [path, content] of Object.entries(files)) {
			await mkdir(dirname(join(f.root, "source", path)), { recursive: true });
			await writeFile(join(f.root, "source", path), content);
		}
		await mkdir(join(f.root, "source/.cursor"));
		await symlink("../README.md", join(f.root, "source/.cursor/environment.json"));
		await f.src("add", "--all");
		await f.src("update-index", "--add", "--cacheinfo", `160000,${f.baseSha},vendored`);
		await f.src("commit", "--quiet", "-m", "setup");
		const head = await f.src("rev-parse", "HEAD");
		await seedCodeArea(c.job, { repository: f.repository, baseSha: head, bundle: await f.bundle("refs/heads/main") });
		let kept: CodeCommitSource | undefined;
		const read = await withCodeCommit(c.job, { repository: f.repository, commit: head }, async (source) => {
			kept = source;
			const text = async (path: string, maxBytes = 65536) => {
				const entry = await source.read(path, maxBytes);
				return entry.kind === "file" ? Buffer.from(entry.bytes).toString("utf8") : entry.kind;
			};
			return {
				qorpera: await text(".qorpera/environment.json"),
				cursor: await text(".cursor/environment.json"),
				devcontainer: await text(".devcontainer/devcontainer.json"),
				folder: await text(".qorpera"),
				submodule: await text("vendored"),
				missing: await text("nothing/here"),
				dockerfile: await text("docker/Dockerfile"),
				exact: await text("big.txt", 100),
				cut: await text("big.txt", 10),
				quoted: await text('set up/a"b\tc.json'),
				accented: await text("docs/été.md"),
				invalid: await Promise.all(
					["", "/README.md", "a/../README.md", "./README.md", "docker//Dockerfile", "docker/"].map((path) =>
						source.read(path, 10).then(
							() => "read",
							(error: Error) => error.message,
						),
					),
				),
			};
		});
		expect(read).toEqual({
			qorpera: '{"install":"make"}\n',
			cursor: "other",
			devcontainer: "other",
			folder: "other",
			submodule: "other",
			missing: "missing",
			dockerfile: "FROM scratch\n",
			exact: "0123456789".repeat(10),
			cut: "01234567890",
			quoted: "odd\n",
			accented: "summer\n",
			invalid: Array(6).fill("INVALID_CODE_HOST_PATH"),
		});
		await expect(kept?.read("README.md", 10)).rejects.toThrow("CODE_HOST_SOURCE_CLOSED");
		await expect(
			withCodeCommit(c.job, { repository: f.repository, commit: "f".repeat(40) }, async () => "never"),
		).rejects.toMatchObject({ code: "CODE_HOST_COMMIT_UNKNOWN" });
		expect(await readdir(c.scratchRoot)).toEqual([]);
	});
});

describe("code host companies", () => {
	it("never names another company's code area in a job", async () => {
		const f = await fixture(),
			a = await f.company("a"),
			b = await f.company("b");
		for (const c of [a, b]) {
			await seedCodeArea(c.job, {
				repository: f.repository,
				baseSha: f.baseSha,
				bundle: await f.bundle("refs/heads/main"),
			});
			await addCodeWorktree(c.job, { repository: f.repository, workerId: randomUUID(), baseSha: f.baseSha });
		}
		const named = (log: CodeHostCommand[], root: string) =>
			log.some((command) => JSON.stringify([command.argv, command.env, command.cwd]).includes(root));
		expect(named(a.log, `${join(f.root, "b")}/`)).toBe(false);
		expect(named(b.log, `${join(f.root, "a")}/`)).toBe(false);
		expect(named(a.log, a.companyRoot)).toBe(true);
		expect(named(b.log, b.companyRoot)).toBe(true);
	});
});
