import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CloudCodingRepository, isSurfaceRepositorySubpath } from "@qorpera/contracts";
import {
	CODE_AREA_IN_QORPERA_REF,
	type CodeHostJob,
	CodeHostJobFailure,
	CodeHostRefusal,
	closed,
	keptRepositoryOf,
	MAX_LISTING,
	type Run,
	SHA,
	withJob,
} from "./code-host-jobs.ts";
import {
	CODE_SITE_MAX_FOLDERS,
	type CodeSiteProblem,
	codeSiteFolderValid,
	codeSiteManifest,
	codeSiteTreeProblem,
} from "./code-site.ts";
import { parseCodingJson } from "./coding-setup.ts";
import { isNativeServableSitePath, NATIVE_SITE_MAX_FILES, nativeSiteTreeProblem } from "./site-blob-upload.ts";
import { readSurfacePreviewRecipe, type SurfacePreviewPlan } from "./surface-preview-runner.ts";

/** A repository's website as the code host reads it (own code storage, step 4, part B; STEP4-RELEASES-PLAN.md 8.2).
 * Once a change's checks passed, the executor's collect writes the web files of the folder the checks file names into
 * the repository's storage as git objects, one tree of them that no ref names, and the change's row keeps the tree's
 * id. The upload pass reads that tree here, by git and never from a worktree, to put it into the site tables as a
 * version. */

/** One file of a site tree: its path in the site, its size, the SHA-256 of its bytes, and the bytes. */
export interface CodeSiteTreeFile {
	readonly path: string;
	readonly bytes: number;
	readonly sha256: string;
	readonly content: Uint8Array;
}

/** A site tree that breaks the site's rules (`codeSiteTreeProblem`), naming the problem and its path. */
export class CodeSiteTreeInvalid extends CodeHostRefusal {
	readonly problem: CodeSiteProblem;
	constructor(problem: CodeSiteProblem) {
		super("CODE_HOST_SITE_TREE_INVALID", problem.path === null ? [] : [problem.path]);
		this.name = "CodeSiteTreeInvalid";
		this.message = `CODE_HOST_SITE_TREE_INVALID: ${problem.code}${problem.path === null ? "" : ` ${problem.path}`}`;
		this.problem = problem;
	}
}

const READ_FAILED = "CODE_HOST_SITE_READ_FAILED";

/** Objects of one kind, each read whole once by one `cat-file --batch` (`<id> <kind> <size>\n<bytes>\n` each), and each
 * proven to be its id's: git's id is the SHA-1 of `<kind> <size>\0<bytes>`, which cat-file never checks and ls-tree
 * checks only for the tree it is named (not the folders below it), while a session may write a loose object under any
 * name (care's repack then carries it into a pack as it is) and the collect skips an object the repository already has
 * by its name. The hash is taken here, over the bytes this read answered, so no object of the repository's can vouch
 * for itself. `named` gives an id's path for the words. */
async function readObjects(
	run: Run,
	kind: "tree" | "blob",
	ids: readonly string[],
	maximumOutputBytes: number,
	named: (id: string) => string,
): Promise<Map<string, Buffer>> {
	const out = await run.gitOk(run.repo, ["cat-file", "--batch"], READ_FAILED, {
		stdin: Buffer.from(ids.map((id) => `${id}\n`).join("")),
		maximumOutputBytes,
	});
	const read = new Map<string, Buffer>();
	let at = 0;
	for (const id of ids) {
		const end = out.indexOf(0x0a, at),
			head = end < 0 ? "" : out.toString("latin1", at, end),
			size = head.startsWith(`${id} ${kind} `) ? head.slice(id.length + kind.length + 2) : "";
		if (!/^\d{1,10}$/.test(size))
			throw new CodeHostJobFailure(
				READ_FAILED,
				`${named(id)}: ${kind === "tree" ? "its folder" : "its file version"} is not here`,
			);
		const start = end + 1,
			stop = start + Number(size);
		if (stop >= out.length || out[stop] !== 0x0a)
			throw new CodeHostJobFailure(READ_FAILED, "cat-file's answer is not git's");
		const bytes = out.subarray(start, stop);
		if (createHash("sha1").update(`${kind} ${size}\0`).update(bytes).digest("hex") !== id)
			throw new CodeHostJobFailure(
				READ_FAILED,
				`${id}: its bytes are not the ${kind === "tree" ? "folder's" : "file version's"}`,
			);
		read.set(id, bytes);
		at = stop + 1;
	}
	if (at !== out.length) throw new CodeHostJobFailure(READ_FAILED, "cat-file's answer is not git's");
	return read;
}

/** One site tree of a repository kept in Qorpera, read by git and never from a worktree, whether or not a ref reaches
 * it: the tree's type (`cat-file --batch-check`); then its folders a level at a time, each level's trees read and proven
 * by `readObjects` and their entries taken from exactly those bytes (never `ls-tree`, which reads the folders below the
 * top without checking them); the files' sizes (`cat-file --batch-check`); then one `cat-file --batch` over its file
 * versions (each once, however many paths share it), each proven the same way. So every byte answered is the tree's,
 * as its id fixes it. The files come in C order with each one's SHA-256, and the manifest over them. Refused:
 * `CODE_HOST_SITE_TREE_UNKNOWN` when the repository has no tree of that id (nothing of that id, or an object of another
 * kind), `CODE_HOST_SITE_TREE_INVALID` (`CodeSiteTreeInvalid`) when the tree breaks the site's rules, found on its
 * entries before any file is read (more folders than a site may have, found while they are walked: at most 100 trees
 * are read below the top); and as every step 2b job, a place a restore works on, one not seeded, and a GitHub copy. A
 * command that failed, a file version or folder the tree names that is not there, and an object whose bytes are not its
 * id's: `CodeHostJobFailure` `CODE_HOST_SITE_READ_FAILED`. */
