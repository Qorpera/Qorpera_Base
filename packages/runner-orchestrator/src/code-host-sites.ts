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
import { type CodeSiteProblem, codeSiteManifest, codeSiteTreeProblem } from "./code-site.ts";

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
