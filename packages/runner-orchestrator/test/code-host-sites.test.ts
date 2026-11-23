import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
	CODE_AREA_IN_QORPERA_REF,
	type CodeHostCommand,
	type CodeHostJob,
	startCodeArea,
} from "../src/code-host-jobs.ts";
import { CodeSiteTreeInvalid, readCodeSiteTree } from "../src/code-host-sites.ts";
import { localShell } from "./helpers/code-host-shell.ts";

const exec = promisify(execFile),
	roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const GIT = "/usr/bin/git";
const MiB = 1024 ** 2;
const kept = { host: "qorpera" as const, owner: "qorpera", name: "example", baseBranch: "main" };
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
/** site-tools' manifest (manifestOf), computed here on its own. */
const manifestOf = (files: readonly { path: string; sha256: string; bytes: number }[]) =>
	digest(
		[...files]
			.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
			.map((file) => `${file.path}\t${file.sha256}\t${file.bytes}`)
			.join("\n"),
	);

interface Site {
	/** Files by path: text, bytes, or a link (`{ link: target }`). */
	files: Record<string, string | Uint8Array | { link: string }>;
	executable?: readonly string[];
	/** Submodules by path, at a commit (no object is needed for it). */
	submodules?: Record<string, string>;
}

/** A company's code host with a repository kept in Qorpera, started (or not). */
async function place(options: { start?: boolean } = {}) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "code-host-sites-")));
	roots.push(root);
	const companyRoot = join(root, "folder"),
		scratchRoot = join(root, "scratch");
	await mkdir(companyRoot);
	await mkdir(scratchRoot);
	const log: CodeHostCommand[] = [];
	const job: CodeHostJob = {
		shell: localShell(log),
		layout: { companyRoot, scratchRoot, git: GIT },
		signal: new AbortController().signal,
	};
	const repo = join(companyRoot, "code/qorpera/example/repo.git");
	const env = { PATH: "/usr/bin:/bin", HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
	const git = async (cwd: string, args: readonly string[], more: Record<string, string> = {}) =>
		(await exec(GIT, args, { cwd, env: { ...env, ...more }, maxBuffer: 64 * MiB })).stdout.trim();
	/** git on repo.git, as the test's own hand. */
	const repoGit = (...args: string[]) => git(root, [`--git-dir=${repo}`, ...args]);
	/** A shell script with git and repo.git as $1 and $2, its stdin closed. */
	const sh = async (script: string, ...args: string[]) =>
		(
			await exec("/bin/sh", ["-c", `{ ${script}; } </dev/null`, "sh", GIT, repo, ...args], { cwd: root, env })
		).stdout.trim();
	if (options.start !== false) await startCodeArea(job, { repository: kept });
	/** A site's files as the collect keeps them: written into repo.git's objects from a scratch git directory of its
	 * own, one tree of them, and no ref that names it. */
	const site = async ({ files, executable = [], submodules = {} }: Site): Promise<string> => {
		const dir = await mkdtemp(join(root, "site-")),
			objects = { GIT_OBJECT_DIRECTORY: join(repo, "objects") };
		await git(dir, ["init", "--quiet", "--template="]);
		for (const [path, content] of Object.entries(files)) {
			await mkdir(dirname(join(dir, path)), { recursive: true });
			if (typeof content === "object" && "link" in content) await symlink(content.link, join(dir, path));
			else await writeFile(join(dir, path), content);
		}
		for (const path of executable) await chmod(join(dir, path), 0o755);
		await git(dir, ["add", "--all"], objects);
		for (const [path, commit] of Object.entries(submodules))
			await git(dir, ["update-index", "--add", "--cacheinfo", `160000,${commit},${path}`], objects);
		const tree = await git(dir, ["write-tree"], objects);
		await rm(dir, { recursive: true, force: true });
		return tree;
	};
	/** An object's bytes as git keeps them (a tree's raw entries), without its header. */
	const raw = async (kind: "tree" | "blob", id: string) =>
		(await exec(GIT, [`--git-dir=${repo}`, "cat-file", kind, id], { cwd: root, env, encoding: "buffer" })).stdout;
	/** What a session can do: a loose object under `id`'s name that holds other bytes (a tree's or a file's). */
	const plant = async (id: string, kind: "tree" | "blob", bytes: Buffer) => {
		const loose = join(repo, "objects", id.slice(0, 2), id.slice(2));
		await chmod(loose, 0o644);
		await writeFile(loose, deflateSync(Buffer.concat([Buffer.from(`${kind} ${bytes.length}\0`, "latin1"), bytes])));
	};
	/** The kinds of the objects the commands since `start` asked for whole (`cat-file --batch`): a tree walked is one,
	 * and a file version read is one. */
	const askedWhole = async (start: number) => {
		const ids = log
			.slice(start)
			.filter((command) => command.argv.at(-1) === "--batch")
			.flatMap((command) =>
				Buffer.from(command.stdin as Uint8Array)
					.toString("latin1")
					.split("\n")
					.filter(Boolean),
			);
		if (!ids.length) return [];
		const kinds = await sh(
			'g=$1 r=$2; shift 2; printf "%s\\n" "$@" | "$g" --git-dir="$r" cat-file --batch-check="%(objecttype)"',
			...ids,
		);
		return kinds.split("\n");
	};
	return { root, job, log, repo, repoGit, sh, site, raw, plant, askedWhole };
}