export async function readCodeSiteTree(
	job: CodeHostJob,
	value: { repository: CloudCodingRepository; tree: string },
): Promise<{ files: CodeSiteTreeFile[]; manifestSha256: string }> {
	const input = closed(value, ["repository", "tree"]);
	const repository = keptRepositoryOf(input.repository),
		tree = input.tree;
	if (typeof tree !== "string" || !SHA.test(tree)) throw new Error("INVALID_CODE_HOST_JOB");
	return withJob(job, repository, async (run) => {
		// The place as the step 2b jobs take it, without the default branch: the tree is read by its id alone.
		if (job.preparedKeptArea !== run.area) {
			if (!(await run.prepare(undefined, { readOnly: true })).seeded)
				throw new CodeHostRefusal("CODE_HOST_NOT_SEEDED", [run.area]);
			if ((await run.ref(CODE_AREA_IN_QORPERA_REF)) === null)
				throw new CodeHostRefusal("CODE_HOST_AREA_FROM_GITHUB", [run.area]);
		}
		// git answers `missing` for an object it does not have and fails only when it cannot look.
		const kind = (
			await run.gitOk(run.repo, ["cat-file", "--batch-check"], READ_FAILED, { stdin: Buffer.from(`${tree}\n`) })
		).toString("latin1");
		if (kind !== `${tree} missing\n` && !/^[0-9a-f]{40} [a-z]+ \d+\n$/.test(kind))
			throw new CodeHostJobFailure(READ_FAILED, "cat-file's line is not git's");
		if (!kind.startsWith(`${tree} tree `)) throw new CodeHostRefusal("CODE_HOST_SITE_TREE_UNKNOWN", [tree]);
		// The folders, a level at a time. A tree's entries are `<mode> <name>\0<20-byte id>`; a folder's mode is 40000.
		const entries: { mode: string; type: string; name: string; path: string; bytes: number }[] = [];
		let level = [{ id: tree, path: "" }],
			folders = 0;
		while (level.length) {
			const paths = new Map(level.map((folder) => [folder.id, folder.path || tree]));
			const trees = await readObjects(run, "tree", [...paths.keys()], MAX_LISTING, (id) => paths.get(id) ?? id);
			const next: typeof level = [];
			for (const folder of level) {
				const bytes = trees.get(folder.id) as Buffer;
				for (let at = 0; at < bytes.length; ) {
					const space = bytes.indexOf(0x20, at),
						end = space < 0 ? -1 : bytes.indexOf(0, space + 1);
					if (end < 0 || end + 21 > bytes.length)
						throw new CodeHostJobFailure(READ_FAILED, `${folder.path || tree}: its entries are not git's`);
					const mode = bytes.toString("latin1", at, space),
						name = bytes.subarray(space + 1, end).toString("utf8"),
						id = bytes.toString("hex", end + 1, end + 21),
						path = folder.path ? `${folder.path}/${name}` : name;
					at = end + 21;
					// A regular file is a blob of its mode; anything else (a link, a submodule) the rules refuse by its mode.
					if (mode === "40000") next.push({ id, path });
					else
						entries.push({
							mode,
							type: mode === "100644" || mode === "100755" ? "blob" : "other",
							name: id,
							path,
							bytes: 0,
						});
				}
			}
			// A site has at most 100 folders below its top: no more trees are read than that.
			folders += next.length;
			if (folders > CODE_SITE_MAX_FOLDERS)
				throw new CodeSiteTreeInvalid({ code: "SITE_TOO_MANY_FOLDERS", path: null, variable: null });
			level = next;
		}
		// C order, as the manifest and the site's rules take them (a refused path may be any bytes).
		entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
		// The files' sizes, for the rules, before any is read: git answers `missing` for a file version it does not have.
		const blobs = entries.filter((entry) => entry.type === "blob");
		if (blobs.length) {
			const sized = (
				await run.gitOk(run.repo, ["cat-file", "--batch-check"], READ_FAILED, {
					stdin: Buffer.from(blobs.map((entry) => `${entry.name}\n`).join("")),
					maximumOutputBytes: MAX_LISTING,
				})
			)
				.toString("latin1")
				.split("\n");
			if (sized.pop() !== "" || sized.length !== blobs.length)
				throw new CodeHostJobFailure(READ_FAILED, "cat-file's lines are not git's");
			blobs.forEach((entry, index) => {
				const size = (sized[index] as string).startsWith(`${entry.name} blob `)
					? (sized[index] as string).slice(entry.name.length + 6)
					: "";
				if (!/^\d{1,10}$/.test(size))
					throw new CodeHostJobFailure(READ_FAILED, `${entry.path}: its file version is not here`);
				entry.bytes = Number(size);
			});
		}
		const problem = codeSiteTreeProblem(entries);
		if (problem) throw new CodeSiteTreeInvalid(problem);
		// Each file version once; its size is proven with its bytes, since the id covers both.
		const versions = [...new Map(entries.map((entry) => [entry.name, entry.bytes])).entries()],
			length = versions.reduce((sum, [name, bytes]) => sum + `${name} blob ${bytes}\n`.length + bytes + 1, 0);
		const read = await readObjects(
			run,
			"blob",
			versions.map(([name]) => name),
			length,
			(id) => id,
		);
		const digests = new Map(
			[...read].map(([name, bytes]) => [name, createHash("sha256").update(bytes).digest("hex")]),
		);
		const files = entries.map(({ name, path, bytes }): CodeSiteTreeFile => {
			const content = read.get(name) as Buffer;
			return {
				path,
				bytes,
				sha256: digests.get(name) as string,
				content: new Uint8Array(content.buffer, content.byteOffset, content.length),
			};
		});
		return { files, manifestSha256: codeSiteManifest(files) };
	});
}

