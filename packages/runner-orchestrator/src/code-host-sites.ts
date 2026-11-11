import { createHash } from "node:crypto";
import type { CloudCodingRepository } from "@qorpera/contracts";
import {
	CODE_AREA_IN_QORPERA_REF,
	type CodeHostJob,
	CodeHostJobFailure,
	CodeHostRefusal,
	closed,
	keptRepositoryOf,
	MAX_LISTING,
	SHA,
	treeRecords,
	withJob,
} from "./code-host-jobs.ts";

/** A repository's website as the code host reads it (own code storage, step 4, part B; STEP4-RELEASES-PLAN.md 8.2).
 * Once a change's checks passed, the executor's collect writes the web files of the folder the checks file names into
 * the repository's storage as git objects, one tree of them that no ref names, and the change's row keeps the tree's
 * id. The upload pass reads that tree here, by git and never from a worktree, to put it into the site tables as a
 * version. */

// Stand-in for code-site.ts (part C1): the plan's 8.1 signatures, with the eighth code and the folders' limit of
// STEP4-BUILD.md section 2. The lead replaces this block with an import from "./code-site.ts" once C1 is merged.
const CODE_SITE_MAX_FILES = 500;
const CODE_SITE_MAX_BYTES = 25 * 1024 * 1024;
const CODE_SITE_MAX_FILE_BYTES = 10 * 1024 * 1024;
/** Folders below the site's top that lead to a listed file. */
const CODE_SITE_MAX_FOLDERS = 100;
/** qorpera_site_content_type's extensions (20260930550000), 30 of them. */
const CODE_SITE_EXTENSIONS: readonly string[] = [
	"html",
	"htm",
	"css",
	"js",
	"mjs",
	"json",
	"map",
	"webmanifest",
	"txt",
	"csv",
	"xml",
	"svg",
	"png",
	"jpg",
	"jpeg",
	"gif",
	"webp",
	"avif",
	"ico",
	"woff",
	"woff2",
	"ttf",
	"otf",
	"mp4",
	"webm",
	"mp3",
	"m4a",
	"ogg",
	"wav",
	"pdf",
];
type CodeSiteProblemCode =
	| "SITE_FOLDER_MISSING"
	| "SITE_NO_INDEX"
	| "SITE_TOO_MANY_FILES"
	| "SITE_TOO_MANY_FOLDERS"
	| "SITE_FILE_TOO_LARGE"
	| "SITE_TOO_LARGE"
	| "SITE_FILE_NAME"
	| "SITE_HOLDS_SECRET";
interface CodeSiteProblem {
	readonly code: CodeSiteProblemCode;
	readonly path: string | null;
	readonly variable: string | null;
}
/** A site path, as the database stores it: no hidden part, no '..', no character a link would escape. */
const CODE_SITE_PATH = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,199}(\/[A-Za-z0-9_][A-Za-z0-9._-]{0,199}){0,15}$/;
/** site-tools' manifest: lines path TAB sha256 TAB bytes in C order, LF, SHA-256. */
function codeSiteManifest(files: readonly { path: string; sha256: string; bytes: number }[]): string {
	// Paths are ASCII: code-unit order is the database's byte order (collate "C").
	const lines = [...files]
		.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
		.map((file) => `${file.path}\t${file.sha256}\t${file.bytes}`);
	return createHash("sha256").update(lines.join("\n"), "utf8").digest("hex");
}
/** The collect's rules on a tree's entries, for the pass. The collect leaves out what is not a regular web file of a
 * path a site serves; a tree holds none of that, so here each such entry is refused as its name. Every folder on a
 * file's way counts toward the folders' limit, since each is one tree. */
function codeSiteTreeProblem(
	entries: readonly { mode: string; type: string; path: string; bytes: number }[],
): CodeSiteProblem | null {
	const problem = (code: CodeSiteProblemCode, path: string | null = null) => ({ code, path, variable: null });
	const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
		folders = new Set<string>();
	let files = 0,
		total = 0;
	for (const { mode, path, bytes } of sorted) {
		const extension = /\.([A-Za-z0-9]{1,12})$/.exec(path.slice(path.lastIndexOf("/") + 1))?.[1]?.toLowerCase();
		// A regular file's mode: a link's is 120000, a submodule's 160000.
		if (
			(mode !== "100644" && mode !== "100755") ||
			path.length > 512 ||
			!CODE_SITE_PATH.test(path) ||
			!extension ||
			!CODE_SITE_EXTENSIONS.includes(extension)
		)
			return problem("SITE_FILE_NAME", path);
		if (bytes > CODE_SITE_MAX_FILE_BYTES) return problem("SITE_FILE_TOO_LARGE", path);
		files += 1;
		total += bytes;
		if (files > CODE_SITE_MAX_FILES) return problem("SITE_TOO_MANY_FILES");
		if (total > CODE_SITE_MAX_BYTES) return problem("SITE_TOO_LARGE");
		for (let slash = path.indexOf("/"); slash >= 0; slash = path.indexOf("/", slash + 1))
			folders.add(path.slice(0, slash));
		if (folders.size > CODE_SITE_MAX_FOLDERS) return problem("SITE_TOO_MANY_FOLDERS");
	}
	return sorted.some((entry) => entry.path === "index.html") ? null : problem("SITE_NO_INDEX");
}
// End of the stand-in for code-site.ts.

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

