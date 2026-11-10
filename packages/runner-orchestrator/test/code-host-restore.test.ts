import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { CODE_BUNDLE_FOLDER, codeBundleName, createCodeBundleStore } from "../src/code-bundle-store.ts";
import {
	addCodeWorktree,
	bundleCodeArea,
	CODE_AREA_CONFIG,
	type CodeAreaRef,
	type CodeHostCommand,
	type CodeHostGcBlock,
	type CodeHostJob,
	checkCodeArea,
	codeRefsSha256,
	fsckCodeArea,
	landCodeBranch,
	startCodeArea,
} from "../src/code-host-jobs.ts";
import {
	CODE_RESTORE_RPCS,
	CodeRestore,
	type CodeRestoreBundle,
	type CodeRestoreRequest,
	closeCodeArea,
	codeSetAsidePath,
	discardSetAside,
	openCodeArea,
	reopenCodeArea,
	restoreCodeArea,
	setAsideCodeArea,
	verifyCodeBundle,
} from "../src/code-host-restore.ts";
import type { CodeHostJobs } from "../src/code-host-views.ts";
import { localShell } from "./helpers/code-host-shell.ts";

const exec = promisify(execFile),
	roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const GIT = "/usr/bin/git";
const COMPANY = "11111111-1111-4111-8111-111111111111";
const ENVIRONMENT = "33333333-3333-4333-8333-333333333333";
const kept = { host: "qorpera" as const, owner: "acme", name: "app", baseBranch: "main" };
const AREA = "code/acme/app";
/** When the tests' restores close a place, and where they put what it held. */
const AT = "20261110T161455Z";
const ASIDE = `code/_set-aside/acme/at-${AT}/app`;
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const exists = (path: string) =>
	lstat(path).then(
		() => true,
		() => false,
	);

async function fixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "code-host-restore-")));
	roots.push(root);
	const companyRoot = join(root, "folder"),
		scratchRoot = join(root, "scratch"),
		controlRoot = join(root, "control");
	for (const dir of [companyRoot, scratchRoot, controlRoot]) await mkdir(dir);
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
	const log: CodeHostCommand[] = [];
	const job: CodeHostJob = {
		shell: localShell(log),
		layout: { companyRoot, scratchRoot, git: GIT },
		signal: new AbortController().signal,
	};
	const code = join(companyRoot, AREA),
		repo = join(code, "repo.git");
	/** Git on the repository's shared directory, or on the one set aside. */
	const inRepo = (...args: string[]) => git(repo, "--git-dir=.", ...args);
	/** Everything under a folder, each with its kind and, for a file, its size. */
	const listing = async (folder: string) =>
		(
			await exec("/usr/bin/find", [
				folder,
				"-mindepth",
				"1",
				"(",
				"-type",
				"f",
				"-printf",
				"f %s %P\\n",
				")",
				"-o",
				"-printf",
				"%y %P\\n",
			])
		).stdout
			.split("\n")
			.filter(Boolean)
			.sort();
	return {
		root,
		companyRoot,
		scratchRoot,
		controlRoot,
		git,
		inRepo,
		listing,
		log,
		job,
		code,
		repo,
		mark: join(code, "restoring.json"),
		aside: join(companyRoot, ASIDE),
	};
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** A session's worktree on the repository, and a commit there. */
async function session(f: Fixture, baseSha: string) {
	const workerId = randomUUID();
	await addCodeWorktree(f.job, { repository: kept, workerId, baseSha });
	const tree = join(f.code, "worktrees", workerId);
	const commit = async (files: Record<string, string>, message = "change") => {
		for (const [path, content] of Object.entries(files)) {
			await mkdir(dirname(join(tree, path)), { recursive: true });
			await writeFile(join(tree, path), content);
		}
		await f.git(tree, "add", "--all");
		await f.git(tree, "commit", "--quiet", "-m", message);
		return f.git(tree, "rev-parse", "HEAD");
	};
	return { workerId, tree, baseSha, commit };
}
const land = (f: Fixture, s: { workerId: string }, headSha: string) =>
	landCodeBranch(f.job, { repository: kept, workerId: s.workerId, headSha });

/** A repository with two changes landed by one session, and a second session with a commit that is not landed and a
 * file it has not committed. */
async function shop(f: Fixture) {
	const { baseSha } = await startCodeArea(f.job, { repository: kept });
	const first = await session(f, baseSha);
	const one = await land(f, first, await first.commit({ "index.html": "<p>shop</p>\n" }, "shop"));
	const two = await land(f, first, await first.commit({ "src/cart.js": "export const cart = [];\n" }, "cart"));
	const second = await session(f, two.mainSha);
	const work = await second.commit({ "work.txt": "work\n" }, "work");
	await writeFile(join(second.tree, "notes.txt"), "not committed\n");
	return { baseSha, first, second, one, two, work };
}

/** The place's bundle as nightly care makes it, with what its manifest would say. */
async function bundled(f: Fixture, createdAt = "2026-11-09T02:14:55.000Z") {
	const checked = await checkCodeArea(f.job, { repository: kept });
	if (checked.state !== "present") throw new Error("the repository is absent");
	const taken: Buffer[] = [];
	const made = await bundleCodeArea(
		f.job,
		{ repository: kept, refsSha256: checked.refsSha256 },
		{
			write: async (chunk) => {
				taken.push(Buffer.from(chunk));
			},
		},
	);
	const bundle: CodeRestoreBundle = {
		name: codeBundleName(createdAt, checked.mainSha),
		sha256: made.sha256,
		bytes: made.bytes,
		refsSha256: made.refsSha256,
		mainSha: checked.mainSha,
	};
	return { bytes: Buffer.concat(taken), bundle, refs: checked.refs, createdAt, gitVersion: made.gitVersion };
}
type Bundled = Awaited<ReturnType<typeof bundled>>;

/** A bundle's bytes as the store hands them out, in pieces. */
function pieces(bytes: Uint8Array, size = 64 * 1024): AsyncIterable<Uint8Array> {
	return (async function* () {
		for (let offset = 0; offset < bytes.length; offset += size) yield bytes.subarray(offset, offset + size);
	})();
}

/** The fixture's job on a code host that goes away at the command a test names. */
function stoppedAt(f: Fixture, stop: (command: CodeHostCommand) => boolean): CodeHostJob {
	const { shell } = f.job;
	return {
		...f.job,
		shell: {
			run: (command, signal) =>
				stop(command) ? Promise.reject(new Error("the code host went away")) : shell.run(command, signal),
		},
	};
}
/** The commands of a build, by what they do. */
const at = {
	init: (f: Fixture) => (command: CodeHostCommand) => command.argv.includes("init") && command.argv.at(-1) === f.repo,
	pack: () => (command: CodeHostCommand) => command.argv.includes("index-pack"),
	refs: (f: Fixture) => (command: CodeHostCommand) =>
		command.argv[0] === GIT && command.argv[2] === `--git-dir=${f.repo}` && command.argv.includes("update-ref"),
	main: () => (command: CodeHostCommand) =>
		command.argv[0] === "/bin/sh" && (command.argv[2] ?? "").includes("worktree add"),
	move: () => (command: CodeHostCommand) =>
		command.argv[0] === "/bin/sh" && (command.argv[2] ?? "").includes("mv --no-copy -T"),
};
/** The n-th command that matches, counted from 1. */
const nth = (n: number, matches: (command: CodeHostCommand) => boolean) => {
	let seen = 0;
	return (command: CodeHostCommand) => matches(command) && ++seen === n;
};

const close = (f: Fixture, b: Bundled, job = f.job, more: Partial<{ requestId: string; at: string }> = {}) =>
	closeCodeArea(
		job,
		{ repository: kept, requestId: more.requestId ?? randomUUID(), bundle: b.bundle, at: more.at ?? AT },
		pieces(b.bytes),
	);
const setAside = (f: Fixture, b: Bundled, job = f.job) =>
	setAsideCodeArea(job, { repository: kept, bundle: b.bundle.name });
const build = (f: Fixture, b: Bundled, job = f.job) =>
	restoreCodeArea(job, { repository: kept, bundle: b.bundle }, pieces(b.bytes));
