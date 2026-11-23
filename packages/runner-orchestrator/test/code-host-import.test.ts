import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	symlink,
	truncate,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { codeBundleName } from "../src/code-bundle-store.ts";
import {
	CODE_HOST_IMPORT_MEASURE,
	codeImportBelow,
	lookCodeImport,
	readIncomingCodeBundle,
} from "../src/code-host-import.ts";
import {
	type CodeHostCommand,
	type CodeHostCommandResult,
	type CodeHostJob,
	CodeHostJobFailure,
	CodeHostRefusal,
	codeRefsSha256,
} from "../src/code-host-jobs.ts";
import {
	closeCodeArea,
	openCodeArea,
	restoreCodeArea,
	setAsideCodeArea,
	verifyCodeBundle,
} from "../src/code-host-restore.ts";
import {
	CODE_IMPORT_KEY_KINDS,
	CODE_IMPORT_SCAN,
	CODE_IMPORT_STEPS,
	type CodeImportLook,
	type CodeImportLooked,
	type CodeImportRaw,
	codeImportBundleName,
	codeImportLookOf,
	codeImportProgressOf,
	codeImportStopOf,
	codeImportTime,
} from "../src/code-import.ts";
import { localShell } from "./helpers/code-host-shell.ts";

const exec = promisify(execFile),
	roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const GIT = "/usr/bin/git";
const kept = { host: "qorpera" as const, owner: "acme", name: "shop", baseBranch: "main" };
/** The import's clock: its 90 and 30 days end then. */
const NOW = Date.UTC(2026, 10, 12, 12, 0, 0);
const NOW_S = NOW / 1000;
const DAY = 86_400;
const CREATED = "2026-11-12T12:00:00.000Z";
const AT = "20261112T120500Z";
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const exists = (path: string) =>
	lstat(path).then(
		() => true,
		() => false,
	);
const HERE = dirname(fileURLToPath(import.meta.url));

async function fixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "code-host-import-")));
	roots.push(root);
	const companyRoot = join(root, "folder"),
		scratchRoot = join(root, "scratch");
	for (const dir of [companyRoot, scratchRoot]) await mkdir(dir);
	const env = {
		PATH: "/usr/bin:/bin",
		HOME: root,
		LC_ALL: "C",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_AUTHOR_NAME: "Test",
		GIT_AUTHOR_EMAIL: "test@example.invalid",
		GIT_COMMITTER_NAME: "Test",
		GIT_COMMITTER_EMAIL: "test@example.invalid",
	};
	/** git as the test runs it: its stdout, which must end 0. */
	const git = (args: string[], input?: Uint8Array, cwd = root) =>
		new Promise<Buffer>((resolve, reject) => {
			const child = spawn(GIT, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
			const out: Buffer[] = [],
				err: Buffer[] = [];
			child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
			child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
			child.stdin.on("error", () => {});
			child.stdin.end(input ?? Buffer.alloc(0));
			child.on("close", (code) =>
				code === 0
					? resolve(Buffer.concat(out))
					: reject(new Error(`git ${args.join(" ")}: ${Buffer.concat(err).toString()}`)),
			);
		});
	const log: CodeHostCommand[] = [],
		seen: { command: CodeHostCommand; result: CodeHostCommandResult }[] = [];
	const shell = localShell(log);
	const job: CodeHostJob = {
		shell: {
			run: async (command, signal) => {
				const result = await shell.run(command, signal);
				seen.push({ command, result });
				return result;
			},
		},
		layout: { companyRoot, scratchRoot, git: GIT },
		signal: new AbortController().signal,
	};
	const listing = async (folder: string) =>
		(await exec("/usr/bin/find", [folder, "-mindepth", "1", "-printf", "%y %s %P\\n"])).stdout
			.split("\n")
			.filter(Boolean)
			.sort();
	return { root, companyRoot, scratchRoot, git, log, seen, job, listing, code: join(companyRoot, "code/acme/shop") };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** A path as fast-import takes it: C-quoted when it holds a line feed. */
const quoted = (path: string) => (path.includes("\n") ? JSON.stringify(path) : path);

/** A history written by `git fast-import`: exact names, modes, times and authors, and no work tree. */
class History {
	readonly parts: Buffer[] = [];
	#mark = 0;
	commit(
		ref: string,
		o: {
			time: number;
			email?: string;
			message?: string;
			from?: number;
			merge?: number;
			files?: Record<string, string | Buffer>;
			symlinks?: Record<string, string>;
			links?: Record<string, string>;
			deletes?: string[];
			clean?: boolean;
		},
	): number {
		this.#mark += 1;
		const mark = this.#mark,
			who = `Dev <${o.email ?? "dev@example.com"}> ${o.time} +0000`;
		this.#text(`commit ${ref}\nmark :${mark}\nauthor ${who}\ncommitter ${who}\n`);
		this.#data(o.message ?? `change ${mark}`);
		if (o.from !== undefined) this.#text(`from :${o.from}\n`);
		if (o.merge !== undefined) this.#text(`merge :${o.merge}\n`);
		if (o.clean) this.#text("deleteall\n");
		for (const path of o.deletes ?? []) this.#text(`D ${quoted(path)}\n`);
		for (const [path, content] of Object.entries(o.files ?? {})) {
			this.#text(`M 100644 inline ${quoted(path)}\n`);
			this.#data(content);
		}
		for (const [path, target] of Object.entries(o.symlinks ?? {})) {
			this.#text(`M 120000 inline ${path}\n`);
			this.#data(target);
		}
		for (const [path, sha] of Object.entries(o.links ?? {})) this.#text(`M 160000 ${sha} ${path}\n`);
		this.#text("\n");
		return mark;
	}
	/** An annotated tag. */
	tag(name: string, from: number, time: number) {
		this.#text(`tag ${name}\nfrom :${from}\ntagger Dev <dev@example.com> ${time} +0000\n`);
		this.#data(`release ${name}`);
	}
	/** A ref at a commit: a light tag, or a branch. */
	reset(ref: string, from: number) {
		this.#text(`reset ${ref}\nfrom :${from}\n\n`);
	}
	#text(text: string) {
		this.parts.push(Buffer.from(text, "utf8"));
	}
	#data(content: string | Buffer) {
		const bytes = Buffer.from(content);
		this.parts.push(Buffer.from(`data ${bytes.length}\n`), bytes, Buffer.from("\n"));
	}
}

/** A bare repository made from a history, its HEAD at `head`. */
async function made(f: Fixture, history: History, head = "refs/heads/master") {
	const repo = join(f.root, `source-${randomUUID()}.git`),
		marks = `${repo}.marks`;
	await f.git(["init", "--quiet", "--bare", repo]);
	const git = (args: string[], input?: Uint8Array) => f.git([`--git-dir=${repo}`, ...args], input);
	await git(["fast-import", "--quiet", `--export-marks=${marks}`], Buffer.concat(history.parts));
	await git(["symbolic-ref", "HEAD", head]);
	const shas = new Map(
		(await readFile(marks, "utf8"))
			.split("\n")
			.filter(Boolean)
			.map((line) => [Number(line.slice(1, line.indexOf(" "))), line.slice(line.indexOf(" ") + 1)] as const),
	);
	const text = async (args: string[], input?: Uint8Array) => (await git(args, input)).toString("utf8").trim();
	return { repo, git, text, sha: (mark: number) => shas.get(mark) as string };
}
type Source = Awaited<ReturnType<typeof made>>;

