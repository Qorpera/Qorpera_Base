import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
	attachmentBase64,
	BATCH,
	createMailObjectReader,
	handleMailOutbox,
	isPublicIpAddress,
	type MailJob,
	type MailOutboxStore,
	MailSendError,
	type MailSender,
	MAX_ATTACHMENT_BYTES,
	ObjectGatewayReader,
	type ObjectReader,
	PACE_MS,
	type ProviderEmail,
	parseMailClaim,
	providerEmail,
	ResendSender,
	sendOneClickUnsubscribe,
	StorageObjectReader,
} from "./mail-outbox.ts";

const KEY = "sb_secret_0123456789abcdefghij";
const LEASE = "73300000-0000-4000-8000-0000000000f1";
const URL = "https://project.example.test/functions/v1/mail-outbox";

function job(n: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		mailId: `73300000-0000-4000-8000-${String(n).padStart(12, "0")}`,
		leaseId: LEASE,
		attemptCount: 1,
		from: '"Ada at Northwind" <support@mail.example.test>',
		to: ["bob@acme.test"],
		cc: [],
		subject: `Email ${n}`,
		text: "Hello\n\n-- \nWritten and sent by Ada, an AI agent working for Northwind.",
		headers: {},
		...extra,
	};
}

function outbox(
	claimed: unknown,
	sender: MailSender,
	objects?: ObjectReader,
	due: unknown = [],
	recorded: [string, string, string][] = [],
) {
	const calls: { claim: [number, string][]; complete: [string, string][]; fail: [string, string, string, boolean][] } = {
		claim: [],
		complete: [],
		fail: [],
	};
	const keys: string[] = [];
	const sleeps: number[] = [];
	const store: MailOutboxStore = {
		async claim(limit, leaseId) {
			calls.claim.push([limit, leaseId]);
			if (claimed instanceof Error) throw claimed;
			return claimed;
		},
		async complete(mail: MailJob, providerMessageId) {
			calls.complete.push([mail.mailId, providerMessageId]);
			if (mail.subject === "Lost completion") throw new Error("lost");
		},
		async messageIdsDue() {
			if (due instanceof Error) throw due;
			return due;
		},
		async recordMessageId(mailId, providerMessageId, messageId) {
			recorded.push([mailId, providerMessageId, messageId]);
		},
		async fail(mailId, leaseId, message, retryable) {
			calls.fail.push([mailId, leaseId, message, retryable]);
		},
	};
	return {
		calls,
		keys,
		sleeps,
		store,
		handle: (request: Request) =>
			handleMailOutbox(request, {
				keys: [KEY, "legacy-service-role-key-0123456789"],
				store: (key) => {
					keys.push(key);
					return store;
				},
				...(objects ? { objects: () => objects } : {}),
				sender,
				leaseId: () => LEASE,
				sleep: async (ms) => {
					sleeps.push(ms);
				},
			}),
	};
}

function recording(fail?: (email: ProviderEmail) => Error | undefined) {
	const sent: [ProviderEmail, string][] = [];
	const sender: MailSender = {
		async send(email, key) {
			sent.push([email, key]);
			const error = fail?.(email);
			if (error) throw error;
			return `provider-${sent.length}`;
		},
		async messageId(providerMessageId) {
			if (providerMessageId === "provider-gone") return null;
			if (providerMessageId === "provider-down") throw new Error("down");
			return `<${providerMessageId}@ses.example>`;
		},
	};
	return { sent, sender };
}

const post = (headers: Record<string, string> = { apikey: KEY }) => new Request(URL, { method: "POST", headers });

