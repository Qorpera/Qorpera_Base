import type { JsonValue } from "@qorpera/contracts";
import { type ConnectorOperationContext, defineConnectorAdapters } from "./cloud-connector-adapter.ts";
import { cloudConnector } from "./cloud-connector-catalog.ts";
import {
	ConnectorRequestError,
	type ConnectorResponse,
	clipText,
	codePointCount,
	connectorRequest,
	decodeUtf8,
	fitItems,
	jsonArray,
	jsonBoolean,
	jsonInteger,
	jsonRecord,
	jsonString,
	parseJsonResponse,
	providerRefusal,
} from "./cloud-connector-http.ts";
import type { CloudSecretConnectorAdapter } from "./cloud-secret-broker.ts";

/**
 * Compiled GitHub adapter: REST v3 on api.github.com with the connected
 * account's token as a bearer. Each operation reduces the provider payload to
 * the few fields an agent needs; bodies are shortened so a result fits the
 * tool-result budget.
 */

export const GITHUB_API_VERSION = "2022-11-28";
const BODY_CHARS = 4000;
const COMMENT_CHARS = 1200;
const COMMENT_BUDGET_CHARS = 3600;
const FILE_CHARS = 6000;
// Byte budgets under the broker's 32 KiB result limit (CONNECTOR_RESULT_MAX_BYTES).
const BODY_BYTES = 12 * 1024;
const COMMENT_BYTES = 4 * 1024;
const FILE_BYTES = 16 * 1024;
const LIST_BYTES = 24 * 1024;
// A pull request's changed-file list shares the result with a body of up to BODY_BYTES.
const PULL_FILES_BYTES = 12 * 1024;
const MAX_FILE_BYTES = 96 * 1024;
const OWNER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}$/;
const BRANCH_REF = /^[A-Za-z0-9][A-Za-z0-9._/:-]{0,255}$/;

function headers(context: ConnectorOperationContext, extra: Record<string, string> = {}): Record<string, string> {
	return {
		authorization: `Bearer ${context.bearer}`,
		accept: "application/vnd.github+json",
		"x-github-api-version": GITHUB_API_VERSION,
		"user-agent": "qorpera-cloud-connector",
		...extra,
	};
}

function gitRefValue(value: unknown, label: string): string {
	const text = typeof value === "string" ? value.trim() : "";
	if (
		!text ||
		!BRANCH_REF.test(text) ||
		text.includes("..") ||
		text.includes("//") ||
		text.startsWith("/") ||
		text.endsWith("/") ||
		text.endsWith(".") ||
		text.endsWith(".lock")
	) {
		throw new ConnectorRequestError("invalid_request", `The ${label} is not valid.`);
	}
	return text;
}

function unprocessableRefusal(response: ConnectorResponse): ConnectorRequestError {
	const refusal = providerRefusal(response, "GitHub");
	if (response.status !== 422) return refusal;
	let first: string | null = null;
	try {
		first =
			jsonArray(jsonRecord(parseJsonResponse(response)).errors)
				.map((item) => jsonString(jsonRecord(item).message, 200))
				.find((message): message is string => Boolean(message)) ?? null;
	} catch {
		first = null;
	}
	return first ? new ConnectorRequestError("invalid_request", `GitHub: ${first}`) : refusal;
}

async function github(
	context: ConnectorOperationContext,
	path: string,
	options: {
		query?: Record<string, string | undefined>;
		method?: "GET" | "POST" | "PATCH";
		body?: JsonValue;
	} = {},
): Promise<unknown> {
	const response = await connectorRequest({
		fetch: context.fetch,
		origin: context.origin,
		path,
		query: options.query,
		method: options.method ?? "GET",
		headers: headers(context, options.body === undefined ? {} : { "content-type": "application/json" }),
		...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
		signal: context.signal,
		keepHeaders: ["x-ratelimit-remaining"],
	});
	if (response.status < 200 || response.status >= 300) throw unprocessableRefusal(response);
	return parseJsonResponse(response);
}

