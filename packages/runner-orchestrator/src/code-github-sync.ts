import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	type CloudCodingRepository,
	isUuid,
	parseCloudCodingRepository,
	parseGitHubCodingRepository,
} from "@qorpera/contracts";
import { CODE_FOLDER_ANY_SESSION, codeFolderRefuses } from "./code-folder-names.ts";
import {
	CODE_AREA_IN_QORPERA_REF,
	CodeHostJobFailure,
	CodeHostRefusal,
	MAX_PACK,
	moveBase,
	PLATFORM_COMMITTER,
	parseMergeTreeConflict,
	type Run,
	SHA,
	streamFileOut,
	tail,
	withJob,
} from "./code-host-jobs.ts";
import type { CodeHostJobs } from "./code-host-views.ts";
import type { CodingRepositoryCredentials } from "./coding-executor-host.ts";
import { type CodingBrokerGitOutput, type CodingBrokerGitRunner, runCodingBrokerGit } from "./coding-git.ts";
import { checkDirectory } from "./lxd-office-journal-files.ts";

const SCHEMA = "qorpera.code-request-outcome/v1";
const GITHUB_API_ORIGIN = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const MAX_SYNC_BUNDLE_BYTES = 128 * 1024 ** 2;
const MAX_PR_RESPONSE_BYTES = 64 * 1024;
const MAX_SCAN_BYTES = 32 * 1024 ** 2;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const REFUSAL_CODE_PATTERN = /^(CODE_HOST|GITHUB_SYNC)_[A-Z0-9_]{1,100}$/;
const GITHUB_TOKEN_PATTERN = /^[A-Za-z0-9_]{20,512}$/;
const SECRET_PATTERNS: readonly RegExp[] = [
	/\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
	/\bgithub_pat_[A-Za-z0-9_]{30,}\b/,
	/\bAKIA[0-9A-Z]{16}\b/,
	/\bsk_live_[0-9A-Za-z]{20,}\b/,
	/\bsk-ant-[A-Za-z0-9_-]{32,}\b/,
	/\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

export type CodeGitHubSyncOp = "sync" | "pull" | "push" | "create_pr";

export interface CodeGitHubSyncRequest {
	readonly kind: "github_sync";
	readonly requestId: string;
	readonly token: string;
	readonly companyId: string;
	readonly environmentId: string;
	readonly owner: string;
	readonly name: string;
	readonly op: CodeGitHubSyncOp;
	readonly githubRepo: string;
	readonly githubOwner: string;
	readonly githubName: string;
	readonly remoteBranch?: string;
	readonly localRef?: string;
	readonly allowDefaultBranch?: boolean;
	readonly headBranch?: string;
	readonly baseBranch?: string;
	readonly title?: string;
	readonly body?: string;
	readonly draft?: boolean;
	readonly sessionId?: string;
}

export type CodeGitHubSyncOutcome = { readonly schema: typeof SCHEMA } & (
	| {
			readonly state: "done";
			readonly result: "synced";
			readonly githubRepo: string;
			readonly remoteBranch: string;
			readonly remoteSha: string | null;
			readonly mainSha: string;
			readonly ahead: number;
			readonly behind: number;
			readonly diverged: boolean;
	  }
	| {
			readonly state: "done";
			readonly result: "pulled";
			readonly githubRepo: string;
			readonly remoteBranch: string;
			readonly mainBefore: string;
			readonly mainAfter: string;
			readonly remoteSha: string;
			readonly mode: "unchanged" | "fast-forward" | "merged";
			readonly commitsPulled: number;
	  }
	| {
			readonly state: "done";
			readonly result: "pushed";
			readonly githubRepo: string;
			readonly localRef: string;
			readonly remoteBranch: string;
			readonly headSha: string;
			readonly previousRemoteSha: string | null;
			readonly created: boolean;
	  }
	| {
			readonly state: "done";
			readonly result: "pr_created";
			readonly githubRepo: string;
			readonly number: number;
			readonly url: string;
			readonly prState: string;
			readonly headBranch: string;
			readonly baseBranch: string;
			readonly title: string;
			readonly headSha: string | null;
			readonly draft: boolean;
			readonly updatedAt: string;
			readonly sessionId?: string;
	  }
	| {
			readonly state: "refused";
			readonly code: string;
			readonly paths?: readonly string[];
			readonly messages?: readonly string[];
	  }
	| { readonly state: "busy" }
	| { readonly state: "failed"; readonly code: string }
);

export interface CodeGitHubSyncOptions {
	readonly hosts: Pick<CodeHostJobs, "run">;
	readonly credentials: CodingRepositoryCredentials;
	readonly journalRoot: string;
	readonly runGit?: CodingBrokerGitRunner;
	readonly fetch?: typeof fetch;
	readonly report?: (event: Record<string, unknown>) => void;
}

export class GitHubSyncRefusal extends Error {
	readonly code: string;
	readonly paths: readonly string[];
	readonly messages: readonly string[];

	constructor(code: string, paths: readonly string[] = [], messages: readonly string[] = []) {
		super(messages[0] ? `${code}: ${messages[0]}` : code);
		this.name = "GitHubSyncRefusal";
		this.code = code;
		this.paths = Object.freeze([...paths]);
		this.messages = Object.freeze([...messages]);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBranchName(value: unknown): value is string {
	return (
		typeof value === "string" &&
		Buffer.byteLength(value, "utf8") <= 200 &&
		BRANCH_PATTERN.test(value) &&
		!value.includes("..") &&
		!value.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock"))
	);
}

function parseGitHubRepoString(value: unknown): {
	readonly githubRepo: string;
	readonly githubOwner: string;
	readonly githubName: string;
} {
	if (typeof value !== "string") throw new Error("CODE_REQUEST_INVALID");
	const parts = value.split("/");
	if (parts.length !== 2) throw new Error("CODE_REQUEST_INVALID");
	const parsed = parseGitHubCodingRepository({
		host: "github.com",
		owner: parts[0],
		name: parts[1],
		baseBranch: "main",
	});
	return {
		githubRepo: `${parsed.owner}/${parsed.name}`,
		githubOwner: parsed.owner,
		githubName: parsed.name,
	};
}

export function codeGitHubSyncRequestOf(value: unknown): CodeGitHubSyncRequest {
	const entry = isRecord(value) ? value : {};
	const { requestId, token, companyId, environmentId, kind, op, githubSync } = entry;
	if (
		kind !== "github_sync" ||
		![requestId, token, companyId, environmentId].every((id) => isUuid(id)) ||
		!isRecord(githubSync)
	)
		throw new Error("CODE_REQUEST_INVALID");
	const repo = parseCloudCodingRepository({
		host: "qorpera",
		owner: entry.owner,
		name: entry.name,
		baseBranch: "main",
	});
	if (op !== "sync" && op !== "pull" && op !== "push" && op !== "create_pr") throw new Error("CODE_REQUEST_INVALID");
	const syncOp: CodeGitHubSyncOp = op;
	const gh = parseGitHubRepoString(githubSync.githubRepo);
	const base = {
		kind: "github_sync" as const,
		requestId: requestId as string,
		token: token as string,
		companyId: companyId as string,
		environmentId: environmentId as string,
		owner: repo.owner,
		name: repo.name,
		op: syncOp,
		...gh,
	};
	if (syncOp === "sync" || syncOp === "pull") {
		if (!isBranchName(githubSync.remoteBranch)) throw new Error("CODE_REQUEST_INVALID");
		return { ...base, remoteBranch: githubSync.remoteBranch };
	}
	if (syncOp === "push") {
		if (
			!isBranchName(githubSync.remoteBranch) ||
			typeof githubSync.localRef !== "string" ||
			!githubSync.localRef ||
			githubSync.localRef.length > 260
		)
			throw new Error("CODE_REQUEST_INVALID");
		if (githubSync.allowDefaultBranch !== undefined && typeof githubSync.allowDefaultBranch !== "boolean")
			throw new Error("CODE_REQUEST_INVALID");
		return {
			...base,
			remoteBranch: githubSync.remoteBranch,
			localRef: githubSync.localRef,
			allowDefaultBranch: githubSync.allowDefaultBranch === true,
		};
	}
	if (
		!isBranchName(githubSync.headBranch) ||
		!isBranchName(githubSync.baseBranch) ||
		typeof githubSync.title !== "string" ||
		!githubSync.title.trim() ||
		githubSync.title.length > 256
	)
		throw new Error("CODE_REQUEST_INVALID");
	if (
		githubSync.body !== undefined &&
		githubSync.body !== null &&
		(typeof githubSync.body !== "string" || githubSync.body.length > 20_000)
	)
		throw new Error("CODE_REQUEST_INVALID");
	if (githubSync.draft !== undefined && typeof githubSync.draft !== "boolean") throw new Error("CODE_REQUEST_INVALID");
	if (githubSync.sessionId !== undefined && githubSync.sessionId !== null && !isUuid(githubSync.sessionId))
		throw new Error("CODE_REQUEST_INVALID");
	return {
		...base,
		headBranch: githubSync.headBranch,
		baseBranch: githubSync.baseBranch,
		title: githubSync.title.trim(),
		...(typeof githubSync.body === "string" ? { body: githubSync.body } : {}),
		draft: githubSync.draft === true,
		...(typeof githubSync.sessionId === "string" ? { sessionId: githubSync.sessionId } : {}),
	};
}

export function codeGitHubSyncOutcomeOf(value: unknown): CodeGitHubSyncOutcome {
	if (!isRecord(value) || value.schema !== SCHEMA) throw new Error("CODE_GITHUB_SYNC_OUTCOME_INVALID");
	if (value.state === "busy") return { schema: SCHEMA, state: "busy" };
	if (value.state === "failed" && typeof value.code === "string" && /^[A-Z0-9_:]{1,120}$/.test(value.code)) {
		return { schema: SCHEMA, state: "failed", code: value.code };
	}
	if (value.state === "refused" && typeof value.code === "string" && REFUSAL_CODE_PATTERN.test(value.code)) {
		return {
			schema: SCHEMA,
			state: "refused",
			code: value.code,
			...(Array.isArray(value.paths) ? { paths: value.paths.slice(0, 100).map(String) } : {}),
			...(Array.isArray(value.messages) ? { messages: value.messages.slice(0, 30).map(String) } : {}),
		};
	}
	if (value.state === "done") {
		if (
			value.result === "synced" ||
			value.result === "pulled" ||
			value.result === "pushed" ||
			value.result === "pr_created"
		) {
			return value as CodeGitHubSyncOutcome;
		}
	}
	throw new Error("CODE_GITHUB_SYNC_OUTCOME_INVALID");
}

function brokerGitConfigs(): string[] {
	return [
		"core.hooksPath=/dev/null",
		"credential.helper=",
		"credential.interactive=false",
		"http.followRedirects=false",
		"http.sslVerify=true",
		"protocol.allow=never",
		"protocol.https.allow=always",
		"submodule.recurse=false",
		"fetch.recurseSubmodules=false",
		"fetch.writeCommitGraph=false",
		"maintenance.auto=false",
		"gc.auto=0",
		"transfer.fsckObjects=true",
		"fetch.fsckObjects=true",
		"receive.fsckObjects=true",
	];
}

function brokerGitEnv(scratch: string, remote?: string, token?: string): Record<string, string> {
	const env: Record<string, string> = {
		PATH: "/usr/bin:/bin",
		HOME: scratch,
		XDG_CONFIG_HOME: scratch,
		LANG: "C",
		LC_ALL: "C",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_SYSTEM: "/dev/null",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_TERMINAL_PROMPT: "0",
		GIT_ASKPASS: "/bin/false",
		GIT_NO_REPLACE_OBJECTS: "1",
		GIT_ALLOW_PROTOCOL: "https",
		GIT_OPTIONAL_LOCKS: "0",
	};
	if (remote !== undefined && token !== undefined) {
		if (!GITHUB_TOKEN_PATTERN.test(token))
			throw new GitHubSyncRefusal("GITHUB_SYNC_AUTH_REFUSED", [], ["GitHub token is unavailable."]);
		env.GIT_CONFIG_COUNT = "1";
		env.GIT_CONFIG_KEY_0 = `http.${remote}.extraHeader`;
		env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
	}
	return env;
}

function parseLsRemoteOutput(
	output: string,
	branchRef: string,
): { defaultBranch: string | null; branchSha: string | null } {
	let defaultBranch: string | null = null;
	let branchSha: string | null = null;
	for (const line of output.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const symref = /^ref:\s+refs\/heads\/(.+)\tHEAD$/.exec(trimmed);
		if (symref?.[1]) {
			defaultBranch = symref[1];
			continue;
		}
		const match = /^([0-9a-f]{40})\t(.+)$/.exec(trimmed);
		if (match?.[1] && match[2] === branchRef) {
			branchSha = match[1];
		}
	}
	return { defaultBranch, branchSha };
}

async function inspectKeptRepo(run: Run): Promise<{
	readonly area: Awaited<ReturnType<Run["prepare"]>>;
	readonly mainSha: string;
}> {
	const area = await run.prepare();
	if (!area.seeded) throw new CodeHostRefusal("CODE_HOST_NOT_SEEDED", [run.area]);
	const named = await run.refsNamed([CODE_AREA_IN_QORPERA_REF, "refs/heads/main"]);
	if (named(CODE_AREA_IN_QORPERA_REF) === null) throw new CodeHostRefusal("CODE_HOST_AREA_FROM_GITHUB", [run.area]);
	const mainSha = named("refs/heads/main");
	if (!mainSha) throw new CodeHostRefusal("CODE_HOST_AREA_NO_BASE", ["refs/heads/main"]);
	return { area, mainSha };
}

async function importBundleIntoRepo(run: Run, bundle: Uint8Array, refName: string, expectedSha: string): Promise<void> {
	const bundleFile = `${run.directory}/sync.bundle`;
	const scratch = `${run.directory}/sync-scratch.git`;
	const put = await run.sh('umask 077; set -C; exec cat >"$1"', [bundleFile], { stdin: bundle });
	if (put.status !== 0) throw new CodeHostJobFailure("CODE_HOST_SYNC_BUNDLE_WRITE_FAILED", tail(put.stderr));
	await run.gitOk(
		scratch,
		["init", "--quiet", "--bare", "--template=", "--ref-format=files", scratch],
		"CODE_HOST_SYNC_FAILED",
	);
	const alt = await run.sh('printf "%s\\n" "$2" >"$1"', [`${scratch}/objects/info/alternates`, `${run.repo}/objects`]);
	if (alt.status !== 0) throw new CodeHostJobFailure("CODE_HOST_SYNC_FAILED", tail(alt.stderr));
	await run.gitOk(scratch, ["bundle", "verify", "--quiet", bundleFile], "CODE_HOST_SYNC_BUNDLE_INVALID");
	await run.gitOk(
		scratch,
		[
			"fetch",
			"--quiet",
			"--no-tags",
			"--no-recurse-submodules",
			"--no-write-fetch-head",
			bundleFile,
			`${refName}:${refName}`,
		],
		"CODE_HOST_SYNC_FAILED",
	);
	const resolved = (
		await run.gitOk(scratch, ["rev-parse", "--verify", `${refName}^{commit}`], "CODE_HOST_SYNC_FAILED")
	)
		.toString("latin1")
		.trim();
	if (resolved !== expectedSha) throw new CodeHostJobFailure("CODE_HOST_SYNC_HEAD_MISMATCH");
	await run.gitOk(scratch, ["repack", "-a", "-d", "-l", "-q"], "CODE_HOST_SYNC_FAILED");
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
	if (listed.status !== 0) throw new CodeHostJobFailure("CODE_HOST_SYNC_FAILED", tail(listed.stderr));
	for (const line of listed.stdout.toString("utf8").split("\n").filter(Boolean)) {
		const space = line.indexOf(" ");
		const size = Number(line.slice(0, space));
		if (!(size < MAX_PACK)) throw new CodeHostRefusal("CODE_HOST_PACK_TOO_LARGE", [`${size} bytes`]);
	}
	const moved = await run.sh(
		'src=$1 dst=$2; for p in "$src"/pack-*.pack; do [ -f "$p" ] || continue; b=$(basename "$p" .pack); cp -f -- "$src/$b.pack" "$dst/$b.pack.tmp" && cp -f -- "$src/$b.idx" "$dst/$b.idx.tmp" && mv -fT -- "$dst/$b.pack.tmp" "$dst/$b.pack" && mv -fT -- "$dst/$b.idx.tmp" "$dst/$b.idx" || exit 1; done',
		[`${scratch}/objects/pack`, `${run.repo}/objects/pack`],
	);
	if (moved.status !== 0) throw new CodeHostJobFailure("CODE_HOST_SYNC_FAILED", tail(moved.stderr));
}

async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) return "";
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel().catch(() => undefined);
				throw new Error("GITHUB_SYNC_RESPONSE_TOO_LARGE");
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks).toString("utf8");
}

