import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { type CloudCodingRepository, folderKey, isUuid, parseCloudCodingRepository } from "@qorpera/contracts";
import { withTimeoutScope } from "./abort-scope.ts";
import { CODE_FOLDER_ANY_SESSION, codeFolderRefuses } from "./code-folder-names.ts";

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
	stdin?: Uint8Array | AsyncIterable<Uint8Array>;
	onStdout?: (chunk: Buffer) => void;
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
	preparedKeptArea?: string;
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
/** A session's worktree refused for the names of what it would hold (`addCodeWorktree`): the refusal of the names'
 * rules (`Run.checkNames`, and the company folder's, `CODE_HOST_NAMES_FOLDER_REFUSES`), saying whose names they are.
 * `branch`: the session's own branch, whose worktree was to be made again; `base`: the base a new worktree starts at. */
export class CodeWorktreeNamesRefused extends CodeHostRefusal {
	readonly of: "branch" | "base";
	constructor(code: string, paths: readonly string[], of: "branch" | "base") {
		super(code, paths);
		this.of = of;
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

// What follows without a doc comment of its own surface is exported for the code host's other job files (a second
// file of jobs builds on the same run, the same guarded move of main and the same limits). It is not the executor's
// surface: the executor calls the job functions.
export const SHA = /^[0-9a-f]{40}$/;
export const SHA256 = /^[0-9a-f]{64}$/;
export const ZERO = "0".repeat(40);
export const MiB = 1024 ** 2;
export const GiB = 1024 ** 3;
/** Q13: single files over 256 MiB are refused until large files; the folder refuses a pack of 256 MiB or more. */
export const MAX_BLOB = 256 * MiB;
export const MAX_PACK = 256 * MiB;
export const MAX_LISTING = 256 * MiB;
/** A commit file read (5h reads at most 1 MiB). */
export const MAX_READ = 16 * MiB;
export const MAX_TEXT = 64 * 1024;
/** Every ref of a code area in one listing: a session may keep branches and tags of its own beside its branch. */
export const MAX_REFS = 64 * MiB;
/** One exec's output is held in memory, and LXD's pipe carries at most this (lxd-client.ts). */
export const MAX_PIECE = 256 * MiB;
/** The platform's repository config, byte for byte: no include, extension, filter, hook or worktree setting. */
export const CODE_AREA_CONFIG = "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = true\n";
export const MAIN_LOCK = "qorpera: the default branch, platform-only";
export const WORKTREE_LOCK = "qorpera: a coding session's worktree";
/** The mark of a restore under way, `code/<owner>/<name>/restoring.json` (own code storage, step 2b): the platform's
 * alone, there from the job that set the damaged place aside until the job that built the repository again. */
export const CODE_AREA_RESTORING = "restoring.json";

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
export function closed<T extends string>(value: unknown, keys: readonly T[]): Record<T, unknown> {
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
export function tail(text: string): string {
	return text.length > 2000 ? text.slice(-2000) : text;
}

type PathType = "none" | "link" | "directory" | "file" | "other";
const PATH_TYPES = new Set<string>(["none", "link", "directory", "file", "other"]);

/** One job: its scratch directory, its environment, and the code area's paths. */
export class Run {
	readonly job: CodeHostJob;
	readonly layout: CodeHostLayout;
	readonly repository: CloudCodingRepository;
	readonly directory: string;
	readonly code: string;
	readonly repo: string;
	readonly main: string;
	readonly area: string;
	readonly restored: string[] = [];
	/** How often the job moved the base (`moveBase`). */
	moves = 0;
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
			onStdout?: CodeHostCommand["onStdout"];
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
				...(options.onStdout === undefined ? {} : { onStdout: options.onStdout }),
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

	async readMany(paths: readonly string[]): Promise<(Buffer | null)[]> {
		const out: (Buffer | null)[] = [];
		for (let start = 0; start < paths.length; start += 60) {
			const part = paths.slice(start, start + 60);
			const result = await this.sh(
				'for p do if [ -f "$p" ]; then s=$(wc -c <"$p") || exit 1; printf "F %d\\n" "$s"; cat -- "$p" || exit 1; else printf "M\\n"; fi; done',
				part,
			);
			if (result.status !== 0) throw new CodeHostJobFailure("CODE_HOST_READ_FAILED", tail(result.stderr));
			let offset = 0;
			for (let i = 0; i < part.length; i++) {
				const nl = result.stdout.indexOf(0x0a, offset);
				if (nl < 0) throw new CodeHostJobFailure("CODE_HOST_READ_FAILED", "truncated batch read");
				const header = result.stdout.subarray(offset, nl).toString("latin1");
				offset = nl + 1;
				if (header === "M") {
					out.push(null);
				} else {
					const match = /^F (\d+)$/.exec(header);
					const size = match ? Number(match[1]) : Number.NaN;
					if (!Number.isSafeInteger(size) || offset + size > result.stdout.length)
						throw new CodeHostJobFailure("CODE_HOST_READ_FAILED", "malformed batch read");
					out.push(result.stdout.subarray(offset, offset + size));
					offset += size;
				}
			}
			if (offset !== result.stdout.length)
				throw new CodeHostJobFailure("CODE_HOST_READ_FAILED", "malformed batch read");
		}
		return out;
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

	async #repairFiles(
		before: readonly (readonly [string, string])[],
		stray: readonly string[],
		after: readonly (readonly [string, string])[],
	): Promise<void> {
		const args: string[] = [String(before.length)];
		for (const [p, c] of before) args.push(p, c);
		args.push(String(stray.length), ...stray);
		for (const [p, c] of after) args.push(p, c);
		const result = await this.sh(
			'n=$1; shift; i=0; while [ "$i" -lt "$n" ]; do p=$1; c=$2; shift 2; i=$((i + 1)); if [ -f "$p" ] && printf %s "$c" | cmp -s - "$p"; then continue; fi; (set -C; umask 022; printf %s "$c" >"$p.lock") && mv -fT -- "$p.lock" "$p" || exit 11; printf "%s\\n" "$p"; done; m=$1; shift; i=0; while [ "$i" -lt "$m" ]; do p=$1; shift; i=$((i + 1)); if [ -e "$p" ] || [ -L "$p" ]; then rm -f -- "$p" || exit 12; printf "%s\\n" "$p"; fi; done; while [ "$#" -ge 2 ]; do p=$1; c=$2; shift 2; if [ -f "$p" ] && printf %s "$c" | cmp -s - "$p"; then continue; fi; (set -C; umask 022; printf %s "$c" >"$p.lock") && mv -fT -- "$p.lock" "$p" || exit 11; printf "%s\\n" "$p"; done',
			args,
		);
		if (result.status === 11) throw new CodeHostJobFailure("CODE_HOST_WRITE_FAILED", tail(result.stderr));
		if (result.status !== 0) throw new CodeHostJobFailure("CODE_HOST_PREPARE_FAILED", tail(result.stderr));
		for (const path of result.stdout.toString("utf8").split("\n").filter(Boolean))
			this.restored.push(this.relative(path));
	}

	/** Before every job: no link on the way to or inside the code area's parts, the platform's config, no file that
	 * points git elsewhere, and main/'s admin files as the platform made them. A place a restore is working on (it
	 * holds `restoring.json`, own code storage step 2b) is refused before anything is repaired there
	 * (`CODE_HOST_RESTORE_IN_PROGRESS`): only a restore's own jobs pass `restoring`. */
	async prepare(workerId?: string, options: { restoring?: boolean } = {}) {
		const worktree = workerId ? `${this.code}/worktrees/${workerId}` : undefined,
			admin = workerId ? `${this.repo}/worktrees/${workerId}` : undefined,
			mark = `${this.code}/${CODE_AREA_RESTORING}`;
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
			mark,
		];
		const extra = admin ? [`${admin}/locked`] : [];
		const types = await this.types([...directories, ...files, ...extra]);
		const type = new Map([...directories, ...files, ...extra].map((path, index) => [path, types[index]]));
		const links = [...type].filter(([, t]) => t === "link").map(([path]) => this.relative(path));
		if (links.length) throw new CodeHostRefusal("CODE_HOST_LINK", links);
		// Whatever has the mark's name closes the place to every job but a restore's own.
		if (options.restoring !== true && type.get(mark) !== "none")
			throw new CodeHostRefusal("CODE_HOST_RESTORE_IN_PROGRESS", [this.area]);
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
		const mainAdmin = type.get(`${this.repo}/worktrees/main`) === "directory",
			mainTree = type.get(this.main) === "directory";
		if (made) {
			const before: (readonly [string, string])[] = [[`${this.repo}/config`, CODE_AREA_CONFIG]];
			const stray = [
				`${this.repo}/commondir`,
				`${this.repo}/config.worktree`,
				`${this.repo}/objects/info/alternates`,
				`${this.repo}/objects/info/http-alternates`,
				`${this.repo}/worktrees/main/config.worktree`,
			];
			const after: (readonly [string, string])[] = [];
			if (seeded && mainAdmin && mainTree) {
				after.push(
					[`${this.repo}/worktrees/main/commondir`, "../..\n"],
					[`${this.repo}/worktrees/main/gitdir`, `${this.main}/.git\n`],
					[`${this.main}/.git`, `gitdir: ${this.repo}/worktrees/main\n`],
				);
				if (type.get(`${this.repo}/worktrees/main/locked`) === "none")
					after.push([`${this.repo}/worktrees/main/locked`, MAIN_LOCK]);
			}
			await this.#repairFiles(before, stray, after);
		}
		return {
			made,
			seeded,
			restoring: type.get(mark) === "file",
			main:
				mainAdmin && mainTree
					? ("present" as const)
					: mainAdmin || mainTree
						? ("partial" as const)
						: ("none" as const),
			worktree:
				worktree && admin
					? {
							tree: type.get(worktree) as PathType,
							admin: type.get(admin) as PathType,
							locked: type.get(`${admin}/locked`) as PathType,
						}
					: undefined,
		};
	}

	async refsNamed(refs: readonly string[]): Promise<(ref: string) => string | null> {
		const byName = new Map<string, readonly [string, string, string]>();
		if (refs.length > 0) {
			const unique = [...new Set(refs)];
			const out = (
				await this.gitOk(
					this.repo,
					["for-each-ref", "--format=%(refname)%00%(objectname)%00%(objecttype)%00%(symref)", ...unique],
					"CODE_HOST_REF_UNREADABLE",
				)
			).toString("utf8");
			for (const line of out.split("\n")) {
				if (!line) continue;
				const [name, objectName = "", objectType = "", symref = ""] = line.split("\0");
				if (name) byName.set(name, [objectName, objectType, symref]);
			}
		}
		return (ref: string): string | null => {
			const entry = byName.get(ref);
			if (!entry) return null;
			const [objectName, objectType, symref] = entry;
			if (symref) throw new CodeHostRefusal("CODE_HOST_REF_IS_SYMBOLIC", [ref]);
			if (objectType !== "commit" || !SHA.test(objectName))
				throw new CodeHostRefusal("CODE_HOST_REF_NOT_A_COMMIT", [ref]);
			return objectName;
		};
	}

	/** A ref of the code area, read without following it: its commit, or null when there is none. */
	async ref(ref: string): Promise<string | null> {
		return (await this.refsNamed([ref]))(ref);
	}

	/** Every ref of a git directory in one read, in git's order (by name), each with the object it names: for a
	 * symbolic ref, the one it leads to. */
	async refs(gitDir: string): Promise<{ name: string; sha: string; type: string; symref: string }[]> {
		const out = await this.gitOk(
			gitDir,
			["for-each-ref", "--format=%(refname)%00%(objectname)%00%(objecttype)%00%(symref)"],
			"CODE_HOST_REF_UNREADABLE",
			{ maximumOutputBytes: MAX_REFS },
		);
		return out
			.toString("utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				const [name, objectName, type, symref] = line.split("\0");
				if (!name || !objectName || !SHA.test(objectName) || !type || symref === undefined)
					throw new CodeHostJobFailure("CODE_HOST_REF_UNREADABLE", "a ref line is not git's");
				return { name, sha: objectName, type, symref };
			});
	}

	/** Whether a worktree holds exactly what its HEAD and index say, by git's own status (given whole, with its git
	 * directory and work tree): it printed nothing. Its output stays in the scratch, so a worktree full of changes
	 * fails no command; a status that failed proves nothing, and counts as not clean. */
	async clean(status: readonly string[]): Promise<boolean> {
		const result = await this.sh('out=$1; shift; "$@" >"$out" || exit 2; [ ! -s "$out" ]', [
			`${this.directory}/status.out`,
			this.layout.git,
			"--no-replace-objects",
			...status,
		]);
		return result.status === 0;
	}

	async isCommit(gitDir: string, commit: string): Promise<boolean> {
		const result = await this.git(gitDir, ["cat-file", "-t", commit]);
		return result.status === 0 && result.stdout.toString("utf8") === "commit\n";
	}

	async areCommits(gitDir: string, commits: readonly string[]): Promise<boolean[]> {
		if (commits.length === 0) return [];
		const result = await this.git(gitDir, ["cat-file", "--batch-check=%(objecttype)"], {
			stdin: Buffer.from(`${commits.join("\n")}\n`),
		});
		if (result.status !== 0) return commits.map(() => false);
		const lines = result.stdout.toString("utf8").split("\n");
		if (lines.pop() !== "" || lines.length !== commits.length) return commits.map(() => false);
		return lines.map((line) => line === "commit");
	}

	/** §6 "Names": every name in the commit's tree in NFC, no two names in one folder that differ only by case, and no
	 * file over 256 MiB. Refused naming the paths, before anything reaches the folder. Answers the tree's records, its
	 * folders among them. */
	async checkNames(gitDir: string, commit: string): Promise<ReturnType<typeof treeRecords>> {
		const listing = await this.gitOk(
			gitDir,
			["ls-tree", "-r", "-t", "-l", "-z", "--full-tree", commit],
			"CODE_HOST_TREE_UNREADABLE",
			{ maximumOutputBytes: MAX_LISTING },
		);
		const decoder = new TextDecoder("utf-8", { fatal: true });
		const records = treeRecords(listing),
			notUtf8: string[] = [],
			notNfc: string[] = [],
			large: string[] = [],
			names = new Map<string, string>(),
			siblings = new Set<string>();
		for (const { type, size, path: raw } of records) {
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
		return records;
	}

	async checkNamesIncremental(
		gitDir: string,
		baseCommit: string,
		nextCommit: string,
	): Promise<{ records: ReturnType<typeof treeRecords>; checksFileTouched: boolean }> {
		const diff = await this.gitOk(
			gitDir,
			["diff-tree", "-r", "-z", "--no-renames", "--raw", baseCommit, nextCommit],
			"CODE_HOST_TREE_UNREADABLE",
			{ maximumOutputBytes: MAX_LISTING },
		);
		const decoder = new TextDecoder("utf-8", { fatal: true });
		const checksFileBytes = Buffer.from(CODE_CHECKS_FILE, "utf8");
		const notUtf8: string[] = [];
		const touchedDirs = new Set<string>();
		let addedOrChanged = 0;
		let checksFileTouched = false;
		for (let start = 0; start < diff.length; ) {
			const headerEnd = diff.indexOf(0, start);
			const pathEnd = headerEnd < 0 ? -1 : diff.indexOf(0, headerEnd + 1);
			if (pathEnd < 0) throw new CodeHostJobFailure("CODE_HOST_TREE_UNREADABLE");
			const header = diff.subarray(start, headerEnd).toString("latin1");
			const raw = diff.subarray(headerEnd + 1, pathEnd);
			start = pathEnd + 1;
			if (!header.startsWith(":")) throw new CodeHostJobFailure("CODE_HOST_TREE_UNREADABLE");
			if (raw.equals(checksFileBytes)) checksFileTouched = true;
			const status = header.slice(header.lastIndexOf(" ") + 1);
			if (status === "D") continue;
			addedOrChanged += 1;
			let decoded: string;
			try {
				decoded = decoder.decode(raw);
			} catch {
				notUtf8.push(raw.toString("utf8"));
				continue;
			}
			touchedDirs.add("");
			let slash = decoded.indexOf("/");
			while (slash >= 0) {
				touchedDirs.add(decoded.slice(0, slash));
				slash = decoded.indexOf("/", slash + 1);
			}
		}
		if (notUtf8.length) throw new CodeHostRefusal("CODE_HOST_NAMES_NOT_UTF8", notUtf8);
		if (addedOrChanged === 0) return { records: [], checksFileTouched };
		if (touchedDirs.size > 200) return { records: await this.checkNames(gitDir, nextCommit), checksFileTouched };
		const byDepth = new Map<number, string[]>();
		for (const dir of touchedDirs) {
			const depth = dir === "" ? 0 : dir.split("/").length;
			const bucket = byDepth.get(depth);
			if (bucket) bucket.push(dir);
			else byDepth.set(depth, [dir]);
		}
		const records: ReturnType<typeof treeRecords> = [];
		const depths = [...byDepth.keys()].sort((a, b) => a - b);
		for (const depth of depths) {
			const dirs = byDepth.get(depth) as string[];
			if (depth === 0) {
				const listing = await this.gitOk(gitDir, ["ls-tree", "-l", "-z", nextCommit], "CODE_HOST_TREE_UNREADABLE", {
					maximumOutputBytes: MAX_LISTING,
				});
				records.push(...treeRecords(listing));
			} else {
				for (let at = 0; at < dirs.length; at += 40) {
					const part = dirs.slice(at, at + 40).map((dir) => `${dir}/`);
					const listing = await this.gitOk(
						gitDir,
						["--literal-pathspecs", "ls-tree", "-l", "-z", nextCommit, "--", ...part],
						"CODE_HOST_TREE_UNREADABLE",
						{ maximumOutputBytes: MAX_LISTING },
					);
					records.push(...treeRecords(listing));
				}
			}
		}
		records.sort((a, b) => Buffer.compare(a.path, b.path));
		const notNfc: string[] = [];
		const large: string[] = [];
		const names = new Map<string, string>();
		const siblings = new Set<string>();
		for (const { type, size, path: raw } of records) {
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
		return { records, checksFileTouched };
	}
}

export const STREAM_FILE_WINDOW_BYTES = 32 * 1024 * 1024;
const STREAM_FILE_WINDOW_CHUNKS = 4;

export async function streamFileOut(
	run: Run,
	file: string,
	expectedBytes: number,
	expectedSha256: string,
	chunkBytes: number,
	write: (piece: Buffer) => Promise<void>,
	failureCode: string,
	mismatchMessage: string,
	maxWindowBytes = STREAM_FILE_WINDOW_BYTES,
): Promise<void> {
	if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || !Number.isSafeInteger(chunkBytes) || chunkBytes < 1)
		throw new Error("INVALID_CODE_HOST_JOB");
	const read = createHash("sha256");
	if (expectedBytes === 0) {
		const probe = await run.command(["/usr/bin/dd", `if=${file}`, "bs=1", "count=1", "status=none"], {
			maximumOutputBytes: 1,
		});
		if (probe.status !== 0) throw new CodeHostJobFailure(failureCode, tail(probe.stderr) || "a piece was cut short");
		if (probe.stdout.length > 0) throw new CodeHostJobFailure(failureCode, "the file grew while being read");
		if (read.digest("hex") !== expectedSha256) throw new CodeHostJobFailure(failureCode, mismatchMessage);
		return;
	}
	const chunksPerWindow = Math.max(
		1,
		Math.min(STREAM_FILE_WINDOW_CHUNKS, Math.floor(Math.max(chunkBytes, maxWindowBytes) / chunkBytes)),
	);
	const windowBytes = chunksPerWindow * chunkBytes;
	let total = 0;
	for (let chunkIndex = 0; chunkIndex * chunkBytes < expectedBytes; chunkIndex += chunksPerWindow) {
		const offset = chunkIndex * chunkBytes;
		const wantBytes = Math.min(windowBytes, expectedBytes - offset);
		const wantChunks = Math.ceil(wantBytes / chunkBytes);
		const isFinalWindow = offset + wantBytes === expectedBytes;
		const streamAbort = new AbortController();
		const onJobAbort = () => streamAbort.abort(run.job.signal.reason);
		if (run.job.signal.aborted) streamAbort.abort(run.job.signal.reason);
		else run.job.signal.addEventListener("abort", onJobAbort, { once: true });
		let pending: Buffer[] = [];
		let pendingBytes = 0;
		let windowTotal = 0;
		let chain: Promise<void> = Promise.resolve();
		let hasWriteFailure = false;
		let writeFailure: unknown;
		let overflow = false;
		const enqueue = (piece: Buffer) => {
			const copy = Buffer.from(piece);
			chain = chain
				.then(async () => {
					if (hasWriteFailure) return;
					run.job.signal.throwIfAborted();
					await write(copy);
				})
				.catch((error: unknown) => {
					if (!hasWriteFailure) {
						hasWriteFailure = true;
						writeFailure = error;
						streamAbort.abort(error);
					}
				});
		};
		const handleChunk = (chunk: Buffer) => {
			if (hasWriteFailure || overflow || chunk.length === 0) return;
			windowTotal += chunk.length;
			if (windowTotal > wantBytes) {
				overflow = true;
				streamAbort.abort(new CodeHostJobFailure(failureCode, "the file grew while being read"));
				return;
			}
			read.update(chunk);
			pending.push(chunk);
			pendingBytes += chunk.length;
			while (pendingBytes >= chunkBytes) {
				const combined = pending.length === 1 ? (pending[0] as Buffer) : Buffer.concat(pending, pendingBytes);
				const piece = combined.subarray(0, chunkBytes);
				const rest = combined.subarray(chunkBytes);
				pending = rest.length > 0 ? [rest] : [];
				pendingBytes = rest.length;
				enqueue(piece);
			}
		};
		let result: CodeHostCommandResult | undefined;
		let runError: unknown;
		try {
			// WHY: LXD exec stdout callbacks have no pause/resume backpressure; windowing dd bounds
			// peak buffered orchestrator memory to windowBytes even when the upload sink stalls.
			result = await run.command(
				[
					"/usr/bin/dd",
					`if=${file}`,
					`bs=${chunkBytes}`,
					`skip=${chunkIndex}`,
					`count=${isFinalWindow ? wantChunks + 1 : wantChunks}`,
					"iflag=fullblock",
					"status=none",
				],
				{
					maximumOutputBytes: wantBytes + chunkBytes,
					signal: streamAbort.signal,
					onStdout: handleChunk,
				},
			);
		} catch (error) {
			runError = error;
		} finally {
			run.job.signal.removeEventListener("abort", onJobAbort);
		}
		await chain;
		if (hasWriteFailure) throw writeFailure;
		if (overflow) throw new CodeHostJobFailure(failureCode, "the file grew while being read");
		run.job.signal.throwIfAborted();
		if (runError !== undefined) throw runError;
		if (!result || result.status !== 0)
			throw new CodeHostJobFailure(failureCode, tail(result?.stderr ?? "") || "a piece was cut short");
		if (windowTotal === 0 && result.stdout.length > 0) {
			handleChunk(result.stdout);
			await chain;
			if (hasWriteFailure) throw writeFailure;
			if (overflow) throw new CodeHostJobFailure(failureCode, "the file grew while being read");
		}
		if (pendingBytes > 0) {
			const last = pending.length === 1 ? (pending[0] as Buffer) : Buffer.concat(pending, pendingBytes);
			await write(last);
			run.job.signal.throwIfAborted();
		}
		if (windowTotal !== wantBytes) throw new CodeHostJobFailure(failureCode, "a piece was cut short");
		total += windowTotal;
	}
	if (total !== expectedBytes) throw new CodeHostJobFailure(failureCode, "a piece was cut short");
	if (read.digest("hex") !== expectedSha256) throw new CodeHostJobFailure(failureCode, mismatchMessage);
}

/** The records of `ls-tree -l -z`, `<mode> <type> <object> <size>\t<path>\0`, with the path as raw bytes. Only this
 * form leaves the path unquoted: `--format` C-quotes `%(path)` even with -z. */
export function treeRecords(
	listing: Buffer,
): { mode: string; type: string; name: string; size: string; path: Buffer }[] {
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

export async function withJob<T>(job: CodeHostJob, repository: CloudCodingRepository, use: (run: Run) => Promise<T>) {
	const layout = checkLayout(job.layout);
	job.signal.throwIfAborted();
	const run = new Run(job, layout, repository, `${layout.scratchRoot}/${randomUUID()}`);
	const made = await run.command(["/usr/bin/mkdir", "-m", "0700", "--", run.directory], { cwd: layout.scratchRoot });
	if (made.status !== 0) throw new CodeHostJobFailure("CODE_HOST_SCRATCH_UNAVAILABLE", tail(made.stderr));
	try {
		return await use(run);
	} finally {
		await withTimeoutScope(undefined, 60_000, (cleanupSignal) =>
			run.command(["/usr/bin/rm", "-rf", "--", run.directory], {
				cwd: layout.scratchRoot,
				signal: cleanupSignal,
			}),
		).catch(() => {});
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
		const records = await run.checkNames(scratch, baseSha);
		// And the company folder's rule for each path where a session's worktree holds it (the longest place a commit of
		// the place is checked out at, so main/ takes it too): git takes a name such as `bad.` that the folder refuses, and
		// the folder would refuse the checkout's whole change set once main/ or the worktree was written. Before the
		// repack: nothing of the seed enters repo.git.
		const refused = codeFolderRefuses(run.area, records, CODE_FOLDER_ANY_SESSION);
		if (refused.length) throw new CodeHostRefusal("CODE_HOST_NAMES_FOLDER_REFUSES", refused);
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

export async function moveBase(
	run: Run,
	state: "present" | "partial" | "none",
	base: string,
	commit: string,
	old: string,
) {
	// The script makes its two pipes in the job's scratch. A job that moves a second time (nightly care's check: main/'s
	// HEAD, then its files) removes them first.
	if (run.moves > 0) {
		const cleared = await run.command([
			"/usr/bin/rm",
			"-f",
			"--",
			`${run.directory}/base.in`,
			`${run.directory}/base.out`,
		]);
		if (cleared.status !== 0) throw new CodeHostJobFailure("CODE_HOST_SEED_FAILED", tail(cleared.stderr));
	}
	run.moves += 1;
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
		const [base, headBytes, holds] = await Promise.all([
			run.ref(`refs/heads/${repository.baseBranch}`),
			area.main === "present" ? run.read(`${run.repo}/worktrees/main/HEAD`) : Promise.resolve(null),
			run.isCommit(run.repo, commit),
		]);
		const ready = area.main === "present" && base !== null && headBytes?.equals(Buffer.from(`${base}\n`)) === true;
		return { base, ready, holds, restored: run.restored };
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
 * (retain-workspace). A worktree whose files are gone while git's own folder for it is left (nightly care retired it,
 * or a removal stopped halfway) is added again from its branch: that folder holds nothing the missing files do not
 * make moot, so it is removed first and named in `restored`. Files without git's folder stay a refusal. A worktree
 * whose names the code host's rules or the company folder's refuse where it stands is not added (`CodeWorktreeNamesRefused`,
 * with the paths), and nothing is written for it. */
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
		const {
			tree: treeType,
			admin: adminType,
			locked: lockedType,
		} = area.worktree as {
			tree: PathType;
			admin: PathType;
			locked: PathType;
		};
		const head = await run.ref(`refs/heads/${branch}`);
		if (treeType === "directory" && adminType === "directory") {
			const [link, back] = await run.readMany([`${tree}/.git`, `${admin}/gitdir`]);
			if (!link?.equals(Buffer.from(`gitdir: ${admin}\n`)) || !back?.equals(Buffer.from(`${tree}/.git\n`)))
				throw new CodeHostRefusal("CODE_HOST_WORKTREE_CHANGED", [run.relative(tree)]);
			if (lockedType === "none") await run.keep(`${admin}/locked`, WORKTREE_LOCK);
			return { state: "present", headSha: head, restored: run.restored };
		}
		const adminLeft = treeType === "none" && adminType === "directory";
		if (!adminLeft && (treeType !== "none" || adminType !== "none"))
			throw new CodeHostRefusal("CODE_HOST_WORKTREE_INCOMPLETE", [
				...(treeType === "none" ? [] : [run.relative(tree)]),
				...(adminType === "none" ? [] : [run.relative(admin)]),
			]);
		if (!head && !(await run.isCommit(run.repo, baseSha)))
			throw new CodeHostRefusal("CODE_HOST_BASE_UNKNOWN", [baseSha]);
		// The names of what the worktree would hold, by the code host's rules and then the company folder's where this
		// worktree holds them, before anything is written: the folder would refuse the checkout's whole change set (or
		// the mount a name over 255 bytes) once it was written, the same at every follow-up. The refusal says whose names
		// they are: the session's branch, or the base a new worktree starts at.
		const of = head ? "branch" : "base";
		const records = await run.checkNames(run.repo, head ?? baseSha).catch((error: unknown) => {
			throw error instanceof CodeHostRefusal ? new CodeWorktreeNamesRefused(error.code, error.paths, of) : error;
		});
		const refused = codeFolderRefuses(run.area, records, `worktrees/${workerId}`);
		if (refused.length) throw new CodeWorktreeNamesRefused("CODE_HOST_NAMES_FOLDER_REFUSES", refused, of);
		if (adminLeft) {
			// With git's folder there, git would call the branch checked out and refuse the add.
			const removed = await run.command(["/usr/bin/rm", "-rf", "--", admin]);
			if (removed.status !== 0) throw new CodeHostJobFailure("CODE_HOST_WORKTREE_FAILED", tail(removed.stderr));
			run.restored.push(run.relative(admin));
		}
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
		const [hasBase, hasHead] = await run.areCommits(run.repo, [baseSha, headSha]);
		if (!hasBase) throw new CodeHostRefusal("CODE_HOST_BASE_UNKNOWN", [baseSha]);
		// The branch may have moved on since the session submitted; it must still hold what was submitted.
		if (!hasHead) throw new CodeHostRefusal("CODE_HOST_EXPORT_MOVED", [ref]);
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
export const PLATFORM_COMMITTER = ["-c", "user.name=Qorpera", "-c", "user.email=code@qorpera.com"] as const;

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
		const named = await run.refsNamed([CODE_AREA_IN_QORPERA_REF, base]);
		let kept = named(CODE_AREA_IN_QORPERA_REF);
		const head = named(base);
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

/** `closed`, with keys that may be left out. */
function closedWith<T extends string, O extends string>(
	value: unknown,
	keys: readonly T[],
	optional: readonly O[],
): Record<T, unknown> & Partial<Record<O, unknown>> {
	const given =
		value && typeof value === "object" && !Array.isArray(value) ? optional.filter((key) => key in value) : [];
	return closed(value, [...keys, ...given]) as Record<T, unknown> & Partial<Record<O, unknown>>;
}

/** One path that differs between two commits. A file whose kind changed (a file to a link) is `changed`. */
export interface CodeChangePath {
	path: string;
	change: "added" | "changed" | "removed";
}
/** What a movement of the default branch changed (own code storage, step 2b): how many paths differ between the two
 * commits, and the first of them in git's order, at most 50 and at most 8 KiB of path bytes together. `pathsMore`
 * counts the rest, so `filesChanged` is always `paths.length + pathsMore`. */
export interface CodeChangeDiff {
	filesChanged: number;
	paths: CodeChangePath[];
	pathsMore: number;
}
const MAX_DIFF_PATHS = 50;
const MAX_DIFF_PATH_BYTES = 8 * 1024;
const DIFF_CHANGES: ReadonlyMap<string, CodeChangePath["change"]> = new Map([
	["A", "added"],
	["M", "changed"],
	["T", "changed"],
	["D", "removed"],
]);

/** The paths that differ between two commits, by `git diff-tree -r -z --no-renames --name-status`: every file, link
 * and submodule entry counts once, a rename as one path removed and one added. A path that is not UTF-8 is shown with
 * the replacement character, and counts as the bytes it is shown with. */
async function changeDiff(run: Run, before: string, after: string, failure: string): Promise<CodeChangeDiff> {
	const out = await run.gitOk(
		run.repo,
		["diff-tree", "-r", "-z", "--no-renames", "--name-status", before, after],
		failure,
		{ maximumOutputBytes: MAX_LISTING },
	);
	const paths: CodeChangePath[] = [];
	let filesChanged = 0,
		bytes = 0,
		listing = true;
	// `<status>\0<path>\0` for each path.
	for (let start = 0; start < out.length; ) {
		const statusEnd = out.indexOf(0, start),
			pathEnd = statusEnd < 0 ? -1 : out.indexOf(0, statusEnd + 1),
			change = DIFF_CHANGES.get(out.subarray(start, Math.max(statusEnd, start)).toString("latin1"));
		if (pathEnd < 0 || !change) throw new CodeHostJobFailure(failure, "diff-tree's lines are not git's");
		const raw = out.subarray(statusEnd + 1, pathEnd);
		start = pathEnd + 1;
		filesChanged += 1;
		if (!listing) continue;
		// The first path that does not fit ends the list, so what is named is always the first of them. No path is
		// decoded that could not fit.
		const path = paths.length < MAX_DIFF_PATHS && raw.length <= MAX_DIFF_PATH_BYTES ? raw.toString("utf8") : null,
			size = path === null ? 0 : Buffer.byteLength(path);
		if (path !== null && bytes + size <= MAX_DIFF_PATH_BYTES) {
			bytes += size;
			paths.push({ path, change });
		} else listing = false;
	}
	return { filesChanged, paths, pathsMore: filesChanged - paths.length };
}

/** What the landing found at the path a session gave as its picture (`coding_finish.picture`), in the commit that
 * became the default branch. `ok` names the file version by its git id: exactly those bytes are the picture. */
export type CodePictureChecked =
	| { state: "ok"; blob: string; bytes: number; type: "png" | "jpeg" | "webp" }
	| { state: "missing" | "not_a_file" | "too_large" | "not_a_picture" };
/** A change's picture is at most 4 MiB. */
const MAX_PICTURE = 4 * MiB;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The session's picture, checked in git and never in the folder, so the session cannot swap the file afterwards: the
 * path must name a regular file of the commit (`records` is its tree, as `checkNames` read it) of at most 4 MiB whose
 * first bytes are a PNG's, a JPEG's or a WebP's. The four checks are made in that order, and the first that fails is
 * the answer. A string that can be no path in a repository names nothing: it is `missing`. */
async function checkPictureEntry(
	run: Run,
	entry: ReturnType<typeof treeRecords>[number] | undefined,
): Promise<CodePictureChecked> {
	if (!entry) return { state: "missing" };
	if (entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755")) return { state: "not_a_file" };
	const bytes = Number(entry.size);
	if (!SHA.test(entry.name) || !Number.isSafeInteger(bytes)) throw new CodeHostJobFailure("CODE_HOST_TREE_UNREADABLE");
	if (bytes > MAX_PICTURE) return { state: "too_large" };
	const length = Math.min(bytes, 12);
	const read = await run.sh(
		'n=$1; shift; "$@" | exec /usr/bin/head -c "$n"',
		[String(length), run.layout.git, "--no-replace-objects", `--git-dir=${run.repo}`, "cat-file", "blob", entry.name],
		{ maximumOutputBytes: length },
	);
	if (read.status !== 0 || read.stdout.length !== length)
		throw new CodeHostJobFailure("CODE_HOST_FILE_UNREADABLE", tail(read.stderr));
	const head = read.stdout;
	const type = head.subarray(0, 8).equals(PNG)
		? ("png" as const)
		: head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff
			? ("jpeg" as const)
			: head.length === 12 && head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WEBP"
				? ("webp" as const)
				: null;
	return type ? { state: "ok", blob: entry.name, bytes, type } : { state: "not_a_picture" };
}

async function checkPictureAtCommit(run: Run, commit: string, path: string): Promise<CodePictureChecked> {
	if (!path || path.length > 4096 || /[\0\n\r]/.test(path)) return { state: "missing" };
	if (path.split("/").some((part) => !part || part === "." || part === "..")) return { state: "missing" };
	const entry = await commitTreeEntry(run, commit, path);
	return checkPictureEntry(run, entry);
}

function checksEntryKey(entry: ReturnType<typeof treeRecords>[number] | undefined): string {
	if (!entry) return "missing";
	return `${entry.mode}:${entry.type}:${entry.name}`;
}

/** The commit of the default branch that first held `head`, which `main` reaches: `main` itself when it is `head`;
 * `head` when the branch stood at it once (it is on main's line of first parents); otherwise the oldest commit on that
 * line that reaches it, which is the merge that brought it in. Read from the commits between the two with their
 * parents (`rev-list --ancestry-path --parents`), since `--first-parent --ancestry-path` prints nothing for a head that
 * lies more than one step behind a merge's second parent. */
async function firstHeldAt(run: Run, head: string, main: string): Promise<string> {
	if (head === main) return main;
	const out = await run.gitOk(
		run.repo,
		["rev-list", "--ancestry-path", "--parents", `${head}..${main}`],
		"CODE_HOST_LAND_FAILED",
		{ maximumOutputBytes: MAX_LISTING },
	);
	// Each commit that both reaches `head` and is reached by `main`, with its first parent.
	const firstParent = new Map<string, string | undefined>();
	for (const line of out.toString("latin1").split("\n")) {
		const [commit, parent] = line.split(" ");
		if (commit) firstParent.set(commit, parent);
	}
	let at = main;
	for (;;) {
		const parent = firstParent.get(at);
		if (parent === head) return head;
		if (parent === undefined || !firstParent.has(parent)) return at;
		at = parent;
	}
}

/** The repository's checks file (own code storage, step 3): read from git at the commit that would become the default
 * branch and at the default branch, never from a worktree. */
export const CODE_CHECKS_FILE = ".qorpera/checks.json";
/** The checks file is read up to this size; a larger one comes back cut one byte after it. */
const CODE_CHECKS_READ_BYTES = 16 * 1024;

export interface CodeBranchLanding {
	repository: CloudCodingRepository;
	workerId: string;
	/** The commit the session submitted: its branch's head, or a commit the branch still reaches. */
	headSha: string;
	/** The picture the session gave with its hand-in: a file's path in the repository. Checked at the commit that
	 * becomes the default branch (`CodeBranchLanded.picture`); it never stops a landing. */
	picture?: string;
	/** Read .qorpera/checks.json at the commit that would become the default branch and at the default branch. When
	 * either has anything at that path, answer `to-check`, having moved nothing. */
	checks?: true;
	/** Land exactly this candidate, made by an earlier job's `to-check`. When the default branch is not at `mainBefore`
	 * any more, or the session's branch no longer holds `headSha`, or (merged) `mainAfter`'s parents are not
	 * `[mainBefore, headSha]`, refuse with CodeHostJobFailure CODE_HOST_LAND_STALE before any write. */
	expect?: { how: "fast-forward" | "merged"; mainBefore: string; mainAfter: string };
}
/** A landing that waits for its checks (own code storage, step 3): the commit that would become the default branch, and
 * the checks file at it and at the default branch. Nothing moved; for a merge, the merge commit is written. */
export interface CodeBranchToCheck {
	state: "to-check";
	how: "fast-forward" | "merged";
	/** The default branch now. */
	mainBefore: string;
	/** The candidate: headSha, or the merge commit this job wrote (no ref names it; it stays an object). */
	mainAfter: string;
	/** .qorpera/checks.json at mainAfter and at mainBefore, read with maxBytes 16 KiB. */
	checks: CodeCommitFile;
	mainChecks: CodeCommitFile;
	restored: string[];
}
export interface CodeBranchLanded {
	/** `fast-forward`: the default branch moved to the submitted commit. `merged`: to a merge of it with the default
	 * branch, which had moved on. `unchanged`: the default branch already held it. */
	state: "fast-forward" | "merged" | "unchanged";
	/** The default branch's commit after the landing. */
	mainSha: string;
	/** The default branch's commit before the landing; `mainSha` itself when unchanged. */
	mainBefore: string;
	/** Unchanged only: the commit of the default branch that first held the submitted commit (`firstHeldAt`). */
	containedAt: string | null;
	/** What the landing changed in the default branch's files; nothing when unchanged. */
	diff: CodeChangeDiff;
	/** The picture as it was found; null when none was given, or when unchanged. */
	picture: CodePictureChecked | null;
	restored: string[];
}

/** A session's submitted commit landed on the default branch of a repository kept in Qorpera, with main/ moved to it
 * in the same step as the branch (`moveBase`'s compare-and-swap: a landing racing another fails, and is asked again).
 * When the default branch moved on since the session's base, the two are merged by git's own merge (`merge-tree`, no
 * worktree); a conflict lands nothing and is refused naming its paths (`CODE_HOST_LAND_CONFLICT`), for the session to
 * merge itself. The landed tree passes the same name checks as a seed. For the change's record (step 2b) the answer
 * says where the default branch was before, what the landing changed in its files and what the session's picture
 * is; all of that is read before the branch moves, so the move is the landing's last step. The names checks are
 * `Run.checkNames`, then the company folder's rule for each path where a session's worktree will hold it, which also
 * holds where main/ will (`codeFolderRefuses`, `CODE_HOST_NAMES_FOLDER_REFUSES` naming the paths).
 *
 * A landing whose checks run between two jobs (own code storage, step 3): with `checks`, after the names of the
 * commit that would become the default branch passed, the checks file is read there and at the default branch, and
 * when either has anything at its path the job answers `to-check` without the picture, the diff or the move (a merge
 * commit is written all the same). With `expect`, the next job lands exactly that candidate, as a landing does, or is
 * refused as stale before any write; it merges nothing and reads no checks file. A commit the default branch already
 * holds is `unchanged` in every case. */
export function landCodeBranch(
	job: CodeHostJob,
	value: CodeBranchLanding & { checks?: undefined },
): Promise<CodeBranchLanded>;
export function landCodeBranch(
	job: CodeHostJob,
	value: CodeBranchLanding,
): Promise<CodeBranchLanded | CodeBranchToCheck>;
export async function landCodeBranch(
	job: CodeHostJob,
	value: CodeBranchLanding,
): Promise<CodeBranchLanded | CodeBranchToCheck> {
	const input = closedWith(value, ["repository", "workerId", "headSha"], ["picture", "checks", "expect"]);
	const repository = repositoryOf(input.repository),
		workerId = workerIdOf(input.workerId),
		headSha = sha(input.headSha),
		picture = input.picture,
		checks = input.checks === true;
	let expected: CodeBranchLanding["expect"];
	if (input.expect !== undefined) {
		const given = closed(input.expect, ["how", "mainBefore", "mainAfter"]);
		if (given.how !== "fast-forward" && given.how !== "merged") throw new Error("INVALID_CODE_HOST_JOB");
		expected = { how: given.how, mainBefore: sha(given.mainBefore), mainAfter: sha(given.mainAfter) };
	}
	if (
		repository.host !== "qorpera" ||
		(picture !== undefined && typeof picture !== "string") ||
		(input.checks !== undefined && !checks) ||
		(checks && expected)
	)
		throw new Error("INVALID_CODE_HOST_JOB");
	const ref = `refs/heads/qorpera/coding/${workerId}`,
		base = `refs/heads/${repository.baseBranch}`;
	const stale = (detail: string) => new CodeHostJobFailure("CODE_HOST_LAND_STALE", detail);
	return withJob(job, repository, async (run): Promise<CodeBranchLanded | CodeBranchToCheck> => {
		const area = await run.prepare();
		if (!area.seeded) throw new CodeHostRefusal("CODE_HOST_NOT_SEEDED", [run.area]);
		const named = await run.refsNamed([CODE_AREA_IN_QORPERA_REF, ref, base]);
		if (named(CODE_AREA_IN_QORPERA_REF) === null) throw new CodeHostRefusal("CODE_HOST_AREA_FROM_GITHUB", [run.area]);
		const ancestor = async (older: string, newer: string): Promise<boolean> => {
			const result = await run.git(run.repo, ["merge-base", "--is-ancestor", older, newer]);
			if (result.status !== 0 && result.status !== 1)
				throw new CodeHostJobFailure("CODE_HOST_LAND_FAILED", tail(result.stderr));
			return result.status === 0;
		};
		// The branch may have moved on since the session submitted; it must still hold what was submitted.
		const branch = named(ref);
		if (
			!branch ||
			(branch !== headSha && (!(await run.isCommit(run.repo, headSha)) || !(await ancestor(headSha, branch))))
		) {
			if (expected) throw stale("the session's branch no longer holds the commit");
			throw new CodeHostRefusal(branch ? "CODE_HOST_EXPORT_MOVED" : "CODE_HOST_EXPORT_NO_BRANCH", [ref]);
		}
		const current = named(base);
		if (!current) throw new CodeHostRefusal("CODE_HOST_AREA_NO_BASE", [base]);
		const [alreadyInMain, fastForward] =
			headSha === current
				? [true, true]
				: await Promise.all([ancestor(headSha, current), ancestor(current, headSha)]);
		if (alreadyInMain) {
			const [headBytes, containedAt] = await Promise.all([
				area.main === "present" ? run.read(`${run.repo}/worktrees/main/HEAD`) : Promise.resolve(null),
				firstHeldAt(run, headSha, current),
			]);
			const at = area.main === "present" && headBytes?.equals(Buffer.from(`${current}\n`)) === true;
			if (!at) await moveBase(run, area.main, base, current, current);
			return {
				state: "unchanged",
				mainSha: current,
				mainBefore: current,
				containedAt,
				diff: { filesChanged: 0, paths: [], pathsMore: 0 },
				picture: null,
				restored: run.restored,
			};
		}
		if (expected && current !== expected.mainBefore) throw stale("the default branch moved");
		const state = fastForward ? ("fast-forward" as const) : ("merged" as const);
		let next = headSha;
		if (expected) {
			// Exactly the candidate that was checked: the session's commit, or the merge of the two in that order.
			const same =
				expected.how === state &&
				(state === "fast-forward"
					? expected.mainAfter === headSha
					: (await run.isCommit(run.repo, expected.mainAfter)) &&
						(
							await run.gitOk(
								run.repo,
								["rev-list", "--max-count=1", "--parents", expected.mainAfter],
								"CODE_HOST_LAND_FAILED",
							)
						).toString("latin1") === `${expected.mainAfter} ${current} ${headSha}\n`);
			if (!same) throw stale("not the candidate that was checked");
			next = expected.mainAfter;
		} else if (state === "merged") {
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
		}
		let incrementalRecords: ReturnType<typeof treeRecords> = [];
		let checksFileTouched = false;
		if (!expected) {
			const checkedNames = await run.checkNamesIncremental(run.repo, current, next);
			incrementalRecords = checkedNames.records;
			checksFileTouched = checkedNames.checksFileTouched;
			const refused = codeFolderRefuses(run.area, incrementalRecords, CODE_FOLDER_ANY_SESSION);
			if (refused.length) throw new CodeHostRefusal("CODE_HOST_NAMES_FOLDER_REFUSES", refused);
		}
		if (checks) {
			const mainEntry = await commitTreeEntry(run, current, CODE_CHECKS_FILE);
			let found: CodeCommitFile;
			let mainFound: CodeCommitFile;
			if (!checksFileTouched) {
				found = await commitFileFromEntry(run, mainEntry, CODE_CHECKS_READ_BYTES);
				mainFound =
					found.entry.kind === "file"
						? { entry: { kind: "file" as const, bytes: new Uint8Array(found.entry.bytes) }, blob: found.blob }
						: found;
			} else {
				const wantedPath = Buffer.from(CODE_CHECKS_FILE, "utf8");
				const nextEntry = incrementalRecords.find((record) => record.path.equals(wantedPath));
				found = await commitFileFromEntry(run, nextEntry, CODE_CHECKS_READ_BYTES);
				mainFound =
					found.entry.kind === "file" &&
					mainEntry &&
					mainEntry.type === "blob" &&
					(mainEntry.mode === "100644" || mainEntry.mode === "100755") &&
					mainEntry.name === found.blob &&
					Number.isSafeInteger(Number(mainEntry.size))
						? { entry: { kind: "file" as const, bytes: new Uint8Array(found.entry.bytes) }, blob: found.blob }
						: await commitFileFromEntry(run, mainEntry, CODE_CHECKS_READ_BYTES);
			}
			if (found.entry.kind !== "missing" || mainFound.entry.kind !== "missing")
				return {
					state: "to-check",
					how: state,
					mainBefore: current,
					mainAfter: next,
					checks: found,
					mainChecks: mainFound,
					restored: run.restored,
				};
		}
		const [diff, checked] = await Promise.all([
			changeDiff(run, current, next, "CODE_HOST_LAND_FAILED"),
			picture === undefined ? Promise.resolve(null) : checkPictureAtCommit(run, next, picture),
		]);
		await moveBase(run, area.main, base, next, current);
		return {
			state,
			mainSha: next,
			mainBefore: current,
			containedAt: null,
			diff,
			picture: checked,
			restored: run.restored,
		};
	});
}

export const CODE_LAND_BATCH_MAX = 8;

export interface CodeBranchBatchCandidate {
	workerId: string;
	headSha: string;
}

export interface CodeBranchBatchPreparedStep {
	index: number;
	workerId: string;
	headSha: string;
	how: "fast-forward" | "merged";
	mainBefore: string;
	mainAfter: string;
}

export interface CodeBranchBatchRejected {
	index: number;
	workerId: string;
	headSha: string;
	error: CodeHostRefusal;
}

export interface CodeBranchBatchUnchanged {
	index: number;
	workerId: string;
	headSha: string;
	mainSha: string;
	containedAt: string;
}

export interface CodeBranchBatchPrepared {
	mainBefore: string;
	mainChecks: CodeCommitFile;
	tipChecks: CodeCommitFile;
	accepted: CodeBranchBatchPreparedStep[];
	rejected: CodeBranchBatchRejected[];
	unchanged: CodeBranchBatchUnchanged[];
	deferred: number[];
	restored: string[];
}

export async function landCodeBranchBatch(
	job: CodeHostJob,
	value: { repository: CloudCodingRepository; candidates: readonly CodeBranchBatchCandidate[] },
): Promise<CodeBranchBatchPrepared> {
	const input = closed(value, ["repository", "candidates"]);
	const repository = keptRepositoryOf(input.repository);
	const raw = input.candidates;
	if (!Array.isArray(raw) || raw.length < 1 || raw.length > CODE_LAND_BATCH_MAX)
		throw new Error("INVALID_CODE_HOST_JOB");
	const candidates = raw.map((entry: unknown) => {
		const item = closed(entry, ["workerId", "headSha"]);
		return { workerId: workerIdOf(item.workerId), headSha: sha(item.headSha) };
	});
	if (new Set(candidates.map((candidate) => candidate.workerId)).size !== candidates.length)
		throw new Error("INVALID_CODE_HOST_JOB");
	const base = `refs/heads/${repository.baseBranch}`;
	return withJob(job, repository, async (run): Promise<CodeBranchBatchPrepared> => {
		const area = await run.prepare();
		if (!area.seeded) throw new CodeHostRefusal("CODE_HOST_NOT_SEEDED", [run.area]);
		const branchRefs = candidates.map((candidate) => `refs/heads/qorpera/coding/${candidate.workerId}`);
		const named = await run.refsNamed([CODE_AREA_IN_QORPERA_REF, base, ...branchRefs]);
		if (named(CODE_AREA_IN_QORPERA_REF) === null) throw new CodeHostRefusal("CODE_HOST_AREA_FROM_GITHUB", [run.area]);
		const mainStart = named(base);
		if (!mainStart) throw new CodeHostRefusal("CODE_HOST_AREA_NO_BASE", [base]);
		const ancestor = async (older: string, newer: string): Promise<boolean> => {
			if (older === newer) return true;
			const result = await run.git(run.repo, ["merge-base", "--is-ancestor", older, newer]);
			if (result.status !== 0 && result.status !== 1)
				throw new CodeHostJobFailure("CODE_HOST_LAND_FAILED", tail(result.stderr));
			return result.status === 0;
		};
		const mainChecksEntry = await commitTreeEntry(run, mainStart, CODE_CHECKS_FILE);
		const mainChecks = await commitFileFromEntry(run, mainChecksEntry, CODE_CHECKS_READ_BYTES);
		const mainChecksKey = checksEntryKey(mainChecksEntry);
		let tipChecks: CodeCommitFile =
			mainChecks.entry.kind === "file"
				? { entry: { kind: "file", bytes: new Uint8Array(mainChecks.entry.bytes) }, blob: mainChecks.blob }
				: mainChecks;
		const accepted: CodeBranchBatchPreparedStep[] = [];
		const rejected: CodeBranchBatchRejected[] = [];
		const unchanged: CodeBranchBatchUnchanged[] = [];
		const deferred: number[] = [];
		let tip = mainStart;
		for (let i = 0; i < candidates.length; i += 1) {
			const { workerId, headSha } = candidates[i] as { workerId: string; headSha: string };
			const ref = branchRefs[i] as string;
			const branch = named(ref);
			if (
				!branch ||
				(branch !== headSha && (!(await run.isCommit(run.repo, headSha)) || !(await ancestor(headSha, branch))))
			) {
				rejected.push({
					index: i,
					workerId,
					headSha,
					error: new CodeHostRefusal(branch ? "CODE_HOST_EXPORT_MOVED" : "CODE_HOST_EXPORT_NO_BRANCH", [ref]),
				});
				continue;
			}
			const [alreadyInTip, fastForward] =
				headSha === tip ? [true, true] : await Promise.all([ancestor(headSha, tip), ancestor(tip, headSha)]);
			if (alreadyInTip) {
				if (tip === mainStart) {
					const containedAt = await firstHeldAt(run, headSha, mainStart);
					unchanged.push({ index: i, workerId, headSha, mainSha: mainStart, containedAt });
				} else {
					deferred.push(i);
				}
				continue;
			}
			const how = fastForward ? ("fast-forward" as const) : ("merged" as const);
			let next = headSha;
			if (how === "merged") {
				const merged = await run.git(run.repo, [
					"merge-tree",
					"--write-tree",
					"-z",
					"--name-only",
					"--no-messages",
					tip,
					headSha,
				]);
				const fields = merged.stdout.toString("utf8").split("\0");
				if (merged.status === 1) {
					if (tip !== mainStart) {
						deferred.push(i);
						continue;
					}
					const paths = [...new Set(fields.slice(1).filter(Boolean))];
					rejected.push({
						index: i,
						workerId,
						headSha,
						error: new CodeHostRefusal("CODE_HOST_LAND_CONFLICT", paths),
					});
					continue;
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
							tip,
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
			}
			let checkedNames: { records: ReturnType<typeof treeRecords>; checksFileTouched: boolean };
			try {
				checkedNames = await run.checkNamesIncremental(run.repo, tip, next);
				const refused = codeFolderRefuses(run.area, checkedNames.records, CODE_FOLDER_ANY_SESSION);
				if (refused.length) throw new CodeHostRefusal("CODE_HOST_NAMES_FOLDER_REFUSES", refused);
			} catch (error) {
				if (error instanceof CodeHostRefusal) {
					if (tip !== mainStart) {
						deferred.push(i);
						continue;
					}
					rejected.push({ index: i, workerId, headSha, error });
					continue;
				}
				throw error;
			}
			if (checkedNames.checksFileTouched) {
				const wantedPath = Buffer.from(CODE_CHECKS_FILE, "utf8");
				const nextChecksEntry = checkedNames.records.find((record) => record.path.equals(wantedPath));
				if (checksEntryKey(nextChecksEntry) !== mainChecksKey) {
					if (accepted.length > 0) {
						for (let rest = i; rest < candidates.length; rest += 1) deferred.push(rest);
						break;
					}
					tipChecks = await commitFileFromEntry(run, nextChecksEntry, CODE_CHECKS_READ_BYTES);
					accepted.push({ index: i, workerId, headSha, how, mainBefore: tip, mainAfter: next });
					tip = next;
					for (let rest = i + 1; rest < candidates.length; rest += 1) deferred.push(rest);
					break;
				}
			}
			accepted.push({ index: i, workerId, headSha, how, mainBefore: tip, mainAfter: next });
			tip = next;
		}
		if (accepted.length === 0 && unchanged.length > 0) {
			const headBytes = area.main === "present" ? await run.read(`${run.repo}/worktrees/main/HEAD`) : null;
			const at = area.main === "present" && headBytes?.equals(Buffer.from(`${mainStart}\n`)) === true;
			if (!at) await moveBase(run, area.main, base, mainStart, mainStart);
		}
		return {
			mainBefore: mainStart,
			mainChecks,
			tipChecks,
			accepted,
			rejected,
			unchanged,
			deferred,
			restored: run.restored,
		};
	});
}

export interface CodeBranchBatchCommitStep {
	workerId: string;
	headSha: string;
	how: "fast-forward" | "merged";
	mainBefore: string;
	mainAfter: string;
	picture?: string;
}

export interface CodeBranchBatchCommittedStep {
	workerId: string;
	headSha: string;
	state: "fast-forward" | "merged";
	mainBefore: string;
	mainSha: string;
	diff: CodeChangeDiff;
	picture: CodePictureChecked | null;
}

export interface CodeBranchBatchCommitted {
	mainBefore: string;
	mainSha: string;
	steps: CodeBranchBatchCommittedStep[];
	restored: string[];
}

export async function commitCodeBranchBatch(
	job: CodeHostJob,
	value: { repository: CloudCodingRepository; steps: readonly CodeBranchBatchCommitStep[] },
): Promise<CodeBranchBatchCommitted> {
	const input = closed(value, ["repository", "steps"]);
	const repository = keptRepositoryOf(input.repository);
	const raw = input.steps;
	if (!Array.isArray(raw) || raw.length < 1 || raw.length > CODE_LAND_BATCH_MAX)
		throw new Error("INVALID_CODE_HOST_JOB");
	const steps = raw.map((entry: unknown) => {
		const item = closedWith(entry, ["workerId", "headSha", "how", "mainBefore", "mainAfter"], ["picture"]);
		if (item.how !== "fast-forward" && item.how !== "merged") throw new Error("INVALID_CODE_HOST_JOB");
		if (item.picture !== undefined && typeof item.picture !== "string") throw new Error("INVALID_CODE_HOST_JOB");
		return {
			workerId: workerIdOf(item.workerId),
			headSha: sha(item.headSha),
			how: item.how as "fast-forward" | "merged",
			mainBefore: sha(item.mainBefore),
			mainAfter: sha(item.mainAfter),
			picture: item.picture as string | undefined,
		};
	});
	if (new Set(steps.map((step) => step.workerId)).size !== steps.length) throw new Error("INVALID_CODE_HOST_JOB");
	for (let i = 1; i < steps.length; i += 1) {
		if (steps[i]?.mainBefore !== steps[i - 1]?.mainAfter) throw new Error("INVALID_CODE_HOST_JOB");
	}
	const base = `refs/heads/${repository.baseBranch}`;
	const stale = (detail: string) => new CodeHostJobFailure("CODE_HOST_LAND_STALE", detail);
	return withJob(job, repository, async (run): Promise<CodeBranchBatchCommitted> => {
		const area = await run.prepare();
		if (!area.seeded) throw new CodeHostRefusal("CODE_HOST_NOT_SEEDED", [run.area]);
		const branchRefs = steps.map((step) => `refs/heads/qorpera/coding/${step.workerId}`);
		const named = await run.refsNamed([CODE_AREA_IN_QORPERA_REF, base, ...branchRefs]);
		if (named(CODE_AREA_IN_QORPERA_REF) === null) throw new CodeHostRefusal("CODE_HOST_AREA_FROM_GITHUB", [run.area]);
		const current = named(base);
		if (!current) throw new CodeHostRefusal("CODE_HOST_AREA_NO_BASE", [base]);
		const mainBefore = (steps[0] as (typeof steps)[number]).mainBefore;
		if (current !== mainBefore) throw stale("the default branch moved");
		const ancestor = async (older: string, newer: string): Promise<boolean> => {
			if (older === newer) return true;
			const result = await run.git(run.repo, ["merge-base", "--is-ancestor", older, newer]);
			if (result.status !== 0 && result.status !== 1)
				throw new CodeHostJobFailure("CODE_HOST_LAND_FAILED", tail(result.stderr));
			return result.status === 0;
		};
		for (let i = 0; i < steps.length; i += 1) {
			const step = steps[i] as (typeof steps)[number];
			const branch = named(branchRefs[i] as string);
			if (
				!branch ||
				(branch !== step.headSha &&
					(!(await run.isCommit(run.repo, step.headSha)) || !(await ancestor(step.headSha, branch))))
			)
				throw stale("the session's branch no longer holds the commit");
			if (step.how === "fast-forward") {
				if (step.mainAfter !== step.headSha || !(await ancestor(step.mainBefore, step.headSha)))
					throw stale("not the candidate that was checked");
			}
		}
		const mergedSteps = steps.filter((step) => step.how === "merged");
		if (mergedSteps.length > 0) {
			const mergedIds = mergedSteps.map((step) => step.mainAfter);
			const exists = await run.areCommits(run.repo, mergedIds);
			if (exists.some((ok) => !ok)) throw stale("not the candidate that was checked");
			const parentsOut = (
				await run.gitOk(run.repo, ["rev-list", "--no-walk", "--parents", ...mergedIds], "CODE_HOST_LAND_FAILED")
			).toString("latin1");
			const parentsByCommit = new Map<string, string>();
			for (const line of parentsOut.split("\n")) {
				if (!line) continue;
				const space = line.indexOf(" ");
				if (space > 0) parentsByCommit.set(line.slice(0, space), line);
			}
			for (const step of mergedSteps) {
				if (parentsByCommit.get(step.mainAfter) !== `${step.mainAfter} ${step.mainBefore} ${step.headSha}`)
					throw stale("not the candidate that was checked");
			}
		}
		const committedSteps: CodeBranchBatchCommittedStep[] = [];
		for (const step of steps) {
			const [diff, checked] = await Promise.all([
				changeDiff(run, step.mainBefore, step.mainAfter, "CODE_HOST_LAND_FAILED"),
				step.picture === undefined
					? Promise.resolve(null)
					: checkPictureAtCommit(run, step.mainAfter, step.picture),
			]);
			committedSteps.push({
				workerId: step.workerId,
				headSha: step.headSha,
				state: step.how,
				mainBefore: step.mainBefore,
				mainSha: step.mainAfter,
				diff,
				picture: checked,
			});
		}
		const tipSha = (steps[steps.length - 1] as (typeof steps)[number]).mainAfter;
		await moveBase(run, area.main, base, tipSha, mainBefore);
		return {
			mainBefore,
			mainSha: tipSha,
			steps: committedSteps,
			restored: run.restored,
		};
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
	packRefs?: boolean;
	packArchivedRefs?: boolean;
	prune?: boolean;
}
export type CodeGarbageCollected =
	| { state: "collected"; restored: string[] }
	/** Another code host's view holds the block. */
	| { state: "busy" }
	/** Leases were still held when the wait ran out; the block was ended. */
	| { state: "held"; held: number };

/** gc with the lease block: new leases in repo.git wait while it runs (worktrees and everything outside repo.git do
 * not), and it starts once none is held. Worker branches stay loose; with `packRefs` false every ref does, and with
 * `prune` false no object is dropped. */
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
		now = options.now ?? Date.now,
		packRefs = options.packRefs ?? true,
		packArchivedRefs = options.packArchivedRefs ?? false,
		prune = options.prune ?? true;
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
			if ((await run.types([`${run.repo}/shallow`]))[0] !== "none")
				throw new CodeHostRefusal("CODE_HOST_GC_SHALLOW", [`${run.area}/repo.git/shallow`]);
			if (packRefs)
				await run.gitOk(
					run.repo,
					["pack-refs", "--all", "--exclude", "refs/heads/qorpera/coding/*"],
					"CODE_HOST_GC_FAILED",
				);
			if (packArchivedRefs) {
				const scan = await run.sh(
					'if [ -d "$1" ]; then for d in "$1"/*; do [ -d "$d" ] || continue; printf "W %s\\n" "$(basename -- "$d")"; done; fi; if [ -d "$2" ]; then for f in "$2"/*; do [ -f "$f" ] || continue; printf "C %s\\n" "$(basename -- "$f")"; done; fi; if [ -d "$3" ]; then for f in "$3"/*; do [ -f "$f" ] || continue; printf "S\\n"; break; done; fi',
					[`${run.repo}/worktrees`, `${run.repo}/refs/heads/qorpera/coding`, `${run.repo}/refs/qorpera/sites`],
				);
				if (scan.status !== 0) throw new CodeHostJobFailure("CODE_HOST_GC_FAILED", tail(scan.stderr));
				const active = new Set<string>();
				const codingLoose: string[] = [];
				let hasSitePins = false;
				for (const line of scan.stdout.toString("utf8").split("\n")) {
					if (line.startsWith("W ")) active.add(line.slice(2));
					else if (line.startsWith("C ")) codingLoose.push(line.slice(2));
					else if (line === "S") hasSitePins = true;
				}
				const includes = [
					...codingLoose.filter((id) => !active.has(id)).map((id) => `refs/heads/qorpera/coding/${id}`),
					...(hasSitePins ? ["refs/qorpera/sites/*"] : []),
				];
				for (let at = 0; at < includes.length; at += 25) {
					const part = includes.slice(at, at + 25);
					await run.gitOk(
						run.repo,
						["pack-refs", ...part.flatMap((pattern) => ["--include", pattern])],
						"CODE_HOST_GC_FAILED",
					);
				}
			}
			if (prune) {
				await run.gitOk(
					run.repo,
					[
						"repack",
						"--cruft",
						"--cruft-expiration=14.days.ago",
						"-d",
						"--write-midx",
						"--write-bitmap-index",
						"-q",
					],
					"CODE_HOST_GC_FAILED",
				);
				await run.gitOk(run.repo, ["prune", "--expire=14.days.ago"], "CODE_HOST_GC_FAILED");
			} else {
				await run.gitOk(
					run.repo,
					["repack", "--geometric=2", "-d", "--write-midx", "--write-bitmap-index", "-q"],
					"CODE_HOST_GC_FAILED",
				);
			}
			await run.gitOk(
				run.repo,
				["commit-graph", "write", "--reachable", "--changed-paths", "--split", "--expire-time=1.day.ago"],
				"CODE_HOST_GC_FAILED",
			);
			return { state: "collected", restored: run.restored };
		};
		const end = () => withTimeoutScope(undefined, 30_000, (endSignal) => block.end(run.area, endSignal));
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

// Nightly care of a repository kept in Qorpera (own code storage, step 2): a check that repairs main/, an fsck, a bundle
// that leaves the code host, `collectCodeGarbage` with `packRefs` and `prune` off, and the retiring of archived
// sessions' worktrees. Each is a job of its own, and none of them makes a repository or touches a ref.

/** One ref: `refs/heads/main`, a session's branch, the mark. */
export interface CodeAreaRef {
	name: string;
	sha: string;
}

/** The refs' fingerprint: sha256 (hex) of the refs as lines `<sha> <name>\n`, sorted by name (by its bytes, as git
 * lists them), in UTF-8. */
export function codeRefsSha256(refs: readonly CodeAreaRef[]): string {
	if (!Array.isArray(refs)) throw new Error("INVALID_CODE_HOST_JOB");
	const lines = refs.map((ref: CodeAreaRef) => {
		if (typeof ref?.name !== "string" || !ref.name || /[\0\n]/.test(ref.name) || !SHA.test(ref.sha))
			throw new Error("INVALID_CODE_HOST_JOB");
		return { name: Buffer.from(ref.name, "utf8"), line: `${ref.sha} ${ref.name}\n` };
	});
	lines.sort((a, b) => Buffer.compare(a.name, b.name));
	const hash = createHash("sha256");
	for (const { line } of lines) hash.update(line, "utf8");
	return hash.digest("hex");
}

/** Every ref of a repository kept in Qorpera, and its default branch's commit. The mark and the default branch are
 * read as `Run.ref` reads them: never symbolic, always a commit. A seeded area without the mark is a copy of a GitHub
 * repository, and one without its default branch a start that stopped before it: both are refused. */
export async function keptRefs(run: Run): Promise<{ refs: CodeAreaRef[]; mainSha: string }> {
	const base = `refs/heads/${run.repository.baseBranch}`,
		listed = await run.refs(run.repo);
	const commit = (ref: string): string | null => {
		const found = listed.find((entry) => entry.name === ref);
		if (!found) return null;
		if (found.symref) throw new CodeHostRefusal("CODE_HOST_REF_IS_SYMBOLIC", [ref]);
		if (found.type !== "commit") throw new CodeHostRefusal("CODE_HOST_REF_NOT_A_COMMIT", [ref]);
		return found.sha;
	};
	if (commit(CODE_AREA_IN_QORPERA_REF) === null) throw new CodeHostRefusal("CODE_HOST_AREA_FROM_GITHUB", [run.area]);
	const mainSha = commit(base);
	if (mainSha === null) throw new CodeHostRefusal("CODE_HOST_AREA_NO_BASE", [base]);
	return { refs: listed.map(({ name, sha: objectName }) => ({ name, sha: objectName })), mainSha };
}

/** A care job's repository: one kept in Qorpera, as a landing's. */
export function keptRepositoryOf(value: unknown): CloudCodingRepository {
	const repository = repositoryOf(value);
	if (repository.host !== "qorpera") throw new Error("INVALID_CODE_HOST_JOB");
	return repository;
}

export type CodeAreaChecked =
	/** Nothing is seeded at the repository's place: its first session has not started it yet. */
	| { state: "absent" }
	| {
			state: "present";
			/** The default branch's commit. */
			mainSha: string;
			refs: CodeAreaRef[];
			refsSha256: string;
			/** `repo.git/shallow` exists: history may be cut, and gc refuses. */
			shallow: boolean;
			/** The session ids that have a worktree folder under worktrees/. */
			worktrees: string[];
			/** `git count-objects -v`: loose objects, packs, and what both take on disk. */
			objects: { loose: number; packs: number; sizeKiB: number };
			/** What the check repaired: main/'s HEAD, or main/'s files (removed and added again). */
			repaired: "none" | "head" | "files";
			restored: string[];
	  };

/** Whether main/ holds exactly the commit's files: every path of its tree and no other (but a submodule's empty
 * folder), each of its kind (a file, a link, a folder) and, for a file or a link, of its size. No file's content is
 * read for that. Sizes alone also differ where the repository's own attributes convert a file at checkout (its line
 * endings), so a difference in sizes only is settled by git's status, which compares content; `deep` asks it always. */
async function mainHolds(run: Run, commit: string, deep: boolean): Promise<boolean> {
	const listing = await run.gitOk(
		run.repo,
		["ls-tree", "-r", "-l", "-z", "--full-tree", commit],
		"CODE_HOST_TREE_UNREADABLE",
		{ maximumOutputBytes: MAX_LISTING },
	);
	// Paths as their bytes, one character each: names are compared, never shown.
	const wanted = new Map<string, string>(),
		submodules = new Set<string>();
	for (const { mode, type, size, path } of treeRecords(listing)) {
		const name = path.toString("latin1");
		// A submodule's commit is never checked out: its place is an empty folder, or none, as git itself takes it, and
		// so are the folders that lead to nothing else.
		if (type === "commit") submodules.add(name);
		else wanted.set(name, `${mode === "120000" ? "l" : "f"} ${size}`);
		for (let slash = name.indexOf("/"); slash >= 0; slash = name.indexOf("/", slash + 1))
			if (type === "commit") submodules.add(name.slice(0, slash));
			else wanted.set(name.slice(0, slash), "d");
	}
	const found = await run.command(["/usr/bin/find", run.main, "-mindepth", "1", "-printf", "%y\\0%s\\0%P\\0"], {
		maximumOutputBytes: MAX_LISTING,
	});
	if (found.status !== 0) throw new CodeHostJobFailure("CODE_HOST_INSPECT_FAILED", tail(found.stderr));
	const fields = found.stdout.toString("latin1").split("\0");
	if (fields.pop() !== "" || fields.length % 3 !== 0) throw new CodeHostJobFailure("CODE_HOST_INSPECT_FAILED");
	let seen = 0,
		sizes = false;
	for (let index = 0; index < fields.length; index += 3) {
		const kind = fields[index],
			name = fields[index + 2];
		// main/'s own link to git's folder for it, which `prepare` keeps.
		if (name === ".git" && kind === "f") continue;
		const want = wanted.get(name);
		if (want === undefined) {
			if (kind === "d" && submodules.has(name)) continue;
			return false;
		}
		seen += 1;
		if (want === "d" || kind === "d") {
			if (want !== kind) return false;
		} else if (!want.startsWith(`${kind} `)) return false;
		else if (want !== `${kind} ${fields[index + 1]}`) sizes = true;
	}
	if (seen !== wanted.size) return false;
	if (!sizes && !deep) return true;
	return await run.clean([
		`--git-dir=${run.repo}/worktrees/main`,
		`--work-tree=${run.main}`,
		"status",
		"--porcelain",
		"--untracked-files=no",
		"--ignore-submodules=all",
	]);
}

/** Nightly care's first job: what a repository kept in Qorpera holds, with main/ repaired when it is not at the
 * default branch. This is `startCodeArea`'s repair alone, without its power to make a repository: a place where
 * nothing is seeded answers `absent`, and nothing is written there. main/'s HEAD at another commit is moved by
 * `moveBase`'s checkout; a main/ that is missing or half there, or whose files are not the default branch's
 * (`mainHolds`), is removed and added again. `deep` also compares every file's content. */
export async function checkCodeArea(
	job: CodeHostJob,
	value: { repository: CloudCodingRepository },
	options: { deep?: boolean } = {},
): Promise<CodeAreaChecked> {
	const input = closed(value, ["repository"]);
	const repository = keptRepositoryOf(input.repository),
		deep = options.deep === true;
	const base = `refs/heads/${repository.baseBranch}`;
	return withJob(job, repository, async (run) => {
		const area = await run.prepare();
		if (!area.seeded) return { state: "absent" };
		const { refs, mainSha } = await keptRefs(run);
		let repaired: "none" | "head" | "files" = "none";
		if (area.main !== "present") {
			await moveBase(run, area.main, base, mainSha, mainSha);
			repaired = "files";
		} else {
			if (!(await run.read(`${run.repo}/worktrees/main/HEAD`))?.equals(Buffer.from(`${mainSha}\n`))) {
				await moveBase(run, "present", base, mainSha, mainSha);
				repaired = "head";
			}
			// A checkout leaves a file git does not know in its place, so the files are looked at after it too.
			if (!(await mainHolds(run, mainSha, deep))) {
				await moveBase(run, "partial", base, mainSha, mainSha);
				repaired = "files";
			}
		}
		const [listed, countedBytes, shallowTypes] = await Promise.all([
			run.sh(
				'[ -d "$1" ] || exit 0; exec find "$1" -mindepth 1 -maxdepth 1 -type d -printf "%f\\0"',
				[`${run.code}/worktrees`],
				{
					maximumOutputBytes: MAX_READ,
				},
			),
			run.gitOk(run.repo, ["count-objects", "-v"], "CODE_HOST_INSPECT_FAILED"),
			run.types([`${run.repo}/shallow`]),
		]);
		if (listed.status !== 0) throw new CodeHostJobFailure("CODE_HOST_INSPECT_FAILED", tail(listed.stderr));
		const counted = countedBytes.toString("utf8");
		const count = (key: string): number => {
			const number = Number(new RegExp(`^${key}: (\\d+)$`, "m").exec(counted)?.[1]);
			if (!Number.isSafeInteger(number)) throw new CodeHostJobFailure("CODE_HOST_INSPECT_FAILED", "count-objects");
			return number;
		};
		return {
			state: "present",
			mainSha,
			refs,
			refsSha256: codeRefsSha256(refs),
			shallow: shallowTypes[0] !== "none",
			worktrees: listed.stdout.toString("utf8").split("\0").filter(isUuid).sort(),
			objects: { loose: count("count"), packs: count("packs"), sizeKiB: count("size") + count("size-pack") },
			repaired,
			restored: run.restored,
		};
	});
}

/** fsck's own exit status in the first line, or `timeout` when it was stopped (TERM, and KILL 10 s later), then the
 * start of what it said. The status goes through a file, since `timeout`'s own could be fsck's: without the file,
 * `timeout` must say that it stopped the command (124, or 137 after the KILL), or the command never ran. */
const FSCK = `out=$1 status=$2 seconds=$3; shift 3
timeout -k 10 "$seconds" /bin/sh -c '"$@"; echo "$?" >"$0"' "$status" "$@" >"$out" 2>&1
stopped=$?
if [ -f "$status" ]; then cat -- "$status" || exit 1
elif [ "$stopped" -eq 124 ] || [ "$stopped" -eq 137 ]; then echo timeout
else cat -- "$out" >&2; exit 1; fi
exec head -c 61440 -- "$out"`;

/** Nightly care's second job: `git fsck --connectivity-only`, which finds a missing or unreadable commit, tree or
 * file version behind any ref, diary line or worktree, and reads no file's content (the bundle's proof does that, on
 * the code host's own disk). It is stopped after `maximumMs` (default 30 minutes). `detail` is the first 2,000
 * characters of what fsck said. */
export async function fsckCodeArea(
	job: CodeHostJob,
	value: { repository: CloudCodingRepository },
	options: { maximumMs?: number } = {},
): Promise<{ state: "ok" | "problems" | "timeout"; exitCode: number | null; detail: string }> {
	const input = closed(value, ["repository"]);
	const repository = keptRepositoryOf(input.repository),
		maximumMs = options.maximumMs ?? 1_800_000;
	if (!Number.isSafeInteger(maximumMs) || maximumMs < 1 || maximumMs > 86_400_000)
		throw new Error("INVALID_CODE_HOST_JOB");
	return withJob(job, repository, async (run) => {
		if (!(await run.prepare()).seeded) throw new CodeHostRefusal("CODE_HOST_NOT_SEEDED", [run.area]);
		if ((await run.ref(CODE_AREA_IN_QORPERA_REF)) === null)
			throw new CodeHostRefusal("CODE_HOST_AREA_FROM_GITHUB", [run.area]);
		const ran = await run.sh(FSCK, [
			`${run.directory}/fsck.out`,
			`${run.directory}/fsck.status`,
			String(maximumMs / 1000),
			run.layout.git,
			"--no-replace-objects",
			`--git-dir=${run.repo}`,
			"fsck",
			"--connectivity-only",
			"--no-dangling",
			"--no-progress",
		]);
		const end = ran.stdout.indexOf(0x0a),
			first = ran.stdout.subarray(0, Math.max(end, 0)).toString("latin1");
		if (ran.status !== 0 || !/^(timeout|\d{1,3})$/.test(first))
			throw new CodeHostJobFailure("CODE_HOST_FSCK_FAILED", tail(ran.stderr));
		const detail = ran.stdout
			.subarray(end + 1)
			.toString("utf8")
			.replaceAll("\0", "")
			.slice(0, 2000);
		if (first === "timeout") return { state: "timeout", exitCode: null, detail };
		const exitCode = Number(first);
		return { state: exitCode === 0 ? "ok" : "problems", exitCode, detail };
	});
}

/** Where a bundle's pieces go as they leave the code host, in order. */
export interface CodeBundleSink {
	write(chunk: Uint8Array): Promise<void>;
}

/** Nightly care's copy out: every ref of a repository kept in Qorpera in one bundle (`git bundle create --all`),
 * made in the scratch and proven to restore before a byte leaves: `bundle verify`, then a fetch of every ref into a
 * new scratch repository that borrows nothing, whose refs must be the code area's (the fetch reads and checks every
 * object, on the code host's own disk). The bundle's sha256 and size are taken in the code host, and it is read out
 * in pieces of `chunkBytes` (default 16 MiB), one exec each, handed to `sink` in order; what was handed over has that
 * sha256, or the job fails. Refuses (CodeHostRefusal) with CODE_HOST_BUNDLE_REFS_MOVED when the refs are not
 * `refsSha256` any more, and with CODE_HOST_BUNDLE_TOO_LARGE over `maximumBytes` (default 2 GiB). A session's
 * uncommitted files are in no bundle. */
export async function bundleCodeArea(
	job: CodeHostJob,
	value: { repository: CloudCodingRepository; refsSha256: string },
	sink: CodeBundleSink,
	options: { maximumBytes?: number; chunkBytes?: number } = {},
): Promise<{ sha256: string; bytes: number; gitVersion: string; refs: CodeAreaRef[]; refsSha256: string }> {
	const input = closed(value, ["repository", "refsSha256"]);
	const repository = keptRepositoryOf(input.repository),
		refsSha256 = input.refsSha256,
		maximumBytes = options.maximumBytes ?? 2 * GiB,
		chunkBytes = options.chunkBytes ?? 16 * MiB;
	if (
		typeof refsSha256 !== "string" ||
		!SHA256.test(refsSha256) ||
		typeof sink?.write !== "function" ||
		!Number.isSafeInteger(maximumBytes) ||
		maximumBytes < 1 ||
		!Number.isSafeInteger(chunkBytes) ||
		chunkBytes < 1 ||
		chunkBytes > MAX_PIECE
	)
		throw new Error("INVALID_CODE_HOST_JOB");
	return withJob(job, repository, async (run) => {
		if (!(await run.prepare()).seeded) throw new CodeHostRefusal("CODE_HOST_NOT_SEEDED", [run.area]);
		const { refs } = await keptRefs(run);
		if (codeRefsSha256(refs) !== refsSha256) throw new CodeHostRefusal("CODE_HOST_BUNDLE_REFS_MOVED", [run.area]);
		const file = `${run.directory}/all.bundle`,
			proof = `${run.directory}/proof.git`;
		await run.gitOk(run.repo, ["bundle", "create", "--quiet", file, "--all"], "CODE_HOST_BUNDLE_FAILED");
		const measured = await run.sh('sha256sum <"$1" && exec wc -c <"$1"', [file]),
			[, sha256, counted] = /^([0-9a-f]{64}) [ *]-\n *(\d+)\n$/.exec(measured.stdout.toString("latin1")) ?? [],
			bytes = Number(counted);
		if (measured.status !== 0 || !sha256 || !Number.isSafeInteger(bytes) || bytes < 1)
			throw new CodeHostJobFailure("CODE_HOST_BUNDLE_FAILED", tail(measured.stderr));
		if (bytes > maximumBytes) throw new CodeHostRefusal("CODE_HOST_BUNDLE_TOO_LARGE", [`${bytes} bytes`]);
		await run.gitOk(
			proof,
			["init", "--quiet", "--bare", "--template=", "--ref-format=files", proof],
			"CODE_HOST_BUNDLE_FAILED",
		);
		await run.gitOk(proof, ["bundle", "verify", "--quiet", file], "CODE_HOST_BUNDLE_FAILED");
		// The bundle also names each worktree's HEAD, outside refs/: a restore makes no worktree, so those stay behind.
		await run.gitOk(
			proof,
			["fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", file, "+refs/*:refs/*"],
			"CODE_HOST_BUNDLE_FAILED",
		);
		const restored = (await run.refs(proof)).map(({ name, sha: objectName }) => ({ name, sha: objectName }));
		if (codeRefsSha256(restored) !== refsSha256) {
			// A ref that moved while the bundle was made is no fault of the bundle's: the caller starts again.
			if (codeRefsSha256((await keptRefs(run)).refs) !== refsSha256)
				throw new CodeHostRefusal("CODE_HOST_BUNDLE_REFS_MOVED", [run.area]);
			throw new CodeHostJobFailure("CODE_HOST_BUNDLE_FAILED", "the bundle does not restore every ref");
		}
		const gitVersion = (await run.gitOk(run.repo, ["version"], "CODE_HOST_BUNDLE_FAILED"))
			.toString("utf8")
			.trim()
			.replace(/^git version /, "");
		if (!gitVersion || gitVersion.length > 100)
			throw new CodeHostJobFailure("CODE_HOST_BUNDLE_FAILED", "git version");
		await streamFileOut(
			run,
			file,
			bytes,
			sha256,
			chunkBytes,
			(piece) => sink.write(piece),
			"CODE_HOST_BUNDLE_FAILED",
			"the bundle read out is not the one made",
		);
		return { sha256, bytes, gitVersion, refs, refsSha256 };
	});
}

/** What git keeps in its folder for a worktree while a merge, a pick, a revert, a bisect or a rebase is under way. */
const WORKTREE_IN_PROGRESS = [
	"MERGE_HEAD",
	"CHERRY_PICK_HEAD",
	"REVERT_HEAD",
	"BISECT_LOG",
	"rebase-merge",
	"rebase-apply",
	"sequencer",
] as const;

/** Retire's first job for one session: its worktree's files are removed only when the folder's copy is exactly its
 * branch's head, so the branch gives every file back. Answers why the worktree stays, or null when its files went. */
async function retireFiles(run: Run, workerId: string): Promise<string | null> {
	const tree = `${run.code}/worktrees/${workerId}`,
		admin = `${run.repo}/worktrees/${workerId}`,
		ref = `refs/heads/qorpera/coding/${workerId}`;
	const [treeType, adminType, linkType, backType, commonType, headType, refsType, ...progress] = await run.types([
		tree,
		admin,
		`${tree}/.git`,
		`${admin}/gitdir`,
		`${admin}/commondir`,
		`${admin}/HEAD`,
		`${admin}/refs`,
		...WORKTREE_IN_PROGRESS.map((name) => `${admin}/${name}`),
	]);
	if (treeType !== "directory" || adminType !== "directory") return "NOT_THERE";
	// The two link files as `addCodeWorktree` reads them, and commondir, which says whose objects, refs and config git
	// takes for this worktree: every git command below runs on this folder.
	if (linkType !== "file" || backType !== "file" || commonType !== "file") return "LINKS_DIFFER";
	const [linkBytes, backBytes, commonBytes, headBytes] = await run.readMany(
		headType === "file"
			? [`${tree}/.git`, `${admin}/gitdir`, `${admin}/commondir`, `${admin}/HEAD`]
			: [`${tree}/.git`, `${admin}/gitdir`, `${admin}/commondir`],
	);
	if (
		!linkBytes?.equals(Buffer.from(`gitdir: ${admin}\n`)) ||
		!backBytes?.equals(Buffer.from(`${tree}/.git\n`)) ||
		!commonBytes?.equals(Buffer.from("../..\n"))
	)
		return "LINKS_DIFFER";
	if (headType !== "file" || !headBytes?.equals(Buffer.from(`ref: ${ref}\n`))) return "HEAD_NOT_ITS_BRANCH";
	const head = await run.ref(ref).catch((error: unknown) => {
		if (error instanceof CodeHostRefusal) return null;
		throw error;
	});
	if (!head) return "NO_BRANCH";
	if (progress.some((type) => type !== "none")) return "IN_PROGRESS";
	// git makes an empty refs/ in its folder for every worktree. A ref in it is the worktree's own (a bisect's, a
	// rebase's), and no branch keeps what it names.
	if (refsType !== "none") {
		if (refsType !== "directory") return "IN_PROGRESS";
		const own = await run.command([
			"/usr/bin/find",
			`${admin}/refs`,
			"-mindepth",
			"1",
			"!",
			"-type",
			"d",
			"-print",
			"-quit",
		]);
		if (own.status !== 0) throw new CodeHostJobFailure("CODE_HOST_INSPECT_FAILED", tail(own.stderr));
		if (own.stdout.length) return "IN_PROGRESS";
	}
	// The names first: a head `addCodeWorktree` would refuse could never be given back. Its rules: the code host's, then
	// the company folder's where this worktree holds them.
	const records = await run.checkNames(run.repo, head).catch((error: unknown) => {
		if (error instanceof CodeHostRefusal) return null;
		throw error;
	});
	if (!records || codeFolderRefuses(run.area, records, `worktrees/${workerId}`).length) return "NAMES_REFUSED";
	// And no repository inside this one, in the head or in the folder, before git's status walks the folder.
	if (records.some((record) => record.type === "commit")) return "SUBMODULE";
	const nested = await run.command(["/usr/bin/find", tree, "-mindepth", "2", "-iname", ".git", "-print", "-quit"]);
	if (nested.status !== 0) throw new CodeHostJobFailure("CODE_HOST_INSPECT_FAILED", tail(nested.stderr));
	if (nested.stdout.length) return "SUBMODULE";
	// A file the index tells git not to look at (assume-unchanged, skip-worktree) could differ from the head unseen by
	// status: every entry must be a plain one, which `ls-files -v` marks `H`.
	const plain = await run.sh(
		'out=$1; shift; "$@" >"$out" || exit 2; grep -q -v "^H " "$out"; case $? in 1) exit 0 ;; 0) exit 1 ;; *) exit 2 ;; esac',
		[
			`${run.directory}/index.out`,
			run.layout.git,
			"--no-replace-objects",
			`--git-dir=${admin}`,
			`--work-tree=${tree}`,
			"ls-files",
			"-v",
		],
	);
	if (plain.status !== 0) return "NOT_CLEAN";
	const clean = await run.clean([
		`--git-dir=${admin}`,
		`--work-tree=${tree}`,
		"status",
		"--porcelain",
		"-z",
		"--untracked-files=all",
		"--ignore-submodules=all",
	]);
	if (!clean) return "NOT_CLEAN";
	// Not `git worktree remove`: its own status enters submodules, in a tree the session controls.
	const removed = await run.command(["/usr/bin/rm", "-rf", "--", tree]);
	if (removed.status !== 0) throw new CodeHostJobFailure("CODE_HOST_RETIRE_FAILED", tail(removed.stderr));
	return null;
}

/** Retire's second job for one session, in a job that sees what the first one's save left: with the files gone,
 * git's folder for the worktree goes too. Files that are still there mean the folder dropped their removal because
 * something changed meanwhile: everything stays. */
async function retireGitFolder(run: Run, workerId: string): Promise<string | null> {
	const tree = `${run.code}/worktrees/${workerId}`,
		admin = `${run.repo}/worktrees/${workerId}`;
	const [treeType, adminType] = await run.types([tree, admin]);
	if (treeType !== "none") return "FILES_STILL_THERE";
	if (adminType !== "directory") return "NOT_THERE";
	if (!(await run.read(`${admin}/gitdir`))?.equals(Buffer.from(`${tree}/.git\n`))) return "LINKS_DIFFER";
	const removed = await run.command(["/usr/bin/rm", "-rf", "--", admin]);
	if (removed.status !== 0) throw new CodeHostJobFailure("CODE_HOST_RETIRE_FAILED", tail(removed.stderr));
	return null;
}

/** Nightly care's retiring of archived sessions' worktrees (at most 20 a job), in two jobs. `files` removes a
 * worktree's files when all of this holds, and says which did not (`reason`) when it leaves them:
 * both folders are there (NOT_THERE) with their link files as git made them (LINKS_DIFFER); the worktree's HEAD is its
 * session's branch (HEAD_NOT_ITS_BRANCH), which is a commit (NO_BRANCH); no merge, pick, revert, bisect or rebase is
 * under way and the worktree has no refs of its own (IN_PROGRESS); the head's names pass `addCodeWorktree`'s check
 * (NAMES_REFUSED); neither the head nor the folder holds a repository inside (SUBMODULE); and git's status of the
 * folder, untracked and ignored files included, prints nothing (NOT_CLEAN). `git-folder`, in a later job, removes
 * git's own folder for a worktree whose files are gone, and leaves one whose files are still there
 * (FILES_STILL_THERE). The branch always stays: `addCodeWorktree` gives a follow-up its worktree back from it.
 * Whether a session may be retired at all (archived, not attached, no turn waiting) is the caller's to know. */
export async function retireCodeWorktrees(
	job: CodeHostJob,
	value: { repository: CloudCodingRepository; workerIds: readonly string[] },
	options: { phase: "files" | "git-folder" },
): Promise<{ retired: string[]; kept: { workerId: string; reason: string }[] }> {
	const input = closed(value, ["repository", "workerIds"]);
	const repository = keptRepositoryOf(input.repository),
		phase = options?.phase,
		given = input.workerIds;
	if (
		(phase !== "files" && phase !== "git-folder") ||
		!Array.isArray(given) ||
		given.length > 20 ||
		new Set(given).size !== given.length
	)
		throw new Error("INVALID_CODE_HOST_JOB");
	const workerIds = given.map(workerIdOf);
	return withJob(job, repository, async (run) => {
		if (!(await run.prepare()).seeded) throw new CodeHostRefusal("CODE_HOST_NOT_SEEDED", [run.area]);
		if ((await run.ref(CODE_AREA_IN_QORPERA_REF)) === null)
			throw new CodeHostRefusal("CODE_HOST_AREA_FROM_GITHUB", [run.area]);
		const retired: string[] = [],
			kept: { workerId: string; reason: string }[] = [];
		for (const workerId of workerIds) {
			const reason = await (phase === "files" ? retireFiles(run, workerId) : retireGitFolder(run, workerId));
			if (reason === null) retired.push(workerId);
			else kept.push({ workerId, reason });
		}
		return { retired, kept };
	});
}

// The change record, the undo and the download of a repository kept in Qorpera (own code storage, step 2b). Each is a
// job of its own on a kept repository whose default branch is there. Only the undo moves a ref, through `moveBase` as a
// landing does, and as its last step: a job that fails or is cancelled before it leaves nothing behind.

/** A step 2b job's place: a seeded repository kept in Qorpera (a copy of a GitHub repository is refused, as nightly
 * care refuses it), with its default branch and that branch's commit. */
async function keptArea(run: Run) {
	const area = await run.prepare();
	if (!area.seeded) throw new CodeHostRefusal("CODE_HOST_NOT_SEEDED", [run.area]);
	const base = `refs/heads/${run.repository.baseBranch}`;
	const named = await run.refsNamed([CODE_AREA_IN_QORPERA_REF, base]);
	if (named(CODE_AREA_IN_QORPERA_REF) === null) throw new CodeHostRefusal("CODE_HOST_AREA_FROM_GITHUB", [run.area]);
	const mainSha = named(base);
	if (!mainSha) throw new CodeHostRefusal("CODE_HOST_AREA_NO_BASE", [base]);
	return { area, base, mainSha };
}

/** What stands at each of the platform's own paths in a code area, asked for as many as one command carries: a folder
 * (`folders`) or a file is there, or nothing; a link is refused, and so is anything else. */
async function ownPaths(
	run: Run,
	folders: readonly string[],
	files: readonly string[],
): Promise<Map<string, PathType>> {
	const paths = [...folders, ...files],
		type = new Map<string, PathType>();
	for (let index = 0; index < paths.length; index += 60) {
		const part = paths.slice(index, index + 60),
			types = await run.types(part);
		part.forEach((path, at) => {
			type.set(path, types[at] as PathType);
		});
	}
	const links = paths.filter((path) => type.get(path) === "link");
	if (links.length)
		throw new CodeHostRefusal(
			"CODE_HOST_LINK",
			links.map((path) => run.relative(path)),
		);
	const wrong = [
		...folders.filter((path) => !["none", "directory"].includes(type.get(path) as PathType)),
		...files.filter((path) => !["none", "file"].includes(type.get(path) as PathType)),
	];
	if (wrong.length)
		throw new CodeHostRefusal(
			"CODE_HOST_UNEXPECTED_FILE",
			wrong.map((path) => run.relative(path)),
		);
	return type;
}

/** One change's record file, as the executor rendered it. */
export interface CodeChangeRecordFile {
	n: number;
	/** The file's text; with `diff`, a function of what the job found between the two commits. */
	text: string | ((diff: CodeChangeDiff) => string);
	diff?: { before: string; after: string };
	/** The picture's git blob and the folder path it is copied to (`code/<owner>/<name>/changes/<n>.<ext>`). */
	picture?: { blob: string; to: string };
}
export interface CodeChangeArchiveFile {
	name: string;
	text: string;
	immutable?: boolean;
}
export const CODE_CHANGE_ARCHIVE_COMPLETE_LINE = "Status: complete.";
export const MAX_CODE_CHANGE_ARCHIVES = 50;
const MAX_RECORDS = 200;
const MAX_ARCHIVES = MAX_CODE_CHANGE_ARCHIVES;
const ARCHIVE_FILE_NAME = /^(\d{4,9})-(\d{4,9})\.md$/;
const MAX_RECORD_TEXT = 256 * 1024;

export async function listCodeChangeArchives(
	job: CodeHostJob,
	repositoryInput: CloudCodingRepository,
): Promise<Set<string>> {
	const repository = keptRepositoryOf(repositoryInput);
	return withJob(job, repository, async (run) => {
		if (job.preparedKeptArea !== run.area) await keptArea(run);
		const archiveFolder = `${run.code}/changes/archive`;
		const listed = await run.sh(
			'if [ -d "$1" ]; then for f in "$1"/*.md; do [ -f "$f" ] || continue; if head -n 4 -- "$f" | grep -Fxq -- "$2"; then basename -- "$f"; fi; done; fi',
			[archiveFolder, CODE_CHANGE_ARCHIVE_COMPLETE_LINE],
		);
		if (listed.status !== 0) throw new CodeHostJobFailure("CODE_HOST_RECORD_FAILED", tail(listed.stderr));
		const found = new Set<string>();
		for (const line of listed.stdout.toString("utf8").split("\n")) {
			const name = line.trim();
			if (ARCHIVE_FILE_NAME.test(name)) found.add(name);
		}
		return found;
	});
}

function recordText(value: unknown): string {
	if (typeof value !== "string" || !value || value.includes("\0") || Buffer.byteLength(value) > MAX_RECORD_TEXT)
		throw new Error("INVALID_CODE_HOST_JOB");
	return value;
}

/** Each file's bytes from stdin, one after the other, each under git's own lock name and then renamed over its place.
 * The arguments are the files' paths and sizes in turn. */
const WRITE_RECORDS = `umask 022
while [ "$#" -gt 0 ]; do
	rm -f -- "$1.lock" || exit 1
	/usr/bin/head -c "$2" >"$1.lock" || exit 1
	[ "$(wc -c <"$1.lock")" -eq "$2" ] || exit 1
	mv -fT -- "$1.lock" "$1" || exit 1
	shift 2
done`;
/** One file version from git's objects, written the same way. */
const WRITE_PICTURE = `to=$1; shift; umask 022
rm -f -- "$to.lock" || exit 1
"$@" >"$to.lock" || exit 1
exec mv -fT -- "$to.lock" "$to"`;

/** The change record's files of a repository kept in Qorpera (step 2b): `changes/<n>.md` for each record, with the
 * session's picture copied out of git beside it (`changes/<n>.png`, `.jpg` or `.webp`, the bytes of exactly that git
 * blob), and, when given, the list `changes/index.md`. A file that already holds its bytes is left. A record with
 * `diff` is rendered with what differs between its two commits, and that is answered in `diffs`. `written` names the
 * records whose file now holds their text. What a restore took out of the repository cannot fail the job, or no file
 * of the repository would be written again: a record whose `diff` names a commit that is not here is left unwritten
 * and out of `written`, and a picture whose blob is not here (or is no file version of at most 4 MiB) is not copied
 * while its record is written. The job never touches a ref, and the folder saves what it wrote when it ends. */
export async function writeCodeChangeRecords(
	job: CodeHostJob,
	value: {
		repository: CloudCodingRepository;
		records: readonly CodeChangeRecordFile[];
		index: string | null;
		archives?: readonly CodeChangeArchiveFile[];
	},
): Promise<{ written: number[]; diffs: ({ n: number } & CodeChangeDiff)[]; restored: string[] }> {
	const input = closedWith(value, ["repository", "records", "index"], ["archives"]);
	const repository = keptRepositoryOf(input.repository),
		index = input.index === null ? null : recordText(input.index),
		given = input.records,
		givenArchives = input.archives ?? [],
		changes = `${codeAreaPath(repository)}/changes`;
	if (
		!Array.isArray(given) ||
		given.length > MAX_RECORDS ||
		!Array.isArray(givenArchives) ||
		givenArchives.length > MAX_ARCHIVES
	)
		throw new Error("INVALID_CODE_HOST_JOB");
	const archives = givenArchives.map((entry: unknown) => {
		const archive = closedWith(entry, ["name", "text"], ["immutable"]);
		if (typeof archive.name !== "string") throw new Error("INVALID_CODE_HOST_JOB");
		const match = ARCHIVE_FILE_NAME.exec(archive.name);
		if (!match) throw new Error("INVALID_CODE_HOST_JOB");
		const start = Number(match[1]);
		const end = Number(match[2]);
		if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start)
			throw new Error("INVALID_CODE_HOST_JOB");
		if (archive.immutable !== undefined && typeof archive.immutable !== "boolean")
			throw new Error("INVALID_CODE_HOST_JOB");
		return { name: archive.name, text: recordText(archive.text), immutable: archive.immutable === true };
	});
	if (new Set(archives.map((archive) => archive.name)).size !== archives.length)
		throw new Error("INVALID_CODE_HOST_JOB");
	const records = given.map((entry: unknown) => {
		const record = closedWith(entry, ["n", "text"], ["diff", "picture"]),
			n = record.n,
			text = record.text;
		if (!Number.isSafeInteger(n) || (n as number) < 1) throw new Error("INVALID_CODE_HOST_JOB");
		const ends = record.diff === undefined ? undefined : closed(record.diff, ["before", "after"]),
			diff = ends && { before: sha(ends.before), after: sha(ends.after) },
			copy = record.picture === undefined ? undefined : closed(record.picture, ["blob", "to"]),
			picture = copy && { blob: sha(copy.blob), to: copy.to as string };
		if (typeof text !== "function") recordText(text);
		else if (!diff) throw new Error("INVALID_CODE_HOST_JOB");
		if (picture && !["png", "jpg", "webp"].some((ext) => picture.to === `${changes}/${n}.${ext}`))
			throw new Error("INVALID_CODE_HOST_JOB");
		return { n: n as number, text: text as CodeChangeRecordFile["text"], diff, picture };
	});
	if (new Set(records.map((record) => record.n)).size !== records.length) throw new Error("INVALID_CODE_HOST_JOB");
	return withJob(job, repository, async (run) => {
		if (job.preparedKeptArea !== run.area) await keptArea(run);
		const folder = `${run.code}/changes`,
			archiveFolder = `${folder}/archive`,
			diffs: ({ n: number } & CodeChangeDiff)[] = [],
			texts: { n: number | null; path: string; bytes: Buffer; archive?: boolean; immutable?: boolean }[] = [],
			pictures: { blob: string; path: string }[] = [];
		const diffCommits = [
			...new Set(records.flatMap((record) => (record.diff ? [record.diff.before, record.diff.after] : []))),
		];
		const diffHere = diffCommits.length ? await run.areCommits(run.repo, diffCommits) : [];
		const here = new Map(diffCommits.map((commit, index) => [commit, diffHere[index] === true]));
		for (const { n, text, diff, picture } of records) {
			let found: CodeChangeDiff | undefined;
			if (diff) {
				if (!here.get(diff.before) || !here.get(diff.after)) continue;
				found = await changeDiff(run, diff.before, diff.after, "CODE_HOST_RECORD_FAILED");
				diffs.push({ n, ...found });
			}
			const rendered = typeof text === "function" ? recordText(text(found as CodeChangeDiff)) : text;
			texts.push({ n, path: `${folder}/${n}.md`, bytes: Buffer.from(rendered, "utf8") });
			if (picture) pictures.push({ blob: picture.blob, path: `${run.layout.companyRoot}/${picture.to}` });
		}
		if (index !== null) texts.push({ n: null, path: `${folder}/index.md`, bytes: Buffer.from(index, "utf8") });
		for (const archive of archives) {
			texts.push({
				n: null,
				path: `${archiveFolder}/${archive.name}`,
				bytes: Buffer.from(archive.text, "utf8"),
				archive: true,
				immutable: archive.immutable,
			});
		}
		if (pictures.length) {
			const sized = await run.gitOk(run.repo, ["cat-file", "--batch-check"], "CODE_HOST_RECORD_FAILED", {
				stdin: Buffer.from(pictures.map((picture) => `${picture.blob}\n`).join("")),
			});
			const lines = sized.toString("latin1").split("\n");
			if (lines.pop() !== "" || lines.length !== pictures.length)
				throw new CodeHostJobFailure("CODE_HOST_RECORD_FAILED", "cat-file's lines are not git's");
			for (let at = pictures.length - 1; at >= 0; at -= 1) {
				const [name, type, size] = (lines[at] as string).split(" ");
				if (name !== pictures[at]?.blob) throw new CodeHostJobFailure("CODE_HOST_RECORD_FAILED", "cat-file");
				if (type !== "blob" || !(Number(size) <= MAX_PICTURE)) pictures.splice(at, 1);
			}
		}
		const type = await ownPaths(
			run,
			archives.length ? [folder, archiveFolder] : [folder],
			[...texts, ...pictures].map((file) => file.path),
		);
		const hashes = async (script: string, lead: readonly string[], paths: readonly string[], pattern: RegExp) => {
			const found = new Map<string, string>();
			for (let at = 0; at < paths.length; at += 50) {
				const part = paths.slice(at, at + 50);
				const hashed = await run.sh(script, [...lead, ...part]),
					lines = hashed.stdout.toString("latin1").split("\n");
				if (hashed.status !== 0 || lines.pop() !== "" || lines.length !== part.length)
					throw new CodeHostJobFailure("CODE_HOST_RECORD_FAILED", tail(hashed.stderr));
				part.forEach((path, line) => {
					const hash = pattern.exec(lines[line] as string)?.[1];
					if (!hash) throw new CodeHostJobFailure("CODE_HOST_RECORD_FAILED", "a hash line is not the tool's");
					found.set(path, hash);
				});
			}
			return found;
		};
		const there = (file: { path: string }) => type.get(file.path) === "file";
		const existingCompleteArchives = new Set<string>();
		const immutableExisting = texts.filter((file) => file.immutable && there(file));
		if (immutableExisting.length) {
			const checked = await run.sh(
				'marker=$1; shift; for p do if head -n 4 -- "$p" | grep -Fxq -- "$marker"; then printf "1\\n"; else printf "0\\n"; fi; done',
				[CODE_CHANGE_ARCHIVE_COMPLETE_LINE, ...immutableExisting.map((file) => file.path)],
			);
			const flags = checked.stdout.toString("latin1").split("\n");
			if (checked.status !== 0 || flags.pop() !== "" || flags.length !== immutableExisting.length)
				throw new CodeHostJobFailure("CODE_HOST_RECORD_FAILED", tail(checked.stderr));
			immutableExisting.forEach((file, idx) => {
				if (flags[idx] === "1") existingCompleteArchives.add(file.path);
			});
		}
		const hashableTexts = texts.filter((file) => there(file) && !existingCompleteArchives.has(file.path));
		const [textHashes, pictureHashes] = await Promise.all([
			hashes(
				'for p do sha256sum <"$p" || exit 1; done',
				[],
				hashableTexts.map((file) => file.path),
				/^([0-9a-f]{64}) [ *]-$/,
			),
			hashes(
				'exec "$@"',
				[run.layout.git, "--no-replace-objects", `--git-dir=${run.repo}`, "hash-object", "--no-filters", "--"],
				pictures.filter(there).map((file) => file.path),
				/^([0-9a-f]{40})$/,
			),
		]);
		const newTexts = texts.filter((file) => {
				if (existingCompleteArchives.has(file.path)) return false;
				return textHashes.get(file.path) !== createHash("sha256").update(file.bytes).digest("hex");
			}),
			newPictures = pictures.filter((file) => pictureHashes.get(file.path) !== file.blob);
		if (newTexts.length + newPictures.length && type.get(folder) === "none") {
			const made = await run.command(["/usr/bin/mkdir", "-m", "0755", "--", folder]);
			if (made.status !== 0) throw new CodeHostJobFailure("CODE_HOST_RECORD_FAILED", tail(made.stderr));
		}
		if (newTexts.some((file) => file.archive) && type.get(archiveFolder) === "none") {
			const made = await run.command(["/usr/bin/mkdir", "-m", "0755", "--", archiveFolder]);
			if (made.status !== 0) throw new CodeHostJobFailure("CODE_HOST_RECORD_FAILED", tail(made.stderr));
		}
		for (let at = 0; at < newTexts.length; at += 25) {
			const part = newTexts.slice(at, at + 25);
			const wrote = await run.sh(
				WRITE_RECORDS,
				part.flatMap((file) => [file.path, String(file.bytes.length)]),
				{ stdin: Buffer.concat(part.map((file) => file.bytes)) },
			);
			if (wrote.status !== 0) throw new CodeHostJobFailure("CODE_HOST_RECORD_FAILED", tail(wrote.stderr));
		}
		for (const picture of newPictures) {
			const wrote = await run.sh(WRITE_PICTURE, [
				picture.path,
				run.layout.git,
				"--no-replace-objects",
				`--git-dir=${run.repo}`,
				"cat-file",
				"blob",
				picture.blob,
			]);
			if (wrote.status !== 0) throw new CodeHostJobFailure("CODE_HOST_RECORD_FAILED", tail(wrote.stderr));
		}
		return {
			written: texts.flatMap((file) => (file.n === null ? [] : [file.n])),
			diffs,
			restored: run.restored,
		};
	});
}

/** An undo's answer. `undone`: the default branch moved from `mainBefore` to the undo's commit `mainAfter`, which
 * changed `diff`; `replayed` when an earlier run of the same request had made it. `nothing`: the default branch no
 * longer holds what the change did, and stays where it is. */
export type CodeChangeUndone =
	| { state: "undone"; mainBefore: string; mainAfter: string; diff: CodeChangeDiff; replayed: boolean }
	| { state: "nothing"; mainSha: string };

/** A change taken out of the default branch of a repository kept in Qorpera, as one new commit on it by the platform's
 * committer, moved with `moveBase`'s compare-and-swap as a landing is (a move that lost the branch to another fails
 * with `CODE_HOST_BASE_MOVED`, having written nothing, and is asked again). The change is given by the record's two
 * ends of the default branch, `mainBefore` and `mainAfter`, never by a commit's parents, so a fast-forward of many
 * commits and a merge are undone alike. The new files are git's three-way merge of the default branch with
 * `mainBefore`, from `mainAfter` as the base (`merge-tree`, no worktree): what the change put in goes, everything
 * since stays. When later changes built on it that merge conflicts: nothing is written, and the refusal names the
 * paths (`CODE_HOST_UNDO_CONFLICT`). `andLater` takes no merge: the new commit's files are exactly `mainBefore`'s.
 * The commit's message is `message`, then the line `Qorpera-Request: <requestId>`; a run finds an earlier run's commit
 * by that line and answers it again (`replayed`), with main/ put right. Refused as well: a commit that is not here
 * (`CODE_HOST_UNDO_UNKNOWN_COMMIT`), a change the default branch does not hold (`CODE_HOST_UNDO_NOT_IN_MAIN`), names a
 * landing would refuse, and a place that is not a seeded repository kept in Qorpera. */
export async function undoCodeChange(
	job: CodeHostJob,
	value: {
		repository: CloudCodingRepository;
		requestId: string;
		change: { n: number; mainBefore: string; mainAfter: string };
		andLater: boolean;
		message: string;
	},
): Promise<CodeChangeUndone> {
	const input = closed(value, ["repository", "requestId", "change", "andLater", "message"]);
	const repository = keptRepositoryOf(input.repository),
		change = closed(input.change, ["n", "mainBefore", "mainAfter"]),
		before = sha(change.mainBefore),
		after = sha(change.mainAfter),
		{ requestId, andLater, message } = input;
	if (
		!isUuid(requestId) ||
		!Number.isSafeInteger(change.n) ||
		(change.n as number) < 1 ||
		typeof andLater !== "boolean" ||
		typeof message !== "string" ||
		!message.trim() ||
		message.includes("\0") ||
		Buffer.byteLength(message) > 4096
	)
		throw new Error("INVALID_CODE_HOST_JOB");
	const line = `Qorpera-Request: ${requestId}`;
	return withJob(job, repository, async (run) => {
		const { area, base, mainSha } = await keptArea(run);
		const wanted = [...new Set([after, before])];
		const exists = await run.areCommits(run.repo, wanted);
		const unknown = wanted.filter((_, index) => !exists[index]);
		if (unknown.length) throw new CodeHostRefusal("CODE_HOST_UNDO_UNKNOWN_COMMIT", unknown);
		const held = await run.git(run.repo, ["merge-base", "--is-ancestor", after, mainSha]);
		if (held.status === 1) throw new CodeHostRefusal("CODE_HOST_UNDO_NOT_IN_MAIN", [after]);
		if (held.status !== 0) throw new CodeHostJobFailure("CODE_HOST_UNDO_FAILED", tail(held.stderr));
		// Done already? An earlier run of this request moved the branch, and its answer was lost.
		const [earlier, parent] = (
			await run.gitOk(
				run.repo,
				[
					"rev-list",
					"--first-parent",
					"--fixed-strings",
					`--grep=${line}`,
					"--max-count=1",
					"--no-commit-header",
					"--format=%H %P",
					`${after}..${mainSha}`,
				],
				"CODE_HOST_UNDO_FAILED",
			)
		)
			.toString("latin1")
			.trim()
			.split(" ");
		if (earlier) {
			if (!SHA.test(earlier) || !SHA.test(parent ?? ""))
				throw new CodeHostJobFailure("CODE_HOST_UNDO_FAILED", "the request's commit is not an undo's");
			const diff = await changeDiff(run, parent as string, earlier, "CODE_HOST_UNDO_FAILED");
			// That run's job saved the branch and not main/'s files.
			const at =
				area.main === "present" &&
				(await run.read(`${run.repo}/worktrees/main/HEAD`))?.equals(Buffer.from(`${mainSha}\n`)) === true;
			if (!at) await moveBase(run, area.main, base, mainSha, mainSha);
			return { state: "undone", mainBefore: parent as string, mainAfter: earlier, diff, replayed: true };
		}
		const treeOf = async (commit: string): Promise<string> => {
			const tree = (
				await run.gitOk(run.repo, ["rev-parse", "--verify", `${commit}^{tree}`], "CODE_HOST_UNDO_FAILED")
			)
				.toString("latin1")
				.trim();
			if (!SHA.test(tree)) throw new CodeHostJobFailure("CODE_HOST_UNDO_FAILED", "no tree");
			return tree;
		};
		let tree: string;
		if (andLater) tree = await treeOf(before);
		else {
			const merged = await run.git(
				run.repo,
				[
					"merge-tree",
					"--write-tree",
					"-z",
					"--name-only",
					"--no-messages",
					`--merge-base=${after}`,
					mainSha,
					before,
				],
				{ maximumOutputBytes: MAX_READ },
			);
			const fields = merged.stdout.toString("utf8").split("\0");
			// As a landing's conflict: the tree, then each conflicted path (one per conflicting stage).
			if (merged.status === 1)
				throw new CodeHostRefusal("CODE_HOST_UNDO_CONFLICT", [...new Set(fields.slice(1).filter(Boolean))]);
			if (merged.status !== 0 || !SHA.test(fields[0] ?? ""))
				throw new CodeHostJobFailure("CODE_HOST_UNDO_FAILED", tail(merged.stderr));
			tree = fields[0] as string;
		}
		if (tree === (await treeOf(mainSha))) return { state: "nothing", mainSha };
		const next = (
			await run.gitOk(
				run.repo,
				[...PLATFORM_COMMITTER, "commit-tree", tree, "-p", mainSha, "-m", message, "-m", line],
				"CODE_HOST_UNDO_FAILED",
			)
		)
			.toString("latin1")
			.trim();
		if (!SHA.test(next)) throw new CodeHostJobFailure("CODE_HOST_UNDO_FAILED", "no undo commit");
		// A file put back may differ from a newer one only by case.
		await run.checkNames(run.repo, next);
		const diff = await changeDiff(run, mainSha, next, "CODE_HOST_UNDO_FAILED");
		await moveBase(run, area.main, base, next, mainSha);
		return { state: "undone", mainBefore: mainSha, mainAfter: next, diff, replayed: false };
	});
}

/** A download's file name: one plain name ending in what its kind is, `.zip` or `.bundle`. */
function downloadName(value: unknown): string {
	if (typeof value !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,190}\.(zip|bundle)$/.test(value))
		throw new Error("INVALID_CODE_HOST_JOB");
	return value;
}

/** The made file into downloads/, after the files of its kind that stood there (their lock names too): one zip and
 * one bundle stay at most. */
const PUBLISH_DOWNLOAD = `dir=$1 made=$2 name=$3 kind=$4; umask 022
mkdir -p -- "$dir" || exit 1
find "$dir" -mindepth 1 -maxdepth 1 ! -type d \\( -name "*.$kind" -o -name "*.$kind.lock" \\) -exec rm -f -- {} + || exit 1
cat -- "$made" >"$dir/$name.lock" || exit 1
exec mv -fT -- "$dir/$name.lock" "$dir/$name"`;

/** The code of a repository kept in Qorpera as one file a member downloads (step 2b), made in the scratch and then
 * put at `code/<owner>/<name>/downloads/<fileName>`. `files` is the default branch's files as a zip
 * (`git archive --format=zip`, every path under `<name>/`; what the repository's own `.gitattributes` marks
 * `export-ignore` is left out, as git does). `history` is the default branch with its history as a git bundle of
 * `HEAD` and that branch, for a developer: it is verified and cloned in the scratch, and that clone's `HEAD` must be
 * the branch at its commit, so a plain `git clone` of the file checks the code out. The sessions' branches and the
 * mark are in neither. Over `maximumBytes` (default 200 MiB, which keeps clear of a folder file's 256 MiB) it is
 * refused with `CODE_HOST_DOWNLOAD_TOO_LARGE` and nothing is written. The file replaces whatever of its kind stood in
 * downloads/. Answers its folder path, its size and SHA-256, and the commit it was made from. */
export async function archiveCodeArea(
	job: CodeHostJob,
	value: { repository: CloudCodingRepository; file: "files" | "history"; fileName: string },
	options: { maximumBytes?: number } = {},
): Promise<{ path: string; bytes: number; sha256: string; mainSha: string }> {
	const input = closed(value, ["repository", "file", "fileName"]);
	const repository = keptRepositoryOf(input.repository),
		kind = input.file === "files" ? "zip" : "bundle",
		fileName = downloadName(input.fileName),
		maximumBytes = options.maximumBytes ?? 200 * MiB;
	if (
		(input.file !== "files" && input.file !== "history") ||
		!fileName.endsWith(`.${kind}`) ||
		!Number.isSafeInteger(maximumBytes) ||
		maximumBytes < 1 ||
		maximumBytes > MAX_BLOB
	)
		throw new Error("INVALID_CODE_HOST_JOB");
	return withJob(job, repository, async (run) => {
		const { base, mainSha } = await keptArea(run);
		const folder = `${run.code}/downloads`,
			made = `${run.directory}/${fileName}`;
		await ownPaths(run, [folder], []);
		if (kind === "zip")
			await run.gitOk(
				run.repo,
				["archive", "--format=zip", `--prefix=${repository.name}/`, "-o", made, mainSha],
				"CODE_HOST_DOWNLOAD_FAILED",
			);
		else {
			const proof = `${run.directory}/proof`;
			await run.gitOk(run.repo, ["bundle", "create", "--quiet", made, "HEAD", base], "CODE_HOST_DOWNLOAD_FAILED");
			await run.gitOk(run.repo, ["bundle", "verify", "--quiet", made], "CODE_HOST_DOWNLOAD_FAILED");
			// What a developer does with the file. Without its files: the clone's HEAD says what would be checked out.
			const cloned = await run.command([
				run.layout.git,
				"--no-replace-objects",
				"clone",
				"--quiet",
				"--no-checkout",
				"--template=",
				made,
				proof,
			]);
			if (cloned.status !== 0) throw new CodeHostJobFailure("CODE_HOST_DOWNLOAD_FAILED", tail(cloned.stderr));
			const head = await run.gitOk(`${proof}/.git`, ["symbolic-ref", "HEAD"], "CODE_HOST_DOWNLOAD_FAILED"),
				at = await run.gitOk(
					`${proof}/.git`,
					["rev-parse", "--verify", "HEAD^{commit}"],
					"CODE_HOST_DOWNLOAD_FAILED",
				);
			if (head.toString("utf8") !== `${base}\n` || at.toString("utf8") !== `${mainSha}\n`)
				throw new CodeHostJobFailure(
					"CODE_HOST_DOWNLOAD_FAILED",
					"a clone of the bundle is not at the default branch",
				);
		}
		const measured = await run.sh('sha256sum <"$1" && exec wc -c <"$1"', [made]),
			[, sha256, counted] = /^([0-9a-f]{64}) [ *]-\n *(\d+)\n$/.exec(measured.stdout.toString("latin1")) ?? [],
			bytes = Number(counted);
		if (measured.status !== 0 || !sha256 || !Number.isSafeInteger(bytes) || bytes < 1)
			throw new CodeHostJobFailure("CODE_HOST_DOWNLOAD_FAILED", tail(measured.stderr));
		if (bytes > maximumBytes) throw new CodeHostRefusal("CODE_HOST_DOWNLOAD_TOO_LARGE", [`${bytes} bytes`]);
		const published = await run.sh(PUBLISH_DOWNLOAD, [folder, made, fileName, kind]);
		if (published.status !== 0) throw new CodeHostJobFailure("CODE_HOST_DOWNLOAD_FAILED", tail(published.stderr));
		return { path: `${run.area}/downloads/${fileName}`, bytes, sha256, mainSha };
	});
}

/** Downloads removed from `code/<owner>/<name>/downloads/` by their file names (at most 20; an expired request's
 * file). A name that is not there, or is a folder, is left out of `removed`; the folder itself goes when the last
 * file went. */
export async function removeCodeDownloads(
	job: CodeHostJob,
	value: { repository: CloudCodingRepository; fileNames: readonly string[] },
): Promise<{ removed: string[] }> {
	const input = closed(value, ["repository", "fileNames"]);
	const repository = keptRepositoryOf(input.repository),
		given = input.fileNames;
	if (!Array.isArray(given) || given.length > 20 || new Set(given).size !== given.length)
		throw new Error("INVALID_CODE_HOST_JOB");
	const fileNames = given.map(downloadName);
	return withJob(job, repository, async (run) => {
		await keptArea(run);
		const folder = `${run.code}/downloads`;
		if ((await ownPaths(run, [folder], [])).get(folder) === "none" || !fileNames.length) return { removed: [] };
		// A link by a download's name goes as a file does: `rm` takes the link away, never what it points at.
		const removed = await run.sh(
			'dir=$1; shift; for n do if [ -L "$dir/$n" ] || [ -f "$dir/$n" ]; then rm -f -- "$dir/$n" || exit 1; printf "%s\\n" "$n"; fi; done; rmdir -- "$dir" 2>/dev/null; exit 0',
			[folder, ...fileNames],
		);
		if (removed.status !== 0) throw new CodeHostJobFailure("CODE_HOST_DOWNLOAD_FAILED", tail(removed.stderr));
		return { removed: removed.stdout.toString("utf8").split("\n").filter(Boolean) };
	});
}

/** One path of a commit: a regular file (mode 100644 or 100755) with its bytes, something else (a folder, a link or a
 * submodule), or nothing. The shape of 5h's `CodingSetupSource`. */
export type CodeCommitEntry = { kind: "missing" } | { kind: "file"; bytes: Uint8Array } | { kind: "other" };
/** A path of one commit, as git holds it: its entry (a file's bytes cut after maxBytes + 1), and its blob's id when it
 * is a regular file. */
export interface CodeCommitFile {
	entry: CodeCommitEntry;
	blob: string | null;
}
/** One path of a commit of the code area, read by git (`ls-tree`, then `cat-file`) and never from a worktree. `path`
 * and `maxBytes` are the caller's to check. */
async function commitTreeEntry(
	run: Run,
	commit: string,
	path: string,
): Promise<ReturnType<typeof treeRecords>[number] | undefined> {
	// Without -r, ls-tree walks down to the path and shows its own entry.
	const listing = await run.gitOk(
		run.repo,
		["ls-tree", "-l", "-z", "--full-tree", commit, "--", path],
		"CODE_HOST_TREE_UNREADABLE",
	);
	const wantedPath = Buffer.from(path, "utf8");
	return treeRecords(listing).find((record) => record.path.equals(wantedPath));
}

async function commitFileFromEntry(
	run: Run,
	entry: ReturnType<typeof treeRecords>[number] | undefined,
	maxBytes: number,
): Promise<CodeCommitFile> {
	if (!entry) return { entry: { kind: "missing" }, blob: null };
	const { mode, type, name, size } = entry;
	if (type !== "blob" || (mode !== "100644" && mode !== "100755")) return { entry: { kind: "other" }, blob: null };
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
	return { entry: { kind: "file", bytes: new Uint8Array(result.stdout) }, blob: name };
}