const SURFACE_SITE_FALLBACK_FOLDERS = ["dist", "build", "out", "public"] as const;
const SURFACE_SKIP_DIRS = new Set(["node_modules", "vendor", "target", "coverage", "__pycache__"]);
const SURFACE_ROOT_CONFIG_FILES = new Set([
	"package.json",
	"package-lock.json",
	"tsconfig.json",
	"jsconfig.json",
	"biome.json",
	"biome.jsonc",
	"eslint.config.js",
	"eslint.config.mjs",
	"eslint.config.cjs",
	"vite.config.js",
	"vite.config.mjs",
	"vite.config.cjs",
	"vitest.config.js",
	"vitest.config.mjs",
	"vitest.config.cjs",
	"webpack.config.js",
	"webpack.config.mjs",
	"webpack.config.cjs",
	"rollup.config.js",
	"rollup.config.mjs",
	"postcss.config.js",
	"postcss.config.mjs",
	"postcss.config.cjs",
	"tailwind.config.js",
	"tailwind.config.mjs",
	"tailwind.config.cjs",
	"next.config.js",
	"next.config.mjs",
	"next.config.cjs",
]);
const SURFACE_TSCONFIG_FILE = /^tsconfig\.[^/]+\.json$/i;
const MAX_SURFACE_CHECKS_BYTES = 64 * 1024;
const MAX_SURFACE_WALK_FOLDERS = NATIVE_SITE_MAX_FILES;

interface ParsedGitTreeEntry {
	readonly mode: string;
	readonly name: string;
	readonly id: string;
}

function parseGitTreeEntries(bytes: Buffer, label: string): ParsedGitTreeEntry[] {
	const parsed: ParsedGitTreeEntry[] = [];
	for (let at = 0; at < bytes.length; ) {
		const space = bytes.indexOf(0x20, at),
			end = space < 0 ? -1 : bytes.indexOf(0, space + 1);
		if (end < 0 || end + 21 > bytes.length)
			throw new CodeHostJobFailure(READ_FAILED, `${label}: its entries are not git's`);
		parsed.push({
			mode: bytes.toString("latin1", at, space),
			name: bytes.subarray(space + 1, end).toString("utf8"),
			id: bytes.toString("hex", end + 1, end + 21),
		});
		at = end + 21;
	}
	return parsed;
}

function isRegularBlobMode(mode: string): boolean {
	return mode === "100644" || mode === "100755";
}

function hasIndexHtml(entries: readonly ParsedGitTreeEntry[]): boolean {
	return entries.some((entry) => entry.name === "index.html" && isRegularBlobMode(entry.mode));
}

async function resolveTreeFolder(run: Run, rootTreeId: string, folder: string): Promise<string | null> {
	let currentId = rootTreeId;
	let currentLabel = rootTreeId;
	for (const segment of folder.split("/")) {
		const trees = await readObjects(run, "tree", [currentId], MAX_LISTING, () => currentLabel);
		const entries = parseGitTreeEntries(trees.get(currentId) as Buffer, currentLabel);
		const match = entries.find((entry) => entry.mode === "40000" && entry.name === segment);
		if (!match) return null;
		currentId = match.id;
		currentLabel = currentLabel === rootTreeId ? segment : `${currentLabel}/${segment}`;
	}
	return currentId;
}

async function readSurfaceChecksText(run: Run, rootEntries: readonly ParsedGitTreeEntry[]): Promise<string | null> {
	const qorperaDir = rootEntries.find((entry) => entry.mode === "40000" && entry.name === ".qorpera");
	if (!qorperaDir) return null;
	const dirTrees = await readObjects(run, "tree", [qorperaDir.id], MAX_LISTING, () => ".qorpera");
	const dirEntries = parseGitTreeEntries(dirTrees.get(qorperaDir.id) as Buffer, ".qorpera");
	const checksEntry = dirEntries.find((entry) => entry.name === "checks.json" && isRegularBlobMode(entry.mode));
	if (!checksEntry) return null;
	const meta = (
		await run.gitOk(run.repo, ["cat-file", "--batch-check"], READ_FAILED, {
			stdin: Buffer.from(`${checksEntry.id}\n`),
		})
	).toString("latin1");
	const sizeText = meta.startsWith(`${checksEntry.id} blob `) ? meta.slice(checksEntry.id.length + 6).trim() : "";
	if (!/^\d{1,10}$/.test(sizeText)) return null;
	const size = Number(sizeText);
	if (size <= 0 || size > MAX_SURFACE_CHECKS_BYTES) return null;
	const blobs = await readObjects(
		run,
		"blob",
		[checksEntry.id],
		`${checksEntry.id} blob ${size}\n`.length + size + 1,
		() => ".qorpera/checks.json",
	);
	return (blobs.get(checksEntry.id) as Buffer).toString("utf8");
}