/** The source's bundle (`git bundle create`), and its first bundle's facts as the fetch or the read would store them. */
async function bundled(f: Fixture, source: Source, defaultBranch = "master", revs = ["--all"], leftOut = 0) {
	const file = join(f.root, `${randomUUID()}.bundle`);
	await source.git(["bundle", "create", "--quiet", file, ...revs]);
	const bytes = await readFile(file),
		heads = (await source.text(["bundle", "list-heads", file])).split("\n").filter((line) => / refs\//.test(line));
	const mainSha = await source.text(["rev-parse", `refs/heads/${defaultBranch}`]);
	const raw: CodeImportRaw = {
		name: codeImportBundleName(CREATED, mainSha),
		sha256: digest(bytes),
		bytes: bytes.length,
		defaultBranch,
		mainSha,
		refs: heads.length,
		leftOut,
	};
	return { file, bytes, raw };
}

function pieces(bytes: Uint8Array, size = 64 * 1024): AsyncIterable<Uint8Array> {
	return (async function* () {
		for (let offset = 0; offset < bytes.length; offset += size) yield bytes.subarray(offset, offset + size);
	})();
}

/** The look, with the restore-shaped bundle's pieces caught. */
async function looking(
	f: Fixture,
	b: { bytes: Buffer; raw: CodeImportRaw },
	more: {
		look?: boolean;
		job?: CodeHostJob;
		options?: Parameters<typeof lookCodeImport>[4];
		source?: AsyncIterable<Uint8Array>;
	} = {},
) {
	const out: Buffer[] = [];
	const result = await lookCodeImport(
		more.job ?? f.job,
		{ repository: kept, raw: b.raw, look: more.look ?? true, now: NOW },
		more.source ?? pieces(b.bytes),
		{
			write: async (chunk) => {
				out.push(Buffer.from(chunk));
			},
		},
		more.options,
	);
	return { result, out: Buffer.concat(out), pieces: out.length };
}
const lookOf = (result: CodeImportLooked): CodeImportLook => result.look;

/** The refs of a bare repository, by name. */
async function refsIn(f: Fixture, repo: string) {
	return (await f.git([`--git-dir=${repo}`, "for-each-ref", "--format=%(refname) %(objectname)"]))
		.toString("utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => ({ name: line.slice(0, line.indexOf(" ")), sha: line.slice(line.indexOf(" ") + 1) }));
}

/** The job's git, with a command of the test's in the way. */
async function wrapped(f: Fixture, script: string): Promise<CodeHostJob> {
	const path = join(f.root, `git-${randomUUID()}`);
	await writeFile(path, `#!/bin/sh\n${script}\nexec ${GIT} "$@"\n`);
	await chmod(path, 0o755);
	return { ...f.job, layout: { ...f.job.layout, git: path } };
}

/** A typical history: several authors, the platform's own and a bot among them, a big file, tags and branches. */
function shop() {
	const h = new History();
	const c1 = h.commit("refs/heads/master", {
		time: NOW_S - 400 * DAY,
		email: "alice@example.com",
		files: { "README.md": "# shop\n", "src/a.js": "export const a = 1;\n" },
	});
	const c2 = h.commit("refs/heads/master", {
		time: NOW_S - 100 * DAY,
		email: "bob@example.com",
		files: { "src/b/c.js": "export const c = 3;\n" },
	});
	const c3 = h.commit("refs/heads/master", {
		time: NOW_S - 20 * DAY,
		email: "carol@example.com",
		files: { "big.bin": Buffer.alloc(5000, 7) },
	});
	const c4 = h.commit("refs/heads/master", {
		time: NOW_S - 10 * DAY,
		email: "4f1e2d3c-0000-4000-8000-000000000001@coding.qorpera.com",
		files: { "src/a.js": "export const a = 2;\n" },
	});
	const c5 = h.commit("refs/heads/master", {
		time: NOW_S - 5 * DAY,
		email: "renovate[bot]@users.noreply.github.com",
		files: { "package.json": "{}\n" },
	});
	const c6 = h.commit("refs/heads/master", {
		time: NOW_S - 2 * DAY,
		email: "code@qorpera.com",
		files: { "changes.txt": "one\n" },
	});
	const c7 = h.commit("refs/heads/master", {
		time: NOW_S - DAY,
		email: "Alice@Example.com",
		files: { "src/a.js": "export const a = 3;\n" },
	});
	h.reset("refs/tags/v1", c3);
	h.tag("v2", c5, NOW_S - 4 * DAY);
	h.commit("refs/heads/feature", { time: NOW_S - 3 * DAY, from: c6, files: { "feature.txt": "f\n" } });
	h.commit("refs/heads/old", { time: NOW_S - 200 * DAY, from: c1, files: { "old.txt": "o\n" } });
	return { h, marks: { c1, c2, c3, c4, c5, c6, c7 } };
}

/** The blobs the kept refs reach, as git counts them: every one, and their sizes. */
async function blobsOf(f: Fixture, repo: string, tips: string[]) {
	const listed = (
		await f.git([`--git-dir=${repo}`, "rev-list", "--objects", "--stdin"], Buffer.from(`${tips.join("\n")}\n`))
	)
		.toString("latin1")
		.split("\n")
		.filter(Boolean)
		.map((line) => line.slice(0, 40));
	const checked = (
		await f.git(
			[`--git-dir=${repo}`, "cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
			Buffer.from(`${listed.join("\n")}\n`),
		)
	)
		.toString("latin1")
		.split("\n")
		.filter((line) => line.includes(" blob "))
		.map((line) => ({ oid: line.slice(0, 40), size: Number(line.split(" ")[2]) }));
	return checked;
}

describe("code host: an import's look (own code storage, step 6, part B)", { timeout: 120_000 }, () => {
	it("looks only: the facts of the history, main and the refs, and nothing made, written or left behind", async () => {
		const f = await fixture(),
			{ h, marks } = shop(),
			source = await made(f, h);
		await source.git(["tag", "tree-tag", `${source.sha(marks.c1)}^{tree}`]);
		const b = await bundled(f, source, "master", ["--all"], 3);
		const before = await f.listing(f.companyRoot);
		const { result, out } = await looking(f, b);
		expect(result.state).toBe("looked");
		const look = lookOf(result);
		expect(codeImportLookOf(look)).toEqual(look);
		const main = source.sha(marks.c7);
		const blobs = await blobsOf(f, source.repo, [
			main,
			await source.text(["rev-parse", "refs/tags/v1"]),
			await source.text(["rev-parse", "refs/tags/v2"]),
			await source.text(["rev-parse", "refs/heads/feature"]),
		]);
		expect(look).toEqual({
			schema: "qorpera.code-import-look/v1",
			bytes: b.bytes.length,
			defaultBranch: "master",
			mainSha: main,
			commits: 7,
			firstAt: "2025-10-08T12:00:00Z",
			lastAt: "2026-11-11T12:00:00Z",
			// carol, alice (of any case); not the session's, the bot's or code@qorpera.com; bob is older.
			authors30d: 2,
			tags: { seen: 3, kept: 2 },
			branches: { seen: 2, kept: 1 },
			// The one branch kept, a change main lacks and one of main's it lacks.
			lines: {
				count: 1,
				changes: 1,
				shown: [{ name: "feature", ahead: 1, behind: 1, lastAt: codeImportTime(NOW_S - 3 * DAY), fits: true }],
			},
			// The fetch's 3, the tree's tag and the old branch.
			leftOut: 5,
			files: 6,
			entries: 8,
			biggest: { path: "big.bin", bytes: 5000 },
			lfs: { pointers: 0 },
			submodules: 0,
			refused: { code: null, paths: [], more: 0 },
			secrets: {
				found: 0,
				shown: [],
				scan: { blobs: blobs.length, bytes: blobs.reduce((sum, blob) => sum + blob.size, 0), all: true },
			},
			fits: true,
			why: null,
		});
		expect(out.length).toBe(0);
		expect(await f.listing(f.companyRoot)).toEqual(before);
		expect(await readdir(f.scratchRoot)).toEqual([]);
		// Not a job's values: refused before any command.
		const commands = f.log.length;
		const sink = { write: async () => {} };
		for (const bad of [
			() =>
				lookCodeImport(
					f.job,
					{ repository: { ...kept, host: "github.com" }, raw: b.raw, look: true, now: NOW },
					pieces(b.bytes),
					sink,
				),
			() =>
				lookCodeImport(
					f.job,
					{ repository: kept, raw: { ...b.raw, name: "latest" }, look: true, now: NOW },
					pieces(b.bytes),
					sink,
				),
			() =>
				lookCodeImport(
					f.job,
					{
						repository: kept,
						raw: { ...b.raw, defaultBranch: "ghp_0123456789abcdefghijABCDEFGHIJ012345" },
						look: true,
						now: NOW,
					},
					pieces(b.bytes),
					sink,
				),
			() =>
				lookCodeImport(
					f.job,
					{ repository: kept, raw: b.raw, look: "yes" as never, now: NOW },
					pieces(b.bytes),
					sink,
				),
			() => lookCodeImport(f.job, { repository: kept, raw: b.raw, look: true, now: -1 }, pieces(b.bytes), sink),
			() =>
				lookCodeImport(
					f.job,
					{ repository: kept, raw: b.raw, look: true, now: NOW, more: 1 } as never,
					pieces(b.bytes),
					sink,
				),
			() => lookCodeImport(f.job, { repository: kept, raw: b.raw, look: true, now: NOW }, b.bytes as never, sink),
			() =>
				lookCodeImport(f.job, { repository: kept, raw: b.raw, look: true, now: NOW }, pieces(b.bytes), {} as never),
			() =>
				lookCodeImport(f.job, { repository: kept, raw: b.raw, look: true, now: NOW }, pieces(b.bytes), sink, {
					fsckMs: 0,
				}),
			() =>
				lookCodeImport(f.job, { repository: kept, raw: b.raw, look: true, now: NOW }, pieces(b.bytes), sink, {
					scanSeconds: 0,
				}),
			() =>
				lookCodeImport(f.job, { repository: kept, raw: b.raw, look: true, now: NOW }, pieces(b.bytes), sink, {
					chunkBytes: 0,
				}),
			() =>
				lookCodeImport(f.job, { repository: kept, raw: b.raw, look: true, now: NOW }, pieces(b.bytes), sink, {
					scanBytes: 2 * 1024 ** 3 + 1,
				}),
			() =>
				lookCodeImport(f.job, { repository: kept, raw: b.raw, look: true, now: NOW }, pieces(b.bytes), sink, {
					linesSeconds: 0,
				}),
			() =>
				lookCodeImport(f.job, { repository: kept, raw: b.raw, look: true, now: NOW }, pieces(b.bytes), sink, {
					lineTreeBytes: 32 * 1024 ** 2 + 1,
				}),
		])
			await expect(bad()).rejects.toThrow("INVALID_CODE_HOST_JOB");
		expect(f.log).toHaveLength(commands);
		// The first commit is the oldest root's; and a first bundle whose default branch is at another commit than its
		// facts say is not the one stored.
		const roots = new History();
		const lib = roots.commit("refs/heads/lib", { time: NOW_S - 500 * DAY, files: { "lib.txt": "l\n" } });
		const right = roots.commit("refs/heads/master", { time: NOW_S - 300 * DAY, files: { "a.txt": "a\n" } });
		roots.commit("refs/heads/master", {
			time: NOW_S - 200 * DAY,
			from: right,
			merge: lib,
			files: { "b.txt": "b\n" },
		});
		const merged = await made(f, roots),
			two = await bundled(f, merged);
		expect(lookOf((await looking(f, two)).result)).toMatchObject({
			commits: 3,
			firstAt: codeImportTime(NOW_S - 500 * DAY),
			lastAt: codeImportTime(NOW_S - 200 * DAY),
		});
		const elsewhere = {
			...two.raw,
			mainSha: merged.sha(right),
			name: codeImportBundleName(CREATED, merged.sha(right)),
		};
		await expect(looking(f, { bytes: two.bytes, raw: elsewhere })).rejects.toMatchObject({
			code: "CODE_HOST_IMPORT_BUNDLE_DIFFERS",
		});
	});

	it("applies the refs plan: main and the mark at the default branch, the newest 500 tags and 200 branches of 90 days", async () => {
		const f = await fixture(),
			h = new History();
		const root = h.commit("refs/heads/master", { time: NOW_S - 300 * DAY, files: { "a.txt": "a\n" } });
		let previous = root;
		for (let index = 0; index < 501; index += 1) {
			previous = h.commit("refs/heads/master", {
				time: NOW_S - 200 * DAY + index * 60,
				from: previous,
				files: { "a.txt": `a ${index}\n` },
			});
			h.reset(`refs/tags/t${String(index).padStart(3, "0")}`, previous);
		}
		for (let index = 0; index < 201; index += 1)
			h.commit(`refs/heads/topic/${String(index).padStart(3, "0")}`, {
				time: NOW_S - 30 * DAY + index * 60,
				from: root,
				files: { [`t${index}.txt`]: `${index}\n` },
			});
		h.commit("refs/heads/stale", { time: NOW_S - 91 * DAY, from: root, files: { "s.txt": "s\n" } });
		const source = await made(f, h),
			b = await bundled(f, source);
		const { result, out, pieces: count } = await looking(f, b, { look: false, options: { chunkBytes: 4096 } });
		if (result.state !== "kept") throw new Error(`not kept: ${JSON.stringify(result.look)}`);
		expect(count).toBe(Math.ceil(out.length / 4096));
		const look = result.look;
		expect(look.tags).toEqual({ seen: 501, kept: 500 });
		expect(look.branches).toEqual({ seen: 202, kept: 200 });
		expect(look.leftOut).toBe(3);
		// The bundle read out is the one the answer says.
		expect(out.length).toBe(result.bundle.bytes);
		expect(digest(out)).toBe(result.bundle.sha256);
		const file = join(f.root, "kept.bundle");
		await writeFile(file, out);
		const heads = (await f.git(["bundle", "list-heads", file])).toString("utf8").split("\n").filter(Boolean);
		const main = source.sha(previous);
		expect(heads).toContain(`${main} HEAD`);
		const named = heads.filter((line) => !line.endsWith(" HEAD")).map((line) => line.slice(41));
		expect(named).toHaveLength(702);
		expect(named.filter((name) => name.startsWith("refs/tags/"))).toEqual(
			Array.from({ length: 500 }, (_, index) => `refs/tags/t${String(index + 1).padStart(3, "0")}`),
		);
		expect(named.filter((name) => name.startsWith("refs/qorpera/imported/heads/")).sort()).toEqual(
			Array.from(
				{ length: 200 },
				(_, index) => `refs/qorpera/imported/heads/topic/${String(index + 1).padStart(3, "0")}`,
			),
		);
		expect(result.bundle.refs.map((ref) => ref.name)).toEqual(
			[...named].sort((a, c) => Buffer.compare(Buffer.from(a), Buffer.from(c))),
		);
		expect(result.bundle.refsSha256).toBe(codeRefsSha256(result.bundle.refs));
		expect(result.bundle.mainSha).toBe(main);
		expect(result.bundle.refs.find((ref) => ref.name === "refs/heads/main")?.sha).toBe(main);
		expect(result.bundle.refs.find((ref) => ref.name === "refs/qorpera/kept-here")?.sha).toBe(main);
		expect(result.bundle.gitVersion).toMatch(/^\d+\.\d+/);
		expect(await readdir(f.scratchRoot)).toEqual([]);
	});

	// The lead's call 6a of the import's follow-ups: another branch brought in as main, and the source's own default 400
	// days old, kept beside it whatever its age, measured as a line, and in the restore-shaped bundle.
	it("keeps the source's own default whatever its age when another branch came in as main", async () => {
		const f = await fixture(),
			h = new History();
		const root = h.commit("refs/heads/master", { time: NOW_S - 500 * DAY, files: { "a.txt": "a\n" } });
		h.commit("refs/heads/master", { time: NOW_S - 400 * DAY, from: root, files: { "m.txt": "m\n" } });
		h.commit("refs/heads/feature", { time: NOW_S - DAY, from: root, files: { "f.txt": "f\n" } });
		h.commit("refs/heads/stale", { time: NOW_S - 400 * DAY, from: root, files: { "s.txt": "s\n" } });
		const b = await bundled(f, await made(f, h), "feature");
		// As today without it: the old default is older than 90 days, left out, and no line.
		const today = lookOf((await looking(f, b)).result);
		expect(today.defaultBranch).toBe("feature");
		expect(today.branches).toEqual({ seen: 2, kept: 0 });
		expect(today.lines).toEqual({ count: 0, changes: 0, shown: [] });
		const named = { bytes: b.bytes, raw: { ...b.raw, sourceBranch: "master" } };
		const look = lookOf((await looking(f, named)).result);
		expect(look.branches).toEqual({ seen: 2, kept: 1 });
		expect(look.leftOut).toBe(today.leftOut - 1);
		expect(look.lines).toEqual({
			count: 1,
			changes: 1,
			shown: [{ name: "master", ahead: 1, behind: 1, lastAt: codeImportTime(NOW_S - 400 * DAY), fits: true }],
		});
		const { result } = await looking(f, named, { look: false });
		if (result.state !== "kept") throw new Error(`not kept: ${JSON.stringify(result.look)}`);
		expect(result.bundle.refs.map((ref) => ref.name)).toEqual([
			"refs/heads/main",
			"refs/qorpera/imported/heads/master",
			"refs/qorpera/kept-here",
		]);
		expect(await readdir(f.scratchRoot)).toEqual([]);
	});

	it("measures the other lines of work: the changes main lacks, each counted once, at most 10 shown, and whether the folder takes their names", async () => {
		const f = await fixture(),
			h = new History();
		/** Each file's bytes hold a mark of their own: none may come out of the code host. */
		const marks: string[] = [];
		const files = (...names: string[]) =>
			Object.fromEntries(
				names.map((name) => {
					const mark = `LINE-${randomUUID()}`;
					marks.push(mark);
					return [name, `${mark}\n`];
				}),
			);
		h.commit("refs/heads/master", { time: NOW_S - 100 * DAY, files: files("README.md") });
		const m2 = h.commit("refs/heads/master", { time: NOW_S - 50 * DAY, files: files("src/a.js") });
		const m3 = h.commit("refs/heads/master", { time: NOW_S - 10 * DAY, files: files("src/b.js") });
		// Two lines that share two changes: three changes main lacks between them, not five.
		h.commit("refs/heads/two", { time: NOW_S - 20 * DAY, from: m2, files: files("two/1.txt") });
		const s2 = h.commit("refs/heads/two", { time: NOW_S - 15 * DAY, files: files("two/2.txt") });
		h.commit("refs/heads/two-more", { time: NOW_S - 5 * DAY, from: s2, files: files("two/3.txt") });
		// Behind main alone: kept, and no line of work.
		h.reset("refs/heads/behind", m2);
		// A name the company folder refuses (a part ending in a dot); two names one to the folder by case.
		h.commit("refs/heads/bad", { time: NOW_S - 2 * DAY, from: m3, files: files("bad.") });
		h.commit("refs/heads/clash", { time: NOW_S - 4 * DAY, from: m3, files: files("Notes.txt", "notes.txt") });
		// A name like a key: counted and shown, its name not.
		const keyLike = "feature/AKIAGHJKLMNPRSTUVWXY";
		h.commit(`refs/heads/${keyLike}`, { time: NOW_S - DAY, from: m3, files: files("k.txt") });
		h.commit("refs/heads/wide", {
			time: NOW_S - 3 * DAY,
			from: m3,
			files: files(...Array.from({ length: 40 }, (_, i) => `wide/${i}.txt`)),
		});
		for (let i = 1; i <= 6; i += 1)
			h.commit(`refs/heads/t0${i}`, { time: NOW_S - (30 + i) * DAY, from: m3, files: files(`t${i}.txt`) });
		const source = await made(f, h),
			b = await bundled(f, source);
		const sha = (name: string) => source.text(["rev-parse", `refs/heads/${name}`]);
		const at = (days: number) => codeImportTime(NOW_S - days * DAY);
		const { result } = await looking(f, b);
		expect(result.state).toBe("looked");
		const look = lookOf(result);
		expect(look.branches).toEqual({ seen: 13, kept: 13 });
		// Twelve lines hold changes main lacks (behind holds none); thirteen such changes, the two that two and
		// two-more share counted once; ten shown, by changes, then the newest; t05 and t06 not shown.
		expect(look.lines).toEqual({
			count: 12,
			changes: 13,
			shown: [
				{ name: "two-more", ahead: 3, behind: 1, lastAt: at(5), fits: true },
				{ name: "two", ahead: 2, behind: 1, lastAt: at(15), fits: true },
				{ name: null, ahead: 1, behind: 0, lastAt: at(1), fits: true },
				{ name: "bad", ahead: 1, behind: 0, lastAt: at(2), fits: false },
				{ name: "wide", ahead: 1, behind: 0, lastAt: at(3), fits: true },
				{ name: "clash", ahead: 1, behind: 0, lastAt: at(4), fits: false },
				{ name: "t01", ahead: 1, behind: 0, lastAt: at(31), fits: true },
				{ name: "t02", ahead: 1, behind: 0, lastAt: at(32), fits: true },
				{ name: "t03", ahead: 1, behind: 0, lastAt: at(33), fits: true },
				{ name: "t04", ahead: 1, behind: 0, lastAt: at(34), fits: true },
			],
		});
		expect(JSON.stringify(look)).not.toContain("AKIA");
		// Each command of the measure ran under its bounds in the code host: one walk of each kind, and the trees of the
		// ten lines shown alone, never t05's or t06's.
		const measured = f.log.filter((command) => command.argv[2] === CODE_HOST_IMPORT_MEASURE);
		const args = (command: CodeHostCommand) => command.argv.slice(8).join(" ");
		expect(measured.filter((command) => args(command).includes(" for-each-ref --stdin "))).toHaveLength(1);
		expect(measured.filter((command) => args(command).includes(" rev-list --count --stdin"))).toHaveLength(1);
		const listed = measured.filter((command) => args(command).includes(" ls-tree "));
		expect(listed.map((command) => command.argv.at(-1)).sort()).toEqual(
			(
				await Promise.all(
					["two-more", "two", keyLike, "bad", "wide", "clash", "t01", "t02", "t03", "t04"].map((name) =>
						sha(name),
					),
				)
			).sort(),
		);
		expect(measured).toHaveLength(12);
		// Each within 300 seconds; the walk's answer within 1 MiB, the count's 64 bytes, a tree's 32 MiB.
		expect(
			measured.map((command) => [
				command.argv[4],
				command.argv[5],
				command.maximumOutputBytes - Number(command.argv[5]),
			]),
		).toEqual([
			["300", String(1024 ** 2), 5],
			["300", "64", 5],
			...listed.map(() => ["300", String(32 * 1024 ** 2), 5]),
		]);
		// Not one byte of a file came out of the code host, in what any command of the look handed out or said.
		expect(marks.length).toBe(56);
		for (const { result: out } of f.seen)
			for (const mark of marks) {
				expect(out.stdout.includes(mark)).toBe(false);
				expect(out.stderr.includes(mark)).toBe(false);
			}
		expect(await readdir(f.scratchRoot)).toEqual([]);
		// Brought in, the same: the lines are measured before the plan moves the heads.
		const brought = await looking(f, b, { look: false });
		expect(brought.result.state).toBe("kept");
		expect(brought.result.look.lines).toEqual(look.lines);
		// A line's tree over its bound is not read: whether it fits is not known. The rest is as before.
		const narrow = lookOf((await looking(f, b, { options: { lineTreeBytes: 2000 } })).result);
		expect(narrow.lines).toEqual({
			...look.lines,
			shown: look.lines?.shown.map((shown) => (shown.name === "wide" ? { ...shown, fits: null } : shown)),
		});
		// One line, no line, and no head beside main.
		const one = new History();
		const base = one.commit("refs/heads/master", { time: NOW_S - DAY, files: { "a.txt": "a\n" } });
		one.commit("refs/heads/topic", { time: NOW_S - DAY, from: base, files: { "b.txt": "b\n" } });
		const alone = new History();
		alone.commit("refs/heads/master", { time: NOW_S - DAY, files: { "a.txt": "a\n" } });
		const same = new History();
		const tip = same.commit("refs/heads/master", { time: NOW_S - DAY, files: { "a.txt": "a\n" } });
		same.reset("refs/heads/copy", tip);
		/** The lines of a history's look, and how many commands of the measure it ran. */
		const lines = async (history: History) => {
			const before = f.log.length,
				found = lookOf((await looking(f, await bundled(f, await made(f, history)))).result).lines;
			return {
				found,
				ran: f.log.slice(before).filter((command) => command.argv[2] === CODE_HOST_IMPORT_MEASURE).length,
			};
		};
		expect(await lines(one)).toEqual({
			found: { count: 1, changes: 1, shown: [{ name: "topic", ahead: 1, behind: 0, lastAt: at(1), fits: true }] },
			ran: 3,
		});
		// No head kept beside main: nothing to measure. One that holds nothing main lacks: one walk, no more.
		expect(await lines(alone)).toEqual({ found: { count: 0, changes: 0, shown: [] }, ran: 0 });
		expect(await lines(same)).toEqual({ found: { count: 0, changes: 0, shown: [] }, ran: 1 });
	});

	it("leaves the lines out when their measure does not end well, and the look goes on; the job's own stop goes on up", async () => {
		const f = await fixture(),
			{ h } = shop(),
			source = await made(f, h),
			b = await bundled(f, source);
		const feature = await source.text(["rev-parse", "refs/heads/feature"]);
		const { lines, ...rest } = lookOf((await looking(f, b)).result);
		expect(lines?.count).toBe(1);
		for (const [what, script, options] of [
			["the ahead-behind walk fails", 'case "$*" in *ahead-behind*) exit 3;; esac', {}],
			["the distinct count fails", 'case "$*" in *"rev-list --count --stdin"*) exit 3;; esac', {}],
			["a line's listing fails", `case "$*" in *"ls-tree -r -t -l -z --full-tree ${feature}"*) exit 3;; esac`, {}],
			[
				"the walk answers what is no git's",
				'case "$*" in *ahead-behind*) echo refs/heads/feature; exit 0;; esac',
				{},
			],
			[
				"the walk answers a head twice",
				String.raw`case "$*" in *ahead-behind*) printf 'refs/heads/feature\0001 1\nrefs/heads/feature\0000 1\n'; exit 0;; esac`,
				{},
			],
			[
				"the walk's answer is cut within a line",
				String.raw`case "$*" in *ahead-behind*) printf 'refs/heads/feature\0001 1'; exit 0;; esac`,
				{},
			],
			["the walk leaves a head out", 'case "$*" in *ahead-behind*) cat >/dev/null; exit 0;; esac', {}],
			["the count is below a line's own", 'case "$*" in *"rev-list --count --stdin"*) echo 0; exit 0;; esac', {}],
			[
				"the walk answers more than its bound",
				'case "$*" in *ahead-behind*) head -c 2000000 /dev/zero; exit 0;; esac',
				{},
			],
			["the walk does not end", 'case "$*" in *ahead-behind*) exec sleep 60;; esac', { linesSeconds: 1 }],
		] as [string, string, { linesSeconds?: number }][]) {
			const started = Date.now();
			const { result } = await looking(f, b, { job: await wrapped(f, script), look: false, options });
			expect(result.state, what).toBe("kept");
			expect("lines" in result.look, what).toBe(false);
			expect(result.look, what).toEqual(rest);
			expect(Date.now() - started, what).toBeLessThan(30_000);
		}
		// The job's own stop, while the measure runs, is the job's: not a measure that did not end well.
		const controller = new AbortController(),
			started = join(f.root, "started");
		const job = {
			...(await wrapped(f, `case "$*" in *ahead-behind*) : >"${started}"; exec sleep 20;; esac`)),
			signal: controller.signal,
		};
		const looked = looking(f, b, { job });
		looked.catch(() => {});
		for (let tries = 0; !(await exists(started)) && tries < 600; tries += 1)
			await new Promise((resolve) => setTimeout(resolve, 50));
		controller.abort();
		await expect(looked).rejects.toMatchObject({ name: "AbortError" });
	});

	it("leaves out a case clash, an NFD name, an a./b name, other refs and a name that is not UTF-8; restore's own jobs build it with proven", async () => {
		const f = await fixture(),
			h = new History();
		const one = h.commit("refs/heads/master", {
			time: NOW_S - 5 * DAY,
			files: { "index.html": "<p>shop</p>\n", "src/cart.js": "export const cart = [];\n" },
		});
		const two = h.commit("refs/heads/master", {
			time: NOW_S - 4 * DAY,
			files: { "src/cart.js": "export const cart = [1];\n" },
		});
		h.commit("refs/heads/Fix", { time: NOW_S - 2 * DAY, from: one, files: { "fix.txt": "F\n" } });
		h.commit("refs/heads/fix", { time: NOW_S - 3 * DAY, from: one, files: { "fix.txt": "f\n" } });
		h.reset("refs/heads/é", one);
		h.reset("refs/heads/a./b", one);
		h.reset("refs/remotes/origin/master", one);
		h.reset("refs/heads/main/x", one);
		const source = await made(f, h);
		await source.git(
			["update-ref", "--no-deref", "-z", "--stdin"],
			Buffer.concat([
				Buffer.from("create refs/heads/caf"),
				Buffer.from([0xe9]),
				Buffer.from(`\0${source.sha(one)}\0`),
			]),
		);
		const b = await bundled(f, source);
		const { result, out } = await looking(f, b, { look: false });
		if (result.state !== "kept") throw new Error(`not kept: ${JSON.stringify(result.look)}`);
		// Fix kept (the newer of the two), fix one name with it to the folder; the NFD name and a./b refused by the
		// folder's rule; the remote ref neither a head nor a tag; the latin-1 name removed before the plan. main/x is kept:
		// as an imported head it is no folder of main's.
		expect(result.look.branches).toEqual({ seen: 5, kept: 2 });
		expect(result.look.leftOut).toBe(5);
		expect(result.bundle.refs.map((ref) => ref.name)).toEqual([
			"refs/heads/main",
			"refs/qorpera/imported/heads/Fix",
			"refs/qorpera/imported/heads/main/x",
			"refs/qorpera/kept-here",
		]);
		// The restore-shaped bundle is one a restore takes as it is: verified, then closed and built with `proven`.
		const bundle = {
			name: codeBundleName(CREATED, source.sha(two)),
			sha256: result.bundle.sha256,
			bytes: result.bundle.bytes,
			refsSha256: result.bundle.refsSha256,
			mainSha: result.bundle.mainSha,
		};
		expect(await verifyCodeBundle(f.job, { repository: kept, bundle }, pieces(out))).toEqual({
			mainSha: source.sha(two),
			refsSha256: bundle.refsSha256,
			refs: 4,
		});
		const fsckBefore = f.log.filter((command) => command.argv.includes("fsck")).length;
		const requestId = randomUUID();
		expect(
			await closeCodeArea(f.job, { repository: kept, requestId, bundle, at: AT, fresh: false }, pieces(out), {
				proven: true,
			}),
		).toMatchObject({ state: "closed", step: "closed" });
		expect(await setAsideCodeArea(f.job, { repository: kept, bundle: bundle.name })).toEqual({
			state: "absent",
			movedTo: null,
			moved: 0,
		});
		expect(await restoreCodeArea(f.job, { repository: kept, bundle }, pieces(out), { proven: true })).toEqual({
			mainSha: source.sha(two),
			refsSha256: bundle.refsSha256,
			refs: 4,
		});
		// Neither proof ran an fsck.
		expect(f.log.filter((command) => command.argv.includes("fsck")).length).toBe(fsckBefore);
		let recorded = 0;
		expect(
			await openCodeArea(f.job, { repository: kept, bundle, sessions: [] }, async () => {
				recorded += 1;
			}),
		).toMatchObject({ state: "opened", mainSha: source.sha(two) });
		expect(recorded).toBe(1);
		const repo = join(f.code, "repo.git");
		expect(codeRefsSha256(await refsIn(f, repo))).toBe(bundle.refsSha256);
		expect(await readFile(join(repo, "HEAD"), "utf8")).toBe("ref: refs/heads/main\n");
		expect(await readFile(join(f.code, "main/src/cart.js"), "utf8")).toBe("export const cart = [1];\n");
		await f.git([`--git-dir=${repo}`, "fsck", "--full", "--strict", "--no-dangling", "--no-progress"]);
	});

	it("refuses main's tree with its paths: LFS pointers, a gitlink, more than 9,000 entries, names not NFC", async () => {
		const f = await fixture();
		const refusedBy = async (files: Record<string, string | Buffer>, links: Record<string, string> = {}) => {
			const h = new History();
			h.commit("refs/heads/master", { time: NOW_S - DAY, files, links });
			const b = await bundled(f, await made(f, h));
			const { result, out } = await looking(f, b, { look: false });
			// Nothing else is made: the look alone, with its refusal.
			expect(result.state).toBe("looked");
			expect(out.length).toBe(0);
			return result.look;
		};
		const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${"a".repeat(64)}\nsize 12345\n`;
		const lfs = await refusedBy({
			"assets/logo.png": pointer,
			// The version line not where the file starts, and a file of 1 KiB that starts with it: no pointers.
			"docs/lfs.md": `see:\n${pointer}`,
			"docs/long.txt": `${pointer}${"x".repeat(1024 - pointer.length)}`,
			"src/a.js": "a\n",
		});
		expect(lfs).toMatchObject({
			lfs: { pointers: 1 },
			refused: { code: "IMPORT_USES_LFS", paths: ["assets/logo.png"], more: 0 },
			fits: false,
			why: "IMPORT_USES_LFS",
			files: 4,
		});
		const lfsJust = await refusedBy({ "docs/long.txt": `${pointer}${"x".repeat(1023 - pointer.length)}` });
		expect(lfsJust).toMatchObject({ lfs: { pointers: 1 }, why: "IMPORT_USES_LFS" });

		const link = await refusedBy({ "a.txt": "a\n" }, { "vendor/lib": "0123456789abcdef0123456789abcdef01234567" });
		expect(link).toMatchObject({
			submodules: 1,
			refused: { code: "IMPORT_USES_SUBMODULES", paths: ["vendor/lib"], more: 0 },
			why: "IMPORT_USES_SUBMODULES",
			entries: 3,
		});

		// 9,000 entries pass (one folder, 8,998 files in it and one beside it); 9,001 do not.
		const many = (count: number) => {
			const files: Record<string, string> = { "a.txt": "a\n" };
			for (let index = 0; index < count; index += 1) files[`d/f${index}`] = "x\n";
			return files;
		};
		const h = new History();
		h.commit("refs/heads/master", { time: NOW_S - DAY, files: many(8998) });
		const fits = await looking(f, await bundled(f, await made(f, h)), { look: true });
		expect(fits.result.look).toMatchObject({ entries: 9000, files: 8999, fits: true, why: null });
		const over = await refusedBy(many(8999));
		expect(over).toMatchObject({
			entries: 9001,
			refused: { code: "IMPORT_TOO_MANY_FILES", paths: [], more: 0 },
			why: "IMPORT_TOO_MANY_FILES",
		});

		const nfd = await refusedBy({ "café.txt": "nfd\n", "ok.txt": "ok\n" });
		expect(nfd).toMatchObject({
			refused: { code: "CODE_HOST_NAMES_NOT_NFC", paths: ["café.txt"], more: 0 },
			why: "CODE_HOST_NAMES_NOT_NFC",
			files: 2,
		});
		// The first rule broken is the refusal: names before entries, LFS and gitlinks.
		const both = await refusedBy(
			{ "café.txt": "nfd\n", "logo.png": pointer },
			{ lib: "0123456789abcdef0123456789abcdef01234567" },
		);
		expect(both).toMatchObject({ refused: { code: "CODE_HOST_NAMES_NOT_NFC" }, lfs: { pointers: 1 }, submodules: 1 });
		const later = await refusedBy({ "logo.png": pointer }, { lib: "0123456789abcdef0123456789abcdef01234567" });
		expect(later).toMatchObject({ refused: { code: "IMPORT_USES_LFS" } });
	});

	it("refuses main's tree with a name the company folder refuses where main will stand, and never touches the place", async () => {
		const f = await fixture();
		const before = await f.listing(f.companyRoot);
		const looked = async (files: Record<string, string>, look = false) => {
			const h = new History();
			h.commit("refs/heads/master", { time: NOW_S - DAY, files: { "ok.txt": "ok\n", ...files } });
			return looking(f, await bundled(f, await made(f, h)), { look });
		};
		const refusedFor = async (
			files: Record<string, string>,
			paths: (string | null)[],
			code = "CODE_HOST_NAMES_FOLDER_REFUSES",
		) => {
			const { result, out } = await looked(files);
			// The look alone, with its refusal: nothing else is made.
			expect(result.state).toBe("looked");
			expect(result.look).toMatchObject({ refused: { code, paths, more: 0 }, fits: false, why: code });
			expect(out.length).toBe(0);
			// Nothing was closed, made or written at the place, nor anywhere in the folder.
			expect(await exists(f.code)).toBe(false);
			expect(await f.listing(f.companyRoot)).toEqual(before);
		};
		// The review's case: git takes `bad.`, and so does `checkNames`; the folder refuses the trailing dot.
		await refusedFor({ "bad.": "x\n" }, ["bad."]);
		// A folder ending in a space, named once and not again for what is in it.
		await refusedFor({ "x /f.txt": "x\n", "x /y/g.txt": "y\n" }, ["x "]);
		// A part ending in a dot deep in the tree, a backslash, a control character (never shown).
		await refusedFor({ "a/b/c./d.txt": "d\n", "a/b/e.txt": "e\n" }, ["a/b/c."]);
		await refusedFor({ "a\\b.txt": "b\n" }, ["a\\b.txt"]);
		await refusedFor({ "tab\there.txt": "t\n" }, [null]);
		// An NFD name is `checkNames`'s own refusal, before the folder's rule.
		await refusedFor({ "café.txt": "nfd\n" }, ["café.txt"], "CODE_HOST_NAMES_NOT_NFC");
		// WHY: Folder names cap at 255 bytes and SQL qorpera_folder_commit caps folded keys at 2,600 bytes
		// under code/acme/shop/worktrees/<uuid>/ (62 bytes), so 2,538 bytes fit and 2,539 do not.
		const deep = Array.from({ length: 12 }, () => "p".repeat(200)).join("/");
		await refusedFor({ [`${"n".repeat(252)}.txt`]: "n\n" }, [null]);
		await refusedFor({ [`${deep}/${"q".repeat(127)}`]: "q\n" }, [null]);
		const fits = await looked(
			{
				[`${"n".repeat(251)}.txt`]: "n\n",
				[`${deep}/${"q".repeat(126)}`]: "q\n",
				// What the folder takes under code/ alone: a device name, a colon, a percent sign.
				"con.txt": "c\n",
				"a:b.txt": "a\n",
				"100%.txt": "p\n",
			},
			true,
		);
		expect(fits.result.look).toMatchObject({ refused: { code: null, paths: [] }, fits: true, why: null });

		// A ref whose name has a part over 255 bytes (a header C2 builds may name one; `git bundle create` cannot): the
		// strict fetch cannot write it on the code host's disk, and the look refuses the history before the place is
		// touched. Words of damage for it are C1's to change (B.md).
		const h = new History();
		h.commit("refs/heads/master", { time: NOW_S - DAY, files: { "a.txt": "a\n" } });
		const plain = await bundled(f, await made(f, h));
		const end = plain.bytes.indexOf("\n\n") + 2;
		const long = Buffer.concat([
			Buffer.from(
				`# v2 git bundle\n${plain.raw.mainSha} refs/heads/master\n${plain.raw.mainSha} refs/tags/${"t".repeat(300)}\n\n`,
			),
			plain.bytes.subarray(end),
		]);
		const longRaw = { ...plain.raw, sha256: digest(long), bytes: long.length, refs: 2 };
		const refused = await looking(f, { bytes: long, raw: longRaw }).catch((error: unknown) => error);
		expect(refused).toBeInstanceOf(CodeHostRefusal);
		expect((refused as CodeHostRefusal).code).toMatch(/^IMPORT_HISTORY_DAMAGED/);
		expect(await exists(f.code)).toBe(false);
		expect(await readdir(f.scratchRoot)).toEqual([]);
	});

	it("refuses a history by git's own message id: old git objects as a warning, damage as damage, and none of git's words", async () => {
		const f = await fixture();
		/** A history whose one tree git's strict check refuses: its entries, around the id of a folder of one file. */
		const strange = async (entries: (folder: Buffer) => Buffer) => {
			const repo = join(f.root, `old-${randomUUID()}.git`);
			await f.git(["init", "--quiet", "--bare", repo]);
			const g = async (args: string[], input?: Uint8Array) =>
				(await f.git([`--git-dir=${repo}`, ...args], input)).toString("utf8").trim();
			const blob = await g(["hash-object", "-w", "--stdin"], Buffer.from("x\n"));
			const sub = await g(["mktree"], Buffer.from(`100644 blob ${blob}\tf\n`));
			const tree = await g(
				["hash-object", "-t", "tree", "--literally", "-w", "--stdin"],
				entries(Buffer.from(sub, "hex")),
			);
			const commit = await g(["commit-tree", tree, "-m", "old"]);
			await g(["update-ref", "refs/heads/master", commit]);
			const file = join(f.root, `${randomUUID()}.bundle`);
			await g(["bundle", "create", "--quiet", file, "--all"]);
			const bytes = await readFile(file);
			return {
				bytes,
				raw: {
					name: codeImportBundleName(CREATED, commit),
					sha256: digest(bytes),
					bytes: bytes.length,
					defaultBranch: "master",
					mainSha: commit,
					refs: 1,
					leftOut: 0,
				},
			};
		};
		const refusal = async (b: { bytes: Buffer; raw: CodeImportRaw }, job = f.job, options = {}) => {
			const error = await looking(f, b, { job, options }).catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(Error);
			return error as CodeHostRefusal & CodeHostJobFailure;
		};
		const old = await strange((folder) => Buffer.concat([Buffer.from("040000 d\0"), folder]));
		const warned = await refusal(old);
		expect(warned).toBeInstanceOf(CodeHostRefusal);
		expect(warned.code).toBe("IMPORT_HISTORY_ZERO_PADDED_FILEMODE");
		// Only the code: no object, no path, nothing git said.
		expect(warned.message).toBe("IMPORT_HISTORY_ZERO_PADDED_FILEMODE");
		expect(warned.paths).toEqual([]);
		expect(codeImportStopOf(warned)).toMatchObject({ end: "refused", code: "IMPORT_HISTORY_ZERO_PADDED_FILEMODE" });
		// Two entries of one name: an error to git, so damage.
		const twice = await strange((folder) =>
			Buffer.concat([Buffer.from("40000 d\0"), folder, Buffer.from("40000 d\0"), folder]),
		);
		const damaged = await refusal(twice);
		expect(damaged).toBeInstanceOf(CodeHostRefusal);
		expect(damaged.code).toMatch(/^IMPORT_HISTORY_DAMAGED_[A-Z_]+$/);
		expect(damaged.message).toBe(damaged.code);
		// A history the strict fetch takes and fsck does not: damage by fsck's own id, or none.
		const { h } = shop();
		const fine = await bundled(f, await made(f, h));
		const broken = await wrapped(
			f,
			'for a do [ "$a" = fsck ] && { echo "error in tree 0123456789abcdef0123456789abcdef01234567: badTree: secret-name.txt"; exit 4; }; done',
		);
		const fsckDamage = await refusal(fine, broken);
		expect(fsckDamage).toBeInstanceOf(CodeHostRefusal);
		expect(fsckDamage.message).toBe("IMPORT_HISTORY_DAMAGED_BAD_TREE");
		const mute = await wrapped(f, 'for a do [ "$a" = fsck ] && { echo "it broke"; exit 2; }; done');
		expect((await refusal(fine, mute)).message).toBe("IMPORT_HISTORY_DAMAGED");
		const slow = await wrapped(f, 'for a do [ "$a" = fsck ] && exec sleep 20; done');
		const stopped = await refusal(fine, slow, { fsckMs: 300 });
		expect(stopped).toBeInstanceOf(CodeHostJobFailure);
		expect(stopped.code).toBe("IMPORT_FSCK_TIMEOUT");
		expect(codeImportStopOf(stopped)).toMatchObject({ end: "failed", code: "IMPORT_FSCK_TIMEOUT" });
		expect(await readdir(f.scratchRoot)).toEqual([]);
	});

	it("scans for keys: each kind with its path and whether main holds it, and no value and no list of objects ever comes out", async () => {
		const f = await fixture(),
			h = new History();
		const letters = (count: number) =>
			randomBytes(count).toString("hex").toUpperCase().replace(/[0-9]/g, "Q").slice(0, count);
		const lower = (count: number) => randomBytes(count).toString("hex").replace(/[0-9]/g, "k").slice(0, count);
		// The key-like folder's name is a path, and paths do come out (main's tree is how the look checks names). Its
		// letters are none a planted value has (theirs are A to F and Q), so no 12 bytes of a value can stand in it by
		// chance: with the same letters, about 1 run in 600 drew a name that began as the AWS value does (`AKIA` and eight
		// Q, run 20261112T214649-84564-068d609b), and the check below took main's tree, which names it, for a leak.
		const unlike = (count: number) => [...randomBytes(count)].map((byte) => "GHJKLMNPRSTUVWXY"[byte % 16]).join("");
		const planted = {
			aws: `AKIA${letters(16)}`,
			github: `ghp_${lower(36)}`,
			stripe: `sk_live_${lower(24)}`,
			slack: `xoxb-${lower(24)}`,
			google: `AIza${lower(35)}`,
			"private-key": "-----BEGIN RSA PRIVATE KEY-----",
			resend: `re_${lower(10)}_${lower(24)}`,
			openai: `sk-proj-${lower(32)}`,
			anthropic: `sk-ant-api03-${lower(32)}`,
			history: `ASIA${letters(16)}`,
			newline: `rk_live_${lower(24)}`,
			pathKey: `AKIA${unlike(16)}`,
		};
		const filler = (index: number) => `line ${index} of plain text\n`;
		const first = h.commit("refs/heads/master", {
			time: NOW_S - 10 * DAY,
			files: {
				"old/leak.txt": `token=${planted.history}\n`,
				// git's plain object listing cuts this path at its line feed; the look shows it as null, never cut.
				"a\nb.txt": `${planted.newline}\n`,
				...Object.fromEntries(Array.from({ length: 300 }, (_, index) => [`many/f${index}.txt`, filler(index)])),
			},
		});
		h.commit("refs/heads/master", {
			time: NOW_S - 9 * DAY,
			from: first,
			deletes: ["old/leak.txt", "many", "a\nb.txt"],
			files: {
				"config/aws.txt": `key = ${planted.aws}\n`,
				"src/github.ts": `const token = "${planted.github}";\n`,
				"pay/stripe.js": `stripe(${JSON.stringify(planted.stripe)})\n`,
				"chat/slack.txt": `${planted.slack}\n`,
				"maps/google.js": `k="${planted.google}"`,
				"keys/id_rsa": `${planted["private-key"]}\nMIIEow\n-----END RSA PRIVATE KEY-----\n`,
				"mail/resend.ts": `const resend = '${planted.resend}';\n`,
				"ai/openai.py": `OPENAI = "${planted.openai}"\n`,
				"ai/anthropic.py": `ANTHROPIC = "${planted.anthropic}"\n`,
				".env": "MODE=dev\n",
				"web/.env.local": "PORT=3000\n",
				".env.example": "MODE=\n",
				[`${planted.pathKey}/notes.txt`]: `${planted.github}\n`,
				"README.md": "# no keys here\n",
			},
			// Links are no tracked .env and no LFS pointer.
			symlinks: { ".env.production": ".env.example", "logo.png": "version https://git-lfs.github.com/spec/v1" },
		});
		const source = await made(f, h),
			b = await bundled(f, source);
		const { result } = await looking(f, b);
		const look = lookOf(result);
		expect(look.fits).toBe(true);
		expect(look.secrets.shown).toEqual([
			{ kind: "aws", path: "config/aws.txt", inMain: true },
			{ kind: "github", path: "src/github.ts", inMain: true },
			{ kind: "github", path: null, inMain: true },
			{ kind: "stripe", path: "pay/stripe.js", inMain: true },
			{ kind: "slack", path: "chat/slack.txt", inMain: true },
			{ kind: "google", path: "maps/google.js", inMain: true },
			{ kind: "private-key", path: "keys/id_rsa", inMain: true },
			{ kind: "resend", path: "mail/resend.ts", inMain: true },
			{ kind: "openai", path: "ai/openai.py", inMain: true },
			{ kind: "anthropic", path: "ai/anthropic.py", inMain: true },
			{ kind: "env-file", path: ".env", inMain: true },
			{ kind: "env-file", path: "web/.env.local", inMain: true },
			{ kind: "aws", path: "old/leak.txt", inMain: false },
			{ kind: "stripe", path: null, inMain: false },
		]);
		expect(look.secrets.found).toBe(14);
		expect(look.secrets.scan.all).toBe(true);
		expect([...new Set(look.secrets.shown.map((hit) => hit.kind))].sort()).toEqual([...CODE_IMPORT_KEY_KINDS].sort());
		// The scan's own stdout: offsets and kinds alone.
		const scans = f.seen.filter(({ command }) => command.argv[2] === CODE_IMPORT_SCAN);
		expect(scans).toHaveLength(1);
		const said = (scans[0] as { result: CodeHostCommandResult }).result.stdout.toString("latin1");
		expect(said).toMatch(/^(\d+ [a-z-]+\n)+$/);
		const values = Object.values(planted);
		for (const value of values) {
			expect(said).not.toContain(value);
			for (let at = 0; at + 8 <= value.length; at += 1) expect(said).not.toContain(value.slice(at, at + 8));
		}
		// No command of the look handed out a value of a file, nor any part of one of 12 bytes (the key-like folder's
		// name is a path, and paths do come out).
		const contents = values.filter((value) => value !== planted.pathKey);
		// The fixture keeps it so: no 12 bytes of a value stand in the one path drawn at random, which does come out.
		for (const value of contents)
			for (let at = 0; at + 12 <= value.length; at += 1)
				expect(`${planted.pathKey}/notes.txt`).not.toContain(value.slice(at, at + 12));
		for (const { result: answered } of f.seen) {
			const text = answered.stdout.toString("latin1");
			for (const value of contents)
				for (let at = 0; at + 12 <= value.length; at += 1) expect(text).not.toContain(value.slice(at, at + 12));
		}
		// No list of every object came out: no blob of the history that is not hit was ever named to the executor.
		const main = await source.text(["rev-parse", "refs/heads/master"]);
		const all = await blobsOf(f, source.repo, [main]);
		const inMain = new Set(
			(await source.text(["ls-tree", "-r", main])).split("\n").map((line) => line.split(/\s+/)[2] as string),
		);
		const leaks = [
			await source.text(["rev-parse", `${source.sha(first)}:old/leak.txt`]),
			await source.text(["rev-parse", `${source.sha(first)}:a\nb.txt`]),
		];
		const unnamed = all.map((blob) => blob.oid).filter((oid) => !inMain.has(oid) && !leaks.includes(oid));
		expect(unnamed.length).toBeGreaterThan(250);
		for (const { result: answered } of f.seen) {
			const text = answered.stdout.toString("latin1");
			for (const oid of unnamed) expect(text).not.toContain(oid);
		}
		// The whole of what came out is small beside the history's lists.
		expect(f.seen.reduce((sum, { result: answered }) => sum + answered.stdout.length, 0)).toBeLessThan(64 * 1024);
	});

	it("says the scan was not whole: a blob of 1 MiB passed over, the bytes' bound reached, a scan stopped after its time", async () => {
		const f = await fixture();
		const key = `AKIA${"Z".repeat(16)}`;
		const h = new History();
		h.commit("refs/heads/master", {
			time: NOW_S - DAY,
			files: { "a.txt": `${key}\n`, "big.bin": Buffer.alloc(1024 * 1024, 0x61), "b.txt": "b\n" },
		});
		const big = await bundled(f, await made(f, h));
		expect(lookOf((await looking(f, big)).result).secrets).toMatchObject({
			found: 1,
			scan: { blobs: 2, all: false },
		});
		const small = new History();
		small.commit("refs/heads/master", {
			time: NOW_S - DAY,
			files: { "a.txt": `${key}\n`, "b.bin": Buffer.alloc(1024 * 1024 - 1, 0x61) },
		});
		const under = await bundled(f, await made(f, small));
		expect(lookOf((await looking(f, under)).result).secrets.scan).toMatchObject({ blobs: 2, all: true });
		// With a bound of 1 MiB: the first blobs that fit are read, the rest passed over.
		const bounded = lookOf((await looking(f, under, { options: { scanBytes: 1024 * 1024 } })).result).secrets;
		expect(bounded.scan.blobs).toBe(1);
		expect(bounded.scan.all).toBe(false);
		const exact = lookOf((await looking(f, under, { options: { scanBytes: 1024 * 1024 + 20 } })).result).secrets;
		expect(exact.scan).toMatchObject({ blobs: 2, bytes: 1024 * 1024 + 20, all: true });
		// A scan that does not end: stopped, and not whole. main has no small file for the LFS check, so the scan's is
		// the one `cat-file --batch`.
		const late = new History();
		late.commit("refs/heads/master", { time: NOW_S - DAY, files: { "a.txt": `${key}${"x".repeat(2000)}\n` } });
		const slow = await wrapped(f, 'for a do [ "$a" = --batch ] && exec sleep 30; done');
		const stopped = lookOf(
			(await looking(f, await bundled(f, await made(f, late)), { job: slow, options: { scanSeconds: 1 } })).result,
		);
		expect(stopped.secrets).toMatchObject({ found: 0, scan: { blobs: 1, all: false } });
		expect(stopped.fits).toBe(true);
	});

	it("before the look: dead scratch removed, room for five bundles, and the bundle's own bytes only", async () => {
		const f = await fixture(),
			{ h } = shop(),
			b = await bundled(f, await made(f, h));
		// What jobs that never reached their cleanup left.
		await mkdir(join(f.scratchRoot, randomUUID(), "proof.git"), { recursive: true });
		await writeFile(join(f.scratchRoot, randomUUID()), "x");
		await looking(f, b);
		expect(await readdir(f.scratchRoot)).toEqual([]);
		const sweep = f.log.findIndex((command) => command.argv[2]?.includes("-exec rm -rf"));
		// The job's own scratch is made, then the sweep runs: before anything else.
		expect(sweep).toBe(1);
		expect(f.log[sweep]?.argv.slice(4, 6)).toEqual([f.scratchRoot, f.log[0]?.argv.at(-1)?.split("/").at(-1)]);

		let taken = 0;
		const room = await looking(
			f,
			{ ...b, raw: { ...b.raw, bytes: 2 ** 44 } },
			{
				source: (async function* () {
					taken += 1;
					yield b.bytes;
				})(),
			},
		).catch((error: unknown) => error);
		expect(room).toMatchObject({ code: "IMPORT_NO_SPACE" });
		expect(codeImportStopOf(room)).toMatchObject({ end: "failed", code: "IMPORT_NO_SPACE" });
		expect(taken).toBe(0);
		const changed = Buffer.from(b.bytes);
		changed[changed.length - 1] ^= 1;
		for (const bytes of [
			changed,
			b.bytes.subarray(0, b.bytes.length - 1),
			Buffer.concat([b.bytes, Buffer.from("x")]),
		])
			await expect(looking(f, { bytes, raw: b.raw })).rejects.toMatchObject({
				code: "CODE_HOST_IMPORT_BUNDLE_DIFFERS",
			});
		await expect(
			looking(f, b, {
				source: (async function* () {
					yield b.bytes.subarray(0, 100);
					throw new Error("CODE_BUNDLE_STORE_TIMEOUT");
				})(),
			}),
		).rejects.toThrow("CODE_BUNDLE_STORE_TIMEOUT");
		// A stream that does not end is not read past the bundle's bytes and one.
		await expect(
			looking(f, b, {
				source: (async function* () {
					yield b.bytes;
					for (;;) yield Buffer.alloc(64 * 1024);
				})(),
			}),
		).rejects.toMatchObject({ code: "CODE_HOST_IMPORT_BUNDLE_DIFFERS" });
		// A first bundle that needs commits it does not hold: refused as history git cannot take.
		const source = await made(f, shop().h);
		const thin = await bundled(f, source, "master", ["master", `^${await source.text(["rev-parse", "master~2"])}`]);
		const refused = await looking(f, thin).catch((error: unknown) => error);
		expect(refused).toBeInstanceOf(CodeHostRefusal);
		expect((refused as CodeHostRefusal).code).toMatch(/^IMPORT_HISTORY_DAMAGED/);
		// A restore-shaped bundle that does not restore every ref is never read out.
		const cut = await wrapped(
			f,
			`for a do [ "$a" = create ] && { "${GIT}" "$@" || exit 1; for p do case $p in *.bundle) n=$(wc -c <"$p"); head -c $((n - 64)) "$p" >"$p.cut" && mv -f -- "$p.cut" "$p";; esac; done; exit 0; }; done`,
		);
		const sunk: Buffer[] = [];
		await expect(
			lookCodeImport(cut, { repository: kept, raw: b.raw, look: false, now: NOW }, pieces(b.bytes), {
				write: async (chunk) => {
					sunk.push(Buffer.from(chunk));
				},
			}),
		).rejects.toMatchObject({ code: "CODE_HOST_BUNDLE_FAILED" });
		expect(sunk).toEqual([]);
		expect(await readdir(f.scratchRoot)).toEqual([]);
	});
});