function extractGitHubErrorMessage(body: string): string | null {
	try {
		const parsed = JSON.parse(body) as unknown;
		if (!isRecord(parsed)) return null;
		if (Array.isArray(parsed.errors)) {
			for (const entry of parsed.errors) {
				if (isRecord(entry) && typeof entry.message === "string" && entry.message.trim()) {
					return entry.message.trim().slice(0, 240);
				}
			}
		}
		if (typeof parsed.message === "string" && parsed.message.trim()) {
			return parsed.message.trim().slice(0, 240);
		}
	} catch {
		return null;
	}
	return null;
}

function parseGitHubPullRequest(
	parsed: unknown,
	defaults: { readonly headBranch: string; readonly baseBranch: string; readonly title: string },
): {
	readonly number: number;
	readonly url: string;
	readonly prState: string;
	readonly headBranch: string;
	readonly baseBranch: string;
	readonly title: string;
	readonly headSha: string | null;
	readonly draft: boolean;
	readonly updatedAt: string;
} {
	if (!isRecord(parsed)) throw new Error("GITHUB_SYNC_RESPONSE_INVALID");
	const number = typeof parsed.number === "number" && Number.isSafeInteger(parsed.number) ? parsed.number : 0;
	const htmlUrl = typeof parsed.html_url === "string" ? parsed.html_url : "";
	const prState = typeof parsed.state === "string" ? parsed.state : "open";
	const headObj = isRecord(parsed.head) ? parsed.head : {};
	const baseObj = isRecord(parsed.base) ? parsed.base : {};
	const headSha = typeof headObj.sha === "string" && SHA.test(headObj.sha) ? headObj.sha : null;
	const updatedAt =
		typeof parsed.updated_at === "string" && parsed.updated_at ? parsed.updated_at : new Date().toISOString();
	if (number < 1 || !htmlUrl.startsWith("https://")) throw new Error("GITHUB_SYNC_RESPONSE_INVALID");
	return {
		number,
		url: htmlUrl,
		prState,
		headBranch: typeof headObj.ref === "string" && headObj.ref ? headObj.ref : defaults.headBranch,
		baseBranch: typeof baseObj.ref === "string" && baseObj.ref ? baseObj.ref : defaults.baseBranch,
		title: typeof parsed.title === "string" && parsed.title ? parsed.title.slice(0, 256) : defaults.title,
		headSha,
		draft: parsed.draft === true,
		updatedAt: updatedAt.slice(0, 64),
	};
}