function parseChecksSiteFolder(text: string | null): string | null {
	if (text === null) return null;
	let parsed: unknown;
	try {
		parsed = parseCodingJson(text, false);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	const site = (parsed as { site?: unknown }).site;
	if (!site || typeof site !== "object" || Array.isArray(site)) return null;
	const folder = (site as { folder?: unknown }).folder;
	if (typeof folder !== "string") return null;
	const trimmed = folder.trim();
	return codeSiteFolderValid(trimmed) ? trimmed : null;
}

async function resolveFallbackWebTree(
	run: Run,
	entries: readonly ParsedGitTreeEntry[],
	labelPrefix: string,
): Promise<string | null> {
	for (const candidate of SURFACE_SITE_FALLBACK_FOLDERS) {
		const dir = entries.find((entry) => entry.mode === "40000" && entry.name === candidate);
		if (!dir) continue;
		const label = labelPrefix ? `${labelPrefix}/${candidate}` : candidate;
		const subTrees = await readObjects(run, "tree", [dir.id], MAX_LISTING, () => label);
		const subEntries = parseGitTreeEntries(subTrees.get(dir.id) as Buffer, label);
		if (hasIndexHtml(subEntries)) return dir.id;
	}
	return null;
}

async function resolveMonorepoAppSiteTree(
	run: Run,
	rootEntries: readonly ParsedGitTreeEntry[],
	repoName: string,
): Promise<string | null> {
	const appsDir = rootEntries.find((entry) => entry.mode === "40000" && entry.name === "apps");
	if (!appsDir) return null;
	const appsTrees = await readObjects(run, "tree", [appsDir.id], MAX_LISTING, () => "apps");
	const appSubdirs = parseGitTreeEntries(appsTrees.get(appsDir.id) as Buffer, "apps")
		.filter((entry) => entry.mode === "40000" && !entry.name.startsWith("."))
		.sort((a, b) => a.name.localeCompare(b.name));
	if (appSubdirs.length === 0) return null;
	const repoLower = repoName.toLowerCase();
	const prioritized = [
		...appSubdirs.filter((entry) => entry.name.toLowerCase() === repoLower),
		...appSubdirs.filter((entry) => {
			const lower = entry.name.toLowerCase();
			return lower !== repoLower && (lower.startsWith(`${repoLower}-`) || lower.startsWith(`${repoLower}_`));
		}),
	];
	const candidates = prioritized.length > 0 ? prioritized : appSubdirs;
	const matches: string[] = [];
	for (const subdir of candidates) {
		const label = `apps/${subdir.name}`;
		const subTrees = await readObjects(run, "tree", [subdir.id], MAX_LISTING, () => label);
		const subEntries = parseGitTreeEntries(subTrees.get(subdir.id) as Buffer, label);
		if (hasIndexHtml(subEntries)) {
			if (prioritized.length > 0) return subdir.id;
			matches.push(subdir.id);
			continue;
		}
		const nested = await resolveFallbackWebTree(run, subEntries, label);
		if (nested) {
			if (prioritized.length > 0) return nested;
			matches.push(nested);
		}
	}
	return matches.length === 1 ? (matches[0] as string) : null;
}

async function readSurfaceSiteTreeInRun(
	run: Run,
	repository: CloudCodingRepository,
	tree: string,
	rootEntries: readonly ParsedGitTreeEntry[],
	configuredFolder: string | null,
): Promise<{ files: CodeSiteTreeFile[]; manifestSha256: string }> {
	let siteTreeId = tree;
	if (configuredFolder && configuredFolder !== ".") {
		const resolved = await resolveTreeFolder(run, tree, configuredFolder);
		if (!resolved) {
			throw new CodeSiteTreeInvalid({ code: "SITE_FOLDER_MISSING", path: configuredFolder, variable: null });
		}
		siteTreeId = resolved;
	} else if (!configuredFolder && !hasIndexHtml(rootEntries)) {
		const fallbackTree =
			(await resolveFallbackWebTree(run, rootEntries, "")) ??
			(await resolveMonorepoAppSiteTree(run, rootEntries, repository.name));
		if (fallbackTree) siteTreeId = fallbackTree;
	}

	const servingRepoRoot = siteTreeId === tree;
	const entries: { mode: string; type: string; name: string; path: string; bytes: number }[] = [];
	let level = [{ id: siteTreeId, path: "" }],
		walkedFolders = 0;
	while (level.length) {
		const paths = new Map(level.map((folder) => [folder.id, folder.path || siteTreeId]));
		const trees = await readObjects(run, "tree", [...paths.keys()], MAX_LISTING, (id) => paths.get(id) ?? id);
		const next: typeof level = [];
		for (const folder of level) {
			for (const item of parseGitTreeEntries(trees.get(folder.id) as Buffer, folder.path || siteTreeId)) {
				if (item.name.startsWith(".")) continue;
				if (item.mode === "40000") {
					if (SURFACE_SKIP_DIRS.has(item.name)) continue;
					next.push({ id: item.id, path: folder.path ? `${folder.path}/${item.name}` : item.name });
					continue;
				}
				if (!isRegularBlobMode(item.mode)) continue;
				if (
					servingRepoRoot &&
					folder.path === "" &&
					(SURFACE_ROOT_CONFIG_FILES.has(item.name.toLowerCase()) || SURFACE_TSCONFIG_FILE.test(item.name))
				)
					continue;
				const path = folder.path ? `${folder.path}/${item.name}` : item.name;
				const isRootControlFile = folder.path === "" && (item.name === "_redirects" || item.name === "_headers");
				if (!isRootControlFile && !isNativeServableSitePath(path)) continue;
				entries.push({ mode: item.mode, type: "blob", name: item.id, path, bytes: 0 });
			}
		}
		walkedFolders += next.length;
		if (walkedFolders > MAX_SURFACE_WALK_FOLDERS)
			throw new CodeSiteTreeInvalid({ code: "SITE_TOO_MANY_FOLDERS", path: null, variable: null });
		level = next;
	}

	entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	if (entries.length) {
		const sized = (
			await run.gitOk(run.repo, ["cat-file", "--batch-check"], READ_FAILED, {
				stdin: Buffer.from(entries.map((entry) => `${entry.name}\n`).join("")),
				maximumOutputBytes: Math.max(MAX_LISTING, entries.length * 80),
			})
		)
			.toString("latin1")
			.split("\n");
		if (sized.pop() !== "" || sized.length !== entries.length)
			throw new CodeHostJobFailure(READ_FAILED, "cat-file's lines are not git's");
		entries.forEach((entry, index) => {
			const size = (sized[index] as string).startsWith(`${entry.name} blob `)
				? (sized[index] as string).slice(entry.name.length + 6)
				: "";
			if (!/^\d{1,10}$/.test(size))
				throw new CodeHostJobFailure(READ_FAILED, `${entry.path}: its file version is not here`);
			entry.bytes = Number(size);
		});
	}
	const problem = nativeSiteTreeProblem(entries);
	if (problem) throw new CodeSiteTreeInvalid(problem);
	const versions = [...new Map(entries.map((entry) => [entry.name, entry.bytes])).entries()],
		length = versions.reduce((sum, [name, bytes]) => sum + `${name} blob ${bytes}\n`.length + bytes + 1, 0);
	const read = await readObjects(
		run,
		"blob",
		versions.map(([name]) => name),
		length,
		(id) => id,
	);
	const digests = new Map([...read].map(([name, bytes]) => [name, createHash("sha256").update(bytes).digest("hex")]));
	const files = entries.map(({ name, path, bytes }): CodeSiteTreeFile => {
		const content = read.get(name) as Buffer;
		return {
			path,
			bytes,
			sha256: digests.get(name) as string,
			content: new Uint8Array(content.buffer, content.byteOffset, content.length),
		};
	});
	return { files, manifestSha256: codeSiteManifest(files) };
}

function parseOptionalSurfaceSubpath(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string" || !isSurfaceRepositorySubpath(value)) throw new Error("INVALID_CODE_HOST_JOB");
	return value;
}

function joinSubpath(subpath: string, relative: string): string {
	return relative === "." ? subpath : `${subpath}/${relative}`;
}

function pathWithinSubpath(path: string, subpath: string): boolean {
	return path === subpath || path.startsWith(`${subpath}/`);
}

async function resolveScopedChecksAndTree(
	run: Run,
	tree: string,
	rootEntries: readonly ParsedGitTreeEntry[],
	subpath: string | null,
): Promise<{
	readonly scopedTreeId: string;
	readonly scopedEntries: readonly ParsedGitTreeEntry[];
	readonly checksText: string | null;
	readonly checksFromSubpath: boolean;
}> {
	if (!subpath) {
		return {
			scopedTreeId: tree,
			scopedEntries: rootEntries,
			checksText: await readSurfaceChecksText(run, rootEntries),
			checksFromSubpath: false,
		};
	}
	const scopedTreeId = await resolveTreeFolder(run, tree, subpath);
	if (!scopedTreeId) {
		throw new CodeSiteTreeInvalid({ code: "SITE_FOLDER_MISSING", path: subpath, variable: null });
	}
	const scopedTrees = await readObjects(run, "tree", [scopedTreeId], MAX_LISTING, () => subpath);
	const scopedEntries = parseGitTreeEntries(scopedTrees.get(scopedTreeId) as Buffer, subpath);
	const subpathChecks = await readSurfaceChecksText(run, scopedEntries);
	if (subpathChecks !== null) {
		return {
			scopedTreeId,
			scopedEntries,
			checksText: subpathChecks,
			checksFromSubpath: true,
		};
	}
	return {
		scopedTreeId,
		scopedEntries,
		checksText: await readSurfaceChecksText(run, rootEntries),
		checksFromSubpath: false,
	};
}

function resolveConfiguredSiteFolderForScope(
	checksText: string | null,
	subpath: string | null,
	checksFromSubpath: boolean,
): { readonly baseTreeMode: "root" | "scoped"; readonly folder: string | null } {
	const configured = parseChecksSiteFolder(checksText);
	if (!subpath) return { baseTreeMode: "root", folder: configured };
	if (checksFromSubpath) return { baseTreeMode: "scoped", folder: configured };
	if (configured && pathWithinSubpath(configured, subpath)) {
		return { baseTreeMode: "root", folder: configured };
	}
	return { baseTreeMode: "scoped", folder: null };
}

function resolvePreviewRecipeForScope(
	checksText: string | null,
	subpath: string | null,
	checksFromSubpath: boolean,
): ReturnType<typeof readSurfacePreviewRecipe> {
	const read = readSurfacePreviewRecipe(checksText);
	if (read.kind !== "recipe" || !subpath) return read;
	if (checksFromSubpath) {
		return {
			kind: "recipe",
			recipe: {
				...read.recipe,
				cwd: joinSubpath(subpath, read.recipe.cwd),
				folder: joinSubpath(subpath, read.recipe.folder),
			},
		};
	}
	if (pathWithinSubpath(read.recipe.cwd, subpath) || pathWithinSubpath(read.recipe.folder, subpath)) {
		return read;
	}
	return { kind: "none" };
}

// WHY: Surface previews and publishes compose a full repository tree (including .qorpera/checks.json and non-web source files); filter to servable web assets under the resolved site folder while keeping cryptographic git object verification.
export async function readSurfaceSiteTree(
	job: CodeHostJob,
	value: { repository: CloudCodingRepository; tree: string; subpath?: string | null },
): Promise<{ files: CodeSiteTreeFile[]; manifestSha256: string }> {
	const hasSubpath = typeof value === "object" && value !== null && "subpath" in value && value.subpath !== undefined;
	let rawRepo: unknown;
	let tree: unknown;
	let rawSubpath: unknown;
	if (hasSubpath) {
		const input = closed(value, ["repository", "tree", "subpath"]);
		rawRepo = input.repository;
		tree = input.tree;
		rawSubpath = input.subpath;
	} else {
		const input = closed(value, ["repository", "tree"]);
		rawRepo = input.repository;
		tree = input.tree;
	}
	const repository = keptRepositoryOf(rawRepo);
	const subpath = hasSubpath ? parseOptionalSurfaceSubpath(rawSubpath) : null;
	if (typeof tree !== "string" || !SHA.test(tree)) throw new Error("INVALID_CODE_HOST_JOB");
	return withJob(job, repository, async (run) => {
		if (job.preparedKeptArea !== run.area) {
			if (!(await run.prepare(undefined, { readOnly: true })).seeded)
				throw new CodeHostRefusal("CODE_HOST_NOT_SEEDED", [run.area]);
			if ((await run.ref(CODE_AREA_IN_QORPERA_REF)) === null)
				throw new CodeHostRefusal("CODE_HOST_AREA_FROM_GITHUB", [run.area]);
		}
		const kind = (
			await run.gitOk(run.repo, ["cat-file", "--batch-check"], READ_FAILED, { stdin: Buffer.from(`${tree}\n`) })
		).toString("latin1");
		if (kind !== `${tree} missing\n` && !/^[0-9a-f]{40} [a-z]+ \d+\n$/.test(kind))
			throw new CodeHostJobFailure(READ_FAILED, "cat-file's line is not git's");
		if (!kind.startsWith(`${tree} tree `)) throw new CodeHostRefusal("CODE_HOST_SITE_TREE_UNKNOWN", [tree]);

		const rootTrees = await readObjects(run, "tree", [tree], MAX_LISTING, () => tree);
		const rootEntries = parseGitTreeEntries(rootTrees.get(tree) as Buffer, tree);
		const scoped = await resolveScopedChecksAndTree(run, tree, rootEntries, subpath);
		const resolvedFolder = resolveConfiguredSiteFolderForScope(scoped.checksText, subpath, scoped.checksFromSubpath);
		return readSurfaceSiteTreeInRun(
			run,
			repository,
			resolvedFolder.baseTreeMode === "scoped" ? scoped.scopedTreeId : tree,
			resolvedFolder.baseTreeMode === "scoped" ? scoped.scopedEntries : rootEntries,
			resolvedFolder.folder,
		);
	});
}

export async function readSurfacePreviewPlan(
	job: CodeHostJob,
	value: { repository: CloudCodingRepository; tree: string; subpath?: string | null },
): Promise<SurfacePreviewPlan> {
	const hasSubpath = typeof value === "object" && value !== null && "subpath" in value && value.subpath !== undefined;
	let rawRepo: unknown;
	let tree: unknown;
	let rawSubpath: unknown;
	if (hasSubpath) {
		const input = closed(value, ["repository", "tree", "subpath"]);
		rawRepo = input.repository;
		tree = input.tree;
		rawSubpath = input.subpath;
	} else {
		const input = closed(value, ["repository", "tree"]);
		rawRepo = input.repository;
		tree = input.tree;
	}
	const repository = keptRepositoryOf(rawRepo);
	const subpath = hasSubpath ? parseOptionalSurfaceSubpath(rawSubpath) : null;
	if (typeof tree !== "string" || !SHA.test(tree)) throw new Error("INVALID_CODE_HOST_JOB");
	return withJob(job, repository, async (run) => {
		if (job.preparedKeptArea !== run.area) {
			if (!(await run.prepare(undefined, { readOnly: true })).seeded)
				throw new CodeHostRefusal("CODE_HOST_NOT_SEEDED", [run.area]);
			if ((await run.ref(CODE_AREA_IN_QORPERA_REF)) === null)
				throw new CodeHostRefusal("CODE_HOST_AREA_FROM_GITHUB", [run.area]);
		}
		const rootTrees = await readObjects(run, "tree", [tree], MAX_LISTING, () => tree);
		const rootEntries = parseGitTreeEntries(rootTrees.get(tree) as Buffer, tree);
		const scoped = await resolveScopedChecksAndTree(run, tree, rootEntries, subpath);
		const read = resolvePreviewRecipeForScope(scoped.checksText, subpath, scoped.checksFromSubpath);
		if (read.kind === "none") return { kind: "static" };
		if (read.kind === "invalid") return read;
		let cwdEntries = rootEntries;
		if (read.recipe.cwd !== ".") {
			const cwdTree = await resolveTreeFolder(run, tree, read.recipe.cwd);
			if (!cwdTree) return { kind: "static" };
			const cwdTrees = await readObjects(run, "tree", [cwdTree], MAX_LISTING, () => read.recipe.cwd);
			cwdEntries = parseGitTreeEntries(cwdTrees.get(cwdTree) as Buffer, read.recipe.cwd);
		}
		return cwdEntries.some((entry) => entry.name === "package.json" && isRegularBlobMode(entry.mode))
			? { kind: "build", recipe: read.recipe }
			: { kind: "static" };
	});
}

export type SurfacePreviewPlanAndTree =
	| { readonly kind: "invalid"; readonly detail: string }
	| { readonly kind: "build"; readonly recipe: Extract<SurfacePreviewPlan, { readonly kind: "build" }>["recipe"] }
	| { readonly kind: "static"; readonly files: CodeSiteTreeFile[]; readonly manifestSha256: string };

// WHY: Reads the preview plan and static site tree in one withJob pass so .qorpera/checks.json and the root git tree are never fetched twice.
export async function readSurfacePreviewPlanAndTree(
	job: CodeHostJob,
	value: { repository: CloudCodingRepository; tree: string; subpath?: string | null },
): Promise<SurfacePreviewPlanAndTree> {
	const hasSubpath = typeof value === "object" && value !== null && "subpath" in value && value.subpath !== undefined;
	let rawRepo: unknown;
	let tree: unknown;
	let rawSubpath: unknown;
	if (hasSubpath) {
		const input = closed(value, ["repository", "tree", "subpath"]);
		rawRepo = input.repository;
		tree = input.tree;
		rawSubpath = input.subpath;
	} else {
		const input = closed(value, ["repository", "tree"]);
		rawRepo = input.repository;
		tree = input.tree;
	}
	const repository = keptRepositoryOf(rawRepo);
	const subpath = hasSubpath ? parseOptionalSurfaceSubpath(rawSubpath) : null;
	if (typeof tree !== "string" || !SHA.test(tree)) throw new Error("INVALID_CODE_HOST_JOB");
	return withJob(job, repository, async (run) => {
		if (job.preparedKeptArea !== run.area) {
			if (!(await run.prepare(undefined, { readOnly: true })).seeded)
				throw new CodeHostRefusal("CODE_HOST_NOT_SEEDED", [run.area]);
			if ((await run.ref(CODE_AREA_IN_QORPERA_REF)) === null)
				throw new CodeHostRefusal("CODE_HOST_AREA_FROM_GITHUB", [run.area]);
		}
		const rootTrees = await readObjects(run, "tree", [tree], MAX_LISTING, () => tree);
		const rootEntries = parseGitTreeEntries(rootTrees.get(tree) as Buffer, tree);
		const scoped = await resolveScopedChecksAndTree(run, tree, rootEntries, subpath);
		const read = resolvePreviewRecipeForScope(scoped.checksText, subpath, scoped.checksFromSubpath);
		if (read.kind === "invalid") return read;
		if (read.kind === "recipe") {
			let cwdEntries = rootEntries;
			let hasCwd = true;
			if (read.recipe.cwd !== ".") {
				const cwdTree = await resolveTreeFolder(run, tree, read.recipe.cwd);
				if (!cwdTree) {
					hasCwd = false;
				} else {
					const cwdTrees = await readObjects(run, "tree", [cwdTree], MAX_LISTING, () => read.recipe.cwd);
					cwdEntries = parseGitTreeEntries(cwdTrees.get(cwdTree) as Buffer, read.recipe.cwd);
				}
			}
			if (hasCwd && cwdEntries.some((entry) => entry.name === "package.json" && isRegularBlobMode(entry.mode))) {
				return { kind: "build", recipe: read.recipe };
			}
		}
		const resolvedFolder = resolveConfiguredSiteFolderForScope(scoped.checksText, subpath, scoped.checksFromSubpath);
		const siteTree = await readSurfaceSiteTreeInRun(
			run,
			repository,
			resolvedFolder.baseTreeMode === "scoped" ? scoped.scopedTreeId : tree,
			resolvedFolder.baseTreeMode === "scoped" ? scoped.scopedEntries : rootEntries,
			resolvedFolder.folder,
		);
		return { kind: "static", ...siteTree };
	});
}

export const CODE_SITE_REF_PREFIX = "refs/qorpera/sites/change-";

export async function pinCodeSiteTree(
	job: CodeHostJob,
	value: { repository: CloudCodingRepository; change: number; tree: string },
): Promise<{ pinned: boolean; ref: string }> {
	const input = closed(value, ["repository", "change", "tree"]);
	const repository = keptRepositoryOf(input.repository);
	const change = input.change;
	const tree = input.tree;
	if (!Number.isSafeInteger(change) || (change as number) < 1 || typeof tree !== "string" || !SHA.test(tree))
		throw new Error("INVALID_CODE_HOST_JOB");
	const ref = `${CODE_SITE_REF_PREFIX}${change}`;
	return withJob(job, repository, async (run) => {
		if (job.preparedKeptArea !== run.area) {
			if (!(await run.prepare()).seeded) throw new CodeHostRefusal("CODE_HOST_NOT_SEEDED", [run.area]);
			if ((await run.ref(CODE_AREA_IN_QORPERA_REF)) === null)
				throw new CodeHostRefusal("CODE_HOST_AREA_FROM_GITHUB", [run.area]);
		}
		const kind = (
			await run.gitOk(run.repo, ["cat-file", "--batch-check"], "CODE_HOST_SITE_PIN_FAILED", {
				stdin: Buffer.from(`${tree}\n`),
			})
		).toString("latin1");
		if (!kind.startsWith(`${tree} tree `)) return { pinned: false, ref };
		await run.gitOk(run.repo, ["update-ref", "--no-deref", ref, tree], "CODE_HOST_SITE_PIN_FAILED");
		return { pinned: true, ref };
	});
}

const MAX_APP_SOURCE_TAR_BYTES = 128 * 1024 * 1024;
const EXPORT_FAILED = "CODE_HOST_SITE_EXPORT_FAILED";

async function extractTarBuffer(tarBytes: Buffer, targetDir: string): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn("tar", ["-xf", "-", "-C", targetDir], { stdio: ["pipe", "ignore", "pipe"] });
		let errText = "";
		child.stderr?.on("data", (chunk: Buffer) => {
			if (errText.length < 1024) errText += chunk.toString("utf8");
		});
		child.on("error", (err) => reject(new CodeHostJobFailure(EXPORT_FAILED, err.message)));
		child.on("close", (code) => {
			if (code === 0) resolve();
			else reject(new CodeHostJobFailure(EXPORT_FAILED, errText.trim() || `tar exited ${String(code)}`));
		});
		child.stdin?.on("error", () => undefined);
		child.stdin?.end(tarBytes);
	});
}

