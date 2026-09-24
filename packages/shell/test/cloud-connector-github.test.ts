import { randomBytes } from "node:crypto";
import type { JsonValue } from "@qorpera/contracts";
import { createGitHubConnectorAdapters } from "@qorpera/runtime/cloud-connector-github";
import type { CloudSecretConnectorAdapter } from "@qorpera/runtime/cloud-secret-broker";
import { expect, it, vi } from "vitest";

const token = `ghp_${randomBytes(20).toString("hex")}`;

function adapter(operationId: string, fetchImplementation: typeof fetch): CloudSecretConnectorAdapter {
	const found = createGitHubConnectorAdapters(fetchImplementation).find((item) => item.operationId === operationId);
	if (!found) throw new Error(operationId);
	return found;
}

function input(args: JsonValue, overrides: Record<string, unknown> = {}) {
	return {
		arguments: args,
		credentials: { access_token: token },
		credentialName: "access_token",
		destinationOrigin: "https://api.github.com",
		idempotencyKey: "op-1",
		signal: new AbortController().signal,
		...overrides,
	} as Parameters<CloudSecretConnectorAdapter["execute"]>[0];
}

function server(
	routes: Record<string, (url: URL, init?: RequestInit) => Response>,
): ReturnType<typeof vi.fn<typeof fetch>> {
	return vi.fn<typeof fetch>(async (target, init) => {
		const url = new URL(String(target));
		expect(url.origin).toBe("https://api.github.com");
		expect(init?.redirect).toBe("error");
		expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${token}`);
		expect((init?.headers as Record<string, string>)["x-github-api-version"]).toBe("2022-11-28");
		const route = routes[`${init?.method ?? "GET"} ${url.pathname}`];
		if (!route) return Response.json({ message: "Not Found" }, { status: 404 });
		return route(url, init);
	});
}

it("reads an issue with a bounded number of comments and reduces the payload", async () => {
	const long = "x".repeat(10_000);
	const fetchImplementation = server({
		"GET /repos/acme/roadmap/issues/42": () =>
			Response.json({
				number: 42,
				title: "Login is broken",
				state: "open",
				body: long,
				user: { login: "anna", node_id: "secret-ish" },
				labels: [{ name: "bug" }],
				comments: 3,
				repository_url: "https://api.github.com/repos/acme/roadmap",
				html_url: "https://github.com/acme/roadmap/issues/42",
				assignees: [{ login: "bo" }],
			}),
		"GET /repos/acme/roadmap/issues/42/comments": (url) => {
			expect(url.searchParams.get("per_page")).toBe("2");
			return Response.json([
				{ user: { login: "bo" }, body: "Looking", created_at: "2026-09-01T00:00:00Z" },
				{ user: { login: "cy" }, body: "Fixed", created_at: "2026-09-02T00:00:00Z" },
			]);
		},
	});
	const result = (await adapter("get_issue", fetchImplementation).execute(
		input({ owner: "acme", repository: "roadmap", number: 42, comment_limit: 2 }),
	)) as Record<string, JsonValue>;
	expect(result.status).toBe("completed");
	const issue = result.result as Record<string, JsonValue>;
	expect(issue).toMatchObject({
		number: 42,
		title: "Login is broken",
		repository: "acme/roadmap",
		author: "anna",
		labels: ["bug"],
		body_truncated: true,
		assignees: ["bo"],
		comments_omitted: 0,
	});
	expect((issue.body as string).length).toBeLessThan(4100);
	expect(issue.comments_included).toEqual([
		expect.objectContaining({ author: "bo", body: "Looking" }),
		expect.objectContaining({ author: "cy", body: "Fixed" }),
	]);
	expect(JSON.stringify(result)).not.toContain("secret-ish");
	expect(JSON.stringify(result).length).toBeLessThan(8 * 1024);
});

it("creates issues and comments through POST with the closed body only", async () => {
	const fetchImplementation = server({
		"POST /repos/acme/roadmap/issues": (_url, init) => {
			expect(JSON.parse(String(init?.body))).toEqual({ title: "New", body: "Details", labels: ["bug"] });
			return Response.json(
				{ number: 7, html_url: "https://github.com/acme/roadmap/issues/7", state: "open" },
				{ status: 201 },
			);
		},
		"POST /repos/acme/roadmap/issues/7/comments": (_url, init) => {
			expect(JSON.parse(String(init?.body))).toEqual({ body: "Thanks" });
			return Response.json(
				{
					id: 99,
					html_url: "https://github.com/acme/roadmap/issues/7#issuecomment-99",
					created_at: "2026-09-22T00:00:00Z",
				},
				{ status: 201 },
			);
		},
	});
	await expect(
		adapter("create_issue", fetchImplementation).execute(
			input({ owner: "acme", repository: "roadmap", title: "New", body: "Details", labels: ["bug"] }),
		),
	).resolves.toMatchObject({ status: "completed", result: { number: 7, state: "open" } });
	await expect(
		adapter("create_issue_comment", fetchImplementation).execute(
			input({ owner: "acme", repository: "roadmap", number: 7, body: "Thanks" }),
		),
	).resolves.toMatchObject({ status: "completed", result: { comment_id: 99 } });
});

it("turns provider refusals into closed failure results without echoing the body", async () => {
	const fetchImplementation = server({
		"GET /repos/acme/private/issues/1": () =>
			Response.json(
				{ message: "Not Found", documentation_url: "https://docs.github.com/x", secret_echo: token },
				{ status: 404 },
			),
		"GET /user/repos": () =>
			new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
				status: 403,
				headers: { "content-type": "application/json", "x-ratelimit-remaining": "0" },
			}),
	});
	await expect(
		adapter("get_issue", fetchImplementation).execute(input({ owner: "acme", repository: "private", number: 1 })),
	).resolves.toEqual({
		schema: "qorpera.connector-result/v1",
		status: "failed",
		reason: "not_found",
		detail: "GitHub: Not Found",
	});
	await expect(adapter("list_repositories", fetchImplementation).execute(input({}))).resolves.toMatchObject({
		status: "failed",
		reason: "rate_limited",
	});
});

it("refuses wrong destinations, credential names, token shapes and off-schema arguments before any request", async () => {
	const fetchImplementation = vi.fn<typeof fetch>();
	const get = adapter("get_issue", fetchImplementation);
	const args = { owner: "acme", repository: "roadmap", number: 1 };
	await expect(get.execute(input(args, { destinationOrigin: "https://api.github.com.evil" }))).rejects.toThrow(
		"authority",
	);
	await expect(get.execute(input(args, { credentialName: "token" }))).rejects.toThrow("authority");
	await expect(get.execute(input(args, { credentials: { access_token: "short" } }))).rejects.toThrow(
		"credential shape",
	);
	await expect(get.execute(input({ ...args, extra: true }))).rejects.toThrow("extra fields");
	await expect(get.execute(input({ owner: "../../etc", repository: "x", number: 1 }))).rejects.toThrow("invalid");
	await expect(
		adapter("read_file", fetchImplementation).execute(
			input({ owner: "acme", repository: "roadmap", path: "a/../b" }),
		),
	).resolves.toMatchObject({ status: "failed", reason: "invalid_request" });
	expect(fetchImplementation).not.toHaveBeenCalled();
});

it("reads text files, marks binaries and large files, and lists directories", async () => {
	const fetchImplementation = server({
		"GET /repos/acme/roadmap/contents/README.md": (url) => {
			expect(url.searchParams.get("ref")).toBe("main");
			return Response.json({
				type: "file",
				encoding: "base64",
				size: 11,
				sha: "abc",
				path: "README.md",
				content: Buffer.from("# Roadmap\n\n").toString("base64"),
				html_url: "https://github.com/acme/roadmap/blob/main/README.md",
			});
		},
		"GET /repos/acme/roadmap/contents/logo.png": () =>
			Response.json({
				type: "file",
				encoding: "base64",
				size: 3,
				sha: "def",
				path: "logo.png",
				content: "/////w==",
			}),
		"GET /repos/acme/roadmap/contents/docs": () =>
			Response.json([
				{ name: "a.md", type: "file", size: 3 },
				{ name: "img", type: "dir", size: 0 },
			]),
	});
	const read = adapter("read_file", fetchImplementation);
	await expect(
		read.execute(input({ owner: "acme", repository: "roadmap", path: "README.md", ref: "main" })),
	).resolves.toMatchObject({
		status: "completed",
		result: { path: "README.md", content: "# Roadmap\n\n", content_truncated: false },
	});
	await expect(read.execute(input({ owner: "acme", repository: "roadmap", path: "logo.png" }))).resolves.toMatchObject(
		{
			result: { content: null, content_omitted: "binary" },
		},
	);
	await expect(read.execute(input({ owner: "acme", repository: "roadmap", path: "docs" }))).resolves.toMatchObject({
		result: {
			type: "directory",
			entries: [
				{ name: "a.md", type: "file", size: 3 },
				{ name: "img", type: "dir", size: 0 },
			],
		},
	});
});

it("keeps repository, issue and pull request file lists under the broker's result limit and says how many were left out", async () => {
	const wide = "😀".repeat(250);
	const fetchImplementation = server({
		"GET /user/repos": () =>
			Response.json(
				Array.from({ length: 50 }, (_, index) => ({
					full_name: `acme/${"r".repeat(150)}${index}`,
					description: wide,
					html_url: `https://github.com/acme/${"r".repeat(400)}${index}`,
				})),
			),
		"GET /search/issues": () =>
			Response.json({
				total_count: 50,
				items: Array.from({ length: 50 }, (_, index) => ({
					number: index + 1,
					title: `${"😀".repeat(200)}`,
					repository_url: "https://api.github.com/repos/acme/app",
					html_url: `https://github.com/acme/app/issues/${index + 1}/${"x".repeat(400)}`,
				})),
			}),
		"GET /repos/acme/app/pulls/7": () =>
			Response.json({
				number: 7,
				title: "Big change",
				body: wide.repeat(20),
				html_url: "https://github.com/acme/app/pull/7",
			}),
		"GET /repos/acme/app/pulls/7/files": () =>
			Response.json(
				Array.from({ length: 50 }, (_, index) => ({
					filename: `src/${"f".repeat(900)}${index}.ts`,
					status: "modified",
				})),
			),
	});
	const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
	const repositories = await adapter("list_repositories", fetchImplementation).execute(input({ limit: 50 }));
	expect(repositories).toMatchObject({ status: "completed" });
	expect((repositories as { result: { repositories_omitted: number } }).result.repositories_omitted).toBeGreaterThan(
		0,
	);
	expect(bytes(repositories)).toBeLessThanOrEqual(30 * 1024);
	const issues = await adapter("search_issues", fetchImplementation).execute(input({ query: "is:open", limit: 50 }));
	expect((issues as { result: { items_omitted: number } }).result.items_omitted).toBeGreaterThan(0);
	expect(bytes(issues)).toBeLessThanOrEqual(30 * 1024);
	const pull = await adapter("get_pull_request", fetchImplementation).execute(
		input({ owner: "acme", repository: "app", number: 7 }),
	);
	expect(pull).toMatchObject({ status: "completed", result: { body_truncated: true } });
	expect((pull as { result: { files_omitted: number } }).result.files_omitted).toBeGreaterThan(0);
	expect(bytes(pull)).toBeLessThanOrEqual(30 * 1024);
});
