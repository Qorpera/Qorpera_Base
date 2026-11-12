import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { CloudCodingRepository } from "@qorpera/contracts";
import { CODE_BUNDLE_MAXIMUM_BYTES, type CodeBundleRef } from "./code-bundle-store.ts";
import { codeFolderRefuses } from "./code-folder-names.ts";
import {
	type CodeAreaRef,
	type CodeBundleSink,
	type CodeHostCommandResult,
	type CodeHostJob,
	CodeHostJobFailure,
	CodeHostRefusal,
	closed,
	codeRefsSha256,
	keptRepositoryOf,
	MAX_LISTING,
	MAX_PIECE,
	MAX_READ,
	MAX_REFS,
	type Run,
	SHA,
	SHA256,
	treeRecords,
	withJob,
} from "./code-host-jobs.ts";
import {
	CODE_IMPORT_AUTHOR_DAYS,
	CODE_IMPORT_FILE_MAXIMUM_BYTES,
	CODE_IMPORT_FSCK_MS,
	CODE_IMPORT_MAIN_ENTRIES,
	CODE_IMPORT_MAXIMUM_BYTES_LIMIT,
	CODE_IMPORT_READ_PIECE_BYTES,
	CODE_IMPORT_REF_LIST_BYTES,
	CODE_IMPORT_SCAN,
	CODE_IMPORT_SCAN_BLOB_BYTES,
	CODE_IMPORT_SCAN_BYTES,
	CODE_IMPORT_SCAN_OUTPUT_BYTES,
	CODE_IMPORT_SCAN_SECONDS,
	CODE_IMPORT_SCRATCH_FACTOR,
	type CodeImportFetched,
	type CodeImportJobs,
	type CodeImportKeyKind,
	type CodeImportLooked,
	type CodeImportLookFacts,
	type CodeImportLookValue,
	type CodeImportRaw,
	type CodeImportReadValue,
	type CodeImportRefSeen,
	type CodeImportSink,
	codeImportAuthors,
	codeImportBundleHeaderOf,
	codeImportEnvFile,
	codeImportFileBranch,
	codeImportGitRefValid,
	codeImportHistoryCode,
	codeImportIncomingPathValid,
	codeImportLook,
	codeImportProgressOf,
	codeImportRefsPlan,
	codeImportScanAnswer,
	codeImportScanBlobs,
	codeImportTime,
} from "./code-import.ts";

/** The import's code host jobs (own code storage, step 6, part B; STEP6-IMPORT-BUILD.md 5.3 to 5.5, as the last section
 * of STEP6-BUILD.md corrected it). Every git command of an import runs here, in the company's code host, on bytes the
 * coding executor only moves (part C2's fetch, part C3's run):
 *
 *   read    a file source, `code/_incoming/<folder>/<name>.bundle`, copied to the scratch, checked against the
 *           request's SHA-256 and read out as the first bundle.
 *   look    the first bundle proven (the import's one fsck), what it holds looked at (the facts and the key scan), and
 *           then, unless the look was all that was asked or it found what stops the import, the refs plan applied and
 *           the restore-shaped bundle made, proven as care proves one, and read out.
 *
 * Nothing here removes the file source: once the import is in, the agent that made the bundle removes it through its own
 * view, which has the folder's checks for a writer, and only if it is still that bundle. A code host job's view has no
 * removal that holds only while the file is still the one read (a removal takes the version its name shows, and the
 * view shows what another view publishes), and a bundle left behind is a smaller harm than a file the import never
 * read removed or written over.
 *
 * What the code brought in holds never leaves the code host but as counts, sizes, ref names, paths and the scan's
 * offsets: no file's content, no key the scan matched, and no list of every object (those stay in files in the
 * scratch). Nor is git's own text ever put in an error: what git says of code that is not ours yet may name its paths
 * or quote its objects, so a failure says which of our steps failed and how it ended, and a refused history is named by
 * git's message id alone (`codeImportHistoryCode`). */

const FAILED = "CODE_HOST_IMPORT_FAILED";
/** The first bundle the store handed in is not the one the fetch or the read stored. */
const DIFFERS = "CODE_HOST_IMPORT_BUNDLE_DIFFERS";
const REFS_FAILED = "CODE_HOST_IMPORT_REFS_FAILED";
const SCAN_FAILED = "IMPORT_SCAN_FAILED";
/** A fetch from a bundle that takes every ref and writes nothing else. */
const FETCH = ["fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head"] as const;
const INIT = ["init", "--quiet", "--bare", "--template=", "--ref-format=files"] as const;
/** The refs plan's input, one ref a line (C1's `CodeImportRefSeen`). */
const REF_FORMAT = "--format=%(refname)%00%(objectname)%00%(objecttype)%00%(*objecttype)%00%(creatordate:unix)";
const LFS_LINE = "version https://git-lfs.github.com/spec/";
/** A Git LFS pointer is under 1 KiB (`codeImportLfsPointer`). */
const LFS_POINTER_BYTES = 1024;
/** The most of one lookup's answer taken in: the found blobs' names and paths, the LFS check's offsets. */
const ANSWER_BYTES = 16 * 1024 ** 2;
/** The sizes column of the blobs the scan reads: at most 8 bytes a blob. */
const SIZES_BYTES = 64 * 1024 ** 2;

function ok(result: CodeHostCommandResult, code: string, what: string): Buffer {
	if (result.status !== 0) throw new CodeHostJobFailure(code, `${what} ended ${result.status}`);
	return result.stdout;
}

/** A failure of a job of the code host's own, said again without what git said. */
function quiet(error: unknown): unknown {
	return error instanceof CodeHostJobFailure ? new CodeHostJobFailure(error.code) : error;
}

/** An ERE that matches the decimal numbers 0 to `bound` - 1 as git prints them (no leading zero). */
export function codeImportBelow(bound: number): string {
	if (!Number.isSafeInteger(bound) || bound < 2) throw new Error("INVALID_CODE_IMPORT");
	const top = String(bound),
		forms = ["0"];
	if (top.length > 2) forms.push(`[1-9][0-9]{0,${top.length - 2}}`);
	else if (top.length === 2) forms.push("[1-9]");
	for (let at = 0; at < top.length; at += 1) {
		const digit = Number(top[at]),
			least = at === 0 ? 1 : 0;
		if (digit - 1 < least) continue;
		const rest = top.length - at - 1;
		forms.push(`${top.slice(0, at)}[${least}-${digit - 1}]${rest ? `[0-9]{${rest}}` : ""}`);
	}
	return forms.join("|");
}

