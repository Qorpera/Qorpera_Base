import { constants } from "node:fs";
import { type FileHandle, lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
	type CloudCodingPullRequest,
	type CloudCodingRepository,
	parseCloudCodingPullRequest,
	parseGitHubCodingRepository,
} from "@qorpera/contracts";

export interface CloudCodingDraftPublication {
	repository: CloudCodingRepository;
	workerId: string;
	headSha: string;
	title: string;
	body: string;
}

export interface CloudCodingPublisherOptions {
	/** Existing private persistent service directory. Never the worker checkout. */
	journalRoot: string;
	/** Recheck current worker, repository, publication and sponsor authority. */
	assertAuthorized(input: Readonly<CloudCodingDraftPublication>, signal: AbortSignal): Promise<void>;
	/** The broker must select a repository-scoped credential; no token is returned to the worker. */
	withRepositoryToken<T>(
		repository: CloudCodingRepository,
		use: (token: string) => Promise<T>,
		signal: AbortSignal,
	): Promise<T>;
	fetch?: typeof fetch;
	signal: AbortSignal;
}

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("CODING_PUBLICATION_INVALID_RESPONSE");
	return value as Record<string, unknown>;
}

async function responseJson(response: Response): Promise<unknown> {
	if (!response.body) throw new Error("CODING_PUBLICATION_INVALID_RESPONSE");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			bytes += chunk.value.byteLength;
			if (bytes > 1024 * 1024) throw new Error("CODING_PUBLICATION_INVALID_RESPONSE");
			chunks.push(chunk.value);
		}
		return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
	} catch {
		throw new Error("CODING_PUBLICATION_INVALID_RESPONSE");
	} finally {
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}

/**
 * Trusted publication lane after an independently authorized push. It never
 * executes repository code, pushes, merges, or exposes the repository token.
 * A durable exclusive claim precedes the only POST. Lost replies are recovered
 * by observation; an absent PR after a claim requires operator reconciliation.
 * GitHub has no create-PR idempotency key, so automatic POST retries are unsafe.
 * The caller must exclusively own branch publication through this call: GitHub
 * accepts a branch name, not a compare-and-set head SHA, when creating a PR.
 */