const open = (
	f: Fixture,
	b: Bundled,
	more: Partial<{ tips: { n: number; mainAfter: string }[]; sessions: { workerId: string; baseSha: string }[] }> = {},
) => openCodeArea(f.job, { repository: kept, bundle: b.bundle, tips: more.tips ?? [], sessions: more.sessions ?? [] });
/** A place closed and seen emptied: ready for the build. */
async function emptied(f: Fixture, b: Bundled) {
	await close(f, b);
	expect((await setAside(f, b)).state).toBe("moved");
	expect(await setAside(f, b)).toEqual({ state: "set-aside", movedTo: ASIDE, moved: 0 });
}
const readMark = async (f: Fixture) => JSON.parse(await readFile(f.mark, "utf8"));
/** The repository's refs as the bundle's fingerprint counts them. */
async function refsOf(f: Fixture, repo = f.repo): Promise<CodeAreaRef[]> {
	return (await f.git(repo, "--git-dir=.", "for-each-ref", "--format=%(refname) %(objectname)"))
		.split("\n")
		.filter(Boolean)
		.map((line) => ({ name: line.split(" ")[0] as string, sha: line.split(" ")[1] as string }));
}
/** The place holds the bundle's repository, whole, and nothing of a worktree. */
async function expectBuilt(f: Fixture, b: Bundled) {
	expect(codeRefsSha256(await refsOf(f))).toBe(b.bundle.refsSha256);
	expect(await f.inRepo("rev-parse", "refs/heads/main")).toBe(b.bundle.mainSha);
	expect(await readFile(join(f.repo, "HEAD"), "utf8")).toBe("ref: refs/heads/main\n");
	expect(await readFile(join(f.repo, "config"), "utf8")).toBe(CODE_AREA_CONFIG);
	expect(await f.inRepo("fsck", "--full", "--strict", "--no-dangling", "--no-progress")).toBe("");
	expect(await readFile(join(f.repo, "worktrees/main/HEAD"), "utf8")).toBe(`${b.bundle.mainSha}\n`);
	// main/ holds main's files and no other.
	expect(
		(await f.inRepo("ls-tree", "-r", "--name-only", b.bundle.mainSha)).split("\n").filter(Boolean).sort(),
	).toEqual(
		(await f.listing(join(f.code, "main")))
			.flatMap((line) =>
				line.startsWith("f ") && line.split(" ")[2] !== ".git" ? [line.split(" ").slice(2).join(" ")] : [],
			)
			.sort(),
	);
	expect(await readdir(join(f.repo, "worktrees"))).toEqual(["main"]);
	expect((await readdir(f.code)).filter((name) => name !== "restoring.json").sort()).toEqual(["main", "repo.git"]);
}