/** Free bytes in the job's scratch. */
async function free(run: Run): Promise<number> {
	const room = await run.sh('exec stat -f -c "%a %S" -- "$1"', [run.directory]),
		[, blocks, size] = /^(\d+) (\d+)\n$/.exec(room.stdout.toString("latin1")) ?? [],
		bytes = Number(blocks) * Number(size);
	if (room.status !== 0 || !Number.isFinite(bytes)) throw new CodeHostJobFailure(FAILED, `stat ended ${room.status}`);
	return bytes;
}

/** A file's SHA-256 and size, as the code host measures them. */
async function measure(run: Run, file: string): Promise<{ sha256: string; bytes: number }> {
	const measured = await run.sh('sha256sum <"$1" && exec wc -c <"$1"', [file]),
		[, sha256, counted] = /^([0-9a-f]{64}) [ *]-\n *(\d+)\n$/.exec(measured.stdout.toString("latin1")) ?? [];
	if (measured.status !== 0 || !sha256) throw new CodeHostJobFailure(FAILED, `a measure ended ${measured.status}`);
	return { sha256, bytes: Number(counted) };
}

/** A file in the scratch read out to `write` in pieces of `chunkBytes`, one exec each (as care's bundle job); what was
 * handed over must have `sha256`. */
async function readOut(
	run: Run,
	file: string,
	measured: { sha256: string; bytes: number },
	chunkBytes: number,
	write: (piece: Buffer) => Promise<void>,
): Promise<void> {
	const read = createHash("sha256");
	for (let index = 0; index * chunkBytes < measured.bytes; index += 1) {
		const length = Math.min(chunkBytes, measured.bytes - index * chunkBytes);
		const piece = await run.command(
			[
				"/usr/bin/dd",
				`if=${file}`,
				`bs=${chunkBytes}`,
				`skip=${index}`,
				"count=1",
				"iflag=fullblock",
				"status=none",
			],
			{ maximumOutputBytes: length },
		);
		if (piece.status !== 0 || piece.stdout.length !== length)
			throw new CodeHostJobFailure(FAILED, "a piece was cut short");
		read.update(piece.stdout);
		await write(piece.stdout);
		run.job.signal.throwIfAborted();
	}
	if (read.digest("hex") !== measured.sha256)
		throw new CodeHostJobFailure(FAILED, "the file read out is not the one made");
}

// The file source: read ------------------------------------------------------------------------------------------------

/** Where a file source is, and the folders on the way to it, by plain file tests: each must be what it says, reached
 * without a link. */
async function incoming(run: Run, path: string) {
	const file = `${run.layout.companyRoot}/${path}`,
		folder = posix.dirname(file),
		folders = [`${run.layout.companyRoot}/code`, posix.dirname(folder), folder];
	const types = await run.types([...folders, file]);
	return { file, folder, folders: types.slice(0, 3), type: types[3] };
}

/** Part C1's `CodeImportReadJob` (5.5): a file source, `code/_incoming/<folder>/<name>.bundle` that an agent made on a
 * machine, as the first bundle. The file is copied to the scratch (at most `maximumBytes`, and never more than one
 * folder file, 256 MiB: `IMPORT_TOO_LARGE`), and only the copy is read: it must have the request's SHA-256, taken when
 * the import was asked (`IMPORT_FILE_CHANGED`, also when the file is gone or is no plain file reached without a link).
 * Its header must be a git bundle's that needs nothing it does not hold: no prerequisite, no capability but the
 * object format (a filtered bundle leaves objects out), every ref a name git takes (`IMPORT_FILE_NOT_WHOLE`;
 * `IMPORT_SHA256_REPOSITORY`). The default branch is the one asked for, the only head, `main`, `master` or the one head
 * at the bundle's `HEAD` (`codeImportFileBranch`; `IMPORT_BRANCH_UNKNOWN`, `IMPORT_BRANCH_NAME`). Then the copy goes out
 * to `sink` in pieces of 16 MiB, each awaited; the sink is never committed or aborted here. It answers the copy's
 * SHA-256 and size, the default branch and its commit, and the refs the header names under `refs/` (its `HEAD` line is
 * none). Nothing in the folder is written. */
