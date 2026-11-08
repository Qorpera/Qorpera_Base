import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { type CloudCodingRepository, folderKey, isUuid, parseCloudCodingRepository } from "@qorpera/contracts";

/** The code host's jobs (5e, RUNTIME-FOLDER-CODING-MACHINES.md "The code host"): every git command that must not run as
 * a member's root. Each job runs in the company's code host VM, through its `code_host` view of `/company` (code/
 * only), with the pinned git and none of the repository's code or settings: no system or global config, the
 * repository config the platform's own (restored when a job finds it changed), hooks, fsmonitor, filters and
 * submodules off, and every setting given in the environment (`GIT_CONFIG_COUNT`, command scope; LXD exec takes at
 * most 64 arguments). A job's scratch is the VM's own disk, never the folder. */

/** One command in the code host: exactly this argv and environment, no terminal. */
export interface CodeHostCommand {
	argv: readonly string[];
	env: Readonly<Record<string, string>>;
	cwd: string;
	/** Written to the command's stdin, which is then closed. Without it stdin is empty. */
	stdin?: Uint8Array | AsyncIterable<Uint8Array>;
	/** More stdout than this fails the command. */
	maximumOutputBytes: number;
}
export interface CodeHostCommandResult {
	status: number;
	stdout: Buffer;
	/** The end of stderr, for the report. */
	stderr: string;
}
/** How a job reaches its code host: LXD exec in production, a local process in tests. A status other than 0 is a
 * result, not a rejection; a lost or oversized command rejects. */
export interface CodeHostShell {
	run(command: CodeHostCommand, signal: AbortSignal): Promise<CodeHostCommandResult>;
}
export interface CodeHostLayout {
	/** Where the job's code_host view shows the company folder (`/company`). */
	companyRoot: string;
	/** The code host's own disk, outside the folder: one directory per job. */
	scratchRoot: string;
	/** The pinned git (`/usr/local/bin/git`). */
	git: string;
}
export interface CodeHostJob {
	shell: CodeHostShell;
	layout: CodeHostLayout;
	signal: AbortSignal;
}

/** A job refused by rule, naming what broke it (the first 100 paths and how many more). */
export class CodeHostRefusal extends Error {
	readonly code: string;
	readonly paths: readonly string[];
	constructor(code: string, paths: readonly string[] = []) {
		const shown = paths.slice(0, 100),
			more = paths.length - shown.length;
		super(shown.length ? `${code}: ${shown.join(", ")}${more ? ` and ${more} more` : ""}` : code);
		this.name = "CodeHostRefusal";
		this.code = code;
		this.paths = Object.freeze([...paths]);
	}
}
/** A command that failed, with the end of what it said. */
export class CodeHostJobFailure extends Error {
	readonly code: string;
	readonly detail: string;
	constructor(code: string, detail = "") {
		super(detail ? `${code}: ${detail}` : code);
		this.name = "CodeHostJobFailure";
		this.code = code;
		this.detail = detail;
	}
}

const SHA = /^[0-9a-f]{40}$/;
const ZERO = "0".repeat(40);
const MiB = 1024 ** 2;
/** Q13: single files over 256 MiB are refused until large files; the folder refuses a pack of 256 MiB or more. */
const MAX_BLOB = 256 * MiB;
const MAX_PACK = 256 * MiB;
const MAX_LISTING = 256 * MiB;
/** A commit file read (5h reads at most 1 MiB). */
const MAX_READ = 16 * MiB;
const MAX_TEXT = 64 * 1024;
/** The platform's repository config, byte for byte: no include, extension, filter, hook or worktree setting. */
export const CODE_AREA_CONFIG = "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = true\n";
const MAIN_LOCK = "qorpera: the default branch, platform-only";
const WORKTREE_LOCK = "qorpera: a coding session's worktree";

/** Every command's settings, command scope, so they beat the repository's. §6's table for the shared directory, and
 * for gc: worker branches never packed (packed-refs is shared and the folder can't read its lines; gc packs refs
 * itself), no reflog expiry (it would lock workers' refs and worktrees' HEADs, which the gc block does not hold),
 * locked worktrees never pruned, and packs under the folder's 256 MiB. No grafts advice: with GIT_GRAFT_FILE at
 * /dev/null, git gives it for every process that reads a commit, and it would crowd git's error out of a report. */
const SETTINGS: readonly (readonly [string, string])[] = [
	["core.hooksPath", "/dev/null"],
	["core.fsmonitor", "false"],
	["core.untrackedCache", "false"],
	["core.attributesFile", "/dev/null"],
	["core.excludesFile", "/dev/null"],
	["core.sshCommand", "/bin/false"],
	["core.symlinks", "true"],
	["core.checkStat", "minimal"],
	["core.trustctime", "false"],
	["core.splitIndex", "false"],
	["core.logAllRefUpdates", "false"],
	["core.filesRefLockTimeout", "10000"],
	["core.packedRefsTimeout", "10000"],
	["index.sparse", "false"],
	["credential.helper", ""],
	["protocol.allow", "never"],
	["protocol.file.allow", "always"],
	["submodule.recurse", "false"],
	["fetch.recurseSubmodules", "false"],
	["transfer.fsckObjects", "true"],
	["fetch.fsckObjects", "true"],
	["gc.auto", "0"],
	["maintenance.auto", "false"],
	["gc.packRefs", "false"],
	["gc.reflogExpire", "never"],
	["gc.reflogExpireUnreachable", "never"],
	["gc.worktreePruneExpire", "never"],
	["gc.maxCruftSize", "200m"],
	["pack.packSizeLimit", "200m"],
	["repack.writeBitmaps", "false"],
	["worktree.useRelativePaths", "false"],
	["advice.detachedHead", "false"],
	["advice.graftFileDeprecated", "false"],
];

function checkPath(value: unknown): string {
	if (
		typeof value !== "string" ||
		!value.startsWith("/") ||
		value === "/" ||
		value.length > 1024 ||
		/[\0\n\r]/.test(value) ||
		posix.normalize(value) !== value ||
		value.endsWith("/")
	)
		throw new Error("INVALID_CODE_HOST_LAYOUT");
	return value;
}
function checkLayout(layout: CodeHostLayout): CodeHostLayout {
	const companyRoot = checkPath(layout?.companyRoot),
		scratchRoot = checkPath(layout?.scratchRoot),
		git = checkPath(layout?.git);
	const inside = (a: string, b: string) => a === b || a.startsWith(`${b}/`);
	if (inside(companyRoot, scratchRoot) || inside(scratchRoot, companyRoot))
		throw new Error("INVALID_CODE_HOST_LAYOUT");
	return { companyRoot, scratchRoot, git };
}
function sha(value: unknown): string {
	if (typeof value !== "string" || !SHA.test(value)) throw new Error("INVALID_CODE_HOST_JOB");
	return value;
}
function workerIdOf(value: unknown): string {
	if (!isUuid(value)) throw new Error("INVALID_CODE_HOST_JOB");
	return value;
}
function closed<T extends string>(value: unknown, keys: readonly T[]): Record<T, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).sort().join() !== [...keys].sort().join()
	)
		throw new Error("INVALID_CODE_HOST_JOB");
	return value as Record<T, unknown>;
}
/** A base branch that is a worker branch, or a folder of them, would collide with sessions' branches; in the folder,
 * names that differ only by case are one name. */