function repositoryPath(args: Record<string, JsonValue>): string {
	const owner = String(args.owner);
	const repository = String(args.repository);
	if (!OWNER.test(owner) || !REPOSITORY.test(repository) || repository === "." || repository === "..") {
		throw new ConnectorRequestError("invalid_request", "The repository name is not valid.");
	}
	return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
}

function repositoryFromUrl(value: unknown): string | null {
	const url = jsonString(value, 512);
	const matched = url ? /\/repos\/([^/]+)\/([^/]+)$/.exec(url) : null;
	return matched ? `${matched[1]}/${matched[2]}` : null;
}

function user(value: unknown): string | null {
	return jsonString(jsonRecord(value).login, 64);
}

function labels(value: unknown): string[] {
	return jsonArray(value)
		.map((label) => (typeof label === "string" ? label : jsonString(jsonRecord(label).name, 64)))
		.filter((label): label is string => label !== null)
		.slice(0, 20);
}

function issueSummary(item: unknown): JsonValue {
	const issue = jsonRecord(item);
	return {
		number: jsonInteger(issue.number),
		title: jsonString(issue.title, 256),
		state: jsonString(issue.state, 16),
		repository: repositoryFromUrl(issue.repository_url),
		is_pull_request: Object.hasOwn(issue, "pull_request"),
		author: user(issue.user),
		labels: labels(issue.labels),
		comments: jsonInteger(issue.comments),
		created_at: jsonString(issue.created_at, 40),
		updated_at: jsonString(issue.updated_at, 40),
		url: jsonString(issue.html_url, 512),
	};
}

function limit(value: JsonValue | undefined, fallback: number): string {
	return String(jsonInteger(value) ?? fallback);
}

/** What the agent can relay when the connection's token may not create repositories: an OAuth token without the
 * `repo` scope, a fine-grained token without Administration write, a GitHub App without that permission. */
export const GITHUB_CREATE_REPOSITORY_PERMISSION =
	"the GitHub connection needs to be connected again with permission to create repositories";

/** GitHub's refusal of a new repository, in words the agent can relay. */
function repositoryRefusal(response: ConnectorResponse, organization: string | null): ConnectorRequestError {
	const refusal = providerRefusal(response, "GitHub");
	if (response.status === 422) {
		// "Repository creation failed." says less than its first error: "name already exists on this account".
		let first: string | null = null;
		try {
			first =
				jsonArray(jsonRecord(parseJsonResponse(response)).errors)
					.map((item) => jsonString(jsonRecord(item).message, 200))
					.find((message): message is string => Boolean(message)) ?? null;
		} catch {
			first = null;
		}
		return first ? new ConnectorRequestError("invalid_request", `GitHub: ${first}`) : refusal;
	}
	if (refusal.reason !== "forbidden" && refusal.reason !== "not_found") return refusal;
	// Without an organization the endpoint always exists, so either answer means the token may not create one.
	if (!organization)
		return new ConnectorRequestError(
			"forbidden",
			`GitHub refused to create the repository: ${GITHUB_CREATE_REPOSITORY_PERMISSION} (${refusal.message}).`,
		);
	if (refusal.reason === "not_found")
		return new ConnectorRequestError(
			"not_found",
			`GitHub found no organization ${organization} the connected account can create repositories in. Check the name, or leave owner out to create it in the connected account.`,
		);
	return new ConnectorRequestError(
		"forbidden",
		`GitHub refused a new repository in ${organization}: an owner of that organization must allow it, or ${GITHUB_CREATE_REPOSITORY_PERMISSION}.`,
	);
}