export async function readIncomingCodeBundle(
	job: CodeHostJob,
	value: CodeImportReadValue,
	sink: CodeImportSink,
): Promise<CodeImportFetched> {
	const input = closed(value, ["repository", "path", "sha256", "branch", "maximumBytes"]);
	const repository = keptRepositoryOf(input.repository),
		{ path, sha256, branch, maximumBytes } = input;
	if (
		typeof path !== "string" ||
		!codeImportIncomingPathValid(path) ||
		typeof sha256 !== "string" ||
		!SHA256.test(sha256) ||
		!(branch === null || typeof branch === "string") ||
		!Number.isSafeInteger(maximumBytes) ||
		(maximumBytes as number) < 1 ||
		(maximumBytes as number) > CODE_IMPORT_MAXIMUM_BYTES_LIMIT ||
		typeof sink?.write !== "function"
	)
		throw new Error("INVALID_CODE_HOST_JOB");
	const cap = Math.min(maximumBytes as number, CODE_IMPORT_FILE_MAXIMUM_BYTES);
	return withJob(job, repository, async (run) => {
		const changed = () => new CodeHostRefusal("IMPORT_FILE_CHANGED");
		const source = await incoming(run, path);
		if (!source.folders.every((type) => type === "directory") || source.type !== "file") throw changed();
		const sized = await run.sh('exec stat -c %s -- "$1"', [source.file]),
			size = Number(/^(\d+)\n$/.exec(sized.stdout.toString("latin1"))?.[1]);
		if (sized.status !== 0 || !Number.isSafeInteger(size)) throw changed();
		if (size > cap) throw new CodeHostRefusal("IMPORT_TOO_LARGE");
		if ((await free(run)) < size) throw new CodeHostJobFailure("IMPORT_NO_SPACE");
		// Only the copy is read from here on: the folder's file may change, the copy does not.
		const copy = `${run.directory}/incoming.bundle`;
		const copied = await run.sh('umask 077; set -C; exec head -c "$3" -- "$1" >"$2"', [
			source.file,
			copy,
			String(cap + 1),
		]);
		if (copied.status !== 0) throw changed();
		// A file that grew since it was measured is cut at one byte too many, so its SHA-256 is no longer the request's.
		const measured = await measure(run, copy);
		if (measured.sha256 !== sha256) throw changed();
		const start = await run.sh('exec head -c "$2" -- "$1"', [copy, String(CODE_IMPORT_REF_LIST_BYTES)], {
			maximumOutputBytes: CODE_IMPORT_REF_LIST_BYTES,
		});
		if (start.status !== 0) throw new CodeHostJobFailure(FAILED, `a read ended ${start.status}`);
		const header = codeImportBundleHeaderOf(start.stdout);
		const notWhole = () => new CodeHostRefusal("IMPORT_FILE_NOT_WHOLE");
		if (header.prerequisites > 0 || [...header.capabilities.keys()].some((key) => key !== "object-format"))
			throw notWhole();
		const refs: CodeBundleRef[] = [],
			names = new Set<string>();
		let headSha: string | null = null;
		for (const ref of header.refs) {
			if (ref.name === "HEAD" && headSha === null) headSha = ref.sha;
			else if (!ref.name.startsWith("refs/") || !codeImportGitRefValid(ref.name) || names.has(ref.name))
				throw notWhole();
			else {
				names.add(ref.name);
				refs.push({ name: ref.name, sha: ref.sha });
			}
		}
		const defaultBranch = codeImportFileBranch({ branch: branch as string | null, refs, headSha });
		const mainSha = refs.find((ref) => ref.name === `refs/heads/${defaultBranch}`)?.sha as string;
		await readOut(run, copy, measured, CODE_IMPORT_READ_PIECE_BYTES, (piece) => sink.write(piece, job.signal));
		return { sha256: measured.sha256, bytes: measured.bytes, defaultBranch, mainSha, refs, leftOut: 0 };
	});
}

// The look ---------------------------------------------------------------------------------------------------------------

/** fsck's own exit status in the first line, or `timeout` when it was stopped (TERM, and KILL 10 s later), then the
 * start of what it said, for its message id alone (`code-host-jobs.ts`'s care fsck, which this follows). */
const FSCK = `out=$1 status=$2 seconds=$3; shift 3
timeout -k 10 "$seconds" /bin/sh -c '"$@"; echo "$?" >"$0"' "$status" "$@" >"$out" 2>&1
stopped=$?
if [ -f "$status" ]; then cat -- "$status" || exit 1
elif [ "$stopped" -eq 124 ] || [ "$stopped" -eq 137 ]; then echo timeout
else exit 1; fi
exec head -c 4096 -- "$out"`;

/** `git fsck --full` (not strict) of `gitDir` within `fsckMs`: whether it passed, and the start of what it said. */
async function fsck(run: Run, gitDir: string, fsckMs: number): Promise<{ passed: boolean; said: string }> {
	const name = posix.basename(gitDir);
	const ran = await run.sh(
		FSCK,
		[
			`${run.directory}/${name}.fsck`,
			`${run.directory}/${name}.fsck-status`,
			String(fsckMs / 1000),
			run.layout.git,
			"--no-replace-objects",
			`--git-dir=${gitDir}`,
			"fsck",
			"--full",
			"--no-dangling",
			"--no-progress",
		],
		{ maximumOutputBytes: 8192 },
	);
	const end = ran.stdout.indexOf(0x0a),
		first = ran.stdout.subarray(0, Math.max(end, 0)).toString("latin1");
	if (ran.status !== 0 || !/^(timeout|\d{1,3})$/.test(first))
		throw new CodeHostJobFailure(FAILED, `the check ended ${ran.status}`);
	if (first === "timeout") throw new CodeHostJobFailure("IMPORT_FSCK_TIMEOUT");
	return { passed: first === "0", said: ran.stdout.subarray(end + 1).toString("utf8") };
}

/** Whether what git refused is git's warning alone: the bundle fetched again into a repository of its own with the
 * object check off, then an fsck that is not strict. Both pass for old objects git only warns about (a zero-padded file
 * mode), and not for damage. Only on a refusal's way. */
async function warnedOnly(run: Run, file: string, fsckMs: number): Promise<boolean> {
	const lenient = `${run.directory}/lenient.git`;
	ok(await run.git(lenient, [...INIT, lenient]), FAILED, "an init");
	const fetched = await run.git(lenient, [
		"-c",
		"transfer.fsckObjects=false",
		"-c",
		"fetch.fsckObjects=false",
		...FETCH,
		file,
		"+refs/*:refs/*",
	]);
	const passed = fetched.status === 0 && (await fsck(run, lenient, fsckMs)).passed;
	ok(await run.command(["/usr/bin/rm", "-rf", "--", lenient]), FAILED, "a removal");
	return passed;
}

/** The look's one proof of the first bundle (5.3 step 2), in `proof`: `bundle verify`, a strict fetch of every ref
 * (`transfer.fsckObjects`, as every job's) and `git fsck --full` within `fsckMs` (`IMPORT_FSCK_TIMEOUT`). A refusal is
 * C1's history code by git's own message id: `IMPORT_HISTORY_<ID>` for what git only warns about,
 * `IMPORT_HISTORY_DAMAGED[_<ID>]` for damage. */
async function proveHistory(run: Run, file: string, proof: string, fsckMs: number): Promise<void> {
	const refuse = async (said: string, warning: boolean) =>
		new CodeHostRefusal(codeImportHistoryCode(said, warning && (await warnedOnly(run, file, fsckMs))));
	ok(await run.git(proof, [...INIT, proof]), FAILED, "an init");
	const verified = await run.git(proof, ["bundle", "verify", "--quiet", file]);
	if (verified.status !== 0) throw await refuse(verified.stderr, true);
	const fetched = await run.git(proof, [...FETCH, file, "+refs/*:refs/*"]);
	if (fetched.status !== 0) throw await refuse(fetched.stderr, true);
	// The repository holds every object now: the bundle's room goes back to the scratch.
	ok(await run.command(["/usr/bin/rm", "-f", "--", file]), FAILED, "a removal");
	const checked = await fsck(run, proof, fsckMs);
	if (!checked.passed) throw await refuse(checked.said, false);
}