function repositoryOf(value: unknown): CloudCodingRepository {
	const repository = parseCloudCodingRepository(value),
		base = repository.baseBranch,
		key = base.split("/").map(folderKey).join("/");
	if (key === "qorpera" || key === "qorpera/coding" || key.startsWith("qorpera/coding/"))
		throw new CodeHostRefusal("CODE_HOST_BASE_IS_A_WORKER_BRANCH", [base]);
	return repository;
}
/** The code area's folder path, `code/<owner>/<name>`, lower-case: GitHub ignores case in both, the folder keeps one
 * entry per case-folded name and a guest's lookup is exact, so every spelling of a repository must reach the same
 * path (as 5b's machine key, `lower(owner/name)`). Both are ASCII, where this is the folder's key. GitHub and the
 * credential's claim keep the repository as claimed. */
export function codeAreaPath(repository: CloudCodingRepository): string {
	const { owner, name } = parseCloudCodingRepository(repository);
	return `code/${owner.toLowerCase()}/${name.toLowerCase()}`;
}
function tail(text: string): string {
	return text.length > 2000 ? text.slice(-2000) : text;
}

type PathType = "none" | "link" | "directory" | "file" | "other";
const PATH_TYPES = new Set<string>(["none", "link", "directory", "file", "other"]);