export async function exportCodeSiteSource(
	job: CodeHostJob,
	value: { repository: CloudCodingRepository; tree: string; kind?: "static" | "server" | "hybrid" },
): Promise<{ sourceDir: string; cleanup: () => Promise<void> }> {
	const hasKind = typeof value === "object" && value !== null && "kind" in value && value.kind !== undefined;
	let rawRepo: unknown;
	let tree: unknown;
	let kind: unknown;
	if (hasKind) {
		const input = closed(value, ["repository", "tree", "kind"]);
		rawRepo = input.repository;
		tree = input.tree;
		kind = input.kind;
	} else {
		const input = closed(value, ["repository", "tree"]);
		rawRepo = input.repository;
		tree = input.tree;
	}
	const repository = keptRepositoryOf(rawRepo);
	if (typeof tree !== "string" || !SHA.test(tree)) throw new Error("INVALID_CODE_HOST_JOB");
	if (kind !== undefined && kind !== "static" && kind !== "server" && kind !== "hybrid") {
		throw new Error("INVALID_CODE_HOST_JOB");
	}
	const tarBytes = await withJob(job, repository, async (run) => {
		if (!(await run.prepare()).seeded) throw new CodeHostRefusal("CODE_HOST_NOT_SEEDED", [run.area]);
		if ((await run.ref(CODE_AREA_IN_QORPERA_REF)) === null) {
			throw new CodeHostRefusal("CODE_HOST_AREA_FROM_GITHUB", [run.area]);
		}
		let target = tree;
		if (kind === "hybrid") {
			const mainRef = await run.ref(`refs/heads/${repository.baseBranch}`);
			if (mainRef === null) throw new CodeHostRefusal("CODE_HOST_SITE_TREE_UNKNOWN", [tree]);
			target = mainRef;
		}
		return await run.gitOk(run.repo, ["archive", "--format=tar", target], EXPORT_FAILED, {
			maximumOutputBytes: MAX_APP_SOURCE_TAR_BYTES,
		});
	});
	const sourceDir = await mkdtemp(join(tmpdir(), "qorpera-app-src-"));
	try {
		await extractTarBuffer(tarBytes, sourceDir);
	} catch (error) {
		await rm(sourceDir, { recursive: true, force: true }).catch(() => undefined);
		throw error;
	}
	return {
		sourceDir,
		cleanup: async () => {
			await rm(sourceDir, { recursive: true, force: true });
		},
	};
}

