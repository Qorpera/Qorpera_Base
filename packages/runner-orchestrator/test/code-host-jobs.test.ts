import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	readlink,
	realpath,
	rm,
	symlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { inflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { CODE_FOLDER_ANY_SESSION, codeFolderRefuses } from "../src/code-folder-names.ts";
import {
	addCodeWorktree,
	archiveCodeArea,
	bundleCodeArea,
	CODE_AREA_CONFIG,
	CODE_AREA_IN_QORPERA_REF,
	CODE_CHANGE_ARCHIVE_COMPLETE_LINE,
	CODE_CHECKS_FILE,
	type CodeBranchLanding,
	type CodeChangeDiff,
	type CodeChangeRecordFile,
	type CodeCommitFile,
	type CodeHostCommand,
	type CodeHostGcBlock,
	type CodeHostJob,
	CodeHostRefusal,
	CodeWorktreeNamesRefused,
	checkCodeArea,
	codeAreaPath,
	codeRefsSha256,
	collectCodeGarbage,
	diffCodeArea,
	exportCodeBranch,
	fsckCodeArea,
	inspectCodeArea,
	landCodeBranch,
	listCodeBranches,
	listCodeChangeArchives,
	logCodeArea,
	previewCodeMerge,
	pruneCodeArea,
	removeCodeDownloads,
	retireCodeWorktrees,
	seedCodeArea,
	showCodeFile,
	startCodeArea,
	tagCodeArea,
	undoCodeChange,
	withJob,
	writeCodeChangeRecords,
} from "../src/code-host-jobs.ts";
import { readCodeAreaBase } from "./helpers/code-area-base.ts";
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

	it("refuses a seed with names the company folder does not take where a session's worktree holds them, naming them, before anything of it enters repo.git", async () => {
		const f = await fixture(),
			c = await f.company();
		/** A commit on the source's main of `paths`, put in its index as git takes them (a path too long for a disk too). */
		const named = async (paths: readonly string[]) => {
			await f.src("reset", "--quiet", "--hard", f.baseSha);
			const blob = await f.src("rev-parse", "HEAD:README.md");
			for (const path of paths) await f.src("update-index", "--add", "--cacheinfo", `100644,${blob},${path}`);
			await f.src("commit", "--quiet", "-m", "names");
			return f.src("rev-parse", "HEAD");
		};
		const seed = async (head: string) =>
			seedCodeArea(c.job, { repository: f.repository, baseSha: head, bundle: await f.bundle("refs/heads/main") });
		// A first seed: no repo.git is made.
		await expect(seed(await named(["bad.", "x /file", "x /y/z.txt"]))).rejects.toMatchObject({
			code: "CODE_HOST_NAMES_FOLDER_REFUSES",
			paths: ["bad.", "x "],
		});
		expect(await exists(c.repo)).toBe(false);
		expect(await readdir(c.scratchRoot)).toEqual([]);
		// The seed's refusal is no worktree's: it names no branch or base of a session.
		await expect(seed(await named(["bad."]))).rejects.not.toBeInstanceOf(CodeWorktreeNamesRefused);
		// An update: repo.git, its refs, its packs and main/ stay as they were.
		await f.src("reset", "--quiet", "--hard", f.baseSha);
		expect((await seed(f.baseSha)).state).toBe("seeded");
		const before = {
			refs: await f.git(c.repo, "--git-dir=.", "for-each-ref"),
			packs: (await readdir(join(c.repo, "objects/pack"))).sort(),
			main: (await readdir(join(c.code, "main"))).sort(),
		};
		// 4,029 bytes: 4,055 where main/ holds it, which the folder takes, and 4,097 where a session's worktree does
		// (`code/qorpera/example/worktrees/<36>/`), one past its 4,096: no session could check it out.
		const deep = [...Array.from({ length: 20 }, () => "d".repeat(200)), "e".repeat(9)].join("/");
		expect(Buffer.byteLength(deep)).toBe(4029);
		expect(Buffer.byteLength(`code/qorpera/example/main/${deep}`)).toBe(4055);
		expect(Buffer.byteLength(`code/qorpera/example/${CODE_FOLDER_ANY_SESSION}/${deep}`)).toBe(4097);
		for (const [paths, refused] of [
			[["bad."], ["bad."]],
			[[deep], [deep]],
			[
				["n".repeat(256), "ok/a\\b.txt"],
				["n".repeat(256), "ok/a\\b.txt"],
			],
		] as const) {
			const head = await named(paths);
			await expect(seed(head)).rejects.toMatchObject({ code: "CODE_HOST_NAMES_FOLDER_REFUSES", paths: refused });
			expect(await f.git(c.repo, "--git-dir=.", "for-each-ref")).toBe(before.refs);
			expect((await readdir(join(c.repo, "objects/pack"))).sort()).toEqual(before.packs);
			expect((await readdir(join(c.code, "main"))).sort()).toEqual(before.main);
			await expect(f.git(c.repo, "--git-dir=.", "cat-file", "-e", head)).rejects.toThrow();
			expect(await readdir(c.scratchRoot)).toEqual([]);
		}
		// Asked before the repack: no pack was made of the refused commit.
		const commands = c.log.length;
		await expect(seed(await named(["bad."]))).rejects.toMatchObject({ code: "CODE_HOST_NAMES_FOLDER_REFUSES" });
		expect(c.log.slice(commands).some((command) => command.argv.includes("repack"))).toBe(false);
		expect(c.log.slice(commands).some((command) => command.argv.includes("ls-tree"))).toBe(true);
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
	it("adds and locks a session's worktree, finds it again, keeps its branch, adds one again whose files alone are gone, and refuses files without git's folder", async () => {
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
		await rm(admin, { recursive: true });
		expect(await addCodeWorktree(c.job, input)).toEqual({ state: "added", headSha: head, restored: [] });
		expect(await readFile(join(tree, "README.md"), "utf8")).toBe("session\n");

		// Its files alone go (nightly care retired it, or a removal stopped halfway): git's folder for the worktree, with
		// its own index and diary, is removed, and the worktree is added again from the branch.
		await writeFile(join(admin, "logs-of-the-old-worktree"), "x\n");
		await rm(tree, { recursive: true });
		expect(await addCodeWorktree(c.job, input)).toEqual({
			state: "added",
			headSha: head,
			restored: [`code/qorpera/example/repo.git/worktrees/${workerId}`],
		});
		expect(await readFile(join(tree, "README.md"), "utf8")).toBe("session\n");
		expect(await readFile(join(tree, ".git"), "utf8")).toBe(`gitdir: ${admin}\n`);
		expect(await f.git(tree, "symbolic-ref", "HEAD")).toBe(`refs/heads/qorpera/coding/${workerId}`);
		expect(await f.git(tree, "status", "--porcelain")).toBe("");
		expect(await exists(join(admin, "locked"))).toBe(true);
		expect(await exists(join(admin, "logs-of-the-old-worktree"))).toBe(false);
		expect(await addCodeWorktree(c.job, input)).toEqual({ state: "present", headSha: head, restored: [] });
		// A head the names' rule refuses is not added again, and git's folder stays as it was.
		await writeFile(join(tree, "Readme.md"), "another case\n");
		await f.git(tree, "add", "Readme.md");
		await f.git(tree, "commit", "--quiet", "-m", "names");
		await rm(tree, { recursive: true });
		await expect(addCodeWorktree(c.job, input)).rejects.toMatchObject({ code: "CODE_HOST_NAMES_DIFFER_BY_CASE" });
		expect(await exists(join(admin, "HEAD"))).toBe(true);
		await f.git(c.repo, "--git-dir=.", "update-ref", `refs/heads/qorpera/coding/${workerId}`, head);
		expect(await addCodeWorktree(c.job, input)).toMatchObject({ state: "added", headSha: head });

		await writeFile(join(tree, ".git"), "gitdir: /elsewhere\n");
		await expect(addCodeWorktree(c.job, input)).rejects.toMatchObject({ code: "CODE_HOST_WORKTREE_CHANGED" });
		// Files without git's folder for them: nothing says what they are, and nothing is touched.
		await rm(admin, { recursive: true });
		await expect(addCodeWorktree(c.job, input)).rejects.toMatchObject({
			code: "CODE_HOST_WORKTREE_INCOMPLETE",
			paths: [`code/qorpera/example/worktrees/${workerId}`],
		});
		expect(await readFile(join(tree, "README.md"), "utf8")).toBe("session\n");
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

	it("refuses a worktree made again at a head with names the company folder does not take where it stands, before anything is written, saying they are its branch's", async () => {
		const f = await fixture(),
			c = await f.company();
		const { baseSha } = await startCodeArea(c.job, { repository: kept });
		/** A session whose branch holds `paths` (put in its index as git takes them), its worktree's files then gone. */
		const retired = async (paths: readonly string[], files: Record<string, string> = {}) => {
			const s = await session(f, c, baseSha);
			const blob = await f.git(
				c.repo,
				"--git-dir=.",
				"rev-parse",
				`${await s.commit({ "ok.txt": "ok\n", ...files })}:ok.txt`,
			);
			for (const path of paths)
				await f.git(s.tree, "update-index", "--add", "--cacheinfo", `100644,${blob},${path}`);
			await f.git(s.tree, "commit", "--quiet", "--allow-empty", "-m", "names");
			const head = await f.git(s.tree, "rev-parse", "HEAD");
			await rm(s.tree, { recursive: true });
			return { ...s, head, input: { repository: kept, workerId: s.workerId, baseSha } };
		};
		// 4,029 bytes: 4,055 where main/ holds it, and 4,097 where the session's worktree holds it
		// (`code/qorpera/example/worktrees/<36>/`), one past the folder's 4,096.
		const deep = [...Array.from({ length: 20 }, () => "d".repeat(200)), "e".repeat(9)].join("/");
		for (const [paths, refused] of [
			[["bad."], ["bad."]],
			[["x /file", "x /y/z.txt"], ["x "]],
			[["a/b/c./d.txt"], ["a/b/c."]],
			[["n".repeat(256)], ["n".repeat(256)]],
			[[deep], [deep]],
		] as const) {
			const s = await retired(paths);
			const admin = (await readdir(s.admin)).sort();
			const commands = c.log.length;
			const refusal = await addCodeWorktree(c.job, s.input).catch((error: unknown) => error);
			expect(refusal).toBeInstanceOf(CodeWorktreeNamesRefused);
			expect(refusal).toMatchObject({
				name: "CodeHostRefusal",
				code: "CODE_HOST_NAMES_FOLDER_REFUSES",
				paths: refused,
				of: "branch",
			});
			// Nothing written: git's folder for the worktree stays as it was, no file of the worktree is made, and git was
			// never asked to add it.
			expect((await readdir(s.admin)).sort()).toEqual(admin);
			expect(await exists(s.tree)).toBe(false);
			expect(c.log.slice(commands).some((command) => command.argv.includes("worktree"))).toBe(false);
			// The branch stays as the session left it.
			expect(await f.git(c.repo, "--git-dir=.", "rev-parse", `refs/heads/qorpera/coding/${s.workerId}`)).toBe(
				s.head,
			);
			// Without git's folder too: the same, and nothing made.
			await rm(s.admin, { recursive: true });
			await expect(addCodeWorktree(c.job, s.input)).rejects.toMatchObject({
				code: "CODE_HOST_NAMES_FOLDER_REFUSES",
				of: "branch",
			});
			expect(await exists(s.admin)).toBe(false);
			expect(await exists(s.tree)).toBe(false);
		}
		expect(await readdir(c.scratchRoot)).toEqual([]);
		// The code host's own rules say whose names they are too.
		const cased = await retired([], { "Cart.js": "a\n", "cart.js": "b\n" });
		await expect(addCodeWorktree(c.job, cased.input)).rejects.toMatchObject({
			code: "CODE_HOST_NAMES_DIFFER_BY_CASE",
			of: "branch",
		});
		await expect(addCodeWorktree(c.job, cased.input)).rejects.toBeInstanceOf(CodeWorktreeNamesRefused);
		// A new worktree at a base that holds such a name: refused as the base's, and nothing made.
		const named = await retired(["bad."]);
		const fresh = randomUUID();
		await expect(
			addCodeWorktree(c.job, { repository: kept, workerId: fresh, baseSha: named.head }),
		).rejects.toMatchObject({ code: "CODE_HOST_NAMES_FOLDER_REFUSES", paths: ["bad."], of: "base" });
		expect(await exists(join(c.code, "worktrees", fresh))).toBe(false);
		expect(await exists(join(c.repo, "worktrees", fresh))).toBe(false);
		await expect(
			f.git(c.repo, "--git-dir=.", "rev-parse", "--verify", `refs/heads/qorpera/coding/${fresh}`),
		).rejects.toThrow();
		// A name the folder takes is added again as before.
		const fine = await retired(["n".repeat(255), "a:b.txt"]);
		expect(await addCodeWorktree(c.job, fine.input)).toMatchObject({ state: "added", headSha: fine.head });
	});
});

describe("the company folder's names where a place holds them", () => {
	const area = "code/qorpera/example";
	const records = (...paths: string[]) => paths.map((path) => ({ type: "blob", path: Buffer.from(path) }));
	/** A path of `bytes` bytes (not a multiple of 201), every name within 255. */
	const long = (bytes: number) => {
		const parts = Array.from({ length: Math.floor(bytes / 201) }, () => "d".repeat(200));
		return [...parts, "e".repeat(bytes - parts.length * 201)].join("/");
	};

	it("asks where main/ holds a path by default, and where a session's worktree holds it when told, 42 bytes deeper", () => {
		const workerId = randomUUID();
		expect(CODE_FOLDER_ANY_SESSION).toHaveLength(`worktrees/${workerId}`.length);
		expect(`${area}/${CODE_FOLDER_ANY_SESSION}/`.length - `${area}/main/`.length).toBe(42);
		for (const bytes of [4028, 4029, 4070, 4071]) expect(Buffer.byteLength(long(bytes))).toBe(bytes);
		// main/: 26 bytes before the path, so 4,070 is the longest.
		expect(codeFolderRefuses(area, records(long(4070)))).toEqual([]);
		expect(codeFolderRefuses(area, records(long(4071)))).toEqual([long(4071)]);
		expect(codeFolderRefuses(area, records(long(4071)), "main")).toEqual([long(4071)]);
		// A session's worktree: 68 bytes before the path, so 4,028 is the longest, for any session.
		for (const under of [CODE_FOLDER_ANY_SESSION, `worktrees/${workerId}`]) {
			expect(codeFolderRefuses(area, records(long(4028)), under)).toEqual([]);
			expect(codeFolderRefuses(area, records(long(4029)), under)).toEqual([long(4029)]);
		}
		expect(codeFolderRefuses(area, records(long(4029)))).toEqual([]);
		// What the folder refuses wherever it stands is refused in both.
		for (const under of ["main", CODE_FOLDER_ANY_SESSION])
			expect(
				codeFolderRefuses(area, records("ok.txt", "bad.", "a\\b", "n".repeat(256), "n".repeat(255)), under),
			).toEqual(["bad.", "a\\b", "n".repeat(256)]);
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

const kept = { host: "qorpera" as const, owner: "qorpera", name: "example", baseBranch: "main" };
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Company = Awaited<ReturnType<Fixture["company"]>>;
/** A session's worktree on the kept repository, and a commit there. */
async function session(f: Fixture, c: Company, baseSha: string) {
	const workerId = randomUUID();
	await addCodeWorktree(c.job, { repository: kept, workerId, baseSha });
	const tree = join(c.code, "worktrees", workerId);
	const commit = async (files: Record<string, string | Uint8Array>, message = "change") => {
		for (const [path, content] of Object.entries(files)) {
			await mkdir(dirname(join(tree, path)), { recursive: true });
			await writeFile(join(tree, path), content);
		}
		await f.git(tree, "add", "--all");
		await f.git(tree, "commit", "--quiet", "-m", message);
		return f.git(tree, "rev-parse", "HEAD");
	};
	return { workerId, tree, admin: join(c.repo, "worktrees", workerId), commit };
}

describe("code host: a repository kept in Qorpera (own code storage, slice 1)", () => {
	it("starts empty: one commit of no files on the default branch, its mark, and main/ at it; again, the same", async () => {
		const f = await fixture(),
			c = await f.company();
		const started = await startCodeArea(c.job, { repository: kept });
		expect(started.state).toBe("started");
		expect(await f.git(c.repo, "--git-dir=.", "rev-parse", "refs/heads/main")).toBe(started.baseSha);
		expect(await f.git(c.repo, "--git-dir=.", "rev-parse", CODE_AREA_IN_QORPERA_REF)).toBe(started.baseSha);
		expect(await f.git(c.repo, "--git-dir=.", "ls-tree", started.baseSha)).toBe("");
		expect(await f.git(c.repo, "--git-dir=.", "log", "-1", "--format=%an <%ae> %s", started.baseSha)).toBe(
			"Qorpera <code@qorpera.com> Start example",
		);
		expect(await readFile(join(c.repo, "config"), "utf8")).toBe(CODE_AREA_CONFIG);
		expect(await readdir(join(c.code, "main"))).toEqual([".git"]);
		expect(await readFile(join(c.repo, "worktrees/main/HEAD"), "utf8")).toBe(`${started.baseSha}\n`);
		expect(await readdir(c.scratchRoot)).toEqual([]);
		expect(await startCodeArea(c.job, { repository: kept })).toEqual({
			state: "present",
			baseSha: started.baseSha,
			restored: [],
		});
		// One default branch: another branch of the same repository is no repository kept in Qorpera, so it never resets
		// main/ to an empty start (review 1544 r1 F2).
		await expect(startCodeArea(c.job, { repository: { ...kept, baseBranch: "master" } })).rejects.toThrow(
			"INVALID_CODING_REPOSITORY",
		);
		expect(await f.git(c.repo, "--git-dir=.", "for-each-ref", "--format=%(refname)", "refs/heads")).toBe(
			"refs/heads/main",
		);
		// main/ lost (a start or landing stopped between the branch and main/): put back at the branch.
		await rm(join(c.code, "main"), { recursive: true });
		await rm(join(c.repo, "worktrees/main"), { recursive: true });
		expect((await startCodeArea(c.job, { repository: kept })).baseSha).toBe(started.baseSha);
		expect(await readFile(join(c.repo, "worktrees/main/HEAD"), "utf8")).toBe(`${started.baseSha}\n`);
	});

	it("never holds a GitHub copy and a repository kept in Qorpera in one code area", async () => {
		const f = await fixture(),
			github = await f.company("github"),
			own = await f.company("own");
		await seedCodeArea(github.job, {
			repository: f.repository,
			baseSha: f.baseSha,
			bundle: await f.bundle("refs/heads/main"),
		});
		await expect(startCodeArea(github.job, { repository: kept })).rejects.toMatchObject({
			code: "CODE_HOST_AREA_FROM_GITHUB",
		});
		await startCodeArea(own.job, { repository: kept });
		await expect(
			seedCodeArea(own.job, {
				repository: f.repository,
				baseSha: f.baseSha,
				bundle: await f.bundle("refs/heads/main"),
			}),
		).rejects.toMatchObject({ code: "CODE_HOST_AREA_IN_QORPERA" });
		// The jobs of one kind refuse the other kind's repository outright.
		await expect(startCodeArea(own.job, { repository: f.repository })).rejects.toThrow("INVALID_CODE_HOST_JOB");
		await expect(
			seedCodeArea(own.job, { repository: kept, baseSha: f.baseSha, bundle: await f.bundle("refs/heads/main") }),
		).rejects.toThrow("INVALID_CODE_HOST_JOB");
		await expect(
			landCodeBranch(github.job, { repository: f.repository, workerId: randomUUID(), headSha: f.baseSha }),
		).rejects.toThrow("INVALID_CODE_HOST_JOB");
	});

	it("lands a session's work: a fast-forward, a merge when main moved on, unchanged again, and a conflict lands nothing", async () => {
		const f = await fixture(),
			c = await f.company();
		const { baseSha } = await startCodeArea(c.job, { repository: kept });
		const first = await session(f, c, baseSha),
			second = await session(f, c, baseSha),
			third = await session(f, c, baseSha);
		const one = await first.commit({ "index.html": "<p>shop</p>\n" }, "shop");
		expect(await landCodeBranch(c.job, { repository: kept, workerId: first.workerId, headSha: one })).toEqual({
			state: "fast-forward",
			mainSha: one,
			mainBefore: baseSha,
			containedAt: null,
			diff: { filesChanged: 1, paths: [{ path: "index.html", change: "added" }], pathsMore: 0 },
			picture: null,
			restored: [],
		});
		expect(await readFile(join(c.code, "main/index.html"), "utf8")).toBe("<p>shop</p>\n");
		// Landing the same commit again changes nothing.
		expect((await landCodeBranch(c.job, { repository: kept, workerId: first.workerId, headSha: one })).state).toBe(
			"unchanged",
		);
		// A session that began before the first landed: its other file is merged with main.
		const two = await second.commit({ "cart.js": "export const cart = [];\n" }, "cart");
		const merged = await landCodeBranch(c.job, { repository: kept, workerId: second.workerId, headSha: two });
		expect(merged.state).toBe("merged");
		expect(await f.git(c.repo, "--git-dir=.", "rev-parse", "refs/heads/main")).toBe(merged.mainSha);
		expect(await f.git(c.repo, "--git-dir=.", "log", "-1", "--format=%P %an", merged.mainSha)).toBe(
			`${one} ${two} Qorpera`,
		);
		expect((await readdir(join(c.code, "main"))).sort()).toEqual([".git", "cart.js", "index.html"]);
		// A session that changed the same file another way: refused with its path, and main stays.
		const three = await third.commit({ "index.html": "<p>store</p>\n" }, "store");
		await expect(
			landCodeBranch(c.job, { repository: kept, workerId: third.workerId, headSha: three }),
		).rejects.toMatchObject({ code: "CODE_HOST_LAND_CONFLICT", paths: ["index.html"] });
		expect(await f.git(c.repo, "--git-dir=.", "rev-parse", "refs/heads/main")).toBe(merged.mainSha);
		expect(await readFile(join(c.code, "main/index.html"), "utf8")).toBe("<p>shop</p>\n");
		// The session merges main itself, and its next landing is a fast-forward.
		await f.git(third.tree, "merge", "--quiet", "-X", "theirs", "-m", "merge main", "main").catch(() => undefined);
		const resolved = await third.commit({ "index.html": "<p>store</p>\n" }, "resolve");
		expect(
			(await landCodeBranch(c.job, { repository: kept, workerId: third.workerId, headSha: resolved })).state,
		).toBe("fast-forward");
		expect(await readFile(join(c.code, "main/index.html"), "utf8")).toBe("<p>store</p>\n");
		expect(await readdir(c.scratchRoot)).toEqual([]);
	});

	it("refuses a commit its session's branch does not hold, and a code area that was never started", async () => {
		const f = await fixture(),
			c = await f.company();
		await expect(
			landCodeBranch(c.job, { repository: kept, workerId: randomUUID(), headSha: f.baseSha }),
		).rejects.toMatchObject({ code: "CODE_HOST_NOT_SEEDED" });
		const { baseSha } = await startCodeArea(c.job, { repository: kept });
		const a = await session(f, c, baseSha),
			b = await session(f, c, baseSha);
		const theirs = await b.commit({ "b.txt": "b\n" });
		await expect(
			landCodeBranch(c.job, { repository: kept, workerId: a.workerId, headSha: theirs }),
		).rejects.toMatchObject({ code: "CODE_HOST_EXPORT_MOVED" });
		expect(await f.git(c.repo, "--git-dir=.", "rev-parse", "refs/heads/main")).toBe(baseSha);
	});

	it("refuses a commit with a name the company folder does not take, naming it, before main moves, and before any check", async () => {
		const f = await fixture(),
			c = await f.company();
		const { baseSha } = await startCodeArea(c.job, { repository: kept });
		/** A session's commit of `ok.txt` and `paths`, put in its index as git takes them (a name too long for a disk too). */
		const named = async (paths: readonly string[], files: Record<string, string> = {}) => {
			const s = await session(f, c, baseSha);
			await s.commit({ "ok.txt": "ok\n", ...files });
			const blob = await f.git(s.tree, "rev-parse", "HEAD:ok.txt");
			for (const path of paths)
				await f.git(s.tree, "update-index", "--add", "--cacheinfo", `100644,${blob},${path}`);
			await f.git(s.tree, "commit", "--quiet", "-m", "names");
			return { s, head: await f.git(s.tree, "rev-parse", "HEAD") };
		};
		const long = "n".repeat(256);
		// 4,071 bytes, every name within 255: 4,097 where main/ holds it (`code/qorpera/example/main/`), one past the
		// folder's 4,096 bytes.
		const deep = [...Array.from({ length: 20 }, () => "d".repeat(200)), "e".repeat(51)].join("/");
		expect(Buffer.byteLength(`code/qorpera/example/main/${deep}`)).toBe(4097);
		// 4,029 bytes: 4,055 where main/ holds it, which the folder takes, but 4,097 where a session's worktree holds it
		// (`code/qorpera/example/worktrees/<36>/`): nothing goes into main that no session could check out.
		const edge = [...Array.from({ length: 20 }, () => "d".repeat(200)), "e".repeat(9)].join("/");
		expect(Buffer.byteLength(`code/qorpera/example/main/${edge}`)).toBe(4055);
		for (const [paths, refused] of [
			[["bad."], ["bad."]],
			// A folder is named once, at the highest part the folder refuses.
			[["x /file", "x /y/z.txt"], ["x "]],
			[["a/b/c./d.txt"], ["a/b/c."]],
			[["a\\b.txt"], ["a\\b.txt"]],
			[[long], [long]],
			[[deep], [deep]],
			[[edge], [edge]],
		] as const) {
			const { s, head } = await named(paths);
			await expect(
				landCodeBranch(c.job, { repository: kept, workerId: s.workerId, headSha: head }),
			).rejects.toMatchObject({
				code: "CODE_HOST_NAMES_FOLDER_REFUSES",
				paths: refused,
			});
			expect(await f.git(c.repo, "--git-dir=.", "rev-parse", "refs/heads/main")).toBe(baseSha);
			expect(await readdir(join(c.code, "main"))).toEqual([".git"]);
		}
		// With checks: the candidate is refused before the checks file is read, so no check runs on it.
		const commands = c.log.length;
		const { s, head } = await named(["bad."], { [CODE_CHECKS_FILE]: "{}\n" });
		await expect(
			landCodeBranch(c.job, { repository: kept, workerId: s.workerId, headSha: head, checks: true }),
		).rejects.toMatchObject({ code: "CODE_HOST_NAMES_FOLDER_REFUSES", paths: ["bad."] });
		expect(c.log.slice(commands).some((command) => command.argv.includes(CODE_CHECKS_FILE))).toBe(false);
		// The longest name and names the folder takes on code/ (a colon, a percent sign, a device's name) land.
		const { s: fine, head: kept255 } = await named(["n".repeat(255), "a:b.txt", "100%.txt", "con.txt"]);
		expect((await landCodeBranch(c.job, { repository: kept, workerId: fine.workerId, headSha: kept255 })).state).toBe(
			"fast-forward",
		);
		expect(await f.git(c.repo, "--git-dir=.", "rev-parse", "refs/heads/main")).toBe(kept255);
		expect(await readdir(c.scratchRoot)).toEqual([]);
	});
});

describe("code host: nightly care of a repository kept in Qorpera (own code storage, step 2)", () => {
	const area = "code/qorpera/example";
	const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
	const unblocked: CodeHostGcBlock = { begin: async () => ({ state: "blocking", held: 0 }), end: async () => {} };
	/** A repository with one session's work landed on main. */
	async function landed() {
		const f = await fixture(),
			c = await f.company();
		const { baseSha } = await startCodeArea(c.job, { repository: kept });
		const first = await session(f, c, baseSha);
		const head = await first.commit(
			{ "index.html": "<p>shop</p>\n", "src/cart.js": "export const cart = [];\n" },
			"shop",
		);
		await landCodeBranch(c.job, { repository: kept, workerId: first.workerId, headSha: head });
		return { f, c, baseSha, first, head };
	}
	async function check(c: Company, options?: { deep?: boolean }) {
		const checked = await checkCodeArea(c.job, { repository: kept }, options);
		if (checked.state !== "present") throw new Error("the repository is absent");
		return checked;
	}
	/** Every command of the jobs is one LXD exec can carry, with the code host's settings and no other. */
	function expectJobCommands(log: CodeHostCommand[]) {
		for (const command of log) {
			expect(command.env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
			expect(command.argv.length).toBeLessThanOrEqual(64);
			if (command.argv[0] === GIT) expect(command.argv[2]).toMatch(/^--git-dir=\//);
		}
	}

	it("the jobs are a kept repository's alone: nothing is made where none is seeded, and a copy of a GitHub repository is refused", async () => {
		const f = await fixture(),
			c = await f.company();
		const sink = { write: async () => {} },
			refsSha256 = "0".repeat(64);
		expect(await checkCodeArea(c.job, { repository: kept })).toEqual({ state: "absent" });
		expect(await readdir(c.companyRoot)).toEqual([]);
		expect(await readdir(c.scratchRoot)).toEqual([]);
		for (const job of [
			() => fsckCodeArea(c.job, { repository: kept }),
			() => bundleCodeArea(c.job, { repository: kept, refsSha256 }, sink),
			() => retireCodeWorktrees(c.job, { repository: kept, workerIds: [] }, { phase: "files" }),
		])
			await expect(job()).rejects.toMatchObject({ code: "CODE_HOST_NOT_SEEDED" });
		expect(await readdir(c.companyRoot)).toEqual([]);
		// A repository on GitHub is none of theirs: refused before any command.
		const commands = c.log.length;
		for (const job of [
			() => checkCodeArea(c.job, { repository: f.repository }),
			() => fsckCodeArea(c.job, { repository: f.repository }),
			() => bundleCodeArea(c.job, { repository: f.repository, refsSha256 }, sink),
			() => retireCodeWorktrees(c.job, { repository: f.repository, workerIds: [] }, { phase: "files" }),
			() => checkCodeArea(c.job, { repository: kept, deep: true } as never),
			() => fsckCodeArea(c.job, { repository: kept }, { maximumMs: 0 }),
			() => bundleCodeArea(c.job, { repository: kept, refsSha256: "main" }, sink),
			() => bundleCodeArea(c.job, { repository: kept, refsSha256 }, sink, { chunkBytes: 0 }),
			() => bundleCodeArea(c.job, { repository: kept, refsSha256 }, sink, { maximumBytes: 1.5 }),
		])
			await expect(job()).rejects.toThrow("INVALID_CODE_HOST_JOB");
		expect(c.log).toHaveLength(commands);
		// A copy of a GitHub repository at the same place has no mark: no care job reads or repairs it.
		await seedCodeArea(c.job, {
			repository: f.repository,
			baseSha: f.baseSha,
			bundle: await f.bundle("refs/heads/main"),
		});
		await writeFile(join(c.code, "main/stray.txt"), "stray\n");
		for (const job of [
			() => checkCodeArea(c.job, { repository: kept }),
			() => fsckCodeArea(c.job, { repository: kept }),
			() => bundleCodeArea(c.job, { repository: kept, refsSha256 }, sink),
			() => retireCodeWorktrees(c.job, { repository: kept, workerIds: [] }, { phase: "git-folder" }),
		])
			await expect(job()).rejects.toMatchObject({ code: "CODE_HOST_AREA_FROM_GITHUB", paths: [area] });
		expect(await readFile(join(c.code, "main/stray.txt"), "utf8")).toBe("stray\n");
		expect(await readdir(c.scratchRoot)).toEqual([]);
	});

	it("check: answers the refs with their fingerprint, the worktrees and the objects, and moves a main/ that is a commit behind", async () => {
		const { f, c, baseSha, first, head } = await landed();
		const branch = `refs/heads/qorpera/coding/${first.workerId}`;
		const refs = [
			{ name: "refs/heads/main", sha: head },
			{ name: branch, sha: head },
			{ name: CODE_AREA_IN_QORPERA_REF, sha: baseSha },
		];
		const refsSha256 = digest(`${head} refs/heads/main\n${head} ${branch}\n${baseSha} ${CODE_AREA_IN_QORPERA_REF}\n`);
		// The fingerprint is of the refs sorted by name, in whatever order they are given.
		expect(codeRefsSha256([...refs].reverse())).toBe(refsSha256);
		expect(codeRefsSha256([])).toBe(digest(""));
		expect(() => codeRefsSha256([{ name: "refs/heads/main", sha: "main" }])).toThrow("INVALID_CODE_HOST_JOB");
		const checked = await checkCodeArea(c.job, { repository: kept });
		expect(checked).toEqual({
			state: "present",
			mainSha: head,
			refs,
			refsSha256,
			shallow: false,
			worktrees: [first.workerId],
			objects: { loose: expect.any(Number), packs: 0, sizeKiB: expect.any(Number) },
			repaired: "none",
			restored: [],
		});
		expect((await check(c)).objects.loose).toBeGreaterThan(0);
		// A folder under worktrees/ that is no session's is not one of them.
		await mkdir(join(c.code, "worktrees/notes"));
		const other = await session(f, c, head);
		expect((await check(c)).worktrees).toEqual([first.workerId, other.workerId].sort());
		await writeFile(join(c.repo, "shallow"), `${head}\n`);
		expect(await check(c)).toMatchObject({ shallow: true, repaired: "none" });
		await rm(join(c.repo, "shallow"));

		// main/ is a commit behind the default branch (a landing stopped between the two): its HEAD, index and files.
		await f.git(join(c.code, "main"), "checkout", "--quiet", "--force", "--detach", baseSha);
		expect(await readdir(join(c.code, "main"))).toEqual([".git"]);
		expect(await check(c)).toMatchObject({ mainSha: head, repaired: "head", restored: [] });
		expect(await readFile(join(c.repo, "worktrees/main/HEAD"), "utf8")).toBe(`${head}\n`);
		expect(await readFile(join(c.code, "main/index.html"), "utf8")).toBe("<p>shop</p>\n");
		expect(await f.git(join(c.code, "main"), "status", "--porcelain")).toBe("");
		expect(await check(c)).toMatchObject({ repaired: "none", restored: [] });
		// Only its HEAD file is another commit's, and a file the checkout does not know is left: both are put right.
		await writeFile(join(c.repo, "worktrees/main/HEAD"), `${baseSha}\n`);
		expect(await check(c)).toMatchObject({ repaired: "head", restored: [] });
		await writeFile(join(c.repo, "worktrees/main/HEAD"), `${baseSha}\n`);
		await writeFile(join(c.code, "main/stray.txt"), "stray\n");
		expect(await check(c)).toMatchObject({ repaired: "files", restored: [`${area}/main`] });
		expect(await readFile(join(c.repo, "worktrees/main/HEAD"), "utf8")).toBe(`${head}\n`);
		expect((await readdir(join(c.code, "main"))).sort()).toEqual([".git", "index.html", "src"]);

		// A start that stopped before its default branch is not the check's to finish.
		await rm(join(c.repo, "refs/heads/main"));
		await expect(checkCodeArea(c.job, { repository: kept })).rejects.toMatchObject({
			code: "CODE_HOST_AREA_NO_BASE",
			paths: ["refs/heads/main"],
		});
		expect(await readdir(c.scratchRoot)).toEqual([]);
		expectJobCommands(c.log);
	});

	it("check: a main/ whose files are not the default branch's is removed and added again, and a deep check compares content too", async () => {
		const { f, c, head } = await landed(),
			main = join(c.code, "main");
		const rebuilt = { mainSha: head, repaired: "files", restored: [`${area}/main`] },
			right = { mainSha: head, repaired: "none", restored: [] };
		const changes: [string, () => Promise<unknown>][] = [
			["a file too many", () => writeFile(join(main, "src/stray.txt"), "stray\n")],
			["a missing file", () => rm(join(main, "src/cart.js"))],
			["an empty folder too many", () => mkdir(join(main, "empty"))],
			["a file of another size", () => writeFile(join(main, "index.html"), "<p>another shop</p>\n")],
			[
				"a link where a file was",
				async () => {
					await rm(join(main, "index.html"));
					await symlink("src/cart.js", join(main, "index.html"));
				},
			],
			["no files at all", () => rm(main, { recursive: true })],
			[
				"neither the files nor git's folder for them",
				async () => {
					await rm(main, { recursive: true });
					await rm(join(c.repo, "worktrees/main"), { recursive: true });
				},
			],
		];
		for (const [name, change] of changes) {
			await change();
			// main/ made from nothing is no restore of a file the job found changed.
			expect(await check(c), name).toMatchObject(
				name.startsWith("neither") ? { ...rebuilt, restored: [] } : rebuilt,
			);
			expect((await readdir(main)).sort(), name).toEqual([".git", "index.html", "src"]);
			expect(await readdir(join(main, "src")), name).toEqual(["cart.js"]);
			expect(await readFile(join(main, "index.html"), "utf8"), name).toBe("<p>shop</p>\n");
			expect(await readFile(join(main, ".git"), "utf8"), name).toBe(`gitdir: ${c.repo}/worktrees/main\n`);
			expect(await exists(join(c.repo, "worktrees/main/locked")), name).toBe(true);
			expect(await f.git(main, "status", "--porcelain"), name).toBe("");
			expect(await check(c), name).toMatchObject(right);
		}
		// Other content of the same size: no path, kind or size differs, so only a deep check, which reads, finds it.
		const before = new Date(Date.now() - 60_000);
		await writeFile(join(main, "index.html"), "<p>shOp</p>\n");
		await utimes(join(main, "index.html"), before, before);
		expect(await check(c)).toMatchObject(right);
		expect(await check(c, { deep: true })).toMatchObject(rebuilt);
		expect(await readFile(join(main, "index.html"), "utf8")).toBe("<p>shop</p>\n");
		expect(await check(c, { deep: true })).toMatchObject(right);
		expect(await f.git(c.repo, "--git-dir=.", "rev-parse", "refs/heads/main")).toBe(head);
		expect(await readdir(c.scratchRoot)).toEqual([]);
	});

	it("check: a file the repository's own attributes convert at checkout has another size than its version, and is no difference", async () => {
		const f = await fixture(),
			c = await f.company();
		const { baseSha } = await startCodeArea(c.job, { repository: kept });
		const first = await session(f, c, baseSha);
		const head = await first.commit(
			{ ".gitattributes": "*.txt text eol=crlf\n", "notes.txt": "one\ntwo\n" },
			"notes",
		);
		await landCodeBranch(c.job, { repository: kept, workerId: first.workerId, headSha: head });
		const notes = join(c.code, "main/notes.txt");
		expect(await f.git(c.repo, "--git-dir=.", "cat-file", "-s", `${head}:notes.txt`)).toBe("8");
		expect(await readFile(notes, "utf8")).toBe("one\r\ntwo\r\n");
		for (const deep of [false, true])
			expect(await check(c, { deep })).toMatchObject({ repaired: "none", restored: [] });
		// The same file with other content is one.
		await writeFile(notes, "one\r\ntwo\r\nthree\r\n");
		expect(await check(c)).toMatchObject({ repaired: "files", restored: [`${area}/main`] });
		expect(await readFile(notes, "utf8")).toBe("one\r\ntwo\r\n");
	});

	it("check: a submodule's place in main/ is an empty folder or none, as git takes it, and nothing is inside it", async () => {
		const f = await fixture(),
			c = await f.company();
		const { baseSha } = await startCodeArea(c.job, { repository: kept });
		const first = await session(f, c, baseSha);
		await writeFile(join(first.tree, "index.html"), "<p>shop</p>\n");
		await f.git(first.tree, "add", "index.html");
		for (const path of ["vendored", "deps/only/this"])
			await f.git(first.tree, "update-index", "--add", "--cacheinfo", `160000,${baseSha},${path}`);
		await f.git(first.tree, "commit", "--quiet", "-m", "vendored");
		const head = await f.git(first.tree, "rev-parse", "HEAD");
		await landCodeBranch(c.job, { repository: kept, workerId: first.workerId, headSha: head });
		const main = join(c.code, "main"),
			right = { mainSha: head, repaired: "none", restored: [] };
		expect(await readdir(join(main, "vendored"))).toEqual([]);
		expect(await readdir(join(main, "deps/only/this"))).toEqual([]);
		for (const deep of [false, true]) expect(await check(c, { deep })).toMatchObject(right);
		// A folder that keeps no empty folder shows none of them.
		await rm(join(main, "vendored"), { recursive: true });
		await rm(join(main, "deps"), { recursive: true });
		for (const deep of [false, true]) expect(await check(c, { deep })).toMatchObject(right);
		// Files in a submodule's place are none of the default branch's.
		await mkdir(join(main, "vendored"));
		await writeFile(join(main, "vendored/stray.txt"), "stray\n");
		expect(await check(c)).toMatchObject({ repaired: "files", restored: [`${area}/main`] });
		expect(await readdir(join(main, "vendored"))).toEqual([]);
		expect(await check(c)).toMatchObject(right);
	});

	it("fsck: ok; a missing file version is a problem, with what fsck said; long output is cut; a slow one is stopped", async () => {
		const { f, c, first, head } = await landed();
		expect(await fsckCodeArea(c.job, { repository: kept })).toEqual({ state: "ok", exitCode: 0, detail: "" });
		const loose = (object: string) => join(c.repo, "objects", object.slice(0, 2), object.slice(2));
		const blob = await f.git(c.repo, "--git-dir=.", "rev-parse", `${head}:src/cart.js`);
		await rm(loose(blob));
		const missing = await fsckCodeArea(c.job, { repository: kept });
		expect(missing.state).toBe("problems");
		expect(missing.exitCode).toBeGreaterThan(0);
		expect(missing.detail).toContain(`missing blob ${blob}`);
		expect(missing.detail.length).toBeLessThan(2000);

		// 80 more file versions go: fsck names each, and the answer keeps the first 2,000 characters.
		const many = Object.fromEntries(
			Array.from({ length: 80 }, (_, index) => [`files/${index}.txt`, `file ${index}\n`]),
		);
		const next = await first.commit(many, "many");
		const blobs = (
			await f.git(c.repo, "--git-dir=.", "ls-tree", "-r", "--format=%(objectname)", next, "files/")
		).split("\n");
		expect(blobs).toHaveLength(80);
		for (const object of blobs) await rm(loose(object));
		const cut = await fsckCodeArea(c.job, { repository: kept });
		expect(cut.state).toBe("problems");
		expect(cut.detail).toHaveLength(2000);
		expect(cut.detail).toContain("missing blob ");

		// An fsck that does not end is stopped, and what it said until then is kept.
		const slow = join(f.root, "slow-git");
		await writeFile(
			slow,
			`#!/bin/sh\nfor a do [ "$a" = fsck ] && { echo "Checking connectivity"; exec sleep 60; }; done\nexec ${GIT} "$@"\n`,
		);
		await chmod(slow, 0o755);
		const started = Date.now();
		expect(
			await fsckCodeArea(
				{ ...c.job, layout: { ...c.job.layout, git: slow } },
				{ repository: kept },
				{ maximumMs: 500 },
			),
		).toEqual({ state: "timeout", exitCode: null, detail: "Checking connectivity\n" });
		expect(Date.now() - started).toBeLessThan(30_000);
		// It wrote nothing in the folder, and its scratch is gone.
		expect(await readdir(c.scratchRoot)).toEqual([]);
		expectJobCommands(c.log);
	});

	it("bundle: holds every ref and restores as a mirror that passes fsck, read out in pieces whose hash and size are the code host's", async () => {
		const { f, c, baseSha, first, head } = await landed();
		// A second session with work that is not landed, and a tag and a branch of its own.
		const second = await session(f, c, head);
		const work = await second.commit({ "work.txt": "work\n" }, "work");
		await f.git(second.tree, "tag", "-a", "-m", "tagged", "v1");
		await f.git(second.tree, "branch", "spare", baseSha);
		const checked = await check(c);
		expect(checked.refs.map((ref) => ref.name)).toEqual(
			[
				"refs/heads/main",
				`refs/heads/qorpera/coding/${first.workerId}`,
				`refs/heads/qorpera/coding/${second.workerId}`,
				"refs/heads/spare",
				CODE_AREA_IN_QORPERA_REF,
				"refs/tags/v1",
			].sort(),
		);
		const before = await readdir(c.repo);
		const pieces: Buffer[] = [];
		const beforeBundle = c.log.length;
		const bundled = await bundleCodeArea(
			c.job,
			{ repository: kept, refsSha256: checked.refsSha256 },
			{
				write: async (chunk) => {
					pieces.push(Buffer.from(chunk));
				},
			},
			{ chunkBytes: 256 },
		);
		const whole = Buffer.concat(pieces);
		expect(bundled).toEqual({
			sha256: digest(whole),
			bytes: whole.length,
			gitVersion: (await f.git(f.root, "version")).replace("git version ", ""),
			refs: checked.refs,
			refsSha256: checked.refsSha256,
		});
		expect(pieces.length).toBeGreaterThan(1);
		expect(pieces.length).toBe(Math.ceil(whole.length / 256));
		expect(pieces.slice(0, -1).every((piece) => piece.length === 256)).toBe(true);
		const bundleCommands = c.log.slice(beforeBundle);
		const ddCommands = bundleCommands.filter((command) => command.argv[0] === "/usr/bin/dd");
		expect(ddCommands.length).toBeGreaterThanOrEqual(1);
		expect(ddCommands.length).toBeLessThan(pieces.length);

		// Anywhere with git: a mirror of the bundle is the whole repository.
		const file = join(f.root, "all.bundle"),
			mirror = join(f.root, "mirror.git");
		await writeFile(file, whole);
		await f.git(f.root, "clone", "--quiet", "--mirror", file, mirror);
		expect(await f.git(mirror, "fsck", "--full", "--strict", "--no-dangling", "--no-progress")).toBe("");
		expect((await f.git(mirror, "for-each-ref", "--format=%(refname) %(objectname)")).split("\n")).toEqual(
			checked.refs.map((ref) => `${ref.name} ${ref.sha}`),
		);
		// A bundle says which commit HEAD is at, not which branch: git guesses one at that commit, here main or the
		// first session's.
		expect(await f.git(mirror, "rev-parse", "HEAD")).toBe(head);
		expect(await f.git(mirror, "show", `${work}:work.txt`)).toBe("work");
		expect(await f.git(mirror, "show", "refs/heads/main:index.html")).toBe("<p>shop</p>");

		// One piece when it fits, the same bytes.
		const again: Buffer[] = [];
		const once = await bundleCodeArea(
			c.job,
			{ repository: kept, refsSha256: checked.refsSha256 },
			{
				write: async (chunk) => {
					again.push(Buffer.from(chunk));
				},
			},
		);
		expect(again).toHaveLength(1);
		expect(once.bytes).toBe(again[0]?.length);
		expect(once.sha256).toBe(digest(again[0] as Buffer));
		// The job wrote nothing in the code area, and its scratch is gone.
		expect(await readdir(c.repo)).toEqual(before);
		expect((await check(c)).refsSha256).toBe(checked.refsSha256);
		expect(await readdir(c.scratchRoot)).toEqual([]);
		expectJobCommands(c.log);
	});

	it("bundle: refuses over the cap and when the refs are not the ones asked for, also when one moves while the bundle is made", async () => {
		const { f, c, first } = await landed();
		const checked = await check(c);
		const written: number[] = [];
		const sink = {
			write: async (chunk: Uint8Array) => {
				written.push(chunk.length);
			},
		};
		await expect(
			bundleCodeArea(c.job, { repository: kept, refsSha256: checked.refsSha256 }, sink, { maximumBytes: 100 }),
		).rejects.toMatchObject({ code: "CODE_HOST_BUNDLE_TOO_LARGE" });
		// The session commits: the fingerprint is not the refs' any more.
		const next = await first.commit({ "more.txt": "more\n" }, "more");
		await expect(
			bundleCodeArea(c.job, { repository: kept, refsSha256: checked.refsSha256 }, sink),
		).rejects.toMatchObject({ code: "CODE_HOST_BUNDLE_REFS_MOVED", paths: [area] });
		// A ref made between the job's reading of the refs and its bundle: the bundle is not of the refs asked for.
		const moving = join(f.root, "moving-git");
		await writeFile(
			moving,
			`#!/bin/sh\nfor a do [ "$a" = create ] && ${GIT} --git-dir="${c.repo}" update-ref refs/heads/spare ${next}; done\nexec ${GIT} "$@"\n`,
		);
		await chmod(moving, 0o755);
		await expect(
			bundleCodeArea(
				{ ...c.job, layout: { ...c.job.layout, git: moving } },
				{ repository: kept, refsSha256: (await check(c)).refsSha256 },
				sink,
			),
		).rejects.toMatchObject({ code: "CODE_HOST_BUNDLE_REFS_MOVED", paths: [area] });
		expect(await f.git(c.repo, "--git-dir=.", "rev-parse", "refs/heads/spare")).toBe(next);
		// A history cut short (repo.git/shallow hides a commit's parents) gives a bundle that does not restore: the proof
		// fails it.
		await first.commit({ "third.txt": "third\n" }, "third");
		const fourth = await first.commit({ "fourth.txt": "fourth\n" }, "fourth");
		await writeFile(join(c.repo, "shallow"), `${fourth}\n`);
		await expect(
			bundleCodeArea(c.job, { repository: kept, refsSha256: (await check(c)).refsSha256 }, sink),
		).rejects.toMatchObject({ code: "CODE_HOST_BUNDLE_FAILED" });
		await rm(join(c.repo, "shallow"));
		// No byte of a refused or failed bundle left the code host.
		expect(written).toEqual([]);
		// A sink that fails fails the job.
		await expect(
			bundleCodeArea(
				c.job,
				{ repository: kept, refsSha256: (await check(c)).refsSha256 },
				{
					write: async () => {
						throw new Error("CODE_BUNDLE_STORE_FULL");
					},
				},
			),
		).rejects.toThrow("CODE_BUNDLE_STORE_FULL");
		expect(await readdir(c.scratchRoot)).toEqual([]);
	});

	it("pack with the refs left loose and nothing pruned: every ref stays a file, and a landing, a start and a new session work afterwards", async () => {
		const { f, c, baseSha, first, head } = await landed();
		expect(
			await collectCodeGarbage(c.job, { repository: kept }, unblocked, { packRefs: false, prune: false }),
		).toEqual({ state: "collected", restored: [] });
		expect(await exists(join(c.repo, "packed-refs"))).toBe(false);
		expect(await readFile(join(c.repo, "refs/heads/main"), "utf8")).toBe(`${head}\n`);
		expect(await readFile(join(c.repo, "refs/qorpera/kept-here"), "utf8")).toBe(`${baseSha}\n`);
		expect(await readFile(join(c.repo, "refs/heads/qorpera/coding", first.workerId), "utf8")).toBe(`${head}\n`);
		const packed = await check(c);
		expect(packed).toMatchObject({ mainSha: head, repaired: "none", restored: [] });
		expect(packed.objects.loose).toBe(0);
		expect(packed.objects.packs).toBeGreaterThan(0);
		expect(await fsckCodeArea(c.job, { repository: kept })).toEqual({ state: "ok", exitCode: 0, detail: "" });
		expect(
			c.log.filter((command) => command.argv.includes("repack")).map((command) => command.argv.slice(3)),
		).toEqual([["repack", "--geometric=2", "-d", "--write-midx", "--write-bitmap-index", "-q"]]);
		expect(
			c.log.filter((command) => command.argv.includes("commit-graph")).map((command) => command.argv.slice(3)),
		).toEqual([["commit-graph", "write", "--reachable", "--changed-paths", "--split", "--expire-time=1.day.ago"]]);
		expect(await exists(join(c.repo, "objects/pack/multi-pack-index"))).toBe(true);
		expect(await exists(join(c.repo, "objects/info/commit-graphs/commit-graph-chain"))).toBe(true);
		expect(c.log.some((command) => command.argv.includes("pack-refs"))).toBe(false);

		const more = await first.commit({ "more.txt": "more\n" }, "more");
		expect(await landCodeBranch(c.job, { repository: kept, workerId: first.workerId, headSha: more })).toMatchObject({
			state: "fast-forward",
			mainSha: more,
			mainBefore: head,
			restored: [],
		});
		expect(await readFile(join(c.code, "main/more.txt"), "utf8")).toBe("more\n");
		expect(await startCodeArea(c.job, { repository: kept })).toEqual({
			state: "present",
			baseSha: more,
			restored: [],
		});
		const other = await session(f, c, more);
		expect(await readFile(join(other.tree, "more.txt"), "utf8")).toBe("more\n");
		await f.git(other.tree, "branch", "spare");
		await f.git(other.tree, "branch", "-D", "spare");
		expect(await exists(join(c.repo, "packed-refs"))).toBe(false);

		expect(await collectCodeGarbage(c.job, { repository: kept }, unblocked)).toEqual({
			state: "collected",
			restored: [],
		});
		expect(await readFile(join(c.repo, "packed-refs"), "utf8")).toContain(`${more} refs/heads/main`);
		expect(await exists(join(c.repo, "refs/heads/main"))).toBe(false);
		expect(
			c.log.filter((command) => command.argv.includes("repack")).map((command) => command.argv.slice(3)),
		).toEqual([
			["repack", "--geometric=2", "-d", "--write-midx", "--write-bitmap-index", "-q"],
			["repack", "--cruft", "--cruft-expiration=14.days.ago", "-d", "--write-midx", "--write-bitmap-index", "-q"],
		]);
		expect(c.log.filter((command) => command.argv.includes("prune")).map((command) => command.argv.slice(3))).toEqual(
			[["prune", "--expire=14.days.ago"]],
		);
		expect(await readdir(c.scratchRoot)).toEqual([]);
	});

	it("geometric repack keeps unreachable objects while cruft prune drops expired orphans and keeps pinned site trees", async () => {
		const { f, c, head } = await landed();
		const repo = (...args: string[]) => f.git(c.repo, "--git-dir=.", ...args);
		await writeFile(join(f.root, "orphan.txt"), "kept by no ref\n");
		const blob = await repo("hash-object", "-w", join(f.root, "orphan.txt"));
		await writeFile(join(f.root, "orphan.tree"), `100644 blob ${blob}\torphan.txt\n`);
		const tree = (
			await exec("/bin/sh", ["-c", `exec ${GIT} --git-dir=. mktree <"$1"`, "sh", join(f.root, "orphan.tree")], {
				cwd: c.repo,
				env: f.env,
			})
		).stdout.trim();
		const orphan = await repo("commit-tree", tree, "-p", head, "-m", "orphan");
		const old = new Date(Date.now() - 30 * 86_400_000);
		for (const object of [blob, tree, orphan])
			await utimes(join(c.repo, "objects", object.slice(0, 2), object.slice(2)), old, old);
		expect(
			await collectCodeGarbage(c.job, { repository: kept }, unblocked, { packRefs: false, prune: false }),
		).toEqual({ state: "collected", restored: [] });
		for (const object of [blob, tree, orphan])
			expect(await exists(join(c.repo, "objects", object.slice(0, 2), object.slice(2)))).toBe(false);
		expect(await repo("cat-file", "-t", orphan)).toBe("commit");
		expect(await repo("show", `${orphan}:orphan.txt`)).toBe("kept by no ref");
		expect(await repo("fsck", "--full", "--no-dangling", "--no-progress")).toBe("");
		await collectCodeGarbage(c.job, { repository: kept }, unblocked, { packRefs: false, prune: false });
		expect(await repo("show", `${orphan}:orphan.txt`)).toBe("kept by no ref");

		await writeFile(join(f.root, "expired.txt"), "expired orphan\n");
		const expiredBlob = await repo("hash-object", "-w", join(f.root, "expired.txt"));
		await writeFile(join(f.root, "site.html"), "<h1>pinned site</h1>\n");
		const siteBlob = await repo("hash-object", "-w", join(f.root, "site.html"));
		await writeFile(join(f.root, "site.tree"), `100644 blob ${siteBlob}\tindex.html\n`);
		const siteTree = (
			await exec("/bin/sh", ["-c", `exec ${GIT} --git-dir=. mktree <"$1"`, "sh", join(f.root, "site.tree")], {
				cwd: c.repo,
				env: f.env,
			})
		).stdout.trim();
		await repo("update-ref", "--no-deref", "refs/qorpera/sites/change-1", siteTree);
		for (const object of [expiredBlob, siteBlob, siteTree])
			await utimes(join(c.repo, "objects", object.slice(0, 2), object.slice(2)), old, old);
		await collectCodeGarbage(c.job, { repository: kept }, unblocked);
		await expect(repo("cat-file", "-e", expiredBlob)).rejects.toThrow();
		expect(await repo("cat-file", "-p", siteBlob)).toBe("<h1>pinned site</h1>");
		expect(await repo("rev-parse", "refs/heads/main")).toBe(head);
	});

	it("retire: leaves a worktree that is not exactly its session's branch, saying why", async () => {
		const f = await fixture(),
			c = await f.company();
		const { baseSha } = await startCodeArea(c.job, { repository: kept });
		type Session = Awaited<ReturnType<typeof session>> & { head: string };
		const cases: [string, (s: Session) => Promise<unknown>][] = [
			["LINKS_DIFFER", (s) => writeFile(join(s.tree, ".git"), "gitdir: /elsewhere\n")],
			["LINKS_DIFFER", (s) => writeFile(join(s.admin, "gitdir"), "/elsewhere/.git\n")],
			// Whose objects, refs and config git would take for the worktree.
			["LINKS_DIFFER", (s) => writeFile(join(s.admin, "commondir"), `${f.root}/source/.git\n`)],
			["HEAD_NOT_ITS_BRANCH", (s) => f.git(s.tree, "checkout", "--quiet", "--detach")],
			["HEAD_NOT_ITS_BRANCH", (s) => f.git(s.tree, "checkout", "--quiet", "-b", "another")],
			["NO_BRANCH", (s) => rm(join(c.repo, "refs/heads/qorpera/coding", s.workerId))],
			["IN_PROGRESS", (s) => writeFile(join(s.admin, "MERGE_HEAD"), `${s.head}\n`)],
			["IN_PROGRESS", (s) => mkdir(join(s.admin, "rebase-merge"))],
			// A ref of the worktree's own, as a bisect keeps them.
			[
				"IN_PROGRESS",
				async (s) => {
					await mkdir(join(s.admin, "refs/bisect"), { recursive: true });
					await writeFile(join(s.admin, "refs/bisect/bad"), `${s.head}\n`);
				},
			],
			["NOT_CLEAN", (s) => writeFile(join(s.tree, "untracked.txt"), "x\n")],
			["NOT_CLEAN", (s) => writeFile(join(s.tree, "index.html"), "<p>another shop</p>\n")],
			["NOT_CLEAN", (s) => rm(join(s.tree, "index.html"))],
			[
				"NOT_CLEAN",
				async (s) => {
					await writeFile(join(s.tree, "index.html"), "<p>staged</p>\n");
					await f.git(s.tree, "add", "index.html");
					await writeFile(join(s.tree, "index.html"), "<p>shop</p>\n");
				},
			],
			// Changes the index tells git not to look at: its status prints nothing for them.
			...["--assume-unchanged", "--skip-worktree"].map((flag): [string, (s: Session) => Promise<unknown>] => [
				"NOT_CLEAN",
				async (s) => {
					await f.git(s.tree, "update-index", flag, "index.html");
					await writeFile(join(s.tree, "index.html"), "<p>a shop git does not look at</p>\n");
					expect(await f.git(s.tree, "status", "--porcelain", "--ignored")).toBe("");
				},
			]),
			[
				"SUBMODULE",
				async (s) => {
					await f.git(s.tree, "update-index", "--add", "--cacheinfo", `160000,${s.head},vendored`);
					await f.git(s.tree, "commit", "--quiet", "-m", "vendored");
				},
			],
			["SUBMODULE", (s) => f.git(s.tree, "init", "--quiet", "--template=", "nested")],
			["NAMES_REFUSED", (s) => s.commit({ "Cart.js": "a\n", "cart.js": "b\n" }, "names")],
		];
		const sessions: Session[] = [];
		for (const [, change] of cases) {
			const made = await session(f, c, baseSha);
			const head = await made.commit({ "index.html": "<p>shop</p>\n", ".gitignore": "*.log\n" }, "shop");
			sessions.push({ ...made, head });
			await change({ ...made, head });
		}
		const missing = randomUUID();
		const workerIds = [missing, ...sessions.map((s) => s.workerId)];
		expect(await retireCodeWorktrees(c.job, { repository: kept, workerIds }, { phase: "files" })).toEqual({
			retired: [],
			kept: [
				{ workerId: missing, reason: "NOT_THERE" },
				...sessions.map((s, index) => ({ workerId: s.workerId, reason: cases[index]?.[0] })),
			],
		});
		for (const s of sessions) {
			expect(await exists(join(s.tree, ".gitignore"))).toBe(true);
			expect(await exists(join(s.admin, "HEAD"))).toBe(true);
		}
		// And the second job leaves a worktree whose files are there.
		expect(await retireCodeWorktrees(c.job, { repository: kept, workerIds }, { phase: "git-folder" })).toEqual({
			retired: [],
			kept: [
				{ workerId: missing, reason: "NOT_THERE" },
				...sessions.map((s) => ({ workerId: s.workerId, reason: "FILES_STILL_THERE" })),
			],
		});
		for (const s of sessions) expect(await exists(join(s.admin, "HEAD"))).toBe(true);
		// A name the company folder does not take where the worktree holds it: added again, the worktree would be refused
		// (`addCodeWorktree`), so its files stay.
		const folder = await session(f, c, baseSha);
		await folder.commit({ "bad.": "a\n" }, "folder names");
		expect(
			await retireCodeWorktrees(c.job, { repository: kept, workerIds: [folder.workerId] }, { phase: "files" }),
		).toEqual({ retired: [], kept: [{ workerId: folder.workerId, reason: "NAMES_REFUSED" }] });
		expect(await readFile(join(folder.tree, "bad."), "utf8")).toBe("a\n");
		// At most 20 sessions a job, each once, in one of the two phases.
		const commands = c.log.length;
		for (const [ids, phase] of [
			[Array.from({ length: 21 }, () => randomUUID()), "files"],
			[[missing, missing], "files"],
			[["main"], "files"],
			[[missing], "all"],
		] as const)
			await expect(
				retireCodeWorktrees(c.job, { repository: kept, workerIds: ids }, { phase: phase as "files" }),
			).rejects.toThrow("INVALID_CODE_HOST_JOB");
		expect(c.log).toHaveLength(commands);
		expect(await readdir(c.scratchRoot)).toEqual([]);
		expectJobCommands(c.log);
	});

	it("retire: removes a clean worktree's files, then git's folder for it, and a follow-up gets the same head and files back from the branch", async () => {
		const { f, c, baseSha, first, head } = await landed();
		// The second session's work is not landed: it is on its branch, which stays.
		const second = await session(f, c, head);
		await mkdir(join(second.tree, "bin"));
		await writeFile(join(second.tree, "bin/run.sh"), "#!/bin/sh\n");
		await chmod(join(second.tree, "bin/run.sh"), 0o755);
		await symlink("bin/run.sh", join(second.tree, "run"));
		const work = await second.commit({ "work.txt": "work\n" }, "work");
		// The empty refs/ git makes in its folder for a worktree, and an empty folder a finished bisect left in it, hold
		// no ref.
		expect(await readdir(join(first.admin, "refs"))).toEqual([]);
		await mkdir(join(second.admin, "refs/bisect"));
		const ids = [first.workerId, second.workerId];
		const retire = (phase: "files" | "git-folder") =>
			retireCodeWorktrees(c.job, { repository: kept, workerIds: ids }, { phase });
		const branch = (workerId: string) =>
			f.git(c.repo, "--git-dir=.", "rev-parse", `refs/heads/qorpera/coding/${workerId}`);
		const refs = (await check(c)).refsSha256;

		expect(await retire("files")).toEqual({ retired: ids, kept: [] });
		for (const s of [first, second]) {
			expect(await exists(s.tree)).toBe(false);
			expect(await exists(join(s.admin, "HEAD"))).toBe(true);
		}
		// No ref moved, and the worktrees are no longer among the folder's.
		expect(await check(c)).toMatchObject({ refsSha256: refs, worktrees: [], repaired: "none" });
		expect(await retire("files")).toEqual({
			retired: [],
			kept: ids.map((workerId) => ({ workerId, reason: "NOT_THERE" })),
		});

		// A follow-up between the two jobs: the first session's worktree comes back from its branch.
		expect(await addCodeWorktree(c.job, { repository: kept, workerId: first.workerId, baseSha })).toEqual({
			state: "added",
			headSha: head,
			restored: [`${area}/repo.git/worktrees/${first.workerId}`],
		});
		expect(await readFile(join(first.tree, "src/cart.js"), "utf8")).toBe("export const cart = [];\n");
		expect(await f.git(first.tree, "symbolic-ref", "HEAD")).toBe(`refs/heads/qorpera/coding/${first.workerId}`);
		expect(await f.git(first.tree, "status", "--porcelain")).toBe("");

		// The second job: git's folder goes where the files are gone, and stays where they are back.
		expect(await retire("git-folder")).toEqual({
			retired: [second.workerId],
			kept: [{ workerId: first.workerId, reason: "FILES_STILL_THERE" }],
		});
		expect(await exists(second.admin)).toBe(false);
		expect(await exists(join(first.admin, "HEAD"))).toBe(true);
		expect(await retire("git-folder")).toEqual({
			retired: [],
			kept: [
				{ workerId: first.workerId, reason: "FILES_STILL_THERE" },
				{ workerId: second.workerId, reason: "NOT_THERE" },
			],
		});
		expect(await branch(second.workerId)).toBe(work);
		expect(await fsckCodeArea(c.job, { repository: kept })).toEqual({ state: "ok", exitCode: 0, detail: "" });

		// The second session's follow-up: the same head and the same files, and it works on.
		expect(await addCodeWorktree(c.job, { repository: kept, workerId: second.workerId, baseSha: head })).toEqual({
			state: "added",
			headSha: work,
			restored: [],
		});
		expect(await f.git(second.tree, "rev-parse", "HEAD")).toBe(work);
		expect(await f.git(second.tree, "symbolic-ref", "HEAD")).toBe(`refs/heads/qorpera/coding/${second.workerId}`);
		expect(await f.git(second.tree, "status", "--porcelain", "--ignored")).toBe("");
		expect((await readdir(second.tree)).sort()).toEqual([".git", "bin", "index.html", "run", "src", "work.txt"]);
		expect(await readFile(join(second.tree, "work.txt"), "utf8")).toBe("work\n");
		expect((await lstat(join(second.tree, "bin/run.sh"))).mode & 0o111).toBe(0o111);
		expect((await lstat(join(second.tree, "run"))).isSymbolicLink()).toBe(true);
		expect(await exists(join(second.admin, "locked"))).toBe(true);
		const later = await second.commit({ "later.txt": "later\n" }, "later");
		expect(
			await landCodeBranch(c.job, { repository: kept, workerId: second.workerId, headSha: later }),
		).toMatchObject({ state: "fast-forward", mainSha: later, mainBefore: head, restored: [] });
		// A worktree whose link to git's folder was changed after its files went is left to its session.
		expect(
			await retireCodeWorktrees(c.job, { repository: kept, workerIds: [first.workerId] }, { phase: "files" }),
		).toEqual({
			retired: [first.workerId],
			kept: [],
		});
		await writeFile(join(first.admin, "gitdir"), "/elsewhere/.git\n");
		expect(
			await retireCodeWorktrees(c.job, { repository: kept, workerIds: [first.workerId] }, { phase: "git-folder" }),
		).toEqual({ retired: [], kept: [{ workerId: first.workerId, reason: "LINKS_DIFFER" }] });
		expect(await exists(join(first.admin, "HEAD"))).toBe(true);
		expect(await readdir(c.scratchRoot)).toEqual([]);
		expectJobCommands(c.log);
	});
});

/** A zip's entries from its central directory, each name with its bytes (stored, or deflated). */
function unzip(zip: Buffer): Map<string, Buffer> {
	const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])),
		entries = new Map<string, Buffer>();
	let at = zip.readUInt32LE(end + 16);
	for (let index = zip.readUInt16LE(end + 10); index > 0; index -= 1) {
		expect(zip.readUInt32LE(at)).toBe(0x02014b50);
		const method = zip.readUInt16LE(at + 10),
			packed = zip.readUInt32LE(at + 20),
			nameLength = zip.readUInt16LE(at + 28),
			local = zip.readUInt32LE(at + 42),
			data = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28),
			bytes = zip.subarray(data, data + packed);
		expect([0, 8]).toContain(method);
		entries.set(zip.toString("utf8", at + 46, at + 46 + nameLength), method === 0 ? bytes : inflateRawSync(bytes));
		at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
	}
	return entries;
}

describe("code host: the change record, undo and download of a repository kept in Qorpera (own code storage, step 2b)", () => {
	const area = "code/qorpera/example";
	const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
	/** The first bytes of each kind of picture, and a little after them. */
	const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("a picture")]),
		jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("a picture")]),
		webp = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x1a, 0, 0, 0]), Buffer.from("WEBPVP8 a picture")]);
	const none: CodeChangeDiff = { filesChanged: 0, paths: [], pathsMore: 0 };
	const repo = (f: Fixture, c: Company, ...args: string[]) => f.git(c.repo, "--git-dir=.", ...args);
	const land = (c: Company, s: { workerId: string }, headSha: string, picture?: string) =>
		landCodeBranch(c.job, {
			repository: kept,
			workerId: s.workerId,
			headSha,
			...(picture === undefined ? {} : { picture }),
		});
	/** What the repository holds, with main/ looked at file by file: `repaired` is "none" when it was main's files. */
	async function state(f: Fixture, c: Company) {
		const checked = await checkCodeArea(c.job, { repository: kept });
		if (checked.state !== "present") throw new Error("the repository is absent");
		return {
			main: checked.mainSha,
			files: (await repo(f, c, "ls-tree", "-r", "--name-only", checked.mainSha)).split("\n").filter(Boolean),
			repaired: checked.repaired,
			refs: checked.refsSha256,
		};
	}
	/** Every command of the jobs is one LXD exec can carry, with the code host's settings and no other; git works on
	 * the git directory it is given, but for the clone that proves a download. */
	function expectJobCommands(log: CodeHostCommand[]) {
		for (const command of log) {
			expect(command.env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
			expect(command.argv.length).toBeLessThanOrEqual(64);
			if (command.argv[0] === GIT) expect(command.argv[2]).toMatch(/^(--git-dir=\/|clone$)/);
		}
	}
	/** A repository with three changes: a fast-forward of three commits, a merge, and a fast-forward of one. */
	async function changes() {
		const f = await fixture(),
			c = await f.company();
		const { baseSha } = await startCodeArea(c.job, { repository: kept });
		const first = await session(f, c, baseSha),
			second = await session(f, c, baseSha);
		await first.commit({ "index.html": "<p>shop</p>\n" }, "shop");
		await first.commit({ "src/a.js": "a\n" }, "a");
		const one = await land(c, first, await first.commit({ "src/b.js": "b\n" }, "b"));
		const two = await land(c, second, await second.commit({ "cart.js": "cart\n" }, "cart"));
		const third = await session(f, c, two.mainSha);
		const three = await land(c, third, await third.commit({ "later.txt": "later\n" }, "later"));
		expect([one.state, two.state, three.state]).toEqual(["fast-forward", "merged", "fast-forward"]);
		return { f, c, baseSha, first, second, third, one, two, three };
	}
	/** A change as its record gives it: its number and the two ends of main. */
	const span = (n: number, landed: { mainBefore: string; mainSha: string }) => ({
		n,
		mainBefore: landed.mainBefore,
		mainAfter: landed.mainSha,
	});
	const undo = (
		c: Company,
		change: { n: number; mainBefore: string; mainAfter: string },
		more: { requestId?: string; andLater?: boolean; message?: string } = {},
	) =>
		undoCodeChange(c.job, {
			repository: kept,
			requestId: more.requestId ?? randomUUID(),
			change,
			andLater: more.andLater ?? false,
			message: more.message ?? `Undo change ${change.n}: a title`,
		});

	it("a landing answers where main was, what it changed in main's files, and where main already held the commit", async () => {
		const f = await fixture(),
			c = await f.company();
		const { baseSha } = await startCodeArea(c.job, { repository: kept });
		const first = await session(f, c, baseSha),
			second = await session(f, c, baseSha);
		// Three commits landed as one fast-forward: the change is main before to main after, not one commit's.
		const h1 = await first.commit({ "index.html": "<p>shop</p>\n" }, "shop");
		await first.commit({ "src/a.js": "a\n" }, "a");
		const h3 = await first.commit({ "src/b.js": "b\n" }, "b");
		expect(await land(c, first, h3)).toEqual({
			state: "fast-forward",
			mainSha: h3,
			mainBefore: baseSha,
			containedAt: null,
			diff: {
				filesChanged: 3,
				paths: [
					{ path: "index.html", change: "added" },
					{ path: "src/a.js", change: "added" },
					{ path: "src/b.js", change: "added" },
				],
				pathsMore: 0,
			},
			picture: null,
			restored: [],
		});
		// A merge: what main got is the session's two files, whatever the merge commit's parents hold.
		const x1 = await second.commit({ "cart.js": "export const cart = [];\n" }, "cart");
		const x2 = await second.commit({ "cart.test.js": "test\n", "docs/cart.png": png }, "test");
		const merged = await land(c, second, x2, "docs/cart.png");
		expect(merged).toEqual({
			state: "merged",
			mainSha: await repo(f, c, "rev-parse", "refs/heads/main"),
			mainBefore: h3,
			containedAt: null,
			diff: {
				filesChanged: 3,
				paths: [
					{ path: "cart.js", change: "added" },
					{ path: "cart.test.js", change: "added" },
					{ path: "docs/cart.png", change: "added" },
				],
				pathsMore: 0,
			},
			picture: {
				state: "ok",
				blob: await repo(f, c, "rev-parse", `${x2}:docs/cart.png`),
				bytes: png.length,
				type: "png",
			},
			restored: [],
		});
		expect(merged.mainSha).not.toBe(x2);
		// A file changed and a file removed.
		const third = await session(f, c, merged.mainSha);
		await rm(join(third.tree, "src/a.js"));
		const last = await third.commit({ "index.html": "<p>store</p>\n" }, "store");
		expect((await land(c, third, last)).diff).toEqual({
			filesChanged: 2,
			paths: [
				{ path: "index.html", change: "changed" },
				{ path: "src/a.js", change: "removed" },
			],
			pathsMore: 0,
		});

		// Main already holds the commit: nothing changed, no picture is looked at, and the answer says which commit of
		// main first held it.
		const unchanged = (containedAt: string) => ({
			state: "unchanged",
			mainSha: last,
			mainBefore: last,
			containedAt,
			diff: none,
			picture: null,
			restored: [],
		});
		// Main itself.
		expect(await land(c, third, last, "index.html")).toEqual(unchanged(last));
		// A commit main stood at once, and one a fast-forward passed over: both are on main's own line.
		expect(await land(c, first, h3)).toEqual(unchanged(h3));
		expect(await land(c, first, h1)).toEqual(unchanged(h1));
		// A commit a merge brought in, and one behind it (two steps behind the merge's second parent, where
		// `rev-list --first-parent --ancestry-path` prints nothing): the merge.
		expect(await land(c, second, x2)).toEqual(unchanged(merged.mainSha));
		expect(await land(c, second, x1)).toEqual(unchanged(merged.mainSha));

		// More than fifty paths: the first fifty are named and the rest counted.
		const fourth = await session(f, c, last);
		const many = Object.fromEntries(
			Array.from({ length: 60 }, (_, index) => [`many/f${String(index).padStart(2, "0")}.txt`, `${index}\n`]),
		);
		const counted = (await land(c, fourth, await fourth.commit(many, "many"))).diff;
		expect(counted).toMatchObject({ filesChanged: 60, pathsMore: 10 });
		expect(counted.paths).toEqual(
			Object.keys(many)
				.slice(0, 50)
				.map((path) => ({ path, change: "added" })),
		);
		// Long paths (398 bytes each): the names listed stay within 8 KiB together, which is twenty of them.
		const long = Object.fromEntries(
			Array.from({ length: 30 }, (_, index) => [
				`${"d".repeat(200)}/${"e".repeat(190)}-${String(index).padStart(2, "0")}.txt`,
				`${index}\n`,
			]),
		);
		const cut = (await land(c, fourth, await fourth.commit(long, "long"))).diff;
		expect(cut).toMatchObject({ filesChanged: 30, pathsMore: 10 });
		expect(cut.paths.map((entry) => entry.path)).toEqual(Object.keys(long).slice(0, 20));
		// A merge's picture is looked for in the merge, the commit that becomes main: a path only main's side holds is
		// found there (and is no picture), though the session's own commit has no such file.
		const fifth = await session(f, c, baseSha);
		const late = await land(c, fifth, await fifth.commit({ "notes.txt": "notes\n" }, "notes"), "cart.js");
		expect(late).toMatchObject({
			state: "merged",
			diff: { filesChanged: 1, paths: [{ path: "notes.txt", change: "added" }], pathsMore: 0 },
			picture: { state: "not_a_picture" },
		});
		expect(await readdir(c.scratchRoot)).toEqual([]);
		expectJobCommands(c.log);
	});

	it("checks a session's picture in git, at the commit that becomes main, and says which check failed", async () => {
		const f = await fixture(),
			c = await f.company();
		const { baseSha } = await startCodeArea(c.job, { repository: kept });
		const s = await session(f, c, baseSha);
		const large = Buffer.alloc(4 * 1024 ** 2 + 1);
		png.copy(large);
		await mkdir(join(s.tree, "docs"));
		await symlink("shot.png", join(s.tree, "docs/link.png"));
		await writeFile(join(s.tree, "docs/run.png"), png);
		await chmod(join(s.tree, "docs/run.png"), 0o755);
		const head = await s.commit(
			{
				"docs/shot.png": png,
				"docs/shot.jpg": jpeg,
				"docs/shot.webp": webp,
				"docs/four-mib.png": large.subarray(0, 4 * 1024 ** 2),
				"docs/over.png": large,
				"docs/notes.png": "not a picture\n",
				"docs/empty.png": "",
				"docs/wave.webp": Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVEfmt ")]),
				"docs/short.jpg": Buffer.from([0xff, 0xd8]),
			},
			"pictures",
		);
		const ok = async (path: string, bytes: number, type: string) => ({
			state: "ok",
			blob: await repo(f, c, "rev-parse", `${head}:${path}`),
			bytes,
			type,
		});
		expect((await land(c, s, head, "docs/shot.png")).picture).toEqual(await ok("docs/shot.png", png.length, "png"));
		const cases: [string, unknown][] = [
			["docs/shot.jpg", await ok("docs/shot.jpg", jpeg.length, "jpeg")],
			["docs/shot.webp", await ok("docs/shot.webp", webp.length, "webp")],
			// An executable file is a file.
			["docs/run.png", await ok("docs/run.png", png.length, "png")],
			["docs/four-mib.png", await ok("docs/four-mib.png", 4 * 1024 ** 2, "png")],
			["docs/over.png", { state: "too_large" }],
			["docs/notes.png", { state: "not_a_picture" }],
			["docs/empty.png", { state: "not_a_picture" }],
			["docs/wave.webp", { state: "not_a_picture" }],
			["docs/short.jpg", { state: "not_a_picture" }],
			["docs/link.png", { state: "not_a_file" }],
			["docs", { state: "not_a_file" }],
			["docs/none.png", { state: "missing" }],
			["Docs/shot.png", { state: "missing" }],
			// What can be no path in a repository names nothing.
			["docs/../docs/shot.png", { state: "missing" }],
			["/docs/shot.png", { state: "missing" }],
			["docs/shot.png/", { state: "missing" }],
			["", { state: "missing" }],
		];
		let main = head;
		for (const [index, [picture, expected]] of cases.entries()) {
			// The file in the session's folder is swapped after the commit: the check reads git's object.
			const next = await s.commit({ "n.txt": `${index}\n` }, `case ${index}`);
			await writeFile(join(s.tree, "docs/shot.jpg"), "swapped\n");
			const landed = await land(c, s, next, picture);
			expect(landed, picture).toMatchObject({ state: "fast-forward", mainBefore: main, mainSha: next });
			expect(landed.picture, picture).toEqual(expected);
			await writeFile(join(s.tree, "docs/shot.jpg"), jpeg);
			main = next;
		}
		// None given is none looked at, and a picture that is no string is no job.
		const next = await s.commit({ "n.txt": "last\n" }, "last");
		expect(
			(await landCodeBranch(c.job, { repository: kept, workerId: s.workerId, headSha: next, picture: undefined }))
				.picture,
		).toBeNull();
		const commands = c.log.length;
		for (const more of [{ picture: 5 }, { picture: null }, { shot: "docs/shot.png" }])
			await expect(
				landCodeBranch(c.job, { repository: kept, workerId: s.workerId, headSha: next, ...more } as never),
			).rejects.toThrow("INVALID_CODE_HOST_JOB");
		expect(c.log).toHaveLength(commands);
		expect(await readdir(c.scratchRoot)).toEqual([]);
		expectJobCommands(c.log);
	});

	it("records: writes each change's file, its picture out of git and the list; leaves a file that holds its bytes; renders a record from the diff it computes", async () => {
		const f = await fixture(),
			c = await f.company();
		const { baseSha } = await startCodeArea(c.job, { repository: kept });
		const s = await session(f, c, baseSha);
		const one = await s.commit({ "index.html": "<p>shop</p>\n", "docs/changes/shop.png": png }, "shop");
		const first = await land(c, s, one, "docs/changes/shop.png");
		if (first.picture?.state !== "ok") throw new Error("the picture was not taken");
		const two = await s.commit({ "index.html": "<p>store</p>\n", "src/cart.js": "cart\n" }, "store");
		await land(c, s, two);
		const before = await state(f, c);
		const render = (diff: CodeChangeDiff) =>
			`# Change 2\n\n- Files changed: ${diff.filesChanged}\n${diff.paths.map((entry) => `- ${entry.change} ${entry.path}\n`).join("")}`;
		const records: CodeChangeRecordFile[] = [
			{
				n: 1,
				text: "# Change 1: Shop\n\n> a session's words, and “quotes”\n",
				picture: { blob: first.picture.blob, to: `${area}/changes/1.png` },
			},
			{ n: 2, text: render, diff: { before: one, after: two } },
		];
		const index = "# Changes in qorpera/example\n\n- 2 · store\n- 1 · shop\n";
		const write = (value: { records: readonly CodeChangeRecordFile[]; index: string | null }) =>
			writeCodeChangeRecords(c.job, { repository: kept, ...value });
		expect(await write({ records, index })).toEqual({
			written: [1, 2],
			diffs: [
				{
					n: 2,
					filesChanged: 2,
					paths: [
						{ path: "index.html", change: "changed" },
						{ path: "src/cart.js", change: "added" },
					],
					pathsMore: 0,
				},
			],
			restored: [],
		});
		const folder = join(c.code, "changes");
		expect((await readdir(folder)).sort()).toEqual(["1.md", "1.png", "2.md", "index.md"]);
		expect(await readFile(join(folder, "1.md"), "utf8")).toBe(records[0]?.text);
		expect(await readFile(join(folder, "2.md"), "utf8")).toBe(
			"# Change 2\n\n- Files changed: 2\n- changed index.html\n- added src/cart.js\n",
		);
		expect((await readFile(join(folder, "1.png"))).equals(png)).toBe(true);
		expect(await readFile(join(folder, "index.md"), "utf8")).toBe(index);
		for (const name of ["1.md", "1.png", "index.md"])
			expect((await lstat(join(folder, name))).mode & 0o777).toBe(0o644);
		expect((await lstat(folder)).mode & 0o777).toBe(0o755);

		// Again: every file holds its bytes, and none is written (a written file is a new one renamed into place).
		const inodes = async (): Promise<Record<string, number>> =>
			Object.fromEntries(
				await Promise.all(
					(await readdir(folder))
						.sort()
						.map(async (name) => [name, (await lstat(join(folder, name))).ino] as const),
				),
			);
		const made = await inodes();
		expect(await write({ records, index })).toMatchObject({ written: [1, 2], restored: [] });
		expect(await inodes()).toEqual(made);
		// One record's text changed and no list given: that file alone is written.
		const changed: CodeChangeRecordFile[] = [
			{ ...(records[0] as CodeChangeRecordFile), text: "# Change 1: Shop\n\n- State: undone by change 3\n" },
			records[1] as CodeChangeRecordFile,
		];
		expect(await write({ records: changed, index: null })).toMatchObject({ written: [1, 2] });
		const later = await inodes();
		expect(later["1.md"]).not.toBe(made["1.md"]);
		expect({ ...later, "1.md": made["1.md"] }).toEqual(made);
		expect(await readFile(join(folder, "1.md"), "utf8")).toBe("# Change 1: Shop\n\n- State: undone by change 3\n");
		expect(await readFile(join(folder, "index.md"), "utf8")).toBe(index);
		// A picture that is not git's bytes any more is copied out again.
		await writeFile(join(folder, "1.png"), "swapped");
		await write({ records: changed, index: null });
		expect((await readFile(join(folder, "1.png"))).equals(png)).toBe(true);

		// What a restore took out of the repository is left out, and fails no job: a record whose diff names a commit
		// that is not here is not written, and a picture whose file version is not here (or is none) is not copied.
		const gone = "f".repeat(40);
		expect(
			await write({
				records: [
					{ n: 3, text: render, diff: { before: gone, after: two } },
					{ n: 4, text: "# Change 4\n", picture: { blob: gone, to: `${area}/changes/4.jpg` } },
					{
						n: 5,
						text: "# Change 5\n",
						picture: { blob: await repo(f, c, "rev-parse", `${two}^{tree}`), to: `${area}/changes/5.webp` },
					},
				],
				index: null,
			}),
		).toEqual({ written: [4, 5], diffs: [], restored: [] });
		expect((await readdir(folder)).sort()).toEqual(["1.md", "1.png", "2.md", "4.md", "5.md", "index.md"]);
		// No ref moved, and main/ is as it was.
		expect(await state(f, c)).toEqual({ ...before, repaired: "none" });
		expect(await readdir(c.scratchRoot)).toEqual([]);
		expectJobCommands(c.log);
	});

	it("records: many in one job; a folder where a file goes, a link where the folder is and a malformed record are refused", async () => {
		const { f, c, three } = await changes();
		const folder = join(c.code, "changes");
		const write = (value: unknown) =>
			writeCodeChangeRecords(c.job, { repository: kept, ...(value as { records: []; index: null }) });
		// Sixty records and the list, some of them long: each file gets exactly its own bytes off the one stream.
		const long = new Map([
			[2, 100_000],
			[3, 120_000],
			[27, 70_000],
		]);
		const many = Array.from({ length: 60 }, (_, index) => ({
			n: index + 1,
			text: `# Change ${index + 1}\n${long.has(index + 1) ? `${"é".repeat(long.get(index + 1) ?? 0)}\n` : ""}`,
		}));
		expect((await write({ records: many, index: "# The list\n" })).written).toEqual(many.map((record) => record.n));
		expect(await readdir(folder)).toHaveLength(61);
		for (const { n, text } of many) expect(await readFile(join(folder, `${n}.md`), "utf8"), `${n}.md`).toBe(text);
		expect(await readFile(join(folder, "index.md"), "utf8")).toBe("# The list\n");
		expectJobCommands(c.log);

		await rm(join(folder, "7.md"));
		await mkdir(join(folder, "7.md"));
		await expect(write({ records: many, index: null })).rejects.toMatchObject({
			code: "CODE_HOST_UNEXPECTED_FILE",
			paths: [`${area}/changes/7.md`],
		});
		await rm(folder, { recursive: true });
		await mkdir(join(f.root, "elsewhere"));
		await symlink(join(f.root, "elsewhere"), folder);
		await expect(write({ records: many.slice(0, 1), index: "# The list\n" })).rejects.toMatchObject({
			code: "CODE_HOST_LINK",
			paths: [`${area}/changes`],
		});
		expect(await readdir(join(f.root, "elsewhere"))).toEqual([]);

		const commands = c.log.length,
			head = three.mainSha;
		for (const value of [
			{ records: [{ n: 0, text: "x" }], index: null },
			{ records: [{ n: 1.5, text: "x" }], index: null },
			{
				records: [
					{ n: 1, text: "x" },
					{ n: 1, text: "y" },
				],
				index: null,
			},
			{ records: [{ n: 1, text: "" }], index: null },
			{ records: [{ n: 1, text: "a\0b" }], index: null },
			{ records: [{ n: 1 }], index: null },
			// A text still to be rendered, with nothing to render it from.
			{ records: [{ n: 1, text: () => "x" }], index: null },
			{ records: [{ n: 1, text: "x", diff: { before: "main", after: head } }], index: null },
			{ records: [{ n: 1, text: "x", diff: { before: head } }], index: null },
			// A picture goes beside its own record and nowhere else.
			{ records: [{ n: 1, text: "x", picture: { blob: head, to: `${area}/changes/2.png` } }], index: null },
			{ records: [{ n: 1, text: "x", picture: { blob: head, to: `${area}/main/1.png` } }], index: null },
			{ records: [{ n: 1, text: "x", picture: { blob: head, to: `${area}/changes/1.gif` } }], index: null },
			{ records: [{ n: 1, text: "x", picture: { blob: "main", to: `${area}/changes/1.png` } }], index: null },
			{ records: [{ n: 1, text: "x", state: "landed" }], index: null },
			{ records: Array.from({ length: 201 }, (_, index) => ({ n: index + 1, text: "x" })), index: null },
			{ records: "all", index: null },
			{ records: [], index: "" },
			{ records: [], index: "x".repeat(256 * 1024 + 1) },
			{ records: [] },
		])
			await expect(write(value)).rejects.toThrow("INVALID_CODE_HOST_JOB");
		expect(c.log).toHaveLength(commands);
		expect(await readdir(c.scratchRoot)).toEqual([]);
	});

	it("undo: takes one change out as one new commit of the platform's, a fast-forward of three commits and a merge alike, and an undo is undone the same way", async () => {
		const { f, c, one, two, three } = await changes();
		const requestId = randomUUID();
		const undone = await undo(c, span(1, one), { requestId, message: "Undo change 1: Shop" });
		if (undone.state !== "undone") throw new Error("the change was not undone");
		expect(undone).toEqual({
			state: "undone",
			mainBefore: three.mainSha,
			mainAfter: undone.mainAfter,
			diff: {
				filesChanged: 3,
				paths: [
					{ path: "index.html", change: "removed" },
					{ path: "src/a.js", change: "removed" },
					{ path: "src/b.js", change: "removed" },
				],
				pathsMore: 0,
			},
			replayed: false,
			matchesBeforeTree: false,
			checksFilePresent: false,
		});
		// Main and main/ moved together, to what main was without the three commits; everything since is kept.
		expect(await state(f, c)).toMatchObject({
			main: undone.mainAfter,
			files: ["cart.js", "later.txt"],
			repaired: "none",
		});
		expect((await readdir(join(c.code, "main"))).sort()).toEqual([".git", "cart.js", "later.txt"]);
		expect(await repo(f, c, "log", "-1", "--format=%P%n%an <%ae>%n%cn <%ce>%n%B", undone.mainAfter)).toBe(
			`${three.mainSha}\nQorpera <code@qorpera.com>\nQorpera <code@qorpera.com>\nUndo change 1: Shop\n\nQorpera-Request: ${requestId}`,
		);

		// The merge goes by the record's two ends of main, not by its parents.
		const second = await undo(c, span(2, two));
		if (second.state !== "undone") throw new Error("the merge was not undone");
		expect(second).toMatchObject({
			mainBefore: undone.mainAfter,
			diff: { filesChanged: 1, paths: [{ path: "cart.js", change: "removed" }], pathsMore: 0 },
			replayed: false,
			matchesBeforeTree: false,
			checksFilePresent: false,
		});
		expect((await state(f, c)).files).toEqual(["later.txt"]);

		// An undo is a change like any other: undoing it puts back what it took out.
		const back = await undo(c, { n: 4, mainBefore: undone.mainBefore, mainAfter: undone.mainAfter });
		if (back.state !== "undone") throw new Error("the undo was not undone");
		expect(back.diff).toEqual({
			filesChanged: 3,
			paths: [
				{ path: "index.html", change: "added" },
				{ path: "src/a.js", change: "added" },
				{ path: "src/b.js", change: "added" },
			],
			pathsMore: 0,
		});
		expect(await state(f, c)).toMatchObject({
			main: back.mainAfter,
			files: ["index.html", "later.txt", "src/a.js", "src/b.js"],
			repaired: "none",
		});
		expect(await readFile(join(c.code, "main/index.html"), "utf8")).toBe("<p>shop</p>\n");
		// Main's history stays one line: each undo's one parent is main before it.
		expect(await repo(f, c, "rev-list", "--first-parent", "--max-count=4", "refs/heads/main")).toBe(
			[back.mainAfter, second.mainAfter, undone.mainAfter, three.mainSha].join("\n"),
		);
		expect(await readdir(c.scratchRoot)).toEqual([]);
		expectJobCommands(c.log);
	});

	it("undo: an undo is undone by its own two ends, so a landing that came after it stays, though one wider row of the record covers both", async () => {
		const { f, c, one, three } = await changes();
		// The undo of change 1 moves main from three to U and takes three files out.
		const undone = await undo(c, span(1, one));
		if (undone.state !== "undone") throw new Error("the change was not undone");
		// A landing after it adds a file that has nothing to do with the undo.
		const next = await session(f, c, undone.mainAfter);
		const landed = await land(c, next, await next.commit({ "news.txt": "news\n" }, "news"));
		expect(landed.state).toBe("fast-forward");
		expect((await state(f, c)).files).toEqual(["cart.js", "later.txt", "news.txt"]);
		// The record lost both and holds them as one row, from three to the landing. The undo's own two ends are three
		// and U: undoing the undo by those puts back exactly what it took out.
		const back = await undo(c, { n: 5, mainBefore: undone.mainBefore, mainAfter: undone.mainAfter });
		if (back.state !== "undone") throw new Error("the undo was not undone");
		expect(undone.mainBefore).toBe(three.mainSha);
		expect(back.diff).toEqual({
			filesChanged: 3,
			paths: [
				{ path: "index.html", change: "added" },
				{ path: "src/a.js", change: "added" },
				{ path: "src/b.js", change: "added" },
			],
			pathsMore: 0,
		});
		expect((await state(f, c)).files).toEqual([
			"cart.js",
			"index.html",
			"later.txt",
			"news.txt",
			"src/a.js",
			"src/b.js",
		]);
		expect(await readFile(join(c.code, "main/news.txt"), "utf8")).toBe("news\n");
	});

	it("undo: a change later work built on is refused with its paths and nothing is written; andLater makes main's files what they were before it; a change main no longer holds is nothing", async () => {
		const { f, c, baseSha, third, one, two } = await changes();
		// A later change rewrote a file the first one added.
		const four = await land(c, third, await third.commit({ "index.html": "<p>store</p>\n" }, "store"));
		const before = {
			...(await state(f, c)),
			head: await readFile(join(c.repo, "worktrees/main/HEAD"), "utf8"),
		};
		await expect(undo(c, span(1, one))).rejects.toMatchObject({
			code: "CODE_HOST_UNDO_CONFLICT",
			paths: ["index.html"],
		});
		expect({ ...(await state(f, c)), head: await readFile(join(c.repo, "worktrees/main/HEAD"), "utf8") }).toEqual(
			before,
		);
		expect(before).toMatchObject({ main: four.mainSha, repaired: "none" });

		// That change and everything after it, together: no merge, so no conflict.
		const all = await undo(c, span(1, one), { andLater: true, message: "Go back to before change 1" });
		if (all.state !== "undone") throw new Error("the changes were not undone");
		expect(all).toMatchObject({ mainBefore: four.mainSha, replayed: false });
		expect(all.diff).toEqual({
			filesChanged: 5,
			paths: ["cart.js", "index.html", "later.txt", "src/a.js", "src/b.js"].map((path) => ({
				path,
				change: "removed",
			})),
			pathsMore: 0,
		});
		expect(await state(f, c)).toMatchObject({ main: all.mainAfter, files: [], repaired: "none" });
		expect(await readdir(join(c.code, "main"))).toEqual([".git"]);
		expect(await repo(f, c, "rev-parse", `${all.mainAfter}^{tree}`)).toBe(
			await repo(f, c, "rev-parse", `${baseSha}^{tree}`),
		);
		expect(await repo(f, c, "log", "-1", "--format=%P %s", all.mainAfter)).toBe(
			`${four.mainSha} Go back to before change 1`,
		);

		// Main no longer holds what those changes did: there is nothing to take out, and main stays.
		const nothing = { state: "nothing", mainSha: all.mainAfter };
		expect(await undo(c, span(1, one))).toEqual(nothing);
		expect(await undo(c, span(2, two))).toEqual(nothing);
		expect(await undo(c, span(1, one), { andLater: true })).toEqual(nothing);
		expect(await repo(f, c, "rev-parse", "refs/heads/main")).toBe(all.mainAfter);

		// And that undo undone: every change is back, the later one's file as it left it.
		expect((await undo(c, { n: 5, mainBefore: all.mainBefore, mainAfter: all.mainAfter })).state).toBe("undone");
		expect((await state(f, c)).files).toEqual(["cart.js", "index.html", "later.txt", "src/a.js", "src/b.js"]);
		expect(await readFile(join(c.code, "main/index.html"), "utf8")).toBe("<p>store</p>\n");
		expect(await readdir(c.scratchRoot)).toEqual([]);
	});

	it("undo: a request made again is found by its line in main's history and answered as it was, with main/ put right", async () => {
		const { f, c, two, three } = await changes();
		const requestId = randomUUID();
		const undone = await undo(c, span(2, two), { requestId });
		if (undone.state !== "undone") throw new Error("the change was not undone");
		// That run's job saved the branch and lost the rest: main/ holds the files of main before it.
		await f.git(join(c.code, "main"), "checkout", "--quiet", "--force", "--detach", three.mainSha);
		expect(await readFile(join(c.code, "main/cart.js"), "utf8")).toBe("cart\n");
		expect(await undo(c, span(2, two), { requestId })).toEqual({ ...undone, replayed: true });
		expect(await exists(join(c.code, "main/cart.js"))).toBe(false);
		expect(await state(f, c)).toMatchObject({
			main: undone.mainAfter,
			files: ["index.html", "later.txt", "src/a.js", "src/b.js"],
			repaired: "none",
		});
		// Another change lands after it: the request is still answered with its own commit, and none is made.
		const fourth = await session(f, c, undone.mainAfter);
		const more = await land(c, fourth, await fourth.commit({ "more.txt": "more\n" }, "more"));
		expect(await undo(c, span(2, two), { requestId })).toEqual({ ...undone, replayed: true });
		expect(await repo(f, c, "rev-parse", "refs/heads/main")).toBe(more.mainSha);
		// Another request for the same change finds main without it.
		expect(await undo(c, span(2, two))).toEqual({ state: "nothing", mainSha: more.mainSha });
		expect(await readdir(c.scratchRoot)).toEqual([]);
	});

	it("undo: refuses a change main does not hold, a commit that is not there, names the folder takes for one, a main that moved under it, and a malformed request", async () => {
		const { f, c, first, one, three } = await changes();
		// A session's commit that never landed.
		const loose = await first.commit({ "loose.txt": "loose\n" }, "loose");
		await expect(undo(c, { n: 9, mainBefore: three.mainSha, mainAfter: loose })).rejects.toMatchObject({
			code: "CODE_HOST_UNDO_NOT_IN_MAIN",
			paths: [loose],
		});
		const gone = "f".repeat(40),
			never = "e".repeat(40);
		await expect(undo(c, { n: 9, mainBefore: gone, mainAfter: three.mainSha })).rejects.toMatchObject({
			code: "CODE_HOST_UNDO_UNKNOWN_COMMIT",
			paths: [gone],
		});
		await expect(undo(c, { n: 9, mainBefore: gone, mainAfter: never })).rejects.toMatchObject({
			code: "CODE_HOST_UNDO_UNKNOWN_COMMIT",
			paths: [never, gone],
		});

		// A file was removed, and its name came back in another case: the old one put back would stand beside it.
		const s = await session(f, c, three.mainSha);
		await rm(join(s.tree, "later.txt"));
		const removed = await land(c, s, await s.commit({ "x.txt": "x\n" }, "without later"));
		const renamed = await land(c, s, await s.commit({ "Later.txt": "Later\n" }, "another later"));
		const refused = undo(c, span(4, removed));
		await expect(refused).rejects.toMatchObject({ code: "CODE_HOST_NAMES_DIFFER_BY_CASE" });
		expect([...(await refused.catch((error) => error.paths))].sort()).toEqual(["Later.txt", "later.txt"]);
		expect(await state(f, c)).toMatchObject({ main: renamed.mainSha, repaired: "none" });

		// Main moves between the undo's reading of it and its own move: the compare-and-swap fails, and nothing of the
		// undo is in main.
		const other = await s.commit({ "other.txt": "other\n" }, "other"),
			moving = join(f.root, "moving-git");
		await writeFile(
			moving,
			`#!/bin/sh\nfor a do [ "$a" = commit-tree ] && ${GIT} --git-dir="${c.repo}" update-ref refs/heads/main ${other} ${renamed.mainSha}; done\nexec ${GIT} "$@"\n`,
		);
		await chmod(moving, 0o755);
		await expect(
			undoCodeChange(
				{ ...c.job, layout: { ...c.job.layout, git: moving } },
				{
					repository: kept,
					requestId: randomUUID(),
					change: span(1, one),
					andLater: false,
					message: "Undo change 1",
				},
			),
		).rejects.toMatchObject({ code: "CODE_HOST_BASE_MOVED" });
		expect(await repo(f, c, "rev-parse", "refs/heads/main")).toBe(other);
		expect(await repo(f, c, "log", "--format=%s", "--grep=Undo change", "refs/heads/main")).toBe("");

		const commands = c.log.length;
		for (const more of [
			{ requestId: "request" },
			{ andLater: "yes" },
			{ message: "" },
			{ message: " \n" },
			{ message: "a\0b" },
			{ message: "x".repeat(4097) },
			{ change: { n: 0, mainBefore: three.mainSha, mainAfter: three.mainSha } },
			{ change: { n: 1, mainBefore: "main", mainAfter: three.mainSha } },
			{ change: { n: 1, mainAfter: three.mainSha } },
			{ change: 1 },
			{ reason: "it broke" },
		])
			await expect(
				undoCodeChange(c.job, {
					repository: kept,
					requestId: randomUUID(),
					change: span(1, one),
					andLater: false,
					message: "Undo change 1",
					...more,
				} as never),
			).rejects.toThrow("INVALID_CODE_HOST_JOB");
		expect(c.log).toHaveLength(commands);
		expect(await readdir(c.scratchRoot)).toEqual([]);
	});

	it("download: main's files as a zip under the repository's name, and main with its history as a bundle a plain clone checks out; one of each stays, and they are removed by name", async () => {
		const f = await fixture(),
			c = await f.company();
		const { baseSha } = await startCodeArea(c.job, { repository: kept });
		const s = await session(f, c, baseSha);
		await mkdir(join(s.tree, "bin"));
		await writeFile(join(s.tree, "bin/run.sh"), "#!/bin/sh\n");
		await chmod(join(s.tree, "bin/run.sh"), 0o755);
		await symlink("bin/run.sh", join(s.tree, "run"));
		const landed = await land(
			c,
			s,
			await s.commit(
				{
					"index.html": "<p>shop</p>\n",
					"src/cart.js": "export const cart = [];\n",
					"docs/shot.png": png,
					"docs/internal.md": "internal\n",
					".gitattributes": "docs/internal.md export-ignore\n",
				},
				"shop",
			),
		);
		const head = landed.mainSha;
		// Another session's work that is not in main.
		const other = await session(f, c, head);
		await other.commit({ "unlanded.txt": "unlanded\n" }, "unlanded");
		const before = await state(f, c),
			downloads = join(c.code, "downloads");

		const zipped = await archiveCodeArea(c.job, {
			repository: kept,
			file: "files",
			fileName: "example-2026-11-10.zip",
		});
		const zip = await readFile(join(downloads, "example-2026-11-10.zip"));
		expect(zipped).toEqual({
			path: `${area}/downloads/example-2026-11-10.zip`,
			bytes: zip.length,
			sha256: digest(zip),
			mainSha: head,
		});
		// Main's files, each under the repository's name (a folder has an entry of its own). What the repository's own
		// attributes mark export-ignore is left out, as git does.
		const entries = unzip(zip);
		expect([...entries.keys()].filter((name) => !name.endsWith("/")).sort()).toEqual([
			"example/.gitattributes",
			"example/bin/run.sh",
			"example/docs/shot.png",
			"example/index.html",
			"example/run",
			"example/src/cart.js",
		]);
		expect(entries.get("example/index.html")?.toString("utf8")).toBe("<p>shop</p>\n");
		expect(entries.get("example/src/cart.js")?.toString("utf8")).toBe("export const cart = [];\n");
		expect(entries.get("example/docs/shot.png")?.equals(png)).toBe(true);
		expect(entries.get("example/run")?.toString("utf8")).toBe("bin/run.sh");
		expect((await lstat(join(downloads, "example-2026-11-10.zip"))).mode & 0o777).toBe(0o644);

		// The same main another day: the same bytes under the new name, and the older zip is gone.
		expect(
			await archiveCodeArea(c.job, { repository: kept, file: "files", fileName: "example-2026-11-11.zip" }),
		).toEqual({ ...zipped, path: `${area}/downloads/example-2026-11-11.zip` });
		expect(await readdir(downloads)).toEqual(["example-2026-11-11.zip"]);

		// The history, for a developer: beside the zip.
		const bundled = await archiveCodeArea(c.job, {
			repository: kept,
			file: "history",
			fileName: "example-2026-11-11.bundle",
		});
		const file = join(downloads, "example-2026-11-11.bundle"),
			bundle = await readFile(file);
		expect(bundled).toEqual({
			path: `${area}/downloads/example-2026-11-11.bundle`,
			bytes: bundle.length,
			sha256: digest(bundle),
			mainSha: head,
		});
		expect((await readdir(downloads)).sort()).toEqual(["example-2026-11-11.bundle", "example-2026-11-11.zip"]);
		// It holds main and where HEAD is, and neither the sessions' branches nor the mark.
		expect(await f.src("bundle", "list-heads", file)).toBe(`${head} HEAD\n${head} refs/heads/main`);
		// A plain clone checks main out, with its history.
		const clone = join(f.root, "clone");
		await f.git(f.root, "clone", "--quiet", file, clone);
		expect(await f.git(clone, "status", "--short", "--branch")).toBe("## main...origin/main");
		expect(await f.git(clone, "rev-parse", "HEAD")).toBe(head);
		expect(await f.git(clone, "log", "--format=%s")).toBe("shop\nStart example");
		expect(await readFile(join(clone, "src/cart.js"), "utf8")).toBe("export const cart = [];\n");
		expect(await readFile(join(clone, "docs/internal.md"), "utf8")).toBe("internal\n");
		expect(await f.git(clone, "for-each-ref", "--format=%(refname)")).not.toContain("qorpera");
		expect(await f.git(clone, "fsck", "--full", "--strict", "--no-dangling", "--no-progress")).toBe("");

		// A new bundle takes the old one's place and leaves the zip.
		await archiveCodeArea(c.job, { repository: kept, file: "history", fileName: "example-2026-11-12.bundle" });
		const standing = ["example-2026-11-11.zip", "example-2026-11-12.bundle"];
		expect((await readdir(downloads)).sort()).toEqual(standing);
		// Too large: refused before anything is put in downloads/, and what stood there stays.
		for (const [kind, fileName] of [
			["files", "example-2026-11-13.zip"],
			["history", "example-2026-11-13.bundle"],
		] as const)
			await expect(
				archiveCodeArea(c.job, { repository: kept, file: kind, fileName }, { maximumBytes: 100 }),
			).rejects.toMatchObject({
				code: "CODE_HOST_DOWNLOAD_TOO_LARGE",
				// The same main is the same zip, byte for byte; a bundle's pack may come out another size.
				paths: [kind === "files" ? `${zip.length} bytes` : expect.stringMatching(/^\d+ bytes$/)],
			});
		expect((await readdir(downloads)).sort()).toEqual(standing);
		// At the limit it is made.
		expect(
			(
				await archiveCodeArea(
					c.job,
					{ repository: kept, file: "files", fileName: "example-2026-11-11.zip" },
					{ maximumBytes: zip.length },
				)
			).bytes,
		).toBe(zip.length);

		// Removed by name: a name that is not there is left out, a folder by a download's name stays, and a link goes
		// without what it points at.
		await mkdir(join(downloads, "folder.zip"));
		await writeFile(join(f.root, "kept.zip"), "kept\n");
		await symlink(join(f.root, "kept.zip"), join(downloads, "link.zip"));
		expect(
			await removeCodeDownloads(c.job, {
				repository: kept,
				fileNames: ["example-2026-11-11.zip", "example-2026-11-10.zip", "folder.zip", "link.zip"],
			}),
		).toEqual({ removed: ["example-2026-11-11.zip", "link.zip"] });
		expect((await readdir(downloads)).sort()).toEqual(["example-2026-11-12.bundle", "folder.zip"]);
		expect(await readFile(join(f.root, "kept.zip"), "utf8")).toBe("kept\n");
		await rm(join(downloads, "folder.zip"), { recursive: true });
		// The folder goes with its last file.
		expect(await removeCodeDownloads(c.job, { repository: kept, fileNames: ["example-2026-11-12.bundle"] })).toEqual({
			removed: ["example-2026-11-12.bundle"],
		});
		expect(await exists(downloads)).toBe(false);
		expect(await removeCodeDownloads(c.job, { repository: kept, fileNames: ["example-2026-11-12.bundle"] })).toEqual({
			removed: [],
		});
		expect(await removeCodeDownloads(c.job, { repository: kept, fileNames: [] })).toEqual({ removed: [] });

		// No ref moved, and main/ is as it was.
		expect(await state(f, c)).toEqual({ ...before, repaired: "none" });
		expect(await readdir(c.scratchRoot)).toEqual([]);
		expectJobCommands(c.log);
	});

	it("download: a repository with no files yet; refuses a name that is no plain file of its kind, a limit that is none, and a downloads/ that is a link", async () => {
		const f = await fixture(),
			c = await f.company();
		const { baseSha } = await startCodeArea(c.job, { repository: kept });
		const empty = await archiveCodeArea(c.job, { repository: kept, file: "files", fileName: "example.zip" });
		expect(empty.mainSha).toBe(baseSha);
		expect([...unzip(await readFile(join(c.code, "downloads/example.zip"))).keys()]).toEqual(["example/"]);
		expect(
			(await archiveCodeArea(c.job, { repository: kept, file: "history", fileName: "example.bundle" })).mainSha,
		).toBe(baseSha);
		await rm(join(c.code, "downloads"), { recursive: true });

		const commands = c.log.length;
		for (const [value, options] of [
			[{ file: "files", fileName: "example.bundle" }],
			[{ file: "history", fileName: "example.zip" }],
			[{ file: "all", fileName: "example.zip" }],
			[{ file: "files", fileName: "../example.zip" }],
			[{ file: "files", fileName: "a/example.zip" }],
			[{ file: "files", fileName: ".zip" }],
			[{ file: "files", fileName: "-o.zip" }],
			[{ file: "files", fileName: "example.zip.lock" }],
			[{ file: "files", fileName: `${"x".repeat(192)}.zip` }],
			[{ file: "files", fileName: 5 }],
			[{ file: "files" }],
			[{ file: "files", fileName: "example.zip" }, { maximumBytes: 0 }],
			[{ file: "files", fileName: "example.zip" }, { maximumBytes: 1.5 }],
			[{ file: "files", fileName: "example.zip" }, { maximumBytes: 256 * 1024 ** 2 + 1 }],
		] as [Record<string, unknown>, { maximumBytes: number }?][])
			await expect(archiveCodeArea(c.job, { repository: kept, ...value } as never, options)).rejects.toThrow(
				"INVALID_CODE_HOST_JOB",
			);
		for (const fileNames of [
			["a/b.zip"],
			["example.txt"],
			["x.zip", "x.zip"],
			Array.from({ length: 21 }, (_, index) => `f${index}.zip`),
			"x.zip",
		])
			await expect(removeCodeDownloads(c.job, { repository: kept, fileNames } as never)).rejects.toThrow(
				"INVALID_CODE_HOST_JOB",
			);
		expect(c.log).toHaveLength(commands);

		await mkdir(join(f.root, "elsewhere"));
		await writeFile(join(f.root, "elsewhere/keep.zip"), "keep\n");
		await symlink(join(f.root, "elsewhere"), join(c.code, "downloads"));
		await expect(
			archiveCodeArea(c.job, { repository: kept, file: "files", fileName: "example.zip" }),
		).rejects.toMatchObject({ code: "CODE_HOST_LINK", paths: [`${area}/downloads`] });
		await expect(removeCodeDownloads(c.job, { repository: kept, fileNames: ["keep.zip"] })).rejects.toMatchObject({
			code: "CODE_HOST_LINK",
			paths: [`${area}/downloads`],
		});
		expect(await readdir(join(f.root, "elsewhere"))).toEqual(["keep.zip"]);
		expect(await readdir(c.scratchRoot)).toEqual([]);
	});

	it("the jobs are a kept repository's alone: nothing is made where none is seeded, and a copy of a GitHub repository is refused", async () => {
		const f = await fixture(),
			c = await f.company();
		const jobs = (repository: unknown = kept) => {
			const here = repository as typeof kept;
			return [
				() =>
					writeCodeChangeRecords(c.job, {
						repository: here,
						records: [{ n: 1, text: "# 1\n" }],
						index: "# list\n",
					}),
				() =>
					undoCodeChange(c.job, {
						repository: here,
						requestId: randomUUID(),
						change: { n: 1, mainBefore: f.baseSha, mainAfter: f.baseSha },
						andLater: false,
						message: "Undo change 1",
					}),
				() => archiveCodeArea(c.job, { repository: here, file: "files", fileName: "example.zip" }),
				() => archiveCodeArea(c.job, { repository: here, file: "history", fileName: "example.bundle" }),
				() => removeCodeDownloads(c.job, { repository: here, fileNames: ["example.zip"] }),
			];
		};
		for (const job of jobs()) await expect(job()).rejects.toMatchObject({ code: "CODE_HOST_NOT_SEEDED" });
		expect(await readdir(c.companyRoot)).toEqual([]);
		// A repository on GitHub is none of theirs: refused before any command.
		const commands = c.log.length;
		for (const job of jobs(f.repository)) await expect(job()).rejects.toThrow("INVALID_CODE_HOST_JOB");
		expect(c.log).toHaveLength(commands);
		// A copy of a GitHub repository at the same place has no mark.
		await seedCodeArea(c.job, {
			repository: f.repository,
			baseSha: f.baseSha,
			bundle: await f.bundle("refs/heads/main"),
		});
		for (const job of jobs())
			await expect(job()).rejects.toMatchObject({ code: "CODE_HOST_AREA_FROM_GITHUB", paths: [area] });
		expect((await readdir(c.code)).sort()).toEqual(["main", "repo.git"]);
		expect(await f.git(c.repo, "--git-dir=.", "rev-parse", "refs/heads/main")).toBe(f.baseSha);
		expect(await readdir(c.scratchRoot)).toEqual([]);
	});

	it("a place a restore is working on is closed: every job is refused before it repairs or makes anything there, but a restore's own", async () => {
		const f = await fixture(),
			c = await f.company();
		const prepare = (restoring?: boolean) =>
			withJob(c.job, kept, (run) => run.prepare(undefined, restoring === undefined ? undefined : { restoring }));
		const mark = join(c.code, "restoring.json"),
			closed = { code: "CODE_HOST_RESTORE_IN_PROGRESS", paths: [area] };
		// Between a restore's two jobs the place holds the mark alone: a session's first turn starts no empty repository
		// there.
		await mkdir(c.code, { recursive: true });
		await writeFile(mark, '{"schema":"qorpera.code-restoring/v1"}\n');
		await expect(startCodeArea(c.job, { repository: kept })).rejects.toMatchObject(closed);
		await expect(prepare()).rejects.toMatchObject(closed);
		await expect(prepare(false)).rejects.toMatchObject(closed);
		expect(await readdir(c.code)).toEqual(["restoring.json"]);
		expect(await prepare(true)).toMatchObject({ made: false, seeded: false, restoring: true, main: "none" });
		await rm(mark);
		expect(await prepare()).toMatchObject({ made: false, restoring: false });

		// A repository with work in it, and the mark there.
		const { baseSha } = await startCodeArea(c.job, { repository: kept });
		const s = await session(f, c, baseSha);
		const landed = await land(c, s, await s.commit({ "index.html": "<p>shop</p>\n" }, "shop"));
		const next = await s.commit({ "more.txt": "more\n" }, "more");
		await writeFile(mark, "{}\n");
		// Something a job would put back on its way in.
		await writeFile(join(c.repo, "config"), "[core]\n\tbare = true\n\thooksPath = /elsewhere\n");
		const sink = { write: async () => {} };
		for (const job of [
			() => startCodeArea(c.job, { repository: kept }),
			() => addCodeWorktree(c.job, { repository: kept, workerId: randomUUID(), baseSha }),
			() => addCodeWorktree(c.job, { repository: kept, workerId: s.workerId, baseSha }),
			() => landCodeBranch(c.job, { repository: kept, workerId: s.workerId, headSha: next }),
			() => inspectCodeArea(c.job, { repository: kept, commit: next }),
			() =>
				exportCodeBranch(
					c.job,
					{ repository: kept, workerId: s.workerId, baseSha, headSha: next },
					{ maximumBytes: 1024 },
				),
			() => checkCodeArea(c.job, { repository: kept }),
			() => fsckCodeArea(c.job, { repository: kept }),
			() => bundleCodeArea(c.job, { repository: kept, refsSha256: "0".repeat(64) }, sink),
			() => retireCodeWorktrees(c.job, { repository: kept, workerIds: [] }, { phase: "files" }),
			() => writeCodeChangeRecords(c.job, { repository: kept, records: [{ n: 1, text: "# 1\n" }], index: null }),
			() => undo(c, span(1, landed)),
			() => archiveCodeArea(c.job, { repository: kept, file: "files", fileName: "example.zip" }),
			() => removeCodeDownloads(c.job, { repository: kept, fileNames: ["example.zip"] }),
		])
			await expect(job()).rejects.toMatchObject(closed);
		expect(await readFile(join(c.repo, "config"), "utf8")).toBe("[core]\n\tbare = true\n\thooksPath = /elsewhere\n");
		expect(await readFile(join(c.repo, "refs/heads/main"), "utf8")).toBe(`${landed.mainSha}\n`);
		expect((await readdir(c.code)).sort()).toEqual(["main", "repo.git", "restoring.json", "worktrees"]);
		// A restore's own job passes, and finds the place prepared as every job does.
		expect(await prepare(true)).toMatchObject({ made: true, seeded: true, restoring: true, main: "present" });
		expect(await readFile(join(c.repo, "config"), "utf8")).toBe(CODE_AREA_CONFIG);

		// Whatever has the mark's name closes the place; for a restore's own job it is a file, and never a link.
		await rm(mark);
		await mkdir(mark);
		await expect(prepare()).rejects.toMatchObject(closed);
		await expect(prepare(true)).rejects.toMatchObject({
			code: "CODE_HOST_UNEXPECTED_FILE",
			paths: [`${area}/restoring.json`],
		});
		await rm(mark, { recursive: true });
		await symlink("main", mark);
		for (const restoring of [true, undefined])
			await expect(prepare(restoring)).rejects.toMatchObject({
				code: "CODE_HOST_LINK",
				paths: [`${area}/restoring.json`],
			});
		// With the mark gone the repository works as before.
		await rm(mark);
		expect(await land(c, s, next)).toMatchObject({ state: "fast-forward", mainBefore: landed.mainSha });
		expect(await readdir(c.scratchRoot)).toEqual([]);
	});
});