/** One job: its scratch directory, its environment, and the code area's paths. */
class Run {
	readonly job: CodeHostJob;
	readonly layout: CodeHostLayout;
	readonly repository: CloudCodingRepository;
	readonly directory: string;
	readonly code: string;
	readonly repo: string;
	readonly main: string;
	readonly area: string;
	readonly restored: string[] = [];
	readonly #env: Record<string, string>;
	constructor(job: CodeHostJob, layout: CodeHostLayout, repository: CloudCodingRepository, directory: string) {
		this.job = job;
		this.layout = layout;
		this.repository = repository;
		this.directory = directory;
		this.area = codeAreaPath(repository);
		this.code = `${layout.companyRoot}/${this.area}`;
		this.repo = `${this.code}/repo.git`;
		this.main = `${this.code}/main`;
		// The code area is the platform's: git's ownership check passes for it, and only for it.
		const settings = [...SETTINGS, ["safe.directory", `${this.code}/*`] as const];
		this.#env = {
			PATH: "/usr/local/bin:/usr/bin:/bin",
			HOME: directory,
			XDG_CONFIG_HOME: directory,
			TMPDIR: directory,
			LANG: "C",
			LC_ALL: "C",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_SYSTEM: "/dev/null",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_ATTR_NOSYSTEM: "1",
			GIT_TERMINAL_PROMPT: "0",
			GIT_ASKPASS: "/bin/false",
			SSH_ASKPASS: "/bin/false",
			GIT_NO_REPLACE_OBJECTS: "1",
			GIT_GRAFT_FILE: "/dev/null",
			GIT_OPTIONAL_LOCKS: "0",
			GIT_ALLOW_PROTOCOL: "file",
			GIT_PROTOCOL_FROM_USER: "0",
			GIT_LITERAL_PATHSPECS: "1",
			GIT_CONFIG_COUNT: String(settings.length),
		};
		settings.forEach(([key, value], index) => {
			this.#env[`GIT_CONFIG_KEY_${index}`] = key;
			this.#env[`GIT_CONFIG_VALUE_${index}`] = value;
		});
	}

	/** A path in the code area as the folder names it, for reports. */
	relative(path: string): string {
		return path.startsWith(`${this.layout.companyRoot}/`) ? path.slice(this.layout.companyRoot.length + 1) : path;
	}

	async command(
		argv: readonly string[],
		options: {
			stdin?: CodeHostCommand["stdin"];
			maximumOutputBytes?: number;
			signal?: AbortSignal;
			cwd?: string;
		} = {},
	): Promise<CodeHostCommandResult> {
		const signal = options.signal ?? this.job.signal;
		signal.throwIfAborted();
		const result = await this.job.shell.run(
			{
				argv: Object.freeze([...argv]),
				env: Object.freeze({ ...this.#env }),
				cwd: options.cwd ?? this.directory,
				...(options.stdin === undefined ? {} : { stdin: options.stdin }),
				maximumOutputBytes: options.maximumOutputBytes ?? MAX_TEXT,
			},
			signal,
		);
		signal.throwIfAborted();
		return result;
	}

	/** A shell script of ours with its arguments as positional parameters, never spliced into the script. */
	sh(script: string, args: readonly string[], options: Parameters<Run["command"]>[1] = {}) {
		return this.command(["/bin/sh", "-c", script, "sh", ...args], options);
	}

	/** Git on one git directory, never discovered. */
	git(gitDir: string, args: readonly string[], options: Parameters<Run["command"]>[1] = {}) {
		return this.command([this.layout.git, "--no-replace-objects", `--git-dir=${gitDir}`, ...args], options);
	}

	async gitOk(gitDir: string, args: readonly string[], failure: string, options: Parameters<Run["command"]>[1] = {}) {
		const result = await this.git(gitDir, args, options);
		if (result.status !== 0) throw new CodeHostJobFailure(failure, tail(result.stderr));
		return result.stdout;
	}

	async types(paths: readonly string[]): Promise<PathType[]> {
		const result = await this.sh(
			'for p do if [ -L "$p" ]; then echo link; elif [ -d "$p" ]; then echo directory; elif [ -f "$p" ]; then echo file; elif [ -e "$p" ]; then echo other; else echo none; fi; done',
			paths,
		);
		const lines = result.stdout.toString("utf8").split("\n");
		if (
			result.status !== 0 ||
			lines.pop() !== "" ||
			lines.length !== paths.length ||
			lines.some((l) => !PATH_TYPES.has(l))
		)
			throw new CodeHostJobFailure("CODE_HOST_INSPECT_FAILED", tail(result.stderr));
		return lines as PathType[];
	}

	/** A small file's bytes, or null when it is not there. */
	async read(path: string): Promise<Buffer | null> {
		const result = await this.sh('[ -f "$1" ] || exit 3; exec cat -- "$1"', [path]);
		if (result.status === 3) return null;
		if (result.status !== 0) throw new CodeHostJobFailure("CODE_HOST_READ_FAILED", tail(result.stderr));
		return result.stdout;
	}

	/** Git's own lock protocol, which the folder serves: exclusive create of `X.lock`, then the rename over X (never into
	 * X when X is a directory). */
	async write(path: string, content: string): Promise<void> {
		const result = await this.sh('set -C; umask 022; printf %s "$2" >"$1.lock" && exec mv -fT -- "$1.lock" "$1"', [
			path,
			content,
		]);
		if (result.status !== 0) throw new CodeHostJobFailure("CODE_HOST_WRITE_FAILED", tail(result.stderr));
	}

	/** Make a file hold exactly `content`, reporting a restore. */
	async keep(path: string, content: string): Promise<void> {
		const current = await this.read(path);
		if (current?.equals(Buffer.from(content))) return;
		await this.write(path, content);
		this.restored.push(this.relative(path));
	}

	/** Before every job: no link on the way to or inside the code area's parts, the platform's config, no file that
	 * points git elsewhere, and main/'s admin files as the platform made them. */
	async prepare(workerId?: string) {
		const worktree = workerId ? `${this.code}/worktrees/${workerId}` : undefined,
			admin = workerId ? `${this.repo}/worktrees/${workerId}` : undefined;
		const directories = [
			`${this.layout.companyRoot}/code`,
			posix.dirname(this.code),
			this.code,
			this.repo,
			`${this.repo}/objects`,
			`${this.repo}/objects/info`,
			`${this.repo}/worktrees`,
			`${this.repo}/worktrees/main`,
			this.main,
			`${this.code}/worktrees`,
			...(worktree && admin ? [worktree, admin] : []),
		];
		const files = [
			`${this.repo}/HEAD`,
			`${this.repo}/config`,
			`${this.repo}/worktrees/main/commondir`,
			`${this.repo}/worktrees/main/gitdir`,
			`${this.repo}/worktrees/main/locked`,
			`${this.main}/.git`,
		];
		const types = await this.types([...directories, ...files]);
		const type = new Map([...directories, ...files].map((path, index) => [path, types[index]]));
		const links = [...type].filter(([, t]) => t === "link").map(([path]) => this.relative(path));
		if (links.length) throw new CodeHostRefusal("CODE_HOST_LINK", links);
		const wrong = [
			...directories.filter((path) => !["none", "directory"].includes(type.get(path) as PathType)),
			...files.filter((path) => !["none", "file"].includes(type.get(path) as PathType)),
		];
		if (wrong.length)
			throw new CodeHostRefusal(
				"CODE_HOST_UNEXPECTED_FILE",
				wrong.map((path) => this.relative(path)),
			);
		// Without HEAD, repo.git is no repository to git. A seed that stopped after its base ref was published (with the
		// ref's lease) and before its HEAD was (at the job's end) leaves one so: the next seed makes it again.
		const made = type.get(this.repo) === "directory",
			seeded = made && type.get(`${this.repo}/HEAD`) === "file";
		if (made) {
			await this.keep(`${this.repo}/config`, CODE_AREA_CONFIG);
			// A commondir makes repo.git another repository's worktree; alternates borrow objects from elsewhere.
			const stray = [
				`${this.repo}/commondir`,
				`${this.repo}/config.worktree`,
				`${this.repo}/objects/info/alternates`,
				`${this.repo}/objects/info/http-alternates`,
				`${this.repo}/worktrees/main/config.worktree`,
			];
			const removed = await this.sh(
				'for p do if [ -e "$p" ] || [ -L "$p" ]; then rm -f -- "$p" || exit 1; printf "%s\\n" "$p"; fi; done',
				stray,
			);
			if (removed.status !== 0) throw new CodeHostJobFailure("CODE_HOST_PREPARE_FAILED", tail(removed.stderr));
			for (const path of removed.stdout.toString("utf8").split("\n").filter(Boolean))
				this.restored.push(this.relative(path));
		}
		const mainAdmin = type.get(`${this.repo}/worktrees/main`) === "directory",
			mainTree = type.get(this.main) === "directory";
		if (seeded && mainAdmin && mainTree) {
			await this.keep(`${this.repo}/worktrees/main/commondir`, "../..\n");
			await this.keep(`${this.repo}/worktrees/main/gitdir`, `${this.main}/.git\n`);
			await this.keep(`${this.main}/.git`, `gitdir: ${this.repo}/worktrees/main\n`);
			if (type.get(`${this.repo}/worktrees/main/locked`) === "none")
				await this.keep(`${this.repo}/worktrees/main/locked`, MAIN_LOCK);
		}
		return {
			made,
			seeded,
			main:
				mainAdmin && mainTree
					? ("present" as const)
					: mainAdmin || mainTree
						? ("partial" as const)
						: ("none" as const),
			worktree:
				worktree && admin
					? { tree: type.get(worktree) as PathType, admin: type.get(admin) as PathType }
					: undefined,
		};
	}

	/** A ref of the code area, read without following it: its commit, or null when there is none. */
	async ref(ref: string): Promise<string | null> {
		const out = (
			await this.gitOk(
				this.repo,
				["for-each-ref", "--format=%(refname)%00%(objectname)%00%(objecttype)%00%(symref)", ref],
				"CODE_HOST_REF_UNREADABLE",
			)
		).toString("utf8");
		const line = out.split("\n").find((l) => l.split("\0")[0] === ref);
		if (!line) return null;
		const [, objectName, objectType, symref] = line.split("\0");
		if (symref) throw new CodeHostRefusal("CODE_HOST_REF_IS_SYMBOLIC", [ref]);
		if (objectType !== "commit" || !SHA.test(objectName))
			throw new CodeHostRefusal("CODE_HOST_REF_NOT_A_COMMIT", [ref]);
		return objectName;
	}

	async isCommit(gitDir: string, commit: string): Promise<boolean> {
		const result = await this.git(gitDir, ["cat-file", "-t", commit]);
		return result.status === 0 && result.stdout.toString("utf8") === "commit\n";
	}

	/** §6 "Names": every name in the commit's tree in NFC, no two names in one folder that differ only by case, and no
	 * file over 256 MiB. Refused naming the paths, before anything reaches the folder. */
	async checkNames(gitDir: string, commit: string): Promise<void> {
		const listing = await this.gitOk(
			gitDir,
			["ls-tree", "-r", "-t", "-l", "-z", "--full-tree", commit],
			"CODE_HOST_TREE_UNREADABLE",
			{ maximumOutputBytes: MAX_LISTING },
		);
		const decoder = new TextDecoder("utf-8", { fatal: true });
		const notUtf8: string[] = [],
			notNfc: string[] = [],
			large: string[] = [],
			names = new Map<string, string>(),
			siblings = new Set<string>();
		for (const { type, size, path: raw } of treeRecords(listing)) {
			let path: string;
			try {
				path = decoder.decode(raw);
			} catch {
				notUtf8.push(raw.toString("utf8"));
				continue;
			}
			if (path.normalize("NFC") !== path) notNfc.push(path);
			if (type === "blob" && Number(size) > MAX_BLOB) large.push(path);
			const slash = path.lastIndexOf("/"),
				key = `${path.slice(0, slash + 1)}\0${folderKey(path.slice(slash + 1))}`,
				other = names.get(key);
			if (other === undefined) names.set(key, path);
			else siblings.add(other).add(path);
		}
		if (notUtf8.length) throw new CodeHostRefusal("CODE_HOST_NAMES_NOT_UTF8", notUtf8);
		if (notNfc.length) throw new CodeHostRefusal("CODE_HOST_NAMES_NOT_NFC", notNfc);
		if (siblings.size) throw new CodeHostRefusal("CODE_HOST_NAMES_DIFFER_BY_CASE", [...siblings]);
		if (large.length) throw new CodeHostRefusal("CODE_HOST_FILE_TOO_LARGE", large);
	}
}

/** The records of `ls-tree -l -z`, `<mode> <type> <object> <size>\t<path>\0`, with the path as raw bytes. Only this
 * form leaves the path unquoted: `--format` C-quotes `%(path)` even with -z. */
function treeRecords(listing: Buffer): { mode: string; type: string; name: string; size: string; path: Buffer }[] {
	const records: ReturnType<typeof treeRecords> = [];
	let start = 0;
	while (start < listing.length) {
		const end = listing.indexOf(0, start);
		if (end < 0) throw new CodeHostJobFailure("CODE_HOST_TREE_UNREADABLE");
		const record = listing.subarray(start, end),
			tab = record.indexOf(0x09);
		start = end + 1;
		const fields = tab < 0 ? [] : record.subarray(0, tab).toString("latin1").split(/ +/);
		if (fields.length !== 4) throw new CodeHostJobFailure("CODE_HOST_TREE_UNREADABLE");
		const [mode, type, name, size] = fields;
		records.push({ mode, type, name, size, path: record.subarray(tab + 1) });
	}
	return records;
}

async function withJob<T>(job: CodeHostJob, repository: CloudCodingRepository, use: (run: Run) => Promise<T>) {
	const layout = checkLayout(job.layout);
	job.signal.throwIfAborted();
	const run = new Run(job, layout, repository, `${layout.scratchRoot}/${randomUUID()}`);
	const made = await run.command(["/usr/bin/mkdir", "-m", "0700", "--", run.directory], { cwd: layout.scratchRoot });
	if (made.status !== 0) throw new CodeHostJobFailure("CODE_HOST_SCRATCH_UNAVAILABLE", tail(made.stderr));
	try {
		return await use(run);
	} finally {
		await run
			.command(["/usr/bin/rm", "-rf", "--", run.directory], {
				cwd: layout.scratchRoot,
				signal: AbortSignal.timeout(60_000),
			})
			.catch(() => {});
	}
}

export interface CodeAreaSeed {
	repository: CloudCodingRepository;
	baseSha: string;
	/** The broker's bundle of exactly `refs/heads/<baseBranch>` at baseSha: complete, or needing only what the code
	 * area already holds. */
	bundle: Uint8Array | AsyncIterable<Uint8Array>;
}
export interface CodeAreaSeeded {
	state: "seeded" | "updated" | "unchanged";
	baseSha: string;
	/** Files the job found changed and put back. */
	restored: string[];
}

/** Seed or update a code area from the broker's bundle, and move `main/` to it. The bundle is fetched into a scratch
 * repository on the code host's disk (borrowing the code area's objects), its names checked, and repacked into packs
 * under the folder's limit; only then do the packs enter `repo.git`, followed by a compare-and-swap of the base ref
 * (a base another job moved meanwhile fails, and the caller seeds again). */
export async function seedCodeArea(job: CodeHostJob, value: CodeAreaSeed): Promise<CodeAreaSeeded> {
	const input = closed(value, ["repository", "baseSha", "bundle"]);
	const repository = repositoryOf(input.repository),
		baseSha = sha(input.baseSha),
		bundle = input.bundle as CodeAreaSeed["bundle"];
	if (
		!(bundle instanceof Uint8Array) &&
		typeof (bundle as AsyncIterable<Uint8Array>)?.[Symbol.asyncIterator] !== "function"
	)
		throw new Error("INVALID_CODE_HOST_JOB");
	// A repository kept in Qorpera is never seeded from GitHub (startCodeArea makes it).
	if (repository.host !== "github.com") throw new Error("INVALID_CODE_HOST_JOB");
	const base = `refs/heads/${repository.baseBranch}`;
	return withJob(job, repository, async (run) => {
		const area = await run.prepare();
		if (area.seeded && (await run.ref(CODE_AREA_IN_QORPERA_REF)) !== null)
			throw new CodeHostRefusal("CODE_HOST_AREA_IN_QORPERA", [run.area]);
		const file = `${run.directory}/seed.bundle`,
			scratch = `${run.directory}/scratch.git`;
		const put = await run.sh('umask 077; set -C; exec cat >"$1"', [file], { stdin: bundle });
		if (put.status !== 0) throw new CodeHostJobFailure("CODE_HOST_SEED_UNREADABLE", tail(put.stderr));
		await run.gitOk(
			scratch,
			["init", "--quiet", "--bare", "--template=", "--ref-format=files", scratch],
			"CODE_HOST_SEED_FAILED",
		);
		if (area.seeded) {
			const borrowed = await run.sh('printf "%s\\n" "$2" >"$1"', [
				`${scratch}/objects/info/alternates`,
				`${run.repo}/objects`,
			]);
			if (borrowed.status !== 0) throw new CodeHostJobFailure("CODE_HOST_SEED_FAILED", tail(borrowed.stderr));
		}
		const heads = await run.gitOk(scratch, ["bundle", "list-heads", file], "CODE_HOST_SEED_UNREADABLE");
		if (heads.toString("utf8") !== `${baseSha} ${base}\n`) throw new CodeHostRefusal("CODE_HOST_SEED_HEADS", [base]);
		await run.gitOk(scratch, ["bundle", "verify", "--quiet", file], "CODE_HOST_SEED_INCOMPLETE");
		await run.gitOk(
			scratch,
			["fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", file, `${base}:${base}`],
			"CODE_HOST_SEED_FAILED",
		);
		if (
			(await run.gitOk(scratch, ["rev-parse", "--verify", `${base}^{commit}`], "CODE_HOST_SEED_FAILED")).toString(
				"utf8",
			) !== `${baseSha}\n`
		)
			throw new CodeHostRefusal("CODE_HOST_SEED_HEADS", [base]);
		await run.checkNames(scratch, baseSha);
		// Only what the code area does not hold yet, in self-contained packs under the limit.
		await run.gitOk(scratch, ["repack", "-a", "-d", "-l", "-q"], "CODE_HOST_SEED_FAILED");
		const listed = await run.command([
			"/usr/bin/find",
			`${scratch}/objects/pack`,
			"-maxdepth",
			"1",
			"-type",
			"f",
			"-name",
			"pack-*.pack",
			"-printf",
			"%s %p\\n",
		]);
		if (listed.status !== 0) throw new CodeHostJobFailure("CODE_HOST_SEED_FAILED", tail(listed.stderr));
		const packs = listed.stdout
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
		if (!area.seeded) {
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
				"CODE_HOST_SEED_FAILED",
			);
			await run.write(`${run.repo}/config`, CODE_AREA_CONFIG);
			// git takes a repo.git without HEAD for a new one: it writes HEAD and leaves the refs and objects there.
			if (area.made) run.restored.push(run.relative(`${run.repo}/HEAD`));
		}
		// git's own temporary-then-rename for each pack; the folder publishes them with the ref below.
		for (const pack of packs) {
			const indexed = await run.sh('f=$1; shift; exec "$@" <"$f"', [
				pack.path,
				run.layout.git,
				"--no-replace-objects",
				`--git-dir=${run.repo}`,
				"index-pack",
				"--stdin",
			]);
			if (indexed.status !== 0) throw new CodeHostJobFailure("CODE_HOST_SEED_FAILED", tail(indexed.stderr));
		}
		const old = area.made ? await run.ref(base) : null;
		await moveBase(run, area.main, base, baseSha, old ?? ZERO);
		return { state: !old ? "seeded" : old === baseSha ? "unchanged" : "updated", baseSha, restored: run.restored };
	});
}