describe("code host: an import's file source, read (own code storage, step 6, part B)", { timeout: 120_000 }, () => {
	/** A bundle put where an agent puts one. */
	async function placed(f: Fixture, bytes: Uint8Array, path = "code/_incoming/shop/shop.bundle") {
		await mkdir(dirname(join(f.companyRoot, path)), { recursive: true });
		await writeFile(join(f.companyRoot, path), bytes);
		return path;
	}
	const read = (
		f: Fixture,
		path: string,
		sha256: string,
		more: Partial<{ branch: string | null; maximumBytes: number }> = {},
	) => {
		const out: Buffer[] = [];
		return readIncomingCodeBundle(
			f.job,
			{
				repository: kept,
				path,
				sha256,
				branch: more.branch ?? null,
				maximumBytes: more.maximumBytes ?? 1024 ** 3,
			},
			{
				write: async (chunk, signal) => {
					expect(signal).toBe(f.job.signal);
					out.push(Buffer.from(chunk));
				},
			},
		).then((answer) => ({ answer, out }));
	};
	const refused = async (promise: Promise<unknown>, code: string) => {
		const error = await promise.catch((caught: unknown) => caught);
		expect(codeImportStopOf(error)).toMatchObject({ end: "refused", code });
		expect((error as Error).message).toBe(code);
	};

	it("reads a file source out whole, in 16 MiB pieces, with its default branch and refs", async () => {
		const f = await fixture(),
			{ h } = shop();
		h.commit("refs/heads/master", { time: NOW_S - 1, files: { "data.bin": randomBytes(20 * 1024 ** 2) } });
		const source = await made(f, h),
			b = await bundled(f, source);
		const path = await placed(f, b.bytes);
		const before = await f.listing(f.companyRoot);
		const { answer, out } = await read(f, path, digest(b.bytes));
		expect(out.map((piece) => piece.length)).toEqual([16 * 1024 ** 2, b.bytes.length - 16 * 1024 ** 2]);
		expect(Buffer.concat(out).equals(b.bytes)).toBe(true);
		const heads = (await source.text(["for-each-ref", "--format=%(objectname) %(refname)"]))
			.split("\n")
			.map((line) => ({ name: line.slice(41), sha: line.slice(0, 40) }));
		expect(answer).toEqual({
			sha256: digest(b.bytes),
			bytes: b.bytes.length,
			defaultBranch: "master",
			mainSha: await source.text(["rev-parse", "master"]),
			refs: heads,
			leftOut: 0,
		});
		expect(await f.listing(f.companyRoot)).toEqual(before);
		expect(await readdir(f.scratchRoot)).toEqual([]);
		// Not a job's values: refused before any command.
		const commands = f.log.length;
		const value = { repository: kept, path, sha256: digest(b.bytes), branch: null, maximumBytes: 1024 };
		const sink = { write: async () => {} };
		for (const bad of [
			() => readIncomingCodeBundle(f.job, { ...value, repository: { ...kept, host: "github.com" } }, sink),
			() => readIncomingCodeBundle(f.job, { ...value, path: "code/_incoming/../x.bundle" }, sink),
			() => readIncomingCodeBundle(f.job, { ...value, path: "code/acme/shop/x.bundle" }, sink),
			() => readIncomingCodeBundle(f.job, { ...value, sha256: "x" }, sink),
			() => readIncomingCodeBundle(f.job, { ...value, branch: 1 as never }, sink),
			() => readIncomingCodeBundle(f.job, { ...value, maximumBytes: 0 }, sink),
			() => readIncomingCodeBundle(f.job, { ...value, maximumBytes: 2 * 1024 ** 3 + 1 }, sink),
			() => readIncomingCodeBundle(f.job, { ...value, more: 1 } as never, sink),
			() => readIncomingCodeBundle(f.job, value, {} as never),
		])
			await expect(bad()).rejects.toThrow("INVALID_CODE_HOST_JOB");
		expect(f.log).toHaveLength(commands);
	});

	it("chooses the default branch: the one asked for, the only head, main, master, the one head at HEAD", async () => {
		const f = await fixture();
		const choose = async (heads: string[], head: string, branch: string | null = null, at = heads) => {
			const h = new History();
			const root = h.commit(`refs/heads/${heads[0]}`, { time: NOW_S - DAY, files: { "a.txt": "a\n" } });
			const other = h.commit("refs/heads/_other", {
				time: NOW_S - DAY + 1,
				from: root,
				files: { "b.txt": "b\n" },
			});
			for (const name of heads.slice(1)) h.reset(`refs/heads/${name}`, at.includes(name) ? other : root);
			const source = await made(f, h, `refs/heads/${head}`);
			await source.git(["update-ref", "-d", "refs/heads/_other"]);
			const b = await bundled(f, source, heads[0]);
			const path = await placed(f, b.bytes, `code/_incoming/${randomUUID()}/x.bundle`);
			return read(f, path, digest(b.bytes), { branch });
		};
		expect((await choose(["trunk"], "trunk")).answer.defaultBranch).toBe("trunk");
		expect((await choose(["dev", "main"], "dev")).answer.defaultBranch).toBe("main");
		expect((await choose(["dev", "master"], "dev")).answer.defaultBranch).toBe("master");
		expect((await choose(["dev", "main", "master"], "dev")).answer.defaultBranch).toBe("main");
		expect((await choose(["dev", "main"], "dev", "dev")).answer.defaultBranch).toBe("dev");
		// HEAD's commit is one head's alone (`b` is at another commit than `a`).
		expect((await choose(["a", "b"], "b", null, ["b"])).answer.defaultBranch).toBe("b");
		await refused(choose(["a", "b", "c"], "b", null, ["b", "c"]), "IMPORT_BRANCH_UNKNOWN");
		await refused(choose(["dev", "main"], "dev", "gone"), "IMPORT_BRANCH_UNKNOWN");
		// The file's own default by the same rule, beside a branch the request named (the lead's call 6a): only then,
		// only when it is another, and only when the file has a clear one.
		expect((await choose(["dev", "main"], "dev", "dev")).answer).toMatchObject({
			defaultBranch: "dev",
			sourceBranch: "main",
		});
		expect((await choose(["dev", "main"], "dev")).answer).not.toHaveProperty("sourceBranch");
		expect((await choose(["dev", "main"], "dev", "main")).answer).not.toHaveProperty("sourceBranch");
		expect((await choose(["a", "b", "c"], "b", "a", ["b", "c"])).answer).not.toHaveProperty("sourceBranch");
		await refused(
			choose(["ghp_0123456789abcdefghijABCDEFGHIJ012345"], "ghp_0123456789abcdefghijABCDEFGHIJ012345"),
			"IMPORT_BRANCH_NAME",
		);
	});

	it("refuses a file that is not the one asked for, not whole, not a bundle or too large", async () => {
		const f = await fixture(),
			{ h, marks } = shop(),
			source = await made(f, h),
			b = await bundled(f, source);
		const path = await placed(f, b.bytes);
		// Another file than the request's, or none.
		await refused(read(f, path, digest("another")), "IMPORT_FILE_CHANGED");
		await refused(read(f, "code/_incoming/shop/gone.bundle", digest(b.bytes)), "IMPORT_FILE_CHANGED");
		// A link in the file's place, or on the way to it.
		await symlink(join(f.companyRoot, path), join(f.companyRoot, "code/_incoming/shop/link.bundle"));
		await refused(read(f, "code/_incoming/shop/link.bundle", digest(b.bytes)), "IMPORT_FILE_CHANGED");
		await symlink(join(f.companyRoot, "code/_incoming/shop"), join(f.companyRoot, "code/_incoming/linked"));
		await refused(read(f, "code/_incoming/linked/shop.bundle", digest(b.bytes)), "IMPORT_FILE_CHANGED");
		// Over the request's bound.
		await refused(read(f, path, digest(b.bytes), { maximumBytes: b.bytes.length - 1 }), "IMPORT_TOO_LARGE");
		expect((await read(f, path, digest(b.bytes), { maximumBytes: b.bytes.length })).answer.bytes).toBe(
			b.bytes.length,
		);
		// One that needs commits it does not hold.
		const thin = join(f.root, "thin.bundle");
		await source.git(["bundle", "create", "--quiet", thin, "master", `^${source.sha(marks.c6)}`]);
		const thinBytes = await readFile(thin);
		await refused(
			read(f, await placed(f, thinBytes, "code/_incoming/thin/a.bundle"), digest(thinBytes)),
			"IMPORT_FILE_NOT_WHOLE",
		);
		// No bundle at all.
		const zip = Buffer.from("PK\u0003\u0004 not a bundle\n\n");
		await refused(read(f, await placed(f, zip, "code/_incoming/zip/a.bundle"), digest(zip)), "IMPORT_FILE_NOT_WHOLE");
		// A bundle that leaves objects out by a filter (v3's `@filter`; git 2.53's `bundle create` makes none, so by hand).
		const filteredBytes = Buffer.concat([
			Buffer.from(
				`# v3 git bundle\n@object-format=sha1\n@filter=blob:none\n${source.sha(marks.c7)} refs/heads/master\n\n`,
			),
			b.bytes.subarray(b.bytes.indexOf("\n\n") + 2),
		]);
		await refused(
			read(f, await placed(f, filteredBytes, "code/_incoming/filter/a.bundle"), digest(filteredBytes)),
			"IMPORT_FILE_NOT_WHOLE",
		);
		// A ref name git does not take, one named twice, one outside refs/.
		const main = source.sha(marks.c7);
		for (const [folder, lines] of [
			["name", `${main} refs/heads/a..b\n`],
			["twice", `${main} refs/heads/master\n${main} refs/heads/master\n`],
			["outside", `${main} refs/heads/master\n${main} heads/x\n`],
		]) {
			const header = Buffer.from(`# v2 git bundle\n${lines}\n`);
			await refused(
				read(f, await placed(f, header, `code/_incoming/${folder}/a.bundle`), digest(header)),
				"IMPORT_FILE_NOT_WHOLE",
			);
		}
		// More than a folder file can be, whatever the request's bound: refused before it is copied.
		const huge = await placed(f, Buffer.alloc(0), "code/_incoming/huge/a.bundle");
		await truncate(join(f.companyRoot, huge), 256 * 1024 ** 2 + 1);
		await refused(read(f, huge, digest("")), "IMPORT_TOO_LARGE");
		// A repository of SHA-256 object names.
		const wide = join(f.root, "wide");
		await f.git(["init", "--quiet", "--object-format=sha256", "--initial-branch=main", wide]);
		await writeFile(join(wide, "a.txt"), "a\n");
		await f.git(["-C", wide, "add", "a.txt"]);
		await f.git(["-C", wide, "commit", "--quiet", "-m", "a"]);
		await f.git(["-C", wide, "bundle", "create", "--quiet", join(f.root, "wide.bundle"), "--all"]);
		const wideBytes = await readFile(join(f.root, "wide.bundle"));
		await refused(
			read(f, await placed(f, wideBytes, "code/_incoming/wide/a.bundle"), digest(wideBytes)),
			"IMPORT_SHA256_REPOSITORY",
		);
		expect(await readdir(f.scratchRoot)).toEqual([]);
	});
});

