import type { JsonValue } from "@qorpera/contracts";
import { type ConnectorOperationContext, defineConnectorAdapters } from "./cloud-connector-adapter.ts";
import { cloudConnector } from "./cloud-connector-catalog.ts";
import {
	ConnectorRequestError,
	clipText,
	connectorRequest,
	decodeUtf8,
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
const MAX_FILE_BYTES = 96 * 1024;
const OWNER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}$/;

function headers(context: ConnectorOperationContext, extra: Record<string, string> = {}): Record<string, string> {
	return {
		authorization: `Bearer ${context.bearer}`,
		accept: "application/vnd.github+json",
		"x-github-api-version": GITHUB_API_VERSION,
		"user-agent": "qorpera-cloud-connector",
		...extra,
	};
}

async function github(
	context: ConnectorOperationContext,
	path: string,
	options: {
		query?: Record<string, string | undefined>;
		method?: "GET" | "POST";
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
	if (response.status < 200 || response.status >= 300) throw providerRefusal(response, "GitHub");
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
				return { repositories, filtered_by: query ?? null };
			},
			async search_issues(args, context) {
				const payload = jsonRecord(
					await github(context, "/search/issues", {
						query: { q: String(args.query), per_page: limit(args.limit, 20) },
					}),
				);
				return {
					total_count: jsonInteger(payload.total_count),
					items: jsonArray(payload.items).map(issueSummary),
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
				const body = clipText(jsonString(issue.body, 100_000) ?? "", BODY_CHARS);
				// Comments share one text budget so the whole result stays readable
				// inside the tool-result size the model receives.
				let budget = COMMENT_BUDGET_CHARS;
				const included: JsonValue[] = [];
				for (const item of comments) {
					if (budget <= 0) break;
					const comment = jsonRecord(item);
					const text = clipText(jsonString(comment.body, 100_000) ?? "", Math.min(COMMENT_CHARS, budget));
					budget -= [...text.text].length;
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
				const clipped = clipText(text, FILE_CHARS);
				return { ...metadata, content: clipped.text, content_truncated: clipped.truncated };
			},
			async get_pull_request(args, context) {
				const base = `${repositoryPath(args)}/pulls/${jsonInteger(args.number)}`;
				const pull = jsonRecord(await github(context, base));
				const files = jsonArray(await github(context, `${base}/files`, { query: { per_page: "50" } }));
				const body = clipText(jsonString(pull.body, 100_000) ?? "", BODY_CHARS);
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
					files: files.map((item) => {
						const file = jsonRecord(item);
						return {
							filename: jsonString(file.filename, 1024),
							status: jsonString(file.status, 16),
							additions: jsonInteger(file.additions),
							deletions: jsonInteger(file.deletions),
						};
					}),
				};
			},
		},
	});
}