/** The base ref and main/ move together. One `update-ref --stdin` transaction takes the base ref's lock (the folder's
 * lease, so for every job of every code host of the company) with the compare-and-swap, or only the check when the
 * base is unchanged; main/ is moved while the lock is held, and only then is the ref committed (aborted when main/
 * failed). A seed racing this one fails its own transaction, so no job moves main/ after a later base. main/ is a
 * locked, detached worktree at the default branch, platform-only; a half-made one is made again. Exit 10: the lock
 * or the swap, 11: main/. */
const MOVE_BASE = `git=$1 repo=$2 dir=$3 ref=$4 new=$5 old=$6 state=$7 main=$8 reason=$9
mkfifo -m 0600 "$dir/base.in" "$dir/base.out" || exit 1
"$git" --no-replace-objects --git-dir="$repo" update-ref --no-deref --stdin <"$dir/base.in" >"$dir/base.out" &
pid=$!
exec 3>"$dir/base.in" 4<"$dir/base.out"
answer() { IFS= read -r line <&4 && [ "$line" = "$1: ok" ]; }
finish() { exec 3>&- 4<&-; wait "$pid"; s=$?; [ "$1" -ne 0 ] && exit "$1"; exit "$s"; }
printf 'start\\n' >&3; answer start || finish 10
if [ "$new" = "$old" ]; then printf 'verify %s %s\\n' "$ref" "$old"; else printf 'update %s %s %s\\n' "$ref" "$new" "$old"; fi >&3
printf 'prepare\\n' >&3; answer prepare || finish 10
case $state in
present) "$git" --no-replace-objects --git-dir="$repo/worktrees/main" --work-tree="$main" checkout --quiet --force --detach "$new" ;;
*) { [ "$state" = none ] || rm -rf -- "$main" "$repo/worktrees/main"; } &&
	"$git" --no-replace-objects --git-dir="$repo" worktree add --quiet --lock --reason "$reason" --detach "$main" "$new" &&
	{ printf 'gitdir: %s/worktrees/main\\n' "$repo" | cmp -s - "$main/.git" || { echo "main/ did not get the admin directory worktrees/main" >&2; false; }; } ;;
esac || { printf 'abort\\n' >&3; answer abort; finish 11; }
printf 'commit\\n' >&3; answer commit || finish 10
finish 0`;