describe("code host: a landing in two jobs with the checks between them (own code storage, step 3)", () => {
	const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
	const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("a picture")]);
	const none: CodeChangeDiff = { filesChanged: 0, paths: [], pathsMore: 0 };
	const missing: CodeCommitFile = { entry: { kind: "missing" }, blob: null },
		other: CodeCommitFile = { entry: { kind: "other" }, blob: null };
	const repo = (f: Fixture, c: Company, ...args: string[]) => f.git(c.repo, "--git-dir=.", ...args);
	const checksText = (...names: string[]) =>
		`${JSON.stringify({ checks: names.map((name) => ({ name, run: `npm run ${name}` })) }, null, "\t")}\n`;
	/** The checks file as job A answers it: its bytes, and its blob at that commit. */
	const file = async (f: Fixture, c: Company, commit: string, text: string): Promise<CodeCommitFile> => ({
		entry: { kind: "file", bytes: new Uint8Array(Buffer.from(text)) },
		blob: await repo(f, c, "rev-parse", `${commit}:${CODE_CHECKS_FILE}`),
	});
	/** Job A: the candidate, and the checks file at it and at main. */
	const toCheck = (c: Company, s: { workerId: string }, headSha: string, picture?: string) =>
		landCodeBranch(c.job, {
			repository: kept,
			workerId: s.workerId,
			headSha,
			checks: true,
			...(picture === undefined ? {} : { picture }),
		});
	/** Job B: exactly the candidate job A made. */
	const landAs = (
		c: Company,
		s: { workerId: string },
		headSha: string,
		wanted: NonNullable<CodeBranchLanding["expect"]>,
		picture?: string,
	) =>
		landCodeBranch(c.job, {
			repository: kept,
			workerId: s.workerId,
			headSha,
			expect: wanted,
			...(picture === undefined ? {} : { picture }),
		});
	/** Every path under a code area with what it holds, so a job that wrote nothing leaves it equal. */
	async function snapshot(dir: string): Promise<Record<string, string>> {
		const found: Record<string, string> = {};
		for (const path of (await readdir(dir, { recursive: true })).sort()) {
			const at = join(dir, path),
				info = await lstat(at);
			found[path] = info.isSymbolicLink()
				? `link ${await readlink(at)}`
				: info.isDirectory()
					? "folder"
					: `file ${info.mode.toString(8)} ${digest(await readFile(at))}`;
		}
		return found;
	}
	const changed = (before: Record<string, string>, after: Record<string, string>) =>
		[...new Set([...Object.keys(before), ...Object.keys(after)])]
			.filter((path) => before[path] !== after[path])
			.sort();

	it("to-check: a fast-forward and a merge are answered with the checks file at both ends, having moved nothing; expect then lands exactly that candidate, with its picture and diff", async () => {
		const f = await fixture(),
			c = await f.company();
		const { baseSha } = await startCodeArea(c.job, { repository: kept });
		const first = await session(f, c, baseSha),
			second = await session(f, c, baseSha);
		const text = checksText("install", "test");
		const h1 = await first.commit(
			{ [CODE_CHECKS_FILE]: text, "index.html": "<p>shop</p>\n", "docs/shot.png": png },
			"shop",
		);
		const before = await snapshot(c.code);
		expect(await toCheck(c, first, h1, "docs/shot.png")).toEqual({
			state: "to-check",
			how: "fast-forward",
			mainBefore: baseSha,
			mainAfter: h1,
			checks: await file(f, c, h1, text),
			mainChecks: missing,
			restored: [],
		});
		// Nothing moved and nothing was written: the default branch, main/ and the objects are as they were.
		expect(changed(before, await snapshot(c.code))).toEqual([]);
		// Job B lands exactly that candidate, and answers what a landing answers today.
		expect(
			await landAs(c, first, h1, { how: "fast-forward", mainBefore: baseSha, mainAfter: h1 }, "docs/shot.png"),
		).toEqual({
			state: "fast-forward",
			mainSha: h1,
			mainBefore: baseSha,
			containedAt: null,
			diff: {
				filesChanged: 3,
				paths: [
					{ path: CODE_CHECKS_FILE, change: "added" },
					{ path: "docs/shot.png", change: "added" },
					{ path: "index.html", change: "added" },
				],
				pathsMore: 0,
			},
			picture: {
				state: "ok",
				blob: await repo(f, c, "rev-parse", `${h1}:docs/shot.png`),
				bytes: png.length,
				type: "png",
			},
			restored: [],
		});
		expect(await repo(f, c, "rev-parse", "refs/heads/main")).toBe(h1);
		expect(await readFile(join(c.code, "main", CODE_CHECKS_FILE), "utf8")).toBe(text);

		// A session that began before: its candidate is the merge with main, which job A writes and no ref names.
		const h2 = await second.commit({ "cart.js": "export const cart = [];\n", "docs/cart.png": png }, "cart");
		const between = await snapshot(c.code);
		const merge = await toCheck(c, second, h2, "docs/cart.png");
		if (merge.state !== "to-check") throw new Error(`job A answered ${merge.state}`);
		expect(merge).toEqual({
			state: "to-check",
			how: "merged",
			mainBefore: h1,
			mainAfter: merge.mainAfter,
			checks: await file(f, c, merge.mainAfter, text),
			mainChecks: await file(f, c, h1, text),
			restored: [],
		});
		expect(await repo(f, c, "log", "-1", "--format=%P %an %cn", merge.mainAfter)).toBe(`${h1} ${h2} Qorpera Qorpera`);
		// Only new objects were written: no ref, nothing of main/ and nothing else.
		const written = changed(between, await snapshot(c.code));
		expect(written.length).toBeGreaterThan(0);
		for (const path of written) {
			expect(path).toMatch(/^repo\.git\/objects\//);
			expect(between[path]).toBeUndefined();
		}
		expect(await repo(f, c, "for-each-ref", "--points-at", merge.mainAfter)).toBe("");
		// Job B lands the merge job A made, and makes none of its own.
		const commands = c.log.length;
		expect(
			await landAs(c, second, h2, { how: "merged", mainBefore: h1, mainAfter: merge.mainAfter }, "docs/cart.png"),
		).toEqual({
			state: "merged",
			mainSha: merge.mainAfter,
			mainBefore: h1,
			containedAt: null,
			diff: {
				filesChanged: 2,
				paths: [
					{ path: "cart.js", change: "added" },
					{ path: "docs/cart.png", change: "added" },
				],
				pathsMore: 0,
			},
			picture: {
				state: "ok",
				blob: await repo(f, c, "rev-parse", `${merge.mainAfter}:docs/cart.png`),
				bytes: png.length,
				type: "png",
			},
			restored: [],
		});
		expect(
			c.log
				.slice(commands)
				.some(
					(command) =>
						command.argv.includes("commit-tree") ||
						command.argv.includes("merge-tree") ||
						command.argv.includes(CODE_CHECKS_FILE),
				),
		).toBe(false);
		expect(await repo(f, c, "rev-parse", "refs/heads/main")).toBe(merge.mainAfter);
		expect((await readdir(join(c.code, "main"))).sort()).toEqual([
			".git",
			".qorpera",
			"cart.js",
			"docs",
			"index.html",
		]);
		expect(await readdir(c.scratchRoot)).toEqual([]);
	});

	it("to-check: the file at the candidate only, at main only, at both; a folder or a link there is other; a file of 20 KiB comes back cut", async () => {
		const f = await fixture(),
			c = await f.company();
		const { baseSha } = await startCodeArea(c.job, { repository: kept });
		const s = await session(f, c, baseSha);
		const at = join(s.tree, CODE_CHECKS_FILE);
		const text = checksText("test");
		const h1 = await s.commit({ [CODE_CHECKS_FILE]: text }, "checks");
		expect(await toCheck(c, s, h1)).toMatchObject({
			how: "fast-forward",
			checks: await file(f, c, h1, text),
			mainChecks: missing,
		});
		await landAs(c, s, h1, { how: "fast-forward", mainBefore: baseSha, mainAfter: h1 });
		// Main has it, and the candidate removed it.
		await rm(join(s.tree, ".qorpera"), { recursive: true });
		const h2 = await s.commit({ "a.txt": "a\n" }, "no checks");
		expect(await toCheck(c, s, h2)).toEqual({
			state: "to-check",
			how: "fast-forward",
			mainBefore: h1,
			mainAfter: h2,
			checks: missing,
			mainChecks: await file(f, c, h1, text),
			restored: [],
		});
		// Both have it, changed at the candidate; an executable file is a file.
		const more = checksText("test", "build");
		await s.commit({ [CODE_CHECKS_FILE]: more }, "more checks");
		await chmod(at, 0o755);
		const h3 = await s.commit({ "b.txt": "b\n" }, "executable");
		expect(await repo(f, c, "ls-tree", h3, "--", CODE_CHECKS_FILE)).toMatch(/^100755 blob /);
		expect(await toCheck(c, s, h3)).toMatchObject({
			checks: await file(f, c, h3, more),
			mainChecks: await file(f, c, h1, text),
		});
		// A folder at the path, and a link: something there that is no file.
		await rm(at);
		await mkdir(at);
		await writeFile(join(at, "inside"), "x\n");
		expect(await toCheck(c, s, await s.commit({}, "a folder"))).toMatchObject({
			checks: other,
			mainChecks: await file(f, c, h1, text),
		});
		await rm(at, { recursive: true });
		await symlink("../a.txt", at);
		const h5 = await s.commit({}, "a link");
		expect(await repo(f, c, "ls-tree", h5, "--", CODE_CHECKS_FILE)).toMatch(/^120000 blob /);
		expect(await toCheck(c, s, h5)).toMatchObject({ checks: other });
		// A file of 20 KiB: its first 16 KiB and one byte more, and the whole file's blob.
		await rm(at);
		const large = "x".repeat(20 * 1024);
		const h6 = await s.commit({ [CODE_CHECKS_FILE]: large }, "large");
		expect(await toCheck(c, s, h6)).toMatchObject({
			checks: {
				entry: { kind: "file", bytes: new Uint8Array(Buffer.from(large.slice(0, 16 * 1024 + 1))) },
				blob: await repo(f, c, "rev-parse", `${h6}:${CODE_CHECKS_FILE}`),
			},
		});
		// None of it moved main.
		expect(await repo(f, c, "rev-parse", "refs/heads/main")).toBe(h1);
		expect(await readdir(c.scratchRoot)).toEqual([]);
	});

	it("without a checks file at either end it lands as today; a commit main holds is unchanged as today; a conflict and a refusal by name come before any read", async () => {
		const f = await fixture(),
			c = await f.company();
		const { baseSha } = await startCodeArea(c.job, { repository: kept });
		const first = await session(f, c, baseSha),
			second = await session(f, c, baseSha);
		const h1 = await first.commit({ "index.html": "<p>shop</p>\n" }, "shop");
		expect(await toCheck(c, first, h1)).toEqual({
			state: "fast-forward",
			mainSha: h1,
			mainBefore: baseSha,
			containedAt: null,
			diff: { filesChanged: 1, paths: [{ path: "index.html", change: "added" }], pathsMore: 0 },
			picture: null,
			restored: [],
		});
		expect(await repo(f, c, "rev-parse", "refs/heads/main")).toBe(h1);
		// A merge, where `.qorpera` is a file and not a folder: nothing at the path either.
		const h2 = await second.commit({ ".qorpera": "a file\n", "cart.js": "cart\n" }, "cart");
		const merged = await toCheck(c, second, h2);
		if (merged.state !== "merged") throw new Error(`job A answered ${merged.state}`);
		expect(merged).toMatchObject({ mainBefore: h1, diff: { filesChanged: 2 } });
		expect(await repo(f, c, "rev-parse", "refs/heads/main")).toBe(merged.mainSha);
		// `checks` and `expect` left undefined are left out.
		const third = await session(f, c, merged.mainSha);
		const h3 = await third.commit({ "later.txt": "later\n" }, "later");
		expect(
			await landCodeBranch(c.job, {
				repository: kept,
				workerId: third.workerId,
				headSha: h3,
				checks: undefined,
				expect: undefined,
			}),
		).toMatchObject({ state: "fast-forward", mainSha: h3 });
		// Unchanged as today, also when what main holds has a checks file.
		expect(await toCheck(c, first, h1)).toEqual({
			state: "unchanged",
			mainSha: h3,
			mainBefore: h3,
			containedAt: h1,
			diff: none,
			picture: null,
			restored: [],
		});
		await rm(join(third.tree, ".qorpera"));
		const h4 = await third.commit({ [CODE_CHECKS_FILE]: checksText("test") }, "checks");
		await landAs(c, third, h4, { how: "fast-forward", mainBefore: h3, mainAfter: h4 });
		expect(await toCheck(c, third, h4, "later.txt")).toEqual({
			state: "unchanged",
			mainSha: h4,
			mainBefore: h4,
			containedAt: h4,
			diff: none,
			picture: null,
			restored: [],
		});
		// A conflict, and names that differ only by case: refused as today, and the checks file is never read.
		const commands = c.log.length;
		const fourth = await session(f, c, baseSha);
		const store = await fourth.commit(
			{ "index.html": "<p>store</p>\n", [CODE_CHECKS_FILE]: checksText("test") },
			"store",
		);
		await expect(toCheck(c, fourth, store)).rejects.toMatchObject({
			code: "CODE_HOST_LAND_CONFLICT",
			paths: ["index.html"],
		});
		const fifth = await session(f, c, h4);
		const named = await fifth.commit(
			{ "docs/Notes.md": "a\n", "docs/notes.md": "b\n", [CODE_CHECKS_FILE]: checksText("test", "build") },
			"names",
		);
		await expect(toCheck(c, fifth, named)).rejects.toMatchObject({ code: "CODE_HOST_NAMES_DIFFER_BY_CASE" });
		expect(c.log.slice(commands).some((command) => command.argv.includes(CODE_CHECKS_FILE))).toBe(false);
		expect(await repo(f, c, "rev-parse", "refs/heads/main")).toBe(h4);
		expect(await readdir(c.scratchRoot)).toEqual([]);
	});

	it("expect: stale, having written nothing, when main moved, when the session's branch no longer holds the commit, or when the candidate is not of those two; checks with expect is no job", async () => {
		const f = await fixture(),
			c = await f.company();
		const { baseSha } = await startCodeArea(c.job, { repository: kept });
		const s = await session(f, c, baseSha),
			another = await session(f, c, baseSha);
		const head = await s.commit({ [CODE_CHECKS_FILE]: checksText("test"), "a.txt": "a\n" }, "a");
		expect(await toCheck(c, s, head)).toMatchObject({
			state: "to-check",
			how: "fast-forward",
			mainBefore: baseSha,
			mainAfter: head,
		});
		const stale = async (wanted: NonNullable<CodeBranchLanding["expect"]>, headSha = head) => {
			const before = await snapshot(c.code);
			await expect(landAs(c, s, headSha, wanted), JSON.stringify(wanted)).rejects.toMatchObject({
				code: "CODE_HOST_LAND_STALE",
			});
			expect(changed(before, await snapshot(c.code)), JSON.stringify(wanted)).toEqual([]);
		};
		// Another session's landing moves main while the checks run.
		const moved = await landCodeBranch(c.job, {
			repository: kept,
			workerId: another.workerId,
			headSha: await another.commit({ "b.txt": "b\n" }, "b"),
		});
		await stale({ how: "fast-forward", mainBefore: baseSha, mainAfter: head });
		// Job A again: the candidate is now the merge with main.
		const merge = await toCheck(c, s, head);
		if (merge.state !== "to-check") throw new Error(`job A answered ${merge.state}`);
		expect(merge).toMatchObject({ how: "merged", mainBefore: moved.mainSha });
		const right = { how: "merged" as const, mainBefore: moved.mainSha, mainAfter: merge.mainAfter };
		// Not the candidate that was checked: the two parents the other way round, one parent too few, a commit that is
		// not there, a tree, the session's own commit, or the right one said to be a fast-forward or after another main.
		const tree = await repo(f, c, "rev-parse", `${merge.mainAfter}^{tree}`);
		const swapped = await repo(f, c, "commit-tree", tree, "-p", head, "-p", moved.mainSha, "-m", "swapped");
		const single = await repo(f, c, "commit-tree", tree, "-p", moved.mainSha, "-m", "one parent");
		for (const wanted of [
			{ ...right, mainAfter: swapped },
			{ ...right, mainAfter: single },
			{ ...right, mainAfter: "f".repeat(40) },
			{ ...right, mainAfter: tree },
			{ ...right, mainAfter: head },
			{ ...right, how: "fast-forward" as const },
			{ how: "fast-forward" as const, mainBefore: moved.mainSha, mainAfter: head },
			{ ...right, mainBefore: baseSha },
		])
			await stale(wanted);
		// The session's branch went back to its base, or is gone.
		await f.git(s.tree, "reset", "--quiet", "--hard", baseSha);
		await stale(right);
		await f.git(s.tree, "reset", "--quiet", "--hard", head);
		const branch = `refs/heads/qorpera/coding/${s.workerId}`;
		await repo(f, c, "update-ref", "-d", branch);
		await stale(right);
		await repo(f, c, "update-ref", branch, head);
		// The candidate that was checked lands; asked again, main holds the commit: unchanged, as today.
		expect(await landAs(c, s, head, right)).toMatchObject({
			state: "merged",
			mainSha: merge.mainAfter,
			mainBefore: moved.mainSha,
		});
		expect(await landAs(c, s, head, right)).toMatchObject({
			state: "unchanged",
			mainSha: merge.mainAfter,
			containedAt: merge.mainAfter,
		});
		// A fast-forward: its candidate is the session's commit, and a fast-forward it must be.
		await f.git(s.tree, "merge", "--quiet", "--ff-only", merge.mainAfter);
		const next = await s.commit({ "c.txt": "c\n" }, "c");
		await stale({ how: "fast-forward", mainBefore: merge.mainAfter, mainAfter: merge.mainAfter }, next);
		await stale({ how: "merged", mainBefore: merge.mainAfter, mainAfter: next }, next);
		expect(
			await landAs(c, s, next, { how: "fast-forward", mainBefore: merge.mainAfter, mainAfter: next }),
		).toMatchObject({ state: "fast-forward", mainSha: next });

		// Both options at once, and options that are not as the plan writes them: no job, no command.
		const commands = c.log.length;
		for (const more of [
			{ checks: true, expect: right },
			{ checks: false },
			{ checks: "yes" },
			{ checks: null },
			{ expect: null },
			{ expect: { ...right, how: "rebase" } },
			{ expect: { how: "merged", mainBefore: right.mainBefore } },
			{ expect: { ...right, headSha: head } },
			{ expect: { ...right, mainBefore: "main" } },
		])
			await expect(
				landCodeBranch(c.job, { repository: kept, workerId: s.workerId, headSha: next, ...more } as never),
				JSON.stringify(more),
			).rejects.toThrow("INVALID_CODE_HOST_JOB");
		expect(c.log).toHaveLength(commands);
		expect(await readdir(c.scratchRoot)).toEqual([]);
	});
});