/** The proof repository's refs, as the refs plan takes them; a ref whose name is not UTF-8 is set apart (`raw`, by its
 * bytes), since the plan deletes by name. */
async function refsSeen(
	run: Run,
	proof: string,
): Promise<{ refs: CodeImportRefSeen[]; raw: { name: Buffer; sha: string }[] }> {
	const listed = ok(
		await run.git(proof, ["for-each-ref", REF_FORMAT], { maximumOutputBytes: MAX_REFS }),
		"CODE_HOST_REF_UNREADABLE",
		"for-each-ref",
	);
	const decoder = new TextDecoder("utf-8", { fatal: true }),
		refs: CodeImportRefSeen[] = [],
		raw: { name: Buffer; sha: string }[] = [];
	const unreadable = () => new CodeHostJobFailure("CODE_HOST_REF_UNREADABLE", "a ref line is not git's");
	for (let start = 0; start < listed.length; ) {
		const end = listed.indexOf(0x0a, start);
		if (end < 0) throw unreadable();
		const line = listed.subarray(start, end),
			fields: Buffer[] = [];
		start = end + 1;
		for (let at = 0; ; ) {
			const nul = line.indexOf(0, at);
			fields.push(line.subarray(at, nul < 0 ? line.length : nul));
			if (nul < 0) break;
			at = nul + 1;
		}
		if (fields.length !== 5) throw unreadable();
		const [name, sha, type, peeledType, time] = fields as [Buffer, Buffer, Buffer, Buffer, Buffer];
		const oid = sha.toString("latin1"),
			seconds = time.toString("latin1");
		if (!SHA.test(oid) || !/^-?\d*$/.test(seconds)) throw unreadable();
		let decoded: string;
		try {
			decoded = decoder.decode(name);
		} catch {
			raw.push({ name: Buffer.from(name), sha: oid });
			continue;
		}
		refs.push({
			name: decoded,
			sha: oid,
			type: type.toString("latin1"),
			peeledType: peeledType.toString("latin1"),
			time: seconds ? Number(seconds) : 0,
		});
	}
	return { refs, raw };
}

interface MainTree {
	files: number;
	entries: number;
	biggest: { path: string; bytes: number } | null;
	lfsPointers: number;
	submodules: number;
	refused: { code: string; paths: string[] } | null;
	/** Main's blobs, each with its first path there. */
	blobs: Map<string, string>;
	/** Tracked `.env` files. */
	env: string[];
}

/** The LFS check: each listed blob's content through `grep -b -o`, which prints only where the spec's version line
 * starts and the line itself, never a byte of a file. Each of git and grep appends its status. */
const LFS = `status=$1; shift
{ "$@"; echo "git $?" >>"$status"; } |
	{ grep -a -b -o -F -e '${LFS_LINE}'; echo "grep $?" >>"$status"; } |
	head -c ${ANSWER_BYTES}`;

/** The Git LFS pointers among main's small blobs (`codeImportLfsPointer`: under 1 KiB, and the version line is where
 * the file starts), found in the code host: git's batch output gives each blob's place, and the version line must start
 * exactly where a blob's content does. */
async function lfsPointers(run: Run, proof: string, blobs: { oid: string; size: number }[]): Promise<Set<string>> {
	const found = new Set<string>();
	if (blobs.length === 0) return found;
	const status = `${run.directory}/lfs.status`;
	const ran = await run.sh(
		LFS,
		[status, run.layout.git, "--no-replace-objects", `--git-dir=${proof}`, "cat-file", "--batch"],
		{
			stdin: Buffer.from(blobs.map((blob) => `${blob.oid}\n`).join(""), "latin1"),
			maximumOutputBytes: ANSWER_BYTES,
		},
	);
	const said = (await run.read(status))?.toString("latin1") ?? "";
	if (ran.status !== 0 || !said.includes("git 0\n") || !/^grep [01]$/m.test(said))
		throw new CodeHostJobFailure(FAILED, "the LFS check did not end well");
	const starts = new Map<number, string>();
	let at = 0;
	for (const blob of blobs) {
		const content = at + 47 + String(blob.size).length;
		starts.set(content, blob.oid);
		at = content + blob.size + 1;
	}
	const lines = ran.stdout.toString("latin1").split("\n");
	lines.pop();
	for (const line of lines) {
		const offset = /^(\d+):/.exec(line)?.[1];
		const oid = offset === undefined ? undefined : starts.get(Number(offset));
		if (oid !== undefined) found.add(oid);
	}
	return found;
}

/** Main's tree (5.3 step 3): `Run.checkNames` (NFC, UTF-8, names one to the folder by case, files over 256 MiB), then
 * the company folder's own rule for each path where it will stand (`codeFolderRefuses`, as a session's landing asks it;
 * `CODE_HOST_NAMES_FOLDER_REFUSES`), at most 9,000 entries, no LFS pointers, no gitlinks, in that order; the first rule
 * broken is the look's refusal, with its paths. And main's facts beside. Without the folder's rule a restore would
 * close the place and only then find its build refused, every time it was tried. */