export class CodeGitHubSync {
	readonly #hosts: Pick<CodeHostJobs, "run">;
	readonly #credentials: CodingRepositoryCredentials;
	readonly #journalRoot: string;
	readonly #runGit: CodingBrokerGitRunner;
	readonly #fetch: typeof fetch;
	readonly #report: (event: Record<string, unknown>) => void;

	constructor(options: CodeGitHubSyncOptions) {
		this.#hosts = options.hosts;
		this.#credentials = options.credentials;
		this.#journalRoot = options.journalRoot;
		this.#runGit = options.runGit ?? runCodingBrokerGit;
		this.#fetch = options.fetch ?? fetch;
		const report = options.report;
		this.#report = (event) => {
			try {
				report?.(event);
			} catch {
				undefined;
			}
		};
	}

	async run(request: CodeGitHubSyncRequest, signal: AbortSignal): Promise<CodeGitHubSyncOutcome> {
		try {
			if (request.op === "sync") return await this.#sync(request, signal);
			if (request.op === "pull") return await this.#pull(request, signal);
			if (request.op === "push") return await this.#push(request, signal);
			return await this.#createPr(request, signal);
		} catch (error) {
			if (signal.aborted) return { schema: SCHEMA, state: "busy" };
			if (error instanceof GitHubSyncRefusal) {
				return {
					schema: SCHEMA,
					state: "refused",
					code: error.code,
					...(error.paths.length > 0 ? { paths: [...error.paths] } : {}),
					...(error.messages.length > 0 ? { messages: [...error.messages] } : {}),
				};
			}
			if (error instanceof CodeHostRefusal && REFUSAL_CODE_PATTERN.test(error.code)) {
				return {
					schema: SCHEMA,
					state: "refused",
					code: error.code,
					...(error.paths.length > 0 ? { paths: [...error.paths] } : {}),
					...(error.messages.length > 0 ? { messages: [...error.messages] } : {}),
				};
			}
			const code =
				error instanceof CodeHostJobFailure
					? error.code
					: error instanceof Error && /^[A-Z][A-Z0-9_:]{1,100}$/.test(error.message)
						? error.message
						: "GITHUB_SYNC_FAILED";
			this.#report({
				event: "code-github-sync-error",
				requestId: request.requestId,
				op: request.op,
				githubRepo: request.githubRepo,
				error,
			});
			return { schema: SCHEMA, state: "failed", code };
		}
	}

	#githubRepository(request: CodeGitHubSyncRequest, branch: string): CloudCodingRepository {
		return parseGitHubCodingRepository({
			host: "github.com",
			owner: request.githubOwner,
			name: request.githubName,
			baseBranch: branch,
		});
	}

	#qorperaRepository(request: CodeGitHubSyncRequest): CloudCodingRepository {
		return parseCloudCodingRepository({
			host: "qorpera",
			owner: request.owner,
			name: request.name,
			baseBranch: "main",
		});
	}

	#remoteUrl(request: CodeGitHubSyncRequest): string {
		return `https://github.com/${request.githubOwner}/${request.githubName}.git`;
	}

	async #withBrokerScratch<T>(
		request: CodeGitHubSyncRequest,
		branch: string,
		signal: AbortSignal,
		use: (helpers: {
			readonly scratch: string;
			readonly cwd: string;
			readonly remote: string;
			runLocal(
				args: readonly string[],
				long?: boolean,
				stream?: { readonly input?: Uint8Array; readonly output: CodingBrokerGitOutput },
			): Promise<string>;
			runNetwork(args: readonly string[], long?: boolean): Promise<string>;
		}) => Promise<T>,
	): Promise<T> {
		await checkDirectory(this.#journalRoot);
		const scratch = await mkdtemp(join(this.#journalRoot, ".gh-sync-"));
		const cwd = join(scratch, "repo.git");
		const remote = this.#remoteUrl(request);
		const prefix = ["--no-replace-objects", ...brokerGitConfigs().flatMap((config) => ["-c", config])];
		const ghRepo = this.#githubRepository(request, branch);
		const scope = {
			companyId: request.companyId,
			workerId: request.requestId,
			leaseToken: request.token,
		};
		try {
			await checkDirectory(scratch);
			const runLocal = async (
				args: readonly string[],
				long = false,
				stream?: { readonly input?: Uint8Array; readonly output: CodingBrokerGitOutput },
			): Promise<string> =>
				this.#runGit({
					cwd: args[0] === "init" ? scratch : cwd,
					scratchRoot: scratch,
					network: false,
					args: [...prefix, ...args],
					env: brokerGitEnv(scratch),
					signal,
					...(long ? { long } : {}),
					...(stream ? stream : {}),
				});
			const runNetwork = async (args: readonly string[], long = false): Promise<string> =>
				this.#credentials.withRepositoryToken(
					scope,
					ghRepo,
					async (token) =>
						this.#runGit({
							cwd,
							scratchRoot: scratch,
							network: true,
							args: [...prefix, ...args],
							env: brokerGitEnv(scratch, remote, token),
							signal,
							...(long ? { long } : {}),
						}),
					signal,
				);
			await runLocal(["init", "--bare", "--template=", cwd]);
			return await use({ scratch, cwd, remote, runLocal, runNetwork });
		} finally {
			await rm(scratch, { recursive: true, force: true });
		}
	}

	async #fetchRemoteBranchBundle(
		request: CodeGitHubSyncRequest,
		remoteBranch: string,
		signal: AbortSignal,
	): Promise<{ readonly remoteSha: string | null; readonly bundle: Buffer | null }> {
		const branchRef = `refs/heads/${remoteBranch}`;
		return this.#withBrokerScratch(
			request,
			remoteBranch,
			signal,
			async ({ scratch, remote, runLocal, runNetwork }) => {
				const lsOut = await runNetwork(["ls-remote", "--symref", remote, "HEAD", branchRef]);
				const { branchSha } = parseLsRemoteOutput(lsOut, branchRef);
				if (!branchSha) return { remoteSha: null, bundle: null };
				await runNetwork(
					[
						"fetch",
						"--quiet",
						"--no-tags",
						"--no-recurse-submodules",
						"--no-write-fetch-head",
						remote,
						`${branchRef}:${branchRef}`,
					],
					true,
				);
				const bundlePath = join(scratch, "fetched.bundle");
				await runLocal(["bundle", "create", "--quiet", bundlePath, branchRef], true);
				const bundle = await readFile(bundlePath);
				if (bundle.byteLength > MAX_SYNC_BUNDLE_BYTES) {
					throw new GitHubSyncRefusal(
						"GITHUB_SYNC_BUNDLE_TOO_LARGE",
						[],
						["The fetched branch bundle exceeds the 128 MB sync limit."],
					);
				}
				return { remoteSha: branchSha, bundle };
			},
		);
	}

	async #sync(request: CodeGitHubSyncRequest, signal: AbortSignal): Promise<CodeGitHubSyncOutcome> {
		const remoteBranch = request.remoteBranch as string;
		const { remoteSha, bundle } = await this.#fetchRemoteBranchBundle(request, remoteBranch, signal);
		const qorperaRepo = this.#qorperaRepository(request);
		const remoteTrackingRef = `refs/remotes/github/${remoteBranch}`;
		const branchRef = `refs/heads/${remoteBranch}`;

		const stats = await this.#hosts.run(request.companyId, request.environmentId, signal, (job) =>
			withJob(job, qorperaRepo, async (run) => {
				const { mainSha } = await inspectKeptRepo(run);
				if (remoteSha === null || bundle === null) {
					await run.git(run.repo, ["update-ref", "-d", remoteTrackingRef]);
					const aheadRaw = (await run.gitOk(run.repo, ["rev-list", "--count", mainSha], "CODE_HOST_SYNC_FAILED"))
						.toString("latin1")
						.trim();
					return {
						mainSha,
						remoteSha: null as string | null,
						ahead: Number(aheadRaw) || 0,
						behind: 0,
						diverged: false,
					};
				}
				const hasCommit = await run.git(run.repo, ["cat-file", "-e", `${remoteSha}^{commit}`]);
				if (hasCommit.status !== 0) {
					await importBundleIntoRepo(run, bundle, branchRef, remoteSha);
				}
				await run.gitOk(run.repo, ["update-ref", remoteTrackingRef, remoteSha], "CODE_HOST_SYNC_FAILED");
				const lr = (
					await run.gitOk(
						run.repo,
						["rev-list", "--left-right", "--count", `${mainSha}...${remoteSha}`],
						"CODE_HOST_SYNC_FAILED",
					)
				)
					.toString("latin1")
					.trim();
				const [aheadText, behindText] = lr.split(/\s+/);
				const ahead = Number(aheadText ?? "0");
				const behind = Number(behindText ?? "0");
				return {
					mainSha,
					remoteSha,
					ahead,
					behind,
					diverged: ahead > 0 && behind > 0,
				};
			}),
		);

		return {
			schema: SCHEMA,
			state: "done",
			result: "synced",
			githubRepo: request.githubRepo,
			remoteBranch,
			remoteSha: stats.remoteSha,
			mainSha: stats.mainSha,
			ahead: stats.ahead,
			behind: stats.behind,
			diverged: stats.diverged,
		};
	}

	async #pull(request: CodeGitHubSyncRequest, signal: AbortSignal): Promise<CodeGitHubSyncOutcome> {
		const remoteBranch = request.remoteBranch as string;
		const { remoteSha, bundle } = await this.#fetchRemoteBranchBundle(request, remoteBranch, signal);
		if (remoteSha === null || bundle === null) {
			throw new GitHubSyncRefusal(
				"GITHUB_SYNC_REMOTE_BRANCH_MISSING",
				[],
				[`GitHub repository ${request.githubRepo} does not have branch ${remoteBranch}.`],
			);
		}
		const qorperaRepo = this.#qorperaRepository(request);
		const remoteTrackingRef = `refs/remotes/github/${remoteBranch}`;
		const branchRef = `refs/heads/${remoteBranch}`;

		const pulled = await this.#hosts.run(request.companyId, request.environmentId, signal, (job) =>
			withJob(job, qorperaRepo, async (run) => {
				const { area, mainSha } = await inspectKeptRepo(run);
				const hasCommit = await run.git(run.repo, ["cat-file", "-e", `${remoteSha}^{commit}`]);
				if (hasCommit.status !== 0) {
					await importBundleIntoRepo(run, bundle, branchRef, remoteSha);
				}
				await run.gitOk(run.repo, ["update-ref", remoteTrackingRef, remoteSha], "CODE_HOST_SYNC_FAILED");

				const remoteIsAncestor = await run.git(run.repo, ["merge-base", "--is-ancestor", remoteSha, mainSha]);
				if (remoteSha === mainSha || remoteIsAncestor.status === 0) {
					return {
						mainBefore: mainSha,
						mainAfter: mainSha,
						mode: "unchanged" as const,
						commitsPulled: 0,
					};
				}

				const commitsPulledRaw = (
					await run.gitOk(run.repo, ["rev-list", "--count", `${mainSha}..${remoteSha}`], "CODE_HOST_SYNC_FAILED")
				)
					.toString("latin1")
					.trim();
				const commitsPulled = Number(commitsPulledRaw) || 0;

				const mainIsAncestor = await run.git(run.repo, ["merge-base", "--is-ancestor", mainSha, remoteSha]);
				if (mainIsAncestor.status === 0) {
					const records = await run.checkNames(run.repo, remoteSha);
					const refused = codeFolderRefuses(run.area, records, CODE_FOLDER_ANY_SESSION);
					if (refused.length) throw new CodeHostRefusal("CODE_HOST_NAMES_FOLDER_REFUSES", refused);
					await moveBase(run, area.main, "refs/heads/main", remoteSha, mainSha);
					return {
						mainBefore: mainSha,
						mainAfter: remoteSha,
						mode: "fast-forward" as const,
						commitsPulled,
					};
				}

				const merged = await run.git(run.repo, [
					"merge-tree",
					"--write-tree",
					"-z",
					"--name-only",
					"--messages",
					mainSha,
					remoteSha,
				]);
				if (merged.status === 1) {
					const conflict = parseMergeTreeConflict(merged.stdout);
					throw new GitHubSyncRefusal("GITHUB_SYNC_CONFLICT", conflict.paths, conflict.messages);
				}
				const fields = merged.stdout.toString("utf8").split("\0");
				const tree = fields[0] ?? "";
				if (merged.status !== 0 || !SHA.test(tree)) {
					throw new CodeHostJobFailure("CODE_HOST_SYNC_FAILED", tail(merged.stderr));
				}
				const mergeCommit = (
					await run.gitOk(
						run.repo,
						[
							...PLATFORM_COMMITTER,
							"commit-tree",
							tree,
							"-p",
							mainSha,
							"-p",
							remoteSha,
							"-m",
							`Merge ${remoteBranch} from ${request.githubRepo}`,
						],
						"CODE_HOST_SYNC_FAILED",
					)
				)
					.toString("latin1")
					.trim();
				if (!SHA.test(mergeCommit)) throw new CodeHostJobFailure("CODE_HOST_SYNC_FAILED", "no merge commit");
				const records = await run.checkNames(run.repo, mergeCommit);
				const refused = codeFolderRefuses(run.area, records, CODE_FOLDER_ANY_SESSION);
				if (refused.length) throw new CodeHostRefusal("CODE_HOST_NAMES_FOLDER_REFUSES", refused);
				await moveBase(run, area.main, "refs/heads/main", mergeCommit, mainSha);
				return {
					mainBefore: mainSha,
					mainAfter: mergeCommit,
					mode: "merged" as const,
					commitsPulled,
				};
			}),
		);

		return {
			schema: SCHEMA,
			state: "done",
			result: "pulled",
			githubRepo: request.githubRepo,
			remoteBranch,
			mainBefore: pulled.mainBefore,
			mainAfter: pulled.mainAfter,
			remoteSha,
			mode: pulled.mode,
			commitsPulled: pulled.commitsPulled,
		};
	}

	async #exportLocalBundle(
		request: CodeGitHubSyncRequest,
		localRef: string,
		remoteBranch: string,
		signal: AbortSignal,
	): Promise<{ readonly headSha: string; readonly bundle: Buffer }> {
		const qorperaRepo = this.#qorperaRepository(request);
		const targetRef = `refs/heads/${remoteBranch}`;
		return this.#hosts.run(
			request.companyId,
			request.environmentId,
			signal,
			(job) =>
				withJob(job, qorperaRepo, async (run) => {
					await inspectKeptRepo(run);
					const resolved = await run.git(run.repo, ["rev-parse", "--verify", `${localRef}^{commit}`]);
					const headSha = resolved.stdout.toString("latin1").trim();
					if (resolved.status !== 0 || !SHA.test(headSha)) {
						throw new CodeHostRefusal("CODE_HOST_REF_NOT_FOUND", [localRef]);
					}
					const scratch = `${run.directory}/export.git`;
					await run.gitOk(
						scratch,
						["init", "--quiet", "--bare", "--template=", "--ref-format=files", scratch],
						"CODE_HOST_SYNC_FAILED",
					);
					const alt = await run.sh('printf "%s\\n" "$2" >"$1"', [
						`${scratch}/objects/info/alternates`,
						`${run.repo}/objects`,
					]);
					if (alt.status !== 0) throw new CodeHostJobFailure("CODE_HOST_SYNC_FAILED", tail(alt.stderr));
					await run.gitOk(scratch, ["update-ref", targetRef, headSha], "CODE_HOST_SYNC_FAILED");
					const bundleFile = `${run.directory}/push.bundle`;
					await run.gitOk(
						scratch,
						["bundle", "create", "--quiet", bundleFile, targetRef],
						"CODE_HOST_SYNC_FAILED",
					);
					const measured = await run.sh('sha256sum <"$1" && exec wc -c <"$1"', [bundleFile]);
					const [, sha256, bytesText] =
						/^([0-9a-f]{64}) [ *]-\n *(\d+)\n$/.exec(measured.stdout.toString("latin1")) ?? [];
					const bytes = Number(bytesText);
					if (measured.status !== 0 || !sha256 || !Number.isSafeInteger(bytes) || bytes < 1) {
						throw new CodeHostJobFailure("CODE_HOST_SYNC_FAILED", tail(measured.stderr));
					}
					if (bytes > MAX_SYNC_BUNDLE_BYTES) {
						throw new GitHubSyncRefusal(
							"GITHUB_SYNC_BUNDLE_TOO_LARGE",
							[],
							["The exported push bundle exceeds the 128 MB sync limit."],
						);
					}
					const chunks: Buffer[] = [];
					await streamFileOut(
						run,
						bundleFile,
						bytes,
						sha256,
						4 * 1024 ** 2,
						async (piece) => {
							chunks.push(piece);
						},
						"CODE_HOST_SYNC_FAILED",
						"bundle stream checksum mismatch",
					);
					const bundle = Buffer.concat(chunks);
					if (createHash("sha256").update(bundle).digest("hex") !== sha256) {
						throw new CodeHostJobFailure("CODE_HOST_SYNC_FAILED", "bundle checksum mismatch");
					}
					return { headSha, bundle };
				}),
			{ readOnly: true },
		);
	}

	async #scanForSecrets(
		runLocal: (
			args: readonly string[],
			long?: boolean,
			stream?: { readonly input?: Uint8Array; readonly output: CodingBrokerGitOutput },
		) => Promise<string>,
		headSha: string,
		previousRemoteSha: string | null,
		signal: AbortSignal,
	): Promise<void> {
		signal.throwIfAborted();
		const rangeArgs = previousRemoteSha
			? ["rev-list", "--objects", headSha, `^${previousRemoteSha}`]
			: ["rev-list", "--objects", headSha];
		const listChunks: Buffer[] = [];
		await runLocal(rangeArgs, true, {
			output: {
				limit: 16 * 1024 ** 2,
				write(chunk) {
					listChunks.push(chunk);
				},
			},
		});
		const objectsOut = Buffer.concat(listChunks).toString("utf8");
		const flaggedPaths: string[] = [];
		const candidates: { readonly oid: string; readonly path: string }[] = [];
		const seenOids = new Set<string>();
		for (const line of objectsOut.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			const space = trimmed.indexOf(" ");
			if (space < 40) continue;
			const oid = trimmed.slice(0, 40);
			const path = trimmed.slice(space + 1);
			if (!SHA.test(oid) || !path) continue;
			if (/(^|\/)\.env(?:\.[^/]+)?$/i.test(path) && !/\.(?:example|sample|template)$/i.test(path)) {
				flaggedPaths.push(path);
				continue;
			}
			if (seenOids.has(oid)) continue;
			seenOids.add(oid);
			candidates.push({ oid, path });
		}
		if (candidates.length > 0) {
			const batchInput = Buffer.from(candidates.map((entry) => `${entry.oid}\n`).join(""), "utf8");
			let index = 0;
			let header = Buffer.alloc(0);
			let current: { readonly type: string; readonly size: number; left: number; chunks: Buffer[] } | null = null;
			let closing = false;
			let scannedBytes = 0;
			const LF = 0x0a;
			try {
				await runLocal(["cat-file", "--batch"], true, {
					input: batchInput,
					output: {
						limit: MAX_SCAN_BYTES * 2,
						write(chunk) {
							for (let at = 0; at < chunk.length; ) {
								if (closing) {
									if (chunk[at] === LF) at++;
									closing = false;
									index++;
									continue;
								}
								if (current === null) {
									const end = chunk.indexOf(LF, at);
									header = Buffer.concat([header, chunk.subarray(at, end < 0 ? chunk.length : end)]);
									if (header.length > 160) throw new Error("SCAN_HEADER_OVERFLOW");
									if (end < 0) return;
									at = end + 1;
									const lineText = header.toString("latin1");
									header = Buffer.alloc(0);
									const match = /^([0-9a-f]{40}) (blob|tree|commit|tag) ([0-9]{1,12})$/.exec(lineText);
									if (!match) {
										index++;
										continue;
									}
									const size = Number(match[3]);
									current = { type: match[2], size, left: size, chunks: [] };
								} else {
									const take = Math.min(current.left, chunk.length - at);
									if (
										current.type === "blob" &&
										current.size <= 64 * 1024 &&
										scannedBytes + current.size <= MAX_SCAN_BYTES
									) {
										current.chunks.push(chunk.subarray(at, at + take));
									}
									current.left -= take;
									at += take;
								}
								if (current.left > 0) continue;
								if (current.type === "blob" && current.chunks.length > 0) {
									scannedBytes += current.size;
									const text = Buffer.concat(current.chunks).toString("utf8");
									if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) {
										const candidate = candidates[index];
										if (candidate) flaggedPaths.push(candidate.path);
									}
								}
								current = null;
								closing = true;
							}
						},
					},
				});
			} catch (error) {
				if (flaggedPaths.length === 0) throw error;
			}
		}
		if (flaggedPaths.length > 0) {
			throw new GitHubSyncRefusal("GITHUB_SYNC_SECRET_DETECTED", [...new Set(flaggedPaths)].slice(0, 20), [
				"Potential secret material or .env file detected in commits being pushed; remove it before pushing.",
			]);
		}
	}

	async #push(request: CodeGitHubSyncRequest, signal: AbortSignal): Promise<CodeGitHubSyncOutcome> {
		const remoteBranch = request.remoteBranch as string;
		const localRef = request.localRef as string;
		const branchRef = `refs/heads/${remoteBranch}`;
		const { headSha, bundle } = await this.#exportLocalBundle(request, localRef, remoteBranch, signal);

		const pushed = await this.#withBrokerScratch(
			request,
			remoteBranch,
			signal,
			async ({ scratch, remote, runLocal, runNetwork }) => {
				const lsOut = await runNetwork(["ls-remote", "--symref", remote, "HEAD", branchRef]);
				const { defaultBranch, branchSha: previousRemoteSha } = parseLsRemoteOutput(lsOut, branchRef);
				if (defaultBranch && defaultBranch === remoteBranch && !request.allowDefaultBranch) {
					throw new GitHubSyncRefusal(
						"GITHUB_SYNC_DEFAULT_BRANCH_PROTECTED",
						[],
						[
							`Pushing directly to GitHub's default branch (${defaultBranch}) is blocked unless allowDefaultBranch is true.`,
						],
					);
				}

				const bundlePath = join(scratch, "push.bundle");
				await writeFile(bundlePath, bundle, { flag: "wx", mode: 0o600 });
				await runLocal(["bundle", "verify", bundlePath]);
				await runLocal(["bundle", "unbundle", bundlePath]);
				await runLocal(["fsck", "--strict", "--no-reflogs", "--no-dangling", headSha], true);

				if (previousRemoteSha === headSha) {
					return { previousRemoteSha, created: false };
				}

				if (previousRemoteSha !== null) {
					await runNetwork(
						[
							"fetch",
							"--quiet",
							"--no-tags",
							"--no-recurse-submodules",
							"--no-write-fetch-head",
							remote,
							`${branchRef}:refs/qorpera/remote-head`,
						],
						true,
					);
					try {
						await runLocal(["merge-base", "--is-ancestor", previousRemoteSha, headSha]);
					} catch {
						throw new GitHubSyncRefusal(
							"GITHUB_SYNC_NON_FAST_FORWARD",
							[],
							[
								`Remote branch ${remoteBranch} on ${request.githubRepo} has commits not in ${localRef}; pull or rebase before pushing.`,
							],
						);
					}
				}

				await this.#scanForSecrets(runLocal, headSha, previousRemoteSha, signal);

				await runNetwork(
					["push", "--porcelain", "--no-verify", "--recurse-submodules=no", remote, `${headSha}:${branchRef}`],
					true,
				);

				return { previousRemoteSha, created: previousRemoteSha === null };
			},
		);

		return {
			schema: SCHEMA,
			state: "done",
			result: "pushed",
			githubRepo: request.githubRepo,
			localRef,
			remoteBranch,
			headSha,
			previousRemoteSha: pushed.previousRemoteSha,
			created: pushed.created,
		};
	}

	async #createPr(request: CodeGitHubSyncRequest, signal: AbortSignal): Promise<CodeGitHubSyncOutcome> {
		const headBranch = request.headBranch as string;
		const baseBranch = request.baseBranch as string;
		const title = request.title as string;
		const ghRepo = this.#githubRepository(request, baseBranch);
		const scope = {
			companyId: request.companyId,
			workerId: request.requestId,
			leaseToken: request.token,
		};

		const created = await this.#credentials.withRepositoryToken(
			scope,
			ghRepo,
			async (token) => {
				if (!GITHUB_TOKEN_PATTERN.test(token)) {
					throw new GitHubSyncRefusal("GITHUB_SYNC_AUTH_REFUSED", [], ["GitHub token is unavailable."]);
				}
				const url = `${GITHUB_API_ORIGIN}/repos/${encodeURIComponent(request.githubOwner)}/${encodeURIComponent(request.githubName)}/pulls`;
				const headers = {
					authorization: `Bearer ${token}`,
					accept: "application/vnd.github+json",
					"x-github-api-version": GITHUB_API_VERSION,
					"user-agent": "qorpera-github-sync",
				};
				const response = await this.#fetch(url, {
					method: "POST",
					redirect: "error",
					signal,
					headers: {
						...headers,
						"content-type": "application/json",
					},
					body: JSON.stringify({
						title,
						head: headBranch,
						base: baseBranch,
						...(request.body !== undefined ? { body: request.body } : {}),
						draft: request.draft === true,
					}),
				});
				const text = await readBoundedResponseText(response, MAX_PR_RESPONSE_BYTES);
				if (response.status === 422) {
					const detail = extractGitHubErrorMessage(text) ?? "GitHub rejected pull request creation.";
					if (/already exists/i.test(detail) || /already exists/i.test(text)) {
						try {
							const lookupUrl = `${url}?state=open&head=${encodeURIComponent(`${request.githubOwner}:${headBranch}`)}&base=${encodeURIComponent(baseBranch)}&per_page=1`;
							const existingResponse = await this.#fetch(lookupUrl, {
								method: "GET",
								redirect: "error",
								signal,
								headers,
							});
							if (existingResponse.status >= 200 && existingResponse.status < 300) {
								const existingText = await readBoundedResponseText(existingResponse, MAX_PR_RESPONSE_BYTES);
								const existingParsed = JSON.parse(existingText) as unknown;
								if (Array.isArray(existingParsed) && existingParsed.length > 0) {
									return parseGitHubPullRequest(existingParsed[0], { headBranch, baseBranch, title });
								}
							}
						} catch (lookupError) {
							if (signal.aborted) throw lookupError;
						}
					}
					throw new GitHubSyncRefusal("GITHUB_SYNC_PR_REFUSED", [], [detail]);
				}
				if (response.status === 401 || response.status === 403) {
					const detail = extractGitHubErrorMessage(text) ?? "GitHub refused access for pull request creation.";
					throw new GitHubSyncRefusal("GITHUB_SYNC_AUTH_REFUSED", [], [detail]);
				}
				if (response.status === 404) {
					throw new GitHubSyncRefusal(
						"GITHUB_SYNC_REPO_NOT_FOUND",
						[],
						[`GitHub repository ${request.githubRepo} was not found or is inaccessible.`],
					);
				}
				if (response.status < 200 || response.status >= 300) {
					throw new Error(`GITHUB_SYNC_HTTP_${response.status}`);
				}
				const parsed = JSON.parse(text) as unknown;
				return parseGitHubPullRequest(parsed, { headBranch, baseBranch, title });
			},
			signal,
		);

		return {
			schema: SCHEMA,
			state: "done",
			result: "pr_created",
			githubRepo: request.githubRepo,
			number: created.number,
			url: created.url,
			prState: created.prState,
			headBranch: created.headBranch,
			baseBranch: created.baseBranch,
			title: created.title,
			headSha: created.headSha,
			draft: created.draft,
			updatedAt: created.updatedAt,
			...(request.sessionId ? { sessionId: request.sessionId } : {}),
		};
	}
}