describe("mail outbox", () => {
	it("answers only a POST with a secret key it knows", async () => {
		const { sender } = recording();
		const f = outbox([], sender);
		assert.equal((await f.handle(new Request(URL))).status, 405);
		assert.equal((await f.handle(post({}))).status, 401);
		assert.equal((await f.handle(post({ apikey: "sb_secret_someone_else_000000" }))).status, 401);
		assert.equal((await f.handle(post({ authorization: `Bearer ${KEY}` }))).status, 200);
		assert.equal((await f.handle(post({ apikey: "legacy-service-role-key-0123456789" }))).status, 200);
		assert.deepEqual(f.keys, [KEY, "legacy-service-role-key-0123456789"]);
		assert.deepEqual(f.calls.claim, [
			[BATCH, LEASE],
			[BATCH, LEASE],
		]);
	});

	it("sends each claimed email with its id as the idempotency key, paced, and completes it", async () => {
		const { sent, sender } = recording();
		const reply = job(2, {
			cc: ["boss@acme.test"],
			headers: {
				"In-Reply-To": "<m30@example.org>",
				References: "<m1@example.org> <m30@example.org>",
				"Auto-Submitted": "auto-replied",
			},
		});
		const f = outbox([job(1), reply, job(3)], sender);
		const response = await f.handle(post());
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("cache-control"), "no-store");
		assert.deepEqual(await response.json(), { claimed: 3, sent: 3, retrying: 0, failed: 0, rejected: 0, deferred: 0, messageIds: 0 });
		assert.deepEqual(sent[0][0], {
			from: '"Ada at Northwind" <support@mail.example.test>',
			to: ["bob@acme.test"],
			subject: "Email 1",
			text: "Hello\n\n-- \nWritten and sent by Ada, an AI agent working for Northwind.",
		});
		assert.deepEqual(
			sent.map(([, key]) => key),
			[
				"company-mail/73300000-0000-4000-8000-000000000001",
				"company-mail/73300000-0000-4000-8000-000000000002",
				"company-mail/73300000-0000-4000-8000-000000000003",
			],
		);
		assert.deepEqual(sent[1][0].cc, ["boss@acme.test"]);
		assert.deepEqual(sent[1][0].headers, {
			"In-Reply-To": "<m30@example.org>",
			References: "<m1@example.org> <m30@example.org>",
			"Auto-Submitted": "auto-replied",
		});
		assert.deepEqual(f.sleeps, [PACE_MS, PACE_MS]);
		assert.deepEqual(f.calls.complete, [
			["73300000-0000-4000-8000-000000000001", "provider-1"],
			["73300000-0000-4000-8000-000000000002", "provider-2"],
			["73300000-0000-4000-8000-000000000003", "provider-3"],
		]);
	});

	it("retries what the provider may get past and fails the rest", async () => {
		const { sender } = recording((email) =>
			email.subject === "Email 1"
				? new MailSendError("Too many requests (429/rate_limit_exceeded)", true)
				: email.subject === "Email 2"
					? new MailSendError("Invalid `to` field (422/validation_error)", false)
					: email.subject === "Email 3"
						? new Error("unexpected")
						: undefined,
		);
		const f = outbox([job(1), job(2), job(3), job(4, { subject: "Lost completion" })], sender);
		assert.deepEqual(await (await f.handle(post())).json(), {
			claimed: 4,
			sent: 0,
			retrying: 2,
			failed: 1,
			rejected: 0,
			deferred: 0,
			messageIds: 0,
		});
		assert.deepEqual(f.calls.fail, [
			["73300000-0000-4000-8000-000000000001", LEASE, "Too many requests (429/rate_limit_exceeded)", true],
			["73300000-0000-4000-8000-000000000002", LEASE, "Invalid `to` field (422/validation_error)", false],
			["73300000-0000-4000-8000-000000000003", LEASE, "The email could not be sent", true],
		]);
		// A lost completion is left to the lease: the send is repeated with the same idempotency key.
		assert.deepEqual(f.calls.complete, [["73300000-0000-4000-8000-000000000004", "provider-4"]]);
	});

	it("fails an email it cannot read without sending it, and answers 503 for a failed or invalid claim", async () => {
		const { sent, sender } = recording();
		const f = outbox([job(1, { to: [] }), job(2, { headers: { Bcc: "all@acme.test" } }), job(3)], sender);
		assert.deepEqual(await (await f.handle(post())).json(), {
			claimed: 3,
			sent: 1,
			retrying: 0,
			failed: 0,
			rejected: 2,
			deferred: 0,
			messageIds: 0,
		});
		assert.deepEqual(
			f.calls.fail.map(([mailId, , , retryable]) => [mailId, retryable]),
			[
				["73300000-0000-4000-8000-000000000001", false],
				["73300000-0000-4000-8000-000000000002", false],
			],
		);
		assert.equal(sent.length, 1);
		assert.equal((await outbox(new Error("down"), sender).handle(post())).status, 503);
		assert.equal((await outbox({ jobs: [] }, sender).handle(post())).status, 503);
		assert.equal((await outbox([job(1, { mailId: "x" })], sender).handle(post())).status, 503);
	});

	it("leaves out an empty cc and empty headers", () => {
		const { jobs } = parseMailClaim([job(1)]);
		assert.deepEqual(Object.keys(providerEmail(jobs[0])), ["from", "to", "subject", "text"]);
	});
});

