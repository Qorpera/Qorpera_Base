import { createHash } from "node:crypto";
import { posix } from "node:path";
import {
	type CloudCodingRepository,
	folderKey,
	isUuid,
	parseCloudCodingRepository,
	SHA256_HEX_PATTERN,
} from "@qorpera/contracts";
import {
	CODE_BUNDLE_MAXIMUM_BYTES,
	CODE_BUNDLE_NAME,
	type CodeBundleManifest,
	type CodeBundleStore,
	type CodeBundleTarget,
	type CodeBundleWriter,
	codeBundleName,
} from "./code-bundle-store.ts";
import {
	type bundleCodeArea,
	CODE_AREA_CONFIG,
	CODE_AREA_IN_QORPERA_REF,
	CODE_AREA_RESTORING,
	type CodeAreaRef,
	type CodeHostJob,
	CodeHostJobFailure,
	CodeHostRefusal,
	type checkCodeArea,
	closed,
	codeRefsSha256,
	keptRefs,
	keptRepositoryOf,
	MAX_PACK,
	MAX_READ,
	moveBase,
	type Run,
	SHA,
	SHA256,
	tail,
	withJob,
	ZERO,
} from "./code-host-jobs.ts";
import type { CodeHostJobs } from "./code-host-views.ts";
import { CodingControlBusy } from "./coding-executor.ts";

/** Restore of a repository kept in Qorpera from a stored bundle (own code storage, step 2b, part R): the code host's
 * jobs, and `CodeRestore`, the coding executor's side of a restore request (`qorpera_code_requests`, kind `restore`,
 * migration `20260930720000`). Only an operator asks for one.
 *
 * A restore never repairs in place. It closes the place, moves what it holds aside, builds the repository again from
 * the bundle and opens the place, each in a job of its own:
 *
 *   close      prove the bundle, then write the mark `code/<owner>/<name>/restoring.json`. From its save on, every other
 *              job is refused there (`Run.prepare`, `CODE_HOST_RESTORE_IN_PROGRESS`). A bundle that was just taken of
 *              the place so that nothing is lost (`fresh`) closes it only while the place's refs are still the
 *              bundle's.
 *   set aside  move everything the place holds but the mark to `code/_set-aside/<owner>/at-<UTC>/<name>/`, one rename
 *              each. The mark says `emptied` only once a later job, which sees what the folder saved, finds nothing left.
 *   build      prove the bundle again, then make `repo.git` from it: the packs, every ref but the default branch, then
 *              that branch and `main/` together (`moveBase`). The mark stays.
 *   open       a job of its own sees the bundle's repository whole, has the restore written into the change record
 *              (`qorpera_code_restore_record`) while the place is still closed, and only then removes the mark.
 *
 * Each job is safe whatever part of what it wrote the folder saved, and can be run again: the mark is saved before
 * anything moves and goes after everything else is saved and seen, a move is never taken for done before a later job
 * saw it, a ref is made only from nothing or left as it is, and nothing is ever deleted but the mark. A job that fails
 * or is cancelled saves nothing but refs, which are saved where git commits them: so no job both takes the old
 * `repo.git` away and writes new refs, and the place stays closed from before the first move until after the last ref.
 * A place that was closed and never touched is opened again as it was (`reopenCodeArea`). */

export const CODE_RESTORING_SCHEMA = "qorpera.code-restoring/v1";
/** Where a restore puts what a place held, under `code/`. It can be no owner: an owner has no underscore. */
export const CODE_SET_ASIDE_FOLDER = "_set-aside";
export const CODE_RESTORE_RPCS = ["qorpera_code_request_step", "qorpera_code_restore_record"] as const;

/** A stored bundle as its manifest gives it (`code-bundle-store.ts`). */
export interface CodeRestoreBundle {
	/** The bundle's name in the store, `<UTC>-<main, 12 hex>`. */
	name: string;
	sha256: string;
	bytes: number;
	/** The fingerprint of its refs (`codeRefsSha256`), and its default branch's commit. */
	refsSha256: string;
	mainSha: string;
}

/** The mark of a restore under way, as `restoring.json` holds it. */
export interface CodeRestoringMark {
	schema: typeof CODE_RESTORING_SCHEMA;
	/** The request that closed the place. A later request with the same bundle goes on from it. */
	requestId: string;
	/** The bundle the place is restored from. */
	bundle: string;
	/** When the place was closed, as `YYYYMMDDTHHMMSSZ`: it names the set-aside folder. */
	at: string;
	/** `closed`: the place may still hold what it held. `emptied`: a job saw it hold the mark alone, so whatever is
	 * there besides the mark was built by this restore. */
	step: "closed" | "emptied";
	/** Where the place's content went, once `emptied`; null when there was none. */
	setAside: string | null;
	/** The default branch's commit when the place was closed, when it could be read from its own file. */
	previousMainSha: string | null;
}

const AT = /^\d{8}T\d{6}Z$/;
const FIXED = /^[A-Z][A-Z0-9_]{2,80}$/;
const FAILED = "CODE_HOST_RESTORE_FAILED";
const REFS_MOVED = "CODE_HOST_RESTORE_REFS_MOVED";
const BUNDLE_FAILED = "CODE_HOST_RESTORE_BUNDLE_FAILED";
/** A mark is a few hundred bytes. */
const MAX_MARK = 4096;
/** How many names one command moves: an exec takes at most 64 arguments. */
const MOVE_BATCH = 20;

/** `code/_set-aside/<owner>/at-<UTC>/<name>`: where a restore that closed the place at `at` puts what it held. The
 * fourth part is always `at-<UTC>`, never a name of the company's choosing: the folder reads the fourth part of a path
 * under `code/` to find git's own places, and a repository may be named `worktrees`. */
export function codeSetAsidePath(repository: CloudCodingRepository, at: string): string {
	const { owner, name } = keptRepositoryOf(repository);
	if (typeof at !== "string" || !AT.test(at)) throw new Error("INVALID_CODE_HOST_JOB");
	return `code/${CODE_SET_ASIDE_FOLDER}/${owner}/at-${at}/${name}`;
}

/** The set-aside folder of a restore that closed the place at `at`: its folder path, and it with the three folders
 * above it as the job sees them, outermost first. */
function asideOf(run: Run, at: string): { aside: string; folders: [string, string, string, string] } {
	const aside = codeSetAsidePath(run.repository, at),
		target = `${run.layout.companyRoot}/${aside}`,
		time = posix.dirname(target),
		owner = posix.dirname(time);
	return { aside, folders: [posix.dirname(owner), owner, time, target] };
}

function bundleOf(value: unknown): CodeRestoreBundle {
	const { name, sha256, bytes, refsSha256, mainSha } = closed(value, [
		"name",
		"sha256",
		"bytes",
		"refsSha256",
		"mainSha",
	]);
	if (
		typeof name !== "string" ||
		!CODE_BUNDLE_NAME.test(name) ||
		typeof sha256 !== "string" ||
		!SHA256.test(sha256) ||
		!Number.isSafeInteger(bytes) ||
		(bytes as number) < 1 ||
		typeof refsSha256 !== "string" ||
		!SHA256.test(refsSha256) ||
		typeof mainSha !== "string" ||
		!SHA.test(mainSha) ||
		!name.endsWith(`-${mainSha.slice(0, 12)}`)
	)
		throw new Error("INVALID_CODE_HOST_JOB");
	return { name, sha256, bytes: bytes as number, refsSha256, mainSha };
}

function bundleNameOf(value: unknown): string {
	if (typeof value !== "string" || !CODE_BUNDLE_NAME.test(value)) throw new Error("INVALID_CODE_HOST_JOB");
	return value;
}

function sourceOf(value: unknown): AsyncIterable<Uint8Array> {
	if (typeof (value as AsyncIterable<Uint8Array>)?.[Symbol.asyncIterator] !== "function")
		throw new Error("INVALID_CODE_HOST_JOB");
	return value as AsyncIterable<Uint8Array>;
}

function fsckMsOf(options: { fsckMs?: number } | undefined): number {
	const fsckMs = options?.fsckMs ?? 1_800_000;
	if (!Number.isSafeInteger(fsckMs) || fsckMs < 1 || fsckMs > 86_400_000) throw new Error("INVALID_CODE_HOST_JOB");
	return fsckMs;
}

/** What stands at each path, by plain file tests: a folder (`folders`) or a file is there, or nothing. A link is
 * refused, and so is anything else. A restore looks at a place this way, never through `Run.prepare`: a damaged place
 * may hold what that refuses, and nothing in it is repaired. */
async function plain(run: Run, folders: readonly string[], files: readonly string[]): Promise<Map<string, string>> {
	const paths = [...folders, ...files],
		types = await run.types(paths),
		type = new Map<string, string>(paths.map((path, index) => [path, types[index] as string]));
	const links = paths.filter((path) => type.get(path) === "link");
	if (links.length)
		throw new CodeHostRefusal(
			"CODE_HOST_LINK",
			links.map((path) => run.relative(path)),
		);
	const wrong = [
		...folders.filter((path) => !["none", "directory"].includes(type.get(path) as string)),
		...files.filter((path) => !["none", "file"].includes(type.get(path) as string)),
	];
	if (wrong.length)
		throw new CodeHostRefusal(
			"CODE_HOST_UNEXPECTED_FILE",
			wrong.map((path) => run.relative(path)),
		);
	return type;
}

/** The names in a folder, sorted. */
async function namesIn(run: Run, folder: string): Promise<string[]> {
	const listed = await run.command(["/usr/bin/find", folder, "-mindepth", "1", "-maxdepth", "1", "-printf", "%f\\0"], {
		maximumOutputBytes: MAX_READ,
	});
	if (listed.status !== 0) throw new CodeHostJobFailure("CODE_HOST_INSPECT_FAILED", tail(listed.stderr));
	return listed.stdout.toString("utf8").split("\0").filter(Boolean).sort();
}

