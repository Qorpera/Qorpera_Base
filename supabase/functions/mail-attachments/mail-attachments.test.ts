import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
	type AttachmentFetchJob,
	AttachmentFetchError,
	type AttachmentFetchStore,
	type AttachmentProvider,
	BATCH,
	CHUNK_BYTES,
	handleMailAttachments,
	MAX_ATTACHMENT_BYTES,
	type ObjectSink,
	parseFetchClaim,
	ResendAttachments,
	StorageObjectSink,
	type StoredAttachment,
	storageHeaders,
	storeAttachment,
} from "./mail-attachments.ts";

const KEY = "sb_secret_0123456789abcdefghij";
const LEASE = "80400000-0000-4000-8000-0000000000f1";
const COMPANY = "80400000-0000-4000-8000-000000000010";
const EMAIL = "4ef9a417-02e9-4d39-ad75-9611e0fcc33c";
const URL = "https://project.example.test/functions/v1/mail-attachments";
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function job(n: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		fetchId: `80400000-0000-4000-8000-${String(n).padStart(12, "0")}`,
		leaseId: LEASE,
		attemptCount: 1,
		companyId: COMPANY,
		emailId: EMAIL,
		attachmentId: `att-${n}`,
		...extra,
	};
}

/** Bytes that differ from chunk to chunk, so each chunk has its own digest. */
function content(size: number): Uint8Array {
	const bytes = new Uint8Array(size);
	for (let index = 0; index < size; index++) bytes[index] = (index * 31 + Math.floor(index / CHUNK_BYTES)) & 0xff;
	return bytes;
}

/** A response streaming the bytes in pieces of an odd size, as a network would. */
function streamed(bytes: Uint8Array, piece = 1_000_003): Response {
	let offset = 0;
	return new Response(
		new ReadableStream<Uint8Array>({
			pull(controller) {
				if (offset >= bytes.length) return controller.close();
				controller.enqueue(bytes.slice(offset, offset + piece));
				offset += piece;
			},
		}),
	);
}

function provider(files: Map<string, Uint8Array>, size?: (id: string) => number | null): AttachmentProvider {
	return {
		async locate(_emailId, attachmentId) {
			const bytes = files.get(attachmentId);
			if (!bytes) return null;
			return { url: `https://inbound.example.test/${attachmentId}`, size: size ? size(attachmentId) : bytes.length };
		},
		async download(location) {
			return streamed(files.get(location.url.split("/").pop()!)!);
		},
	};
}

function memorySink() {
	const objects = new Map<string, Uint8Array>();
	const sink: ObjectSink = {
		async put(companyId, sha256, bytes) {
			assert.equal(sha(bytes), sha256);
			objects.set(`${companyId}/${sha256}`, bytes);
		},
	};
	return { objects, sink };
}

function fetches(claimed: unknown) {
	const calls = {
		claim: [] as [number, string][],
		complete: [] as [string, StoredAttachment][],
		fail: [] as [string, string, boolean][],
	};
	const store: AttachmentFetchStore = {
		async claim(limit, leaseId) {
			calls.claim.push([limit, leaseId]);
			if (claimed instanceof Error) throw claimed;
			return claimed;
		},
		async complete(fetch: AttachmentFetchJob, stored) {
			calls.complete.push([fetch.fetchId, stored]);
		},
		async fail(fetch, message, retryable) {
			calls.fail.push([fetch.fetchId, message, retryable]);
		},
	};
	return { calls, store };
}

const post = (headers: Record<string, string> = { apikey: KEY }) => new Request(URL, { method: "POST", headers });