describe("mail outbox Message-IDs", () => {
	it("reads back the provider's Message-ID of sent emails after the sends, paced, and records each it gets", async () => {
		const { sender } = recording();
		const recorded: [string, string, string][] = [];
		const f = outbox(
			[job(1)],
			sender,
			undefined,
			[
				{ mailId: "73300000-0000-4000-8000-0000000000d1", providerMessageId: "provider-a" },
				{ mailId: "73300000-0000-4000-8000-0000000000d2", providerMessageId: "provider-gone" },
				{ mailId: "73300000-0000-4000-8000-0000000000d3", providerMessageId: "provider-down" },
				{ mailId: "not-a-mail", providerMessageId: "provider-b" },
			],
			recorded,
		);
		assert.deepEqual(await (await f.handle(post())).json(), {
			claimed: 1,
			sent: 1,
			retrying: 0,
			failed: 0,
			rejected: 0,
			deferred: 0,
			messageIds: 1,
		});
		assert.deepEqual(recorded, [["73300000-0000-4000-8000-0000000000d1", "provider-a", "<provider-a@ses.example>"]]);
		assert.deepEqual(f.sleeps, [PACE_MS, PACE_MS, PACE_MS]);
		// A list that cannot be read, or none at all, sends as before.
		const broken = outbox([], sender, undefined, new Error("down"));
		assert.equal((await (await broken.handle(post())).json()).messageIds, 0);
	});

	it("asks Resend for a sent email's Message-ID with the platform key", async () => {
		const requests: string[] = [];
		const answers = [
			Response.json({ id: "resend-1", message_id: "<abc@eu-west-1.amazonses.com>" }),
			new Response("{}", { status: 404 }),
			Response.json({ id: "resend-3" }),
			new Response("{}", { status: 500 }),
		];
		const sender = new ResendSender("re_platform_key", (async (url: string, init: RequestInit) => {
			requests.push(`${url} ${(init.headers as Record<string, string>).Authorization}`);
			return answers.shift()!;
		}) as unknown as typeof fetch);
		assert.equal(await sender.messageId("resend-1"), "<abc@eu-west-1.amazonses.com>");
		assert.equal(await sender.messageId("resend-2"), null);
		assert.equal(await sender.messageId("resend-3"), null);
		await assert.rejects(sender.messageId("resend-4"));
		assert.equal(requests[0], "https://api.resend.com/emails/resend-1 Bearer re_platform_key");
	});
});