async function mainTree(run: Run, proof: string, mainSha: string): Promise<MainTree> {
	let records: ReturnType<typeof treeRecords>,
		refused: MainTree["refused"] = null;
	try {
		records = await run.checkNames(proof, mainSha);
	} catch (error) {
		if (!(error instanceof CodeHostRefusal)) throw quiet(error);
		refused = { code: error.code, paths: [...error.paths] };
		records = treeRecords(
			ok(
				await run.git(proof, ["ls-tree", "-r", "-t", "-l", "-z", "--full-tree", mainSha], {
					maximumOutputBytes: MAX_LISTING,
				}),
				"CODE_HOST_TREE_UNREADABLE",
				"ls-tree",
			),
		);
	}
	if (refused === null) {
		const paths = codeFolderRefuses(run.area, records);
		if (paths.length) refused = { code: "CODE_HOST_NAMES_FOLDER_REFUSES", paths };
	}
	let files = 0,
		biggest: MainTree["biggest"] = null;
	const blobs = new Map<string, string>(),
		small = new Map<string, number>(),
		submodules: string[] = [],
		env: string[] = [];
	for (const record of records) {
		const path = record.path.toString("utf8");
		if (record.type === "commit") submodules.push(path);
		if (record.type !== "blob") continue;
		const bytes = Number(record.size);
		files += 1;
		if (!blobs.has(record.name)) blobs.set(record.name, path);
		if (biggest === null || bytes > biggest.bytes) biggest = { path, bytes };
		if (record.mode === "120000") continue;
		if (bytes < LFS_POINTER_BYTES) small.set(record.name, bytes);
		if (codeImportEnvFile(path)) env.push(path);
	}
	const pointers = await lfsPointers(
		run,
		proof,
		[...small].map(([oid, size]) => ({ oid, size })),
	);
	const pointerPaths = records
		.filter((record) => record.type === "blob" && record.mode !== "120000" && pointers.has(record.name))
		.map((record) => record.path.toString("utf8"));
	if (refused === null && records.length > CODE_IMPORT_MAIN_ENTRIES)
		refused = { code: "IMPORT_TOO_MANY_FILES", paths: [] };
	if (refused === null && pointerPaths.length) refused = { code: "IMPORT_USES_LFS", paths: pointerPaths };
	if (refused === null && submodules.length) refused = { code: "IMPORT_USES_SUBMODULES", paths: submodules };
	return {
		files,
		entries: records.length,
		biggest,
		lfsPointers: pointerPaths.length,
		submodules: submodules.length,
		refused,
		blobs,
		env,
	};
}

/** The default branch's history (5.4): its commits, when its first (its oldest root's) and its last commit were made,
 * and who changed it in the last 30 days (`codeImportAuthors`, by committer time). git's mailmap is not used: the
 * code's own `.mailmap` decides nothing here. */
async function historyFacts(run: Run, proof: string, mainSha: string, now: number) {
	const log = async (args: string[]) =>
		ok(
			await run.git(proof, ["log", "--no-use-mailmap", ...args, mainSha], { maximumOutputBytes: MAX_READ }),
			FAILED,
			"log",
		)
			.toString("utf8")
			.split("\n")
			.filter(Boolean);
	const counted = ok(await run.git(proof, ["rev-list", "--count", mainSha]), FAILED, "rev-list").toString("latin1"),
		commits = Number(/^(\d+)\n$/.exec(counted)?.[1]);
	if (!Number.isSafeInteger(commits)) throw new CodeHostJobFailure(FAILED, "rev-list");
	const times = (lines: string[]) => lines.map(Number).filter((time) => Number.isSafeInteger(time));
	const roots = times(await log(["--max-parents=0", "--format=%ct"])),
		[last] = times(await log(["-1", "--format=%ct"]));
	const since = Math.floor(now / 1000) - CODE_IMPORT_AUTHOR_DAYS * 86_400;
	const recent = (await log([`--max-age=${since}`, "--format=%ct%x00%ae"])).flatMap((line) => {
		const nul = line.indexOf("\0");
		return nul > 0 && Number(line.slice(0, nul)) >= since ? [line.slice(nul + 1)] : [];
	});
	return {
		commits,
		firstAt: roots.length ? codeImportTime(Math.min(...roots)) : null,
		lastAt: last === undefined ? null : codeImportTime(last),
		authors30d: codeImportAuthors(recent),
	};
}

/** The lists the key scan reads, made and kept in the scratch (X5): every object the kept refs reach (`objects`, NUL
 * between records: each object's name, and after it its first path as `path=<path>`, whole, as `rev-list -z` gives it,
 * where the plain listing cuts a path at a line feed), their types and sizes, and the blobs under 1 MiB (`list`, and
 * their sizes in `sizes`, in the same order). Out come only the count of every blob and of the small ones, and the sizes
 * column, at most `$4` bytes of it. */
const SCAN_LISTS = `git=$1 proof=$2 dir=$3 bound=$4
"$git" --no-replace-objects --git-dir="$proof" rev-list --objects -z --stdin >"$dir/objects" || exit 10
grep -z -v -e '^path=' -- "$dir/objects" >"$dir/ids.z"
[ "$?" -le 1 ] || exit 11
tr '\\0' '\\n' <"$dir/ids.z" >"$dir/ids" || exit 11
"$git" --no-replace-objects --git-dir="$proof" cat-file --batch-check='%(objectname) %(objecttype) %(objectsize)' <"$dir/ids" >"$dir/checked" || exit 12
grep -E -e '^[0-9a-f]{40} blob (${codeImportBelow(CODE_IMPORT_SCAN_BLOB_BYTES)})$' -- "$dir/checked" >"$dir/small"
[ "$?" -le 1 ] || exit 13
sed -e 's/ .*//' -- "$dir/small" >"$dir/list" || exit 14
sed -e 's/.* //' -- "$dir/small" >"$dir/sizes" || exit 15
blobs=$(grep -c -E -e '^[0-9a-f]{40} blob ' -- "$dir/checked")
[ "$?" -le 1 ] || exit 16
small=$(wc -l <"$dir/small") || exit 17
printf '%s %s\\n' "$blobs" "$small"
exec head -c "$bound" -- "$dir/sizes"`;
/** The first `$3` lines of the list: the blobs that fit the scan's bytes. */
const SCAN_CUT = 'exec head -n "$3" -- "$1" >"$2"';
/** The names of the blobs at the line numbers on stdin (one `:<n>:` a line), as `:<n>:<name>` lines. */
const SCAN_NAMES = `dir=$1 list=$2
cat >"$dir/numbers" || exit 1
grep -n -e '' -- "$list" | sed -e 's/^/:/' | grep -F -f "$dir/numbers"
[ "$?" -le 1 ]`;
/** The first path of each blob named on stdin (one name a line), from the objects' list: each such record and the one
 * after it, NUL after each, at most `$2` bytes. */
const SCAN_PATHS = `dir=$1 bound=$2
cat >"$dir/wanted" || exit 1
grep -z -x -F --no-group-separator -A 1 -f "$dir/wanted" -- "$dir/objects" >"$dir/found"
[ "$?" -le 1 ] || exit 1
exec head -c "$bound" -- "$dir/found"`;