function markOf(run: Run, text: string): CodeRestoringMark {
	const unreadable = () =>
		new CodeHostRefusal("CODE_HOST_RESTORE_MARK_UNREADABLE", [`${run.area}/${CODE_AREA_RESTORING}`]);
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw unreadable();
	}
	const keys = ["schema", "requestId", "bundle", "at", "step", "setAside", "previousMainSha"] as const;
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).sort().join() !== [...keys].sort().join()
	)
		throw unreadable();
	const { schema, requestId, bundle, at, step, setAside, previousMainSha } = value as Record<
		(typeof keys)[number],
		unknown
	>;
	if (
		schema !== CODE_RESTORING_SCHEMA ||
		!isUuid(requestId) ||
		typeof bundle !== "string" ||
		!CODE_BUNDLE_NAME.test(bundle) ||
		typeof at !== "string" ||
		!AT.test(at) ||
		(step !== "closed" && step !== "emptied") ||
		// What was set aside is where this restore's own time says, and nowhere before the place was seen empty.
		!(setAside === null || (step === "emptied" && setAside === codeSetAsidePath(run.repository, at))) ||
		!(previousMainSha === null || (typeof previousMainSha === "string" && SHA.test(previousMainSha)))
	)
		throw unreadable();
	return { schema: CODE_RESTORING_SCHEMA, requestId, bundle, at, step, setAside, previousMainSha };
}

/** The place and its mark, by plain file tests. */
async function lookAt(run: Run): Promise<{ there: boolean; mark: CodeRestoringMark | null }> {
	const file = `${run.code}/${CODE_AREA_RESTORING}`,
		type = await plain(run, [`${run.layout.companyRoot}/code`, posix.dirname(run.code), run.code], [file]);
	const there = type.get(run.code) === "directory";
	if (type.get(file) !== "file") return { there, mark: null };
	const read = await run.sh('exec head -c "$2" -- "$1"', [file, String(MAX_MARK + 1)], {
		maximumOutputBytes: MAX_MARK + 1,
	});
	if (read.status !== 0) throw new CodeHostJobFailure("CODE_HOST_READ_FAILED", tail(read.stderr));
	return { there, mark: markOf(run, read.stdout.length > MAX_MARK ? "" : read.stdout.toString("utf8")) };
}

/** The mark through a file of its own beside it and a rename over it, so a reader never finds half a mark. */
async function writeMark(run: Run, mark: CodeRestoringMark): Promise<void> {
	const wrote = await run.sh(
		'umask 022; rm -f -- "$1.lock" && printf %s "$2" >"$1.lock" && exec mv -fT -- "$1.lock" "$1"',
		[`${run.code}/${CODE_AREA_RESTORING}`, `${JSON.stringify(mark)}\n`],
	);
	if (wrote.status !== 0) throw new CodeHostJobFailure("CODE_HOST_WRITE_FAILED", tail(wrote.stderr));
}

/** The mark that must be there for a job on `bundle`. */
function markFor(run: Run, mark: CodeRestoringMark | null, bundle: string): CodeRestoringMark {
	if (!mark) throw new CodeHostRefusal("CODE_HOST_RESTORE_NOT_CLOSED", [run.area]);
	if (mark.bundle !== bundle) throw new CodeHostRefusal("CODE_HOST_RESTORE_OTHER_BUNDLE", [mark.bundle]);
	return mark;
}

/** `git fsck --full` in the proof repository, stopped after its time (TERM, and KILL 10 s later). What it said stays in
 * the scratch; its start goes to stderr for the report. */
const FSCK = `out=$1 seconds=$2; shift 2
timeout -k 10 "$seconds" "$@" >"$out" 2>&1
status=$?
head -c 2000 -- "$out" >&2
exit "$status"`;

interface Proven {
	/** The scratch repository that holds the bundle's every ref and object, repacked for the folder. */
	proof: string;
	refs: CodeAreaRef[];
	packs: string[];
}

/** A stored bundle proven to restore, in the job's scratch on the code host's own disk, before anything in the folder
 * is touched; and proven to be one the folder can hold, so a restore never finds that out with the place already
 * closed. The bytes that came are the manifest's (their SHA-256 and size, taken as they were handed over and again in
 * the code host). Then the proof nightly care's bundle job ran before the bundle left: `bundle verify`, a fetch of
 * `+refs/*:refs/*` into a new bare repository that borrows nothing, whose refs must have the manifest's fingerprint,
 * with the mark and the default branch among them, the branch at the manifest's commit; and `git fsck --full` there.
 * No two of its refs may be one name to the folder, the default branch's files must pass the folder's name rules, and
 * its packs must each be under the folder's limit. */