export async function readRepoDeployConfig(
	job: CodeHostJob,
	value: { repository: CloudCodingRepository; commitSha: string },
): Promise<{ rawConfig: string; paths: string[] } | null> {
	const input = closed(value, ["repository", "commitSha"]);
	const repository = keptRepositoryOf(input.repository);
	const commitSha = input.commitSha;
	if (typeof commitSha !== "string" || !SHA.test(commitSha)) throw new Error("INVALID_CODE_HOST_JOB");
	return withJob(job, repository, async (run) => {
		if (!(await run.prepare()).seeded) return null;
		if ((await run.ref(CODE_AREA_IN_QORPERA_REF)) === null) return null;
		const spec = `${commitSha}:.qorpera/deploy.json`;
		const probe = (
			await run.gitOk(run.repo, ["cat-file", "--batch-check"], READ_FAILED, {
				stdin: Buffer.from(`${spec}\n`),
			})
		)
			.toString("latin1")
			.trim();
		const parts = probe.split(" ");
		if (parts.length < 3 || parts[1] !== "blob") return null;
		const size = Number(parts[2]);
		if (!Number.isSafeInteger(size) || size <= 0 || size > 64 * 1024) return null;
		const rawConfig = (
			await run.gitOk(run.repo, ["cat-file", "blob", spec], READ_FAILED, {
				maximumOutputBytes: 64 * 1024,
			})
		).toString("utf8");
		const diffOut = (
			await run.gitOk(
				run.repo,
				["diff-tree", "--no-commit-id", "--name-only", "-r", "-m", "--first-parent", commitSha],
				READ_FAILED,
				{ maximumOutputBytes: 256 * 1024 },
			)
		).toString("utf8");
		const paths = diffOut
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line.length > 0);
		return { rawConfig, paths };
	});
}