describe("code host: the import's shell, as the image runs it", () => {
	it("matches decimal numbers below a bound, and only those", () => {
		const pattern = new RegExp(`^(${codeImportBelow(1024 * 1024)})$`);
		for (const yes of ["0", "7", "10", "999999", "1000000", "1039999", "1048000", "1048569", "1048575"])
			expect(pattern.test(yes)).toBe(true);
		// git prints no leading zero, and a number written with one is no size of its.
		for (const no of [
			"1048576",
			"1048577",
			"1048580",
			"1049000",
			"1100000",
			"2000000",
			"10000000",
			"0999999",
			"0123456",
			"01",
			"-1",
			"",
		])
			expect(pattern.test(no)).toBe(false);
		// Every bound to 12,000, at its edge and at the edges of each length of number.
		for (let bound = 2; bound <= 12_000; bound += 1) {
			const below = new RegExp(`^(${codeImportBelow(bound)})$`);
			for (const n of [0, 1, 9, 10, 11, 99, 100, 101, 999, 1000, 1001, 9999, 10_000, 10_001, 12_001])
				if (below.test(String(n)) !== n < bound) expect({ bound, n }).toBe("below the bound exactly");
			for (const padded of ["00", "01", "09", "010", "0999", "01000"])
				if (below.test(padded)) expect({ bound, padded }).toBe("never a number with a leading zero");
			for (let n = Math.max(0, bound - 12); n < bound + 12; n += 1)
				if (below.test(String(n)) !== n < bound) expect({ bound, n }).toBe("below the bound exactly");
		}
		expect(() => codeImportBelow(1)).toThrow("INVALID_CODE_IMPORT");
	});

	it("the code host image's proof runs C1's scan as it is", async () => {
		const proof = await readFile(join(HERE, "../../../deploy/code-host/test/prove-in-code-host.sh"), "utf8");
		expect(proof).toContain(`<<'SCAN'\n${CODE_IMPORT_SCAN}\nSCAN\n`);
	});

	it("runs a command of the measure within its time, and hands out what it said only within its bound", async () => {
		const dir = await realpath(await mkdtemp(join(tmpdir(), "code-host-measure-")));
		roots.push(dir);
		const measure = (seconds: number, bound: number, argv: string[], input = "") =>
			new Promise<{ status: number | null; stdout: string }>((resolve, reject) => {
				const child = spawn(
					"/bin/sh",
					[
						"-c",
						CODE_HOST_IMPORT_MEASURE,
						"sh",
						String(seconds),
						String(bound),
						`${dir}/out`,
						`${dir}/status`,
						...argv,
					],
					{ env: { PATH: "/usr/local/bin:/usr/bin:/bin", LC_ALL: "C" }, stdio: ["pipe", "pipe", "ignore"] },
				);
				const out: Buffer[] = [];
				child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
				child.on("error", reject);
				child.on("close", (status) => resolve({ status, stdout: Buffer.concat(out).toString("latin1") }));
				child.stdin.end(input);
			});
		expect(await measure(300, 5, ["printf", "abcde"])).toEqual({ status: 0, stdout: "ok\nabcde" });
		expect(await measure(300, 4, ["printf", "abcde"])).toEqual({ status: 0, stdout: "over\n" });
		expect(await measure(300, 0, ["printf", ""])).toEqual({ status: 0, stdout: "ok\n" });
		expect(await measure(300, 64, ["cat"], "x\0y\n")).toEqual({ status: 0, stdout: "ok\nx\0y\n" });
		// A command that did not end well: its status, and nothing it said.
		expect(await measure(300, 64, ["/bin/sh", "-c", "printf ab; exit 7"])).toEqual({ status: 7, stdout: "" });
		const started = Date.now();
		expect(await measure(1, 64, ["sleep", "30"])).toEqual({ status: 124, stdout: "" });
		expect(Date.now() - started).toBeLessThan(15_000);
	});

	it("the code host image's proof runs the measure's script as it is", async () => {
		const proof = await readFile(join(HERE, "../../../deploy/code-host/test/prove-in-code-host.sh"), "utf8");
		expect(proof).toContain(`<<'MEASURE'\n${CODE_HOST_IMPORT_MEASURE}\nMEASURE\n`);
	});

	it("reads a progress at each of the import's steps, the runtime's list, and refuses a step not in it", () => {
		expect(CODE_IMPORT_STEPS).toEqual(["fetch", "read", "look", "close", "set-aside", "build", "open"]);
		for (const step of CODE_IMPORT_STEPS) expect(codeImportProgressOf({ step })).toEqual({ step });
		for (const step of ["later", "", 1, null])
			expect(() => codeImportProgressOf({ step }), String(step)).toThrow("INVALID_CODE_IMPORT_PROGRESS");
	});
});