async function moveBase(run: Run, state: "present" | "partial" | "none", base: string, commit: string, old: string) {
	const moved = await run.sh(MOVE_BASE, [
		run.layout.git,
		run.repo,
		run.directory,
		base,
		commit,
		old,
		state,
		run.main,
		MAIN_LOCK,
	]);
	if (moved.status === 10) throw new CodeHostJobFailure("CODE_HOST_BASE_MOVED", tail(moved.stderr));
	if (moved.status === 11) throw new CodeHostJobFailure("CODE_HOST_MAIN_FAILED", tail(moved.stderr));
	if (moved.status !== 0) throw new CodeHostJobFailure("CODE_HOST_SEED_FAILED", tail(moved.stderr));
	if (state === "partial") run.restored.push(run.relative(run.main));
}

/** The code area's base commit, or null before the first seed or while main/ is not at it (a seed stopped between
 * the two): lets the broker skip an unchanged bundle only when nothing is left to do. */
export async function readCodeAreaBase(job: CodeHostJob, value: CloudCodingRepository): Promise<string | null> {
	const repository = repositoryOf(value);
	return withJob(job, repository, async (run) => {
		const area = await run.prepare();
		if (!area.seeded || area.main !== "present") return null;
		const base = await run.ref(`refs/heads/${repository.baseBranch}`);
		return base && (await run.read(`${run.repo}/worktrees/main/HEAD`))?.equals(Buffer.from(`${base}\n`))
			? base
			: null;
	});
}

export interface CodeAreaState {
	/** The base ref's commit, or null before the first seed. */
	base: string | null;
	/** main/ is at the base: a seed of the same base would change nothing. */
	ready: boolean;
	/** The commit asked about is in repo.git. */
	holds: boolean;
	restored: string[];
}

/** What a session's attach needs to know before it seeds: the code area's base, whether main/ is at it, and whether
 * the session's base commit is already there. */
export async function inspectCodeArea(
	job: CodeHostJob,
	value: { repository: CloudCodingRepository; commit: string },
): Promise<CodeAreaState> {
	const input = closed(value, ["repository", "commit"]);
	const repository = repositoryOf(input.repository),
		commit = sha(input.commit);
	return withJob(job, repository, async (run) => {
		const area = await run.prepare();
		if (!area.seeded) return { base: null, ready: false, holds: false, restored: run.restored };
		const base = await run.ref(`refs/heads/${repository.baseBranch}`);
		const ready =
			area.main === "present" &&
			base !== null &&
			(await run.read(`${run.repo}/worktrees/main/HEAD`))?.equals(Buffer.from(`${base}\n`)) === true;
		return { base, ready, holds: await run.isCommit(run.repo, commit), restored: run.restored };
	});
}

export interface CodeWorktree {
	repository: CloudCodingRepository;
	workerId: string;
	baseSha: string;
}
export interface CodeWorktreeAdded {
	/** `present`: the session's worktree was already there, and is locked. */
	state: "added" | "present";
	/** The session's branch, or null when a present worktree's branch is gone. */
	headSha: string | null;
	restored: string[];
}

/** A session's worktree, `worktrees/<workerId>/` on `qorpera/coding/<workerId>`, added and locked. The branch starts at
 * baseSha, or keeps its commits when it is already there. A worktree is never unlocked when its session detaches
 * (retain-workspace). */
export async function addCodeWorktree(job: CodeHostJob, value: CodeWorktree): Promise<CodeWorktreeAdded> {
	const input = closed(value, ["repository", "workerId", "baseSha"]);
	const repository = repositoryOf(input.repository),
		workerId = workerIdOf(input.workerId),
		baseSha = sha(input.baseSha);
	const branch = `qorpera/coding/${workerId}`;
	return withJob(job, repository, async (run) => {
		const area = await run.prepare(workerId);
		if (!area.seeded) throw new CodeHostRefusal("CODE_HOST_NOT_SEEDED", [run.area]);
		const tree = `${run.code}/worktrees/${workerId}`,
			admin = `${run.repo}/worktrees/${workerId}`;
		const { tree: treeType, admin: adminType } = area.worktree as { tree: PathType; admin: PathType };
		const head = await run.ref(`refs/heads/${branch}`);
		if (treeType === "directory" && adminType === "directory") {
			const link = await run.read(`${tree}/.git`),
				back = await run.read(`${admin}/gitdir`);
			if (!link?.equals(Buffer.from(`gitdir: ${admin}\n`)) || !back?.equals(Buffer.from(`${tree}/.git\n`)))
				throw new CodeHostRefusal("CODE_HOST_WORKTREE_CHANGED", [run.relative(tree)]);
			if ((await run.types([`${admin}/locked`]))[0] === "none") await run.keep(`${admin}/locked`, WORKTREE_LOCK);
			return { state: "present", headSha: head, restored: run.restored };
		}
		if (treeType !== "none" || adminType !== "none")
			throw new CodeHostRefusal("CODE_HOST_WORKTREE_INCOMPLETE", [
				...(treeType === "none" ? [] : [run.relative(tree)]),
				...(adminType === "none" ? [] : [run.relative(admin)]),
			]);
		if (!head && !(await run.isCommit(run.repo, baseSha)))
			throw new CodeHostRefusal("CODE_HOST_BASE_UNKNOWN", [baseSha]);
		await run.checkNames(run.repo, head ?? baseSha);
		await run.gitOk(
			run.repo,
			head
				? ["worktree", "add", "--quiet", "--lock", "--reason", WORKTREE_LOCK, tree, branch]
				: ["worktree", "add", "--quiet", "--lock", "--reason", WORKTREE_LOCK, "-b", branch, tree, baseSha],
			"CODE_HOST_WORKTREE_FAILED",
		);
		if (!(await run.read(`${tree}/.git`))?.equals(Buffer.from(`gitdir: ${admin}\n`)))
			throw new CodeHostJobFailure("CODE_HOST_WORKTREE_FAILED", "the worktree did not get its own admin directory");
		return { state: "added", headSha: await run.ref(`refs/heads/${branch}`), restored: run.restored };
	});
}