/** One site tree of a repository kept in Qorpera, read by git and never from a worktree: the tree's type (`cat-file
 * --batch-check`), its entries (`ls-tree -r -l -z --full-tree`), then one `cat-file --batch` over its file versions
 * (each once, however many paths share it), whether or not a ref reaches them. The files come in C order with each
 * one's SHA-256, and the manifest over them. Refused: `CODE_HOST_SITE_TREE_UNKNOWN` when the repository has no tree of
 * that id (nothing of that id, or an object of another kind), `CODE_HOST_SITE_TREE_INVALID` (`CodeSiteTreeInvalid`)
 * when the tree breaks the site's rules, found on its entries before any file is read; and as every step 2b job, a
 * place a restore works on, one not seeded, and a GitHub copy. A command that failed, a file version or folder the
 * tree names that is not there, and bytes that are not their git id's: `CodeHostJobFailure`
 * `CODE_HOST_SITE_READ_FAILED`. */
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
		if (!(await run.prepare()).seeded) throw new CodeHostRefusal("CODE_HOST_NOT_SEEDED", [run.area]);
		if ((await run.ref(CODE_AREA_IN_QORPERA_REF)) === null)
			throw new CodeHostRefusal("CODE_HOST_AREA_FROM_GITHUB", [run.area]);
		// git answers `missing` for an object it does not have and fails only when it cannot look.
		const kind = (
			await run.gitOk(run.repo, ["cat-file", "--batch-check"], READ_FAILED, { stdin: Buffer.from(`${tree}\n`) })
		).toString("latin1");
		if (kind !== `${tree} missing\n` && !/^[0-9a-f]{40} [a-z]+ \d+\n$/.test(kind))
			throw new CodeHostJobFailure(READ_FAILED, "cat-file's line is not git's");
		if (!kind.startsWith(`${tree} tree `)) throw new CodeHostRefusal("CODE_HOST_SITE_TREE_UNKNOWN", [tree]);
		const listing = await run.gitOk(run.repo, ["ls-tree", "-r", "-l", "-z", "--full-tree", tree], READ_FAILED, {
			maximumOutputBytes: MAX_LISTING,
		});
		let records: ReturnType<typeof treeRecords>;
		try {
			records = treeRecords(listing);
		} catch {
			throw new CodeHostJobFailure(READ_FAILED, "ls-tree's records are not git's");
		}
		const entries = records.map(({ mode, type, name, size, path: raw }) => {
			const path = raw.toString("utf8"),
				bytes = type === "blob" ? Number(size) : 0;
			// A file version the repository lacks has the size BAD.
			if (type === "blob" && (!SHA.test(name) || !/^\d+$/.test(size) || !Number.isSafeInteger(bytes)))
				throw new CodeHostJobFailure(READ_FAILED, `${path}: its file version is not here`);
			return { mode, type, name, path, bytes };
		});
		const problem = codeSiteTreeProblem(entries);
		if (problem) throw new CodeSiteTreeInvalid(problem);
		// Each file version once, in the order asked: `<id> blob <size>\n<bytes>\n`.
		const versions = [...new Map(entries.map((entry) => [entry.name, entry.bytes])).entries()],
			heads = versions.map(([name, bytes]) => `${name} blob ${bytes}\n`),
			length = versions.reduce((sum, [, bytes], at) => sum + (heads[at] as string).length + bytes + 1, 0);
		const out = await run.gitOk(run.repo, ["cat-file", "--batch"], READ_FAILED, {
			stdin: Buffer.from(versions.map(([name]) => `${name}\n`).join("")),
			maximumOutputBytes: length,
		});
		if (out.length !== length) throw new CodeHostJobFailure(READ_FAILED, "cat-file's answer is not git's");
		const read = new Map<string, { content: Uint8Array; sha256: string }>();
		let at = 0;
		versions.forEach(([name, bytes], index) => {
			const head = heads[index] as string,
				start = at + head.length;
			if (out.toString("latin1", at, start) !== head || out[start + bytes] !== 0x0a)
				throw new CodeHostJobFailure(READ_FAILED, "cat-file's answer is not git's");
			const content = new Uint8Array(out.buffer, out.byteOffset + start, bytes);
			// cat-file does not check an object's bytes against its name, and a session may write a loose object of any
			// name: the bytes must be the file version's, or the manifest would not be the tree's.
			if (createHash("sha1").update(`blob ${bytes}\0`).update(content).digest("hex") !== name)
				throw new CodeHostJobFailure(READ_FAILED, `${name}: its bytes are not the file version's`);
			read.set(name, { content, sha256: createHash("sha256").update(content).digest("hex") });
			at = start + bytes + 1;
		});
		// In ls-tree's order, which is C order: git sorts a folder among its siblings as its name with a slash.
		const files = entries.map(({ name, path, bytes }): CodeSiteTreeFile => {
			const { content, sha256 } = read.get(name) as { content: Uint8Array; sha256: string };
			return { path, bytes, sha256, content };
		});
		return { files, manifestSha256: codeSiteManifest(files) };
	});
}