describe("code host: restore of a repository kept in Qorpera from a stored bundle (own code storage, step 2b)", () => {
	it("verify: proves a stored bundle restores, in the scratch alone; each way a bundle fails its proof is refused", async () => {
		const f = await fixture(),
			s = await shop(f),
			b = await bundled(f);
		const before = await f.listing(f.companyRoot);
		const verify = (
			bundle: CodeRestoreBundle,
			bytes: Uint8Array = b.bytes,
			job = f.job,
			options?: { fsckMs?: number },
		) => verifyCodeBundle(job, { repository: kept, bundle }, pieces(bytes), options);
		expect(await verify(b.bundle)).toEqual({
			mainSha: s.two.mainSha,
			refsSha256: b.bundle.refsSha256,
			refs: b.refs.length,
		});
		expect(b.refs.map((ref) => ref.name)).toEqual(
			[
				"refs/heads/main",
				`refs/heads/qorpera/coding/${s.first.workerId}`,
				`refs/heads/qorpera/coding/${s.second.workerId}`,
				"refs/qorpera/kept-here",
			].sort(),
		);

		// The bytes are not the manifest's: one changed, one missing, one more.
		const changed = Buffer.from(b.bytes);
		changed[changed.length - 1] ^= 1;
		for (const bytes of [
			changed,
			b.bytes.subarray(0, b.bytes.length - 1),
			Buffer.concat([b.bytes, Buffer.from("x")]),
		])
			await expect(verify(b.bundle, bytes)).rejects.toMatchObject({
				code: "CODE_HOST_RESTORE_BUNDLE_DIFFERS",
				paths: [b.bundle.name],
			});
		// No room for three times the bundle: refused before a byte is taken.
		let taken = 0;
		await expect(
			verifyCodeBundle(
				f.job,
				{ repository: kept, bundle: { ...b.bundle, bytes: 2 ** 45 } },
				(async function* () {
					taken += 1;
					yield b.bytes;
				})(),
			),
		).rejects.toMatchObject({ code: "CODE_HOST_RESTORE_NO_SPACE" });
		expect(taken).toBe(0);
		// A manifest that says other refs, or another commit for main.
		await expect(verify({ ...b.bundle, refsSha256: "0".repeat(64) })).rejects.toMatchObject({
			code: "CODE_HOST_RESTORE_BUNDLE_REFS_DIFFER",
		});
		await expect(
			verify({ ...b.bundle, mainSha: s.one.mainSha, name: codeBundleName(b.createdAt, s.one.mainSha) }),
		).rejects.toMatchObject({ code: "CODE_HOST_RESTORE_BUNDLE_MAIN_DIFFERS" });
		/** A bundle git made by hand, with facts that are its own. */
		const made = async (repo: string, ...revs: string[]) => {
			const file = join(f.root, `${randomUUID()}.bundle`);
			await f.git(repo, "--git-dir=.", "bundle", "create", "--quiet", file, ...revs);
			const bytes = await readFile(file),
				refs = (await f.git(repo, "--git-dir=.", "bundle", "list-heads", file))
					.split("\n")
					.map((line) => ({ sha: line.split(" ")[0] as string, name: line.split(" ")[1] as string }))
					.filter((ref) => ref.name.startsWith("refs/"));
			const main = refs.find((ref) => ref.name === "refs/heads/main")?.sha as string;
			return {
				bytes,
				bundle: {
					name: codeBundleName(b.createdAt, main),
					sha256: digest(bytes),
					bytes: bytes.length,
					refsSha256: codeRefsSha256(refs),
					mainSha: main,
				},
			};
		};
		// One that needs a commit it does not hold.
		const thin = await made(f.repo, "refs/heads/main", "refs/qorpera/kept-here", `^${s.one.mainSha}`);
		await expect(verify(thin.bundle, thin.bytes)).rejects.toMatchObject({ code: "CODE_HOST_RESTORE_BUNDLE_FAILED" });
		// One of a repository that is none kept in Qorpera: no mark.
		const plain = await made(f.repo, "refs/heads/main");
		await expect(verify(plain.bundle, plain.bytes)).rejects.toMatchObject({
			code: "CODE_HOST_RESTORE_BUNDLE_NOT_KEPT",
		});
		// Objects git's own check finds damaged, and a check that does not end.
		const damaged = join(f.root, "damaged-git"),
			slow = join(f.root, "slow-git");
		await writeFile(
			damaged,
			`#!/bin/sh\nfor a do [ "$a" = fsck ] && { echo "error: object is damaged"; exit 4; }; done\nexec ${GIT} "$@"\n`,
		);
		await writeFile(slow, `#!/bin/sh\nfor a do [ "$a" = fsck ] && exec sleep 20; done\nexec ${GIT} "$@"\n`);
		await chmod(damaged, 0o755);
		await chmod(slow, 0o755);
		const failed = await verify(b.bundle, b.bytes, { ...f.job, layout: { ...f.job.layout, git: damaged } }).catch(
			(error) => error,
		);
		expect(failed).toMatchObject({ code: "CODE_HOST_RESTORE_BUNDLE_DAMAGED" });
		expect(failed.detail).toContain("object is damaged");
		await expect(
			verify(b.bundle, b.bytes, { ...f.job, layout: { ...f.job.layout, git: slow } }, { fsckMs: 200 }),
		).rejects.toMatchObject({ code: "CODE_HOST_RESTORE_BUNDLE_FSCK_TIMEOUT" });
		// A store that fails while the bundle is read says so itself.
		await expect(
			verifyCodeBundle(
				f.job,
				{ repository: kept, bundle: b.bundle },
				(async function* () {
					yield b.bytes.subarray(0, 100);
					throw new Error("CODE_BUNDLE_STORE_TIMEOUT");
				})(),
			),
		).rejects.toThrow("CODE_BUNDLE_STORE_TIMEOUT");
		// Not a job's values: refused before any command.
		const commands = f.log.length;
		for (const bad of [
			() =>
				verifyCodeBundle(f.job, { repository: { ...kept, host: "github.com" }, bundle: b.bundle }, pieces(b.bytes)),
			() => verify({ ...b.bundle, name: "latest" }),
			() => verify({ ...b.bundle, bytes: 0 }),
			() => verify({ ...b.bundle, sha256: "main" }),
			() => verify({ ...b.bundle, mainSha: s.one.mainSha }),
			() => verify({ ...b.bundle, extra: true } as never),
			() => verifyCodeBundle(f.job, { repository: kept, bundle: b.bundle }, b.bytes as never),
			() => verify(b.bundle, b.bytes, f.job, { fsckMs: 0 }),
		])
			await expect(bad()).rejects.toThrow("INVALID_CODE_HOST_JOB");
		expect(f.log).toHaveLength(commands);
		// Nothing in the company folder was written, and every scratch is gone.
		expect(await f.listing(f.companyRoot)).toEqual(before);
		expect(await readdir(f.scratchRoot)).toEqual([]);
	});

	it("verify: refuses a bundle the folder could not hold: names on main and refs that differ only by case", async () => {
		const f = await fixture(),
			s = await shop(f);
		// Main moved by hand to a commit no landing would take.
		const names = await s.first.commit({ "A.txt": "upper\n", "a.txt": "lower\n" }, "two names, one to the folder");
		await f.inRepo("update-ref", "refs/heads/main", names);
		const b = await bundled(f);
		await expect(
			verifyCodeBundle(f.job, { repository: kept, bundle: b.bundle }, pieces(b.bytes)),
		).rejects.toMatchObject({ code: "CODE_HOST_NAMES_DIFFER_BY_CASE", paths: ["A.txt", "a.txt"] });
		// A place is not closed for such a bundle.
		await expect(close(f, b)).rejects.toMatchObject({ code: "CODE_HOST_NAMES_DIFFER_BY_CASE" });
		expect(await exists(f.mark)).toBe(false);

		await f.inRepo("update-ref", "refs/heads/main", s.two.mainSha);
		await f.inRepo("update-ref", "refs/heads/Fix", s.one.mainSha);
		await f.inRepo("update-ref", "refs/heads/fix", s.one.mainSha);
		await f.inRepo("update-ref", "refs/heads/topic", s.one.mainSha);
		await f.inRepo("update-ref", "refs/heads/Topic/part", s.one.mainSha);
		const cased = await bundled(f);
		const refused = await verifyCodeBundle(
			f.job,
			{ repository: kept, bundle: cased.bundle },
			pieces(cased.bytes),
		).catch((error) => error);
		expect(refused).toMatchObject({ code: "CODE_HOST_RESTORE_REFS_DIFFER_BY_CASE" });
		expect([...refused.paths].sort()).toEqual(["refs/heads/fix", "refs/heads/topic"]);
		expect(await readdir(f.scratchRoot)).toEqual([]);
	});

	it("close: the bundle is proven first, then the place is marked, and every other job is refused there", async () => {
		const f = await fixture(),
			s = await shop(f),
			b = await bundled(f);
		const before = await f.listing(f.companyRoot),
			requestId = randomUUID();
		// A bundle that fails its proof closes nothing.
		await expect(
			closeCodeArea(
				f.job,
				{ repository: kept, requestId, bundle: b.bundle, at: AT },
				pieces(b.bytes.subarray(0, b.bytes.length - 1)),
			),
		).rejects.toMatchObject({ code: "CODE_HOST_RESTORE_BUNDLE_DIFFERS" });
		expect(await f.listing(f.companyRoot)).toEqual(before);

		expect(await close(f, b, f.job, { requestId })).toEqual({
			state: "closed",
			at: AT,
			step: "closed",
			setAside: null,
			previousMainSha: s.two.mainSha,
		});
		expect(await readMark(f)).toEqual({
			schema: "qorpera.code-restoring/v1",
			requestId,
			bundle: b.bundle.name,
			at: AT,
			step: "closed",
			setAside: null,
			previousMainSha: s.two.mainSha,
		});
		// The mark is the one thing written.
		const marked = await f.listing(f.companyRoot);
		expect(marked.filter((line) => !before.includes(line))).toEqual([
			`f ${(await readFile(f.mark)).length} ${AREA}/restoring.json`,
		]);
		expect(marked).toHaveLength(before.length + 1);
		// A session's first turn starts no empty repository there, its follow-up gets no worktree, and nothing lands.
		const next = await s.second.commit({ "more.txt": "more\n" }, "more");
		for (const job of [
			() => startCodeArea(f.job, { repository: kept }),
			() => addCodeWorktree(f.job, { repository: kept, workerId: randomUUID(), baseSha: s.two.mainSha }),
			() => addCodeWorktree(f.job, { repository: kept, workerId: s.second.workerId, baseSha: s.two.mainSha }),
			() => landCodeBranch(f.job, { repository: kept, workerId: s.second.workerId, headSha: next }),
			() => checkCodeArea(f.job, { repository: kept }),
		])
			await expect(job()).rejects.toMatchObject({ code: "CODE_HOST_RESTORE_IN_PROGRESS", paths: [AREA] });
		expect(await f.inRepo("rev-parse", "refs/heads/main")).toBe(s.two.mainSha);

		// Closed again, by the same request or a later one with the same bundle: the mark stays as it is.
		expect(await close(f, b, f.job, { at: "20261111T000000Z" })).toEqual({
			state: "present",
			at: AT,
			step: "closed",
			setAside: null,
			previousMainSha: s.two.mainSha,
		});
		expect((await readMark(f)).requestId).toBe(requestId);
		// Another bundle takes the mark over while nothing of the first is built: the place still holds its content.
		const other = {
			...b,
			bundle: { ...b.bundle, name: codeBundleName("2026-11-08T02:00:00.000Z", b.bundle.mainSha) },
		};
		expect(await close(f, other)).toMatchObject({ state: "present", at: AT, step: "closed" });
		expect(await readMark(f)).toMatchObject({ bundle: other.bundle.name, at: AT, requestId });
		await expect(setAside(f, b)).rejects.toMatchObject({
			code: "CODE_HOST_RESTORE_OTHER_BUNDLE",
			paths: [other.bundle.name],
		});
		expect(await close(f, b)).toMatchObject({ state: "present" });

		// A mark that is none of a restore's is refused, and so is a link in the place's way.
		await writeFile(f.mark, "{}\n");
		await expect(close(f, b)).rejects.toMatchObject({
			code: "CODE_HOST_RESTORE_MARK_UNREADABLE",
			paths: [`${AREA}/restoring.json`],
		});
		await writeFile(f.mark, "x".repeat(5000));
		await expect(setAside(f, b)).rejects.toMatchObject({ code: "CODE_HOST_RESTORE_MARK_UNREADABLE" });
		await rm(f.mark);
		await rename(f.code, join(f.root, "elsewhere"));
		await symlink(join(f.root, "elsewhere"), f.code);
		await expect(close(f, b)).rejects.toMatchObject({ code: "CODE_HOST_LINK", paths: [AREA] });
		await rm(f.code);

		// A place that is gone is closed too: the mark alone, in a folder made for it.
		expect(await close(f, b)).toEqual({
			state: "closed",
			at: AT,
			step: "closed",
			setAside: null,
			previousMainSha: null,
		});
		expect(await readdir(f.code)).toEqual(["restoring.json"]);
		await expect(startCodeArea(f.job, { repository: kept })).rejects.toMatchObject({
			code: "CODE_HOST_RESTORE_IN_PROGRESS",
		});
		for (const bad of [
			() => close(f, b, f.job, { at: "2026-11-10T16:14:55Z" }),
			() => close(f, b, f.job, { requestId: "request" }),
		])
			await expect(bad()).rejects.toThrow("INVALID_CODE_HOST_JOB");
		expect(await readdir(f.scratchRoot)).toEqual([]);
	});

	it("set aside: moves everything the place holds under code/_set-aside, and calls it done only when a later job sees the place empty", async () => {
		const f = await fixture(),
			s = await shop(f),
			b = await bundled(f);
		// What a restore must not lose: the change record's files, and a file nobody can explain.
		await mkdir(join(f.code, "changes"));
		await writeFile(join(f.code, "changes/1.md"), "# Change 1\n");
		await writeFile(join(f.code, "stray.txt"), "someone's\n");
		const held = await f.listing(f.code),
			refs = await refsOf(f);
		await expect(setAside(f, b)).rejects.toMatchObject({ code: "CODE_HOST_RESTORE_NOT_CLOSED", paths: [AREA] });
		await close(f, b);

		expect(await setAside(f, b)).toEqual({ state: "moved", movedTo: ASIDE, moved: 5 });
		expect(await readdir(f.code)).toEqual(["restoring.json"]);
		// As it was, to the byte: the session's file that was never committed too.
		expect(await f.listing(f.aside)).toEqual(held);
		expect(await readFile(join(f.aside, "worktrees", s.second.workerId, "notes.txt"), "utf8")).toBe(
			"not committed\n",
		);
		expect(await refsOf(f, join(f.aside, "repo.git"))).toEqual(refs);
		expect(await f.git(join(f.aside, "repo.git"), "--git-dir=.", "fsck", "--no-dangling", "--no-progress")).toBe("");
		// The job that moved wrote nothing else: the mark says so only once a later job has looked.
		expect(await readMark(f)).toMatchObject({ step: "closed", setAside: null });
		expect(await setAside(f, b)).toEqual({ state: "set-aside", movedTo: ASIDE, moved: 0 });
		expect(await readMark(f)).toMatchObject({ step: "emptied", setAside: ASIDE, bundle: b.bundle.name, at: AT });
		expect(await setAside(f, b)).toEqual({ state: "set-aside", movedTo: ASIDE, moved: 0 });
		expect(codeSetAsidePath(kept, AT)).toBe(ASIDE);
		// Still closed.
		await expect(startCodeArea(f.job, { repository: kept })).rejects.toMatchObject({
			code: "CODE_HOST_RESTORE_IN_PROGRESS",
		});
		expect(await readdir(f.scratchRoot)).toEqual([]);

		// A place that held nothing: there is nothing to set aside.
		const gone = await fixture();
		await close(gone, b);
		expect(await setAside(gone, b)).toEqual({ state: "absent", movedTo: null, moved: 0 });
		expect(await readMark(gone)).toMatchObject({ step: "emptied", setAside: null });
		expect(await exists(join(gone.companyRoot, "code/_set-aside"))).toBe(false);
	});

	it("set aside: goes on after a stop between two moves, and never writes over what is already aside", async () => {
		const f = await fixture();
		await shop(f);
		const b = await bundled(f);
		// More names than one command moves.
		for (let n = 0; n < 30; n += 1)
			await writeFile(join(f.code, `stray-${String(n).padStart(2, "0")}.txt`), `${n}\n`);
		const held = await f.listing(f.code);
		await close(f, b);
		await expect(setAside(f, b, stoppedAt(f, nth(2, at.move())))).rejects.toThrow("the code host went away");
		const left = (await readdir(f.code)).filter((name) => name !== "restoring.json").sort();
		expect(left.length).toBeGreaterThan(0);
		expect((await readdir(f.aside)).length).toBe(33 - left.length);
		// Half aside, the place stays closed, also for the way back.
		await expect(reopenCodeArea(f.job, { repository: kept, bundle: b.bundle.name })).rejects.toMatchObject({
			code: "CODE_HOST_RESTORE_HALF_SET_ASIDE",
			paths: [ASIDE],
		});
		expect(await readMark(f)).toMatchObject({ step: "closed" });
		// Something in the way of a name still to move (the folder holds one name per spelling): nothing more is moved.
		const blocked = left[0] as string;
		await writeFile(join(f.aside, blocked.toUpperCase()), "in the way\n");
		await expect(setAside(f, b)).rejects.toMatchObject({
			code: "CODE_HOST_RESTORE_SET_ASIDE_IN_THE_WAY",
			paths: [`${ASIDE}/${blocked}`],
		});
		expect((await readdir(f.code)).filter((name) => name !== "restoring.json").sort()).toEqual(left);
		await rm(join(f.aside, blocked.toUpperCase()));
		// The next run moves the rest, and the one after sees the place empty.
		expect(await setAside(f, b)).toEqual({ state: "moved", movedTo: ASIDE, moved: left.length });
		expect(await setAside(f, b)).toEqual({ state: "set-aside", movedTo: ASIDE, moved: 0 });
		expect(await f.listing(f.aside)).toEqual(held);
		expect(await readdir(f.scratchRoot)).toEqual([]);
	});

	it("build and open: the repository again from the bundle, with every ref, main, main/ and HEAD; sessions get their worktrees back and land", async () => {
		const f = await fixture(),
			s = await shop(f),
			b = await bundled(f);
		// A change after the bundle, and a session begun on it: the restore goes back past both.
		const three = await land(f, s.first, await s.first.commit({ "later.txt": "later\n" }, "later"));
		const late = await session(f, three.mainSha);
		await late.commit({ "late.txt": "late\n" }, "late");
		await expect(build(f, b)).rejects.toMatchObject({ code: "CODE_HOST_RESTORE_NOT_CLOSED" });
		await close(f, b);
		// Not before a job saw the place emptied.
		await expect(build(f, b)).rejects.toMatchObject({ code: "CODE_HOST_RESTORE_NOT_SET_ASIDE", paths: [AREA] });
		expect((await setAside(f, b)).state).toBe("moved");
		await expect(build(f, b)).rejects.toMatchObject({ code: "CODE_HOST_RESTORE_NOT_SET_ASIDE" });
		await expect(open(f, b)).rejects.toMatchObject({ code: "CODE_HOST_RESTORE_NOT_SET_ASIDE" });
		expect((await setAside(f, b)).state).toBe("set-aside");
		await expect(open(f, b)).rejects.toMatchObject({ code: "CODE_HOST_RESTORE_NOT_BUILT" });

		expect(await build(f, b)).toEqual({
			mainSha: s.two.mainSha,
			refsSha256: b.bundle.refsSha256,
			refs: b.refs.length,
		});
		await expectBuilt(f, b);
		expect(await refsOf(f)).toEqual(b.refs);
		expect((await readdir(join(f.code, "main"))).sort()).toEqual([".git", "index.html", "src"]);
		expect(await f.inRepo("log", "-1", "--format=%s", "refs/heads/main")).toBe("cart");
		// The mark is still there: the place opens in a job of its own.
		expect(await readMark(f)).toMatchObject({ step: "emptied", setAside: ASIDE });
		await expect(
			landCodeBranch(f.job, { repository: kept, workerId: s.second.workerId, headSha: s.work }),
		).rejects.toMatchObject({ code: "CODE_HOST_RESTORE_IN_PROGRESS" });
		// Built again on what it built: the same answer, and nothing changed.
		const built = await f.listing(f.code);
		expect(await build(f, b)).toEqual({
			mainSha: s.two.mainSha,
			refsSha256: b.bundle.refsSha256,
			refs: b.refs.length,
		});
		expect(await f.listing(f.code)).toEqual(built);

		const tips = [
				{ n: 1, mainAfter: s.one.mainSha },
				{ n: 3, mainAfter: three.mainSha },
				{ n: 2, mainAfter: s.two.mainSha },
			],
			never = randomUUID(),
			sessions = [
				{ workerId: s.first.workerId, baseSha: s.baseSha },
				{ workerId: s.second.workerId, baseSha: s.two.mainSha },
				// Begun after the bundle: neither its branch nor its base is here.
				{ workerId: late.workerId, baseSha: three.mainSha },
				// Never had a worktree, on a base the bundle holds.
				{ workerId: never, baseSha: s.one.mainSha },
			];
		expect(await open(f, b, { tips, sessions })).toEqual({
			state: "opened",
			mainSha: s.two.mainSha,
			keptThrough: 2,
			stranded: [late.workerId],
			previousMainSha: three.mainSha,
		});
		expect(await exists(f.mark)).toBe(false);
		await expectBuilt(f, b);
		// Opened again (the first answer was lost): the same, but for what only the mark knew.
		expect(await open(f, b, { tips, sessions })).toEqual({
			state: "open",
			mainSha: s.two.mainSha,
			keptThrough: 2,
			stranded: [late.workerId],
			previousMainSha: null,
		});
		expect(await open(f, b, { tips: [{ n: 7, mainAfter: three.mainSha }] })).toMatchObject({ keptThrough: null });

		// Nightly care finds a sound repository with main/ as it should be.
		expect(await checkCodeArea(f.job, { repository: kept }, { deep: true })).toMatchObject({
			state: "present",
			mainSha: s.two.mainSha,
			refsSha256: b.bundle.refsSha256,
			repaired: "none",
			worktrees: [],
			shallow: false,
		});
		expect(await fsckCodeArea(f.job, { repository: kept })).toMatchObject({ state: "ok" });
		// A session's follow-up gets its worktree back from its branch: what it committed, not what it had not.
		expect(
			await addCodeWorktree(f.job, { repository: kept, workerId: s.second.workerId, baseSha: s.two.mainSha }),
		).toMatchObject({ state: "added", headSha: s.work });
		expect((await readdir(s.second.tree)).sort()).toEqual([".git", "index.html", "src", "work.txt"]);
		expect(await readFile(join(f.aside, "worktrees", s.second.workerId, "notes.txt"), "utf8")).toBe(
			"not committed\n",
		);
		expect(await land(f, s.second, await s.second.commit({ "more.txt": "more\n" }, "more"))).toMatchObject({
			state: "fast-forward",
			mainBefore: s.two.mainSha,
		});
		// The session the restore stranded cannot start again, and a new one works.
		await expect(
			addCodeWorktree(f.job, { repository: kept, workerId: late.workerId, baseSha: three.mainSha }),
		).rejects.toMatchObject({ code: "CODE_HOST_BASE_UNKNOWN" });
		const fresh = await session(f, (await f.inRepo("rev-parse", "refs/heads/main")) as string);
		expect((await land(f, fresh, await fresh.commit({ "new.txt": "new\n" }, "new"))).state).toBe("fast-forward");
		// What the restore went back past is in the copy set aside.
		expect(await f.git(join(f.aside, "repo.git"), "--git-dir=.", "rev-parse", "refs/heads/main")).toBe(three.mainSha);
		expect(await readdir(f.scratchRoot)).toEqual([]);
	});

	it("build: a second try after a stop at each point builds the same repository, whatever the folder saved of the first", async () => {
		const points: [string, (f: Fixture) => (command: CodeHostCommand) => boolean][] = [
			["before repo.git is made", at.init],
			["before the first pack", at.pack],
			["before the refs", at.refs],
			["before main", at.main],
			// The last look, after main and main/ moved.
			[
				"before the answer",
				(f) =>
					nth(2, (command) => command.argv[2] === `--git-dir=${f.repo}` && command.argv.includes("for-each-ref")),
			],
		];
		for (const [point, stop] of points)
			for (const saved of ["everything", "refs only"] as const) {
				const f = await fixture(),
					s = await shop(f),
					b = await bundled(f);
				await emptied(f, b);
				await expect(build(f, b, stoppedAt(f, stop(f))), point).rejects.toThrow("the code host went away");
				// The place is still closed, with nothing in it a build did not make.
				expect(await exists(f.mark), point).toBe(true);
				if (saved === "refs only") {
					// A job that failed saved nothing but refs, at git's own commit, with the objects they need: no HEAD, no
					// config, no main/.
					for (const path of ["repo.git/HEAD", "repo.git/config", "repo.git/worktrees", "main"])
						await rm(join(f.code, path), { recursive: true, force: true });
				}
				expect(await build(f, b), `${point}, ${saved}`).toEqual({
					mainSha: s.two.mainSha,
					refsSha256: b.bundle.refsSha256,
					refs: b.refs.length,
				});
				await expectBuilt(f, b);
				expect((await open(f, b)).state).toBe("opened");
				expect(await readdir(f.scratchRoot)).toEqual([]);
			}
	}, 120_000);

	it("build and open: refuse a place that holds what no build made, and open nothing that is not the bundle's repository whole", async () => {
		const f = await fixture(),
			s = await shop(f),
			b = await bundled(f);
		await emptied(f, b);
		// Something beside the mark that a build never makes.
		await mkdir(join(f.code, "worktrees"));
		await expect(build(f, b)).rejects.toMatchObject({
			code: "CODE_HOST_RESTORE_PLACE_CHANGED",
			paths: [`${AREA}/worktrees`],
		});
		expect((await readdir(f.code)).sort()).toEqual(["restoring.json", "worktrees"]);
		await rm(join(f.code, "worktrees"), { recursive: true });
		await build(f, b);
		// A ref that is not the bundle's, or not where the bundle has it.
		await f.inRepo("update-ref", "refs/heads/extra", s.one.mainSha);
		await expect(build(f, b)).rejects.toMatchObject({
			code: "CODE_HOST_RESTORE_PLACE_CHANGED",
			paths: ["refs/heads/extra"],
		});
		await expect(open(f, b)).rejects.toMatchObject({ code: "CODE_HOST_RESTORE_NOT_BUILT" });
		await f.inRepo("update-ref", "-d", "refs/heads/extra");
		const branch = `refs/heads/qorpera/coding/${s.second.workerId}`;
		await f.inRepo("update-ref", branch, s.one.mainSha);
		await expect(build(f, b)).rejects.toMatchObject({ code: "CODE_HOST_RESTORE_PLACE_CHANGED", paths: [branch] });
		await expect(open(f, b)).rejects.toMatchObject({ code: "CODE_HOST_RESTORE_NOT_BUILT" });
		// A ref missing: not open, and the build makes it again.
		await f.inRepo("update-ref", "-d", branch);
		await expect(open(f, b)).rejects.toMatchObject({ code: "CODE_HOST_RESTORE_NOT_BUILT" });
		expect(await exists(f.mark)).toBe(true);
		await build(f, b);
		// main/ at another commit, or gone.
		await writeFile(join(f.repo, "worktrees/main/HEAD"), `${s.one.mainSha}\n`);
		await expect(open(f, b)).rejects.toMatchObject({ code: "CODE_HOST_RESTORE_NOT_BUILT" });
		await rm(join(f.code, "main"), { recursive: true });
		await expect(open(f, b)).rejects.toMatchObject({ code: "CODE_HOST_RESTORE_NOT_BUILT" });
		await build(f, b);
		await expectBuilt(f, b);
		// Another bundle's mark is none of this one's, and is not taken over once something is built.
		const other = {
			...b,
			bundle: { ...b.bundle, name: codeBundleName("2026-11-08T02:00:00.000Z", b.bundle.mainSha) },
		};
		await expect(open(f, other)).rejects.toMatchObject({
			code: "CODE_HOST_RESTORE_OTHER_BUNDLE",
			paths: [b.bundle.name],
		});
		await expect(close(f, other)).rejects.toMatchObject({
			code: "CODE_HOST_RESTORE_OTHER_BUNDLE",
			paths: [b.bundle.name],
		});
		expect(await readMark(f)).toMatchObject({ bundle: b.bundle.name });
		expect((await open(f, b)).state).toBe("opened");
		// With no mark and no repository of the bundle's, nothing is called open.
		const empty = await fixture();
		await expect(open(empty, b)).rejects.toMatchObject({ code: "CODE_HOST_RESTORE_NOT_BUILT" });
		await startCodeArea(empty.job, { repository: kept });
		await expect(open(empty, b)).rejects.toMatchObject({ code: "CODE_HOST_RESTORE_NOT_BUILT" });
		for (const bad of [
			() => open(f, b, { tips: [{ n: 0, mainAfter: s.one.mainSha }] }),
			() => open(f, b, { tips: [{ n: 1, mainAfter: "main" }] }),
			() => open(f, b, { sessions: [{ workerId: "session", baseSha: s.one.mainSha }] }),
		])
			await expect(bad()).rejects.toThrow("INVALID_CODE_HOST_JOB");
		expect(await readdir(f.scratchRoot)).toEqual([]);
	});

	it("an emptied place whose bundle is gone takes another bundle, while nothing is built in it", async () => {
		const f = await fixture(),
			s = await shop(f),
			first = await bundled(f, "2026-11-08T02:00:00.000Z");
		await land(f, s.second, s.work);
		const second = await bundled(f);
		await emptied(f, second);
		// The operator asks again with the older bundle: the mark keeps its time and where the content went.
		expect(await close(f, first)).toEqual({
			state: "present",
			at: AT,
			step: "emptied",
			setAside: ASIDE,
			previousMainSha: second.bundle.mainSha,
		});
		expect(await readMark(f)).toMatchObject({ bundle: first.bundle.name, step: "emptied", setAside: ASIDE });
		await expect(build(f, second)).rejects.toMatchObject({ code: "CODE_HOST_RESTORE_OTHER_BUNDLE" });
		await build(f, first);
		await expectBuilt(f, first);
		expect((await open(f, first)).state).toBe("opened");
	});

	it("reopen: a place that was closed and not touched is opened again as it was", async () => {
		const f = await fixture();
		await shop(f);
		const b = await bundled(f);
		const before = await f.listing(f.companyRoot);
		const reopen = (g: Fixture, bundle = b.bundle.name) => reopenCodeArea(g.job, { repository: kept, bundle });
		expect(await reopen(f)).toEqual({ state: "open" });
		await close(f, b);
		await expect(reopen(f, codeBundleName("2026-11-08T02:00:00.000Z", b.bundle.mainSha))).rejects.toMatchObject({
			code: "CODE_HOST_RESTORE_OTHER_BUNDLE",
		});
		expect(await reopen(f)).toEqual({ state: "reopened" });
		expect(await f.listing(f.companyRoot)).toEqual(before);
		expect((await checkCodeArea(f.job, { repository: kept })).state).toBe("present");
		// A set-aside folder with nothing in it (a move that never came) changes nothing.
		await close(f, b);
		await mkdir(f.aside, { recursive: true });
		expect(await reopen(f)).toEqual({ state: "reopened" });
		// Once a job saw the place emptied there is no way back but the build.
		await emptied(f, b);
		await expect(reopen(f)).rejects.toMatchObject({ code: "CODE_HOST_RESTORE_HALF_SET_ASIDE", paths: [ASIDE] });
		expect(await exists(f.mark)).toBe(true);
		// A place that was gone is gone again: the folder made for the mark goes with it.
		const gone = await fixture();
		await close(gone, b);
		expect(await reopen(gone)).toEqual({ state: "reopened" });
		expect(await exists(gone.code)).toBe(false);
		// An emptied place that held nothing stays closed too.
		await close(gone, b);
		await setAside(gone, b);
		await expect(reopen(gone)).rejects.toMatchObject({ code: "CODE_HOST_RESTORE_HALF_SET_ASIDE" });
		expect(await readdir(f.scratchRoot)).toEqual([]);
	});

	it("discard: removes one set-aside copy and the empty folders above it, and never the copy of a restore under way", async () => {
		const f = await fixture();
		await shop(f);
		const b = await bundled(f);
		const discard = (path: string) => discardSetAside(f.job, { repository: kept, path });
		expect(await discard(ASIDE)).toEqual({ removed: false });
		await emptied(f, b);
		// The restore that made it has not ended.
		await expect(discard(ASIDE)).rejects.toMatchObject({ code: "CODE_HOST_RESTORE_IN_PROGRESS", paths: [AREA] });
		await build(f, b);
		await open(f, b);
		// An older restore's copy, and another repository's, beside it.
		const older = join(f.companyRoot, "code/_set-aside/acme/at-20261101T000000Z/app"),
			site = join(f.companyRoot, "code/_set-aside/acme/at-20261110T161455Z/site");
		for (const dir of [older, site]) {
			await mkdir(dir, { recursive: true });
			await writeFile(join(dir, "kept.txt"), "kept\n");
		}
		const commands = f.log.length;
		for (const path of [
			"code/_set-aside",
			"code/_set-aside/acme",
			`code/_set-aside/acme/at-${AT}`,
			`${ASIDE}/repo.git`,
			`code/_set-aside/other/at-${AT}/app`,
			`code/_set-aside/acme/at-${AT}/site`,
			`code/_set-aside/acme/at-now/app`,
			`code/_set-aside/acme/at-${AT}/../../../acme/app`,
			AREA,
			`/${ASIDE}`,
		])
			await expect(discard(path)).rejects.toThrow("INVALID_CODE_HOST_JOB");
		expect(f.log).toHaveLength(commands);
		expect(await discard(ASIDE)).toEqual({ removed: true });
		expect(await exists(f.aside)).toBe(false);
		expect(await readFile(join(site, "kept.txt"), "utf8")).toBe("kept\n");
		expect(await readFile(join(older, "kept.txt"), "utf8")).toBe("kept\n");
		expect(await discard(ASIDE)).toEqual({ removed: false });
		// The last copy takes the folders above it along.
		await rm(site, { recursive: true });
		expect(await discard("code/_set-aside/acme/at-20261101T000000Z/app")).toEqual({ removed: true });
		expect(await exists(join(f.companyRoot, "code/_set-aside/acme/at-20261110T161455Z"))).toBe(true);
		await rm(join(f.companyRoot, "code/_set-aside/acme/at-20261110T161455Z"), { recursive: true });
		await mkdir(older, { recursive: true });
		expect(await discard("code/_set-aside/acme/at-20261101T000000Z/app")).toEqual({ removed: true });
		expect(await exists(join(f.companyRoot, "code/_set-aside"))).toBe(false);
		// A link is never followed.
		await mkdir(join(f.companyRoot, "code/_set-aside/acme"), { recursive: true });
		await symlink(f.code, join(f.companyRoot, "code/_set-aside/acme/at-20261101T000000Z"));
		await expect(discard("code/_set-aside/acme/at-20261101T000000Z/app")).rejects.toMatchObject({
			code: "CODE_HOST_LINK",
		});
		expect((await checkCodeArea(f.job, { repository: kept })).state).toBe("present");
		expect(await readdir(f.scratchRoot)).toEqual([]);
	});
});