export interface CodeBranchExport {
	repository: CloudCodingRepository;
	workerId: string;
	/** The session's base, which GitHub holds: the bundle leaves out what it reaches. */
	baseSha: string;
	/** The commit the session submitted: its branch's head, or a commit the branch still reaches. */
	headSha: string;
}

/** The session's submitted commit as `refs/heads/qorpera/coding/<workerId>`, without what baseSha reaches, for
 * `coding-git.ts` (which fetches the bundle's prerequisites from GitHub, then fsck, ancestry and push); no bundle when
 * the commit has nothing beyond baseSha, so there is nothing to push. Made in a scratch repository on the code host's
 * disk that borrows the code area's objects: the code area gets no ref of the export's. */
export async function exportCodeBranch(
	job: CodeHostJob,
	value: CodeBranchExport,
	options: { maximumBytes: number },
): Promise<{ headSha: string; bundle: Buffer | null }> {
	const input = closed(value, ["repository", "workerId", "baseSha", "headSha"]);
	const repository = repositoryOf(input.repository),
		workerId = workerIdOf(input.workerId),
		baseSha = sha(input.baseSha),
		headSha = sha(input.headSha);
	if (!Number.isSafeInteger(options?.maximumBytes) || options.maximumBytes < 1)
		throw new Error("INVALID_CODE_HOST_JOB");
	const ref = `refs/heads/qorpera/coding/${workerId}`;
	return withJob(job, repository, async (run) => {
		if (!(await run.prepare()).seeded) throw new CodeHostRefusal("CODE_HOST_NOT_SEEDED", [run.area]);
		const branch = await run.ref(ref);
		if (!branch) throw new CodeHostRefusal("CODE_HOST_EXPORT_NO_BRANCH", [ref]);
		if (!(await run.isCommit(run.repo, baseSha))) throw new CodeHostRefusal("CODE_HOST_BASE_UNKNOWN", [baseSha]);
		// The branch may have moved on since the session submitted; it must still hold what was submitted.
		if (!(await run.isCommit(run.repo, headSha))) throw new CodeHostRefusal("CODE_HOST_EXPORT_MOVED", [ref]);
		const held = await run.git(run.repo, ["merge-base", "--is-ancestor", headSha, branch]);
		if (held.status === 1) throw new CodeHostRefusal("CODE_HOST_EXPORT_MOVED", [ref]);
		if (held.status !== 0) throw new CodeHostJobFailure("CODE_HOST_EXPORT_FAILED", tail(held.stderr));
		const beyond = await run.gitOk(
			run.repo,
			["rev-list", "--max-count=1", headSha, `^${baseSha}`],
			"CODE_HOST_EXPORT_FAILED",
		);
		if (!beyond.length) return { headSha, bundle: null };
		const scratch = `${run.directory}/export.git`,
			file = `${run.directory}/export.bundle`;
		await run.gitOk(
			scratch,
			["init", "--quiet", "--bare", "--template=", "--ref-format=files", scratch],
			"CODE_HOST_EXPORT_FAILED",
		);
		const borrowed = await run.sh('printf "%s\\n" "$2" >"$1"', [
			`${scratch}/objects/info/alternates`,
			`${run.repo}/objects`,
		]);
		if (borrowed.status !== 0) throw new CodeHostJobFailure("CODE_HOST_EXPORT_FAILED", tail(borrowed.stderr));
		await run.gitOk(scratch, ["update-ref", "--no-deref", ref, headSha, ZERO], "CODE_HOST_EXPORT_FAILED");
		await run.gitOk(scratch, ["bundle", "create", "--quiet", file, ref, `^${baseSha}`], "CODE_HOST_EXPORT_FAILED");
		const heads = await run.gitOk(scratch, ["bundle", "list-heads", file], "CODE_HOST_EXPORT_FAILED");
		if (heads.toString("utf8") !== `${headSha} ${ref}\n`)
			throw new CodeHostJobFailure("CODE_HOST_EXPORT_FAILED", "the bundle does not hold the submitted commit");
		const counted = await run.sh('exec wc -c <"$1"', [file]),
			size = Number(counted.stdout.toString("utf8").trim());
		if (counted.status !== 0 || !Number.isSafeInteger(size)) throw new CodeHostJobFailure("CODE_HOST_EXPORT_FAILED");
		if (size > options.maximumBytes) throw new CodeHostRefusal("CODE_HOST_EXPORT_TOO_LARGE", [`${size} bytes`]);
		const read = await run.command(["/usr/bin/cat", "--", file], { maximumOutputBytes: options.maximumBytes });
		if (read.status !== 0 || read.stdout.length !== size) throw new CodeHostJobFailure("CODE_HOST_EXPORT_FAILED");
		return { headSha, bundle: read.stdout };
	});
}

/** The mark of a code area kept in Qorpera (own code storage, slice 1): a ref at its first commit, made with it. A seed
 * from GitHub refuses an area that has it, and a start or a landing refuses a seeded area without it, so one code area
 * never holds both a copy of a GitHub repository and a repository kept here. */
export const CODE_AREA_IN_QORPERA_REF = "refs/qorpera/kept-here";
/** Who makes the platform's own commits in a repository kept in Qorpera: its first commit and its merges. */
const PLATFORM_COMMITTER = ["-c", "user.name=Qorpera", "-c", "user.email=code@qorpera.com"] as const;

export interface CodeAreaStarted {
	/** `started`: the repository was made by this job, with one empty commit. `present`: it was already there. */
	state: "started" | "present";
	/** The default branch's commit: a session's base. */
	baseSha: string;
	restored: string[];
}

/** A repository kept in Qorpera (host `qorpera`), made empty when it is not there yet: `repo.git` with one commit of no
 * files on the default branch, its mark, and `main/` at it. A repository already there answers its default branch, and
 * main/ is moved to it when a start or landing stopped between the two. A code area seeded from GitHub is refused
 * (`CODE_HOST_AREA_FROM_GITHUB`). */
