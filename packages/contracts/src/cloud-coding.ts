import { folderKey } from "./folder-key.ts";

/** Portable coding-worker wire contracts. Parsing grants no repository or VM authority. */

/** Where a coding session's repository is kept. `github.com`: a repository on GitHub, reached through the company's
 * GitHub connection, which a session seeds from and publishes to as a draft pull request. `qorpera`: a repository kept
 * only in the company folder (own code storage, slice 1), at `code/<owner>/<name>/`, which a session starts empty and
 * lands its finished work in, with no account anywhere else. */
export const CLOUD_CODING_REPOSITORY_HOSTS = ["github.com", "qorpera"] as const;
export type CloudCodingRepositoryHost = (typeof CLOUD_CODING_REPOSITORY_HOSTS)[number];

export interface CloudCodingRepository {
	readonly host: CloudCodingRepositoryHost;
	/** On GitHub, the account or organization. In Qorpera, the area of the company folder's code/ that holds it. */
	readonly owner: string;
	readonly name: string;
	readonly baseBranch: string;
}

/** Whether the repository is kept in the company folder only (host `qorpera`), never on GitHub. */
export function cloudCodingRepositoryInQorpera(repository: CloudCodingRepository): boolean {
	return repository.host === "qorpera";
}

export interface CloudCodingDispatch {
	readonly operationKey: string;
	readonly repository: CloudCodingRepository;
	readonly goal: string;
	readonly definitionOfDone: string;
	readonly context: string;
	readonly sourceReadIds: readonly string[];
	readonly todoPath: string;
	readonly cancellationPolicy: "retain-workspace";
	readonly completionPolicy: "notify-parent";
	readonly publication: "draft-pr";
}

export interface CloudCodingFollowup {
	readonly operationKey: string;
	readonly workerId: string;
	readonly expectedVersion: number;
	readonly goal: string;
}

export interface CloudCodingPullRequest {
	readonly url: string;
	readonly number: number;
	readonly headSha: string;
}

export const CLOUD_CODING_WORKER_STATES = [
	"queued",
	"provisioning",
	"ready",
	"running",
	"waiting",
	"completed",
	"failed",
	"cancelled",
	"recovery-required",
] as const;
export type CloudCodingWorkerState = (typeof CLOUD_CODING_WORKER_STATES)[number];

export interface CloudCodingWorker {
	readonly schema: "qorpera.coding-worker/v1";
	readonly id: string;
	readonly companyId: string;
	readonly parentAgentId: string;
	readonly parentRunId: string;
	readonly repository: CloudCodingRepository;
	readonly branch: string;
	readonly vmId: string | null;
	readonly version: number;
	readonly state: CloudCodingWorkerState;
	readonly turn: number;
	readonly pullRequest: CloudCodingPullRequest | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OPERATION_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const encoder = new TextEncoder();

function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).sort().join() !== [...keys].sort().join()
	)
		throw new Error("INVALID_CODING_CONTRACT");
	return value as Record<string, unknown>;
}

function text(value: unknown, maximum: number, empty = false): string {
	if (
		typeof value !== "string" ||
		(!empty && !value.trim()) ||
		/[\ud800-\udfff]/u.test(value) ||
		value.includes("\0") ||
		encoder.encode(value).byteLength > maximum
	)
		throw new Error("INVALID_CODING_TEXT");
	return value;
}

function uuid(value: unknown): string {
	if (typeof value !== "string" || value.length !== 36 || !UUID.test(value)) throw new Error("INVALID_CODING_ID");
	return value;
}

function positive(value: unknown): number {
	if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error("INVALID_CODING_VERSION");
	return value as number;
}

function operationKey(value: unknown): string {
	if (typeof value !== "string" || value !== value.trim() || !OPERATION_KEY.test(value))
		throw new Error("INVALID_CODING_OPERATION_KEY");
	return value;
}

/** A conservative ASCII subset of Git branch refs, never an option or revision expression. */
export function parseCloudCodingBranch(value: unknown): string {
	if (
		typeof value !== "string" ||
		value.length > 200 ||
		value !== value.trim() ||
		!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) ||
		value.includes("..") ||
		value.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock"))
	)
		throw new Error("INVALID_CODING_BRANCH");
	return value;
}

/** The one default branch of every repository kept in Qorpera: one repository, one `main/`, whatever a dispatch says. */
export const CLOUD_CODING_QORPERA_BASE_BRANCH = "main";

/** A repository's identity. On GitHub its owner and name as GitHub allows them. In Qorpera both are lower case, since
 * they name the folder `code/<owner>/<name>/` and the folder tells names apart without case; a name never ends with a
 * dot; and the default branch is always `main`, so one repository has one identity and one `main/`. */
export function parseCloudCodingRepository(value: unknown): CloudCodingRepository {
	const input = closed(value, ["host", "owner", "name", "baseBranch"]);
	const valid =
		input.host === "github.com"
			? typeof input.owner === "string" &&
				/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(input.owner) &&
				typeof input.name === "string" &&
				/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/.test(input.name)
			: input.host === "qorpera" &&
				typeof input.owner === "string" &&
				/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/.test(input.owner) &&
				typeof input.name === "string" &&
				/^[a-z0-9_](?:[a-z0-9_.-]{0,98}[a-z0-9_-])?$/.test(input.name) &&
				input.baseBranch === CLOUD_CODING_QORPERA_BASE_BRANCH;
	if (!valid) throw new Error("INVALID_CODING_REPOSITORY");
	return Object.freeze({
		host: input.host as CloudCodingRepositoryHost,
		owner: input.owner as string,
		name: input.name as string,
		baseBranch: parseCloudCodingBranch(input.baseBranch),
	});
}