describe("code host exec batching", () => {
	it("batches prepare into two commands, folds worktree locked into types, and repairs all expected files", async () => {
		const f = await fixture(),
			c = await f.company();
		const { baseSha } = await startCodeArea(c.job, { repository: kept });
		const s = await session(f, c, baseSha);

		const beforePrepare = c.log.length;
		const prepared = await withJob(c.job, kept, (run) => run.prepare(s.workerId));
		const prepareCommands = c.log.slice(beforePrepare);
		expect(prepared).toMatchObject({
			made: true,
			seeded: true,
			main: "present",
			worktree: { tree: "directory", admin: "directory", locked: "file" },
		});
		expect(prepareCommands).toHaveLength(4);

		const beforePresent = c.log.length;
		expect(await addCodeWorktree(c.job, { repository: kept, workerId: s.workerId, baseSha })).toEqual({
			state: "present",
			headSha: baseSha,
			restored: [],
		});
		expect(c.log.slice(beforePresent)).toHaveLength(6);

		await writeFile(join(c.repo, "config"), "[core]\n\tbare = true\n\thooksPath = /elsewhere\n");
		await writeFile(join(c.repo, "commondir"), "/elsewhere\n");
		await writeFile(join(c.code, "main/.git"), "gitdir: /elsewhere\n");
		await rm(join(c.repo, "worktrees/main/locked"));
		const beforeRepair = c.log.length;
		const repaired = await withJob(c.job, kept, async (run) => {
			await run.prepare();
			return run.restored;
		});
		expect(c.log.slice(beforeRepair)).toHaveLength(4);
		expect(repaired).toEqual([
			"code/qorpera/example/repo.git/config",
			"code/qorpera/example/repo.git/commondir",
			"code/qorpera/example/main/.git",
			"code/qorpera/example/repo.git/worktrees/main/locked",
		]);
		expect(await readFile(join(c.repo, "config"), "utf8")).toBe(CODE_AREA_CONFIG);
		expect(await exists(join(c.repo, "commondir"))).toBe(false);
		expect(await exists(join(c.repo, "worktrees/main/locked"))).toBe(true);
	});

	it("readMany reads present, empty, binary, and missing files in one exec and rejects malformed output", async () => {
		const f = await fixture(),
			c = await f.company();
		const { baseSha } = await startCodeArea(c.job, { repository: kept });
		const s = await session(f, c, baseSha);
		const emptyPath = join(s.tree, "empty.bin");
		const binaryPath = join(s.tree, "data.bin");
		const missingPath = join(s.tree, "does-not-exist");
		const binary = Buffer.from([0x00, 0x0a, 0x46, 0x20, 0x31, 0x0a, 0xff]);
		await writeFile(emptyPath, "");
		await writeFile(binaryPath, binary);

		const beforeEmpty = c.log.length;
		const emptyResult = await withJob(c.job, kept, (run) => run.readMany([]));
		expect(emptyResult).toEqual([]);
		expect(c.log.slice(beforeEmpty)).toHaveLength(2);

		const beforeRead = c.log.length;
		const values = await withJob(c.job, kept, (run) =>
			run.readMany([emptyPath, missingPath, binaryPath, join(c.code, "main/.git")]),
		);
		expect(c.log.slice(beforeRead)).toHaveLength(3);
		expect(values[0]?.equals(Buffer.alloc(0))).toBe(true);
		expect(values[1]).toBeNull();
		expect(values[2]?.equals(binary)).toBe(true);
		expect(values[3]?.toString("utf8")).toBe(`gitdir: ${c.repo}/worktrees/main\n`);

		const badJob: CodeHostJob = {
			...c.job,
			shell: {
				async run(command, signal) {
					if (command.argv[0] === "/bin/sh") return { status: 0, stdout: Buffer.from("F 999\nabc"), stderr: "" };
					return c.job.shell.run(command, signal);
				},
			},
		};
		await expect(withJob(badJob, kept, (run) => run.readMany([emptyPath]))).rejects.toMatchObject({
			code: "CODE_HOST_READ_FAILED",
		});
	});

	it("refsNamed batches ref lookups and validates lazily, and areCommits batches commit checks", async () => {
		const f = await fixture(),
			c = await f.company();
		const { baseSha } = await startCodeArea(c.job, { repository: kept });
		const s = await session(f, c, baseSha);
		const head = await s.commit({ "file.txt": "hello\n" }, "hello");
		const blob = await f.git(c.repo, "--git-dir=.", "rev-parse", `${head}:file.txt`);
		const tree = await f.git(c.repo, "--git-dir=.", "rev-parse", `${head}^{tree}`);
		await writeFile(join(c.repo, "refs/heads/sym"), "ref: refs/heads/main\n");
		await writeFile(join(c.repo, "refs/heads/blobref"), `${blob}\n`);

		const beforeRefs = c.log.length;
		await withJob(c.job, kept, async (run) => {
			const named = await run.refsNamed([
				CODE_AREA_IN_QORPERA_REF,
				"refs/heads/main",
				"refs/heads/main",
				"refs/heads/missing",
				"refs/heads/sym",
				"refs/heads/blobref",
			]);
			expect(named(CODE_AREA_IN_QORPERA_REF)).toBe(baseSha);
			expect(named("refs/heads/main")).toBe(baseSha);
			expect(named("refs/heads/missing")).toBeNull();
			expect(() => named("refs/heads/sym")).toThrow("CODE_HOST_REF_IS_SYMBOLIC");
			expect(() => named("refs/heads/blobref")).toThrow("CODE_HOST_REF_NOT_A_COMMIT");
		});
		expect(c.log.slice(beforeRefs).filter((command) => command.argv.includes("for-each-ref"))).toHaveLength(1);

		const beforeCommits = c.log.length;
		const checked = await withJob(c.job, kept, async (run) => {
			expect(await run.areCommits(run.repo, [])).toEqual([]);
			return await run.areCommits(run.repo, [head, blob, tree, "f".repeat(40)]);
		});
		expect(checked).toEqual([true, false, false, false]);
		expect(c.log.slice(beforeCommits).filter((command) => command.argv.includes("cat-file"))).toHaveLength(1);
	});

	it("writeCodeChangeRecords skips prepare only for a matching preparedKeptArea and still enforces ownPaths", async () => {
		const f = await fixture(),
			c = await f.company();
		const { baseSha } = await startCodeArea(c.job, { repository: kept });
		const s = await session(f, c, baseSha);
		const head = await s.commit({ "a.txt": "a\n" }, "a");
		await landCodeBranch(c.job, { repository: kept, workerId: s.workerId, headSha: head });

		const beforePrepared = c.log.length;
		const wrote = await writeCodeChangeRecords(
			{ ...c.job, preparedKeptArea: codeAreaPath(kept) },
			{ repository: kept, records: [{ n: 1, text: "# Change 1\n" }], index: "# Index\n" },
		);
		expect(wrote).toEqual({ written: [1], diffs: [], restored: [] });
		const preparedCommands = c.log.slice(beforePrepared);
		expect(preparedCommands.some((command) => (command.argv[2] ?? "").includes('cmp -s - "$p"'))).toBe(false);
		expect(preparedCommands.some((command) => command.argv.includes("for-each-ref"))).toBe(false);
		expect(await readFile(join(c.code, "changes/1.md"), "utf8")).toBe("# Change 1\n");

		await writeFile(join(c.code, "restoring.json"), "{}\n");
		await expect(
			writeCodeChangeRecords(
				{ ...c.job, preparedKeptArea: "code/qorpera/other" },
				{ repository: kept, records: [{ n: 2, text: "# Change 2\n" }], index: null },
			),
		).rejects.toMatchObject({ code: "CODE_HOST_RESTORE_IN_PROGRESS" });
		await rm(join(c.code, "restoring.json"));

		await rm(join(c.code, "changes"), { recursive: true });
		await mkdir(join(f.root, "outside"));
		await symlink(join(f.root, "outside"), join(c.code, "changes"));
		await expect(
			writeCodeChangeRecords(
				{ ...c.job, preparedKeptArea: codeAreaPath(kept) },
				{ repository: kept, records: [{ n: 3, text: "# Change 3\n" }], index: null },
			),
		).rejects.toMatchObject({ code: "CODE_HOST_LINK", paths: ["code/qorpera/example/changes"] });
	});

	it("deduplicates unchanged checks file reads and skips redundant branch checks in landCodeBranch", async () => {
		const f = await fixture(),
			c = await f.company();
		const { baseSha } = await startCodeArea(c.job, { repository: kept });
		const s = await session(f, c, baseSha);
		const checksBody = `${JSON.stringify({ checks: [{ name: "test", run: "npm test" }] })}\n`;
		const h1 = await s.commit({ [CODE_CHECKS_FILE]: checksBody, "a.txt": "a\n" }, "init checks");
		await landCodeBranch(c.job, { repository: kept, workerId: s.workerId, headSha: h1 });

		const h2 = await s.commit({ "b.txt": "b\n" }, "add b");
		const before = c.log.length;
		const toCheck = await landCodeBranch(c.job, {
			repository: kept,
			workerId: s.workerId,
			headSha: h2,
			checks: true,
		});
		expect(toCheck.state).toBe("to-check");
		if (toCheck.state !== "to-check") throw new Error("expected to-check");
		expect(toCheck.checks).toEqual(toCheck.mainChecks);
		const jobACommands = c.log.slice(before);
		expect(jobACommands.filter((command) => command.argv.includes("for-each-ref"))).toHaveLength(1);
		expect(jobACommands.filter((command) => command.argv.includes("cat-file"))).toHaveLength(1);
		expect(jobACommands.filter((command) => command.argv.includes(CODE_CHECKS_FILE))).toHaveLength(1);
		expect(jobACommands.some((command) => command.argv.includes("ls-tree") && command.argv.includes("-r"))).toBe(
			false,
		);

		const beforeB = c.log.length;
		const landedB = await landCodeBranch(c.job, {
			repository: kept,
			workerId: s.workerId,
			headSha: h2,
			expect: { how: toCheck.how, mainBefore: toCheck.mainBefore, mainAfter: toCheck.mainAfter },
		});
		expect(landedB.state).toBe("fast-forward");
		const jobBCommands = c.log.slice(beforeB);
		expect(jobBCommands.some((command) => command.argv.includes("ls-tree"))).toBe(false);
	});

	it("retires worktrees containing gitignored node_modules, dist, target, and debug.log cleanly", async () => {
		const f = await fixture(),
			c = await f.company();
		const { baseSha } = await startCodeArea(c.job, { repository: kept });
		const s = await session(f, c, baseSha);
		const head = await s.commit(
			{ ".gitignore": "node_modules/\ndist/\ntarget/\n*.log\n", "src/app.ts": "export const x = 1;\n" },
			"add gitignore",
		);
		await landCodeBranch(c.job, { repository: kept, workerId: s.workerId, headSha: head });
		await mkdir(join(s.tree, "node_modules/pkg"), { recursive: true });
		await mkdir(join(s.tree, "dist"), { recursive: true });
		await mkdir(join(s.tree, "target/debug"), { recursive: true });
		await writeFile(join(s.tree, "node_modules/pkg/index.js"), "module.exports = 1;\n");
		await writeFile(join(s.tree, "dist/bundle.js"), "console.log(1);\n");
		await writeFile(join(s.tree, "target/debug/app"), "bin\n");
		await writeFile(join(s.tree, "debug.log"), "trace\n");

		expect(
			await retireCodeWorktrees(c.job, { repository: kept, workerIds: [s.workerId] }, { phase: "files" }),
		).toEqual({ retired: [s.workerId], kept: [] });
		expect(await exists(s.tree)).toBe(false);
		expect(
			await retireCodeWorktrees(c.job, { repository: kept, workerIds: [s.workerId] }, { phase: "git-folder" }),
		).toEqual({ retired: [s.workerId], kept: [] });
		expect(await exists(s.admin)).toBe(false);
	});

	it("packs archived session refs and site pins while keeping active session branches loose", async () => {
		const f = await fixture(),
			c = await f.company();
		const { baseSha } = await startCodeArea(c.job, { repository: kept });
		const active = await session(f, c, baseSha);
		const archived = await session(f, c, baseSha);
		const hActive = await active.commit({ "active.txt": "a\n" }, "active");
		const hArchived = await archived.commit({ "archived.txt": "b\n" }, "archived");
		await landCodeBranch(c.job, { repository: kept, workerId: archived.workerId, headSha: hArchived });
		await retireCodeWorktrees(c.job, { repository: kept, workerIds: [archived.workerId] }, { phase: "files" });
		await retireCodeWorktrees(c.job, { repository: kept, workerIds: [archived.workerId] }, { phase: "git-folder" });
		const treeSha = await f.git(c.repo, "--git-dir=.", "rev-parse", `${hArchived}^{tree}`);
		await f.git(c.repo, "--git-dir=.", "update-ref", "--no-deref", "refs/qorpera/sites/change-1", treeSha);
		const gcUnblocked: CodeHostGcBlock = {
			begin: async () => ({ state: "blocking", held: 0 }),
			end: async () => undefined,
		};

		expect(
			await collectCodeGarbage(c.job, { repository: kept }, gcUnblocked, {
				packRefs: false,
				prune: false,
				packArchivedRefs: true,
			}),
		).toEqual({ state: "collected", restored: [] });
		expect(await exists(join(c.repo, "refs/heads/qorpera/coding", active.workerId))).toBe(true);
		expect(await exists(join(c.repo, "refs/heads/qorpera/coding", archived.workerId))).toBe(false);
		expect(await exists(join(c.repo, "refs/qorpera/sites/change-1"))).toBe(false);
		const packed = await readFile(join(c.repo, "packed-refs"), "utf8");
		expect(packed).toContain(`${hArchived} refs/heads/qorpera/coding/${archived.workerId}`);
		expect(packed).toContain(`${treeSha} refs/qorpera/sites/change-1`);
		expect(packed).not.toContain(`refs/heads/qorpera/coding/${active.workerId}`);
		expect(await f.git(c.repo, "--git-dir=.", "rev-parse", `refs/heads/qorpera/coding/${active.workerId}`)).toBe(
			hActive,
		);
	});

	it("bounds peak buffered bytes when streaming a bundle into a slow sink", async () => {
		const f = await fixture(),
			c = await f.company();
		const { baseSha } = await startCodeArea(c.job, { repository: kept });
		const s = await session(f, c, baseSha);
		const payload = Array.from({ length: 128 }, (_, i) =>
			createHash("sha256").update(`bundle-entropy-${i}`).digest("hex"),
		).join("\n");
		const head = await s.commit({ "large.txt": payload }, "large payload");
		await landCodeBranch(c.job, { repository: kept, workerId: s.workerId, headSha: head });
		const checked = await checkCodeArea(c.job, { repository: kept });
		if (checked.state !== "present") throw new Error("expected present area");
		const chunkBytes = 256;
		let inFlightBytes = 0;
		let peakBufferedBytes = 0;
		const wrappedShell = {
			run: async (command: CodeHostCommand, runSignal: AbortSignal) => {
				const innerOnStdout = command.onStdout;
				const trackedCommand: CodeHostCommand = innerOnStdout
					? {
							...command,
							onStdout: (chunk) => {
								inFlightBytes += chunk.length;
								if (inFlightBytes > peakBufferedBytes) peakBufferedBytes = inFlightBytes;
								innerOnStdout(chunk);
							},
						}
					: command;
				return await c.job.shell.run(trackedCommand, runSignal);
			},
		};
		const pieces: Buffer[] = [];
		const bundled = await bundleCodeArea(
			{ ...c.job, shell: wrappedShell },
			{ repository: kept, refsSha256: checked.refsSha256 },
			{
				write: async (chunk) => {
					await delay(5);
					inFlightBytes -= chunk.length;
					pieces.push(Buffer.from(chunk));
				},
			},
			{ chunkBytes },
		);
		const whole = Buffer.concat(pieces);
		expect(bundled.bytes).toBeGreaterThan(chunkBytes * 4);
		expect(whole.length).toBe(bundled.bytes);
		expect(createHash("sha256").update(whole).digest("hex")).toBe(bundled.sha256);
		expect(inFlightBytes).toBe(0);
		expect(peakBufferedBytes).toBeLessThanOrEqual(chunkBytes * 4);
	});

	it("upgrades partial changes/archive rollups to complete, skips overwriting complete rollups, and lists only complete ones", async () => {
		const f = await fixture(),
			c = await f.company();
		await startCodeArea(c.job, { repository: kept });
		const partialText =
			"# Changes 1 to 500 in qorpera/example\n\nStatus: partial (through 450).\n\n- 1 · 2026-11-10 · Init\n";
		const completeText = `# Changes 1 to 500 in qorpera/example\n\n${CODE_CHANGE_ARCHIVE_COMPLETE_LINE}\nSee changes/<n>.md for current status.\n\n- 1 · 2026-11-10 · Init\n`;
		await writeCodeChangeRecords(c.job, {
			repository: kept,
			records: [{ n: 1, text: "# Change 1\n" }],
			index: "# Changes in qorpera/example\n\n- 1 · 2026-11-10 · in main · Init\n",
			archives: [
				{ name: "0001-0500.md", text: partialText, immutable: false },
				{ name: "0501-1000.md", text: partialText, immutable: false },
			],
		});
		const archivePath = join(c.code, "changes/archive/0001-0500.md");
		expect(await readFile(archivePath, "utf8")).toBe(partialText);
		expect([...(await listCodeChangeArchives(c.job, kept))]).toEqual([]);

		await writeCodeChangeRecords(c.job, {
			repository: kept,
			records: [],
			index: null,
			archives: [{ name: "0001-0500.md", text: completeText, immutable: true }],
		});
		expect(await readFile(archivePath, "utf8")).toBe(completeText);
		expect([...(await listCodeChangeArchives(c.job, kept))]).toEqual(["0001-0500.md"]);

		await writeCodeChangeRecords(c.job, {
			repository: kept,
			records: [],
			index: null,
			archives: [{ name: "0001-0500.md", text: "# Attempted Overwrite\n", immutable: true }],
		});
		expect(await readFile(archivePath, "utf8")).toBe(completeText);
	});
});