export async function startCodeArea(
	job: CodeHostJob,
	value: { repository: CloudCodingRepository },
): Promise<CodeAreaStarted> {
	const input = closed(value, ["repository"]);
	const repository = repositoryOf(input.repository);
	if (repository.host !== "qorpera") throw new Error("INVALID_CODE_HOST_JOB");
	const base = `refs/heads/${repository.baseBranch}`;
	return withJob(job, repository, async (run) => {
		const area = await run.prepare();
		if (!area.seeded) {
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
				"CODE_HOST_START_FAILED",
			);
			await run.write(`${run.repo}/config`, CODE_AREA_CONFIG);
			if (area.made) run.restored.push(run.relative(`${run.repo}/HEAD`));
		}
		let kept = await run.ref(CODE_AREA_IN_QORPERA_REF);
		const head = await run.ref(base);
		if (kept === null && head !== null) throw new CodeHostRefusal("CODE_HOST_AREA_FROM_GITHUB", [run.area]);
		if (kept === null) {
			const tree = (await run.gitOk(run.repo, ["mktree"], "CODE_HOST_START_FAILED", { stdin: new Uint8Array() }))
				.toString("utf8")
				.trim();
			const first = (
				await run.gitOk(
					run.repo,
					[...PLATFORM_COMMITTER, "commit-tree", tree, "-m", `Start ${repository.name}`],
					"CODE_HOST_START_FAILED",
				)
			)
				.toString("utf8")
				.trim();
			if (!SHA.test(first)) throw new CodeHostJobFailure("CODE_HOST_START_FAILED", "no first commit");
			await run.gitOk(
				run.repo,
				["update-ref", "--no-deref", CODE_AREA_IN_QORPERA_REF, first, ZERO],
				"CODE_HOST_START_FAILED",
			);
			kept = first;
		}
		if (head === null) {
			await moveBase(run, area.main, base, kept, ZERO);
			return { state: "started", baseSha: kept, restored: run.restored };
		}
		const at =
			area.main === "present" &&
			(await run.read(`${run.repo}/worktrees/main/HEAD`))?.equals(Buffer.from(`${head}\n`)) === true;
		if (!at) await moveBase(run, area.main, base, head, head);
		return { state: "present", baseSha: head, restored: run.restored };
	});
}

export interface CodeBranchLanding {
	repository: CloudCodingRepository;
	workerId: string;
	/** The commit the session submitted: its branch's head, or a commit the branch still reaches. */
	headSha: string;
}
export interface CodeBranchLanded {
	/** `fast-forward`: the default branch moved to the submitted commit. `merged`: to a merge of it with the default
	 * branch, which had moved on. `unchanged`: the default branch already held it. */
	state: "fast-forward" | "merged" | "unchanged";
	/** The default branch's commit after the landing. */
	mainSha: string;
	restored: string[];
}

/** A session's submitted commit landed on the default branch of a repository kept in Qorpera, with main/ moved to it
 * in the same step as the branch (`moveBase`'s compare-and-swap: a landing racing another fails, and is asked again).
 * When the default branch moved on since the session's base, the two are merged by git's own merge (`merge-tree`, no
 * worktree); a conflict lands nothing and is refused naming its paths (`CODE_HOST_LAND_CONFLICT`), for the session to
 * merge itself. The landed tree passes the same name checks as a seed. */
export async function landCodeBranch(job: CodeHostJob, value: CodeBranchLanding): Promise<CodeBranchLanded> {
	const input = closed(value, ["repository", "workerId", "headSha"]);
	const repository = repositoryOf(input.repository),
		workerId = workerIdOf(input.workerId),
		headSha = sha(input.headSha);
	if (repository.host !== "qorpera") throw new Error("INVALID_CODE_HOST_JOB");
	const ref = `refs/heads/qorpera/coding/${workerId}`,
		base = `refs/heads/${repository.baseBranch}`;
	return withJob(job, repository, async (run) => {
		const area = await run.prepare();
		if (!area.seeded) throw new CodeHostRefusal("CODE_HOST_NOT_SEEDED", [run.area]);
		if ((await run.ref(CODE_AREA_IN_QORPERA_REF)) === null)
			throw new CodeHostRefusal("CODE_HOST_AREA_FROM_GITHUB", [run.area]);
		const branch = await run.ref(ref);
		if (!branch) throw new CodeHostRefusal("CODE_HOST_EXPORT_NO_BRANCH", [ref]);
		if (!(await run.isCommit(run.repo, headSha))) throw new CodeHostRefusal("CODE_HOST_EXPORT_MOVED", [ref]);
		const ancestor = async (older: string, newer: string): Promise<boolean> => {
			const result = await run.git(run.repo, ["merge-base", "--is-ancestor", older, newer]);
			if (result.status !== 0 && result.status !== 1)
				throw new CodeHostJobFailure("CODE_HOST_LAND_FAILED", tail(result.stderr));
			return result.status === 0;
		};
		// The branch may have moved on since the session submitted; it must still hold what was submitted.
		if (!(await ancestor(headSha, branch))) throw new CodeHostRefusal("CODE_HOST_EXPORT_MOVED", [ref]);
		const current = await run.ref(base);
		if (!current) throw new CodeHostRefusal("CODE_HOST_AREA_NO_BASE", [base]);
		if (await ancestor(headSha, current)) {
			const at =
				area.main === "present" &&
				(await run.read(`${run.repo}/worktrees/main/HEAD`))?.equals(Buffer.from(`${current}\n`)) === true;
			if (!at) await moveBase(run, area.main, base, current, current);
			return { state: "unchanged", mainSha: current, restored: run.restored };
		}
		let next = headSha,
			state: CodeBranchLanded["state"] = "fast-forward";
		if (!(await ancestor(current, headSha))) {
			const merged = await run.git(run.repo, [
				"merge-tree",
				"--write-tree",
				"-z",
				"--name-only",
				"--no-messages",
				current,
				headSha,
			]);
			const fields = merged.stdout.toString("utf8").split("\0");
			if (merged.status === 1) {
				// The tree, then each conflicted path (one per conflicting stage), then an empty field.
				const paths = [...new Set(fields.slice(1).filter(Boolean))];
				throw new CodeHostRefusal("CODE_HOST_LAND_CONFLICT", paths);
			}
			if (merged.status !== 0 || !SHA.test(fields[0] ?? ""))
				throw new CodeHostJobFailure("CODE_HOST_LAND_FAILED", tail(merged.stderr));
			next = (
				await run.gitOk(
					run.repo,
					[
						...PLATFORM_COMMITTER,
						"commit-tree",
						fields[0] as string,
						"-p",
						current,
						"-p",
						headSha,
						"-m",
						`Merge the work of coding session ${workerId}`,
					],
					"CODE_HOST_LAND_FAILED",
				)
			)
				.toString("utf8")
				.trim();
			if (!SHA.test(next)) throw new CodeHostJobFailure("CODE_HOST_LAND_FAILED", "no merge commit");
			state = "merged";
		}
		await run.checkNames(run.repo, next);
		await moveBase(run, area.main, base, next, current);
		return { state, mainSha: next, restored: run.restored };
	});
}