export function createGitHubConnectorAdapters(
	fetchImplementation: typeof fetch = fetch,
): readonly CloudSecretConnectorAdapter[] {
	return defineConnectorAdapters(cloudConnector("github"), {
		fetch: fetchImplementation,
		exchange: async (credential) => {
			if (!/^[A-Za-z0-9_]{20,255}$/.test(credential)) throw new Error("GitHub credential shape is invalid");
			return credential;
		},
		handlers: {
			async list_repositories(args, context) {
				const items = jsonArray(
					await github(context, "/user/repos", {
						query: {
							sort: "updated",
							affiliation: "owner,collaborator,organization_member",
							per_page: jsonString(args.query) ? "100" : limit(args.limit, 20),
						},
					}),
				);
				const query = jsonString(args.query, 200)?.toLowerCase();
				const repositories = items
					.map((item) => jsonRecord(item))
					.filter(
						(repository) =>
							!query ||
							(jsonString(repository.full_name, 200) ?? "").toLowerCase().includes(query) ||
							(jsonString(repository.description, 1024) ?? "").toLowerCase().includes(query),
					)
					.slice(0, jsonInteger(args.limit) ?? 20)
					.map((repository) => ({
						full_name: jsonString(repository.full_name, 200),
						private: jsonBoolean(repository.private),
						description: jsonString(repository.description, 300),
						default_branch: jsonString(repository.default_branch, 128),
						open_issues: jsonInteger(repository.open_issues_count),
						updated_at: jsonString(repository.updated_at, 40),
						url: jsonString(repository.html_url, 512),
					}));
				const fitted = fitItems(repositories, LIST_BYTES);
				return {
					repositories: fitted.items,
					filtered_by: query ?? null,
					...(fitted.omitted > 0 ? { repositories_omitted: fitted.omitted } : {}),
				};
			},
			async search_issues(args, context) {
				const payload = jsonRecord(
					await github(context, "/search/issues", {
						query: { q: String(args.query), per_page: limit(args.limit, 20) },
					}),
				);
				const fitted = fitItems(jsonArray(payload.items).map(issueSummary), LIST_BYTES);
				return {
					total_count: jsonInteger(payload.total_count),
					items: fitted.items,
					...(fitted.omitted > 0 ? { items_omitted: fitted.omitted } : {}),
				};
			},
			async get_issue(args, context) {
				const base = `${repositoryPath(args)}/issues/${jsonInteger(args.number)}`;
				const issue = jsonRecord(await github(context, base));
				const commentLimit = jsonInteger(args.comment_limit) ?? 10;
				const comments =
					commentLimit > 0
						? jsonArray(await github(context, `${base}/comments`, { query: { per_page: String(commentLimit) } }))
						: [];
				const body = clipText(typeof issue.body === "string" ? issue.body : "", BODY_CHARS, BODY_BYTES);
				// Comments share one text budget so the whole result stays readable
				// inside the tool-result size the model receives.
				let budget = COMMENT_BUDGET_CHARS;
				const included: JsonValue[] = [];
				for (const item of comments) {
					if (budget <= 0) break;
					const comment = jsonRecord(item);
					const text = clipText(
						typeof comment.body === "string" ? comment.body : "",
						Math.min(COMMENT_CHARS, budget),
						COMMENT_BYTES,
					);
					budget -= codePointCount(text.text);
					included.push({
						author: user(comment.user),
						created_at: jsonString(comment.created_at, 40),
						body: text.text,
						body_truncated: text.truncated,
					});
				}
				return {
					...(issueSummary(issue) as Record<string, JsonValue>),
					body: body.text,
					body_truncated: body.truncated,
					assignees: jsonArray(issue.assignees).map(user),
					milestone: jsonString(jsonRecord(issue.milestone).title, 128),
					comments_included: included,
					comments_omitted: Math.max(0, comments.length - included.length),
				};
			},
			async create_issue(args, context) {
				const created = jsonRecord(
					await github(context, `${repositoryPath(args)}/issues`, {
						method: "POST",
						body: {
							title: String(args.title),
							...(typeof args.body === "string" ? { body: args.body } : {}),
							...(Array.isArray(args.labels) ? { labels: args.labels } : {}),
						},
					}),
				);
				return {
					number: jsonInteger(created.number),
					url: jsonString(created.html_url, 512),
					state: jsonString(created.state, 16),
				};
			},
			async create_issue_comment(args, context) {
				const created = jsonRecord(
					await github(context, `${repositoryPath(args)}/issues/${jsonInteger(args.number)}/comments`, {
						method: "POST",
						body: { body: String(args.body) },
					}),
				);
				return {
					comment_id: jsonInteger(created.id),
					url: jsonString(created.html_url, 512),
					created_at: jsonString(created.created_at, 40),
				};
			},
			async create_repository(args, context) {
				const name = String(args.name);
				const owner = jsonString(args.owner, 64);
				if (!REPOSITORY.test(name) || name === "." || name === ".." || (owner !== null && !OWNER.test(owner))) {
					throw new ConnectorRequestError("invalid_request", "The repository name is not valid.");
				}
				// An owner that is the connected account's own login is the account itself, not an organization.
				let organization: string | null = null;
				if (owner !== null) {
					const login = jsonString(jsonRecord(await github(context, "/user")).login, 64);
					if (login?.toLowerCase() !== owner.toLowerCase()) organization = owner;
				}
				const response = await connectorRequest({
					fetch: context.fetch,
					origin: context.origin,
					path: organization ? `/orgs/${encodeURIComponent(organization)}/repos` : "/user/repos",
					method: "POST",
					headers: headers(context, { "content-type": "application/json" }),
					body: JSON.stringify({
						name,
						// Private unless the call says false; a public one went through the review's access check.
						private: args.private !== false,
						auto_init: args.auto_init !== false,
						...(typeof args.description === "string" ? { description: args.description } : {}),
					}),
					signal: context.signal,
					keepHeaders: ["x-ratelimit-remaining"],
				});
				if (response.status < 200 || response.status >= 300) throw repositoryRefusal(response, organization);
				const created = jsonRecord(parseJsonResponse(response));
				return {
					full_name: jsonString(created.full_name, 200),
					private: jsonBoolean(created.private),
					default_branch: jsonString(created.default_branch, 128),
					url: jsonString(created.html_url, 512),
					clone_url: jsonString(created.clone_url, 512),
					created_at: jsonString(created.created_at, 40),
				};
			},
			async read_file(args, context): Promise<JsonValue> {
				const path = String(args.path);
				if (path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
					throw new ConnectorRequestError("invalid_request", "The file path is not valid.");
				}
				const encodedPath = path.split("/").map(encodeURIComponent).join("/");
				const payload = await github(context, `${repositoryPath(args)}/contents/${encodedPath}`, {
					query: { ref: jsonString(args.ref, 256) ?? undefined },
				});
				if (Array.isArray(payload)) {
					const entries: JsonValue[] = payload.slice(0, 200).map((item) => ({
						name: jsonString(jsonRecord(item).name, 256),
						type: jsonString(jsonRecord(item).type, 16),
						size: jsonInteger(jsonRecord(item).size),
					}));
					return { path, type: "directory", entries };
				}
				const file = jsonRecord(payload);
				const size = jsonInteger(file.size) ?? 0;
				const metadata: Record<string, JsonValue> = {
					path: jsonString(file.path, 1024) ?? path,
					type: jsonString(file.type, 16),
					size,
					sha: jsonString(file.sha, 64),
					url: jsonString(file.html_url, 512),
				};
				if (file.type !== "file" || file.encoding !== "base64" || typeof file.content !== "string") {
					return { ...metadata, content: null, content_omitted: "not_a_text_file" };
				}
				if (size > MAX_FILE_BYTES) return { ...metadata, content: null, content_omitted: "too_large" };
				let text: string;
				try {
					text = decodeUtf8(Buffer.from(file.content.replace(/\s+/g, ""), "base64"));
				} catch {
					return { ...metadata, content: null, content_omitted: "binary" };
				}
				const clipped = clipText(text, FILE_CHARS, FILE_BYTES);
				return { ...metadata, content: clipped.text, content_truncated: clipped.truncated };
			},
			async get_pull_request(args, context) {
				const base = `${repositoryPath(args)}/pulls/${jsonInteger(args.number)}`;
				const pull = jsonRecord(await github(context, base));
				const files = jsonArray(await github(context, `${base}/files`, { query: { per_page: "50" } }));
				const body = clipText(jsonString(pull.body, 100_000) ?? "", BODY_CHARS, BODY_BYTES);
				const changedFiles = fitItems(
					files.map((item) => {
						const file = jsonRecord(item);
						return {
							filename: jsonString(file.filename, 1024),
							status: jsonString(file.status, 16),
							additions: jsonInteger(file.additions),
							deletions: jsonInteger(file.deletions),
						};
					}),
					PULL_FILES_BYTES,
				);
				return {
					number: jsonInteger(pull.number),
					title: jsonString(pull.title, 256),
					state: jsonString(pull.state, 16),
					draft: jsonBoolean(pull.draft),
					merged: jsonBoolean(pull.merged),
					mergeable_state: jsonString(pull.mergeable_state, 32),
					author: user(pull.user),
					head: jsonString(jsonRecord(pull.head).ref, 256),
					base: jsonString(jsonRecord(pull.base).ref, 256),
					body: body.text,
					body_truncated: body.truncated,
					commits: jsonInteger(pull.commits),
					additions: jsonInteger(pull.additions),
					deletions: jsonInteger(pull.deletions),
					changed_files: jsonInteger(pull.changed_files),
					created_at: jsonString(pull.created_at, 40),
					updated_at: jsonString(pull.updated_at, 40),
					url: jsonString(pull.html_url, 512),
					files: changedFiles.items,
					...(changedFiles.omitted > 0 ? { files_omitted: changedFiles.omitted } : {}),
				};
			},
			async list_pull_requests(args, context) {
				const state = jsonString(args.state, 16) ?? "open";
				const head = args.head === undefined ? undefined : gitRefValue(args.head, "head branch");
				const base = args.base === undefined ? undefined : gitRefValue(args.base, "base branch");
				const items = jsonArray(
					await github(context, `${repositoryPath(args)}/pulls`, {
						query: {
							state,
							...(head ? { head } : {}),
							...(base ? { base } : {}),
							per_page: limit(args.limit, 20),
						},
					}),
				);
				const pulls = items.map((item) => {
					const pull = jsonRecord(item);
					const headObj = jsonRecord(pull.head);
					const baseObj = jsonRecord(pull.base);
					return {
						number: jsonInteger(pull.number),
						title: jsonString(pull.title, 256),
						state: jsonString(pull.state, 16),
						draft: jsonBoolean(pull.draft),
						author: user(pull.user),
						head: jsonString(headObj.ref, 256),
						head_sha: jsonString(headObj.sha, 64),
						base: jsonString(baseObj.ref, 256),
						labels: labels(pull.labels),
						created_at: jsonString(pull.created_at, 40),
						updated_at: jsonString(pull.updated_at, 40),
						url: jsonString(pull.html_url, 512),
					};
				});
				const fitted = fitItems(pulls, LIST_BYTES);
				return {
					pull_requests: fitted.items,
					...(fitted.omitted > 0 ? { pull_requests_omitted: fitted.omitted } : {}),
				};
			},
			async create_pull_request(args, context) {
				const head = gitRefValue(args.head, "head branch");
				const base = gitRefValue(args.base, "base branch");
				const created = jsonRecord(
					await github(context, `${repositoryPath(args)}/pulls`, {
						method: "POST",
						body: {
							title: String(args.title),
							head,
							base,
							...(typeof args.body === "string" ? { body: args.body } : {}),
							...(typeof args.draft === "boolean" ? { draft: args.draft } : {}),
						},
					}),
				);
				const headObj = jsonRecord(created.head);
				const baseObj = jsonRecord(created.base);
				return {
					number: jsonInteger(created.number),
					title: jsonString(created.title, 256),
					state: jsonString(created.state, 16),
					draft: jsonBoolean(created.draft),
					head: jsonString(headObj.ref, 256),
					head_sha: jsonString(headObj.sha, 64),
					base: jsonString(baseObj.ref, 256),
					url: jsonString(created.html_url, 512),
					created_at: jsonString(created.created_at, 40),
					updated_at: jsonString(created.updated_at, 40),
				};
			},
			async update_pull_request(args, context) {
				const patch: Record<string, JsonValue> = {};
				if (typeof args.title === "string") patch.title = args.title;
				if (typeof args.body === "string") patch.body = args.body;
				if (typeof args.state === "string") patch.state = args.state;
				if (args.base !== undefined) patch.base = gitRefValue(args.base, "base branch");
				if (Object.keys(patch).length === 0) {
					throw new ConnectorRequestError(
						"invalid_request",
						"Provide at least one of title, body, state, or base to update.",
					);
				}
				const updated = jsonRecord(
					await github(context, `${repositoryPath(args)}/pulls/${jsonInteger(args.number)}`, {
						method: "PATCH",
						body: patch,
					}),
				);
				return {
					number: jsonInteger(updated.number),
					title: jsonString(updated.title, 256),
					state: jsonString(updated.state, 16),
					draft: jsonBoolean(updated.draft),
					base: jsonString(jsonRecord(updated.base).ref, 256),
					url: jsonString(updated.html_url, 512),
					updated_at: jsonString(updated.updated_at, 40),
				};
			},
			async list_pull_request_reviews(args, context) {
				const items = jsonArray(
					await github(context, `${repositoryPath(args)}/pulls/${jsonInteger(args.number)}/reviews`, {
						query: { per_page: limit(args.limit, 20) },
					}),
				);
				const reviews = items.map((item) => {
					const review = jsonRecord(item);
					const clipped = clipText(
						typeof review.body === "string" ? review.body : "",
						COMMENT_CHARS,
						COMMENT_BYTES,
					);
					return {
						id: jsonInteger(review.id),
						author: user(review.user),
						state: jsonString(review.state, 32),
						commit_id: jsonString(review.commit_id, 64),
						submitted_at: jsonString(review.submitted_at, 40),
						body: clipped.text,
						body_truncated: clipped.truncated,
						url: jsonString(review.html_url, 512),
					};
				});
				const fitted = fitItems(reviews, LIST_BYTES);
				return {
					reviews: fitted.items,
					...(fitted.omitted > 0 ? { reviews_omitted: fitted.omitted } : {}),
				};
			},
			async list_check_runs(args, context) {
				const ref = gitRefValue(args.ref, "git ref");
				const payload = jsonRecord(
					await github(context, `${repositoryPath(args)}/commits/${encodeURIComponent(ref)}/check-runs`, {
						query: { per_page: limit(args.limit, 30) },
					}),
				);
				const runs = jsonArray(payload.check_runs).map((item) => {
					const run = jsonRecord(item);
					const output = jsonRecord(run.output);
					return {
						id: jsonInteger(run.id),
						name: jsonString(run.name, 200),
						status: jsonString(run.status, 32),
						conclusion: jsonString(run.conclusion, 32),
						head_sha: jsonString(run.head_sha, 64),
						started_at: jsonString(run.started_at, 40),
						completed_at: jsonString(run.completed_at, 40),
						summary_title: jsonString(output.title, 200),
						url: jsonString(run.html_url, 512),
					};
				});
				const fitted = fitItems(runs, LIST_BYTES);
				return {
					total_count: jsonInteger(payload.total_count),
					check_runs: fitted.items,
					...(fitted.omitted > 0 ? { check_runs_omitted: fitted.omitted } : {}),
				};
			},
			async list_branches(args, context) {
				const items = jsonArray(
					await github(context, `${repositoryPath(args)}/branches`, {
						query: { per_page: limit(args.limit, 30) },
					}),
				);
				const branches = items.map((item) => {
					const entry = jsonRecord(item);
					return {
						name: jsonString(entry.name, 256),
						sha: jsonString(jsonRecord(entry.commit).sha, 64),
						protected: jsonBoolean(entry.protected),
					};
				});
				const fitted = fitItems(branches, LIST_BYTES);
				return {
					branches: fitted.items,
					...(fitted.omitted > 0 ? { branches_omitted: fitted.omitted } : {}),
				};
			},
		},
	});
}