/** A repository on GitHub only: every step that reaches GitHub (seed, push, pull request) takes its repository through
 * this, so a repository kept in Qorpera never reaches one. */
export function parseGitHubCodingRepository(value: unknown): CloudCodingRepository & { readonly host: "github.com" } {
	const repository = parseCloudCodingRepository(value);
	if (repository.host !== "github.com") throw new Error("INVALID_CODING_REPOSITORY");
	return repository as CloudCodingRepository & { readonly host: "github.com" };
}

export function parseCloudCodingDispatch(value: unknown): CloudCodingDispatch {
	const input = closed(value, [
		"operationKey",
		"repository",
		"goal",
		"definitionOfDone",
		"context",
		"sourceReadIds",
		"todoPath",
		"cancellationPolicy",
		"completionPolicy",
		"publication",
	]);
	if (
		input.cancellationPolicy !== "retain-workspace" ||
		input.completionPolicy !== "notify-parent" ||
		input.publication !== "draft-pr" ||
		!Array.isArray(input.sourceReadIds) ||
		input.sourceReadIds.length > 64
	)
		throw new Error("INVALID_CODING_DISPATCH");
	const sourceReadIds = input.sourceReadIds.map(uuid);
	if (new Set(sourceReadIds).size !== sourceReadIds.length) throw new Error("INVALID_CODING_SOURCE_READS");
	const todoPath = text(input.todoPath, 4096);
	if (todoPath.normalize("NFC") !== todoPath) throw new Error("INVALID_CODING_TODO_PATH");
	// Matches the Company File path representation outside code/ (a todo is QorperaOS/agents/<handle>/todos/<name>.md); SQL
	// independently checks path authority.
	for (const candidate of [todoPath, folderKey(todoPath)]) {
		if (
			/[\u0000-\u001f\u007f-\u009f\\%]/.test(candidate) ||
			candidate.split("/").length !== todoPath.split("/").length ||
			candidate
				.split("/")
				.some(
					(part) =>
						!part ||
						part === "." ||
						part === ".." ||
						part.includes(":") ||
						/[. ]$/.test(part) ||
						/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)(?:\..*)?$/i.test(part),
				)
		)
			throw new Error("INVALID_CODING_TODO_PATH");
	}
	return Object.freeze({
		operationKey: operationKey(input.operationKey),
		repository: parseCloudCodingRepository(input.repository),
		goal: text(input.goal, 8192),
		definitionOfDone: text(input.definitionOfDone, 8192),
		context: text(input.context, 32768, true),
		sourceReadIds: Object.freeze(sourceReadIds),
		todoPath,
		cancellationPolicy: "retain-workspace",
		completionPolicy: "notify-parent",
		publication: "draft-pr",
	});
}

export function parseCloudCodingFollowup(value: unknown): CloudCodingFollowup {
	const input = closed(value, ["operationKey", "workerId", "expectedVersion", "goal"]);
	return Object.freeze({
		operationKey: operationKey(input.operationKey),
		workerId: uuid(input.workerId),
		expectedVersion: positive(input.expectedVersion),
		goal: text(input.goal, 8192),
	});
}

export function parseCloudCodingPullRequest(value: unknown, repository: CloudCodingRepository): CloudCodingPullRequest {
	const input = closed(value, ["url", "number", "headSha"]);
	const target = parseCloudCodingRepository(repository);
	// A repository kept in Qorpera has no pull request: its work lands in the company folder.
	if (target.host !== "github.com") throw new Error("INVALID_CODING_PULL_REQUEST");
	const number = positive(input.number);
	if (
		input.url !== `https://github.com/${target.owner}/${target.name}/pull/${number}` ||
		typeof input.headSha !== "string" ||
		input.headSha.length !== 40 ||
		!/^[0-9a-f]{40}$/.test(input.headSha)
	)
		throw new Error("INVALID_CODING_PULL_REQUEST");
	return Object.freeze({ url: input.url, number, headSha: input.headSha });
}

export function parseCloudCodingWorker(value: unknown): CloudCodingWorker {
	const input = closed(value, [
		"schema",
		"id",
		"companyId",
		"parentAgentId",
		"parentRunId",
		"repository",
		"branch",
		"vmId",
		"version",
		"state",
		"turn",
		"pullRequest",
	]);
	if (
		input.schema !== "qorpera.coding-worker/v1" ||
		!CLOUD_CODING_WORKER_STATES.includes(input.state as CloudCodingWorkerState)
	)
		throw new Error("INVALID_CODING_WORKER");
	const repository = parseCloudCodingRepository(input.repository);
	const branch = parseCloudCodingBranch(input.branch);
	if (branch === repository.baseBranch) throw new Error("INVALID_CODING_WORKER_BRANCH");
	return Object.freeze({
		schema: "qorpera.coding-worker/v1",
		id: uuid(input.id),
		companyId: uuid(input.companyId),
		parentAgentId: uuid(input.parentAgentId),
		parentRunId: uuid(input.parentRunId),
		repository,
		branch,
		vmId: input.vmId === null ? null : uuid(input.vmId),
		version: positive(input.version),
		state: input.state as CloudCodingWorkerState,
		turn: positive(input.turn),
		pullRequest: input.pullRequest === null ? null : parseCloudCodingPullRequest(input.pullRequest, repository),
	});
}