/** The core's gc lease block for one code area, through the job's code_host view (5b):
 * `qorpera_folder_git_gc_begin`, polled until no lease is held, and `qorpera_folder_git_gc_end`. */
export interface CodeHostGcBlock {
	/** `repository` is the code area's folder path, `codeAreaPath`'s `code/<owner>/<name>`. */
	begin(repository: string, signal: AbortSignal): Promise<{ state: "blocking"; held: number } | { state: "busy" }>;
	end(repository: string, signal: AbortSignal): Promise<void>;
}
export interface CodeGarbageOptions {
	pollMs?: number;
	maximumWaitMs?: number;
	sleep?(ms: number, signal: AbortSignal): Promise<void>;
	now?(): number;
}
export type CodeGarbageCollected =
	| { state: "collected"; restored: string[] }
	/** Another code host's view holds the block. */
	| { state: "busy" }
	/** Leases were still held when the wait ran out; the block was ended. */
	| { state: "held"; held: number };

/** gc with the lease block: new leases in repo.git wait while it runs (worktrees and everything outside repo.git do
 * not), and it starts once none is held. Worker branches stay loose. */
export async function collectCodeGarbage(
	job: CodeHostJob,
	value: { repository: CloudCodingRepository },
	block: CodeHostGcBlock,
	options: CodeGarbageOptions = {},
): Promise<CodeGarbageCollected> {
	const input = closed(value, ["repository"]);
	const repository = repositoryOf(input.repository);
	const pollMs = options.pollMs ?? 1000,
		maximumWaitMs = options.maximumWaitMs ?? 300_000,
		sleep = options.sleep ?? ((ms: number, signal: AbortSignal) => delay(ms, undefined, { signal })),
		now = options.now ?? Date.now;
	return withJob(job, repository, async (run) => {
		if (!(await run.prepare()).seeded) throw new CodeHostRefusal("CODE_HOST_NOT_SEEDED", [run.area]);
		const started = now();
		const first = await block.begin(run.area, job.signal);
		if (first.state === "busy") return { state: "busy" };
		const collect = async (): Promise<CodeGarbageCollected> => {
			let held = first.held;
			while (held > 0) {
				if (now() - started >= maximumWaitMs) return { state: "held", held };
				await sleep(pollMs, job.signal);
				const answer = await block.begin(run.area, job.signal);
				if (answer.state === "busy") throw new CodeHostJobFailure("CODE_HOST_GC_BLOCK_LOST");
				held = answer.held;
			}
			// A shallow line would make prune drop the history behind it, and sessions can write repo.git/shallow.
			if ((await run.types([`${run.repo}/shallow`]))[0] !== "none")
				throw new CodeHostRefusal("CODE_HOST_GC_SHALLOW", [`${run.area}/repo.git/shallow`]);
			await run.gitOk(
				run.repo,
				["pack-refs", "--all", "--exclude", "refs/heads/qorpera/coding/*"],
				"CODE_HOST_GC_FAILED",
			);
			await run.gitOk(run.repo, ["gc", "--quiet"], "CODE_HOST_GC_FAILED");
			return { state: "collected", restored: run.restored };
		};
		const end = () => block.end(run.area, AbortSignal.timeout(30_000));
		let result: CodeGarbageCollected;
		try {
			result = await collect();
		} catch (error) {
			// The block always ends; the job's own error is the one that counts.
			await end().catch(() => {});
			throw error;
		}
		await end();
		return result;
	});
}

/** One path of a commit: a regular file (mode 100644 or 100755) with its bytes, something else (a folder, a link or a
 * submodule), or nothing. The shape of 5h's `CodingSetupSource`. */
export type CodeCommitEntry = { kind: "missing" } | { kind: "file"; bytes: Uint8Array } | { kind: "other" };
export interface CodeCommitSource {
	/** `path` is repository-relative, without `.` or `..` parts. A file over maxBytes comes back cut after maxBytes + 1
	 * bytes. A failed read throws; it is never `missing`. */
	read(path: string, maxBytes: number): Promise<CodeCommitEntry>;
}

function repositoryPath(value: unknown): string {
	if (
		typeof value !== "string" ||
		!value ||
		value.length > 4096 ||
		/[\0\n\r]/.test(value) ||
		value.split("/").some((part) => !part || part === "." || part === "..")
	)
		throw new Error("INVALID_CODE_HOST_PATH");
	return value;
}

/** Files of one commit, read by git from the code area's objects and never from a worktree, for the setup file and
 * what it names (5h). The source reads only while `use` runs. */
export async function withCodeCommit<T>(
	job: CodeHostJob,
	value: { repository: CloudCodingRepository; commit: string },
	use: (source: CodeCommitSource) => Promise<T>,
): Promise<T> {
	const input = closed(value, ["repository", "commit"]);
	const repository = repositoryOf(input.repository),
		commit = sha(input.commit);
	return withJob(job, repository, async (run) => {
		if (!(await run.prepare()).seeded) throw new CodeHostRefusal("CODE_HOST_NOT_SEEDED", [run.area]);
		if (!(await run.isCommit(run.repo, commit))) throw new CodeHostRefusal("CODE_HOST_COMMIT_UNKNOWN", [commit]);
		let open = true;
		const read = async (pathValue: string, maxBytes: number): Promise<CodeCommitEntry> => {
			if (!open) throw new Error("CODE_HOST_SOURCE_CLOSED");
			const path = repositoryPath(pathValue);
			if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes >= MAX_READ)
				throw new Error("INVALID_CODE_HOST_JOB");
			// Without -r, ls-tree walks down to the path and shows its own entry.
			const listing = await run.gitOk(
				run.repo,
				["ls-tree", "-l", "-z", "--full-tree", commit, "--", path],
				"CODE_HOST_TREE_UNREADABLE",
			);
			const wantedPath = Buffer.from(path, "utf8");
			const entry = treeRecords(listing).find((record) => record.path.equals(wantedPath));
			if (!entry) return { kind: "missing" };
			const { mode, type, name, size } = entry;
			if (type !== "blob" || (mode !== "100644" && mode !== "100755")) return { kind: "other" };
			const bytes = Number(size);
			if (!SHA.test(name) || !Number.isSafeInteger(bytes)) throw new CodeHostJobFailure("CODE_HOST_TREE_UNREADABLE");
			const wanted = Math.min(bytes, maxBytes + 1);
			const result =
				bytes <= maxBytes
					? await run.git(run.repo, ["cat-file", "blob", name], { maximumOutputBytes: wanted })
					: await run.sh(
							'n=$1; shift; "$@" | exec /usr/bin/head -c "$n"',
							[
								String(wanted),
								run.layout.git,
								"--no-replace-objects",
								`--git-dir=${run.repo}`,
								"cat-file",
								"blob",
								name,
							],
							{ maximumOutputBytes: wanted },
						);
			if (result.status !== 0 || result.stdout.length !== wanted)
				throw new CodeHostJobFailure("CODE_HOST_FILE_UNREADABLE", tail(result.stderr));
			return { kind: "file", bytes: new Uint8Array(result.stdout) };
		};
		try {
			return await use({ read });
		} finally {
			open = false;
		}
	});
}