/** The key scan (5.4, X5 and X6): C1's script over the blobs under 1 MiB that the kept refs reach, at most `most`
 * bytes of them (2 GiB), within `seconds`. Each hit's blob is found from the sizes, its name from the list and its first path from the
 * objects' list, only for the blobs hit; `inMain` and a path in main from main's own tree. `all` only when the scan
 * read every blob it could and ended whole. */
async function scanKeys(
	run: Run,
	proof: string,
	tips: readonly string[],
	main: MainTree,
	seconds: number,
	most: number,
): Promise<{ secrets: CodeImportLookFacts["secrets"]; scan: CodeImportLookFacts["scan"] }> {
	const dir = run.directory;
	const listed = await run.sh(SCAN_LISTS, [run.layout.git, proof, dir, String(SIZES_BYTES)], {
		stdin: Buffer.from(`${[...new Set(tips)].join("\n")}\n`, "latin1"),
		maximumOutputBytes: SIZES_BYTES + 64,
	});
	if (listed.status !== 0) throw new CodeHostJobFailure(SCAN_FAILED, `the scan's lists ended ${listed.status}`);
	const head = listed.stdout.indexOf(0x0a),
		[, blobsText, smallText] =
			/^(\d+) +(\d+)$/.exec(listed.stdout.subarray(0, Math.max(head, 0)).toString("latin1")) ?? [];
	const blobs = Number(blobsText),
		small = Number(smallText);
	if (head < 0 || !Number.isSafeInteger(blobs) || !Number.isSafeInteger(small) || small > blobs)
		throw new CodeHostJobFailure(SCAN_FAILED, "the scan's lists");
	const column = listed.stdout.subarray(head + 1),
		cut = column.length >= SIZES_BYTES,
		lines = column.toString("latin1").split("\n");
	// A column cut at its bound loses its last line; a whole one ends in a line feed.
	if (lines.pop() !== "" && !cut) throw new CodeHostJobFailure(SCAN_FAILED, "the scan's sizes");
	const sizes: number[] = [];
	let bytes = 0;
	for (const line of lines) {
		if (!/^\d{1,7}$/.test(line)) throw new CodeHostJobFailure(SCAN_FAILED, "the scan's sizes");
		const size = Number(line);
		if (size >= CODE_IMPORT_SCAN_BLOB_BYTES) throw new CodeHostJobFailure(SCAN_FAILED, "the scan's sizes");
		if (bytes + size > most) break;
		bytes += size;
		sizes.push(size);
	}
	if (sizes.length > small) throw new CodeHostJobFailure(SCAN_FAILED, "the scan's sizes");
	let list = `${dir}/list`;
	if (sizes.length < small) {
		list = `${dir}/list.cut`;
		ok(await run.sh(SCAN_CUT, [`${dir}/list`, list, String(sizes.length)]), SCAN_FAILED, "the scan's cut");
	}
	const status = `${dir}/scan.status`;
	const scanned = await run.sh(
		CODE_IMPORT_SCAN,
		[
			status,
			list,
			String(seconds),
			run.layout.git,
			"--no-replace-objects",
			`--git-dir=${proof}`,
			"cat-file",
			"--batch",
		],
		{ maximumOutputBytes: CODE_IMPORT_SCAN_OUTPUT_BYTES },
	);
	if (scanned.status !== 0) throw new CodeHostJobFailure(SCAN_FAILED, `the scan ended ${scanned.status}`);
	const answer = codeImportScanAnswer(scanned.stdout, (await run.read(status))?.toString("latin1") ?? null);
	const hit = codeImportScanBlobs(sizes, answer.hits).blobs;
	const indices = [...new Set(hit.map((entry) => entry.index))].sort((a, b) => a - b);
	const names = new Map<number, string>();
	if (indices.length) {
		const named = await run.sh(SCAN_NAMES, [dir, list], {
			stdin: Buffer.from(indices.map((index) => `:${index + 1}:\n`).join(""), "latin1"),
			maximumOutputBytes: indices.length * 64,
		});
		if (named.status !== 0) throw new CodeHostJobFailure(SCAN_FAILED, `the scan's names ended ${named.status}`);
		for (const line of named.stdout.toString("latin1").split("\n").filter(Boolean)) {
			const [, number, oid] = /^:(\d+):([0-9a-f]{40})$/.exec(line) ?? [];
			if (number === undefined || oid === undefined) throw new CodeHostJobFailure(SCAN_FAILED, "the scan's names");
			names.set(Number(number) - 1, oid);
		}
		if (!indices.every((index) => names.has(index))) throw new CodeHostJobFailure(SCAN_FAILED, "the scan's names");
	}
	// The first path of each blob hit that main does not hold.
	const outside = [...new Set(indices.map((index) => names.get(index) as string))].filter(
		(oid) => !main.blobs.has(oid),
	);
	const paths = new Map<string, string>();
	if (outside.length) {
		const found = await run.sh(SCAN_PATHS, [dir, String(ANSWER_BYTES)], {
			stdin: Buffer.from(outside.map((oid) => `${oid}\n`).join(""), "latin1"),
			maximumOutputBytes: ANSWER_BYTES,
		});
		if (found.status !== 0) throw new CodeHostJobFailure(SCAN_FAILED, `the scan's paths ended ${found.status}`);
		// Whole records only: one the bound cut is left out, and its blob's path is not known.
		const records: Buffer[] = [],
			wanted = new Set(outside);
		for (
			let start = 0, end = found.stdout.indexOf(0);
			end >= 0;
			start = end + 1, end = found.stdout.indexOf(0, start)
		)
			records.push(found.stdout.subarray(start, end));
		records.forEach((record, index) => {
			const oid = record.toString("latin1"),
				next = records[index + 1];
			if (wanted.has(oid) && !paths.has(oid) && next?.subarray(0, 5).toString("latin1") === "path=")
				paths.set(oid, next.subarray(5).toString("utf8"));
		});
	}
	const secrets: { kind: CodeImportKeyKind; path: string | null; inMain: boolean }[] = hit.map(({ index, kind }) => {
		const oid = names.get(index) as string,
			inMain = main.blobs.get(oid);
		return { kind, path: inMain ?? paths.get(oid) ?? null, inMain: inMain !== undefined };
	});
	for (const path of main.env) secrets.push({ kind: "env-file", path, inMain: true });
	return {
		secrets,
		// A sizes column cut at its bound has fewer lines than there are small blobs: not whole either.
		scan: { blobs: sizes.length, bytes, all: answer.all && sizes.length === small && small === blobs },
	};
}