export async function publishCloudCodingDraftPullRequest(
	value: CloudCodingDraftPublication,
	options: CloudCodingPublisherOptions,
): Promise<CloudCodingPullRequest> {
	const input = Object.freeze({
		...structuredClone(value),
		repository: parseGitHubCodingRepository(value.repository),
	});
	if (
		Object.keys(input).sort().join() !== "body,headSha,repository,title,workerId" ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.workerId) ||
		!/^[0-9a-f]{40}$/.test(input.headSha) ||
		typeof input.title !== "string" ||
		!input.title.trim() ||
		Buffer.byteLength(input.title) > 256 ||
		/[\x00-\x1f\x7f]/.test(input.title) ||
		typeof input.body !== "string" ||
		Buffer.byteLength(input.body) > 32768 ||
		input.body.includes("\0")
	)
		throw new Error("INVALID_CODING_PUBLICATION");
	const branch = `qorpera/coding/${input.workerId}`;
	if (input.repository.baseBranch === branch) throw new Error("INVALID_CODING_PUBLICATION");
	const marker = `<!-- qorpera-coding-worker:${input.workerId} -->`;
	const fullName = `${input.repository.owner}/${input.repository.name}`;
	const root = options.journalRoot;
	if (!isAbsolute(root) || resolve(root) !== root || (await realpath(root)) !== root)
		throw new Error("INVALID_CODING_PUBLICATION_JOURNAL");
	const metadata = await lstat(root);
	if (!metadata.isDirectory() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0)
		throw new Error("INVALID_CODING_PUBLICATION_JOURNAL");
	// Bind the worker once, including repository/base. A later caller cannot
	// obtain another create attempt by changing the target or the request text.
	const claimPath = join(root, `${input.workerId}.publication.json`);
	const claim = JSON.stringify({
		schema: "qorpera.coding-publication-claim/v1",
		workerId: input.workerId,
		repository: input.repository,
		branch,
	});
	const readClaim = async (): Promise<boolean> => {
		let file: FileHandle;
		try {
			file = await open(claimPath, constants.O_RDONLY | constants.O_NOFOLLOW);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw error;
		}
		try {
			const info = await file.stat();
			if (
				!info.isFile() ||
				info.uid !== process.getuid?.() ||
				(info.mode & 0o077) !== 0 ||
				info.nlink !== 1 ||
				info.size > 4096 ||
				(await file.readFile("utf8")) !== claim
			)
				throw new Error("INVALID_CODING_PUBLICATION_JOURNAL");
			return true;
		} finally {
			await file.close();
		}
	};
	const claimed = await readClaim();
	const retainClaim = async (): Promise<boolean> => {
		let file: FileHandle;
		try {
			file = await open(
				claimPath,
				constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
				0o600,
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") {
				await readClaim();
				return false;
			}
			throw new Error("INVALID_CODING_PUBLICATION_JOURNAL");
		}
		try {
			await file.writeFile(claim);
			await file.sync();
		} finally {
			await file.close();
		}
		const directory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
		if (!(await readClaim())) throw new Error("INVALID_CODING_PUBLICATION_JOURNAL");
		return true;
	};
	const signal = AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]);
	const authorize = async (): Promise<void> => {
		signal.throwIfAborted();
		try {
			await options.assertAuthorized(input, signal);
		} catch {
			throw new Error("CODING_PUBLICATION_AUTHORITY_UNAVAILABLE");
		}
		signal.throwIfAborted();
	};
	const request = async (url: URL, method: "GET" | "POST", body?: unknown): Promise<unknown> => {
		await authorize();
		try {
			return await options.withRepositoryToken(
				input.repository,
				async (token) => {
					if (typeof token !== "string" || !/^[A-Za-z0-9_]{20,512}$/.test(token))
						throw new Error("CODING_PUBLICATION_CREDENTIAL_UNAVAILABLE");
					await authorize();
					const response = await (options.fetch ?? fetch)(url, {
						method,
						redirect: "error",
						signal,
						headers: {
							Accept: "application/vnd.github+json",
							Authorization: `Bearer ${token}`,
							"X-GitHub-Api-Version": "2026-03-10",
							"Content-Type": "application/json",
						},
						...(body === undefined ? {} : { body: JSON.stringify(body) }),
					});
					if (response.status !== (method === "POST" ? 201 : 200)) {
						await response.body?.cancel().catch(() => undefined);
						throw new Error("CODING_PUBLICATION_REQUEST_UNCONFIRMED");
					}
					const result = await responseJson(response);
					await authorize();
					return result;
				},
				signal,
			);
		} catch {
			throw new Error("CODING_PUBLICATION_REQUEST_UNCONFIRMED");
		}
	};
	const validatePull = (value: unknown): CloudCodingPullRequest => {
		const pr = record(value),
			head = record(pr.head),
			base = record(pr.base);
		if (
			pr.state !== "open" ||
			pr.draft !== true ||
			typeof pr.body !== "string" ||
			!pr.body.includes(marker) ||
			head.ref !== branch ||
			head.sha !== input.headSha ||
			base.ref !== input.repository.baseBranch ||
			record(head.repo).full_name !== fullName ||
			record(base.repo).full_name !== fullName
		)
			throw new Error("CODING_PUBLICATION_TARGET_MISMATCH");
		return parseCloudCodingPullRequest({ url: pr.html_url, number: pr.number, headSha: head.sha }, input.repository);
	};
	const endpoint = `https://api.github.com/repos/${encodeURIComponent(input.repository.owner)}/${encodeURIComponent(input.repository.name)}`;
	const list = new URL(`${endpoint}/pulls`);
	list.searchParams.set("state", "all");
	list.searchParams.set("head", `${input.repository.owner}:${branch}`);
	list.searchParams.set("per_page", "100");
	const existing = await request(list, "GET");
	if (!Array.isArray(existing) || existing.length > 1) throw new Error("CODING_PUBLICATION_RECONCILIATION_REQUIRED");
	if (existing.length === 1) {
		const result = validatePull(existing[0]);
		await authorize();
		if (!claimed) await retainClaim();
		return result;
	}
	if (claimed) throw new Error("CODING_PUBLICATION_RECONCILIATION_REQUIRED");
	const ref = record(await request(new URL(`${endpoint}/git/ref/heads/${encodeURIComponent(branch)}`), "GET"));
	if (
		ref.ref !== `refs/heads/${branch}` ||
		record(ref.object).type !== "commit" ||
		record(ref.object).sha !== input.headSha
	)
		throw new Error("CODING_PUBLICATION_HEAD_MISMATCH");
	await authorize();
	if (!(await retainClaim())) throw new Error("CODING_PUBLICATION_RECONCILIATION_REQUIRED");
	const created = await request(new URL(`${endpoint}/pulls`), "POST", {
		title: input.title,
		body: `${input.body}\n\n${marker}`,
		head: branch,
		base: input.repository.baseBranch,
		draft: true,
		maintainer_can_modify: false,
	});
	const result = validatePull(created);
	await authorize();
	return result;
}