describe("CodeRestore: a restore request, step by step", () => {
	const NOW = Date.UTC(2026, 10, 10, 16, 14, 55);
	const gc: CodeHostGcBlock = { begin: async () => ({ state: "blocking", held: 0 }), end: async () => {} };
	/** The executor's side with the code host's own jobs on a local disk, the real store, and a kernel that records. */
	function executor(f: Fixture) {
		const store = createCodeBundleStore({ root: join(f.controlRoot, CODE_BUNDLE_FOLDER) });
		const kernel = {
			/** What each step call saved, in order. */
			steps: [] as Record<string, unknown>[],
			answer: (_progress: Record<string, unknown>): "go" | "busy" | "lost" => "go",
		};
		const jobs = {
			/** Whether each job yields, in order. */
			yields: [] as boolean[],
			/** The code host each job gets. */
			host: (): CodeHostJob => f.job,
			after: async (_answer: unknown): Promise<void> => undefined,
		};
		const control = {
			async call(method: string, args: Record<string, unknown>): Promise<unknown> {
				expect(method).toBe("qorpera_code_request_step");
				expect(args).toMatchObject({ p_owner: "coding-node-1", p_machine_id_sha256: "d".repeat(64) });
				const progress = structuredClone(args.p_progress) as Record<string, unknown>,
					state = kernel.answer(progress);
				// The kernel saves only when it lets the job go on.
				if (state === "go") kernel.steps.push(progress);
				return {
					schema: "qorpera.code-request-step/v1",
					state,
					...(state === "go" ? { leaseUntil: "2026-11-10T18:14:55Z" } : {}),
				};
			},
		};
		const hosts: Pick<CodeHostJobs, "run"> = {
			run: async (companyId, environmentId, signal, job, options) => {
				expect([companyId, environmentId]).toEqual([COMPANY, ENVIRONMENT]);
				jobs.yields.push(options?.yields === true);
				const answer = await job({ ...jobs.host(), signal }, gc);
				await jobs.after(answer);
				return answer;
			},
		};
		const events: Record<string, unknown>[] = [];
		const restore = new CodeRestore({
			control,
			hosts,
			bundles: store,
			check: checkCodeArea,
			bundle: bundleCodeArea,
			owner: "coding-node-1",
			machineIdSha256: "d".repeat(64),
			report: (event) => events.push(event),
			now: () => NOW,
		});
		/** A bundle put in the store as nightly care puts it. */
		const keep = async (b: Bundled) => {
			const writer = await store.begin(
				{ companyId: COMPANY, owner: "acme", name: "app" },
				{ expectedBytes: b.bytes.length },
			);
			await writer.write(b.bytes);
			await writer.commit(b.bundle.name, {
				environmentId: ENVIRONMENT,
				createdAt: b.createdAt,
				gitVersion: b.gitVersion,
				mainSha: b.bundle.mainSha,
				refsSha256: b.bundle.refsSha256,
				refs: b.refs,
				sha256: b.bundle.sha256,
				bytes: b.bundle.bytes,
				executorOwner: "coding-node-1",
			});
			return b.bundle.name;
		};
		const errors = () =>
			events.filter((event) => event.event === "code-restore-error").map((event) => String(event.error));
		const run = (request: CodeRestoreRequest) => restore.run(request, new AbortController().signal);
		return {
			store,
			kernel,
			jobs,
			restore,
			events,
			errors,
			keep,
			run,
			folder: join(f.controlRoot, CODE_BUNDLE_FOLDER, COMPANY, "acme", "app"),
		};
	}
	const request = (more: Partial<CodeRestoreRequest> = {}): CodeRestoreRequest => ({
		requestId: randomUUID(),
		token: randomUUID(),
		companyId: COMPANY,
		environmentId: ENVIRONMENT,
		owner: "acme",
		name: "app",
		kind: "restore",
		mode: "restore",
		bundle: "fresh",
		damaged: "keep",
		progress: null,
		path: null,
		tips: [],
		sessions: [],
		...more,
	});
	const SCHEMA = "qorpera.code-request-outcome/v1";

	it("fresh: bundles the place as it stands, sets it aside and builds it again, with no change lost and every step saved", async () => {
		const f = await fixture(),
			s = await shop(f),
			x = executor(f);
		const refs = await refsOf(f),
			tips = [
				{ n: 2, mainAfter: s.two.mainSha },
				{ n: 1, mainAfter: s.one.mainSha },
			],
			sessions = [
				{ workerId: s.first.workerId, baseSha: s.baseSha },
				{ workerId: s.second.workerId, baseSha: s.two.mainSha },
			];
		const name = codeBundleName(new Date(NOW).toISOString(), s.two.mainSha);
		const outcome = await x.run(request({ tips, sessions }));
		expect(x.errors()).toEqual([]);
		expect(outcome).toEqual({
			schema: SCHEMA,
			state: "done",
			result: "restored",
			bundle: name,
			mainSha: s.two.mainSha,
			previousMainSha: s.two.mainSha,
			refsSha256: codeRefsSha256(refs),
			refs: refs.length,
			keptThrough: 2,
			stranded: [],
			movedTo: ASIDE,
		});
		// What the kernel saved before each job: the operator reads how far a restore got from it.
		expect(x.kernel.steps).toEqual([
			{ step: "fresh" },
			{ step: "fresh" },
			{ step: "close", bundle: name },
			{ step: "set-aside", bundle: name, at: AT },
			{ step: "set-aside", bundle: name, at: AT },
			{ step: "build", bundle: name, at: AT, setAside: ASIDE },
			{ step: "open", bundle: name, at: AT, setAside: ASIDE, built: true },
		]);
		// The jobs before the place moves yield to a turn's; from the set-aside to the open they keep their place.
		expect(x.jobs.yields).toEqual([true, true, true, false, false, false, false]);
		expect(CODE_RESTORE_RPCS).toEqual(["qorpera_code_request_step"]);
		// The new bundle is in the store like a nightly one, and is the repository's.
		expect((await readdir(x.folder)).sort()).toEqual([`${name}.bundle`, `${name}.json`]);
		expect(await x.store.verify({ companyId: COMPANY, owner: "acme", name: "app" }, name)).toMatchObject({
			mainSha: s.two.mainSha,
			refsSha256: codeRefsSha256(refs),
			refsCount: refs.length,
			verified: true,
		});
		expect(await exists(f.mark)).toBe(false);
		expect(await refsOf(f)).toEqual(refs);
		expect(await refsOf(f, join(f.aside, "repo.git"))).toEqual(refs);
		expect((await checkCodeArea(f.job, { repository: kept })).state).toBe("present");
		expect(
			await addCodeWorktree(f.job, { repository: kept, workerId: s.second.workerId, baseSha: s.two.mainSha }),
		).toMatchObject({ state: "added", headSha: s.work });
		expect(x.events.filter((event) => event.event === "code-restore").map((event) => event.step)).toEqual([
			"fresh",
			"closed",
			"set-aside",
			"built",
			"opened",
			"ended",
		]);
		expect(await readdir(f.scratchRoot)).toEqual([]);
	});

	it("a stored bundle: verify proves it and writes nothing; restore goes back to it, says what was lost and who is stranded, and removes the old place when asked", async () => {
		const f = await fixture(),
			s = await shop(f),
			x = executor(f);
		const name = await x.keep(await bundled(f));
		const refs = await refsOf(f);
		// Work after the bundle.
		const three = await land(f, s.first, await s.first.commit({ "later.txt": "later\n" }, "later"));
		const late = await session(f, three.mainSha);
		const before = await f.listing(f.companyRoot);
		expect(await x.run(request({ mode: "verify", bundle: name, damaged: null }))).toEqual({
			schema: SCHEMA,
			state: "done",
			result: "verified",
			mainSha: s.two.mainSha,
			refsSha256: codeRefsSha256(refs),
			refs: refs.length,
		});
		expect(x.kernel.steps).toEqual([{ step: "verify", bundle: name }]);
		expect(await f.listing(f.companyRoot)).toEqual(before);

		x.kernel.steps.length = 0;
		const outcome = await x.run(
			request({
				bundle: name,
				damaged: "remove",
				tips: [
					{ n: 3, mainAfter: three.mainSha },
					{ n: 2, mainAfter: s.two.mainSha },
					{ n: 1, mainAfter: s.one.mainSha },
				],
				sessions: [
					{ workerId: s.second.workerId, baseSha: s.two.mainSha },
					{ workerId: late.workerId, baseSha: three.mainSha },
				],
			}),
		);
		expect(x.errors()).toEqual([]);
		expect(outcome).toEqual({
			schema: SCHEMA,
			state: "done",
			result: "restored",
			bundle: name,
			mainSha: s.two.mainSha,
			previousMainSha: three.mainSha,
			refsSha256: codeRefsSha256(refs),
			refs: refs.length,
			keptThrough: 2,
			stranded: [late.workerId],
			// Removed, as asked: after the place was open again.
			movedTo: null,
		});
		expect(x.kernel.steps.map((step) => step.step)).toEqual([
			"close",
			"set-aside",
			"set-aside",
			"build",
			"open",
			"discard",
		]);
		expect(await exists(join(f.companyRoot, "code/_set-aside"))).toBe(false);
		expect(await f.inRepo("rev-parse", "refs/heads/main")).toBe(s.two.mainSha);
		expect(await exists(join(f.code, "main/later.txt"))).toBe(false);
		expect(await refsOf(f)).toEqual(refs);

		// A bundle that is not in the store closes nothing.
		const missing = codeBundleName("2026-11-01T00:00:00.000Z", s.two.mainSha);
		expect(await x.run(request({ bundle: missing }))).toEqual({
			schema: SCHEMA,
			state: "failed",
			code: "CLOSE_FAILED:CODE_BUNDLE_MISSING",
		});
		expect(await x.run(request({ mode: "verify", bundle: missing }))).toEqual({
			schema: SCHEMA,
			state: "failed",
			code: "VERIFY_FAILED:CODE_BUNDLE_MISSING",
		});
		expect(await exists(f.mark)).toBe(false);
		// Requests that name nothing this executor can do.
		for (const bad of [
			request({ mode: "verify", bundle: "fresh" }),
			request({ bundle: "latest" }),
			request({ damaged: null }),
			request({ mode: "discard", path: null }),
			request({ owner: "Acme" }),
			request({ requestId: "request" }),
			request({ mode: "repair" as never }),
		])
			expect(await x.run(bad)).toEqual({ schema: SCHEMA, state: "failed", code: "RESTORE_REQUEST_INVALID" });
		expect(await x.run(request({ mode: "discard", bundle: null, path: `${AREA}/main` }))).toEqual({
			schema: SCHEMA,
			state: "failed",
			code: "DISCARD_FAILED:INVALID_CODE_HOST_JOB",
		});
	});

	it("a damaged repository: fresh fails and leaves the place as it is; the stored bundle restores it, with the damage kept aside; discard removes that later", async () => {
		const f = await fixture(),
			s = await shop(f),
			x = executor(f);
		const name = await x.keep(await bundled(f));
		// A file version main needs is gone from the repository.
		const blob = await f.inRepo("rev-parse", `${s.two.mainSha}:index.html`);
		await rm(join(f.repo, "objects", blob.slice(0, 2), blob.slice(2)));
		const before = await f.listing(f.companyRoot);
		const failed = await x.run(request());
		expect(failed).toEqual({ schema: SCHEMA, state: "failed", code: "FRESH_BUNDLE_FAILED:CODE_HOST_BUNDLE_FAILED" });
		expect(await f.listing(f.companyRoot)).toEqual(before);
		expect((await readdir(x.folder)).sort()).toEqual([`${name}.bundle`, `${name}.json`]);

		const outcome = await x.run(request({ bundle: name }));
		expect(outcome).toMatchObject({
			state: "done",
			result: "restored",
			bundle: name,
			movedTo: ASIDE,
			keptThrough: null,
		});
		expect(await f.inRepo("fsck", "--full", "--no-dangling", "--no-progress")).toBe("");
		expect(await readFile(join(f.code, "main/index.html"), "utf8")).toBe("<p>shop</p>\n");
		// The damaged place is whole in its damage, for hand work.
		expect(await exists(join(f.aside, "repo.git/objects", blob.slice(0, 2), blob.slice(2)))).toBe(false);
		expect(await readFile(join(f.aside, "worktrees", s.second.workerId, "notes.txt"), "utf8")).toBe(
			"not committed\n",
		);

		x.kernel.steps.length = 0;
		expect(await x.run(request({ mode: "discard", bundle: null, damaged: "keep", path: ASIDE }))).toEqual({
			schema: SCHEMA,
			state: "done",
			result: "discarded",
		});
		expect(x.kernel.steps).toEqual([{ step: "discard" }]);
		expect(await exists(join(f.companyRoot, "code/_set-aside"))).toBe(false);
		// Asked again, it is still done.
		expect(await x.run(request({ mode: "discard", bundle: null, path: ASIDE }))).toMatchObject({
			result: "discarded",
		});
		// With no place at all, a fresh bundle is impossible, and a stored one still restores.
		await rm(f.code, { recursive: true });
		expect(await x.run(request())).toEqual({
			schema: SCHEMA,
			state: "failed",
			code: "FRESH_BUNDLE_FAILED:AREA_ABSENT",
		});
		expect(await x.run(request({ bundle: name }))).toMatchObject({
			result: "restored",
			movedTo: null,
			previousMainSha: null,
			mainSha: s.two.mainSha,
		});
		expect(await readFile(join(f.code, "main/index.html"), "utf8")).toBe("<p>shop</p>\n");
	});

	it("a request claimed again goes on from what the kernel saved and the place holds, after a stop at each step", async () => {
		const f = await fixture(),
			s = await shop(f),
			x = executor(f);
		const b = await bundled(f),
			name = await x.keep(b);
		const again = (progress: Record<string, unknown> | null, more: Partial<CodeRestoreRequest> = {}) =>
			x.run(request({ bundle: name, progress, ...more }));
		const restored = { state: "done", result: "restored", bundle: name, mainSha: s.two.mainSha, movedTo: ASIDE };

		// The code host goes away while the bundle is proven for the close: nothing was written.
		x.jobs.host = () => stoppedAt(f, (command) => command.argv.includes("fsck"));
		expect(await again(null)).toEqual({
			schema: SCHEMA,
			state: "failed",
			code: "CLOSE_FAILED:UNCLASSIFIED:PLACE_AS_BEFORE",
		});
		expect(await exists(f.mark)).toBe(false);
		// While the old place is moved: it stays closed, and the next claim moves the rest.
		for (let n = 0; n < 30; n += 1)
			await writeFile(join(f.code, `stray-${String(n).padStart(2, "0")}.txt`), `${n}\n`);
		const held = await f.listing(f.code);
		x.jobs.host = () => stoppedAt(f, nth(2, at.move()));
		expect(await again(null)).toEqual({
			schema: SCHEMA,
			state: "failed",
			code: "SET_ASIDE_FAILED:UNCLASSIFIED:PLACE_CLOSED",
		});
		expect(await readMark(f)).toMatchObject({ step: "closed", bundle: name });
		const saved = x.kernel.steps.at(-1) as Record<string, unknown>;
		expect(saved).toEqual({ step: "set-aside", bundle: name, at: AT });
		// While the repository is built: closed, and the kernel knows the old place is aside.
		x.jobs.host = () => stoppedAt(f, at.refs(f));
		expect(await again(saved)).toEqual({
			schema: SCHEMA,
			state: "failed",
			code: "BUILD_FAILED:UNCLASSIFIED:PLACE_CLOSED",
		});
		expect(await f.listing(f.aside)).toEqual(held);
		const building = x.kernel.steps.at(-1) as Record<string, unknown>;
		expect(building).toEqual({ step: "build", bundle: name, at: AT, setAside: ASIDE });
		expect(await exists(f.mark)).toBe(true);
		// The next claim builds and opens: it neither closes nor moves again.
		x.jobs.host = () => f.job;
		x.kernel.steps.length = 0;
		expect(await again(building, { requestId: randomUUID() })).toMatchObject(restored);
		expect(x.kernel.steps.map((step) => step.step)).toEqual(["build", "open"]);
		expect(await exists(f.mark)).toBe(false);
		await expectBuilt(f, b);
		// The answer of the open was lost: the same request, with what the kernel saved, ends the same way.
		const opened = x.kernel.steps.at(-1) as Record<string, unknown>;
		expect(opened).toEqual({ step: "open", bundle: name, at: AT, setAside: ASIDE, built: true });
		x.kernel.steps.length = 0;
		expect(await again(opened, { tips: [{ n: 2, mainAfter: s.two.mainSha }] })).toMatchObject({
			...restored,
			keptThrough: 2,
			previousMainSha: null,
		});
		expect(x.kernel.steps.map((step) => step.step)).toEqual(["open"]);
		await expectBuilt(f, b);
	});

	it("a restore the kernel puts off, or whose lease is gone, leaves an untouched place open and an emptied one closed", async () => {
		const f = await fixture(),
			s = await shop(f),
			x = executor(f);
		const name = await x.keep(await bundled(f));
		const before = await f.listing(f.companyRoot);
		// A turn began before the old place was moved: the place is opened again, as it was, by a job that does not yield.
		x.kernel.answer = (progress) => (progress.step === "set-aside" ? "busy" : "go");
		expect(await x.run(request({ bundle: name }))).toEqual({ schema: SCHEMA, state: "busy" });
		expect(x.jobs.yields).toEqual([true, false, false]);
		expect(await f.listing(f.companyRoot)).toEqual(before);
		expect(x.kernel.steps).toEqual([{ step: "close", bundle: name }]);
		expect(x.events.find((event) => event.step === "put-off")).toMatchObject({
			at: "set-aside",
			place: "PLACE_AS_BEFORE",
		});
		// A lease another claim took: the place is that claim's to go on from, and stays as it is.
		x.kernel.answer = (progress) => (progress.step === "set-aside" ? "lost" : "go");
		const jobsBefore = x.jobs.yields.length;
		expect(await x.run(request({ bundle: name }))).toEqual({
			schema: SCHEMA,
			state: "failed",
			code: "RESTORE_LEASE_LOST:PLACE_CLOSED",
		});
		expect(x.jobs.yields.slice(jobsBefore)).toEqual([true, false]);
		expect(await readMark(f)).toMatchObject({ step: "closed", bundle: name });
		// A folder that does not keep the move: the job after it still finds the old place there. (The request goes on
		// from the mark the last one left.)
		x.kernel.answer = () => "go";
		x.jobs.after = async (answer) => {
			if ((answer as { state?: string })?.state !== "moved") return;
			for (const entry of await readdir(f.aside)) await rename(join(f.aside, entry), join(f.code, entry));
		};
		expect(await x.run(request({ bundle: name }))).toEqual({
			schema: SCHEMA,
			state: "failed",
			code: "SET_ASIDE_FAILED:RESTORE_SET_ASIDE_NOT_KEPT:PLACE_AS_BEFORE",
		});
		expect([...x.events].reverse().find((event) => event.step === "ended")).toMatchObject({
			words: expect.stringContaining("did not keep the move"),
		});
		await rm(join(f.companyRoot, "code/_set-aside"), { recursive: true });
		expect(await f.listing(f.companyRoot)).toEqual(before);
		x.jobs.after = async () => undefined;
		// Put off once the place is emptied: it stays closed, and the next claim goes on.
		x.kernel.steps.length = 0;
		x.kernel.answer = (progress) => (progress.step === "build" ? "busy" : "go");
		expect(await x.run(request({ bundle: name }))).toEqual({ schema: SCHEMA, state: "busy" });
		expect(await readdir(f.code)).toEqual(["restoring.json"]);
		expect([...x.events].reverse().find((event) => event.step === "put-off")).toMatchObject({
			at: "build",
			place: "PLACE_CLOSED",
		});
		// The kernel saved nothing of a step it put off: the claim comes with the set-aside step's word, and the place
		// itself says it was seen emptied.
		const saved = x.kernel.steps.at(-1) as Record<string, unknown>;
		expect(saved).toEqual({ step: "set-aside", bundle: name, at: AT });
		x.kernel.answer = () => "go";
		// An executor that is stopping ends the request as busy: no command runs for it.
		const stopping = new AbortController();
		stopping.abort(new Error("the executor is stopping"));
		const jobs = x.jobs.yields.length;
		expect(await x.restore.run(request({ bundle: name, progress: saved }), stopping.signal)).toEqual({
			schema: SCHEMA,
			state: "busy",
		});
		expect(x.jobs.yields).toHaveLength(jobs + 1);
		expect(await readdir(f.code)).toEqual(["restoring.json"]);
		expect(await x.run(request({ bundle: name, progress: saved }))).toMatchObject({
			state: "done",
			result: "restored",
			mainSha: s.two.mainSha,
			movedTo: ASIDE,
		});
		expect(await exists(f.mark)).toBe(false);
		// A kernel that answers something else is no go.
		const y = executor(f);
		const control = {
			call: async () => ({ schema: "qorpera.code-request-step/v1", state: "maybe" }),
		};
		const unsure = new CodeRestore({
			control,
			hosts: { run: async (_c, _e, signal, job) => job({ ...f.job, signal }, gc) },
			bundles: y.store,
			check: checkCodeArea,
			bundle: bundleCodeArea,
			owner: "coding-node-1",
			machineIdSha256: "d".repeat(64),
		});
		expect(await unsure.run(request({ mode: "verify", bundle: name }), new AbortController().signal)).toEqual({
			schema: SCHEMA,
			state: "failed",
			code: "VERIFY_FAILED:CODE_RESTORE_STEP_UNCONFIRMED",
		});
		for (const bad of [{ owner: "" }, { machineIdSha256: "d" }, { fsckMs: 0 }, { bundleMaximumBytes: 0 }])
			expect(
				() =>
					new CodeRestore({
						control,
						hosts: y.restore as never,
						bundles: y.store,
						check: checkCodeArea,
						bundle: bundleCodeArea,
						owner: "coding-node-1",
						machineIdSha256: "d".repeat(64),
						...bad,
					}),
			).toThrow("INVALID_CODE_RESTORE");
	});
});
