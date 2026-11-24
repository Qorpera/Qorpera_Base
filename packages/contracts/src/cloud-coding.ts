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

export interface CloudCodingPullRequest {
	readonly url: string;
	readonly number: number;
	readonly headSha: string;
}

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

function positive(value: unknown): number {
	if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error("INVALID_CODING_VERSION");
	return value as number;
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