/** The repository's refs, each with its object, as the fingerprint counts them. */
async function refsOf(run: Run, gitDir: string): Promise<CodeAreaRef[]> {
	const listed = ok(
		await run.git(gitDir, ["for-each-ref", "--format=%(refname)%00%(objectname)"], { maximumOutputBytes: MAX_REFS }),
		"CODE_HOST_REF_UNREADABLE",
		"for-each-ref",
	);
	return listed
		.toString("utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [name, sha] = line.split("\0");
			if (!name || !sha || !SHA.test(sha))
				throw new CodeHostJobFailure("CODE_HOST_REF_UNREADABLE", "a ref line is not git's");
			return { name, sha };
		});
}

/** The first bundle as the request's progress keeps it (C1's own reader of it). */
function rawOf(value: unknown): CodeImportRaw {
	let raw: CodeImportRaw | undefined;
	try {
		raw = codeImportProgressOf({ raw: value }).raw;
	} catch {
		raw = undefined;
	}
	if (raw === undefined) throw new Error("INVALID_CODE_HOST_JOB");
	return raw;
}

/** Part C1's `CodeImportLookJob` (5.3 steps 1 to 6, as STEP6-BUILD.md's last section corrected them), one job:
 *
 * 1. Every other entry of the scratch is removed first: a code host runs one job at a time, so what is there was left
 *    by one that never reached its own cleanup (X12). Then five times the first bundle must be free
 *    (`IMPORT_NO_SPACE`), and the bundle comes in on stdin, no more than its bytes and one, its size and SHA-256 those
 *    of `raw` as taken and as the code host measured them (`CODE_HOST_IMPORT_BUNDLE_DIFFERS`), as a restore's.
 * 2. The proof: `bundle verify`, a strict fetch of every ref into a new bare repository, and `git fsck --full` within
 *    `fsckMs` (default 30 minutes; `IMPORT_FSCK_TIMEOUT`): the import's one fsck. A history git refuses is refused by
 *    its message id (`IMPORT_HISTORY_<ID>`, `IMPORT_HISTORY_DAMAGED[_<ID>]`).
 * 3. The refs plan's counts (`codeImportRefsPlan`, which refuses a default branch it does not take); main's tree
 *    (names, the folder's rule for each path where the build will check it out, entries, LFS pointers, gitlinks);
 *    main's history; the key scan (within `scanSeconds`, default 600, and
 *    `scanBytes`, default and at most 2 GiB).
 * 4. The look (`codeImportLook`). It answers `looked` when only the look was asked, or when the look found what stops
 *    the import (`why`): nothing else is made then.
 * 5. The plan applied (`git update-ref --no-deref -z --stdin`, a ref whose name is not UTF-8 deleted first), `HEAD` at
 *    main, and the refs checked to be the plan's.
 * 6. The restore-shaped bundle (`bundle create --all`), measured, at most the store's 2 GiB
 *    (`CODE_HOST_BUNDLE_TOO_LARGE`), and proven as nightly care proves one (`bundle verify`, a fetch of every ref into
 *    a new repository whose refs must be the plan's); then read out to `sink` in pieces of `chunkBytes` (16 MiB). No
 *    repack: a bundle's pack holds only what its refs reach, and a restore's close repacks it anyway, refusing a pack
 *    the folder cannot hold before it writes its mark. It answers `kept`, with what the store's commit needs.
 *
 * Refusals before the look are `CodeHostRefusal`s with an import code (or C1's own `CodeImportStop`s); failures
 * `CodeHostJobFailure`s with their codes and none of git's words. Nothing in the folder is read or written. */