describe("Resend sender", () => {
	const email: ProviderEmail = { from: '"Ada" <a@mail.example.test>', to: ["bob@acme.test"], subject: "Hi", text: "Hi" };
	const respond = (status: number, body: unknown) =>
		(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

	it("posts the email with the platform key and the idempotency key", async () => {
		let request: { url: string; init: RequestInit } | undefined;
		const sender = new ResendSender("re_platform_key", (async (url: string, init: RequestInit) => {
			request = { url, init };
			return new Response(JSON.stringify({ id: "resend-1" }), { status: 200 });
		}) as unknown as typeof fetch);
		assert.equal(await sender.send(email, "company-mail/1"), "resend-1");
		assert.equal(request?.url, "https://api.resend.com/emails");
		assert.equal(request?.init.method, "POST");
		assert.deepEqual(request?.init.headers, {
			Authorization: "Bearer re_platform_key",
			"Content-Type": "application/json",
			"Idempotency-Key": "company-mail/1",
		});
		assert.deepEqual(JSON.parse(String(request?.init.body)), email);

		const withAttachments: ProviderEmail = {
			...email,
			attachments: [
				{ filename: 'report "Q4".pdf', content: Buffer.from("hello-pdf").toString("base64") },
				{ filename: "notes.txt", content: [Buffer.from("abc").toString("base64"), Buffer.from("def").toString("base64")] },
			],
		};
		assert.equal(await sender.send(withAttachments, "company-mail/2"), "resend-1");
		assert.ok(request?.init.body instanceof Blob);
		assert.deepEqual(JSON.parse(await request.init.body.text()), {
			...email,
			attachments: [
				{ filename: 'report "Q4".pdf', content: Buffer.from("hello-pdf").toString("base64") },
				{ filename: "notes.txt", content: Buffer.from("abcdef").toString("base64") },
			],
		});
	});

	it("says which refusals are worth another try", async () => {
		for (const [status, body, retryable] of [
			[429, { name: "rate_limit_exceeded", message: "Too many requests" }, true],
			[500, { name: "internal_server_error" }, true],
			[408, {}, true],
			[409, { name: "concurrent_idempotent_requests" }, true],
			[409, { name: "invalid_idempotent_request" }, false],
			[422, { name: "validation_error", message: "Invalid `to` field" }, false],
			[403, { name: "validation_error", message: "The domain is not verified" }, false],
			[200, { id: "" }, true],
			[200, [], true],
		] as const) {
			await assert.rejects(new ResendSender("k", respond(status, body)).send(email, "k1"), (error: unknown) => {
				assert.ok(error instanceof MailSendError);
				assert.equal(error.retryable, retryable, `${status} ${JSON.stringify(body)}`);
				return true;
			});
		}
		const unreachable = new ResendSender("k", (async () => {
			throw new TypeError("network down");
		}) as unknown as typeof fetch);
		await assert.rejects(unreachable.send(email, "k1"), (error: unknown) => error instanceof MailSendError && error.retryable);

		let seenRedirect: RequestRedirect | undefined;
		const oversized = new ResendSender("k", (async (_url: string, init?: RequestInit) => {
			seenRedirect = init?.redirect;
			return new Response(JSON.stringify({ id: "x".repeat(80 * 1024) }), { status: 200 });
		}) as unknown as typeof fetch);
		await assert.rejects(
			oversized.send(email, "k1"),
			(error: unknown) => error instanceof MailSendError && error.retryable,
		);
		assert.equal(seenRedirect, "error");
	});
});

const COMPANY = "73300000-0000-4000-8000-000000000010";
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** A company file as the path gateway stores it: its chunks of 4 MiB and a v1 manifest, all in one object store. */
function companyFile(store: Map<string, Uint8Array>, bytes: Uint8Array, filename: string) {
	const chunks = [];
	for (let offset = 0; offset < bytes.length; offset += 4 * 1024 * 1024) {
		const chunk = bytes.slice(offset, offset + 4 * 1024 * 1024);
		store.set(sha(chunk), chunk);
		chunks.push({ sha256: sha(chunk), bytes: chunk.length });
	}
	const manifest = new TextEncoder().encode(
		JSON.stringify({
			schema: "qorpera.cloud-file-manifest/v1",
			fileSha256: sha(bytes),
			bytes: bytes.length,
			mediaType: "application/octet-stream",
			chunks,
		}),
	);
	store.set(sha(manifest), manifest);
	return { filename, manifestSha256: sha(manifest), fileSha256: sha(bytes), bytes: bytes.length };
}

function reader(store: Map<string, Uint8Array>): ObjectReader {
	return {
		async get(companyId, sha256) {
			assert.equal(companyId, COMPANY);
			return store.get(sha256) ?? null;
		},
	};
}

describe("mail outbox attachments", () => {
	const pdf = new Uint8Array(5 * 1024 * 1024).map((_, index) => (index * 7) & 0xff);
	const csv = new TextEncoder().encode("name,amount\nNorthwind,42\n");

	it("sends the company files as attachments, in base64, in the order queued", async () => {
		const objects = new Map<string, Uint8Array>();
		const files = [companyFile(objects, pdf, "invoice.pdf"), companyFile(objects, csv, "totals.csv")];
		const { sent, sender } = recording();
		const f = outbox([job(1, { companyId: COMPANY, attachments: files }), job(2)], sender, reader(objects));
		assert.deepEqual(await (await f.handle(post())).json(), { claimed: 2, sent: 2, retrying: 0, failed: 0, rejected: 0, deferred: 0, messageIds: 0 });
		assert.deepEqual(
			sent[0][0].attachments?.map((file) => {
				const encoded = typeof file.content === "string" ? file.content : file.content.join("");
				return [file.filename, Buffer.from(encoded, "base64").equals(Buffer.from(file.filename === "invoice.pdf" ? pdf : csv))];
			}),
			[
				["invoice.pdf", true],
				["totals.csv", true],
			],
		);
		assert.equal(sent[1][0].attachments, undefined, "an email without files has no attachments");
	});

	it("tries again a file not in Storage yet, and fails one that does not match its digests", async () => {
		const objects = new Map<string, Uint8Array>();
		const file = companyFile(objects, pdf, "invoice.pdf");
		const missing = new Map(objects);
		missing.delete([...objects.keys()].find((key) => objects.get(key)!.length === 4 * 1024 * 1024)!);
		await assert.rejects(
			attachmentBase64(COMPANY, file, reader(missing)),
			(error: unknown) => error instanceof MailSendError && error.retryable && /not in storage yet/.test(error.message),
		);
		const tampered = new Map(objects);
		tampered.set(file.manifestSha256, new TextEncoder().encode("{}"));
		await assert.rejects(
			attachmentBase64(COMPANY, file, reader(tampered)),
			(error: unknown) => error instanceof MailSendError && !error.retryable && /integrity/.test(error.message),
		);
		await assert.rejects(
			attachmentBase64(COMPANY, { ...file, bytes: file.bytes - 1 }, reader(objects)),
			(error: unknown) => error instanceof MailSendError && !error.retryable && /manifest/.test(error.message),
		);
		const rawChunk = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
		const badLenStore = new Map<string, Uint8Array>();
		badLenStore.set(sha(rawChunk), rawChunk);
		const badLenManifest = new TextEncoder().encode(
			JSON.stringify({
				schema: "qorpera.cloud-file-manifest/v1",
				fileSha256: sha(rawChunk),
				bytes: 9,
				mediaType: "application/octet-stream",
				chunks: [{ sha256: sha(rawChunk), bytes: 9 }],
			}),
		);
		badLenStore.set(sha(badLenManifest), badLenManifest);
		await assert.rejects(
			attachmentBase64(
				COMPANY,
				{ filename: "bad-len.bin", manifestSha256: sha(badLenManifest), fileSha256: sha(rawChunk), bytes: 9 },
				reader(badLenStore),
			),
			(error: unknown) => error instanceof MailSendError && !error.retryable && /integrity/.test(error.message),
		);
		const wrongWholeSha = "f".repeat(64);
		const wrongWholeStore = new Map<string, Uint8Array>();
		wrongWholeStore.set(sha(rawChunk), rawChunk);
		const wrongWholeManifest = new TextEncoder().encode(
			JSON.stringify({
				schema: "qorpera.cloud-file-manifest/v1",
				fileSha256: wrongWholeSha,
				bytes: rawChunk.length,
				mediaType: "application/octet-stream",
				chunks: [{ sha256: sha(rawChunk), bytes: rawChunk.length }],
			}),
		);
		wrongWholeStore.set(sha(wrongWholeManifest), wrongWholeManifest);
		await assert.rejects(
			attachmentBase64(
				COMPANY,
				{ filename: "bad-whole.bin", manifestSha256: sha(wrongWholeManifest), fileSha256: wrongWholeSha, bytes: rawChunk.length },
				reader(wrongWholeStore),
			),
			(error: unknown) => error instanceof MailSendError && !error.retryable && /integrity/.test(error.message),
		);
		const shortCarry = new Uint8Array(4 * 1024 * 1024 + 1).map((_, index) => (index * 13 + 3) & 0xff);
		const shortStore = new Map<string, Uint8Array>();
		const shortFile = companyFile(shortStore, shortCarry, "carry.bin");
		const encodedParts = await attachmentBase64(COMPANY, shortFile, reader(shortStore));
		assert.ok(encodedParts.length >= 2);
		assert.equal(encodedParts.join(""), Buffer.from(shortCarry).toString("base64"));
		const { sender, sent } = recording();
		const f = outbox([job(1, { companyId: COMPANY, attachments: [file] })], sender, reader(missing));
		assert.deepEqual(await (await f.handle(post())).json(), { claimed: 1, sent: 0, retrying: 1, failed: 0, rejected: 0, deferred: 0, messageIds: 0 });
		assert.equal(sent.length, 0);
	});

	it("fails for good a claimed email whose attachments cannot be read", async () => {
		const file = { filename: "a.pdf", manifestSha256: "a".repeat(64), fileSha256: "b".repeat(64), bytes: 1 };
		const { sender, sent } = recording();
		const f = outbox(
			[
				job(1, { companyId: COMPANY, attachments: [] }),
				job(2, { attachments: [file] }),
				job(3, { companyId: COMPANY, attachments: [{ ...file, filename: "../a.pdf" }] }),
				job(4, { companyId: COMPANY, attachments: [{ ...file, bytes: MAX_ATTACHMENT_BYTES + 1 }] }),
				job(5, { companyId: COMPANY, attachments: Array.from({ length: 11 }, () => file) }),
				job(6, { companyId: COMPANY, attachments: [{ ...file, filename: `${"n".repeat(253)}.md` }] }),
				// 203 characters, as the database counts them, in 403 UTF-16 units: read, then not in storage yet.
				job(7, { companyId: COMPANY, attachments: [{ ...file, filename: `${"\u{1F4CE}".repeat(200)}.md` }] }),
			],
			sender,
			reader(new Map()),
		);
		assert.deepEqual(await (await f.handle(post())).json(), { claimed: 7, sent: 0, retrying: 1, failed: 0, rejected: 6, deferred: 0, messageIds: 0 });
		assert.equal(sent.length, 0);
	});

	it("reads the company's objects from Storage with the presented key", async () => {
		const requests: [string, RequestInit][] = [];
		const answers = [
			new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
			new Response(JSON.stringify({ statusCode: "404", error: "not_found" }), { status: 400 }),
			new Response("{}", { status: 404 }),
			new Response(JSON.stringify({ statusCode: "403", error: "Unauthorized" }), { status: 400 }),
			new Response("{}", { status: 503 }),
		];
		const storage = new StorageObjectReader("https://project.example.test/", "sb_secret_0123456789abcdefghij", (async (
			url: string,
			init: RequestInit,
		) => {
			requests.push([url, init]);
			return answers.shift()!;
		}) as unknown as typeof fetch);
		assert.deepEqual(await storage.get(COMPANY, "c".repeat(64)), new Uint8Array([1, 2, 3]));
		assert.equal(await storage.get(COMPANY, "c".repeat(64)), null);
		assert.equal(await storage.get(COMPANY, "c".repeat(64)), null);
		await assert.rejects(
			storage.get(COMPANY, "c".repeat(64)),
			(error: unknown) => error instanceof MailSendError && error.retryable && /refused/.test(error.message),
		);
		await assert.rejects(storage.get(COMPANY, "c".repeat(64)), (error: unknown) => error instanceof MailSendError && error.retryable);
		assert.equal(
			requests[0][0],
			`https://project.example.test/storage/v1/object/authenticated/qorpera-profile-objects/${COMPANY}/${"c".repeat(64)}`,
		);
		assert.deepEqual(requests[0][1].headers, { apikey: "sb_secret_0123456789abcdefghij" });
	});

	it("reads company attachments from self-hosted object-gateway when configured, without Supabase Storage", async () => {
		const validToken = "B".repeat(43);
		const digest = "d".repeat(64);
		const requests: [string, RequestInit][] = [];
		const okHeaders = { "content-type": "application/octet-stream", etag: `"sha256-${digest}"` };
		const answers = [
			new Response(new Uint8Array([9, 8, 7]), { status: 200, headers: okHeaders }),
			new Response(JSON.stringify({ error: "Object not found" }), { status: 404 }),
			new Response(JSON.stringify({ error: "Unavailable" }), { status: 503 }),
			new Response("<html>proxy login</html>", { status: 200, headers: { "content-type": "text/html" } }),
			new Response(new Uint8Array([1]), {
				status: 200,
				headers: { ...okHeaders, "content-length": String(9 * 1024 * 1024) },
			}),
			new Response(
				new ReadableStream({
					start(controller) {
						controller.error(new Error("connection reset"));
					},
				}),
				{ status: 200, headers: okHeaders },
			),
		];
		const fetcher = (async (url: string, init: RequestInit) => {
			requests.push([url, init]);
			return answers.shift()!;
		}) as unknown as typeof fetch;
		const gatewayReader = createMailObjectReader({
			objectGatewayUrl: "https://objects.internal.example/",
			objectGatewayInternalToken: validToken,
			supabaseUrl: "https://project.example.test",
			secretKey: KEY,
			fetcher,
		});
		assert.ok(gatewayReader instanceof ObjectGatewayReader);
		assert.deepEqual(await gatewayReader.get(COMPANY, digest), new Uint8Array([9, 8, 7]));
		assert.equal(await gatewayReader.get(COMPANY, digest), null);
		await assert.rejects(
			gatewayReader.get(COMPANY, digest),
			(error: unknown) => error instanceof MailSendError && error.retryable && /HTTP 503/.test(error.message),
		);
		await assert.rejects(
			gatewayReader.get(COMPANY, digest),
			(error: unknown) => error instanceof MailSendError && error.retryable && /unexpected object response/.test(error.message),
		);
		await assert.rejects(
			gatewayReader.get(COMPANY, digest),
			(error: unknown) => error instanceof MailSendError && error.retryable && /size limit/.test(error.message),
		);
		await assert.rejects(
			gatewayReader.get(COMPANY, digest),
			(error: unknown) => error instanceof MailSendError && error.retryable && /connection reset/.test(error.message),
		);
		assert.equal(requests[0][0], `https://objects.internal.example/v1/internal-objects/${COMPANY}/${digest}`);
		assert.deepEqual(requests[0][1].headers, { authorization: `Bearer ${validToken}` });
		assert.equal(requests[0][1].redirect, "error");
		assert.doesNotThrow(() => new ObjectGatewayReader("http://127.0.0.1:8080", validToken, fetcher));
		assert.throws(() => new ObjectGatewayReader("http://objects.internal.example", validToken), /clean https origin/);
		assert.throws(
			() => new ObjectGatewayReader("https://objects.internal.example/v1/internal-objects", validToken),
			/clean https origin/,
		);
		assert.throws(() => new ObjectGatewayReader("https://user:pass@objects.internal.example", validToken), /clean https origin/);
		assert.throws(() => new ObjectGatewayReader("https://objects.internal.example", "short-token"), /43-character/);
		assert.throws(
			() =>
				createMailObjectReader({
					objectGatewayUrl: "https://objects.internal.example",
					supabaseUrl: "https://project.example.test",
					secretKey: KEY,
				}),
			/must be set together/,
		);
		assert.throws(
			() =>
				createMailObjectReader({
					objectGatewayInternalToken: validToken,
					supabaseUrl: "https://project.example.test",
					secretKey: KEY,
				}),
			/must be set together/,
		);
		const fallback = createMailObjectReader({
			supabaseUrl: "https://project.example.test",
			secretKey: KEY,
		});
		assert.ok(fallback instanceof StorageObjectReader);
		const { sender, sent } = recording();
		const throwingObjects = outbox(
			[job(1), job(2, { companyId: COMPANY, attachments: [companyFile(new Map(), csv, "a.csv")] })],
			sender,
			undefined,
		);
		const response = await handleMailOutbox(post(), {
			keys: [KEY],
			store: () => throwingObjects.store,
			objects: () => {
				throw new Error("bad object reader config");
			},
			sender,
			pace: 0,
		});
		assert.deepEqual(await response.json(), {
			claimed: 2,
			sent: 1,
			retrying: 1,
			failed: 0,
			rejected: 0,
			deferred: 0,
			messageIds: 0,
		});
		assert.equal(sent.length, 1);
	});

	it("StorageObjectReader rejects oversized responses and handleMailOutbox stops when budgetMs elapses", async () => {
		const sha = "a".repeat(64);
		const reader = new StorageObjectReader(
			"https://project.example",
			KEY,
			async () =>
				new Response(new Uint8Array(10), {
					status: 200,
					headers: { "content-length": String(9 * 1024 * 1024) },
				}),
		);
		await assert.rejects(
			() => reader.get("30000000-0000-4000-8000-000000000010", sha),
			(err: unknown) => err instanceof MailSendError && err.retryable === true,
		);

		const sent: string[] = [];
		let clock = 1_000;
		const sender: MailSender = {
			async send(email) {
				sent.push(email.subject);
				clock += 30_000;
				return `msg-${sent.length}`;
			},
			async messageId() {
				return null;
			},
		};
		const harness = outbox([job(1), job(2)], sender, undefined);
		const response = await handleMailOutbox(post(), {
			keys: [KEY],
			store: () => harness.store,
			sender,
			pace: 0,
			budgetMs: 20_000,
			now: () => clock,
		});
		assert.deepEqual(await response.json(), {
			claimed: 2,
			sent: 1,
			retrying: 0,
			failed: 0,
			rejected: 0,
			deferred: 1,
			messageIds: 0,
		});
		assert.equal(sent.length, 1);
	});

	it("prefetches multi-chunk attachments within window 3, suppresses unhandled prefetch rejections, and checks budget after attachment load", async () => {
		const multi = new Uint8Array(12 * 1024 * 1024 + 17).map((_, index) => (index * 31 + 5) & 0xff);
		const objects = new Map<string, Uint8Array>();
		const file = companyFile(objects, multi, "multi.bin");

		let active = 0;
		let peak = 0;
		const slowReader: ObjectReader = {
			async get(companyId, sha256) {
				assert.equal(companyId, COMPANY);
				active += 1;
				peak = Math.max(peak, active);
				await new Promise((resolve) => setTimeout(resolve, 10));
				active -= 1;
				return objects.get(sha256) ?? null;
			},
		};
		const parts = await attachmentBase64(COMPANY, file, slowReader);
		assert.equal(peak, 3);
		assert.equal(parts.join(""), Buffer.from(multi).toString("base64"));

		const prefetchSignals: AbortSignal[] = [];
		const failingReader: ObjectReader = {
			async get(_companyId, sha256, signal) {
				if (sha256 === file.manifestSha256) return objects.get(sha256) ?? null;
				if (signal) prefetchSignals.push(signal);
				await new Promise((resolve) => setTimeout(resolve, 5));
				throw new MailSendError("storage down", true);
			},
		};
		await assert.rejects(
			() => attachmentBase64(COMPANY, file, failingReader),
			(err: unknown) => err instanceof MailSendError && err.retryable,
		);
		assert.ok(prefetchSignals.length >= 2, "expected concurrent prefetch signals");
		assert.ok(prefetchSignals.every((sig) => sig.aborted), "first chunk failure must abort in-flight prefetches");
		await new Promise((resolve) => setTimeout(resolve, 20));

		let clock = 1_000;
		const sent: string[] = [];
		const sender: MailSender = {
			async send(email) {
				sent.push(email.subject);
				return "msg-should-not-send";
			},
			async messageId() {
				return null;
			},
		};
		const budgetExhaustingReader: ObjectReader = {
			async get(_companyId, sha256) {
				clock += 30_000;
				return objects.get(sha256) ?? null;
			},
		};
		const harness = outbox([job(1, { companyId: COMPANY, attachments: [file] })], sender, budgetExhaustingReader);
		const response = await handleMailOutbox(post(), {
			keys: [KEY],
			store: () => harness.store,
			objects: () => budgetExhaustingReader,
			sender,
			pace: 0,
			budgetMs: 20_000,
			now: () => clock,
		});
		assert.deepEqual(await response.json(), {
			claimed: 1,
			sent: 0,
			retrying: 0,
			failed: 0,
			rejected: 0,
			deferred: 1,
			messageIds: 0,
		});
		assert.equal(sent.length, 0);
	});

	it("validates public IP addresses and blocks SSRF targets for one-click unsubscribe", async () => {
		assert.equal(isPublicIpAddress("93.184.216.34"), true);
		assert.equal(isPublicIpAddress("1.1.1.1"), true);
		assert.equal(isPublicIpAddress("2606:2800:220:1:248:1893:25c8:1946"), true);
		for (const bad of [
			"127.0.0.1",
			"10.0.0.1",
			"172.16.0.1",
			"192.168.1.1",
			"169.254.169.254",
			"100.64.0.1",
			"0.0.0.0",
			"224.0.0.1",
			"::1",
			"fe80::1",
			"fc00::1",
			"fd12:3456::1",
			"2001:db8::1",
			"::ffff:127.0.0.1",
			"not-an-ip",
		]) {
			assert.equal(isPublicIpAddress(bad), false, `expected ${bad} to be rejected`);
		}

		let fetched = 0;
		const neverFetch = (async () => {
			fetched += 1;
			return new Response("ok");
		}) as typeof fetch;
		const publicResolve = async () => ["93.184.216.34"];

		for (const badUrl of [
			"http://news.example.org/unsub",
			"https://user:pass@news.example.org/unsub",
			"https://news.example.org:8443/unsub",
			"https://localhost/unsub",
			"https://service.local/unsub",
			"https://db.internal/unsub",
			"https://169.254.169.254/latest/meta-data",
			"https://127.0.0.1/unsub",
			"https://[::1]/unsub",
			"not-a-url",
		]) {
			await assert.rejects(
				() => sendOneClickUnsubscribe(badUrl, { fetchImpl: neverFetch, resolveHost: publicResolve }),
				(err: unknown) => err instanceof MailSendError && !err.retryable,
			);
		}

		await assert.rejects(
			() =>
				sendOneClickUnsubscribe("https://rebind.example.org/unsub", {
					fetchImpl: neverFetch,
					resolveHost: async () => ["93.184.216.34", "169.254.169.254"],
				}),
			(err: unknown) => err instanceof MailSendError && !err.retryable,
		);
		assert.equal(fetched, 0);

		const requests: { url: string; method?: string; body?: unknown; redirect?: string; contentType?: string }[] = [];
		await sendOneClickUnsubscribe("https://news.example.org/unsub?token=abc", {
			resolveHost: publicResolve,
			fetchImpl: (async (input, init) => {
				const headers = new Headers(init?.headers);
				requests.push({
					url: String(input),
					method: init?.method,
					body: init?.body,
					redirect: init?.redirect,
					contentType: headers.get("content-type") ?? undefined,
				});
				return new Response("ok", { status: 200 });
			}) as typeof fetch,
		});
		assert.deepEqual(requests, [
			{
				url: "https://news.example.org/unsub?token=abc",
				method: "POST",
				body: "List-Unsubscribe=One-Click",
				redirect: "error",
				contentType: "application/x-www-form-urlencoded",
			},
		]);
	});

	it("drains one-click unsubscribe jobs alongside outbox sends", async () => {
		const completed: string[] = [];
		const failed: { id: string; retryable: boolean; error: string }[] = [];
		const unsubOk = "73300000-0000-4000-8000-0000000000a1";
		const unsubFail = "73300000-0000-4000-8000-0000000000a2";
		const store: MailOutboxStore = {
			claim: async () => [],
			complete: async () => undefined,
			fail: async () => undefined,
			messageIdsDue: async () => [],
			recordMessageId: async () => undefined,
			claimUnsubscribes: async (_limit, leaseId) => [
				{
					unsubscribeId: unsubOk,
					leaseId,
					url: "https://news.example.org/one-click/ok",
					attemptCount: 1,
				},
				{
					unsubscribeId: unsubFail,
					leaseId,
					url: "https://news.example.org/one-click/503",
					attemptCount: 1,
				},
			],
			completeUnsubscribe: async (id) => {
				completed.push(id);
			},
			failUnsubscribe: async (id, _leaseId, error, retryable) => {
				failed.push({ id, retryable, error });
			},
		};
		const sender: MailSender = {
			send: async () => "unused",
			messageId: async () => null,
		};
		const response = await handleMailOutbox(post(), {
			keys: [KEY],
			store: () => store,
			sender,
			pace: 0,
			resolveHost: async () => ["93.184.216.34"],
			unsubscribeFetch: (async (target) =>
				String(target).endsWith("/ok")
					? new Response("done", { status: 200 })
					: new Response("busy", { status: 503 })) as typeof fetch,
		});
		assert.deepEqual(await response.json(), {
			claimed: 0,
			sent: 0,
			retrying: 0,
			failed: 0,
			rejected: 0,
			deferred: 0,
			messageIds: 0,
			unsubscribed: 1,
			unsubscribeFailed: 1,
		});
		assert.deepEqual(completed, [unsubOk]);
		assert.equal(failed.length, 1);
		assert.equal(failed[0]?.id, unsubFail);
		assert.equal(failed[0]?.retryable, true);
		assert.match(failed[0]?.error ?? "", /503/);
	});
});