describe("code host: a repository's site tree (own code storage, step 4, part B)", () => {
	it("reads a tree that no ref reaches, whole, in C order with each file's SHA-256 and the manifest", async () => {
		const p = await place();
		const png = Buffer.concat([
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
			randomBytes(300),
		]);
		const files: Record<string, string | Uint8Array> = {
			"index.html": "<p>shop</p>\n",
			"index-old.html": "<p>old</p>\n",
			"css/site.css": "p{color:red}\n",
			"img/logo.png": png,
			"js/app.js": "export const cart = [];\n",
			// The same bytes at another path: one file version, read once.
			"js/copy.js": "export const cart = [];\n",
			"js.map": "{}\n",
			"Assets/Logo.SVG": "<svg/>\n",
			"robots.txt": "",
		};
		const tree = await p.site({ files, executable: ["js/app.js"] });
		// No ref reaches the tree: the default branch and the mark hold no file.
		expect(await p.repoGit("rev-list", "--objects", "--all")).not.toContain(tree);
		const start = p.log.length;
		const read = await readCodeSiteTree(p.job, { repository: kept, tree });
		const paths = Object.keys(files).sort((a, b) => (a < b ? -1 : 1));
		expect(read.files.map((file) => file.path)).toEqual(paths);
		expect(paths).toEqual([
			"Assets/Logo.SVG",
			"css/site.css",
			"img/logo.png",
			"index-old.html",
			"index.html",
			"js.map",
			"js/app.js",
			"js/copy.js",
			"robots.txt",
		]);
		for (const file of read.files) {
			const bytes = Buffer.from(files[file.path] as string | Uint8Array);
			expect(file.content).toBeInstanceOf(Uint8Array);
			expect(Buffer.from(file.content).equals(bytes)).toBe(true);
			expect(file).toMatchObject({ bytes: bytes.length, sha256: digest(bytes) });
		}
		expect(read.manifestSha256).toBe(manifestOf(read.files));
		expect(await p.askedWhole(start)).toEqual([...Array(5).fill("tree"), ...Array(8).fill("blob")]);
		expect(await readdir(join(p.root, "scratch"))).toEqual([]);

		// Packed, as nightly care leaves what no ref reaches (a cruft pack of its own): read the same.
		await p.repoGit("repack", "-a", "-d", "--cruft", "--quiet");
		expect(await p.repoGit("count-objects", "-v")).toMatch(/^count: 0$/m);
		const again = await readCodeSiteTree(p.job, { repository: kept, tree });
		expect(again.manifestSha256).toBe(read.manifestSha256);
		expect(again.files.map((file) => [file.path, file.sha256])).toEqual(
			read.files.map((file) => [file.path, file.sha256]),
		);
	});

	it("computes the manifest as site-tools does: a fixed vector", async () => {
		const p = await place();
		const tree = await p.site({ files: { "index.html": "<p>shop</p>\n", "css/site.css": "p{color:red}\n" } });
		const read = await readCodeSiteTree(p.job, { repository: kept, tree });
		expect(read.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }))).toEqual([
			{
				path: "css/site.css",
				bytes: 13,
				sha256: "2118a27d8b4caade606bdc7072221202b58c9fba0ece2e2895a5152f9a1c0d99",
			},
			{ path: "index.html", bytes: 12, sha256: "a910ab35913ffde2598d704c3701f890048261d4d60c43d2ba9ab9dc87623a08" },
		]);
		expect(read.manifestSha256).toBe("21bcfaac8a651b8d12f06a40d56b0ab883dff1cec6c440a1d774ea178a8e5d7e");
	});

	it("refuses a tree the repository does not have, and a place that is no repository kept in Qorpera", async () => {
		const p = await place();
		const tree = await p.site({ files: { "index.html": "<p>shop</p>\n" } });
		const unknown = (id: string) =>
			expect(readCodeSiteTree(p.job, { repository: kept, tree: id })).rejects.toMatchObject({
				code: "CODE_HOST_SITE_TREE_UNKNOWN",
				paths: [id],
			});
		// Nothing of that id; a file version; a commit (whose tree ls-tree would list).
		await unknown("0123456789abcdef0123456789abcdef01234567");
		await unknown((await p.repoGit("ls-tree", tree)).split(/\s+/)[2] as string);
		await unknown(await p.repoGit("rev-parse", "refs/heads/main"));
		// No job for a tree that is not an id, a GitHub repository, or another key.
		const commands = p.log.length;
		for (const value of [
			{ repository: kept, tree: "main" },
			{ repository: kept, tree: tree.toUpperCase() },
			{ repository: { ...kept, host: "github.com" }, tree },
			{ repository: kept, tree, folder: "dist" },
		])
			await expect(readCodeSiteTree(p.job, value as Parameters<typeof readCodeSiteTree>[1])).rejects.toThrow(
				"INVALID_CODE_HOST_JOB",
			);
		expect(p.log).toHaveLength(commands);
		// The step 2b jobs' place: a GitHub copy (no mark), and a repository never started.
		await p.repoGit("update-ref", "-d", CODE_AREA_IN_QORPERA_REF);
		await expect(readCodeSiteTree(p.job, { repository: kept, tree })).rejects.toMatchObject({
			code: "CODE_HOST_AREA_FROM_GITHUB",
		});
		const empty = await place({ start: false });
		await expect(readCodeSiteTree(empty.job, { repository: kept, tree })).rejects.toMatchObject({
			code: "CODE_HOST_NOT_SEEDED",
		});
	});

	it("fails a tree whose files are not all there, or whose bytes are not their file version's", async () => {
		const p = await place();
		// A tree that names a file version the repository lacks.
		const lacking = await p.sh(
			'printf "100644 blob %s\\tindex.html\\n" "$3" | "$1" --git-dir="$2" mktree --missing',
			"89abcdef0123456789abcdef0123456789abcdef",
		);
		await expect(readCodeSiteTree(p.job, { repository: kept, tree: lacking })).rejects.toMatchObject({
			name: "CodeHostJobFailure",
			code: "CODE_HOST_SITE_READ_FAILED",
			detail: "index.html: its file version is not here",
		});
		// A tree that names a folder the repository lacks.
		const noFolder = await p.sh(
			'printf "040000 tree %s\\tsite\\n" "$3" | "$1" --git-dir="$2" mktree --missing',
			"89abcdef0123456789abcdef0123456789abcdef",
		);
		await expect(readCodeSiteTree(p.job, { repository: kept, tree: noFolder })).rejects.toMatchObject({
			name: "CodeHostJobFailure",
			code: "CODE_HOST_SITE_READ_FAILED",
			detail: "site: its folder is not here",
		});
		// A loose object written under a file version's name with other bytes of the same size, as a session could.
		const tree = await p.site({ files: { "index.html": "<p>shop</p>\n", "app.js": "const a = 1;\n" } });
		const blob = await p.repoGit("rev-parse", `${tree}:app.js`);
		await p.plant(blob, "blob", Buffer.from("const a = 2;\n"));
		await expect(readCodeSiteTree(p.job, { repository: kept, tree })).rejects.toMatchObject({
			name: "CodeHostJobFailure",
			code: "CODE_HOST_SITE_READ_FAILED",
			detail: `${blob}: its bytes are not the file version's`,
		});
	});

	it("fails a tree whose own bytes, or a folder's, are not their id's: planted loose, or packed by care", async () => {
		const p = await place();
		// Another site of the same count and sizes, its objects all honest: what a session would rather put live.
		const files = { "index.html": "<p>shop</p>\n", "css/site.css": "p{color:red}\n" },
			other = { "index.html": "<p>evil</p>\n", "css/site.css": "p{color:tan}\n" };
		/** The other site's top folder, or its css folder, planted under the id of this site's. */
		const planted = async (where: "top" | "css", these: Record<string, string> = files) => {
			const tree = await p.site({ files: these }),
				evil = await p.site({ files: other }),
				[id, from] =
					where === "top"
						? [tree, evil]
						: [await p.repoGit("rev-parse", `${tree}:css`), await p.repoGit("rev-parse", `${evil}:css`)];
			await p.plant(id, "tree", await p.raw("tree", from));
			// cat-file answers the other folder's bytes under this one's id; git's own walk below the top takes them too.
			expect(await p.raw("tree", id)).toEqual(await p.raw("tree", from));
			if (where === "css")
				expect(await p.repoGit("ls-tree", "-r", tree)).toContain(
					`${await p.repoGit("rev-parse", `${evil}:css/site.css`)}\tcss/site.css`,
				);
			return { tree, id, evil };
		};
		const fails = (tree: string, id: string) =>
			expect(readCodeSiteTree(p.job, { repository: kept, tree })).rejects.toMatchObject({
				name: "CodeHostJobFailure",
				code: "CODE_HOST_SITE_READ_FAILED",
				detail: `${id}: its bytes are not the folder's`,
			});
		for (const where of ["top", "css"] as const) {
			const { tree, id, evil } = await planted(where);
			await fails(tree, id);
			// The honest tree beside it still reads.
			const read = await readCodeSiteTree(p.job, { repository: kept, tree: evil });
			expect(read.files.map((file) => Buffer.from(file.content).toString())).toEqual([
				"p{color:tan}\n",
				"<p>evil</p>\n",
			]);
			// Undone for the next case: the planted object goes, and the next site writes it again.
			await rm(join(p.repo, "objects", id.slice(0, 2), id.slice(2)));
		}
		// Care's repack carries planted objects into a pack under the same ids, as they are: still found.
		const top = await planted("top"),
			css = await planted("css", { ...files, "index.html": "<p>shoq</p>\n" });
		await p.repoGit("repack", "-a", "-d", "--cruft", "--quiet");
		expect(await p.repoGit("count-objects", "-v")).toMatch(/^count: 0$/m);
		expect(await p.raw("tree", top.id)).toEqual(await p.raw("tree", top.evil));
		await fails(top.tree, top.id);
		await fails(css.tree, css.id);
	});

	it("refuses a tree that breaks the site's rules, from its entries alone, before any file is read", async () => {
		const p = await place();
		const refused = async (site: Site, problem: { code: string; path: string | null }) => {
			const tree = await p.site(site),
				start = p.log.length;
			const error = await readCodeSiteTree(p.job, { repository: kept, tree }).then(
				() => null,
				(caught: unknown) => caught,
			);
			expect(error).toBeInstanceOf(CodeSiteTreeInvalid);
			expect(error).toMatchObject({
				code: "CODE_HOST_SITE_TREE_INVALID",
				paths: problem.path === null ? [] : [problem.path],
				problem: { ...problem, variable: null },
			});
			// Its folders were walked; no file was read.
			expect(await p.askedWhole(start)).not.toContain("blob");
		};
		const index = "<p>shop</p>\n";
		// Three parts of the rule's length make 513 characters: one more than a site path has.
		const long = `${"a".repeat(200)}/${"b".repeat(200)}/${"c".repeat(106)}.html`;
		expect(long).toHaveLength(513);
		// Only regular web files of a path a site serves: a link, a submodule, a hidden part, another extension, a name
		// the rule refuses, and one too long.
		const names: [Site, string][] = [
			[{ files: { "index.html": index, "about.html": { link: "index.html" } } }, "about.html"],
			[{ files: { "index.html": index }, submodules: { "vendor/lib": "1".repeat(40) } }, "vendor/lib"],
			[{ files: { "index.html": index, ".well-known/app.json": "{}" } }, ".well-known/app.json"],
			[{ files: { "index.html": index, "notes.bak": "# notes\n" } }, "notes.bak"],
			[{ files: { "index.html": index, "my page.html": index } }, "my page.html"],
			[{ files: { "index.html": index, [long]: index } }, long],
		];
		for (const [site, path] of names) await refused(site, { code: "SITE_FILE_NAME", path });
		await readCodeSiteTree(p.job, {
			repository: kept,
			tree: await p.site({ files: { "index.html": index, [long.slice(1)]: index } }),
		});
		// index.html at the top: a folder alone, and an empty tree, have none.
		await refused({ files: { "site/index.html": index } }, { code: "SITE_NO_INDEX", path: null });
		const emptyTree = await p.sh('"$1" --git-dir="$2" mktree');
		await expect(readCodeSiteTree(p.job, { repository: kept, tree: emptyTree })).rejects.toMatchObject({
			code: "CODE_HOST_SITE_TREE_INVALID",
			problem: { code: "SITE_NO_INDEX" },
		});
	});

	it("takes 500 files in 100 folders, counting a folder that holds only a folder, and refuses one more of each", async () => {
		const p = await place();
		/** index.html, one file two folders down (n and n/m), and 498 files in 98 folders: 500 files, 100 folders. */
		const files: Record<string, string> = { "index.html": "<p>shop</p>\n", "n/m/deep.js": "1\n" };
		for (let at = 0; Object.keys(files).length < 500; at += 1)
			files[`f${String(at % 98).padStart(2, "0")}/file-${at}.js`] = `${at}\n`;
		expect(Object.keys(files)).toHaveLength(500);
		const read = await readCodeSiteTree(p.job, { repository: kept, tree: await p.site({ files }) });
		expect(read.files).toHaveLength(500);
		expect(read.manifestSha256).toBe(manifestOf(read.files));
		const tooMany = async (site: Site, code: string) =>
			expect(readCodeSiteTree(p.job, { repository: kept, tree: await p.site(site) })).rejects.toMatchObject({
				code: "CODE_HOST_SITE_TREE_INVALID",
				problem: { code, path: null },
			});
		await tooMany({ files: { ...files, "f00/one-more.js": "x\n" } }, "SITE_TOO_MANY_FILES");
		// The same 500 files with deep.js one folder further down: n, n/m and n/m/k, 101 folders.
		const { "n/m/deep.js": deep, ...rest } = files;
		await tooMany({ files: { ...rest, "n/m/k/deep.js": deep as string } }, "SITE_TOO_MANY_FOLDERS");
		// No more folders are walked than a site may have, also folders that lead to no file (the collect writes none):
		// index.html beside 100 empty folders is taken, beside 101 refused.
		const empty = await p.sh('"$1" --git-dir="$2" mktree'),
			index = await p.sh('printf "<p>shop</p>\\n" | "$1" --git-dir="$2" hash-object -w --stdin');
		const emptyFolders = (count: number) =>
			p.sh(
				'g=$1 r=$2; shift 2; { printf "100644 blob %s\\tindex.html\\n" "$1"; i=0; while [ "$i" -lt "$2" ]; do printf "040000 tree %s\\tf%03d\\n" "$3" "$i"; i=$((i + 1)); done; } | "$g" --git-dir="$r" mktree',
				index,
				String(count),
				empty,
			);
		const hundred = await readCodeSiteTree(p.job, { repository: kept, tree: await emptyFolders(100) });
		expect(hundred.files.map((file) => file.path)).toEqual(["index.html"]);
		await expect(readCodeSiteTree(p.job, { repository: kept, tree: await emptyFolders(101) })).rejects.toMatchObject({
			code: "CODE_HOST_SITE_TREE_INVALID",
			problem: { code: "SITE_TOO_MANY_FOLDERS" },
		});
	}, 120_000);

	it("takes a file of 10 MiB and a site of 25 MiB, read whole, and refuses one byte more of each", async () => {
		const p = await place();
		const fill = (byte: number, length: number) => Buffer.alloc(length, byte);
		/** 1 + 10 MiB + 10 MiB + (5 MiB - 1) = 25 MiB. */
		const files = {
			"index.html": "x",
			"a.mp4": fill(0x61, 10 * MiB),
			"b.mp4": fill(0x62, 10 * MiB),
			"c.pdf": fill(0x63, 5 * MiB - 1),
		};
		const read = await readCodeSiteTree(p.job, { repository: kept, tree: await p.site({ files }) });
		expect(read.files.map(({ path, bytes }) => [path, bytes])).toEqual([
			["a.mp4", 10 * MiB],
			["b.mp4", 10 * MiB],
			["c.pdf", 5 * MiB - 1],
			["index.html", 1],
		]);
		for (const file of read.files)
			expect(digest(file.content)).toBe(digest(Buffer.from(files[file.path as keyof typeof files])));
		const over = async (site: Site, problem: { code: string; path: string | null }) =>
			expect(readCodeSiteTree(p.job, { repository: kept, tree: await p.site(site) })).rejects.toMatchObject({
				code: "CODE_HOST_SITE_TREE_INVALID",
				problem,
			});
		await over({ files: { ...files, "c.pdf": fill(0x63, 5 * MiB) } }, { code: "SITE_TOO_LARGE", path: null });
		const large = { code: "SITE_FILE_TOO_LARGE", path: "a.mp4" };
		await over({ files: { "index.html": "x", "a.mp4": fill(0x61, 10 * MiB + 1) } }, large);
	}, 120_000);
});