export async function lookCodeImport(
	job: CodeHostJob,
	value: CodeImportLookValue,
	source: AsyncIterable<Uint8Array>,
	sink: CodeBundleSink,
	options: { fsckMs?: number; scanSeconds?: number; chunkBytes?: number; scanBytes?: number } = {},
): Promise<CodeImportLooked> {
	const input = closed(value, ["repository", "raw", "look", "now"]);
	const repository: CloudCodingRepository = keptRepositoryOf(input.repository),
		raw = rawOf(input.raw),
		{ look, now } = input;
	const fsckMs = options.fsckMs ?? CODE_IMPORT_FSCK_MS,
		scanSeconds = options.scanSeconds ?? CODE_IMPORT_SCAN_SECONDS,
		chunkBytes = options.chunkBytes ?? CODE_IMPORT_READ_PIECE_BYTES,
		scanBytes = options.scanBytes ?? CODE_IMPORT_SCAN_BYTES;
	if (
		typeof look !== "boolean" ||
		!Number.isSafeInteger(now) ||
		(now as number) < 0 ||
		typeof (source as AsyncIterable<Uint8Array>)?.[Symbol.asyncIterator] !== "function" ||
		typeof sink?.write !== "function" ||
		!Number.isSafeInteger(fsckMs) ||
		fsckMs < 1 ||
		fsckMs > 86_400_000 ||
		!Number.isSafeInteger(scanSeconds) ||
		scanSeconds < 1 ||
		scanSeconds > 86_400 ||
		!Number.isSafeInteger(chunkBytes) ||
		chunkBytes < 1 ||
		chunkBytes > MAX_PIECE ||
		!Number.isSafeInteger(scanBytes) ||
		scanBytes < 1 ||
		scanBytes > CODE_IMPORT_SCAN_BYTES
	)
		throw new Error("INVALID_CODE_HOST_JOB");
	return withJob(job, repository, async (run) => {
		const swept = await run.sh(
			'exec find "$1" -mindepth 1 -maxdepth 1 ! -name "$2" -exec rm -rf -- {} +',
			[run.layout.scratchRoot, posix.basename(run.directory)],
			{ cwd: run.layout.scratchRoot },
		);
		if (swept.status !== 0)
			throw new CodeHostJobFailure("CODE_HOST_SCRATCH_UNAVAILABLE", "the sweep did not end well");
		if ((await free(run)) < CODE_IMPORT_SCRATCH_FACTOR * raw.bytes) throw new CodeHostJobFailure("IMPORT_NO_SPACE");
		const file = `${run.directory}/first.bundle`,
			proof = `${run.directory}/proof.git`;
		// Never more than the bundle's bytes and one: a longer stream is not the bundle, and must not fill the disk.
		const hash = createHash("sha256");
		let taken = 0,
			failure: { error: unknown } | undefined;
		const counted = (async function* () {
			try {
				for await (const chunk of source as AsyncIterable<Uint8Array>) {
					const left = raw.bytes + 1 - taken;
					if (left <= 0) return;
					const piece = chunk.length > left ? chunk.subarray(0, left) : chunk;
					hash.update(piece);
					taken += piece.length;
					yield piece;
				}
			} catch (error) {
				failure = { error };
				throw error;
			}
		})();
		const put = await run.sh('umask 077; set -C; exec cat >"$1"', [file], { stdin: counted });
		// The store's own error says more than a file cut short.
		if (failure) throw failure.error;
		if (put.status !== 0) throw new CodeHostJobFailure(FAILED, `the bundle's copy ended ${put.status}`);
		const measured = await measure(run, file);
		if (
			taken !== raw.bytes ||
			hash.digest("hex") !== raw.sha256 ||
			measured.bytes !== raw.bytes ||
			measured.sha256 !== raw.sha256
		)
			throw new CodeHostJobFailure(DIFFERS);
		await proveHistory(run, file, proof, fsckMs);

		const seen = await refsSeen(run, proof);
		const plan = codeImportRefsPlan({
			repository,
			defaultBranch: raw.defaultBranch,
			refs: seen.refs,
			now: now as number,
		});
		if (plan.mainSha !== raw.mainSha)
			throw new CodeHostJobFailure(DIFFERS, "its default branch is at another commit");
		const main = await mainTree(run, proof, plan.mainSha),
			history = await historyFacts(run, proof, plan.mainSha, now as number),
			scanned = await scanKeys(
				run,
				proof,
				plan.refs.map((ref) => ref.sha),
				main,
				scanSeconds,
				scanBytes,
			);
		const found = codeImportLook({
			bytes: raw.bytes,
			defaultBranch: raw.defaultBranch,
			mainSha: plan.mainSha,
			...history,
			tags: plan.tags,
			branches: plan.branches,
			leftOut: raw.leftOut + plan.leftOut + seen.raw.length,
			files: main.files,
			entries: main.entries,
			biggest: main.biggest,
			lfsPointers: main.lfsPointers,
			submodules: main.submodules,
			refused: main.refused,
			secrets: scanned.secrets,
			scan: scanned.scan,
			why: main.refused?.code ?? null,
		});
		if (look || found.why !== null) return { state: "looked", look: found };

		// The plan, after the refs whose names are not UTF-8: one update-ref session, each transaction whole.
		const removals = seen.raw.length
			? Buffer.concat([
					Buffer.from("start\0", "latin1"),
					...seen.raw.map((ref) =>
						Buffer.concat([Buffer.from("delete ", "latin1"), ref.name, Buffer.from(`\0${ref.sha}\0`, "latin1")]),
					),
					Buffer.from("prepare\0commit\0", "latin1"),
				])
			: Buffer.alloc(0);
		const stdin = Buffer.concat([removals, plan.stdin]);
		if (stdin.length)
			ok(await run.git(proof, ["update-ref", "--no-deref", "-z", "--stdin"], { stdin }), REFS_FAILED, "update-ref");
		ok(await run.git(proof, ["symbolic-ref", "HEAD", "refs/heads/main"]), REFS_FAILED, "symbolic-ref");
		if (codeRefsSha256(await refsOf(run, proof)) !== plan.refsSha256)
			throw new CodeHostJobFailure(REFS_FAILED, "the refs are not the plan's");

		const kept = `${run.directory}/kept.bundle`,
			again = `${run.directory}/kept.git`;
		ok(
			await run.git(proof, ["bundle", "create", "--quiet", kept, "--all"]),
			"CODE_HOST_BUNDLE_FAILED",
			"bundle create",
		);
		const bundle = await measure(run, kept);
		if (bundle.bytes > CODE_BUNDLE_MAXIMUM_BYTES)
			throw new CodeHostRefusal("CODE_HOST_BUNDLE_TOO_LARGE", [`${bundle.bytes} bytes`]);
		// Care's proof: the bundle restores every ref the plan keeps, in a repository that borrows nothing.
		ok(await run.git(again, [...INIT, again]), "CODE_HOST_BUNDLE_FAILED", "an init");
		ok(await run.git(again, ["bundle", "verify", "--quiet", kept]), "CODE_HOST_BUNDLE_FAILED", "bundle verify");
		ok(await run.git(again, [...FETCH, kept, "+refs/*:refs/*"]), "CODE_HOST_BUNDLE_FAILED", "a fetch");
		if (codeRefsSha256(await refsOf(run, again)) !== plan.refsSha256)
			throw new CodeHostJobFailure("CODE_HOST_BUNDLE_FAILED", "the bundle does not restore every ref");
		ok(await run.command(["/usr/bin/rm", "-rf", "--", again]), FAILED, "a removal");
		const gitVersion = ok(await run.git(proof, ["version"]), "CODE_HOST_BUNDLE_FAILED", "git version")
			.toString("utf8")
			.trim()
			.replace(/^git version /, "");
		if (!gitVersion || gitVersion.length > 100)
			throw new CodeHostJobFailure("CODE_HOST_BUNDLE_FAILED", "git version");
		await readOut(run, kept, bundle, chunkBytes, (piece) => sink.write(piece));
		return {
			state: "kept",
			look: found,
			bundle: {
				sha256: bundle.sha256,
				bytes: bundle.bytes,
				gitVersion,
				refs: plan.refs,
				refsSha256: plan.refsSha256,
				mainSha: plan.mainSha,
			},
		};
	});
}

/** The import's code host jobs as part C3's run takes them (`CodeImportJobs`). */
export const CODE_HOST_IMPORT_JOBS: CodeImportJobs = Object.freeze({
	read: readIncomingCodeBundle,
	look: lookCodeImport,
});