describe("mail attachments", () => {
	it("answers only a POST with a secret key it knows", async () => {
		const { calls, store } = fetches([]);
		const { sink } = memorySink();
		const handle = (request: Request) =>
			handleMailAttachments(request, {
				keys: [KEY],
				store: () => store,
				sink: () => sink,
				provider: provider(new Map()),
				leaseId: () => LEASE,
			});
		assert.equal((await handle(new Request(URL))).status, 405);
		assert.equal((await handle(post({}))).status, 401);
		assert.equal((await handle(post({ apikey: "sb_secret_someone_else_000000" }))).status, 401);
		assert.equal((await handle(post({ authorization: `Bearer ${KEY}` }))).status, 200);
		assert.deepEqual(calls.claim, [[BATCH, LEASE]]);
	});

	it("refuses a claim it cannot read, and answers 503 when the claim fails", async () => {
		assert.throws(() => parseFetchClaim({}), /invalid/);
		assert.throws(() => parseFetchClaim([job(1, { attachmentId: "../x" })]), /invalid/);
		assert.throws(() => parseFetchClaim([job(1, { companyId: "not-a-uuid" })]), /invalid/);
		assert.throws(() => parseFetchClaim(Array.from({ length: 11 }, (_, n) => job(n))), /invalid/);
		assert.equal(parseFetchClaim([job(1)])[0]!.attachmentId, "att-1");
		const { store } = fetches(new Error("down"));
		const response = await handleMailAttachments(post(), {
			keys: [KEY],
			store: () => store,
			sink: () => memorySink().sink,
			provider: provider(new Map()),
		});
		assert.equal(response.status, 503);
	});

	it("stores an attachment as 4 MiB chunks named by their digests and completes the fetch", async () => {
		const file = content(2 * CHUNK_BYTES + 12_345);
		const { calls, store } = fetches([job(1)]);
		const { objects, sink } = memorySink();
		const response = await handleMailAttachments(post(), {
			keys: [KEY],
			store: () => store,
			sink: () => sink,
			provider: provider(new Map([["att-1", file]])),
			leaseId: () => LEASE,
		});
		assert.deepEqual(await response.json(), { claimed: 1, stored: 1, retrying: 0, failed: 0 });
		const [[fetchId, stored]] = calls.complete;
		assert.equal(fetchId, job(1).fetchId);
		assert.equal(stored.fileSha256, sha(file));
		assert.equal(stored.bytes, file.length);
		assert.deepEqual(
			stored.chunks.map((chunk) => chunk.bytes),
			[CHUNK_BYTES, CHUNK_BYTES, 12_345],
		);
		const joined = new Uint8Array(file.length);
		let offset = 0;
		for (const chunk of stored.chunks) {
			const bytes = objects.get(`${COMPANY}/${chunk.sha256}`)!;
			joined.set(bytes, offset);
			offset += bytes.length;
		}
		assert.deepEqual(joined, file);
	});

	it("stores an empty attachment with no chunks, and one of exactly 4 MiB as one chunk", async () => {
		const { sink } = memorySink();
		const empty = await storeAttachment(
			parseFetchClaim([job(1)])[0]!,
			provider(new Map([["att-1", new Uint8Array(0)]])),
			sink,
		);
		assert.deepEqual(empty, { fileSha256: sha(new Uint8Array(0)), bytes: 0, chunks: [] });
		const whole = await storeAttachment(
			parseFetchClaim([job(2)])[0]!,
			provider(new Map([["att-2", content(CHUNK_BYTES)]])),
			sink,
		);
		assert.deepEqual(
			whole.chunks.map((chunk) => chunk.bytes),
			[CHUNK_BYTES],
		);
	});

	it("fails for good what the provider no longer has, or what is over 40 MiB, and tries again what may pass", async () => {
		const big = content(MAX_ATTACHMENT_BYTES + 1);
		const { calls, store } = fetches([
			job(1, { attachmentId: "gone" }),
			job(2),
			job(3),
			job(4),
			job(5),
		]);
		const files = new Map([
			["att-2", content(10)],
			["att-3", big],
			["att-4", content(10)],
			["att-5", content(10)],
		]);
		const base = provider(files, (id) => (id === "att-2" ? MAX_ATTACHMENT_BYTES + 1 : id === "att-3" ? null : 10));
		const flaky: AttachmentProvider = {
			locate: base.locate,
			async download(location, signal) {
				// As Deno words it, with the signed address in the text.
				if (location.url.endsWith("att-4")) throw new TypeError(`error sending request for url (${location.url})`);
				if (location.url.endsWith("att-5")) return new Response("busy", { status: 503 });
				return base.download(location, signal);
			},
		};
		const response = await handleMailAttachments(post(), {
			keys: [KEY],
			store: () => store,
			sink: () => memorySink().sink,
			provider: flaky,
		});
		assert.deepEqual(await response.json(), { claimed: 5, stored: 0, retrying: 2, failed: 3 });
		assert.ok(
			calls.fail.every(([, message]) => !message.includes("inbound.example.test")),
			"no signed address is recorded",
		);
		assert.deepEqual(
			calls.fail.map(([id, message, retryable]) => [id.slice(-1), /30 days|40 MiB|provider failed|503/.exec(message)?.[0], retryable]),
			[
				["1", "30 days", false],
				["2", "40 MiB", false],
				["3", "40 MiB", false],
				["4", "provider failed", true],
				["5", "503", true],
			],
		);
	});

	it("refuses a download whose size differs from the one announced", async () => {
		await assert.rejects(
			storeAttachment(
				parseFetchClaim([job(1)])[0]!,
				provider(new Map([["att-1", content(100)]]), () => 99),
				memorySink().sink,
			),
			(error: unknown) => error instanceof AttachmentFetchError && !error.retryable && /differs/.test(error.message),
		);
	});

	it("finds the attachment in Resend's list with the platform's key, and treats a missing email as gone", async () => {
		const requests: [string, RequestInit | undefined][] = [];
		const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
			requests.push([String(url), init]);
			if (String(url).includes("missing")) return new Response("{}", { status: 404 });
			if (String(url).includes("limited")) return new Response("{}", { status: 429 });
			return Response.json({
				object: "list",
				has_more: false,
				data: [
					{ id: "other", download_url: "https://inbound-cdn.resend.com/other?sig=1", size: 3 },
					{ id: "att-1", download_url: "https://inbound-cdn.resend.com/att-1?sig=2", size: 12 },
					{ id: "elsewhere", download_url: "https://inbound-cdn.resend.com.example.test/x", size: 1 },
					{ id: "plain", download_url: "http://inbound-cdn.resend.com/x", size: 1 },
				],
			});
		}) as typeof fetch;
		const resend = new ResendAttachments("re_platform_key", fetcher);
		assert.deepEqual(await resend.locate(EMAIL, "att-1"), {
			url: "https://inbound-cdn.resend.com/att-1?sig=2",
			size: 12,
		});
		assert.equal(requests[0]![0], `https://api.resend.com/emails/receiving/${EMAIL}/attachments?limit=100`);
		assert.deepEqual((requests[0]![1]!.headers as Record<string, string>).authorization, "Bearer re_platform_key");
		assert.equal(await resend.locate(EMAIL, "att-9"), null);
		for (const id of ["elsewhere", "plain"])
			await assert.rejects(
				resend.locate(EMAIL, id),
				(error: unknown) => error instanceof AttachmentFetchError && !error.retryable && /outside/.test(error.message),
			);
		assert.equal(await resend.locate("missing", "att-1"), null);
		await assert.rejects(
			resend.locate("limited", "att-1"),
			(error: unknown) => error instanceof AttachmentFetchError && error.retryable,
		);
		await resend.download({ url: "https://inbound-cdn.resend.com/att-1?sig=2", size: 12 }, AbortSignal.timeout(1000));
		assert.equal(requests.at(-1)![0], "https://inbound-cdn.resend.com/att-1?sig=2");
		assert.equal((requests.at(-1)![1] as RequestInit).headers, undefined, "no key goes to the download address");
	});

	it("puts each chunk in Storage once: a duplicate is stored, a used-up allowance fails for good", async () => {
		const requests: [string, RequestInit][] = [];
		const answers = [
			new Response("{}", { status: 200 }),
			new Response(JSON.stringify({ statusCode: "409", error: "Duplicate" }), { status: 400 }),
			new Response("{}", { status: 409 }),
			new Response(JSON.stringify({ statusCode: "400", message: "company storage allowance exceeded" }), { status: 400 }),
			new Response("{}", { status: 502 }),
		];
		const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
			requests.push([String(url), init!]);
			return answers.shift()!;
		}) as typeof fetch;
		const sink = new StorageObjectSink("https://project.example.test/", KEY, fetcher);
		const bytes = content(10);
		await sink.put(COMPANY, sha(bytes), bytes);
		await sink.put(COMPANY, sha(bytes), bytes);
		await sink.put(COMPANY, sha(bytes), bytes);
		await assert.rejects(
			sink.put(COMPANY, sha(bytes), bytes),
			(error: unknown) => error instanceof AttachmentFetchError && !error.retryable && /allowance/.test(error.message),
		);
		await assert.rejects(
			sink.put(COMPANY, sha(bytes), bytes),
			(error: unknown) => error instanceof AttachmentFetchError && error.retryable,
		);
		assert.equal(
			requests[0]![0],
			`https://project.example.test/storage/v1/object/qorpera-profile-objects/${COMPANY}/${sha(bytes)}`,
		);
		assert.deepEqual(requests[0]![1].headers, {
			apikey: KEY,
			"content-type": "application/octet-stream",
			"x-upsert": "false",
		});
		assert.deepEqual(storageHeaders("eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c2ln"), {
			apikey: "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c2ln",
			authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c2ln",
		});
	});
});
