import { chmod, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type CloudCodingDraftPublication,
	type CloudCodingPublisherOptions,
	publishCloudCodingDraftPullRequest,
} from "../src/coding-workspace.ts";

const workerId = "b0000000-0000-4000-8000-000000000001";
const branch = `qorpera/coding/${workerId}`;
const token = "github_pat_test_scoped_credential_12345";
const input: CloudCodingDraftPublication = {
	repository: { host: "github.com", owner: "qorpera", name: "example", baseBranch: "main" },
	workerId,
	headSha: "a".repeat(40),
	title: "Implement feature",
	body: "The requested feature and its tests.",
};
const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function pull(headSha = input.headSha) {
	return {
		state: "open",
		draft: true,
		body: `Result\n<!-- qorpera-coding-worker:${workerId} -->`,
		number: 41,
		html_url: "https://github.com/qorpera/example/pull/41",
		head: { ref: branch, sha: headSha, repo: { full_name: "qorpera/example" } },
		base: { ref: "main", repo: { full_name: "qorpera/example" } },
	};
}

async function fixture() {
	const journalRoot = await realpath(await mkdtemp(join(tmpdir(), "coding-publication-")));
	directories.push(journalRoot);
	const calls: Array<{ url: URL; method: string; body?: Record<string, unknown> }> = [];
	let published: ReturnType<typeof pull>[] = [];
	let loseReply = false;
	const fetcher: typeof fetch = async (url, init) => {
		expect(init?.redirect).toBe("error");
		expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${token}`);
		const target = new URL(String(url));
		expect(target.origin).toBe("https://api.github.com");
		const method = init?.method ?? "GET";
		const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
		calls.push({ url: target, method, body });
		if (method === "POST") {
			published = [pull()];
			if (loseReply) throw new Error(`Lost transport ${token}`);
			return Response.json(published[0], { status: 201 });
		}
		if (target.pathname.includes("/git/ref/"))
			return Response.json({ ref: `refs/heads/${branch}`, object: { type: "commit", sha: input.headSha } });
		return Response.json(published);
	};
	const options: CloudCodingPublisherOptions = {
		journalRoot,
		signal: new AbortController().signal,
		fetch: fetcher,
		assertAuthorized: vi.fn(async () => undefined),
		withRepositoryToken: async (repository, use) => {
			expect(repository).toEqual(input.repository);
			return use(token);
		},
	};
	return {
		options,
		calls,
		setPublished: (value: ReturnType<typeof pull>[]) => {
			published = value;
		},
		loseReply: () => {
			loseReply = true;
		},
	};
}

describe("trusted coding draft publication", () => {
	it("creates a draft at the exact repository and pushed head, keeping credentials out of durable state", async () => {
		const { options, calls } = await fixture();
		expect(await publishCloudCodingDraftPullRequest(input, options)).toEqual({
			url: pull().html_url,
			number: 41,
			headSha: input.headSha,
		});
		expect(calls.map((call) => call.method)).toEqual(["GET", "GET", "POST"]);
		expect(calls[0].url.searchParams.get("head")).toBe(`qorpera:${branch}`);
		expect(calls[0].url.searchParams.get("state")).toBe("all");
		expect(calls[2].body).toEqual({
			title: input.title,
			body: `${input.body}\n\n<!-- qorpera-coding-worker:${workerId} -->`,
			head: branch,
			base: "main",
			draft: true,
			maintainer_can_modify: false,
		});
		const journal = await readFile(join(options.journalRoot, `${workerId}.publication.json`), "utf8");
		expect(journal).not.toContain(token);
		expect(journal).not.toContain(input.body);
		expect(journal).toContain(branch);
	});

	it("recovers a lost create reply after service reconstruction without creating another PR", async () => {
		const test = await fixture();
		test.loseReply();
		await expect(publishCloudCodingDraftPullRequest(input, test.options)).rejects.toThrow(
			"CODING_PUBLICATION_REQUEST_UNCONFIRMED",
		);
		expect(await publishCloudCodingDraftPullRequest(input, { ...test.options })).toEqual({
			url: pull().html_url,
			number: 41,
			headSha: input.headSha,
		});
		expect(test.calls.filter((call) => call.method === "POST")).toHaveLength(1);
	});

	it("keeps an ambiguous create fenced even when GitHub reports no matching PR", async () => {
		const test = await fixture();
		test.loseReply();
		await expect(publishCloudCodingDraftPullRequest(input, test.options)).rejects.toThrow();
		test.setPublished([]);
		await expect(publishCloudCodingDraftPullRequest(input, test.options)).rejects.toThrow(
			"CODING_PUBLICATION_RECONCILIATION_REQUIRED",
		);
		expect(test.calls.filter((call) => call.method === "POST")).toHaveLength(1);
	});

	it("serializes concurrent publication using the persistent exclusive claim", async () => {
		const test = await fixture();
		const result = await Promise.allSettled([
			publishCloudCodingDraftPullRequest(input, test.options),
			publishCloudCodingDraftPullRequest(input, test.options),
		]);
		expect(result.some((value) => value.status === "fulfilled")).toBe(true);
		expect(test.calls.filter((call) => call.method === "POST")).toHaveLength(1);
	});

	it("reuses the worker's draft after a later push to the same branch", async () => {
		const test = await fixture();
		await publishCloudCodingDraftPullRequest(input, test.options);
		const headSha = "b".repeat(40);
		test.setPublished([pull(headSha)]);
		expect((await publishCloudCodingDraftPullRequest({ ...input, headSha }, test.options)).number).toBe(41);
		expect(test.calls.filter((call) => call.method === "POST")).toHaveLength(1);
	});

	it.each(["base", "repository", "head", "draft", "closed", "marker", "url"])(
		"rejects mismatched %s in provider responses",
		async (mismatch) => {
			const test = await fixture(),
				pr = pull();
			if (mismatch === "base") pr.base.ref = "other";
			if (mismatch === "repository") pr.head.repo.full_name = "attacker/example";
			if (mismatch === "head") pr.head.sha = "b".repeat(40);
			if (mismatch === "draft") pr.draft = false;
			if (mismatch === "closed") pr.state = "closed";
			if (mismatch === "marker") pr.body = "No worker identity";
			if (mismatch === "url") pr.html_url = "https://attacker.invalid/pull/41";
			test.setPublished([pr]);
			await expect(publishCloudCodingDraftPullRequest(input, test.options)).rejects.toThrow();
			expect(test.calls.some((call) => call.method === "POST")).toBe(false);
		},
	);

	it("refuses retargeting an already bound worker before any credential acquisition", async () => {
		const test = await fixture();
		await publishCloudCodingDraftPullRequest(input, test.options);
		const count = test.calls.length;
		await expect(
			publishCloudCodingDraftPullRequest(
				{ ...input, repository: { ...input.repository, name: "other" } },
				test.options,
			),
		).rejects.toThrow("INVALID_CODING_PUBLICATION_JOURNAL");
		expect(test.calls).toHaveLength(count);
	});

	it("rejects a remote branch moved before creation", async () => {
		const test = await fixture();
		await expect(
			publishCloudCodingDraftPullRequest({ ...input, headSha: "b".repeat(40) }, test.options),
		).rejects.toThrow("CODING_PUBLICATION_HEAD_MISMATCH");
		expect(test.calls.some((call) => call.method === "POST")).toBe(false);
	});

	it("does not echo provider errors or credentials", async () => {
		const test = await fixture();
		test.options.fetch = async () => {
			throw new Error(token);
		};
		await expect(publishCloudCodingDraftPullRequest(input, test.options)).rejects.toThrow(
			/^CODING_PUBLICATION_REQUEST_UNCONFIRMED$/,
		);
	});

	it("fails closed on authority revocation before publication", async () => {
		const test = await fixture();
		test.options.assertAuthorized = async () => {
			throw new Error("revoked");
		};
		await expect(publishCloudCodingDraftPullRequest(input, test.options)).rejects.toThrow(
			"CODING_PUBLICATION_AUTHORITY_UNAVAILABLE",
		);
		expect(test.calls).toHaveLength(0);
	});

	it("rejects symlinked claims without changing their targets", async () => {
		const test = await fixture();
		const target = join(test.options.journalRoot, "unrelated");
		await writeFile(target, "preserve");
		await symlink(target, join(test.options.journalRoot, `${workerId}.publication.json`));
		await expect(publishCloudCodingDraftPullRequest(input, test.options)).rejects.toThrow();
		expect(await readFile(target, "utf8")).toBe("preserve");
		expect(test.calls).toHaveLength(0);
	});

	it("refuses a nonprivate journal before acquiring credentials", async () => {
		const test = await fixture();
		await chmod(test.options.journalRoot, 0o755);
		await expect(publishCloudCodingDraftPullRequest(input, test.options)).rejects.toThrow(
			"INVALID_CODING_PUBLICATION_JOURNAL",
		);
		expect(test.calls).toHaveLength(0);
	});
});