describe("read-only git queries, conflict messages, v2 undo, tags, and prune", () => {
	const kept = { host: "qorpera" as const, owner: "qorpera", name: "example", baseBranch: "main" };

	async function session(
		f: Awaited<ReturnType<typeof fixture>>,
		c: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["company"]>>,
		baseSha: string,
	) {
		const workerId = randomUUID();
		await addCodeWorktree(c.job, { repository: kept, workerId, baseSha });
		const tree = join(c.code, "worktrees", workerId);
		const commit = async (files: Record<string, string | Buffer>, message: string) => {
			for (const [rel, content] of Object.entries(files)) {
				await mkdir(dirname(join(tree, rel)), { recursive: true });
				await writeFile(join(tree, rel), content);
			}
			await f.git(tree, "add", "--all");
			await f.git(tree, "commit", "--quiet", "-m", message);
			return f.git(tree, "rev-parse", "HEAD");
		};
		return { workerId, tree, commit, branch: `qorpera/coding/${workerId}` };
	}

	async function refsDigest(c: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["company"]>>) {
		const checked = await checkCodeArea(c.job, { repository: kept });
		if (checked.state !== "present") throw new Error("expected present");
		return checked.refsSha256;
	}

	it("runs log, diff, show, branches, and merge_preview read-only without mutating refs", async () => {
		const f = await fixture();
		const c = await f.company();
		const { baseSha } = await startCodeArea(c.job, { repository: kept });
		const s1 = await session(f, c, baseSha);
		const h1 = await s1.commit(
			{
				"src/app.ts": "export const v = 1;\n",
				"docs/notes.md": "hello\n",
				"bin/raw.dat": Buffer.from([0x00, 0x01, 0xff]),
			},
			"Add app and docs",
		);
		await symlink("notes.md", join(s1.tree, "docs/link.md"));
		await f.git(s1.tree, "add", "docs/link.md");
		await f.git(s1.tree, "commit", "--quiet", "-m", "Add symlink");
		const h1Link = await f.git(s1.tree, "rev-parse", "HEAD");
		const l1 = await landCodeBranch(c.job, { repository: kept, workerId: s1.workerId, headSha: h1Link });

		const s2 = await session(f, c, l1.mainSha);
		const bigBody = Array.from({ length: 120 }, (_, i) => `export const line${i} = ${i};`).join("\n");
		const h2 = await s2.commit({ "src/app.ts": `export const v = 2;\n${bigBody}\n` }, "Update app v2");
		const l2 = await landCodeBranch(c.job, { repository: kept, workerId: s2.workerId, headSha: h2 });

		const sActive = await session(f, c, l1.mainSha);
		const hConflict = await sActive.commit(
			{ "src/app.ts": "export const v = 99;\n", "src/extra.ts": "extra\n" },
			"Conflicting edit",
		);
		await f.git(c.repo, "--git-dir=.", "update-ref", "refs/qorpera/imported/heads/legacy", h1);

		const refsBefore = await refsDigest(c);

		const logMain = await logCodeArea(c.job, { repository: kept, ref: "main", limit: 2 });
		expect(logMain.resolvedSha).toBe(l2.mainSha);
		expect(logMain.commits).toHaveLength(2);
		expect(logMain.commits[0]?.subject).toBe("Update app v2");

		const logPath = await logCodeArea(c.job, { repository: kept, ref: `worker:${sActive.workerId}`, path: "src/extra.ts" });
		expect(logPath.resolvedSha).toBe(hConflict);
		expect(logPath.commits).toHaveLength(1);
		expect(logPath.commits[0]?.subject).toBe("Conflicting edit");

		const diffFull = await diffCodeArea(c.job, { repository: kept, from: l1.mainSha, to: l2.mainSha });
		expect(diffFull.filesChanged).toBe(1);
		expect(diffFull.patch).toContain("-export const v = 1;");
		expect(diffFull.patch).toContain("+export const v = 2;");
		expect(diffFull.truncated).toBe(false);

		const diffStat = await diffCodeArea(c.job, {
			repository: kept,
			from: baseSha,
			to: l2.mainSha,
			statOnly: true,
			paths: ["src/app.ts"],
		});
		expect(diffStat.patch).toBeNull();
		expect(diffStat.filesChanged).toBe(1);

		const diffTrunc = await diffCodeArea(c.job, { repository: kept, from: l1.mainSha, to: l2.mainSha, maxBytes: 1024 });
		expect(diffTrunc.truncated).toBe(true);
		expect(Buffer.byteLength(diffTrunc.patch ?? "")).toBeLessThanOrEqual(1024);

		const shown = await showCodeFile(c.job, { repository: kept, ref: l1.mainSha, path: "src/app.ts" });
		expect(shown.content).toBe("export const v = 1;\n");
		expect(shown.truncated).toBe(false);

		await expect(showCodeFile(c.job, { repository: kept, ref: "main", path: "docs/link.md" })).rejects.toMatchObject({
			code: "CODE_HOST_SYMLINK_REFUSED",
		});
		await expect(showCodeFile(c.job, { repository: kept, ref: "main", path: "bin/raw.dat" })).rejects.toMatchObject({
			code: "CODE_HOST_BINARY_FILE",
		});
		await expect(showCodeFile(c.job, { repository: kept, ref: "main", path: "missing.ts" })).rejects.toMatchObject({
			code: "CODE_HOST_FILE_NOT_FOUND",
		});
		await expect(showCodeFile(c.job, { repository: kept, ref: "main", path: "src" })).rejects.toMatchObject({
			code: "CODE_HOST_NOT_A_FILE",
		});

		const branches = await listCodeBranches(c.job, { repository: kept });
		expect(branches.main.sha).toBe(l2.mainSha);
		const activeBranch = branches.coding.find((b) => b.workerId === sActive.workerId);
		expect(activeBranch).toMatchObject({ sha: hConflict, ahead: 1, behind: 1 });
		expect(branches.imported.some((b) => b.name === "legacy")).toBe(true);

		const cleanPreview = await previewCodeMerge(c.job, {
			repository: kept,
			base: l1.mainSha,
			head: `worker:${sActive.workerId}`,
		});
		expect(cleanPreview.clean).toBe(true);
		expect(cleanPreview.conflictedPaths).toEqual([]);
		expect(cleanPreview.conflictMessages).toEqual([]);

		const conflictPreview = await previewCodeMerge(c.job, {
			repository: kept,
			base: "main",
			head: `worker:${sActive.workerId}`,
		});
		expect(conflictPreview.clean).toBe(false);
		expect(conflictPreview.conflictedPaths).toEqual(["src/app.ts"]);
		expect(conflictPreview.conflictMessages.join(" ")).toContain("CONFLICT");

		expect(await refsDigest(c)).toBe(refsBefore);
	});

	it("preserves conflict messages on landCodeBranch and supports dryRun, multi-target, and verifyChecks on undoCodeChange", async () => {
		const f = await fixture();
		const c = await f.company();
		const { baseSha } = await startCodeArea(c.job, { repository: kept });
		const s1 = await session(f, c, baseSha);
		const h1 = await s1.commit(
			{ "a.txt": "v1\n", [CODE_CHECKS_FILE]: JSON.stringify({ checks: [{ name: "test", run: "true" }] }) },
			"change 1",
		);
		const l1 = await landCodeBranch(c.job, { repository: kept, workerId: s1.workerId, headSha: h1 });

		const s2 = await session(f, c, l1.mainSha);
		const h2 = await s2.commit({ "b.txt": "b1\n" }, "change 2");
		const l2 = await landCodeBranch(c.job, { repository: kept, workerId: s2.workerId, headSha: h2 });

		const sConflict = await session(f, c, baseSha);
		const hConflict = await sConflict.commit({ "a.txt": "conflict\n" }, "conflicting");
		const landErr = await landCodeBranch(c.job, {
			repository: kept,
			workerId: sConflict.workerId,
			headSha: hConflict,
		}).catch((e) => e);
		expect(landErr).toBeInstanceOf(CodeHostRefusal);
		expect((landErr as CodeHostRefusal).code).toBe("CODE_HOST_LAND_CONFLICT");
		expect((landErr as CodeHostRefusal).paths).toEqual(["a.txt"]);
		expect((landErr as CodeHostRefusal).messages.join(" ")).toContain("CONFLICT");

		const refsBeforeDry = await refsDigest(c);
		const dry = await undoCodeChange(c.job, {
			repository: kept,
			requestId: randomUUID(),
			change: { n: 2, mainBefore: l2.mainBefore, mainAfter: l2.mainSha },
			andLater: false,
			message: "Dry run undo 2",
			dryRun: true,
		});
		expect(dry).toMatchObject({
			state: "dry_run",
			clean: true,
			mainBefore: l2.mainSha,
			matchesBeforeTree: true,
			checksFilePresent: true,
			conflictedPaths: [],
		});
		expect(await refsDigest(c)).toBe(refsBeforeDry);

		await expect(
			undoCodeChange(c.job, {
				repository: kept,
				requestId: randomUUID(),
				change: { n: 2, mainBefore: l2.mainBefore, mainAfter: l2.mainSha },
				andLater: false,
				message: "Blocked by checks",
				verifyChecks: async () => {
					throw new CodeHostRefusal("CODE_HOST_UNDO_CHECKS_FAILED", ["test"]);
				},
			}),
		).rejects.toMatchObject({ code: "CODE_HOST_UNDO_CHECKS_FAILED" });
		expect(await f.git(c.repo, "--git-dir=.", "rev-parse", "refs/heads/main")).toBe(l2.mainSha);

		const multi = await undoCodeChange(c.job, {
			repository: kept,
			requestId: randomUUID(),
			change: { n: 1, mainBefore: l1.mainBefore, mainAfter: l1.mainSha },
			andLater: false,
			message: "Revert 1 and 2",
			targets: [
				{ n: 2, mainBefore: l2.mainBefore, mainAfter: l2.mainSha },
				{ n: 1, mainBefore: l1.mainBefore, mainAfter: l1.mainSha },
			],
		});
		expect(multi).toMatchObject({ state: "undone", mainBefore: l2.mainSha, matchesBeforeTree: true });
		if (multi.state !== "undone") throw new Error("expected undone");
		expect(await exists(join(c.code, "main/a.txt"))).toBe(false);
		expect(await exists(join(c.code, "main/b.txt"))).toBe(false);
	});

	it("creates and lists lightweight/annotated tags and prunes archived worktrees and merged branches safely", async () => {
		const f = await fixture();
		const c = await f.company();
		const { baseSha } = await startCodeArea(c.job, { repository: kept });
		const sMerged = await session(f, c, baseSha);
		const hMerged = await sMerged.commit({ "merged.txt": "ok\n" }, "merged work");
		const landed = await landCodeBranch(c.job, { repository: kept, workerId: sMerged.workerId, headSha: hMerged });

		const sUnmerged = await session(f, c, landed.mainSha);
		await sUnmerged.commit({ "unmerged.txt": "wip\n" }, "unmerged work");

		const light = await tagCodeArea(c.job, { repository: kept, mode: "create", tag: "v1.0.0", target: "main" });
		expect(light).toMatchObject({ mode: "create", tag: "v1.0.0", kind: "lightweight", targetSha: landed.mainSha });
		const annotated = await tagCodeArea(c.job, {
			repository: kept,
			mode: "create",
			tag: "v1.0.1",
			target: landed.mainSha,
			message: "Release 1.0.1",
		});
		expect(annotated).toMatchObject({ mode: "create", tag: "v1.0.1", kind: "annotated", targetSha: landed.mainSha });
		await expect(
			tagCodeArea(c.job, { repository: kept, mode: "create", tag: "v1.0.0", target: "main" }),
		).rejects.toMatchObject({ code: "CODE_HOST_TAG_EXISTS" });
		const listed = await tagCodeArea(c.job, { repository: kept, mode: "list" });
		expect(listed.mode).toBe("list");
		if (listed.mode !== "list") throw new Error("expected list");
		expect(listed.tags.map((t) => t.tag).sort()).toEqual(["v1.0.0", "v1.0.1"]);

		const pruned = await pruneCodeArea(c.job, {
			repository: kept,
			workerIds: [sMerged.workerId, sUnmerged.workerId],
			deleteMergedBranches: true,
		});
		expect(pruned.retiredWorktrees.sort()).toEqual([sMerged.workerId, sUnmerged.workerId].sort());
		expect(pruned.deletedBranches).toEqual([`qorpera/coding/${sMerged.workerId}`]);
		expect(await exists(sMerged.tree)).toBe(false);
		expect(await exists(sUnmerged.tree)).toBe(false);
		expect(await f.git(c.repo, "--git-dir=.", "show-ref", "--verify", `refs/heads/qorpera/coding/${sUnmerged.workerId}`)).toBeTruthy();
	});
});