async function prove(
	run: Run,
	bundle: CodeRestoreBundle,
	source: AsyncIterable<Uint8Array>,
	fsckMs: number,
): Promise<Proven> {
	const file = `${run.directory}/restore.bundle`,
		proof = `${run.directory}/proof.git`,
		base = `refs/heads/${run.repository.baseBranch}`;
	// Room for the bundle, the repository fetched from it and that repository repacked.
	const room = await run.sh('exec stat -f -c "%a %S" -- "$1"', [run.directory]),
		[, blocks, size] = /^(\d+) (\d+)\n$/.exec(room.stdout.toString("latin1")) ?? [],
		free = Number(blocks) * Number(size);
	if (room.status !== 0 || !Number.isFinite(free)) throw new CodeHostJobFailure(FAILED, tail(room.stderr));
	if (free < 3 * bundle.bytes)
		throw new CodeHostRefusal("CODE_HOST_RESTORE_NO_SPACE", [
			`${3 * bundle.bytes} bytes needed`,
			`${free} bytes free`,
		]);
	const hash = createHash("sha256");
	let taken = 0,
		failure: { error: unknown } | undefined;
	// Never more than the manifest's bytes and one: a longer stream is not the bundle, and must not fill the disk.
	const counted = (async function* () {
		try {
			for await (const chunk of source) {
				const left = bundle.bytes + 1 - taken;
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
	if (put.status !== 0) throw new CodeHostJobFailure("CODE_HOST_RESTORE_BUNDLE_UNREADABLE", tail(put.stderr));
	const measured = await run.sh('sha256sum <"$1" && exec wc -c <"$1"', [file]),
		[, sha256, bytes] = /^([0-9a-f]{64}) [ *]-\n *(\d+)\n$/.exec(measured.stdout.toString("latin1")) ?? [];
	if (measured.status !== 0 || !sha256)
		throw new CodeHostJobFailure("CODE_HOST_RESTORE_BUNDLE_UNREADABLE", tail(measured.stderr));
	if (
		taken !== bundle.bytes ||
		hash.digest("hex") !== bundle.sha256 ||
		Number(bytes) !== bundle.bytes ||
		sha256 !== bundle.sha256
	)
		throw new CodeHostRefusal("CODE_HOST_RESTORE_BUNDLE_DIFFERS", [bundle.name]);
	await run.gitOk(proof, ["init", "--quiet", "--bare", "--template=", "--ref-format=files", proof], BUNDLE_FAILED);
	await run.gitOk(proof, ["bundle", "verify", "--quiet", file], BUNDLE_FAILED);
	// The bundle also names each worktree's HEAD, outside refs/: a restore makes no worktree, so those stay behind.
	await run.gitOk(
		proof,
		["fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", file, "+refs/*:refs/*"],
		BUNDLE_FAILED,
	);
	const listed = await run.refs(proof),
		refs = listed.map(({ name, sha }) => ({ name, sha }));
	if (
		listed.some((ref) => ref.symref || !/^refs\/[^\s\0]+$/.test(ref.name)) ||
		codeRefsSha256(refs) !== bundle.refsSha256
	)
		throw new CodeHostRefusal("CODE_HOST_RESTORE_BUNDLE_REFS_DIFFER", [bundle.name]);
	const commit = (ref: string) => listed.find((entry) => entry.name === ref && entry.type === "commit")?.sha;
	if (commit(CODE_AREA_IN_QORPERA_REF) === undefined || commit(base) === undefined)
		throw new CodeHostRefusal("CODE_HOST_RESTORE_BUNDLE_NOT_KEPT", [bundle.name]);
	if (commit(base) !== bundle.mainSha)
		throw new CodeHostRefusal("CODE_HOST_RESTORE_BUNDLE_MAIN_DIFFERS", [bundle.name]);
	// Each ref becomes a file of its name in the folder, where names that differ only by case are one name.
	const spelled = new Map<string, string>(),
		clash = new Set<string>();
	for (const { name } of refs) {
		const parts = name.split("/");
		for (let depth = 1; depth <= parts.length; depth += 1) {
			const path = parts.slice(0, depth).join("/"),
				// A ref's own name must be no other ref's folder.
				kind = depth === parts.length ? "ref" : "folder",
				key = path.split("/").map(folderKey).join("/"),
				other = spelled.get(key);
			if (other === undefined) spelled.set(key, `${kind} ${path}`);
			else if (other !== `${kind} ${path}`) clash.add(name);
		}
	}
	if (clash.size) throw new CodeHostRefusal("CODE_HOST_RESTORE_REFS_DIFFER_BY_CASE", [...clash]);
	const checked = await run.sh(FSCK, [
		`${run.directory}/fsck.out`,
		String(fsckMs / 1000),
		run.layout.git,
		"--no-replace-objects",
		`--git-dir=${proof}`,
		"fsck",
		"--full",
		"--no-dangling",
		"--no-progress",
	]);
	if (checked.status === 124 || checked.status === 137)
		throw new CodeHostJobFailure("CODE_HOST_RESTORE_BUNDLE_FSCK_TIMEOUT");
	if (checked.status !== 0) throw new CodeHostJobFailure("CODE_HOST_RESTORE_BUNDLE_DAMAGED", tail(checked.stderr));
	// What `main/` will hold: refused here, naming the paths, as a landing refuses them.
	await run.checkNames(proof, bundle.mainSha);
	// Self-contained packs under the folder's limit (the job's settings split them), as a seed's. One thread: the same
	// bundle gives the same packs, so a build that is run again adds no second copy of them.
	await run.gitOk(proof, ["-c", "pack.threads=1", "repack", "-a", "-d", "-q"], BUNDLE_FAILED);
	const found = await run.command([
		"/usr/bin/find",
		`${proof}/objects/pack`,
		"-maxdepth",
		"1",
		"-type",
		"f",
		"-name",
		"pack-*.pack",
		"-printf",
		"%s %p\\n",
	]);
	if (found.status !== 0) throw new CodeHostJobFailure(BUNDLE_FAILED, tail(found.stderr));
	const packs = found.stdout
		.toString("utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const space = line.indexOf(" ");
			return { size: Number(line.slice(0, space)), path: line.slice(space + 1) };
		});
	const large = packs.filter((pack) => !(pack.size < MAX_PACK));
	if (large.length)
		throw new CodeHostRefusal(
			"CODE_HOST_PACK_TOO_LARGE",
			large.map((pack) => `${pack.size} bytes`),
		);
	if (packs.length === 0) throw new CodeHostJobFailure(BUNDLE_FAILED, "the bundle's repository has no pack");
	return { proof, refs, packs: packs.map((pack) => pack.path).sort() };
}

/** A restore's first look, and mode `verify` whole: a stored bundle proven to restore (`prove`), with nothing written
 * and nothing read in the company folder. Refusals (`CodeHostRefusal`): `CODE_HOST_RESTORE_NO_SPACE` (three times the
 * bundle must be free in the scratch), `CODE_HOST_RESTORE_BUNDLE_DIFFERS` (the bytes are not the manifest's),
 * `CODE_HOST_RESTORE_BUNDLE_REFS_DIFFER`, `CODE_HOST_RESTORE_BUNDLE_NOT_KEPT` (no mark or no default branch),
 * `CODE_HOST_RESTORE_BUNDLE_MAIN_DIFFERS`, `CODE_HOST_RESTORE_REFS_DIFFER_BY_CASE`, the folder's name rules for the
 * default branch's files and `CODE_HOST_PACK_TOO_LARGE`. Failures (`CodeHostJobFailure`):
 * `CODE_HOST_RESTORE_BUNDLE_FAILED` (git could not verify or fetch it), `CODE_HOST_RESTORE_BUNDLE_DAMAGED` (fsck found
 * problems) and `CODE_HOST_RESTORE_BUNDLE_FSCK_TIMEOUT` (after `fsckMs`, default 30 minutes). */
export async function verifyCodeBundle(
	job: CodeHostJob,
	value: { repository: CloudCodingRepository; bundle: CodeRestoreBundle },
	source: AsyncIterable<Uint8Array>,
	options: { fsckMs?: number } = {},
): Promise<{ mainSha: string; refsSha256: string; refs: number }> {
	const input = closed(value, ["repository", "bundle"]);
	const repository = keptRepositoryOf(input.repository),
		bundle = bundleOf(input.bundle),
		bytes = sourceOf(source),
		fsckMs = fsckMsOf(options);
	return withJob(job, repository, async (run) => {
		const proven = await prove(run, bundle, bytes, fsckMs);
		return { mainSha: bundle.mainSha, refsSha256: bundle.refsSha256, refs: proven.refs.length };
	});
}

export interface CodeAreaClosed {
	/** `closed`: this job wrote the mark. `present`: the mark was there, from an earlier run. */
	state: "closed" | "present";
	/** The mark's time, its step, and where the place's content went, as the mark now says. */
	at: string;
	step: "closed" | "emptied";
	setAside: string | null;
	previousMainSha: string | null;
}

/** A restore's first change: the bundle is proven (`prove`), and only then is the place closed, by the mark
 * `restoring.json` (in a folder made for it when the place is gone). Nothing else is written, and nothing of what the
 * place holds is read by git or repaired. A mark already there stays: of this bundle, the restore goes on from it; of
 * another, it is given this bundle only while nothing of the other one is built in the place (its content is still
 * there, or the mark stands alone), and refused otherwise (`CODE_HOST_RESTORE_OTHER_BUNDLE`, naming the other). A mark
 * that is no mark of ours is refused (`CODE_HOST_RESTORE_MARK_UNREADABLE`).
 *
 * `fresh` says the bundle was just taken of this place so that the restore loses nothing: it must still be all the
 * place holds when the place is closed. So right before the mark is written, in this job, the place's refs are read
 * as the bundle's job read them (the place made ready as for every job, then every ref by git), and their fingerprint
 * (`codeRefsSha256`) must be the bundle's. A place that has moved on since (a change landed, a session committed on
 * its branch, a ref came or went) or that is gone is refused, `CODE_HOST_RESTORE_REFS_MOVED`: no mark is written, and
 * the caller takes a new bundle. A place that already has its mark is not asked: it has not been open since the mark
 * was written. A bundle that was asked for by its name is not `fresh`: it closes whatever the place holds, since
 * there the operator chose to go back. */
export async function closeCodeArea(
	job: CodeHostJob,
	value: {
		repository: CloudCodingRepository;
		requestId: string;
		bundle: CodeRestoreBundle;
		at: string;
		fresh: boolean;
	},
	source: AsyncIterable<Uint8Array>,
	options: { fsckMs?: number } = {},
): Promise<CodeAreaClosed> {
	const input = closed(value, ["repository", "requestId", "bundle", "at", "fresh"]);
	const repository = keptRepositoryOf(input.repository),
		bundle = bundleOf(input.bundle),
		bytes = sourceOf(source),
		fsckMs = fsckMsOf(options),
		{ requestId, at, fresh } = input;
	if (!isUuid(requestId) || typeof at !== "string" || !AT.test(at) || typeof fresh !== "boolean")
		throw new Error("INVALID_CODE_HOST_JOB");
	return withJob(job, repository, async (run) => {
		await prove(run, bundle, bytes, fsckMs);
		const { there, mark } = await lookAt(run);
		if (mark) {
			if (mark.bundle !== bundle.name) {
				if (mark.step === "emptied" && (await namesIn(run, run.code)).length > 1)
					throw new CodeHostRefusal("CODE_HOST_RESTORE_OTHER_BUNDLE", [mark.bundle]);
				await writeMark(run, { ...mark, bundle: bundle.name });
			}
			const { step, setAside, previousMainSha } = mark;
			return { state: "present", at: mark.at, step, setAside, previousMainSha };
		}
		if (fresh) {
			const whole = there && (await run.prepare()).seeded;
			if (!whole || codeRefsSha256((await keptRefs(run)).refs) !== bundle.refsSha256)
				throw new CodeHostRefusal(REFS_MOVED, [run.area]);
		}
		// Where the default branch stands, for the record: from its own file, never by git in a place that may be damaged.
		let previousMainSha: string | null = null;
		const ref = `${run.repo}/refs/heads/${repository.baseBranch}`;
		if (there) {
			const folders = [run.repo, `${run.repo}/refs`, `${run.repo}/refs/heads`],
				types = await run.types([...folders, ref]);
			if (types.slice(0, 3).every((type) => type === "directory") && types[3] === "file") {
				const read = await run.sh('exec head -c 41 -- "$1"', [ref], { maximumOutputBytes: 41 }),
					line = read.stdout.toString("latin1");
				if (read.status === 0 && /^[0-9a-f]{40}\n$/.test(line)) previousMainSha = line.trim();
			}
		} else {
			const made = await run.sh('umask 022; exec mkdir -p -- "$1"', [run.code]);
			if (made.status !== 0) throw new CodeHostJobFailure(FAILED, tail(made.stderr));
		}
		await writeMark(run, {
			schema: CODE_RESTORING_SCHEMA,
			requestId,
			bundle: bundle.name,
			at,
			step: "closed",
			setAside: null,
			previousMainSha,
		});
		return { state: "closed", at, step: "closed", setAside: null, previousMainSha };
	});
}

/** Whether a restore has a place closed, read from the place itself and nothing else: whether its folder is there,
 * and its mark when it holds one. Plain file tests and one read; nothing is written, and git reads nothing. A file
 * that is no mark of ours is refused (`CODE_HOST_RESTORE_MARK_UNREADABLE`). */
export async function readCodeAreaMark(
	job: CodeHostJob,
	value: { repository: CloudCodingRepository },
): Promise<{ there: boolean; mark: CodeRestoringMark | null }> {
	const input = closed(value, ["repository"]);
	const repository = keptRepositoryOf(input.repository);
	return withJob(job, repository, (run) => lookAt(run));
}

/** Each name moved from one folder into another by one rename, never onto anything, and never by a copy: `mv` copies
 * and deletes where a rename is refused as crossing devices, and half a copy of a repository is worse than none. The
 * names moved are printed. Exit 3: something stands where a name would go. */
const MOVE = `from=$1 to=$2; shift 2
for n do
	if [ -e "$to/$n" ] || [ -L "$to/$n" ]; then exit 3; fi
	mv --no-copy -T -- "$from/$n" "$to/$n" || exit 1
	printf '%s\\0' "$n"
done`;

export interface CodeAreaSetAside {
	/** `moved`: this job moved what the place held; whether the folder kept the move is for the next job to see.
	 * `set-aside`: the place holds the mark alone, and what it held is at `movedTo`. `absent`: the place holds the mark
	 * alone, and held nothing. */
	state: "moved" | "set-aside" | "absent";
	movedTo: string | null;
	/** How many names this job moved. */
	moved: number;
}

/** A restore's second step, on a place closed for `bundle`: everything the place holds but the mark is moved, as it
 * is, to `code/_set-aside/<owner>/at-<the mark's time>/<name>/`, each name by one rename. Nothing is read by git,
 * repaired or deleted, so a session's uncommitted files go along. The job that moves answers `moved`, and writes
 * nothing else. A job that finds the mark alone (it sees what the folder saved of the moves) writes `emptied` and
 * where the content went into the mark, and answers `set-aside` or `absent`; from then on it answers the same. So the
 * caller runs it until it stops answering `moved`. A name that is already in the set-aside folder is never written
 * over (`CODE_HOST_RESTORE_SET_ASIDE_IN_THE_WAY`); without an `mv` that can refuse to copy, nothing is moved
 * (`CODE_HOST_RESTORE_NO_SAFE_MOVE`); a place with no mark is refused (`CODE_HOST_RESTORE_NOT_CLOSED`). */
export async function setAsideCodeArea(
	job: CodeHostJob,
	value: { repository: CloudCodingRepository; bundle: string },
): Promise<CodeAreaSetAside> {
	const input = closed(value, ["repository", "bundle"]);
	const repository = keptRepositoryOf(input.repository),
		bundle = bundleNameOf(input.bundle);
	return withJob(job, repository, async (run) => {
		const mark = markFor(run, (await lookAt(run)).mark, bundle);
		if (mark.step === "emptied")
			return { state: mark.setAside ? "set-aside" : "absent", movedTo: mark.setAside, moved: 0 };
		const { aside, folders } = asideOf(run, mark.at),
			target = folders[3];
		const type = await plain(run, folders, []),
			held = (await namesIn(run, run.code)).filter((name) => name !== CODE_AREA_RESTORING),
			there = type.get(target) === "directory" ? await namesIn(run, target) : [];
		if (held.length === 0) {
			const setAside = there.length ? aside : null;
			await writeMark(run, { ...mark, step: "emptied", setAside });
			return { state: setAside ? "set-aside" : "absent", movedTo: setAside, moved: 0 };
		}
		const taken = new Set(there.map(folderKey)),
			inTheWay = held.filter((name) => taken.has(folderKey(name)));
		if (inTheWay.length)
			throw new CodeHostRefusal(
				"CODE_HOST_RESTORE_SET_ASIDE_IN_THE_WAY",
				inTheWay.map((name) => `${aside}/${name}`),
			);
		if ((await run.sh("exec mv --no-copy --version >/dev/null 2>&1", [])).status !== 0)
			throw new CodeHostRefusal("CODE_HOST_RESTORE_NO_SAFE_MOVE", [run.area]);
		const made = await run.sh('umask 022; exec mkdir -p -- "$1"', [target]);
		if (made.status !== 0) throw new CodeHostJobFailure("CODE_HOST_RESTORE_MOVE_FAILED", tail(made.stderr));
		let moved = 0;
		for (let index = 0; index < held.length; index += MOVE_BATCH) {
			const part = held.slice(index, index + MOVE_BATCH),
				result = await run.sh(MOVE, [run.code, target, ...part], { maximumOutputBytes: MAX_READ });
			moved += result.stdout.toString("utf8").split("\0").filter(Boolean).length;
			if (result.status !== 0)
				throw new CodeHostJobFailure(
					"CODE_HOST_RESTORE_MOVE_FAILED",
					result.status === 3 ? "a name is already in the set-aside folder" : tail(result.stderr),
				);
		}
		return { state: "moved", movedTo: aside, moved };
	});
}

/** A restore's third step, on a place a job saw empty (the mark says `emptied`, for `bundle`): the repository is built
 * again. The bundle is proven once more in this job's scratch (`prove`) before the place is touched. Then `repo.git`
 * is made with the platform's config and `HEAD` at the default branch (a bundle says which commit `HEAD` is at, never
 * which branch, so nothing is taken from its `HEAD`); the proof's packs enter through `git index-pack`; every ref of
 * the bundle but the default branch is made in one `update-ref` transaction, each from nothing; and last the default
 * branch and `main/` move together (`moveBase`). The bundle's lines outside `refs/` (each worktree's `HEAD`) are not
 * restored: a restore makes no worktree, and a session's next turn adds its own again from its branch. The mark stays:
 * the place is opened by `openCodeArea`, in a job that sees what this one saved.
 *
 * It can be run again after a stop at any point. The place may hold only the mark and what an earlier run of this
 * step made (`repo.git`, `main`), and each ref there must be the bundle's ref at the bundle's commit
 * (`CODE_HOST_RESTORE_PLACE_CHANGED` otherwise, naming what is in the way); such a ref is left as it is. A place whose
 * mark does not say `emptied` is refused (`CODE_HOST_RESTORE_NOT_SET_ASIDE`). It answers the repository's default
 * branch, the refs' fingerprint and how many refs there are, which are the bundle's. */
export async function restoreCodeArea(
	job: CodeHostJob,
	value: { repository: CloudCodingRepository; bundle: CodeRestoreBundle },
	source: AsyncIterable<Uint8Array>,
	options: { fsckMs?: number } = {},
): Promise<{ mainSha: string; refsSha256: string; refs: number }> {
	const input = closed(value, ["repository", "bundle"]);
	const repository = keptRepositoryOf(input.repository),
		bundle = bundleOf(input.bundle),
		bytes = sourceOf(source),
		fsckMs = fsckMsOf(options),
		base = `refs/heads/${repository.baseBranch}`;
	return withJob(job, repository, async (run) => {
		const mark = markFor(run, (await lookAt(run)).mark, bundle.name);
		if (mark.step !== "emptied") throw new CodeHostRefusal("CODE_HOST_RESTORE_NOT_SET_ASIDE", [run.area]);
		const strange = (await namesIn(run, run.code)).filter(
			(name) => ![CODE_AREA_RESTORING, "repo.git", "main"].includes(name),
		);
		if (strange.length)
			throw new CodeHostRefusal(
				"CODE_HOST_RESTORE_PLACE_CHANGED",
				strange.map((name) => `${run.area}/${name}`),
			);
		const proven = await prove(run, bundle, bytes, fsckMs);
		// From here on the place is written. Its git files are the platform's own before git reads one.
		const area = await run.prepare(undefined, { restoring: true });
		if (!area.seeded)
			// git takes a repo.git without HEAD for a new one: it writes HEAD and keeps any refs and objects there.
			await run.gitOk(
				run.repo,
				[
					"init",
					"--quiet",
					"--bare",
					"--template=",
					"--ref-format=files",
					`--initial-branch=${repository.baseBranch}`,
					run.repo,
				],
				FAILED,
			);
		await run.keep(`${run.repo}/config`, CODE_AREA_CONFIG);
		await run.keep(`${run.repo}/HEAD`, `ref: ${base}\n`);
		// What an earlier run made: only the bundle's refs, each at the bundle's commit.
		const wanted = new Map(proven.refs.map((ref) => [ref.name, ref.sha])),
			made = await run.refs(run.repo),
			other = made.filter((ref) => ref.symref || wanted.get(ref.name) !== ref.sha);
		if (other.length)
			throw new CodeHostRefusal(
				"CODE_HOST_RESTORE_PLACE_CHANGED",
				other.map((ref) => ref.name),
			);
		// git's own temporary-then-rename for each pack; the folder publishes them with the first ref below.
		for (const pack of proven.packs) {
			const indexed = await run.sh('f=$1; shift; exec "$@" <"$f"', [
				pack,
				run.layout.git,
				"--no-replace-objects",
				`--git-dir=${run.repo}`,
				"index-pack",
				"--stdin",
			]);
			if (indexed.status !== 0) throw new CodeHostJobFailure(FAILED, tail(indexed.stderr));
		}
		const here = new Set(made.map((ref) => ref.name)),
			create = proven.refs.filter((ref) => ref.name !== base && !here.has(ref.name));
		if (create.length) {
			const lines = ["start", ...create.map((ref) => `create ${ref.name} ${ref.sha}`), "prepare", "commit", ""];
			const created = await run.git(run.repo, ["update-ref", "--no-deref", "--stdin"], {
				stdin: Buffer.from(lines.join("\n"), "utf8"),
			});
			if (created.status !== 0) throw new CodeHostJobFailure("CODE_HOST_RESTORE_REFS_FAILED", tail(created.stderr));
		}
		// A main/ this job did not find whole beside a repository that was is made again, never trusted.
		const main = area.main === "none" ? "none" : area.seeded && area.main === "present" ? "present" : "partial";
		await moveBase(run, main, base, bundle.mainSha, here.has(base) ? bundle.mainSha : ZERO);
		const built = await keptRefs(run);
		if (built.mainSha !== bundle.mainSha || codeRefsSha256(built.refs) !== bundle.refsSha256)
			throw new CodeHostJobFailure(FAILED, "the repository built is not the bundle's");
		return { mainSha: built.mainSha, refsSha256: bundle.refsSha256, refs: built.refs.length };
	});
}

/** The commits among `commits` that the repository holds. */
async function held(run: Run, commits: readonly string[]): Promise<Set<string>> {
	const asked = [...new Set(commits)],
		found = new Set<string>();
	if (asked.length === 0) return found;
	const out = await run.gitOk(run.repo, ["cat-file", "--batch-check"], FAILED, {
		stdin: Buffer.from(asked.map((commit) => `${commit}\n`).join("")),
		maximumOutputBytes: MAX_READ,
	});
	const lines = out.toString("latin1").split("\n");
	if (lines.pop() !== "" || lines.length !== asked.length) throw new CodeHostJobFailure(FAILED, "cat-file");
	lines.forEach((line, index) => {
		const [name, type] = line.split(" ");
		if (name !== asked[index]) throw new CodeHostJobFailure(FAILED, "cat-file");
		if (type === "commit") found.add(name);
	});
	return found;
}

/** What `openCodeArea` found, as it hands it to its `record` before the mark goes. */
export interface CodeAreaOpening {
	mainSha: string;
	/** The sessions among `sessions` that have neither their branch nor their base commit here: their next turn could
	 * not start. */
	stranded: string[];
	/** Where the default branch stood when the place was closed, as the mark said; null without a mark. */
	previousMainSha: string | null;
}

export interface CodeAreaOpened extends CodeAreaOpening {
	/** `opened`: this job removed the mark. `open`: there was none, and the place holds the restored repository. */
	state: "opened" | "open";
}

/** A restore's last step, in a job that sees what the build saved. With the mark there (for `bundle`, saying
 * `emptied`), the place must hold exactly the mark, `repo.git` and `main/`; the repository's refs must have the
 * bundle's fingerprint, with the default branch at the bundle's commit; and `main/` must be at it
 * (`CODE_HOST_RESTORE_NOT_BUILT` otherwise: the place stays closed, and the build is run again). Then `record` is
 * called with what was found, and only once it has answered does the mark go, which opens the place to every other
 * job. `record` is where the caller writes the restore into the change record: the place is still closed and this job
 * holds its company's line, so no landing can come between the restored default branch and its record, as a landing
 * writes its own row inside its own job. When `record` rejects, the mark stays and the job fails with its error. With
 * no mark, the place must hold a repository kept in Qorpera that has the bundle's default branch commit: an earlier
 * run of this step opened it, after its `record` had answered, and `record` is not called again. Either way it
 * answers `stranded`, from the repository's sessions as the request named them (at most 1,000). */
export async function openCodeArea(
	job: CodeHostJob,
	value: {
		repository: CloudCodingRepository;
		bundle: CodeRestoreBundle;
		sessions: readonly { workerId: string; baseSha: string }[];
	},
	record: (place: CodeAreaOpening) => Promise<void>,
): Promise<CodeAreaOpened> {
	const input = closed(value, ["repository", "bundle", "sessions"]);
	const repository = keptRepositoryOf(input.repository),
		bundle = bundleOf(input.bundle),
		{ sessions } = input;
	if (
		typeof record !== "function" ||
		!Array.isArray(sessions) ||
		sessions.length > 1000 ||
		!sessions.every(
			(session) => isUuid(session?.workerId) && typeof session.baseSha === "string" && SHA.test(session.baseSha),
		)
	)
		throw new Error("INVALID_CODE_HOST_JOB");
	const notBuilt = (run: Run, what: string) => new CodeHostRefusal("CODE_HOST_RESTORE_NOT_BUILT", [run.area, what]);
	return withJob(job, repository, async (run) => {
		const { mark } = await lookAt(run);
		let branches: Set<string>;
		if (mark) {
			if (markFor(run, mark, bundle.name).step !== "emptied")
				throw new CodeHostRefusal("CODE_HOST_RESTORE_NOT_SET_ASIDE", [run.area]);
			const names = await namesIn(run, run.code);
			if (names.join() !== [CODE_AREA_RESTORING, "main", "repo.git"].sort().join())
				throw notBuilt(run, "the place does not hold repo.git and main alone");
			const area = await run.prepare(undefined, { restoring: true });
			if (!area.seeded || area.main !== "present") throw notBuilt(run, "repo.git or main is half there");
			const built = await keptRefs(run);
			if (built.mainSha !== bundle.mainSha || codeRefsSha256(built.refs) !== bundle.refsSha256)
				throw notBuilt(run, "the refs are not the bundle's");
			if (!(await run.read(`${run.repo}/worktrees/main/HEAD`))?.equals(Buffer.from(`${bundle.mainSha}\n`)))
				throw notBuilt(run, "main is not at the default branch");
			branches = new Set(built.refs.map((ref) => ref.name));
		} else {
			// Opened by an earlier run: any job may read the place now.
			const area = await run.prepare();
			if (!area.seeded) throw notBuilt(run, "no repository is there");
			branches = new Set((await keptRefs(run)).refs.map((ref) => ref.name));
			if (!(await run.isCommit(run.repo, bundle.mainSha))) throw notBuilt(run, "the bundle's commit is not there");
		}
		const here = await held(
			run,
			sessions.map((session: { baseSha: string }) => session.baseSha),
		);
		const stranded = (sessions as { workerId: string; baseSha: string }[])
			.filter(
				(session) => !branches.has(`refs/heads/qorpera/coding/${session.workerId}`) && !here.has(session.baseSha),
			)
			.map((session) => session.workerId);
		const place: CodeAreaOpening = {
			mainSha: bundle.mainSha,
			stranded,
			previousMainSha: mark?.previousMainSha ?? null,
		};
		if (mark) {
			// The record first, with the place still closed: once the mark is gone a landing may be recorded.
			await record({ ...place, stranded: [...stranded] });
			const removed = await run.command(["/usr/bin/rm", "-f", "--", `${run.code}/${CODE_AREA_RESTORING}`]);
			if (removed.status !== 0) throw new CodeHostJobFailure(FAILED, tail(removed.stderr));
		}
		return { state: mark ? "opened" : "open", ...place };
	});
}

/** The way back from a restore that stopped before it moved anything: a place closed for `bundle` whose mark still
 * says `closed`, and of which nothing is in its set-aside folder, is exactly what it was before the mark; the mark is
 * removed, and so is the folder when it was made for the mark alone. A place with no mark is open already. One that
 * was emptied, or whose content is partly aside, stays closed (`CODE_HOST_RESTORE_HALF_SET_ASIDE`): it opens only once
 * it is built. */
export async function reopenCodeArea(
	job: CodeHostJob,
	value: { repository: CloudCodingRepository; bundle: string },
): Promise<{ state: "reopened" | "open" }> {
	const input = closed(value, ["repository", "bundle"]);
	const repository = keptRepositoryOf(input.repository),
		bundle = bundleNameOf(input.bundle);
	return withJob(job, repository, async (run) => {
		const { mark } = await lookAt(run);
		if (!mark) return { state: "open" };
		const { aside, folders } = asideOf(run, markFor(run, mark, bundle).at),
			target = folders[3],
			type = await plain(run, folders, []);
		if (mark.step !== "closed" || (type.get(target) === "directory" && (await namesIn(run, target)).length > 0))
			throw new CodeHostRefusal("CODE_HOST_RESTORE_HALF_SET_ASIDE", [aside]);
		// Without the mark, a folder that holds nothing else was made for it.
		const removed = await run.sh('rm -f -- "$1/$2" || exit 1; rmdir -- "$1" 2>/dev/null; exit 0', [
			run.code,
			CODE_AREA_RESTORING,
		]);
		if (removed.status !== 0) throw new CodeHostJobFailure(FAILED, tail(removed.stderr));
		return { state: "reopened" };
	});
}

/** One set-aside copy removed, with the folders above it that it leaves empty: `path` is exactly
 * `code/_set-aside/<owner>/at-<UTC>/<name>` of this repository. Answers whether it was there. The copy of a restore
 * that is still under way (the place's mark names that time) is refused (`CODE_HOST_RESTORE_IN_PROGRESS`). */
export async function discardSetAside(
	job: CodeHostJob,
	value: { repository: CloudCodingRepository; path: string },
): Promise<{ removed: boolean }> {
	const input = closed(value, ["repository", "path"]);
	const repository = keptRepositoryOf(input.repository),
		{ path } = input,
		at = typeof path === "string" ? (/\/at-(\d{8}T\d{6}Z)\/[^/]+$/.exec(path)?.[1] ?? "") : "";
	if (!AT.test(at) || path !== codeSetAsidePath(repository, at)) throw new Error("INVALID_CODE_HOST_JOB");
	return withJob(job, repository, async (run) => {
		if ((await lookAt(run)).mark?.at === at) throw new CodeHostRefusal("CODE_HOST_RESTORE_IN_PROGRESS", [run.area]);
		const { folders } = asideOf(run, at),
			[root, owner, time, target] = folders,
			type = await plain(run, folders, []);
		if (type.get(target) !== "directory") return { removed: false };
		const removed = await run.command(["/usr/bin/rm", "-rf", "--", target]);
		if (removed.status !== 0) throw new CodeHostJobFailure("CODE_HOST_RESTORE_DISCARD_FAILED", tail(removed.stderr));
		// Each folder above goes only when it is empty: another copy's folder stays.
		await run.sh('for d do rmdir -- "$d" 2>/dev/null || exit 0; done', [time, owner, root]);
		return { removed: true };
	});
}

// The coding executor's side.

/** A restore request, as `qorpera_code_requests_claim` hands it out. */
export interface CodeRestoreRequest {
	requestId: string;
	/** The request's lease, for its step calls. */
	token: string;
	companyId: string;
	environmentId: string;
	owner: string;
	name: string;
	kind: "restore";
	mode: "verify" | "restore" | "discard";
	/** A stored bundle's name, or `fresh` (mode `restore` only); null for a discard. */
	bundle: string | null;
	damaged: "keep" | "remove" | null;
	/** What an earlier run of the request saved of how far it got. */
	progress: Record<string, unknown> | null;
	/** A discard's set-aside path. */
	path: string | null;
	/** The repository's sessions that are not archived. */
	sessions: readonly { workerId: string; baseSha: string }[];
}

/** How a restore request ended, as `qorpera_code_request_finish` takes it (`qorpera.code-request-outcome/v1`). Which
 * changes the restored default branch still holds is not the executor's to say: the kernel finds that from its rows
 * when the restore is recorded, and keeps it beside this outcome. */
export type CodeRestoreOutcome = { schema: "qorpera.code-request-outcome/v1" } & (
	| { state: "done"; result: "verified"; mainSha: string; refsSha256: string; refs: number }
	| {
			state: "done";
			result: "restored";
			bundle: string;
			mainSha: string;
			previousMainSha: string | null;
			refsSha256: string;
			refs: number;
			stranded: string[];
			movedTo: string | null;
	  }
	| { state: "done"; result: "discarded" }
	| { state: "busy" }
	| { state: "failed"; code: string }
);

export interface CodeRestoreOptions {
	control: { call(method: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> };
	/** The executor's code host jobs, with the `yields` option. */
	hosts: Pick<CodeHostJobs, "run">;
	/** The store nightly care writes to: the same object, so its uses of the storage stay in one line. */
	bundles: CodeBundleStore;
	/** Nightly care's two jobs (`code-host-jobs.ts`), for a `fresh` bundle of the place as it stands. */
	check: typeof checkCodeArea;
	bundle: typeof bundleCodeArea;
	owner: string;
	machineIdSha256: string;
	/** The log lines `code-restore` and `code-restore-error` (whose `error` is the error itself, for the log to
	 * redact). */
	report?: (event: Record<string, unknown>) => void;
	now?: () => number;
	/** The largest `fresh` bundle copied out. Default 2 GiB, the job's own. */
	bundleMaximumBytes?: number;
	/** How long a proof's fsck may take; the jobs' own bound (30 minutes) when left out. */
	fsckMs?: number;
}

const OUTCOME = "qorpera.code-request-outcome/v1";
const CALL_MS = 10_000;
const YIELDED = "CODE_HOST_JOB_YIELDED";
/** The name each job's step call gives the kernel. `set-aside` is more than a name: it is the one job of a restore
 * that moves anything out of the place, and the kernel ends the downloads made in the place each time a step names
 * it (`qorpera_code_request_step`). A job that moves something out of the place must ask its step under that name. */
type RestoreStep = "verify" | "fresh" | "close" | "set-aside" | "build" | "open" | "discard";
/** What a failed step is called in a request's outcome. */
/** The steps that move the place: their jobs do not yield, and the kernel does not put them off. */
const MOVING: ReadonlySet<RestoreStep> = new Set(["set-aside", "build", "open"]);
const STEP: Readonly<Record<RestoreStep, string>> = {
	verify: "VERIFY_FAILED",
	fresh: "FRESH_BUNDLE_FAILED",
	close: "CLOSE_FAILED",
	"set-aside": "SET_ASIDE_FAILED",
	build: "BUILD_FAILED",
	open: "OPEN_FAILED",
	discard: "DISCARD_FAILED",
};

/** What a failed restore's outcome says, in plain words, by the last part of its code or the code itself. The
 * operator's runbook (`deploy/code-host/RESTORE-RUNBOOK.md`) has the same list. */
export const CODE_RESTORE_WORDS: Readonly<Record<string, string>> = Object.freeze({
	PLACE_AS_BEFORE: "The repository's place is as it was before the request: nothing was moved, and it is open.",
	PLACE_CLOSED:
		"The repository's place is closed (restoring.json is in it). Ask again with the same bundle: the restore goes on from what the place holds.",
	RESTORE_REQUEST_INVALID: "The request names no bundle, path or choice this executor can act on.",
	RESTORE_LEASE_LOST: "Another claim has the request, or this executor no longer holds the company.",
	RESTORE_SET_ASIDE_NOT_KEPT:
		"The folder did not keep the move of the old place: after a job moved it, the next job still found it there.",
	CODE_BUNDLE_MISSING: "No stored bundle has that name for this repository.",
	AREA_ABSENT: "There is no repository at the place to take a fresh bundle of. Ask with a stored bundle's name.",
	RESTORE_BOUNDARY_UNKNOWN:
		"The change record does not know the commit that was restored: which of its earlier changes main still holds could not be told, and their states were left as they were. Compare changes/index.md with main by hand.",
});

/** The kernel did not let a job go on: the company is busy, or the request's lease is gone. */
class RestoreStopped extends Error {
	readonly stop: "busy" | "lost";
	constructor(stop: "busy" | "lost") {
		super(`CODE_RESTORE_STOPPED:${stop}`);
		this.stop = stop;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An error's fixed code: the code host's own, or a message that is one. */
function codeOf(error: unknown): string {
	if ((error instanceof CodeHostJobFailure || error instanceof CodeHostRefusal) && FIXED.test(error.code))
		return error.code;
	return error instanceof Error && FIXED.test(error.message) ? error.message : "UNCLASSIFIED";
}

interface RestoreRun {
	request: CodeRestoreRequest;
	repository: CloudCodingRepository;
	target: CodeBundleTarget;
	named: Record<string, unknown>;
	/** The step under way, for the kernel's record and for a failure's name. */
	step: RestoreStep;
	/** What the kernel keeps of how far the request got: `bundle` (the bundle used), `at` (the place was closed then),
	 * `setAside` (a job saw the place emptied: where its content went, or null) and `built` (the repository is built). */
	progress: Record<string, unknown>;
	/** `open`: this run has not closed the place. `closed`: it began to, and no job has seen the place emptied.
	 * `emptied`: the place opens only once it is built. */
	stage: "open" | "closed" | "emptied";
	/** The bundle the place is closed for, once this run began to close it. */
	bundle?: string | undefined;
	previousMainSha: string | null;
	/** The time in the name of the `fresh` bundle this run took last. */
	freshAt?: number;
}

/** A restore request done, step by step (the module's comment has the steps). Before each job, with the job's place in
 * its company's line held, the kernel is asked (`qorpera_code_request_step`): it renews the request's lease, saves
 * how far the request got, and says whether the company is still quiet. A job yields to a turn's until the restore
 * begins to move the place (and not the one that opens an untouched place again); from the set-aside to the open the
 * jobs keep their place in the line.
 *
 *   verify    `verifyCodeBundle` on the stored bundle.
 *   restore   `fresh` first takes a new bundle of the place as it stands (nightly care's check and bundle jobs) into
 *             the store. A claim that comes again goes on with that bundle only when the place has not been open
 *             since: otherwise it takes a new one (`#earlier`). The close of a `fresh` request writes its mark only
 *             when the place's refs are still the bundle's (`CODE_HOST_RESTORE_REFS_MOVED` otherwise): then one more
 *             bundle is taken and the close tried once more, and a place that moved again ends the request `busy`
 *             with nothing closed. Then set aside (run until a job sees the place emptied), build and open. The job
 *             that opens the place has the restore recorded (`qorpera_code_restore_record`) before its mark goes:
 *             the request's finish, which comes after the job has saved, records nothing. With `damaged: remove`,
 *             the set-aside copy is removed after the place is open again, never before.
 *   discard   `discardSetAside` on the request's path.
 *
 * `run` never throws. A step whose answer is not the one expected ends the request `failed`, with a code that names
 * the step, the reason and, once the place was touched, whether it is as before (`PLACE_AS_BEFORE`) or closed
 * (`PLACE_CLOSED`). A request the kernel put off, a job that yielded and an executor that is stopping end it `busy`:
 * it is claimed again later, and goes on from what the kernel saved and the place holds. So do a record the kernel
 * was not heard to take, and an open that failed after its record was made: the place stays closed, and the next
 * claim opens it, where the record made again is the same record. A place this run closed and did not get to move
 * anything out of is opened again before the run ends, either way, unless the request's lease is gone. */
export class CodeRestore {
	readonly #control: CodeRestoreOptions["control"];
	readonly #hosts: Pick<CodeHostJobs, "run">;
	readonly #bundles: CodeBundleStore;
	readonly #check: typeof checkCodeArea;
	readonly #bundle: typeof bundleCodeArea;
	readonly #owner: string;
	readonly #machineIdSha256: string;
	readonly #report: (event: Record<string, unknown>) => void;
	readonly #now: () => number;
	readonly #bundleMaximumBytes: number;
	readonly #fsck: { fsckMs?: number };

	constructor(options: CodeRestoreOptions) {
		const bundleMaximumBytes = options.bundleMaximumBytes ?? CODE_BUNDLE_MAXIMUM_BYTES;
		if (
			typeof options.owner !== "string" ||
			!options.owner ||
			typeof options.machineIdSha256 !== "string" ||
			!SHA256_HEX_PATTERN.test(options.machineIdSha256) ||
			typeof options.check !== "function" ||
			typeof options.bundle !== "function" ||
			!Number.isSafeInteger(bundleMaximumBytes) ||
			bundleMaximumBytes < 1 ||
			(options.fsckMs !== undefined && (!Number.isSafeInteger(options.fsckMs) || options.fsckMs < 1))
		)
			throw new Error("INVALID_CODE_RESTORE");
		this.#control = options.control;
		this.#hosts = options.hosts;
		this.#bundles = options.bundles;
		this.#check = options.check;
		this.#bundle = options.bundle;
		this.#owner = options.owner;
		this.#machineIdSha256 = options.machineIdSha256;
		const report = options.report;
		// The log must never change what happens: a reporter that throws is not heard.
		this.#report = (event) => {
			try {
				report?.(event);
			} catch {
				/* not heard */
			}
		};
		this.#now = options.now ?? Date.now;
		this.#bundleMaximumBytes = bundleMaximumBytes;
		this.#fsck = options.fsckMs === undefined ? {} : { fsckMs: options.fsckMs };
	}

	async run(request: CodeRestoreRequest, signal: AbortSignal): Promise<CodeRestoreOutcome> {
		const started = this.#now();
		let outcome: CodeRestoreOutcome, run: RestoreRun | undefined;
		try {
			run = this.#runOf(request);
			const { mode } = run.request;
			outcome =
				mode === "verify"
					? await this.#verify(run, signal)
					: mode === "discard"
						? await this.#discard(run, signal)
						: await this.#restore(run, signal);
		} catch (error) {
			outcome = run
				? await this.#ended(run, error, signal)
				: { schema: OUTCOME, state: "failed", code: "RESTORE_REQUEST_INVALID" };
			if (!run) this.#report({ event: "code-restore-error", step: "request", requestId: request?.requestId, error });
		}
		this.#report({
			event: "code-restore",
			step: "ended",
			...(run?.named ?? { requestId: request?.requestId }),
			state: outcome.state,
			...("result" in outcome ? { result: outcome.result } : {}),
			...("code" in outcome ? { code: outcome.code, words: wordsOf(outcome.code) } : {}),
			ms: this.#now() - started,
		});
		return outcome;
	}

	/** The request, checked field by field, with what its mode needs. */
	#runOf(request: CodeRestoreRequest): RestoreRun {
		if (!isRecord(request)) throw new Error("RESTORE_REQUEST_INVALID");
		const { requestId, token, companyId, environmentId, mode, bundle, damaged, path, progress, sessions } = request;
		const stored = typeof bundle === "string" && CODE_BUNDLE_NAME.test(bundle);
		if (
			![requestId, token, companyId, environmentId].every((id) => isUuid(id)) ||
			request.kind !== "restore" ||
			!(mode === "verify"
				? stored
				: mode === "restore"
					? (stored || bundle === "fresh") && (damaged === "keep" || damaged === "remove")
					: mode === "discard" && typeof path === "string") ||
			!(progress === null || isRecord(progress)) ||
			!Array.isArray(sessions)
		)
			throw new Error("RESTORE_REQUEST_INVALID");
		let repository: CloudCodingRepository;
		try {
			repository = parseCloudCodingRepository({
				host: "qorpera",
				owner: request.owner,
				name: request.name,
				baseBranch: "main",
			});
		} catch {
			throw new Error("RESTORE_REQUEST_INVALID");
		}
		// What an earlier run saved, but for the kernel's own word of why it waited.
		const saved: Record<string, unknown> = {};
		for (const key of ["bundle", "at", "setAside", "built"])
			if (progress && key in progress) saved[key] = progress[key];
		return {
			request,
			repository,
			target: { companyId, owner: repository.owner, name: repository.name },
			named: {
				requestId,
				mode,
				companyId,
				environmentId,
				repository: `${repository.owner}/${repository.name}`,
			},
			step: mode === "verify" ? "verify" : mode === "discard" ? "discard" : "close",
			progress: saved,
			stage: "open",
			previousMainSha: null,
		};
	}

	async #verify(run: RestoreRun, signal: AbortSignal): Promise<CodeRestoreOutcome> {
		const name = run.request.bundle as string;
		run.progress.bundle = name;
		const proved = await this.#job(run, signal, async (job) => {
			const stored = await this.#stored(run, name, job.signal);
			return await verifyCodeBundle(
				job,
				{ repository: run.repository, bundle: stored.bundle },
				stored.pieces,
				this.#fsck,
			);
		});
		return {
			schema: OUTCOME,
			state: "done",
			result: "verified",
			mainSha: proved.mainSha,
			refsSha256: proved.refsSha256,
			refs: proved.refs,
		};
	}

	async #discard(run: RestoreRun, signal: AbortSignal): Promise<CodeRestoreOutcome> {
		const path = run.request.path as string;
		const discarded = await this.#job(run, signal, (job) =>
			discardSetAside(job, { repository: run.repository, path }),
		);
		this.#report({ event: "code-restore", step: "discarded", ...run.named, path, removed: discarded.removed });
		return { schema: OUTCOME, state: "done", result: "discarded" };
	}

	async #restore(run: RestoreRun, signal: AbortSignal): Promise<CodeRestoreOutcome> {
		const { request, repository, progress } = run;
		// The bundle: the one asked for, or a new one of the place as it stands. The one an earlier claim took is that
		// only while the place has not been open since (`#earlier`).
		let name: string;
		if (request.bundle !== "fresh") name = request.bundle as string;
		else name = (await this.#earlier(run, signal)) ?? (await this.#fresh(run, signal));
		progress.bundle = name;
		let setAside: string | null;
		if (progress.built === true || "setAside" in progress) {
			// A job of an earlier run saw the place emptied.
			run.stage = "emptied";
			setAside = typeof progress.setAside === "string" ? progress.setAside : null;
		} else {
			let shut: CodeAreaClosed | undefined;
			for (let again = false; !shut; again = true) {
				const bundle = name;
				run.step = "close";
				try {
					shut = await this.#job(run, signal, async (job) => {
						const stored = await this.#stored(run, bundle, job.signal);
						run.bundle = bundle;
						run.stage = "closed";
						const at = `${new Date(this.#now()).toISOString().slice(0, 19).replace(/[-:]/g, "")}Z`;
						return await closeCodeArea(
							job,
							{
								repository,
								requestId: request.requestId,
								bundle: stored.bundle,
								at,
								fresh: request.bundle === "fresh",
							},
							stored.pieces,
							this.#fsck,
						);
					});
				} catch (error) {
					if (!(error instanceof CodeHostRefusal) || error.code !== REFS_MOVED) throw error;
					// Only a `fresh` close refuses so, and it wrote nothing: the place is open, as it was, and has moved on
					// since the bundle was taken (a change landed, a session committed). One more bundle of the place as it
					// stands, and one more close. A place that has moved again by then is left alone: the request is put off,
					// and its next claim finds the place open and starts from a new bundle (`#earlier`).
					run.stage = "open";
					run.bundle = undefined;
					this.#report({ event: "code-restore", step: "refs-moved", ...run.named, bundle });
					if (again) throw new RestoreStopped("busy");
					name = await this.#fresh(run, signal);
					progress.bundle = name;
				}
			}
			progress.at = shut.at;
			run.previousMainSha ??= shut.previousMainSha;
			this.#report({
				event: "code-restore",
				step: "closed",
				...run.named,
				bundle: name,
				at: shut.at,
				state: shut.state,
			});
			setAside = shut.setAside;
			if (shut.step === "closed") {
				run.step = "set-aside";
				// The job that moves, and then one that sees what the folder kept of the move.
				for (let moves = 0; ; ) {
					const aside = await this.#job(run, signal, (job) => setAsideCodeArea(job, { repository, bundle: name }));
					if (aside.state !== "moved") {
						setAside = aside.movedTo;
						break;
					}
					moves += 1;
					if (moves > 1) throw new Error("RESTORE_SET_ASIDE_NOT_KEPT");
				}
			}
			run.stage = "emptied";
			progress.setAside = setAside;
			this.#report({ event: "code-restore", step: "set-aside", ...run.named, movedTo: setAside });
		}
		if (progress.built !== true) {
			run.step = "build";
			const built = await this.#job(run, signal, async (job) => {
				const stored = await this.#stored(run, name, job.signal);
				return await restoreCodeArea(job, { repository, bundle: stored.bundle }, stored.pieces, this.#fsck);
			});
			progress.built = true;
			this.#report({ event: "code-restore", step: "built", ...run.named, mainSha: built.mainSha, refs: built.refs });
		}
		// The open's own step call saves that the repository is built, before the mark goes.
		run.step = "open";
		const manifest = await this.#bundles.find(run.target, name, signal);
		if (!manifest) throw new Error("CODE_BUNDLE_MISSING");
		let recorded = false,
			opened: CodeAreaOpened;
		try {
			opened = await this.#job(run, signal, (job) =>
				openCodeArea(
					job,
					{ repository, bundle: bundleFacts(name, manifest), sessions: request.sessions.slice(0, 1000) },
					async (place) => {
						await this.#record(run, name, place, job.signal);
						recorded = true;
					},
				),
			);
		} catch (error) {
			// The record is made and the place did not open: the mark could not be removed, or the job did not save. The
			// repository is restored and recorded, and only its mark is in the way: the request is not failed for that. It
			// is claimed again, and that claim's open job takes the mark away.
			if (!recorded || error instanceof RestoreStopped) throw error;
			this.#report({ event: "code-restore-error", step: "open", ...run.named, place: "PLACE_CLOSED", error });
			throw new RestoreStopped("busy");
		}
		this.#report({ event: "code-restore", step: "opened", ...run.named, state: opened.state });
		let movedTo = setAside;
		if (request.damaged === "remove" && setAside !== null) {
			// The repository is restored whatever becomes of this: a copy that could not be removed now is named in the
			// outcome, for a discard later.
			run.step = "discard";
			try {
				const path = setAside;
				await this.#job(run, signal, (job) => discardSetAside(job, { repository, path }));
				movedTo = null;
			} catch (error) {
				this.#report({ event: "code-restore-error", step: "discard", ...run.named, error });
			}
		}
		return {
			schema: OUTCOME,
			state: "done",
			result: "restored",
			bundle: name,
			mainSha: opened.mainSha,
			previousMainSha: run.previousMainSha ?? opened.previousMainSha,
			refsSha256: manifest.refsSha256,
			refs: manifest.refsCount,
			stranded: opened.stranded.slice(0, 200),
			movedTo,
		};
	}

	/** The bundle an earlier claim of a `fresh` request took, when the restore goes on with it: only when the place has
	 * not been open since it was taken. That is so once a job saw the place emptied (the progress has `setAside` or
	 * `built`: from there the place opens only restored), and while the place still holds this request's mark for that
	 * bundle, which a job reads from the place itself. Null otherwise: the place is open, because an earlier claim
	 * opened it again or never closed it, and changes may have landed there since. A restore from the earlier bundle
	 * would put main back before them, and `fresh` loses no change: the caller takes a new bundle of the place as it
	 * stands, and closes only then. A place that another mark closes gives null too: the new bundle is refused there
	 * (`CODE_HOST_RESTORE_IN_PROGRESS`), as a first claim's is. */
	async #earlier(run: RestoreRun, signal: AbortSignal): Promise<string | null> {
		const { request, repository, progress } = run,
			name = progress.bundle;
		if (typeof name !== "string" || !CODE_BUNDLE_NAME.test(name)) return null;
		if (progress.built === true || "setAside" in progress) return name;
		run.step = "fresh";
		const { mark } = await this.#job(run, signal, (job) => readCodeAreaMark(job, { repository }));
		return mark?.requestId === request.requestId && mark.bundle === name ? name : null;
	}

	/** `fresh`: a new bundle of the place as it stands, proven by the bundle job itself and stored with its manifest
	 * like a nightly one. It fails when an object behind any ref is missing or bad, or when the place is not as the
	 * platform left it: the operator then asks with a stored bundle's name. No older bundle is pruned for it. */
	async #fresh(run: RestoreRun, signal: AbortSignal): Promise<string> {
		const { repository } = run;
		run.step = "fresh";
		const checked = await this.#job(run, signal, (job) => this.#check(job, { repository }));
		if (isRecord(checked) && checked.state === "absent") throw new Error("AREA_ABSENT");
		if (
			!isRecord(checked) ||
			checked.state !== "present" ||
			typeof checked.mainSha !== "string" ||
			!SHA.test(checked.mainSha) ||
			typeof checked.refsSha256 !== "string" ||
			!SHA256.test(checked.refsSha256) ||
			!Number.isSafeInteger(checked.objects?.sizeKiB)
		)
			throw new Error("CODE_RESTORE_ANSWER_INVALID");
		const maximumBytes = this.#bundleMaximumBytes;
		let writer: CodeBundleWriter | undefined;
		try {
			const begun = await this.#bundles.begin(
				run.target,
				{ expectedBytes: Math.min(checked.objects.sizeKiB * 1024, maximumBytes), maximumBytes },
				signal,
			);
			writer = begun;
			const made = await this.#job(run, signal, (job) =>
				this.#bundle(
					job,
					{ repository, refsSha256: checked.refsSha256 },
					{ write: (chunk) => begun.write(chunk, job.signal) },
					{ maximumBytes },
				),
			);
			if (made?.refsSha256 !== checked.refsSha256) throw new Error("CODE_RESTORE_ANSWER_INVALID");
			// A bundle's name is its time to the second and main's commit. The second bundle of a run (the place moved
			// on before the close) may be of the same main within the same second: it is named a second on.
			const at = Math.max(this.#now(), (run.freshAt ?? Number.NEGATIVE_INFINITY) + 1000);
			run.freshAt = at;
			const createdAt = new Date(at).toISOString(),
				name = codeBundleName(createdAt, checked.mainSha);
			await begun.commit(
				name,
				{
					environmentId: run.request.environmentId,
					createdAt,
					gitVersion: made.gitVersion,
					mainSha: checked.mainSha,
					refsSha256: made.refsSha256,
					refs: made.refs,
					sha256: made.sha256,
					bytes: made.bytes,
					executorOwner: this.#owner,
				},
				signal,
			);
			run.previousMainSha = checked.mainSha;
			this.#report({ event: "code-restore", step: "fresh", ...run.named, bundle: name, bytes: made.bytes });
			return name;
		} catch (error) {
			// Nothing after a commit; a writer that did not get there leaves no file.
			await writer
				?.abort()
				.catch((failure: unknown) =>
					this.#report({ event: "code-restore-error", step: "fresh", ...run.named, error: failure }),
				);
			throw error;
		}
	}

	/** The stored bundle's facts and its bytes, which are read only as the job takes them. */
	async #stored(run: RestoreRun, name: string, signal: AbortSignal) {
		const { manifest, pieces } = await this.#bundles.read(run.target, name, signal);
		return { bundle: bundleFacts(name, manifest), pieces };
	}

	/** One job of the request on the company's code host. With its place in the company's line it asks the kernel first:
	 * only on `go` do its steps run. It yields to a turn's job until the restore begins to move the place. From then on
	 * (set aside, build, open) the place is closed to every session, the kernel does not put the request off any more
	 * (`qorpera_code_restore_moving`), and the job keeps its place: giving way would only keep the repository closed.
	 * The step must stay the first thing a job does: the one of the job that sets the place aside is where the kernel
	 * ends the downloads made in the place, whose files go aside with it, and takes the repository's artifact
	 * generation up (`qorpera_code_request_step`), before anything is moved. It does so every time that step is
	 * asked, on this claim or a later one: a job that was let go may fail before it moves anything, the place is then
	 * opened again, and a download made there must end when the next claim's job is let go to move the place. */
	async #job<T>(run: RestoreRun, signal: AbortSignal, steps: (job: CodeHostJob) => Promise<T>): Promise<T> {
		return await this.#hosts.run(
			run.request.companyId,
			run.request.environmentId,
			signal,
			async (job) => {
				const answer = await this.#step(run, job.signal);
				if (answer !== "go") throw new RestoreStopped(answer);
				return await steps(job);
			},
			{ yields: !MOVING.has(run.step) },
		);
	}

	/** Renews the request's lease, saves how far it got, and asks whether the company is still quiet. */
	async #step(run: RestoreRun, signal: AbortSignal): Promise<"go" | "busy" | "lost"> {
		const answer = await this.#control.call(
			CODE_RESTORE_RPCS[0],
			{
				p_owner: this.#owner,
				p_machine_id_sha256: this.#machineIdSha256,
				p_request_id: run.request.requestId,
				p_token: run.request.token,
				p_progress: { ...run.progress, step: run.step },
			},
			AbortSignal.any([signal, AbortSignal.timeout(CALL_MS)]),
		);
		if (
			isRecord(answer) &&
			answer.schema === "qorpera.code-request-step/v1" &&
			(answer.state === "go" || answer.state === "busy" || answer.state === "lost")
		)
			return answer.state;
		throw new Error("CODE_RESTORE_STEP_UNCONFIRMED");
	}

	/** The restore written into the change record (`qorpera_code_restore_record`), from inside the job that opens the
	 * place, before its mark goes: the kernel writes the restore's row and sets every row's state to what the restored
	 * default branch holds, which it finds from its own rows. It resolves only when the kernel said `recorded`. A
	 * request whose lease is gone ends the run as lost. A kernel that was not heard is asked once more (made again, the
	 * record is the same one); still not heard, the run ends as put off with the place closed, and the next claim's
	 * open records. A restored commit the record does not know is reported as an error for an operator: the record is
	 * made all the same, and no change was marked lost by a guess. */
	async #record(run: RestoreRun, bundle: string, place: CodeAreaOpening, signal: AbortSignal): Promise<void> {
		let failure: unknown;
		for (let tried = 0; tried < 2; tried += 1) {
			let answer: unknown;
			try {
				answer = await this.#control.call(
					CODE_RESTORE_RPCS[1],
					{
						p_owner: this.#owner,
						p_machine_id_sha256: this.#machineIdSha256,
						p_request_id: run.request.requestId,
						p_token: run.request.token,
						p_restored: {
							schema: "qorpera.code-restore-record/v1",
							bundle,
							mainSha: place.mainSha,
							previousMainSha: run.previousMainSha ?? place.previousMainSha,
						},
					},
					AbortSignal.any([signal, AbortSignal.timeout(CALL_MS)]),
				);
			} catch (error) {
				failure = error;
				continue;
			}
			if (isRecord(answer) && answer.schema === "qorpera.code-restore-recorded/v1") {
				if (answer.state === "lost") throw new RestoreStopped("lost");
				const { change, boundary, keptThrough, lost, back } = answer;
				if (
					answer.state === "recorded" &&
					Number.isSafeInteger(change) &&
					(boundary === "found" || boundary === "unknown")
				) {
					this.#report({
						event: "code-restore",
						step: "recorded",
						...run.named,
						change,
						boundary,
						keptThrough,
						lost,
						back,
					});
					if (boundary === "unknown")
						this.#report({
							event: "code-restore-error",
							step: "record",
							...run.named,
							change,
							words: CODE_RESTORE_WORDS.RESTORE_BOUNDARY_UNKNOWN,
							error: new Error("RESTORE_BOUNDARY_UNKNOWN"),
						});
					return;
				}
			}
			failure = new Error("CODE_RESTORE_RECORD_UNCONFIRMED");
		}
		this.#report({
			event: "code-restore-error",
			step: "record",
			...run.named,
			place: "PLACE_CLOSED",
			error: failure,
		});
		throw new RestoreStopped("busy");
	}

	/** How a run that threw ends. A place it closed and did not see emptied is opened again first, when nothing was
	 * moved out of it: a restore that could not go on leaves the repository as it found it. Not when the request's lease
	 * is gone: the place is then for whoever holds the request to go on from. */
	async #ended(run: RestoreRun, error: unknown, signal: AbortSignal): Promise<CodeRestoreOutcome> {
		const stop =
			error instanceof RestoreStopped
				? error.stop
				: (error instanceof CodeHostJobFailure && error.code === YIELDED) ||
						error instanceof CodingControlBusy ||
						signal.aborted
					? "busy"
					: undefined;
		let place: string | undefined;
		if (run.stage === "closed")
			place = stop !== "lost" && (await this.#reopen(run, signal)) ? "PLACE_AS_BEFORE" : "PLACE_CLOSED";
		else if (run.stage === "emptied") place = "PLACE_CLOSED";
		if (stop === "busy") {
			this.#report({ event: "code-restore", step: "put-off", ...run.named, at: run.step, place: place ?? null });
			return { schema: OUTCOME, state: "busy" };
		}
		this.#report({ event: "code-restore-error", step: run.step, ...run.named, place: place ?? null, error });
		const reason = stop === "lost" ? "RESTORE_LEASE_LOST" : `${STEP[run.step]}:${codeOf(error)}`,
			code = place ? `${reason}:${place}` : reason;
		return { schema: OUTCOME, state: "failed", code: /^[A-Z0-9_:]{1,120}$/.test(code) ? code : STEP[run.step] };
	}

	/** Opens a place this run closed, when it is still what it was (`reopenCodeArea`). The job does not yield, and does
	 * not ask the kernel: it must run exactly when the company is busy. */
	async #reopen(run: RestoreRun, signal: AbortSignal): Promise<boolean> {
		const bundle = run.bundle;
		if (bundle === undefined || signal.aborted) return false;
		try {
			const reopened = await this.#hosts.run(run.request.companyId, run.request.environmentId, signal, (job) =>
				reopenCodeArea(job, { repository: run.repository, bundle }),
			);
			this.#report({ event: "code-restore", step: "reopened", ...run.named, state: reopened.state });
			return true;
		} catch (error) {
			this.#report({ event: "code-restore-error", step: "reopen", ...run.named, error });
			return false;
		}
	}
}

function bundleFacts(name: string, manifest: CodeBundleManifest): CodeRestoreBundle {
	const { sha256, bytes, refsSha256, mainSha } = manifest;
	return { name, sha256, bytes, refsSha256, mainSha };
}

/** A failed outcome's code in plain words: what each of its parts says, where this file knows it. */
function wordsOf(code: string): string {
	return code
		.split(":")
		.flatMap((part) => (CODE_RESTORE_WORDS[part] ? [CODE_RESTORE_WORDS[part]] : []))
		.join(" ");
}
